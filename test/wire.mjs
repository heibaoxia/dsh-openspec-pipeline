// 离线回归：wire（Agent 画图的入口）。
//
// 要证明的是「画进去」和「还能改」这两件事同时成立：
//   1. order / stages / steps 三种写法都接成对的线，位置留空（由画布自动分层）；
//   2. 重复调同一张单子是幂等的，不会越画越多；
//   3. 人手断开过的线，没让重排（rewire）就一根都不动；让了才接回去；
//   4. 跑着的时候也能补一格：正在跑的格子状态、sessionId、线都不被动，新格子从待跑起，
//      而且这一轮会接着把它跑掉（不用重开一轮）；
//   5. 已经跑完的格子，线不动（改线不会让它重跑，只会让画布和事实对不上）；
//   6. 坏图整单拒绝、什么都不写：change 不存在、成环、两种写法同时给；
//   7. settings 逐格写提示词和模型，没写的项不动；新格子照 add-all 的规矩播种默认组合；
//   8. dryRun 只算不写。
//
// 不需要 openspec 命令，也不需要浏览器。
//
// 跑法：
//   node plugins/dsh-openspec-pipeline/test/wire.mjs
import { mkdtempSync, mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const failures = []
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`)
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    failures.push(name)
  }
}

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'osp-wire-'))
const profile = path.join(sandbox, 'profile')
mkdirSync(profile, { recursive: true })

function makeProject(name, changes) {
  const proj = path.join(sandbox, name)
  const dir = path.join(proj, 'openspec', 'changes')
  mkdirSync(path.join(proj, 'openspec', 'specs'), { recursive: true })
  mkdirSync(path.join(dir, 'archive'), { recursive: true })
  for (const change of changes) {
    const base = path.join(dir, change)
    mkdirSync(path.join(base, 'specs', 'demo-cap'), { recursive: true })
    writeFileSync(path.join(base, 'proposal.md'), `## Why\n\n${change} 有用。\n\n## What Changes\n\n加一个能力。\n`, 'utf8')
    writeFileSync(
      path.join(base, 'specs', 'demo-cap', 'spec.md'),
      [
        '## ADDED Requirements',
        '',
        `### Requirement: ${change}`,
        'The system SHALL do the thing.',
        '',
        '#### Scenario: works',
        '- **WHEN** 有人要它做',
        '- **THEN** 它做了',
        '',
      ].join('\n'),
      'utf8',
    )
    // 四件规划写完才达到执行标准（缺 design 这一格就不开跑）。
    writeFileSync(path.join(base, 'design.md'), `# 设计 ${change}\n`, 'utf8')
    writeFileSync(path.join(base, 'tasks.md'), '## 1. 任务\n\n- [x] 1.1 做完了\n', 'utf8')
  }
  return proj
}

function writePipeline(proj, nodes, extra = {}) {
  writeFileSync(
    path.join(proj, 'openspec', 'pipeline.json'),
    JSON.stringify(
      {
        version: 1,
        name: '接线测试',
        maxParallel: 1,
        profiles: [],
        defaultProfileId: '',
        ...extra,
        nodes: [{ id: 'start', kind: 'start', change: '', deps: [], status: 'done' }, ...nodes],
      },
      null,
      2,
    ),
    'utf8',
  )
}

// 假对话收到「执行 x Change」就把 x 归档：只有这样这一格才会记「完成」，下游才动。
function archive(proj, change) {
  const from = path.join(proj, 'openspec', 'changes', change)
  if (!existsSync(from)) return
  renameSync(from, path.join(proj, 'openspec', 'changes', 'archive', `2026-11-01-${change}`))
}

const diskOf = (proj) => JSON.parse(readFileSync(path.join(proj, 'openspec', 'pipeline.json'), 'utf8'))

process.env.DSH_PROFILE_DIR = profile
const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

const routes = []
const sessions = new Map()
const calls = []
let workspaces = []
// true 时假对话永远不结束：用来把一格钉在「跑着」上。
let holdSessions = false
let activeProject = ''

const ctx = {
  tools: { register() { return () => {} } },
  webServer: { register(route) { routes.push(route); return () => {} } },
  get(name) {
    if (name === 'sessionController') {
      return {
        async create() {
          const sessionId = `session-${sessions.size + 1}`
          sessions.set(sessionId, {
            snapshotEvents() {
              if (holdSessions) return []
              return [{ type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } }]
            },
          })
          return { sessionId }
        },
        async prompt(request) {
          const text = String(request.content?.[0]?.text || '')
          calls.push(text)
          const match = /^执行 (\S+) Change/m.exec(text)
          if (match) archive(activeProject, match[1])
        },
      }
    }
    if (name === 'agents') return { get: (id) => (sessions.has(id) ? { session: sessions.get(id) } : undefined) }
    if (name === 'sessions') return { get: (id) => sessions.get(id) }
    if (name === 'workspaceRegistry') return { list: () => workspaces }
    return undefined
  },
}
apply(ctx)
if (!routes.length) throw new Error('路由没注册上，测试没法继续')

async function request(method, url, body) {
  const req = {
    method,
    url,
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  }
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(key, value) { this.headers[key] = value },
    end(text) { this.body = text },
  }
  await routes[0].handler(req, res)
  return { status: res.statusCode, payload: JSON.parse(res.body || '{}') }
}
const post = (body) => request('POST', '/openspec-pipeline/api/action', body).then((r) => r.payload)
const getState = (root) =>
  request('GET', `/openspec-pipeline/api/state?root=${encodeURIComponent(root)}`).then((r) => r.payload)

// 驳回走的是 {ok:false, error}，成功走的是 {ok:true, text}；判断信息时两边都看。
const msgOf = (payload) => String(payload?.text || payload?.error || '')
const nodesOf = (payload) => payload?.state?.nodes || []
const nodeOf = (payload, id) => nodesOf(payload).find((node) => node.id === id) || null
const idsOf = (payload) => nodesOf(payload).filter((n) => n.kind !== 'start').map((n) => n.id)
const depsOf = (payload, id) => nodeOf(payload, id)?.deps || []

async function waitFor(root, predicate, timeout = 8000) {
  const started = Date.now()
  for (;;) {
    const payload = await getState(root)
    if (predicate(payload)) return payload
    if (Date.now() - started > timeout) {
      throw new Error(`等超时：${JSON.stringify(nodesOf(payload).map((n) => [n.id, n.status, n.note]))}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
}

// ---------- 1. order：串行 + 位置留空 ----------
const projA = makeProject('case-order', ['alpha', 'beta', 'gamma'])
workspaces = [{ id: 'w1', title: 'case-order', path: projA, sessionIds: [] }]
await post({ action: 'root', root: projA })

const wired = await post({ action: 'wire', order: ['alpha', 'beta', 'gamma'] })
check('order 加了 3 格', idsOf(wired).sort().join() === 'alpha,beta,gamma', JSON.stringify(idsOf(wired)))
check('第一格接「开工」', depsOf(wired, 'alpha').join() === 'start', JSON.stringify(depsOf(wired, 'alpha')))
check('第二格等第一格（写 change 名，不是节点 id）', depsOf(wired, 'beta').join() === 'alpha', JSON.stringify(depsOf(wired, 'beta')))
check('第三格等第二格', depsOf(wired, 'gamma').join() === 'beta', JSON.stringify(depsOf(wired, 'gamma')))
check(
  '新接的格子不写位置（画布自己分层）',
  nodeOf(wired, 'beta').x === null && nodeOf(wired, 'beta').y === null,
  JSON.stringify([nodeOf(wired, 'beta').x, nodeOf(wired, 'beta').y]),
)
check('新接的格子从待跑起', nodeOf(wired, 'beta').status === 'pending', nodeOf(wired, 'beta').status)
const textA = msgOf(wired)
check('回话里有批次', /第 1 批/.test(textA) && /第 3 批/.test(textA), textA)
check('回话里写了每格等谁', /每格等谁/.test(textA), textA)

// ---------- 2. 幂等：同一张单子再画一次 ----------
const again = await post({ action: 'wire', order: ['alpha', 'beta', 'gamma'] })
check('重复画不新增格子', idsOf(again).length === 3, JSON.stringify(idsOf(again)))
check('重复画不改线', depsOf(again, 'gamma').join() === 'beta', JSON.stringify(depsOf(again, 'gamma')))
check('重复画说清没新增', /这次没有新增格子/.test(msgOf(again)), msgOf(again))

// ---------- 3. 人手断开的线，不能在下一次画图里被接回去 ----------
const draft = again.state
const detached = { ...draft, nodes: draft.nodes.map((n) => (n.id === 'gamma' ? { ...n, deps: [] } : n)) }
const savedDetach = await post({ action: 'save', state: detached })
check('人手断开生效', depsOf(savedDetach, 'gamma').length === 0, JSON.stringify(depsOf(savedDetach, 'gamma')))

const keepMine = await post({ action: 'wire', order: ['alpha', 'beta', 'gamma'] })
check('没让重排就一根线都不动', depsOf(keepMine, 'gamma').length === 0, JSON.stringify(depsOf(keepMine, 'gamma')))
check('并且回话里点出来', /已有线没动/.test(msgOf(keepMine)), msgOf(keepMine))

const rewired = await post({ action: 'wire', order: ['alpha', 'beta', 'gamma'], rewire: true })
check('说重排才接回去', depsOf(rewired, 'gamma').join() === 'beta', JSON.stringify(depsOf(rewired, 'gamma')))

// ---------- 4. 已经跑完的格子：线不动 ----------
const projDone = makeProject('case-done', ['done-x', 'wait-y'])
writePipeline(projDone, [
  { id: 'D1', change: 'done-x', deps: ['start'], status: 'done', sessionId: 'session-old', approved: '2026-01-01T00:00:00.000Z' },
  { id: 'D2', change: 'wait-y', deps: ['D1'], status: 'pending' },
])
workspaces = [{ id: 'w2', title: 'case-done', path: projDone, sessionIds: [] }]
await post({ action: 'root', root: projDone })
const frozen = await post({
  action: 'wire',
  // 想让跑完的那格改等另一格（真改了会成环）—— 它跑完了，所以线一根都不许动。
  steps: [{ change: 'done-x', after: ['wait-y'] }, { change: 'wait-y', after: ['done-x'] }],
  settings: [{ change: 'done-x', prompt: '这句不该被写进去' }],
  rewire: true,
})
check('跑完的格子保留状态', nodeOf(frozen, 'D1').status === 'done', nodeOf(frozen, 'D1').status)
check('跑完的格子保留 sessionId', nodeOf(frozen, 'D1').sessionId === 'session-old', nodeOf(frozen, 'D1').sessionId)
check('跑完的格子保留开工时间', nodeOf(frozen, 'D1').approved === '2026-01-01T00:00:00.000Z', nodeOf(frozen, 'D1').approved)
check('跑完的格子线没动', depsOf(frozen, 'D1').join() === 'start', JSON.stringify(depsOf(frozen, 'D1')))
check('跑完的格子提示词也没被改', !nodeOf(frozen, 'D1').prompt, nodeOf(frozen, 'D1').prompt)
check('回话说清哪些线没动', /跑完了或正在跑/.test(msgOf(frozen)), msgOf(frozen))
check('回话说清哪些设置没动', /设置没动/.test(msgOf(frozen)), msgOf(frozen))

// ---------- 5. stages：组内并列、组间栅栏 ----------
const projB = makeProject('case-stages', ['s1', 's2', 's3', 's4'])
workspaces = [{ id: 'w3', title: 'case-stages', path: projB, sessionIds: [] }]
await post({ action: 'root', root: projB })
const staged = await post({ action: 'wire', stages: [['s1'], ['s2', 's3'], ['s4']] })
check(
  '第二组两格都等第一组',
  depsOf(staged, 's2').join() === 's1' && depsOf(staged, 's3').join() === 's1',
  JSON.stringify([depsOf(staged, 's2'), depsOf(staged, 's3')]),
)
check('第三组等第二组两格', [...depsOf(staged, 's4')].sort().join() === 's2,s3', JSON.stringify(depsOf(staged, 's4')))
check('并列时提醒 maxParallel', /maxParallel/.test(msgOf(staged)), msgOf(staged))

// ---------- 6. 坏图整单拒绝 ----------
const before = JSON.stringify(diskOf(projB))
const missing = await post({ action: 'wire', order: ['s1', 'does-not-exist'] })
check('名字不存在就拒绝', /找不到这些 change/.test(msgOf(missing)), msgOf(missing))
check('拒绝时一个字节都没写', JSON.stringify(diskOf(projB)) === before)

const loop = await post({
  action: 'wire',
  steps: [{ change: 's2', after: ['s3'] }, { change: 's3', after: ['s2'] }],
  rewire: true,
})
check('成环就拒绝', /成环/.test(msgOf(loop)), msgOf(loop))
check('成环时一个字节都没写', JSON.stringify(diskOf(projB)) === before)

const both = await post({ action: 'wire', order: ['s1'], stages: [['s1']] })
check('两种写法同时给就拒绝', /只能给一个/.test(msgOf(both)), msgOf(both))

// ---------- 7. settings：逐格提示词、模型；播种默认组合 ----------
const projC = makeProject('case-settings', ['p1', 'p2'])
writePipeline(projC, [], {
  profiles: [
    { id: 'profile-1', name: '默认', preset: 'ptc', provider: 'prov', model: 'model-a', effort: 'max', prompt: '共用尾巴：遇阻停下报告。' },
  ],
  defaultProfileId: 'profile-1',
})
workspaces = [{ id: 'w4', title: 'case-settings', path: projC, sessionIds: [] }]
await post({ action: 'root', root: projC })
const tuned = await post({
  action: 'wire',
  order: ['p1', 'p2'],
  settings: [{ change: 'p2', prompt: 'p2 自己的口径：按 proposal 通过标准逐条跑。', model: 'model-b' }],
})
check('没写提示词的格子播种默认组合', String(nodeOf(tuned, 'p1').prompt || '').includes('共用尾巴'), nodeOf(tuned, 'p1').prompt)
check('写了提示词的格子用自己那份', nodeOf(tuned, 'p2').prompt === 'p2 自己的口径：按 proposal 通过标准逐条跑。', nodeOf(tuned, 'p2').prompt)
check('逐格换模型', nodeOf(tuned, 'p2').model === 'model-b', nodeOf(tuned, 'p2').model)
check('没写的项继承播种值', nodeOf(tuned, 'p2').provider === 'prov', nodeOf(tuned, 'p2').provider)
check('设置碰不到状态', nodeOf(tuned, 'p2').status === 'pending', nodeOf(tuned, 'p2').status)

// ---------- 8. dryRun：只算不写 ----------
const projD = makeProject('case-dry', ['d1', 'd2'])
workspaces = [{ id: 'w5', title: 'case-dry', path: projD, sessionIds: [] }]
await post({ action: 'root', root: projD })
await post({ action: 'wire', order: ['d1'] })
const beforeDry = JSON.stringify(diskOf(projD))
const dry = await post({ action: 'wire', order: ['d1', 'd2'], dryRun: true })
check('dryRun 说清什么都没写', /dryRun/.test(msgOf(dry)), msgOf(dry))
check('dryRun 真的没写', JSON.stringify(diskOf(projD)) === beforeDry)
check('dryRun 也会把要加的格子算出来', /d2/.test(msgOf(dry)), msgOf(dry))

// ---------- 9. 跑着的时候补一格：正在跑的不动，新格子接得上、还接着跑 ----------
const projE = makeProject('case-running', ['r1', 'r2'])
workspaces = [{ id: 'w6', title: 'case-running', path: projE, sessionIds: [] }]
activeProject = projE
await post({ action: 'root', root: projE })
await post({ action: 'wire', order: ['r1'] })
holdSessions = true
calls.length = 0
await post({ action: 'run' })
const running = await waitFor(projE, (payload) => nodeOf(payload, 'r1')?.status === 'running')
const liveSession = nodeOf(running, 'r1').sessionId
const liveDeps = JSON.stringify(depsOf(running, 'r1'))

const grown = await post({ action: 'wire', steps: [{ change: 'r2', after: ['r1'] }] })
check('跑着的时候能加一格', Boolean(nodeOf(grown, 'r2')), JSON.stringify(idsOf(grown)))
check('新格子接在正在跑的那一格后面', depsOf(grown, 'r2').join() === 'r1', JSON.stringify(depsOf(grown, 'r2')))
check('正在跑的格子状态没被动', nodeOf(grown, 'r1').status === 'running', nodeOf(grown, 'r1').status)
check(
  '正在跑的格子 sessionId 没被动',
  nodeOf(grown, 'r1').sessionId === liveSession,
  JSON.stringify([liveSession, nodeOf(grown, 'r1').sessionId]),
)
check('正在跑的格子线没被动', JSON.stringify(depsOf(grown, 'r1')) === liveDeps, JSON.stringify(depsOf(grown, 'r1')))
check('新格子从待跑起', nodeOf(grown, 'r2').status === 'pending', nodeOf(grown, 'r2').status)

// 放开之后 runner 该自己把 r1 收尾、接着把补进来的 r2 跑掉 —— 证明它真的进了这一轮。
holdSessions = false
const finished = await waitFor(projE, (payload) => nodeOf(payload, 'r2')?.status === 'done', 12000)
check(
  '补进去的格子被这一轮接着跑了',
  nodeOf(finished, 'r2').status === 'done',
  JSON.stringify(nodesOf(finished).map((n) => [n.id, n.status, n.note])),
)
await post({ action: 'stop' })

// ---------- 10. 单格「启动」模式下补一格：可跑范围要跟着重算 ----------
const projF = makeProject('case-from', ['f1', 'f2'])
workspaces = [{ id: 'w7', title: 'case-from', path: projF, sessionIds: [] }]
activeProject = projF
await post({ action: 'root', root: projF })
await post({ action: 'wire', order: ['f1'] })
holdSessions = true
await post({ action: 'start-node', nodeId: 'f1' })
await waitFor(projF, (payload) => nodeOf(payload, 'f1')?.status === 'running')

// 单格启动时，可跑范围是开跑那一刻算死的。这里补一格下游，wire 该把它算进去。
await post({ action: 'wire', steps: [{ change: 'f2', after: ['f1'] }] })
holdSessions = false
const fromRun = await waitFor(projF, (payload) => nodeOf(payload, 'f2')?.status === 'done', 12000)
check(
  '单格启动模式下补进来的格子也被接着跑',
  nodeOf(fromRun, 'f2').status === 'done',
  JSON.stringify(nodesOf(fromRun).map((n) => [n.id, n.status, n.note])),
)
await post({ action: 'stop' })

// ---------- 11. 已归档的 change：wire 跳过并回报，plan 整单拒绝 ----------
console.log('\n11. 已归档的 change 不能画回图里')
const projH = makeProject('case-archived', ['mixed-a', 'mixed-b', 'mixed-c'])
archive(projH, 'mixed-b')
workspaces = [{ id: 'w8', title: 'case-archived', path: projH, sessionIds: [] }]
await post({ action: 'root', root: projH })

const mixed = await post({ action: 'wire', order: ['mixed-a', 'mixed-b', 'mixed-c'] })
check('已归档的那一格没加进来', idsOf(mixed).sort().join() === 'mixed-a,mixed-c', JSON.stringify(idsOf(mixed)))
check(
  '回话写明跳过了哪个、为什么',
  /跳过/.test(msgOf(mixed)) && /mixed-b/.test(msgOf(mixed)) && /归档/.test(msgOf(mixed)),
  msgOf(mixed),
)
check(
  '已归档的上游当成「只等开工」，下游不会被扔在画布外',
  depsOf(mixed, 'mixed-c').join() === 'start',
  JSON.stringify(depsOf(mixed, 'mixed-c')),
)
check('新增的只有两格', /新增 2 格/.test(msgOf(mixed)), msgOf(mixed))

// 上游写成已归档的名字：当成「已经满足」吃掉，不整单拒绝。
const satisfied = await post({ action: 'wire', steps: [{ change: 'mixed-c', after: ['mixed-b'] }], rewire: true })
check('上游已归档不整单拒绝', satisfied.ok !== false, msgOf(satisfied))
check('这条等待当成已经满足（只等开工）', depsOf(satisfied, 'mixed-c').join() === 'start', JSON.stringify(depsOf(satisfied, 'mixed-c')))
check('回话里写的是实际的线', /mixed-c → 开工/.test(msgOf(satisfied)), msgOf(satisfied))

// plan：出现已归档 / 找不到的名字 → 整单拒绝，一个字节都不写。
const beforePlan = JSON.stringify(diskOf(projH))
const rejectedPlan = await post({
  action: 'plan',
  nodes: [{ id: 'X', change: 'mixed-a' }, { id: 'Y', change: 'mixed-b' }],
})
check('plan 带已归档的名字就拒绝', rejectedPlan.ok === false && /不能画进图里/.test(msgOf(rejectedPlan)), msgOf(rejectedPlan))
check('拒绝时点名是哪个', /mixed-b/.test(msgOf(rejectedPlan)), msgOf(rejectedPlan))
check('plan 被拒绝时 pipeline.json 没动', JSON.stringify(diskOf(projH)) === beforePlan)

const unknownPlan = await post({ action: 'plan', nodes: [{ id: 'X', change: 'does-not-exist' }] })
check('plan 带找不到的名字也拒绝', unknownPlan.ok === false && /不能画进图里/.test(msgOf(unknownPlan)), msgOf(unknownPlan))
check('还是没写', JSON.stringify(diskOf(projH)) === beforePlan)

console.log(failures.length ? `\n${failures.length} 项没过` : '\n全部通过')
process.exit(failures.length ? 1 : 0)
