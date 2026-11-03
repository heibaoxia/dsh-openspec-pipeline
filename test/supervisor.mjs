// 离线回归：值班监工（两种出手时机）+ 每个项目一份手册。
//
// 要证明四件事：
//   1. 手册按项目存：A 写的手册，B 读不到；
//   2. 开监工会建一个会话，把口径发过去，sessionId 落进 pipeline.json；
//   3. 情况一：某一格对话收尾了但没归档 → 给监工发值班单（带手册、带那一格最后说的话）；
//   4. 情况二：上一格已经归档、但没人接着跑 → 也给监工发值班单；
//   5. 三条投递（开监工 / 值班单 / tell）都必须带取消信号才算送达；值班单送不出去时记进
//      supervisor.lastError，下一次送成功清空；
//   6. 口径第一次没送出去：建好的会话留着，重试复用同一个，不再建第二个孤儿。
//
// 跑法：
//   node plugins/dsh-openspec-pipeline/test/supervisor.mjs
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'osp-supervisor-'))
const profile = path.join(sandbox, 'profile')
mkdirSync(profile, { recursive: true })

const failures = []
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`)
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    failures.push(name)
  }
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeProject(name, changes) {
  const proj = path.join(sandbox, name)
  const dir = path.join(proj, 'openspec', 'changes')
  mkdirSync(path.join(proj, 'openspec', 'specs'), { recursive: true })
  mkdirSync(path.join(dir, 'archive'), { recursive: true })
  for (const change of changes) {
    const base = path.join(dir, change)
    mkdirSync(base, { recursive: true })
    writeFileSync(path.join(base, 'proposal.md'), `# ${change}\n`, 'utf8')
    writeFileSync(path.join(base, 'tasks.md'), '- [x] 1.1 做完了\n', 'utf8')
  }
  return proj
}
function writePipeline(proj, nodes) {
  writeFileSync(
    path.join(proj, 'openspec', 'pipeline.json'),
    JSON.stringify(
      {
        version: 1,
        name: '监工测试',
        maxParallel: 1,
        profiles: [],
        defaultProfileId: '',
        nodes: [{ id: 'start', kind: 'start', change: '', deps: [], status: 'done' }, ...nodes],
      },
      null,
      2,
    ),
    'utf8',
  )
}

const projA = makeProject('proj-a', ['a-one', 'a-two'])
const projB = makeProject('proj-b', ['b-one'])
writePipeline(projA, [
  { id: 'N1', change: 'a-one', deps: ['start'], status: 'pending' },
  { id: 'N2', change: 'a-two', deps: ['N1'], status: 'pending' },
])
writePipeline(projB, [{ id: 'N1', change: 'b-one', deps: ['start'], status: 'pending' }])

process.env.DSH_PROFILE_DIR = profile
const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

const routes = []
const sessions = new Map()
const prompts = [] // { sessionId, text }
let sessionSeq = 0
let createCalls = 0 // 建过几个监工 / 工作会话：重试时不该再建第二个
let rejectPromptFor = '' // 非空时，发给这个会话的投递一律失败（模拟宿主不收）
let rejectNextPrompt = false // 下一条投递直接失败（模拟口径第一次没送出去）
const workspaces = [
  { id: 'wa', title: 'proj-a', path: projA },
  { id: 'wb', title: 'proj-b', path: projB },
]

const ctx = {
  tools: { register() { return () => {} } },
  webServer: { register(route) { routes.push(route); return () => {} } },
  get(name) {
    if (name === 'sessionController') {
      return {
        async create() {
          createCalls += 1
          const sessionId = `session-${++sessionSeq}`
          sessions.set(sessionId, {
            seq: 0,
            snapshotEvents(from) {
              if (from > 1) return []
              return [
                {
                  type: 'assistant/message',
                  seq: 1,
                  data: { message: { role: 'assistant', content: [{ type: 'text', text: '这个断言要放宽吗？' }] } },
                },
                { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } },
              ]
            },
          })
          return { sessionId }
        },
        // 宿主的真实现第一行就是 signal.throwIfAborted()：第二个参数缺了要当场炸，
        // 不能像以前那样默默收下（那正是「启用监工」报错被吞掉的原因）。
        async prompt(request, signal) {
          if (!signal) throw new Error('sessionController.prompt 少了取消信号（signal.throwIfAborted 读不到）')
          // 先记下再判拒收：投递失败也留下了「发过什么」的证据，测试才分得清是没发还是没送到。
          prompts.push({
            sessionId: String(request.sessionId || ''),
            text: String(request.content?.[0]?.text || ''),
          })
          if (rejectNextPrompt) {
            rejectNextPrompt = false
            throw new Error('宿主：这一条没送进去')
          }
          if (rejectPromptFor && rejectPromptFor === request.sessionId) throw new Error('宿主：这个对话现在不收消息')
          return { accepted: true }
        },
      }
    }
    if (name === 'agents') return { get: (id) => (sessions.has(id) ? { session: sessions.get(id) } : undefined) }
    if (name === 'sessions') return { get: (id) => sessions.get(id) }
    if (name === 'workspaceRegistry') return { list: () => workspaces }
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

async function post(body) {
  const response = await fetch(`${origin}/openspec-pipeline/api/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return response.json()
}
async function getState(root) {
  return fetch(`${origin}/openspec-pipeline/api/state?root=${encodeURIComponent(root)}`).then((r) => r.json())
}
async function getManual(root) {
  return fetch(`${origin}/openspec-pipeline/api/manual?root=${encodeURIComponent(root)}`).then((r) => r.json())
}
async function saveManual(root, text) {
  return fetch(`${origin}/openspec-pipeline/api/manual`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root, text }),
  }).then((r) => r.json())
}
async function waitFor(predicate, timeout = 8000) {
  const started = Date.now()
  for (;;) {
    const hit = await predicate()
    if (hit) return hit
    if (Date.now() - started > timeout) return null
    await pause(80)
  }
}

// ---------- 1. 手册按项目存 ----------
const manualA = '遇到问数据口径：用默认值继续，做完归档。'
const saved = await saveManual(projA, manualA)
check('手册存得下', saved.ok === true && saved.text === manualA, JSON.stringify(saved))
const readA = await getManual(projA)
const readB = await getManual(projB)
check('A 的手册读得回来', readA.text === manualA, JSON.stringify(readA.text))
check('B 读不到 A 的手册', readB.text === '', JSON.stringify(readB.text))

// ---------- 2. 开监工：建会话、发口径、记 sessionId ----------
const enabled = await post({ action: 'supervisor', root: projA, enabled: true })
check('开监工成功', enabled.ok === true, JSON.stringify(enabled.text || enabled.error))
const stateA = await getState(projA)
const supervisor = stateA.state?.supervisor
check('监工 sessionId 记进了 pipeline.json', Boolean(supervisor?.sessionId), JSON.stringify(supervisor))
check('监工开着', supervisor?.enabled === true, JSON.stringify(supervisor))
// 面板那一行读这三个字段；少一个就静默少显示一段，所以状态里必须始终带齐。
check(
  '状态里带齐最近一次值班的三个字段',
  ['lastAt', 'lastNote', 'lastError'].every((key) => Object.hasOwn(supervisor || {}, key)),
  JSON.stringify(supervisor),
)
const intro = prompts.find((row) => row.sessionId === supervisor.sessionId && row.text.includes('值班监工'))
check('开了之后先发口径', Boolean(intro), JSON.stringify(prompts.map((row) => row.text.slice(0, 30))))
// 从这里开始，宿主拒收发给监工的话：值班单送不出去要留下记录。
rejectPromptFor = supervisor.sessionId

// ---------- 3. 情况一：对话收尾了但没归档 → 值班单 ----------
await post({ action: 'run', root: projA })
const waiting = await waitFor(async () => {
  const view = await getState(projA)
  return (view.state?.nodes || []).find((node) => node.id === 'N1' && node.status === 'needs_human') ? view : null
})
check('N1 卡在「等你」', Boolean(waiting), JSON.stringify(waiting?.state?.nodes?.map((n) => [n.id, n.status])))
const pausedReport = await waitFor(() =>
  prompts.find((row) => row.sessionId === supervisor.sessionId && row.text.includes('N1 停住了')),
)
check('卡住之后给监工发了值班单', Boolean(pausedReport), JSON.stringify(prompts.map((row) => row.text.slice(0, 40))))
check('值班单带上手册原文', Boolean(pausedReport?.text.includes(manualA)), pausedReport?.text?.slice(0, 200))
check('值班单带上那一格最后说的话', Boolean(pausedReport?.text.includes('这个断言要放宽吗')), pausedReport?.text?.slice(0, 400))
const failedNotify = await waitFor(async () => {
  const view = await getState(projA)
  return view.state?.supervisor?.lastError ? view : null
})
check(
  '值班单没送出去 → lastError 记下原因',
  Boolean(failedNotify?.state?.supervisor?.lastError.includes('不收')),
  JSON.stringify(failedNotify?.state?.supervisor),
)

// tell 这条路也要真的送进去，并且能等到那一格的回复。
const told = await post({ action: 'tell', root: projA, nodeId: 'N1', text: '这一格还差什么？', wait: true })
check(
  'tell 送进那一格并带回回复',
  told.ok === true && String(told.text || '').includes('这个断言要放宽吗'),
  JSON.stringify(told.text || told.error),
)
await post({ action: 'stop', root: projA })

// ---------- 4. 情况二：上一格归档了、下一格没启动 → 值班单 ----------
// 打开推送通道（归档监听跟着连接走），再把 change 挪进 archive/。
const stream = await fetch(`${origin}/openspec-pipeline/api/events?root=${encodeURIComponent(projA)}`)
const reader = stream.body.getReader()
const pump = (async () => {
  for (;;) {
    const { done } = await reader.read()
    if (done) return
  }
})().catch(() => {})
await pause(300)

prompts.length = 0
rejectPromptFor = '' // 宿主恢复收消息：这一张值班单要能送进去
renameSync(path.join(projA, 'openspec', 'changes', 'a-one'), path.join(projA, 'openspec', 'changes', 'archive', '2026-11-02-a-one'))
const stuckReport = await waitFor(() =>
  prompts.find((row) => row.sessionId === supervisor.sessionId && row.text.includes('已经归档')),
)
check('归档了没人接着跑 → 给监工发值班单', Boolean(stuckReport), JSON.stringify(prompts.map((row) => row.text.slice(0, 40))))
check('值班单说清是哪一格', Boolean(stuckReport?.text.includes('N1')), stuckReport?.text?.slice(0, 300))
const recovered = await getState(projA)
check(
  '下一次值班单送成功 → lastError 清空',
  recovered.state?.supervisor?.lastError === '',
  JSON.stringify(recovered.state?.supervisor),
)

// ---------- 5. 口径第一次没送出去：会话留着，重试复用同一个 ----------
const createsBeforeB = createCalls
rejectNextPrompt = true
const firstTry = await post({ action: 'supervisor', root: projB, enabled: true })
check('口径没送出去 → 开监工返回失败', firstTry.ok === false, JSON.stringify(firstTry.text || firstTry.error))
const afterFailB = await getState(projB)
const supervisorB = afterFailB.state?.supervisor
check('失败的会话已经记进 pipeline.json', Boolean(supervisorB?.sessionId), JSON.stringify(supervisorB))
check('口径没送出去，监工不算开着', supervisorB?.enabled === false, JSON.stringify(supervisorB))
const retried = await post({ action: 'supervisor', root: projB, enabled: true })
check('重试开成功了', retried.ok === true, JSON.stringify(retried.text || retried.error))
const afterRetryB = await getState(projB)
check(
  '重试复用同一个会话，没有第二个孤儿',
  afterRetryB.state?.supervisor?.sessionId === supervisorB?.sessionId && createCalls - createsBeforeB === 1,
  `sessionId ${supervisorB?.sessionId} → ${afterRetryB.state?.supervisor?.sessionId}，create 调了 ${createCalls - createsBeforeB} 次`,
)
check('重试之后监工开着', afterRetryB.state?.supervisor?.enabled === true, JSON.stringify(afterRetryB.state?.supervisor))

try {
  await reader.cancel()
} catch {}
pump.catch(() => {})
cleanup()
await new Promise((resolve) => server.close(resolve))

console.log(failures.length ? `\n${failures.length} 项没过` : '\n全部通过')
process.exit(failures.length ? 1 : 0)
