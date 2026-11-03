// 离线回归：面板的推送通道（SSE）。
//
// 要证明三件事：
//   1. runner 写状态之后，Host 会推一条 {type:'nodes'}；
//   2. change 被移进 archive/ 之后，Host 会推一条 {type:'archived', id, change, as}；
//   3. 两个面板看同一个仓库，关掉一个不会把监听带停（监听按持有者算，不按连接算）。
// 全程不用轮询磁盘，也不需要起 DSH。
//
// 跑法：
//   node plugins/dsh-openspec-pipeline/test/event-stream.mjs
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'osp-sse-'))
const profile = path.join(sandbox, 'profile')
const proj = path.join(sandbox, 'proj')
const changes = path.join(proj, 'openspec', 'changes')
mkdirSync(profile, { recursive: true })
mkdirSync(path.join(changes, 'foo'), { recursive: true })
mkdirSync(path.join(changes, 'archive'), { recursive: true })
mkdirSync(path.join(proj, 'openspec', 'specs'), { recursive: true })
writeFileSync(path.join(changes, 'foo', 'proposal.md'), '# foo\n', 'utf8')
writeFileSync(
  path.join(proj, 'openspec', 'pipeline.json'),
  JSON.stringify(
    {
      version: 1,
      name: '推送测试',
      maxParallel: 1,
      profiles: [],
      defaultProfileId: '',
      nodes: [
        { id: 'start', kind: 'start', change: '', deps: [], status: 'done' },
        { id: 'N1', change: 'foo', deps: ['start'], status: 'pending' },
      ],
    },
    null,
    2,
  ),
  'utf8',
)

// 插件在模块加载时就把状态目录定死，所以必须在 import 之前设好。
process.env.DSH_PROFILE_DIR = profile
const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

const routes = []
const sessions = new Map()
const ctx = {
  tools: { register() { return () => {} } },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  get(name) {
    if (name === 'sessionController') {
      return {
        async create() {
          const sessionId = `session-sse-${sessions.size + 1}`
          sessions.set(sessionId, {
            seq: 0,
            snapshotEvents(from) {
              return from <= 1 ? [{ type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } }] : []
            },
          })
          return { sessionId }
        },
        async prompt() {},
      }
    }
    if (name === 'agents') return { get: (id) => (sessions.has(id) ? { session: sessions.get(id) } : undefined) }
    if (name === 'sessions') return { get: (id) => sessions.get(id) }
    if (name === 'workspaceRegistry') return { list: () => [{ id: 'ws', title: 'proj', path: proj }] }
    return undefined
  },
}
const cleanup = apply(ctx)
if (!routes.length) throw new Error('路由没注册上，测试没法继续')

const server = createServer((req, res) => {
  Promise.resolve(routes[0].handler(req, res)).catch(() => {
    try {
      res.destroy()
    } catch {}
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const failures = []
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`)
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    failures.push(name)
  }
}

async function post(body) {
  const response = await fetch(`${origin}/openspec-pipeline/api/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return response.json()
}

// 先把 watcher 挂在 proj 上（面板打开时就是走 /state）。
const state = await fetch(`${origin}/openspec-pipeline/api/state`).then((r) => r.json())
if (state.root !== proj) throw new Error(`工作区解析不对：${state.root}`)

// 连上推送通道，按 SSE 的 \n\n 分帧读。
const response = await fetch(`${origin}/openspec-pipeline/api/events`)
if (response.headers.get('content-type') !== 'text/event-stream; charset=utf-8') {
  throw new Error(`content-type 不对：${response.headers.get('content-type')}`)
}
const reader = response.body.getReader()
const decoder = new TextDecoder()
const queue = []
let buffer = ''
const pump = (async () => {
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue
        try {
          queue.push(JSON.parse(line.slice(5).trim()))
        } catch {}
      }
    }
  }
})()
pump.catch(() => {})

async function nextEvent(match, timeout = 8000) {
  const started = Date.now()
  for (;;) {
    const index = queue.findIndex(match)
    if (index >= 0) return queue.splice(index, 1)[0]
    if (Date.now() - started > timeout) throw new Error(`等事件超时：${JSON.stringify(queue)}`)
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
}

const hello = await nextEvent((event) => event.type === 'hello', 3000)
check('连上就先收到 hello', Boolean(hello))

// 1. 跑一格：对话收尾 → runner 写状态 → 推 nodes。
await post({ action: 'run' })
const nodes = await nextEvent((event) => event.type === 'nodes')
check('节点状态变化会推 nodes', nodes.type === 'nodes', JSON.stringify(nodes))

// 2. 归档：目录移进 archive/ → 推 archived。
renameSync(path.join(changes, 'foo'), path.join(changes, 'archive', '2026-10-29-foo'))
const archived = await nextEvent((event) => event.type === 'archived')
check('change 归档会推 archived', archived.change === 'foo' && archived.id === 'N1', JSON.stringify(archived))
check('archived 事件带上 archive 目录名', archived.as === '2026-10-29-foo', JSON.stringify(archived))

// 3. 已经提醒过的格子不重复推。
await new Promise((resolve) => setTimeout(resolve, 900))
const duplicates = queue.filter((event) => event.type === 'archived')
check('同一个归档不重复推', duplicates.length === 0, JSON.stringify(queue))

// 4. 仓库里的文件动了（对话在勾 tasks / 写 specs）→ 推 changes，让面板立刻重读。
mkdirSync(path.join(changes, 'fresh', 'specs'), { recursive: true })
writeFileSync(path.join(changes, 'fresh', 'tasks.md'), '- [ ] 做事\n', 'utf8')
const changed = await nextEvent((event) => event.type === 'changes')
check('仓库里的文件动了会推 changes', changed.type === 'changes', JSON.stringify(changed))

// 5. 两个面板看同一个仓库：关掉其中一个，剩下的那个照常收归档 / 改动。
//    监听按持有者算，面板这一份要在「最后一个连接断开」时才退。
const second = await fetch(`${origin}/openspec-pipeline/api/events`)
const secondReader = second.body.getReader()
const secondPump = (async () => {
  for (;;) {
    const { done } = await secondReader.read()
    if (done) return
  }
})().catch(() => {})
await new Promise((resolve) => setTimeout(resolve, 300))
try {
  await secondReader.cancel()
} catch {}
secondPump.catch(() => {})
await new Promise((resolve) => setTimeout(resolve, 400))
mkdirSync(path.join(changes, 'later'), { recursive: true })
const stillFresh = await nextEvent((event) => event.type === 'changes')
check('关掉一个面板，剩下的照常收事件', stillFresh.type === 'changes', JSON.stringify(stillFresh))

try {
  reader.cancel()
} catch {}
cleanup()
await new Promise((resolve) => server.close(resolve))

console.log(failures.length ? `\n${failures.length} 项没过` : '\n全部通过')
process.exit(failures.length ? 1 : 0)
