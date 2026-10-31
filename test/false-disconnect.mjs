// 离线回归：断开必须真的断开（0.11 的「假断开」）。
//
// 复现的是真实场景：N2 卡在「等你」、runner 正盯着 archive/，
// 人在面板上把 N3 从线上摘掉，然后点「归档」。
// 0.11 里那条断开只存在于画布（草稿），归档之后 runner 用旧图把 N3 拉了起来。
//
// 要证明三件事：
//   1. 断开之后点了保存 → 归档后 N3 不会开跑；
//   2. 断开还没保存就直接点归档（归档请求带着草稿）→ N3 也不会开跑；
//   3. 没断开时照旧会跑（证明上面两条不是「什么都拦住」）。
//
// 归档用的是真的 openspec 命令（跟面板同一条路）；机器上没有就跳过，不算失败。
//
// 跑法：
//   node plugins/dsh-openspec-pipeline/test/false-disconnect.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'osp-disconnect-'))
const profile = path.join(sandbox, 'profile')
mkdirSync(profile, { recursive: true })

// 每个用例一个独立仓库：状态互不干扰。
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
    writeFileSync(path.join(base, 'tasks.md'), '## 1. 任务\n\n- [x] 1.1 做完了\n', 'utf8')
  }
  return proj
}

function writePipeline(proj, nodes) {
  writeFileSync(
    path.join(proj, 'openspec', 'pipeline.json'),
    JSON.stringify(
      {
        version: 1,
        name: '假断开测试',
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

const changesOf = (proj) => path.join(proj, 'openspec', 'changes')
function archive(proj, change) {
  const from = path.join(changesOf(proj), change)
  if (existsSync(from)) renameSync(from, path.join(changesOf(proj), 'archive', `2026-10-31-${change}`))
}
function isArchived(proj, change) {
  return readdirSync(path.join(changesOf(proj), 'archive')).some((name) => name.endsWith(`-${change}`))
}

const probe = spawnSync(
  process.platform === 'win32' ? 'cmd.exe' : 'openspec',
  process.platform === 'win32' ? ['/d', '/s', '/c', 'openspec', '--version'] : ['--version'],
  { cwd: sandbox, encoding: 'utf8' },
)
if (probe.status !== 0) {
  console.log('  skip 全部用例 — 机器上没有 openspec 命令')
  console.log('\n跳过了（不是失败）')
  process.exit(0)
}

process.env.DSH_PROFILE_DIR = profile
const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

const routes = []
const sessions = new Map()
const calls = []
// 哪几格的「对话」会自己归档：其余的都故意不归档，好让流水线挂在「等你」。
let selfArchive = new Set()
// 这一轮在用哪个仓库（假对话收到 prompted 时要往里归档）。
let activeProject = ''
let workspaces = []

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
          const sessionId = `session-${sessions.size + 1}`
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
          if (!match) return
          if (selfArchive.has(match[1])) archive(activeProject, match[1])
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

const nodeOf = (payload, id) => (payload?.state?.nodes || []).find((item) => item.id === id) || null

async function waitFor(root, predicate, timeout = 15000) {
  const started = Date.now()
  for (;;) {
    const payload = await getState(root)
    if (predicate(payload)) return payload
    if (Date.now() - started > timeout) {
      throw new Error(
        `等超时：${JSON.stringify((payload?.state?.nodes || []).map((n) => [n.id, n.status, n.note]))}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
}

const node = (id, change, deps) => ({ id, change, deps, status: 'pending' })

// ---------- 1. 断开 + 保存 → 归档之后不拉下游 ----------
const projA = makeProject('case-a', ['change-a', 'change-b', 'change-c'])
writePipeline(projA, [node('N1', 'change-a', ['start']), node('N2', 'change-b', ['N1']), node('N3', 'change-c', ['N2'])])
workspaces = [{ id: 'wa', title: 'case-a', path: projA, sessionIds: [] }]
selfArchive = new Set(['change-a']) // N1 自己归档，N2 才会开工并卡在「等你」
activeProject = projA

await post({ action: 'root', root: projA })
await post({ action: 'run' })
const waiting = await waitFor(projA, (payload) => nodeOf(payload, 'N2')?.status === 'needs_human')
check('N2 没归档，挂在「等你」', nodeOf(waiting, 'N2')?.status === 'needs_human', JSON.stringify(nodeOf(waiting, 'N2')))
check('N1 已经归档', isArchived(projA, 'change-a'), JSON.stringify(readdirSync(path.join(changesOf(projA), 'archive'))))
check('N3 还没动', nodeOf(waiting, 'N3')?.status === 'pending', JSON.stringify(nodeOf(waiting, 'N3')))

// 面板上「断开 N3」= 把 N3 的 deps 去掉，然后保存。
const draft = waiting.state
const detached = {
  ...draft,
  nodes: draft.nodes.map((item) => (item.id === 'N3' ? { ...item, deps: [] } : item)),
}
const saved = await post({ action: 'save', state: detached })
check(
  '断开保存后服务器上的 N3 没有依赖',
  (nodeOf(saved, 'N3')?.deps || []).length === 0,
  JSON.stringify(nodeOf(saved, 'N3')?.deps),
)

// 人点「归档」。
const archived = await post({ action: 'archive', nodeId: 'N2' })
check('归档成功', archived.ok === true, JSON.stringify({ ok: archived.ok, error: archived.error, report: archived.report }))
// 等 runner 真的醒过来（它的轮询是 1 秒）再判。
await new Promise((resolve) => setTimeout(resolve, 2500))
const afterArchive = await getState(projA)
check('归档之后 N3 没有被拉起来', !calls.some((text) => text.includes('change-c')), JSON.stringify(calls))
check('N3 还在待跑', nodeOf(afterArchive, 'N3')?.status === 'pending', JSON.stringify(nodeOf(afterArchive, 'N3')))
await post({ action: 'stop' })

// ---------- 2. 断开还没保存，归档请求带着草稿 → 也不拉下游 ----------
const projB = makeProject('case-b', ['y-x', 'y-y', 'y-z'])
writePipeline(projB, [node('N1', 'y-x', ['start']), node('N2', 'y-y', ['N1']), node('N3', 'y-z', ['N2'])])
workspaces = [{ id: 'wb', title: 'case-b', path: projB, sessionIds: [] }]
selfArchive = new Set(['y-x'])
activeProject = projB
calls.length = 0

await post({ action: 'root', root: projB })
await post({ action: 'run' })
const waitingB = await waitFor(projB, (payload) => nodeOf(payload, 'N2')?.status === 'needs_human')
check('第二个仓库也挂在「等你」', nodeOf(waitingB, 'N2')?.status === 'needs_human', JSON.stringify(nodeOf(waitingB, 'N2')))

// 只改画布、不保存：这就是 0.11 里最常见的那一步。
const draftB = waitingB.state
const unrelatedDraft = {
  ...draftB,
  nodes: draftB.nodes.map((item) => (item.id === 'N3' ? { ...item, deps: [] } : item)),
}
const onDiskBefore = JSON.parse(readFileSync(path.join(projB, 'openspec', 'pipeline.json'), 'utf8'))
check(
  '草稿确实还没落盘（磁盘上 N3 还等着 N2）',
  (onDiskBefore.nodes.find((item) => item.id === 'N3')?.deps || []).join() === 'N2',
  JSON.stringify(onDiskBefore.nodes.find((item) => item.id === 'N3')?.deps),
)

const archivedWithDraft = await post({ action: 'archive', nodeId: 'N2', state: unrelatedDraft })
check(
  '带草稿的归档成功',
  archivedWithDraft.ok === true,
  JSON.stringify({ ok: archivedWithDraft.ok, error: archivedWithDraft.error, report: archivedWithDraft.report }),
)
await new Promise((resolve) => setTimeout(resolve, 2500))
const afterB = await getState(projB)
check('归档请求里的草稿生效了：N3 没被拉起来', !calls.some((text) => text.includes('y-z')), JSON.stringify(calls))
check('N3 还在待跑', nodeOf(afterB, 'N3')?.status === 'pending', JSON.stringify(nodeOf(afterB, 'N3')))
await post({ action: 'stop' })

// ---------- 3. 对照：没断开时照旧会跑 ----------
const projC = makeProject('case-c', ['z-m', 'z-n'])
writePipeline(projC, [node('N1', 'z-m', ['start']), node('N2', 'z-n', ['N1'])])
workspaces = [{ id: 'wc', title: 'case-c', path: projC, sessionIds: [] }]
selfArchive = new Set(['z-m', 'z-n'])
activeProject = projC
calls.length = 0

await post({ action: 'root', root: projC })
await post({ action: 'run' })
const ranC = await waitFor(projC, (payload) => nodeOf(payload, 'N2')?.status === 'done')
check('对照：没断开时下游照跑', nodeOf(ranC, 'N2')?.status === 'done', JSON.stringify(nodeOf(ranC, 'N2')))
check('对照：下游确实开了对话', calls.some((text) => text.includes('z-n')), JSON.stringify(calls))

console.log(failures.length ? `\n${failures.length} 项没过` : '\n全部通过')
process.exit(failures.length ? 1 : 0)
