// 离线回归：右键「启动」只从这一格开跑，前置按「跑完了或已归档」算。
//
// 跑法（不需要起 DSH）：
//   node plugins/dsh-openspec-pipeline/test/start-node.mjs
//
// 覆盖三件事：
//   1. 前置还没跑完也没归档 → 启动被拒绝，原话里点出是哪一格；
//   2. 从中间某一格启动 → 只有它和它下游开跑，上游不动；
//   3. 前置「归档了但那一轮还没收尾」（状态还不是 done）→ 照样能启动。
import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'osp-start-'))
const profile = path.join(sandbox, 'profile')
const proj = path.join(sandbox, 'demo-project')
mkdirSync(profile, { recursive: true })
mkdirSync(path.join(proj, 'openspec', 'changes', 'archive'), { recursive: true })
mkdirSync(path.join(proj, 'openspec', 'specs'), { recursive: true })
// 四件规划写完才达到执行标准（缺一件这一格就不开跑）。
function makeChange(name) {
  const dir = path.join(proj, 'openspec', 'changes', name)
  mkdirSync(path.join(dir, 'specs', 'demo'), { recursive: true })
  writeFileSync(path.join(dir, 'proposal.md'), `# ${name}\n`, 'utf8')
  writeFileSync(path.join(dir, 'design.md'), `# ${name}\n`, 'utf8')
  writeFileSync(path.join(dir, 'tasks.md'), '- [ ] 做事\n', 'utf8')
  writeFileSync(
    path.join(dir, 'specs', 'demo', 'spec.md'),
    `## ADDED Requirements\n\n### Requirement: ${name}\n\nThe system SHALL do it.\n\n#### Scenario: works\n- **WHEN** 有人要它做\n- **THEN** 它做了\n`,
    'utf8',
  )
}
for (const name of ['alpha', 'beta']) makeChange(name)

function archiveChange(name) {
  renameSync(
    path.join(proj, 'openspec', 'changes', name),
    path.join(proj, 'openspec', 'changes', 'archive', `2026-10-31-${name}`),
  )
}

process.env.DSH_PROFILE_DIR = profile

const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

const tools = []
const routes = []
const calls = { created: [], prompted: [] }
const sessions = new Map()
let sessionSeq = 0

const ctx = {
  tools: { register(definition) { tools.push(definition); return () => {} } },
  webServer: { register(route) { routes.push(route); return () => {} } },
  get(name) {
    if (name === 'sessionController') {
      return {
        async create(request) {
          calls.created.push(request)
          const sessionId = `session-test-${++sessionSeq}`
          sessions.set(sessionId, {
            seq: 0,
            snapshotEvents(from) {
              return from <= 1
                ? [{ type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } }]
                : []
            },
          })
          return { sessionId }
        },
        async selectModel(request) {
          return { selected: { provider: request.provider, model: request.model } }
        },
        async prompt(request) {
          calls.prompted.push(request)
          const text = String(request.content?.[0]?.text || '')
          const match = /^执行 (\S+) Change/m.exec(text)
          if (match) archiveChange(match[1])
          return undefined
        },
      }
    }
    if (name === 'agents') return { get: (id) => (sessions.has(id) ? { session: sessions.get(id) } : undefined) }
    if (name === 'sessions') return { get: (id) => sessions.get(id) }
    if (name === 'agentDefaultModel') return null
    if (name === 'workspaceRegistry') {
      return {
        list: () => [{ id: 'ws-demo', title: 'demo-project', path: proj }],
        create: async () => ({ id: 'ws-demo', title: 'demo-project', path: proj }),
      }
    }
    return undefined
  },
}

apply(ctx)
if (!tools.length) throw new Error('工具没注册上')
if (!routes.length) throw new Error('路由没注册上')

async function postAction(body) {
  const req = {
    method: 'POST',
    url: '/openspec-pipeline/api/action',
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  }
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(key, value) { this.headers[key] = value },
    end(bodyText) { this.body = bodyText },
  }
  await routes[0].handler(req, res)
  return { status: res.statusCode, payload: JSON.parse(res.body || '{}') }
}

async function getState() {
  const req = {
    method: 'GET',
    url: '/openspec-pipeline/api/state',
    [Symbol.asyncIterator]: async function* () {},
  }
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(key, value) { this.headers[key] = value },
    end(bodyText) { this.body = bodyText },
  }
  await routes[0].handler(req, res)
  return JSON.parse(res.body || '{}')
}

async function waitFor(predicate, timeout = 8000) {
  const started = Date.now()
  for (;;) {
    const state = await getState()
    if (predicate(state)) return state
    if (Date.now() - started > timeout) {
      throw new Error(`等超时：${JSON.stringify(state.state?.nodes?.map((n) => [n.id, n.status]))}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const failures = []
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`)
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    failures.push(name)
  }
}

const statusOf = (payload, id) => payload.state?.nodes?.find((node) => node.id === id)?.status

await postAction({ action: 'root', root: proj })
await postAction({
  action: 'plan',
  name: '启动按钮测试',
  nodes: [
    { id: 'A', change: 'alpha', deps: ['start'] },
    { id: 'B', change: 'beta', deps: ['A'] },
  ],
})

// 1. 前置没跑完也没归档 → 拒绝。
const blocked = await postAction({ action: 'start-node', nodeId: 'B' })
check('前置没满足时拒绝启动', blocked.status === 400, JSON.stringify(blocked.payload))
check(
  '拒绝的原话点出是哪一格前置',
  String(blocked.payload?.error || '').includes('A'),
  String(blocked.payload?.error || ''),
)
check('被拒绝时没开对话', calls.created.length === 0, JSON.stringify(calls.created))

// 2. 从 A 启动 → A 跑完归档，B 自动接着跑。
const started = await postAction({ action: 'start-node', nodeId: 'A' })
check('启动 A 成功', started.status === 200 && started.payload?.ok === true, JSON.stringify(started.payload).slice(0, 300))
const done = await waitFor(
  (payload) => statusOf(payload, 'A') === 'done' && statusOf(payload, 'B') === 'done',
)
check('A 跑完并归档', statusOf(done, 'A') === 'done', JSON.stringify(statusOf(done, 'A')))
check('A 归档之后 B 自动接着跑完', statusOf(done, 'B') === 'done', JSON.stringify(statusOf(done, 'B')))
check('只开了两个对话', calls.created.length === 2, String(calls.created.length))
check(
  '先跑 A、再跑 B',
  /^执行 alpha Change/m.test(String(calls.prompted[0]?.content?.[0]?.text || '')) &&
    /^执行 beta Change/m.test(String(calls.prompted[1]?.content?.[0]?.text || '')),
  JSON.stringify(calls.prompted.map((call) => String(call.content?.[0]?.text || '').slice(0, 20))),
)

// 3. 已归档的格子没得可跑。
const again = await postAction({ action: 'start-node', nodeId: 'A' })
check('已归档的格子再启动被拒绝', again.status === 400, JSON.stringify(again.payload))

// 4. 前置「归档了但那一轮还没收尾」（状态不是 done）→ 照样能启动。
//    alpha 已经在 archive/ 里了（上面第 2 步归的），这里只把图上 A 的状态改回 pending，
//    就是「归档了、还没收尾」那个样子。
// beta2：单独放一个还在 changes/ 里的 change，避免复用上面已经归档的 beta。
makeChange('beta2')
// plan 会拒绝已归档的名字（已经跑完的 change 不能画回图里），所以这一格直接写文件：
// 模拟「A 的 change 已经归档、但图上 A 还没收尾」这个状态。
writeFileSync(
  path.join(proj, 'openspec', 'pipeline.json'),
  JSON.stringify(
    {
      version: 1,
      name: '启动按钮测试',
      maxParallel: 1,
      profiles: [],
      defaultProfileId: '',
      nodes: [
        { id: 'start', kind: 'start', change: '', deps: [], status: 'done' },
        { id: 'A', change: 'alpha', deps: ['start'], status: 'pending' },
        { id: 'B', change: 'beta2', deps: ['A'], status: 'pending' },
      ],
    },
    null,
    2,
  ),
  'utf8',
)
calls.created.length = 0
calls.prompted.length = 0
const upstreamArchived = await postAction({ action: 'start-node', nodeId: 'B' })
check(
  '前置归档了但还没收尾时能启动下游',
  upstreamArchived.status === 200 && upstreamArchived.payload?.ok === true,
  JSON.stringify(upstreamArchived.payload).slice(0, 300),
)
const after = await waitFor((payload) => statusOf(payload, 'B') === 'done')
check('只跑了 B 这一格', calls.created.length === 1, String(calls.created.length))
check(
  '跑的是 beta2',
  /^执行 beta2 Change/m.test(String(calls.prompted[0]?.content?.[0]?.text || '')),
  String(calls.prompted[0]?.content?.[0]?.text || ''),
)
check('上游 A 的状态没被这一轮改动', statusOf(after, 'A') === 'pending', JSON.stringify(statusOf(after, 'A')))

console.log(failures.length ? `\n${failures.length} 项失败` : '\n全部通过')
process.exit(failures.length ? 1 : 0)
