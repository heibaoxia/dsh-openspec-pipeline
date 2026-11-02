// 离线回归：分支合并 —— 一个节点有两个前置时，两个都完成才开跑。
//
// 这个约束从 0.7 起就在开跑逻辑里（`deps.every(done)`），但一直没有测试盯着它。
// 分支一多，最容易出的错就是「一个分支完了就往下走」。两个用例：
//   1. 两个分支并行，一个先完成、另一个还在跑 → 合并节点不许动；第二个也完成了才开跑；
//   2. 一个分支完成、另一个挂在「等你」（对话收尾了但没归档）→ 合并节点也不许动；
//      归档之后才开跑。
//
// 跑法：
//   node plugins/dsh-openspec-pipeline/test/merge-fan-in.mjs
import { mkdtempSync, mkdirSync, existsSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// 卡住就自己退出：这些测试里 runner 的定时器会一直挂着进程，CI 上不能无限等。
const watchdog = setTimeout(() => {
  console.log('WATCHDOG：90 秒没跑完，判定卡住')
  process.exit(3)
}, 90000)
watchdog.unref?.()

const failures = []
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`)
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    failures.push(name)
  }
}

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'osp-fan-in-'))
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
    // 全勾：changeStage 判成「做完了」，不会被当成「他处进行」拦住。
    writeFileSync(path.join(base, 'tasks.md'), '## 1. 任务\n\n- [x] 1.1 做完了\n', 'utf8')
  }
  return proj
}

function writePipeline(proj, nodes, maxParallel) {
  writeFileSync(
    path.join(proj, 'openspec', 'pipeline.json'),
    JSON.stringify(
      {
        version: 1,
        name: '分支合并测试',
        maxParallel: maxParallel || 2,
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

process.env.DSH_PROFILE_DIR = profile
const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

const routes = []
const sessions = new Map()
const calls = []
let selfArchive = new Set()
let holdChanges = new Set()
const held = new Map()
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
            ended: false,
            snapshotEvents(from) {
              return this.ended && from <= 1 ? [{ type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } }] : []
            },
          })
          return { sessionId }
        },
        async prompt(request) {
          const text = String(request.content?.[0]?.text || '')
          calls.push(text)
          const match = /^执行 (\S+) Change/m.exec(text)
          if (!match) return
          const change = match[1]
          if (selfArchive.has(change)) archive(activeProject, change)
          const session = sessions.get(request.sessionId)
          if (!session) return
          if (holdChanges.has(change)) held.set(change, session)
          else session.ended = true
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
const statusOf = (payload) => (payload?.state?.nodes || []).map((n) => `${n.id}:${n.status}`).join(' ')
const prompted = (change) => calls.some((text) => text.includes(`执行 ${change} Change`))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(root, predicate, timeout = 15000) {
  const started = Date.now()
  for (;;) {
    const payload = await getState(root)
    if (predicate(payload)) return payload
    if (Date.now() - started > timeout) throw new Error(`等超时：${statusOf(payload)}`)
    await pause(80)
  }
}

const node = (id, change, deps) => ({ id, change, deps, status: 'pending' })

// ---------- 1. 两个分支并行：一个先完成，合并节点不许动 ----------
const projA = makeProject('running-branch', ['a-root', 'a-left', 'a-right', 'a-merge'])
writePipeline(projA, [
  node('N1', 'a-root', ['start']),
  node('L', 'a-left', ['N1']),
  node('R', 'a-right', ['N1']),
  node('M', 'a-merge', ['L', 'R']),
])
workspaces = [{ id: 'wa', title: 'running-branch', path: projA, sessionIds: [] }]
selfArchive = new Set(['a-root', 'a-left', 'a-right'])
holdChanges = new Set(['a-left'])
held.clear()
activeProject = projA
calls.length = 0

await post({ action: 'root', root: projA })
await post({ action: 'run' })
const both = await waitFor(
  projA,
  (payload) => nodeOf(payload, 'L')?.status === 'running' && nodeOf(payload, 'R')?.status === 'done',
)
check('两个分支都开跑了（并行）', Boolean(held.get('a-left')), JSON.stringify(statusOf(both)))
check('右分支先完成', nodeOf(both, 'R')?.status === 'done', statusOf(both))
check('合并节点还在待跑', nodeOf(both, 'M')?.status === 'pending', statusOf(both))
await pause(1200)
const stillWaiting = await getState(projA)
check('只完成一个分支时，合并节点不开跑', !prompted('a-merge') && nodeOf(stillWaiting, 'M')?.status === 'pending', JSON.stringify(calls))

// 放行左分支：两个前置都完成了，合并节点才开跑。
held.get('a-left').ended = true
const merged = await waitFor(projA, (payload) => ['running', 'needs_human'].includes(nodeOf(payload, 'M')?.status || ''))
check('左分支完成', nodeOf(merged, 'L')?.status === 'done', statusOf(merged))
check('两个前置都完成之后，合并节点开跑', prompted('a-merge'), JSON.stringify(calls))
await post({ action: 'stop' })

// ---------- 2. 一个分支挂在「等你」：合并节点也不许动 ----------
const projB = makeProject('waiting-branch', ['b-root', 'b-left', 'b-right', 'b-merge'])
writePipeline(projB, [
  node('N1', 'b-root', ['start']),
  node('L', 'b-left', ['N1']),
  node('R', 'b-right', ['N1']),
  node('M', 'b-merge', ['L', 'R']),
])
workspaces = [{ id: 'wb', title: 'waiting-branch', path: projB, sessionIds: [] }]
selfArchive = new Set(['b-root', 'b-left'])
holdChanges = new Set()
held.clear()
activeProject = projB
calls.length = 0

await post({ action: 'root', root: projB })
await post({ action: 'run' })
const stuck = await waitFor(
  projB,
  (payload) => nodeOf(payload, 'L')?.status === 'done' && nodeOf(payload, 'R')?.status === 'needs_human',
)
check('右分支没归档，挂在「等你」', nodeOf(stuck, 'R')?.status === 'needs_human', statusOf(stuck))
await pause(1200)
const blocked = await getState(projB)
check('有分支在等你时，合并节点不开跑', !prompted('b-merge') && nodeOf(blocked, 'M')?.status === 'pending', JSON.stringify(calls))

// 手动归档右分支：两个前置都完成了，合并节点才开跑。
archive(projB, 'b-right')
const released = await waitFor(projB, (payload) => ['running', 'needs_human'].includes(nodeOf(payload, 'M')?.status || ''))
check('归档之后右分支记完成', nodeOf(released, 'R')?.status === 'done', statusOf(released))
check('两个前置都完成之后，合并节点开跑', prompted('b-merge'), JSON.stringify(calls))
await post({ action: 'stop' })

console.log(failures.length ? `\n${failures.length} 项没过` : '\n全部通过')
process.exit(failures.length ? 1 : 0)
