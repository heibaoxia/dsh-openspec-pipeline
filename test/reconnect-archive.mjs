// 离线回归：等归档的时候断线、收工之后才接回来 —— 都得照样自动接上（0.15）。
//
// 复现两件真事：
//   1. N2 挂着「等你」等归档，人把 N2 自己那根入线断开、归档前又接回来。
//      0.14 及以前把「暂时没接线」当成「撤出图了」：等待名单当场清空、runner 立刻收工；
//      接回来之后没有谁在看 archive/，归档按钮认得出来，后面的 N3 却再也不动。
//   2. N2 收尾之后 runner 已经自然收工（那一瞬间 N3 还没接回来），人再把 N3 接上。
//      以前没有任何人会再看这张图，N3 永远停在「待跑」。
//
// 还要证明三条闸门没被放松：
//   - 人手点过「停止」之后，接线 + 归档都不会偷偷重启；
//   - 只把一格草稿挂到「开工」下面（没有跑完的前置），不会自动开跑；
//   - 没人点「开始」时，归档按钮会说清楚后面还有没有够格的格子。
//
// 归档走真的 openspec 命令（和面板同一条路）；机器上没有就跳过那一段，不算失败。
//
// 跑法：
//   node plugins/dsh-openspec-pipeline/test/reconnect-archive.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, existsSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
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

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'osp-reconnect-'))
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
    // 四件规划写完才达到执行标准（缺 design 这一格就不开跑）。
    writeFileSync(path.join(base, 'design.md'), `# 设计 ${change}\n`, 'utf8')
    writeFileSync(path.join(base, 'tasks.md'), '## 1. 任务\n\n- [x] 1.1 做完了\n', 'utf8')
  }
  return proj
}

function writePipeline(proj, nodes, name) {
  writeFileSync(
    path.join(proj, 'openspec', 'pipeline.json'),
    JSON.stringify(
      {
        version: 1,
        name: name || '重连测试',
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


const probe = spawnSync(
  process.platform === 'win32' ? 'cmd.exe' : 'openspec',
  process.platform === 'win32' ? ['/d', '/s', '/c', 'openspec', '--version'] : ['--version'],
  { cwd: sandbox, encoding: 'utf8' },
)
const hasOpenspec = probe.status === 0
if (!hasOpenspec) console.log('  （机器上没有 openspec：需要它的那两段会跳过）')

process.env.DSH_PROFILE_DIR = profile
const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

const routes = []
const sessions = new Map()
const calls = []
// 哪几格的「对话」会自己归档：其余的都故意不归档，好让流水线挂在「等你」。
let selfArchive = new Set()
// 哪几格的「对话」先不结束：测试手动放行，用来卡住「收尾前那一刻」。
let holdChanges = new Set()
let heldSession = null
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
          if (holdChanges.has(change)) heldSession = session
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
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const prompted = (change) => calls.some((text) => text.includes(`执行 ${change} Change`))

async function waitFor(root, predicate, timeout = 15000) {
  const started = Date.now()
  for (;;) {
    const payload = await getState(root)
    if (predicate(payload)) return payload
    if (Date.now() - started > timeout) {
      throw new Error(`等超时：${statusOf(payload)}`)
    }
    await pause(80)
  }
}

// 画布动作：改图的某一格（deps / 状态）之后保存 —— 和面板走同一条路（POST action=save）。
async function saveWith(root, mutate) {
  const view = await getState(root)
  const draft = { ...view.state, nodes: view.state.nodes.map((n) => ({ ...n })) }
  mutate(draft)
  return post({ action: 'save', root, state: draft })
}
const setDeps = (root, id, deps) =>
  saveWith(root, (draft) => {
    draft.nodes = draft.nodes.map((n) => (n.id === id ? { ...n, deps } : n))
  })

const node = (id, change, deps) => ({ id, change, deps, status: 'pending' })

// ---------- 1. 挂着「等你」的那一格，自己那根入线断了又接回来 ----------
const projA = makeProject('awaiting-rewire', ['a-one', 'a-two', 'a-three'])
writePipeline(projA, [node('N1', 'a-one', ['start']), node('N2', 'a-two', ['N1']), node('N3', 'a-three', ['N2'])])
workspaces = [{ id: 'wa', title: 'awaiting-rewire', path: projA, sessionIds: [] }]
selfArchive = new Set(['a-one'])
holdChanges = new Set()
heldSession = null
activeProject = projA

await post({ action: 'root', root: projA })
await post({ action: 'run' })
const waitingA = await waitFor(projA, (payload) => nodeOf(payload, 'N2')?.status === 'needs_human')
check('N2 没归档，挂在「等你」', nodeOf(waitingA, 'N2')?.status === 'needs_human', JSON.stringify(nodeOf(waitingA, 'N2')))

await setDeps(projA, 'N2', [])
await pause(1500)
const unpluggedA = await getState(projA)
check('等待归档时断开入线，runner 不收工', unpluggedA.running === true, JSON.stringify({ running: unpluggedA.running }))
check('断开之后 N2 还在等', nodeOf(unpluggedA, 'N2')?.status === 'needs_human', statusOf(unpluggedA))

await setDeps(projA, 'N2', ['N1'])
await pause(1200)
const pluggedA = await getState(projA)
check('接回来之后 runner 还活着', pluggedA.running === true, JSON.stringify({ running: pluggedA.running }))

archive(projA, 'a-two')
const afterArchiveA = await waitFor(projA, (payload) => ['running', 'needs_human'].includes(nodeOf(payload, 'N3')?.status || ''))
check('归档之后 N2 记完成', nodeOf(afterArchiveA, 'N2')?.status === 'done', statusOf(afterArchiveA))
check('归档之后 N3 被自动拉起来', prompted('a-three'), JSON.stringify(calls))
await post({ action: 'stop' })

// ---------- 2. 这一轮已经收工之后才把下游接回来 ----------
const projB = makeProject('late-rewire', ['b-one', 'b-two', 'b-three'])
writePipeline(projB, [node('N1', 'b-one', ['start']), node('N2', 'b-two', ['N1']), node('N3', 'b-three', ['N2'])])
workspaces = [{ id: 'wb', title: 'late-rewire', path: projB, sessionIds: [] }]
selfArchive = new Set(['b-one'])
holdChanges = new Set(['b-two'])
heldSession = null
activeProject = projB
calls.length = 0

await post({ action: 'root', root: projB })
await post({ action: 'run' })
const runningB = await waitFor(projB, (payload) => nodeOf(payload, 'N2')?.status === 'running')
check('N2 跑起来了', nodeOf(runningB, 'N2')?.status === 'running', statusOf(runningB))

// 跑着的时候把 N3 摘掉（人和面板都这么干）。
await setDeps(projB, 'N3', [])
await pause(400)

// 归档，然后放行这一轮：runner 记 N2 完成、发现没有下一格，收工。
archive(projB, 'b-two')
for (let i = 0; i < 60 && !heldSession; i += 1) await pause(50)
check('N2 的对话已经开起来（等着被放行）', Boolean(heldSession), JSON.stringify(calls))
heldSession.ended = true
const endedB = await waitFor(projB, (payload) => payload.running === false, 15000)
check('N2 收工，N3 还没接回来，这一轮自然停下', nodeOf(endedB, 'N2')?.status === 'done' && nodeOf(endedB, 'N3')?.status === 'pending', statusOf(endedB))
check('停下的时候 N3 没被拉起来', !prompted('b-three'), JSON.stringify(calls))

// 现在才把线接回来：旧代码到这儿就没人再看这张图了。
await setDeps(projB, 'N3', ['N2'])
const resumedB = await waitFor(projB, (payload) => ['running', 'needs_human'].includes(nodeOf(payload, 'N3')?.status || ''))
check('接回来之后这一轮自己接上了', resumedB.running === true, JSON.stringify({ running: resumedB.running }))
check('接回来之后 N3 真的开了对话', prompted('b-three'), JSON.stringify(calls))
await post({ action: 'stop' })

// ---------- 3. 只把一格草稿挂到「开工」下面：不许自动开跑 ----------
const projC = makeProject('parked-draft', ['c-one', 'c-two', 'c-three'])
writePipeline(projC, [
  node('N1', 'c-one', ['start']),
  node('N2', 'c-two', ['N1']),
  node('N3', 'c-three', []),
])
workspaces = [{ id: 'wc', title: 'parked-draft', path: projC, sessionIds: [] }]
selfArchive = new Set(['c-one', 'c-two'])
holdChanges = new Set()
heldSession = null
activeProject = projC
calls.length = 0

await post({ action: 'root', root: projC })
await post({ action: 'run' })
const endedC = await waitFor(projC, (payload) => payload.running === false, 15000)
check('两格跑完了，草稿那一格没跑', nodeOf(endedC, 'N2')?.status === 'done' && nodeOf(endedC, 'N3')?.status === 'pending', statusOf(endedC))

await setDeps(projC, 'N3', ['start'])
await pause(2500)
const afterDraftC = await getState(projC)
check('草稿挂到「开工」下面不开对话', !prompted('c-three'), JSON.stringify(calls))
check('草稿还是待跑，这一轮也没偷偷起', nodeOf(afterDraftC, 'N3')?.status === 'pending' && afterDraftC.running === false, statusOf(afterDraftC))

// ---------- 4. 人手「停止」之后：接线 + 归档都不偷偷重启 ----------
const projD = makeProject('stopped', ['d-one', 'd-two', 'd-three'])
writePipeline(projD, [node('N1', 'd-one', ['start']), node('N2', 'd-two', ['N1']), node('N3', 'd-three', ['N2'])])
workspaces = [{ id: 'wd', title: 'stopped', path: projD, sessionIds: [] }]
selfArchive = new Set(['d-one'])
holdChanges = new Set()
heldSession = null
activeProject = projD
calls.length = 0

await post({ action: 'root', root: projD })
await post({ action: 'run' })
await waitFor(projD, (payload) => nodeOf(payload, 'N2')?.status === 'needs_human')
await post({ action: 'stop' })

await setDeps(projD, 'N2', [])
await setDeps(projD, 'N2', ['N1'])
await pause(1200)
check('停止之后接线，不会自己重开', (await getState(projD)).running === false)

let archiveText = ''
if (hasOpenspec) {
  const result = await post({ action: 'archive', nodeId: 'N2', force: true })
  archiveText = String(result.text || result.error || '')
  check('停止之后归档成功', result.ok === true, archiveText)
} else {
  archive(projD, 'd-two')
  await pause(1000)
}
const afterStopD = await getState(projD)
check('停止之后归档，N3 也不会被拉起来', !prompted('d-three') && nodeOf(afterStopD, 'N3')?.status === 'pending', statusOf(afterStopD))
if (hasOpenspec) {
  check('没人跑的时候，归档会说清后面还有没有够格的格子', /后面 N3 已经够格了/.test(archiveText), JSON.stringify(archiveText.split('\n').slice(-2)))
}
await post({ action: 'stop' })

console.log(failures.length ? `\n${failures.length} 项没过` : '\n全部通过')
process.exit(failures.length ? 1 : 0)
