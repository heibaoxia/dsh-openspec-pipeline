// 离线回归：手动归档（validate --strict → archive）+ 任务进度走 openspec list --json。
//
// 要证明五件事：
//   1. 面板能读到 CLI 的官方状态（cli.ok / cliStatus / 勾数）；
//   2. 格式正确的 change，点一次归档就归了，节点记 done；
//   3. 格式残缺的 change，第一次只回 needsConfirm + 报告，**不归档**；
//   4. 报告是能看懂的行（[WARNING] 文件：原因），不是一大坨原始 JSON；
//   5. 人点「仍然归档」才真的过，节点记 done。
//
// 为什么用真 openspec 命令：这个测试要证明的正是「我们跟 CLI 的约定没理解错」。
// 假一个 CLI 回来只能证明我们自洽，证明不了它真那么回答。
// 需要机器上有 openspec（v1.13 起）；没有就跳过这一段，不能判失败。
//
// 跑法：
//   node plugins/dsh-openspec-pipeline/test/archive-action.mjs
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, renameSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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
function skip(name, why) {
  console.log(`  skip ${name} — ${why}`)
}

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'osp-archive-'))
const profile = path.join(sandbox, 'profile')
const proj = path.join(sandbox, 'proj')
const changesDir = path.join(proj, 'openspec', 'changes')
mkdirSync(profile, { recursive: true })
mkdirSync(path.join(proj, 'openspec', 'specs'), { recursive: true })
mkdirSync(path.join(changesDir, 'archive'), { recursive: true })

function makeChange(name, specBody) {
  const base = path.join(changesDir, name)
  mkdirSync(path.join(base, 'specs', 'demo-cap'), { recursive: true })
  writeFileSync(path.join(base, 'proposal.md'), `## Why\n\n${name} 有用。\n\n## What Changes\n\n加一个能力。\n`, 'utf8')
  writeFileSync(path.join(base, 'design.md'), `# 设计 ${name}\n`, 'utf8')
  writeFileSync(path.join(base, 'specs', 'demo-cap', 'spec.md'), specBody, 'utf8')
  writeFileSync(path.join(base, 'tasks.md'), '## 1. 任务\n\n- [x] 1.1 只做这一件事\n', 'utf8')
}

// 格式完整：有 SHALL，scenario 有 WHEN + THEN。validate --strict 应该过。
makeChange(
  'good-change',
  [
    '## ADDED Requirements',
    '',
    '### Requirement: Good capability',
    'The system SHALL provide a good capability.',
    '',
    '#### Scenario: Good works',
    '- **WHEN** the user asks for it',
    '- **THEN** it works',
    '',
  ].join('\n'),
)

// 能解析、但残缺：requirement 正文没有任何 SHALL / MUST。
// 默认档会说 valid；--strict 才算问题（[WARNING] 也当错）。
// 这就是「归档前必须验一次、而且要用 --strict」的理由。
//
// 注意一个已知的漏网：scenario 只有 WHEN 或只有 THEN，--strict 也判它合法
// （v1.13.2 实测：c6/c7 那种只有单边步骤的能过）。所以这道门禁不是万能的，
// 它管的是「需求没写必须/应当」「场景是空的」「根本没有场景」这三类。
makeChange(
  'half-change',
  [
    '## ADDED Requirements',
    '',
    '### Requirement: Half capability',
    '系统要做一个能力，这句话里没有任何约束词。',
    '',
    '#### Scenario: 完整场景',
    '- **WHEN** 用户点了按钮',
    '- **THEN** 系统有反应',
    '',
  ].join('\n'),
)

const pipelineFile = path.join(proj, 'openspec', 'pipeline.json')
writeFileSync(
  pipelineFile,
  JSON.stringify(
    {
      version: 1,
      name: '归档动作测试',
      maxParallel: 1,
      profiles: [],
      defaultProfileId: '',
      nodes: [
        { id: 'start', kind: 'start', change: '', deps: [], status: 'done' },
        { id: 'N1', change: 'good-change', deps: ['start'], status: 'pending' },
        { id: 'N2', change: 'half-change', deps: ['N1'], status: 'pending' },
      ],
    },
    null,
    2,
  ),
  'utf8',
)

const probe = spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'openspec', process.platform === 'win32' ? ['/d', '/s', '/c', 'openspec', '--version'] : ['--version'], {
  cwd: proj,
  encoding: 'utf8',
})
if (probe.status !== 0) {
  skip('全部用例', '机器上没有 openspec 命令')
  console.log('\n跳过了（不是失败）')
  process.exit(0)
}

process.env.DSH_PROFILE_DIR = profile
const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

const routes = []
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
    if (name === 'workspaceRegistry') return { list: () => [{ id: 'ws', title: 'proj', path: proj }] }
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
const getState = () => request('GET', '/openspec-pipeline/api/state').then((r) => r.payload)
// 节点上有两套东西：state.nodes 是服务器事实（状态/说明/sessionId），
// 面板真正画的是 payload.nodes —— derive 之后又合上仓库事实（勾了几项、在不在 archive）。
// 这个测试要看的是后者。
const nodeOf = (payload, id) =>
  (payload.nodes || []).find((node) => node.id === id) ||
  (payload.state?.nodes || []).find((node) => node.id === id)
const archivedNames = () => readdirSync(path.join(changesDir, 'archive'))

// ---------- 1. 状态读取走 CLI ----------
await post({ action: 'root', root: proj })
const first = await getState()
check('CLI 读得到', first.cli?.ok === true, JSON.stringify(first.cli))
const goodRow = (first.available || []).find((row) => row.name === 'good-change')
check('列表带官方状态', goodRow?.cliStatus === 'complete', JSON.stringify(goodRow))
check('勾数来自 CLI', goodRow?.done === 1 && goodRow?.total === 1, JSON.stringify(goodRow))
const n1 = nodeOf(first, 'N1')
check('节点的任务进度也读到了', n1?.taskDone === 1 && n1?.taskTotal === 1, JSON.stringify(n1))

// ---------- 2. 格式正确的：一次就归 ----------
const good = await post({ action: 'archive', nodeId: 'N1' })
check('正确格式归档成功', good.ok === true, JSON.stringify({ ok: good.ok, error: good.error, report: good.report }))
check('归档后有日期前缀的目录', archivedNames().some((name) => name.endsWith('-good-change')), JSON.stringify(archivedNames()))
check('节点记成 done', nodeOf(good, 'N1')?.status === 'done', JSON.stringify(nodeOf(good, 'N1')))
check('changes/ 里没有它了', !existsSync(path.join(changesDir, 'good-change')))

// ---------- 3. 残缺的：先只报告，不归档 ----------
const half = await post({ action: 'archive', nodeId: 'N2' })
check('残缺的先要人确认', half.needsConfirm === true, JSON.stringify({ ok: half.ok, error: half.error, report: half.report }))
check('还没归档', !archivedNames().some((name) => name.endsWith('-half-change')), JSON.stringify(archivedNames()))
check('change 还在 changes/', existsSync(path.join(changesDir, 'half-change')))
check('报告里有一行一条的问题', /\[WARNING\].+half-change|\[WARNING\].+spec\.md/.test(String(half.report || '')), String(half.report || '').slice(0, 400))
check('报告不是原始 JSON', !String(half.report || '').trim().startsWith('{'), String(half.report || '').slice(0, 120))
check('节点还没被记 done', nodeOf(half, 'N2')?.status !== 'done', JSON.stringify(nodeOf(half, 'N2')))

// ---------- 4. 人点「仍然归档」才过 ----------
const forced = await post({ action: 'archive', nodeId: 'N2', force: true })
check('强制归档成功', forced.ok === true, JSON.stringify({ ok: forced.ok, error: forced.error }))
check('这次真的进 archive/ 了', archivedNames().some((name) => name.endsWith('-half-change')), JSON.stringify(archivedNames()))
check('节点记成 done', nodeOf(forced, 'N2')?.status === 'done', JSON.stringify(nodeOf(forced, 'N2')))
check('说明里写清楚人选择硬归', String(nodeOf(forced, 'N2')?.note || '').includes('validate 没过'), nodeOf(forced, 'N2')?.note)

// ---------- 5. 流水线卡在「等你」时点归档，下游自己接着跑 ----------
// 这是最常用的一条路：对话没归档 → 挂「等你」→ 人点「归档」→ 下一格开工。
// 用假的 sessionController 造对话，收尾时故意不归档。
makeChange(
  'run-a',
  ['## ADDED Requirements', '', '### Requirement: Run A', 'The system SHALL run a.', '', '#### Scenario: A', '- **WHEN** a', '- **THEN** b', ''].join('\n'),
)
makeChange(
  'run-b',
  ['## ADDED Requirements', '', '### Requirement: Run B', 'The system SHALL run b.', '', '#### Scenario: B', '- **WHEN** a', '- **THEN** b', ''].join('\n'),
)
writeFileSync(
  pipelineFile,
  JSON.stringify(
    {
      version: 1,
      name: '等你再归档',
      maxParallel: 1,
      profiles: [],
      defaultProfileId: '',
      nodes: [
        { id: 'start', kind: 'start', change: '', deps: [], status: 'done' },
        { id: 'N3', change: 'run-a', deps: ['start'], status: 'pending' },
        { id: 'N4', change: 'run-b', deps: ['N3'], status: 'pending' },
      ],
    },
    null,
    2,
  ),
  'utf8',
)
const sessions = new Map()
const prompts = []
ctx.get = (name) => {
  if (name === 'sessionController') {
    return {
      async create() {
        const sessionId = `session-run-${sessions.size + 1}`
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
        prompts.push(text)
        // 模拟「这一格的对话自己归档了」：目录改名搬进 archive/。
        // run-a 故意不归档，好让流水线挂「等你」，再由人来点按钮。
        if (text.includes('run-b')) {
          const from = path.join(changesDir, 'run-b')
          if (existsSync(from)) renameSync(from, path.join(changesDir, 'archive', '2026-10-31-run-b'))
        }
      },
    }
  }
  if (name === 'agents') return { get: (id) => (sessions.has(id) ? { session: sessions.get(id) } : undefined) }
  if (name === 'sessions') return { get: (id) => sessions.get(id) }
  if (name === 'workspaceRegistry') return { list: () => [{ id: 'ws', title: 'proj', path: proj }] }
  return undefined
}

async function waitFor(predicate, timeout = 12000) {
  const started = Date.now()
  for (;;) {
    const payload = await getState()
    if (predicate(payload)) return payload
    if (Date.now() - started > timeout) throw new Error('等超时')
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
}

await post({ action: 'root', root: proj })
prompts.length = 0
await post({ action: 'run' })
const parked = await waitFor((payload) => nodeOf(payload, 'N3')?.status === 'needs_human')
check('对话不归档就挂「等你」', nodeOf(parked, 'N3')?.status === 'needs_human', JSON.stringify(nodeOf(parked, 'N3')))
check('下游还没动', nodeOf(parked, 'N4')?.status === 'pending', JSON.stringify(nodeOf(parked, 'N4')))
check('这一格的任务全勾了（所以按钮该出现）', nodeOf(parked, 'N3')?.taskDone === 1 && nodeOf(parked, 'N3')?.taskTotal === 1, JSON.stringify(nodeOf(parked, 'N3')))

const clicked = await post({ action: 'archive', nodeId: 'N3' })
check('点归档就归了', clicked.ok === true, JSON.stringify({ ok: clicked.ok, error: clicked.error, report: clicked.report }))
const resumed = await waitFor((payload) => nodeOf(payload, 'N4')?.status === 'done')
check('归档后下游自己开工并跑完', nodeOf(resumed, 'N4')?.status === 'done', JSON.stringify(nodeOf(resumed, 'N4')))
check('下一格确实开了对话', prompts.some((text) => text.includes('run-b')), JSON.stringify(prompts))

if (failures.length) process.exitCode = 1
console.log(failures.length ? `\n${failures.length} 项没过` : '\n全部通过')
