// 离线回归：归档门禁。
//
// 要证明三件事：
//   1. 对话收尾、change 真的进了 archive/ → 记 done，下游开跑；
//   2. 对话收尾、但 change 还在 changes/ → 记 needs_human，下游不动；
//   3. 手动归档后点「开始」→ 这一格直接补记 done（不重开对话），下游接着跑。
//
// 跑法：
//   node plugins/dsh-openspec-pipeline/test/archive-gate.mjs
import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'osp-gate-'))
const profile = path.join(sandbox, 'profile')
const proj = path.join(sandbox, 'proj')
const changes = path.join(proj, 'openspec', 'changes')
mkdirSync(profile, { recursive: true })
for (const name of ['foo', 'bar']) {
  mkdirSync(path.join(changes, name, 'specs', 'demo'), { recursive: true })
  writeFileSync(path.join(changes, name, 'proposal.md'), `# ${name}\n`, 'utf8')
  // 四件规划写完才达到执行标准（否则这一格不开跑，测试就跑不起来）。
  writeFileSync(path.join(changes, name, 'design.md'), `# ${name}\n`, 'utf8')
  writeFileSync(path.join(changes, name, 'tasks.md'), '- [ ] 做事\n', 'utf8')
  writeFileSync(
    path.join(changes, name, 'specs', 'demo', 'spec.md'),
    `## ADDED Requirements\n\n### Requirement: ${name}\n\nThe system SHALL do it.\n\n#### Scenario: works\n- **WHEN** 有人要它做\n- **THEN** 它做了\n`,
    'utf8',
  )
}
mkdirSync(path.join(changes, 'archive'), { recursive: true })
mkdirSync(path.join(proj, 'openspec', 'specs'), { recursive: true })

const pipelineFile = path.join(proj, 'openspec', 'pipeline.json')
function writePipeline() {
  writeFileSync(
    pipelineFile,
    JSON.stringify(
      {
        version: 1,
        name: '门禁测试',
        maxParallel: 1,
        profiles: [],
        defaultProfileId: '',
        nodes: [
          { id: 'start', kind: 'start', change: '', deps: [], status: 'done' },
          { id: 'N1', change: 'foo', deps: ['start'], status: 'pending' },
          { id: 'N2', change: 'bar', deps: ['N1'], status: 'pending' },
        ],
      },
      null,
      2,
    ),
    'utf8',
  )
}
writePipeline()

function archiveChange(name) {
  renameSync(path.join(changes, name), path.join(changes, 'archive', `2026-10-29-${name}`))
}
function unarchiveChange(name) {
  renameSync(path.join(changes, 'archive', `2026-10-29-${name}`), path.join(changes, name))
}

process.env.DSH_PROFILE_DIR = profile
const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

const routes = []
const sessions = new Map()
const calls = []
// 假的对话：收到「执行 xxx Change」时，按这个开关决定要不要归档。
let archiveOnPrompt = true

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
          const sessionId = `session-gate-${sessions.size + 1}`
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
          calls.push(text)
          const match = /^执行 (\S+) Change/m.exec(text)
          if (match && archiveOnPrompt) archiveChange(match[1])
        },
      }
    }
    if (name === 'agents') return { get: (id) => (sessions.has(id) ? { session: sessions.get(id) } : undefined) }
    if (name === 'sessions') return { get: (id) => sessions.get(id) }
    if (name === 'workspaceRegistry') return { list: () => [{ id: 'ws', title: 'proj', path: proj }] }
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
const postAction = (body) => request('POST', '/openspec-pipeline/api/action', body).then((r) => r.payload)
const getState = () => request('GET', '/openspec-pipeline/api/state').then((r) => r.payload)

async function waitFor(predicate, timeout = 8000) {
  const started = Date.now()
  for (;;) {
    const payload = await getState()
    if (predicate(payload)) return payload
    if (Date.now() - started > timeout) {
      throw new Error(`等超时：${JSON.stringify((payload.state?.nodes || []).map((n) => [n.id, n.status, n.note]))}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
const statusOf = (payload, id) => (payload.state?.nodes || []).find((node) => node.id === id)

// 1. 两格都归档 → 一条链跑完。
await postAction({ action: 'root', root: proj })
await postAction({ action: 'run' })
const done = await waitFor((payload) => ['N1', 'N2'].every((id) => statusOf(payload, id)?.status === 'done'))
check('归档了就记为 done', statusOf(done, 'N1')?.status === 'done', JSON.stringify(statusOf(done, 'N1')))
check('下行格子也跑完了', statusOf(done, 'N2')?.status === 'done', JSON.stringify(statusOf(done, 'N2')))
check('每个节点各开一个对话', calls.length === 2, JSON.stringify(calls))
check('第一格先拿到自己的 change', calls[0] === '执行 foo Change', calls[0])
check('第二格拿到自己的 change', calls[1] === '执行 bar Change', calls[1])

// 2. 对话不归档 → 停在这一格，下游不动。
unarchiveChange('foo')
unarchiveChange('bar')
writePipeline()
calls.length = 0
archiveOnPrompt = false
await postAction({ action: 'run' })
const blocked = await waitFor((payload) => statusOf(payload, 'N1')?.status === 'needs_human')
check('没归档就挂「等你」', statusOf(blocked, 'N1')?.status === 'needs_human', JSON.stringify(statusOf(blocked, 'N1')))
check('说明里写清楚没归档', String(statusOf(blocked, 'N1')?.note || '').includes('没归档'), statusOf(blocked, 'N1')?.note)
check('下游停在待跑', statusOf(blocked, 'N2')?.status === 'pending', JSON.stringify(statusOf(blocked, 'N2')))
check('没开工的格子不盖批准时间', statusOf(blocked, 'N2')?.approved === '', JSON.stringify(statusOf(blocked, 'N2')?.approved))
check('开工的格子才写批准时间', Boolean(statusOf(blocked, 'N1')?.approved), JSON.stringify(statusOf(blocked, 'N1')?.approved))
check('只开了一个对话', calls.length === 1, JSON.stringify(calls))

// 3. 手动归档，**不点「开始」**：runner 还在等，自己补记 done，下游接着跑。
archiveChange('foo')
archiveOnPrompt = true
const recovered = await waitFor((payload) => ['N1', 'N2'].every((id) => statusOf(payload, id)?.status === 'done'))
check('归档后自动补记 done', statusOf(recovered, 'N1')?.status === 'done', JSON.stringify(statusOf(recovered, 'N1')))
check('补记不重开对话', calls.length === 2 && calls[1] === '执行 bar Change', JSON.stringify(calls))
check('下游接着跑完', statusOf(recovered, 'N2')?.status === 'done', JSON.stringify(statusOf(recovered, 'N2')))

console.log(failures.length ? `\n${failures.length} 项没过` : '\n全部通过')
process.exit(failures.length ? 1 : 0)
