// 离线回归：规划进度（openspec status --all --json）。
//
// 要证明四件事：
//   1. 「只写了提案」和「四件套只差 tasks」能分开 —— 单靠 `list` 不能，两者都是 no-tasks；
//   2. 面板拿得到 planning: { complete, done, total, missing, next }；
//   3. 图里的节点也带这份进度；
//   4. CLI 不认识这个仓库时降级，不抛异常。
//
// 跑法：
//   node plugins/dsh-openspec-pipeline/test/planning-state.mjs
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'osp-planning-'))
const profile = path.join(sandbox, 'profile')
const proj = path.join(sandbox, 'proj')
const changesDir = path.join(proj, 'openspec', 'changes')
mkdirSync(profile, { recursive: true })
mkdirSync(path.join(proj, 'openspec', 'specs'), { recursive: true })
mkdirSync(path.join(changesDir, 'archive'), { recursive: true })

function makeChange(name, withSpecs, withDesign, withTasks) {
  const base = path.join(changesDir, name)
  mkdirSync(base, { recursive: true })
  writeFileSync(path.join(base, 'proposal.md'), `## Why\n\n${name} 有用。\n\n## What Changes\n\n加一个能力。\n`, 'utf8')
  if (withSpecs) {
    mkdirSync(path.join(base, 'specs', 'demo-cap'), { recursive: true })
    writeFileSync(
      path.join(base, 'specs', 'demo-cap', 'spec.md'),
      [
        '## ADDED Requirements',
        '',
        `### Requirement: Demo ${name}`,
        'The system SHALL demo.',
        '',
        '#### Scenario: Demo works',
        '- **WHEN** the user runs it',
        '- **THEN** it works',
        '',
      ].join('\n'),
      'utf8',
    )
  }
  if (withDesign) writeFileSync(path.join(base, 'design.md'), `# 设计 ${name}\n`, 'utf8')
  if (withTasks) writeFileSync(path.join(base, 'tasks.md'), '## 1. 任务\n\n- [ ] 1.1 第一件事\n', 'utf8')
}

// 三种规划完成度：1/4、3/4、4/4
makeChange('only-proposal', false, false, false)
makeChange('almost-done', true, true, false)
makeChange('ready-to-run', true, true, true)

const pipelineFile = path.join(proj, 'openspec', 'pipeline.json')
writeFileSync(
  pipelineFile,
  JSON.stringify(
    {
      version: 1,
      name: '规划进度测试',
      maxParallel: 1,
      profiles: [],
      defaultProfileId: '',
      nodes: [
        { id: 'start', kind: 'start', change: '', deps: [], status: 'done' },
        { id: 'N1', change: 'only-proposal', deps: ['start'], status: 'pending' },
        { id: 'N2', change: 'ready-to-run', deps: ['N1'], status: 'pending' },
      ],
    },
    null,
    2,
  ),
  'utf8',
)

const probe = spawnSync(
  process.platform === 'win32' ? 'cmd.exe' : 'openspec',
  process.platform === 'win32' ? ['/d', '/s', '/c', 'openspec', '--version'] : ['--version'],
  { cwd: proj, encoding: 'utf8' },
)
if (probe.status !== 0) {
  console.log('  skip 全部用例 — 机器上没有 openspec 命令')
  console.log('\n跳过了（不是失败）')
  process.exit(0)
}

process.env.DSH_PROFILE_DIR = profile
const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

const routes = []
const ctx = {
  tools: { register() { return () => {} } },
  webServer: { register(route) { routes.push(route); return () => {} } },
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
  return JSON.parse(res.body || '{}')
}
const post = (body) => request('POST', '/openspec-pipeline/api/action', body)
const getState = () => request('GET', '/openspec-pipeline/api/state')
const rowOf = (payload, name) => (payload.available || []).find((row) => row.name === name)
const nodeOf = (payload, id) => (payload.nodes || []).find((node) => node.id === id)

await post({ action: 'root', root: proj })
const view = await getState()

check('规划进度读得到', view.cli?.planning?.ok === true, JSON.stringify(view.cli?.planning))

const only = rowOf(view, 'only-proposal')
check('只有提案：1/4', only?.planning?.done === 1 && only?.planning?.total === 4, JSON.stringify(only?.planning))
check('只有提案：没有写完', only?.planning?.complete === false, JSON.stringify(only?.planning))
check(
  '只有提案：缺的是 specs/design/tasks',
  JSON.stringify(only?.planning?.missing || []) === JSON.stringify(['specs', 'design', 'tasks']),
  JSON.stringify(only?.planning?.missing),
)
check('只有提案：给了下一步命令', /instructions specs/.test(String(only?.planning?.next || '')), only?.planning?.next)
check('单靠 list 分不出来（都是 no-tasks）', only?.cliStatus === 'no-tasks', only?.cliStatus)

const almost = rowOf(view, 'almost-done')
check('只差 tasks：3/4', almost?.planning?.done === 3 && almost?.planning?.total === 4, JSON.stringify(almost?.planning))
check('只差 tasks：缺的只有 tasks', JSON.stringify(almost?.planning?.missing || []) === JSON.stringify(['tasks']), JSON.stringify(almost?.planning?.missing))
check('两者 cliStatus 完全一样', almost?.cliStatus === only?.cliStatus, `${almost?.cliStatus} vs ${only?.cliStatus}`)

const ready = rowOf(view, 'ready-to-run')
check('四件齐：写完', ready?.planning?.complete === true, JSON.stringify(ready?.planning))

const n1 = nodeOf(view, 'N1')
check('图里的节点也带规划进度', n1?.planning?.done === 1 && n1?.planning?.complete === false, JSON.stringify(n1?.planning))
const n2 = nodeOf(view, 'N2')
check('四件齐的节点是 complete', n2?.planning?.complete === true, JSON.stringify(n2?.planning))

console.log(failures.length ? `\n${failures.length} 项没过` : '\n全部通过')
if (failures.length) process.exitCode = 1
