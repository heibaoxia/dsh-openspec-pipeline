// 离线回归：一个面板一个工作区（0.12 的「各看各的」）。
//
// 0.11 的问题：工作区是插件全局的一份设置，只要某个工作区开跑，面板上的工作区下拉
// 就被 `running` 锁死 —— 整块面板只能同时盯着一个工作区。
// 现在每个面板各带各的 root：A 在跑的时候，面板可以切到 B 看 B 的图，A 照跑不误。
//
// 要证明五件事：
//   1. 请求带 seat 时，默认跟着「当前对话所在的工作区」；
//   2. 当前对话的工作区没有 openspec 时，退回「上一次打开的工作区」；
//   3. 一个工作区在跑，另一个工作区的面板照样读得到、`running` 不该串；
//   4. 面板切到别的工作区，不会停掉原来那个工作区的 runner；
//   5. 推送（SSE）按工作区分流：A 的归档只该惊动看 A 的那个面板。
//
// 跑法：
//   node plugins/dsh-openspec-pipeline/test/per-workspace.mjs
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'osp-per-ws-'))
const profile = path.join(sandbox, 'profile')
mkdirSync(profile, { recursive: true })

function makeProject(name, change) {
  const proj = path.join(sandbox, name)
  const dir = path.join(proj, 'openspec', 'changes')
  mkdirSync(path.join(proj, 'openspec', 'specs'), { recursive: true })
  mkdirSync(path.join(dir, change), { recursive: true })
  mkdirSync(path.join(dir, 'archive'), { recursive: true })
  writeFileSync(path.join(dir, change, 'proposal.md'), `# ${change}\n`, 'utf8')
  writeFileSync(path.join(dir, change, 'tasks.md'), '## 1. 任务\n\n- [x] 1.1 做完了\n', 'utf8')
  writeFileSync(
    path.join(proj, 'openspec', 'pipeline.json'),
    JSON.stringify(
      {
        version: 1,
        name: `流水线 ${name}`,
        maxParallel: 1,
        profiles: [],
        defaultProfileId: '',
        nodes: [
          { id: 'start', kind: 'start', change: '', deps: [], status: 'done' },
          { id: 'N1', change, deps: ['start'], status: 'pending' },
        ],
      },
      null,
      2,
    ),
    'utf8',
  )
  return proj
}

const projA = makeProject('work-a', 'change-a')
const projB = makeProject('work-b', 'change-b')
// 第三个工作区分组：没 openspec，用来证明「退回上一次打开的那个」。
const plainDir = path.join(sandbox, 'plain-dir')
mkdirSync(plainDir, { recursive: true })

process.env.DSH_PROFILE_DIR = profile
const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

const routes = []
const sessions = new Map()
const calls = []
// A 的对话故意不收尾，好让 A 一直「在跑」；B 的对话立刻收尾并归档。
const hanging = new Map()

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
        async create(request) {
          const sessionId = `session-${sessions.size + 1}`
          const hang = request?.workspaceId === 'wa'
          const session = {
            seq: 0,
            finished: !hang,
            snapshotEvents(from) {
              if (!this.finished) return []
              return from <= 1 ? [{ type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } }] : []
            },
          }
          sessions.set(sessionId, session)
          if (hang) hanging.set(sessionId, session)
          return { sessionId }
        },
        async prompt(request) {
          const text = String(request.content?.[0]?.text || '')
          calls.push(text)
          // B 那一格自己归档（A 的故意不归档，让它停在跑着的样子）。
          if (text.includes('change-b')) {
            const from = path.join(projB, 'openspec', 'changes', 'change-b')
            renameSync(from, path.join(projB, 'openspec', 'changes', 'archive', '2026-10-31-change-b'))
          }
        },
      }
    }
    if (name === 'agents') return { get: (id) => (sessions.has(id) ? { session: sessions.get(id) } : undefined) }
    if (name === 'sessions') return { get: (id) => sessions.get(id) }
    if (name === 'workspaceRegistry') {
      return {
        list: () => [
          { id: 'wa', title: 'work-a', path: projA, sessionIds: ['s-a'] },
          { id: 'wb', title: 'work-b', path: projB, sessionIds: ['s-b'] },
          { id: 'wp', title: 'plain-dir', path: plainDir, sessionIds: ['s-plain'] },
        ],
      }
    }
    return undefined
  },
}
const cleanup = apply(ctx)
if (!routes.length) throw new Error('路由没注册上，测试没法继续')

const failures = []
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`)
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    failures.push(name)
  }
}

const server = createServer((req, res) => {
  Promise.resolve(routes[0].handler(req, res)).catch(() => {
    try {
      res.destroy()
    } catch {}
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const getState = (query = '') =>
  fetch(`${origin}/openspec-pipeline/api/state${query}`).then((response) => response.json())
const post = (body) =>
  fetch(`${origin}/openspec-pipeline/api/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((response) => response.json())

const same = (left, right) =>
  String(left || '').replace(/[\\/]+$/, '').toLowerCase() ===
  String(right || '').replace(/[\\/]+$/, '').toLowerCase()

// ---------- 1. 默认跟着当前对话的工作区 ----------
const seatB = await getState(`?seat=s-b`)
check('带 seat 时 root 跟着当前对话的工作区', same(seatB.root, projB), seatB.root)
check('rootFrom 说明「跟着对话」', seatB.rootFrom === 'seat', seatB.rootFrom)
check('seat.workspaceId 指到登记的工作区', seatB.seat?.workspaceId === 'wb', JSON.stringify(seatB.seat))

// ---------- 2. 对话工作区没有 openspec → 上一次打开的那个 ----------
const plainSeat = await getState(`?seat=s-plain`)
check('没有 openspec 的对话退回上一次打开的工作区', same(plainSeat.root, projB), plainSeat.root)
check('退回时 rootFrom 是 default', plainSeat.rootFrom === 'default', plainSeat.rootFrom)

// ---------- 3. A 在跑，B 的面板照样读，running 不串 ----------
await post({ action: 'root', root: projA })
const runningA = await post({ action: 'run' })
check('A 开跑了', Array.isArray(runningA.runningRoots) && runningA.runningRoots.some((root) => same(root, projA)), JSON.stringify(runningA.runningRoots))

const viewA = await getState(`?root=${encodeURIComponent(projA)}`)
check('看 A 的面板：running=true', viewA.running === true, String(viewA.running))
const viewB = await getState(`?root=${encodeURIComponent(projB)}`)
check('看 B 的面板：running=false', viewB.running === false, String(viewB.running))
check(
  '看 B 的面板也能看到「A 在跑」',
  Array.isArray(viewB.runningRoots) && viewB.runningRoots.some((root) => same(root, projA)),
  JSON.stringify(viewB.runningRoots),
)

// ---------- 4. 切到 B 不会停掉 A ----------
const switched = await post({ action: 'root', root: projB, seat: { sessionId: 's-a' } })
check('面板切到 B', same(switched.root, projB), switched.root)
const stillA = await getState(`?root=${encodeURIComponent(projA)}`)
check('切走之后 A 还在跑', stillA.running === true, String(stillA.running))
check('A 的那一格还是 running', (stillA.state?.nodes || []).find((item) => item.id === 'N1')?.status === 'running', JSON.stringify(stillA.state?.nodes))

// ---------- 5. 推送按工作区分流 ----------
async function openStream(root) {
  const response = await fetch(`${origin}/openspec-pipeline/api/events?root=${encodeURIComponent(root)}`)
  if (!response.headers.get('content-type')?.startsWith('text/event-stream')) {
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
  return { queue, close: () => Promise.resolve(reader.cancel()).catch(() => {}) }
}

async function waitEvent(stream, match, timeout = 8000) {
  const started = Date.now()
  for (;;) {
    const index = stream.queue.findIndex(match)
    if (index >= 0) return stream.queue.splice(index, 1)[0]
    if (Date.now() - started > timeout) throw new Error(`等事件超时：${JSON.stringify(stream.queue)}`)
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
}

const streamA = await openStream(projA)
const streamB = await openStream(projB)
await waitEvent(streamA, (event) => event.type === 'hello')
await waitEvent(streamB, (event) => event.type === 'hello')

// A 的变化：只该惊动看 A 的那个面板。
renameSync(
  path.join(projA, 'openspec', 'changes', 'change-a'),
  path.join(projA, 'openspec', 'changes', 'archive', '2026-10-31-change-a'),
)
const archivedA = await waitEvent(streamA, (event) => event.type === 'archived')
check('A 的归档推到看 A 的面板', archivedA.change === 'change-a', JSON.stringify(archivedA))
await new Promise((resolve) => setTimeout(resolve, 1200))
check(
  '看 B 的面板没收到 A 的归档',
  !streamB.queue.some((event) => event.type === 'archived'),
  JSON.stringify(streamB.queue),
)

// A 的对话收尾 → runner 写状态 → 只有 A 收到 nodes。
for (const session of hanging.values()) session.finished = true
const nodesA = await waitEvent(streamA, (event) => event.type === 'nodes', 12000)
check('A 的状态变化推到看 A 的面板', nodesA.type === 'nodes', JSON.stringify(nodesA))
await new Promise((resolve) => setTimeout(resolve, 800))
check(
  '看 B 的面板没收到 A 的 nodes',
  !streamB.queue.some((event) => event.type === 'nodes'),
  JSON.stringify(streamB.queue),
)

await streamA.close()
await streamB.close()
await post({ action: 'stop', root: projA }).catch(() => {})

console.log(failures.length ? `\n${failures.length} 项没过` : '\n全部通过')
cleanup()
await new Promise((resolve) => server.close(resolve))
process.exit(failures.length ? 1 : 0)
