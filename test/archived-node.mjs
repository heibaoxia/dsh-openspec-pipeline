// 离线回归：仓库里已经归档的 change，不会被当成「找不到」卡住下游。
//
// 覆盖两个前提：
//   1. 状态接口能把 archive/ 里的 change 认成 archived；
//   2. 格子还没跑、但 change 已经在 archive/ 里时，开跑直接补记 done，不再拉对话。
//
// 跑法（不需要起 DSH）：
//   node plugins/dsh-openspec-pipeline/test/archived-node.mjs
import { existsSync, mkdtempSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'osp-archived-'))
const profile = path.join(sandbox, 'profile')
const proj = path.join(sandbox, 'proj')
mkdirSync(profile, { recursive: true })
mkdirSync(path.join(proj, 'openspec', 'changes', 'archive', '2026-10-29-demo'), { recursive: true })
mkdirSync(path.join(proj, 'openspec', 'changes', 'archive', '2026-10-29-gone'), { recursive: true })
mkdirSync(path.join(proj, 'openspec', 'changes', 'live', 'specs', 'demo'), { recursive: true })
mkdirSync(path.join(proj, 'openspec', 'specs'), { recursive: true })
writeFileSync(path.join(proj, 'openspec', 'changes', 'live', 'tasks.md'), '- [ ] 做事\n', 'utf8')
// 执行标准要求四件规划写完：缺一件这一格就不该开跑。
writeFileSync(path.join(proj, 'openspec', 'changes', 'live', 'proposal.md'), '# live\n', 'utf8')
writeFileSync(path.join(proj, 'openspec', 'changes', 'live', 'design.md'), '# live\n', 'utf8')
writeFileSync(
  path.join(proj, 'openspec', 'changes', 'live', 'specs', 'demo', 'spec.md'),
  '## ADDED Requirements\n\n### Requirement: live\n\nThe system SHALL live.\n\n#### Scenario: works\n- **WHEN** 有人要它做\n- **THEN** 它做了\n',
  'utf8',
)

function pipeline(nodes) {
  return JSON.stringify(
    {
      version: 1,
      name: 'archived 测试',
      maxParallel: 1,
      pauseAfterNode: false,
      profiles: [],
      defaultProfileId: '',
      nodes: [{ id: 'start', kind: 'start', change: '', deps: [], status: 'done' }, ...nodes],
    },
    null,
    2,
  )
}

writeFileSync(
  path.join(proj, 'openspec', 'pipeline.json'),
  pipeline([
    { id: 'N2', change: 'demo', deps: ['start'], status: 'pending' },
    { id: 'N4', change: 'live', deps: ['start'], status: 'pending' },
  ]),
  'utf8',
)

// 插件在模块加载时就把状态目录定死，所以必须在 import 之前设好。
process.env.DSH_PROFILE_DIR = profile
const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

const routes = []
const calls = { created: 0 }
const sessions = new Map()
const ctx = {
  tools: {
    register() {
      return () => {}
    },
  },
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
          calls.created += 1
          const sessionId = `session-${calls.created}`
          sessions.set(sessionId, {
            seq: 0,
            snapshotEvents(from) {
              return from <= 1 ? [{ type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } }] : []
            },
          })
          return { sessionId }
        },
        async prompt(request) {
          // 假的对话：收到「执行 xxx Change」就当场归档，好让门禁放行。
          const text = String(request.content?.[0]?.text || '')
          const match = /^执行 (\S+) Change/m.exec(text)
          if (!match) return
          const from = path.join(proj, 'openspec', 'changes', match[1])
          const to = path.join(proj, 'openspec', 'changes', 'archive', `2026-10-29-${match[1]}`)
          mkdirSync(path.dirname(to), { recursive: true })
          if (existsSync(from)) renameSync(from, to)
        },
      }
    }
    if (name === 'agents') return { get: (id) => (sessions.has(id) ? { session: sessions.get(id) } : undefined) }
    if (name === 'sessions') return { get: (id) => sessions.get(id) }
    if (name === 'workspaceRegistry') return { list: () => [{ id: 'p', title: 'proj', path: proj }] }
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

const state = await request('GET', '/openspec-pipeline/api/state')
const demo = (state.payload.nodes || []).find((node) => node.id === 'N2')
const live = (state.payload.nodes || []).find((node) => node.id === 'N4')
check('archive 里的 change 被认成已归档', demo?.archived === true, JSON.stringify(demo))
check('还在 changes/ 的 change 不算已归档', live?.archived === false, JSON.stringify(live))

await request('POST', '/openspec-pipeline/api/action', { action: 'run' })
let healed = null
for (let i = 0; i < 100; i += 1) {
  const current = await request('GET', '/openspec-pipeline/api/state')
  healed = (current.payload.state?.nodes || []).find((node) => node.id === 'N2')
  if (healed?.status === 'done') break
  await new Promise((resolve) => setTimeout(resolve, 50))
}
check('已归档但状态没记上的格子，开跑时补记 done', healed?.status === 'done', JSON.stringify(healed))
// 补记完成时不应该拉对话：只有 live 那一格才会建会话。
check('已归档的格子不拉对话（没记 sessionId）', !healed?.sessionId, JSON.stringify(healed?.sessionId))

// 还在 changes/ 的格子会正常拉对话（这里只确认它没有被误判成已归档）。
let liveAfter = null
for (let i = 0; i < 100; i += 1) {
  const afterRun = await request('GET', '/openspec-pipeline/api/state')
  liveAfter = (afterRun.payload.state?.nodes || []).find((node) => node.id === 'N4')
  if (liveAfter?.status === 'done') break
  await new Promise((resolve) => setTimeout(resolve, 50))
}
check('在 changes/ 的格子照常开跑', ['running', 'done'].includes(liveAfter?.status || ''), JSON.stringify(liveAfter))
check('整轮只给 live 那一格建了一个会话', calls.created === 1, String(calls.created))

// 0.7 的文件里可能留着 verifying / archiving。读回来应该按失败处理，
// 否则它会停在既不跑、也不失败的位置。
writeFileSync(
  path.join(proj, 'openspec', 'pipeline.json'),
  pipeline([{ id: 'N6', change: 'live', deps: ['start'], status: 'verifying' }]),
  'utf8',
)
const legacy = await request('GET', '/openspec-pipeline/api/state')
const legacyNode = (legacy.payload.state?.nodes || []).find((node) => node.id === 'N6')
check('0.7 的 verifying 读回来按失败处理', legacyNode?.status === 'failed', JSON.stringify(legacyNode))

console.log(failures.length ? `\n${failures.length} 项没过` : '\n全部通过')
if (failures.length) process.exitCode = 1
