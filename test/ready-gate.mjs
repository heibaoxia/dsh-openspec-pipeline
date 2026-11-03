// 离线回归：执行标准（开跑前的那道闸）与「等写好自动放行」。
//
// 要证明四件事：
//   1. 没任务清单的格子开跑不建会话，记「等你」并写明差什么，runner 不退；
//   2. 补上 tasks.md 之后，同一轮里自己放行、自己开跑（不用再点「开始」）；
//   3. 右键「启动」用同一把尺子：不够格直接拒绝，不建会话、也不起 runner；
//   4. 读不到 openspec status 时降级：只按目录 + 任务清单判，不因为读不到就拦住。
//
// 跑法（不需要起 DSH）：
//   node plugins/dsh-openspec-pipeline/test/ready-gate.mjs
import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// 卡住就自己退出：runner 的定时器会一直挂着进程。
const watchdog = setTimeout(() => {
  console.log('WATCHDOG：90 秒没跑完，判定卡住')
  process.exit(3)
}, 90000)
watchdog.unref?.()

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'osp-ready-'))
const profile = path.join(sandbox, 'profile')
mkdirSync(profile, { recursive: true })

const spec = (name) =>
  `## ADDED Requirements\n\n### Requirement: ${name}\n\nThe system SHALL do it.\n\n#### Scenario: works\n- **WHEN** 有人要它做\n- **THEN** 它做了\n`

// 四件规划写完（proposal / specs / design / tasks）。tasks=false 时故意不写任务清单。
function makeChange(proj, name, options = {}) {
  const dir = path.join(proj, 'openspec', 'changes', name)
  mkdirSync(path.join(dir, 'specs', 'demo'), { recursive: true })
  writeFileSync(path.join(dir, 'proposal.md'), `# ${name}\n`, 'utf8')
  writeFileSync(path.join(dir, 'design.md'), `# ${name}\n`, 'utf8')
  writeFileSync(path.join(dir, 'specs', 'demo', 'spec.md'), spec(name), 'utf8')
  if (options.tasks !== false) writeFileSync(path.join(dir, 'tasks.md'), '- [ ] 做事\n', 'utf8')
  return dir
}

function makeProject(tag, nodes) {
  const proj = path.join(sandbox, tag)
  mkdirSync(path.join(proj, 'openspec', 'changes', 'archive'), { recursive: true })
  mkdirSync(path.join(proj, 'openspec', 'specs'), { recursive: true })
  writeFileSync(
    path.join(proj, 'openspec', 'pipeline.json'),
    JSON.stringify(
      {
        version: 1,
        name: `执行标准 ${tag}`,
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
  return proj
}

// 1. 整批开跑：没有任务清单的那一格不开跑，补上之后自己接着跑。
const projA = makeProject('run-gate', [
  { id: 'N1', change: 'gate-a', deps: ['start'], status: 'pending' },
  { id: 'N2', change: 'gate-b', deps: ['N1'], status: 'pending' },
])
makeChange(projA, 'gate-a', { tasks: false })
const gateADir = path.join(projA, 'openspec', 'changes', 'gate-a')
makeChange(projA, 'gate-b')

// 2. 手动「启动」：同一把尺子。
const projB = makeProject('start-gate', [{ id: 'N1', change: 'later', deps: ['start'], status: 'pending' }])
makeChange(projB, 'later', { tasks: false })

// 3. 降级：只有任务清单，读不到规划进度也得能跑。
const projC = makeProject('degrade', [{ id: 'N1', change: 'bare', deps: ['start'], status: 'pending' }])
mkdirSync(path.join(projC, 'openspec', 'changes', 'bare'), { recursive: true })
writeFileSync(path.join(projC, 'openspec', 'changes', 'bare', 'tasks.md'), '- [ ] 做事\n', 'utf8')

process.env.DSH_PROFILE_DIR = profile
const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

const routes = []
const sessions = new Map()
const calls = { created: [], prompted: [] }
let activeProject = ''
let sessionSeq = 0

// 假的对话：收到「执行 xxx Change」就当场归档，好让归档门禁放行。
function archiveChange(proj, change) {
  const from = path.join(proj, 'openspec', 'changes', change)
  if (!from) return
  try {
    renameSync(from, path.join(proj, 'openspec', 'changes', 'archive', `2026-11-03-${change}`))
  } catch {}
}

const ctx = {
  tools: { register() { return () => {} } },
  webServer: { register(route) { routes.push(route); return () => {} } },
  get(name) {
    if (name === 'sessionController') {
      return {
        async create() {
          const sessionId = `session-ready-${++sessionSeq}`
          calls.created.push(sessionId)
          sessions.set(sessionId, {
            seq: 0,
            snapshotEvents(from) {
              return from <= 1 ? [{ type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } }] : []
            },
          })
          return { sessionId }
        },
        async prompt(request) {
          const text = String(request.content?.[0]?.text || '')
          calls.prompted.push(text)
          const match = /^执行 (\S+) Change/m.exec(text)
          if (match) archiveChange(activeProject, match[1])
        },
      }
    }
    if (name === 'agents') return { get: (id) => (sessions.has(id) ? { session: sessions.get(id) } : undefined) }
    if (name === 'sessions') return { get: (id) => sessions.get(id) }
    if (name === 'workspaceRegistry') {
      return {
        list: () => [{ id: 'ws', title: path.basename(activeProject || sandbox), path: activeProject || sandbox }],
        create: (root) => ({ id: 'ws', title: path.basename(root), path: root }),
      }
    }
    return undefined
  },
}
apply(ctx)
if (!routes.length) throw new Error('路由没注册上，测试没法继续')

const failures = []
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`)
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    failures.push(name)
  }
}

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
    setHeader(key, value) {
      this.headers[key] = value
    },
    end(text) {
      this.body = text
    },
  }
  await routes[0].handler(req, res)
  return { status: res.statusCode, payload: JSON.parse(res.body || '{}') }
}
const post = (body) => request('POST', '/openspec-pipeline/api/action', body).then((r) => r.payload)
const getState = (root) =>
  request('GET', `/openspec-pipeline/api/state?root=${encodeURIComponent(root)}`).then((r) => r.payload)
const statusOf = (payload, id) => (payload.state?.nodes || []).find((node) => node.id === id)?.status
const noteOf = (payload, id) => (payload.state?.nodes || []).find((node) => node.id === id)?.note

async function waitFor(root, predicate, timeout = 12000) {
  const started = Date.now()
  for (;;) {
    const payload = await getState(root)
    if (predicate(payload)) return payload
    if (Date.now() - started > timeout) {
      throw new Error(
        `等超时：${JSON.stringify((payload.state?.nodes || []).map((n) => [n.id, n.status, n.note]))}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
}

// ---------- 1. 没写好 → 不开跑，但也不收工 ----------

console.log('1. 没有任务清单：不建会话，记「等你」，runner 不退')
activeProject = projA
await post({ action: 'root', root: projA })
await post({ action: 'run' })
const held = await waitFor(projA, (payload) => statusOf(payload, 'N1') === 'needs_human')
check('没写好的格子记「等你」', statusOf(held, 'N1') === 'needs_human', JSON.stringify(statusOf(held, 'N1')))
check('说明里写清差什么', String(noteOf(held, 'N1') || '').includes('任务清单'), noteOf(held, 'N1'))
check('没为它建会话', calls.created.length === 0, JSON.stringify(calls.created))
check('runner 还在等（这一轮不收工）', held.running === true, JSON.stringify(held.running))
check('状态里写清在等哪几格写好', (held.waiting?.ready || []).includes('N1'), JSON.stringify(held.waiting))
check('下游没动', statusOf(held, 'N2') === 'pending', JSON.stringify(statusOf(held, 'N2')))

console.log('\n2. 补上 tasks.md：同一轮里自己放行、自己开跑')
writeFileSync(path.join(gateADir, 'tasks.md'), '- [ ] 做事\n', 'utf8')
const released = await waitFor(projA, (payload) => statusOf(payload, 'N1') === 'done' && statusOf(payload, 'N2') === 'done')
check('写完之后自己开跑并归档', statusOf(released, 'N1') === 'done', JSON.stringify(statusOf(released, 'N1')))
check('下游跟着跑完', statusOf(released, 'N2') === 'done', JSON.stringify(statusOf(released, 'N2')))
check('跑了两个对话', calls.created.length === 2, JSON.stringify(calls.created))
check(
  '先跑的是刚写完的那一格',
  /^执行 gate-a Change/m.test(String(calls.prompted[0] || '')) && /^执行 gate-b Change/m.test(String(calls.prompted[1] || '')),
  JSON.stringify(calls.prompted.map((text) => text.split('\n')[0])),
)

// ---------- 3. 手动「启动」：同一把尺子 ----------

console.log('\n3. 手动「启动」一个没写好的格子：拒绝，不建会话、不起 runner')
calls.created.length = 0
calls.prompted.length = 0
await post({ action: 'root', root: projB })
const rejected = await post({ action: 'start-node', nodeId: 'N1' })
check('拒绝启动', rejected.ok === false, JSON.stringify(rejected).slice(0, 300))
check('原话里写清差任务清单', /任务清单/.test(String(rejected.error || '')), String(rejected.error || ''))
check('拒绝时没建会话', calls.created.length === 0, JSON.stringify(calls.created))
const idle = await getState(projB)
check('拒绝时没起 runner', idle.running === false, JSON.stringify(idle.running))
check('格子还是「待跑」', statusOf(idle, 'N1') === 'pending', JSON.stringify(statusOf(idle, 'N1')))

// ---------- 4. 读不到 openspec status：降级，只看目录和任务清单 ----------

console.log('\n4. 读不到 openspec status：降级，不因为读不到就拦住')
await post({ action: 'root', root: projC })
const savedPath = process.env.PATH
process.env.PATH = ''
try {
  // 强制读一次仓库：CLI 读不到，planning 是 null（这条结果进 3 秒缓存）。
  await getState(projC)
  activeProject = projC
  calls.created.length = 0
  await post({ action: 'run' })
  const degraded = await waitFor(projC, (payload) => statusOf(payload, 'N1') === 'done', 12000)
  check('只有任务清单也照样开跑', statusOf(degraded, 'N1') === 'done', JSON.stringify(statusOf(degraded, 'N1')))
  check('降级时确实建了会话', calls.created.length === 1, JSON.stringify(calls.created))
} finally {
  process.env.PATH = savedPath
}

console.log(failures.length ? `\n${failures.length} 项没过` : '\n全部通过')
process.exit(failures.length ? 1 : 0)
