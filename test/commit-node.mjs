// 离线回归：归档后提交（节点上的「这一格跑完 → 归档之后自动提交」勾）。
//
// 要证明五件事：
//   1. 勾了的格子归档后真的多一条提交：信息 `openspec: <change>`，正文写 archive/<名字>；
//   2. 没勾的格子不提交，改动留在工作树里；
//   3. 没东西可提交也算完成（不报错，说明里写清楚）；
//   4. 提交失败就停在「等你」，下游不动；修好点「开始」会重试提交，不重开对话；
//   5. 一次提交里能同时看到代码文件和 archive 移动（这就是「归档之后再提交」的意思）。
//
// 跑法：
//   node plugins/dsh-openspec-pipeline/test/commit-node.mjs
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

// 提交身份走环境变量：不看这台机器的全局 git 配置，谁跑都一个结果。
process.env.GIT_AUTHOR_NAME = '流水线测试'
process.env.GIT_AUTHOR_EMAIL = 'pipeline@example.invalid'
process.env.GIT_COMMITTER_NAME = '流水线测试'
process.env.GIT_COMMITTER_EMAIL = 'pipeline@example.invalid'

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'osp-commit-'))
const profile = path.join(sandbox, 'profile')
mkdirSync(profile, { recursive: true })
process.env.DSH_PROFILE_DIR = profile

// ---------- git 小工具 ----------

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { ok: result.status === 0, out: String(result.stdout || ''), err: String(result.stderr || '') }
}

function gitOrDie(cwd, args) {
  const result = git(cwd, args)
  if (!result.ok) throw new Error(`git ${args.join(' ')} 失败：${result.err.trim()}`)
  return result.out
}

const subjects = (cwd) => gitOrDie(cwd, ['log', '--format=%s']).trim().split('\n').filter(Boolean)
const dirty = (cwd) => gitOrDie(cwd, ['status', '--porcelain']).trim()

// ---------- 造仓库 ----------

function makeProject(tag, changeNames) {
  const root = path.join(sandbox, tag)
  const changes = path.join(root, 'openspec', 'changes')
  mkdirSync(path.join(changes, 'archive'), { recursive: true })
  mkdirSync(path.join(root, 'openspec', 'specs'), { recursive: true })
  mkdirSync(path.join(root, 'openspec', 'changes'), { recursive: true })
  writeFileSync(path.join(root, 'app.txt'), 'v0\n', 'utf8')
  for (const name of changeNames) {
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
  gitOrDie(root, ['init', '-q'])
  gitOrDie(root, ['add', '-A'])
  gitOrDie(root, ['commit', '-q', '-m', 'init'])
  return root
}

function writePipeline(root, nodes) {
  writeFileSync(
    path.join(root, 'openspec', 'pipeline.json'),
    JSON.stringify(
      {
        version: 1,
        name: '提交测试',
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

const archivedName = (name) => `2026-10-31-${name}`

function archiveChange(root, name) {
  renameSync(
    path.join(root, 'openspec', 'changes', name),
    path.join(root, 'openspec', 'changes', 'archive', archivedName(name)),
  )
}

// ---------- 假宿主 ----------

const projects = []
const routes = []
const sessions = new Map()
const calls = []
let current = ''
// 假对话：收到「执行 xxx Change」时，写一个文件（当作这一格的产出）再归档。
// archiveOnPrompt=false 时只跑不归档。
let archiveOnPrompt = true
// 模拟「有别的 git 进程攥着锁」：提交会在 git add 这一步失败。
let holdLock = false

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
          const sessionId = `session-commit-${sessions.size + 1}`
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
          if (holdLock) writeFileSync(path.join(current, '.git', 'index.lock'), '')
          if (!archiveOnPrompt) return
          writeFileSync(path.join(current, `${match[1]}.txt`), `work on ${match[1]}\n`, 'utf8')
          archiveChange(current, match[1])
        },
      }
    }
    if (name === 'agents') return { get: (id) => (sessions.has(id) ? { session: sessions.get(id) } : undefined) }
    if (name === 'sessions') return { get: (id) => sessions.get(id) }
    if (name === 'workspaceRegistry') {
      return {
        list: () =>
          projects.map((root) => ({ id: `ws-${path.basename(root)}`, title: path.basename(root), path: root })),
        create: (root) => ({ id: `ws-${path.basename(root)}`, title: path.basename(root), path: root }),
      }
    }
    return undefined
  },
}

const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)
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

async function waitFor(predicate, timeout = 15000) {
  const started = Date.now()
  for (;;) {
    const payload = await getState()
    if (predicate(payload)) return payload
    if (Date.now() - started > timeout) {
      throw new Error(`等超时：${JSON.stringify((payload.state?.nodes || []).map((n) => [n.id, n.status, n.note]))}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
}
const statusOf = (payload, id) => (payload.state?.nodes || []).find((node) => node.id === id)
const statusText = (payload) => JSON.stringify((payload.state?.nodes || []).map((n) => [n.id, n.status]))

async function switchTo(root) {
  current = root
  if (!projects.includes(root)) projects.push(root)
  await postAction({ action: 'root', root })
}

// ---------- 1. 两格都勾上：各提交一次 ----------

console.log('1. 勾了提交：每格归档后各一条提交')
const a = makeProject('a', ['foo', 'bar'])
writePipeline(a, [
  { id: 'N1', change: 'foo', deps: ['start'], status: 'pending', commit: true },
  { id: 'N2', change: 'bar', deps: ['N1'], status: 'pending', commit: true },
])
await switchTo(a)
await postAction({ action: 'run' })
const aDone = await waitFor((payload) =>
  ['N1', 'N2'].every((id) => statusOf(payload, id)?.status === 'done'),
)
const aLog = subjects(a)
check('每格一条提交，顺序跟跑的先后一致', aLog[0] === 'openspec: bar' && aLog[1] === 'openspec: foo' && aLog[2] === 'init', JSON.stringify(aLog))
check(
  '提交正文写归档名字',
  gitOrDie(a, ['log', '-1', '--format=%b']).includes(`archive/${archivedName('bar')}`),
  gitOrDie(a, ['log', '-1', '--format=%b']),
)
check('说明里写着已提交的 sha', /已提交 [0-9a-f]{7,}/.test(String(statusOf(aDone, 'N1')?.note || '')), statusOf(aDone, 'N1')?.note)
// 画布本身（openspec/pipeline.json）每次状态变化都会脏，它不算「没提交干净」。
const leftovers = dirty(a).split('\n').filter(Boolean)
check(
  '除了画布状态，工作树是干净的（代码和 archive 移动都进了提交）',
  leftovers.every((line) => line.includes('openspec/pipeline.json')),
  JSON.stringify(leftovers),
)
check('每格只开一个对话', calls.length === 2 && calls[0] === '执行 foo Change' && calls[1] === '执行 bar Change', JSON.stringify(calls))

// ---------- 2. 不勾就不提交 ----------

console.log('\n2. 没勾：不提交，改动留在工作树里')
const b = makeProject('b', ['foo'])
writePipeline(b, [{ id: 'N1', change: 'foo', deps: ['start'], status: 'pending', commit: false }])
calls.length = 0
await switchTo(b)
await postAction({ action: 'run' })
const bDone = await waitFor((payload) => statusOf(payload, 'N1')?.status === 'done')
check('一条提交都没多出来', subjects(b).length === 1, JSON.stringify(subjects(b)))
check('说明里没有「已提交」', !String(statusOf(bDone, 'N1')?.note || '').includes('已提交'), statusOf(bDone, 'N1')?.note)
check('改动还在工作树里', dirty(b).includes('foo.txt'), dirty(b))

// ---------- 3. 没东西可提交：也算完成 ----------

console.log('\n3. 勾了，但这一格本来就没改动：算完成，写明没有改动可提交')
const c = makeProject('c', ['foo'])
archiveChange(c, 'foo')
calls.length = 0
await switchTo(c)
// 写一次画布，再把它连同归档一起提交 —— 这样开跑时工作树真的是干净的。
// 走 save 而不是 plan：foo 已经归档了，而 plan 会拒绝已归档的名字。
await postAction({
  action: 'save',
  state: {
    name: '提交测试',
    maxParallel: 1,
    nodes: [{ id: 'N1', change: 'foo', deps: ['start'], status: 'pending', commit: true }],
  },
})
gitOrDie(c, ['add', '-A'])
gitOrDie(c, ['commit', '-q', '-m', 'pipeline'])
await postAction({ action: 'run' })
const cDone = await waitFor((payload) => statusOf(payload, 'N1')?.status === 'done')
check('还是记完成', statusOf(cDone, 'N1')?.status === 'done', statusText(cDone))
check('说明写明没有改动可提交', String(statusOf(cDone, 'N1')?.note || '').includes('没有改动可提交'), statusOf(cDone, 'N1')?.note)
check('没多出提交', subjects(c)[0] === 'pipeline' && subjects(c).length === 2, JSON.stringify(subjects(c)))
// 提交那一刻确实没有别的改动；之后记 done 会再写一次画布，那一行是运行状态，不算漏提交。
const cLeftovers = dirty(c).split('\n').filter(Boolean)
check(
  '提交那一刻没东西可提交（之后只有画布状态变了）',
  cLeftovers.every((line) => line.includes('openspec/pipeline.json')),
  JSON.stringify(cLeftovers),
)
check('已归档的格子不拉对话', calls.length === 0, JSON.stringify(calls))

// ---------- 4. 提交失败：停在这一格；修好点「开始」会重试 ----------

console.log('\n4. 提交失败：停在「等你」，下游不动；重试成功且不重开对话')
const d = makeProject('d', ['foo', 'bar'])
writePipeline(d, [
  { id: 'N1', change: 'foo', deps: ['start'], status: 'pending', commit: true },
  { id: 'N2', change: 'bar', deps: ['N1'], status: 'pending', commit: false },
])
calls.length = 0
holdLock = true
await switchTo(d)
await postAction({ action: 'run' })
const dBlocked = await waitFor((payload) => statusOf(payload, 'N1')?.status === 'needs_human')
check('提交没成就挂在「等你」', statusOf(dBlocked, 'N1')?.status === 'needs_human', statusText(dBlocked))
check('说明里带着 git 的原话', String(statusOf(dBlocked, 'N1')?.note || '').includes('提交没成'), statusOf(dBlocked, 'N1')?.note)
check('下游没动', statusOf(dBlocked, 'N2')?.status === 'pending', statusText(dBlocked))
check('这一格确实没提交', subjects(d).length === 1, JSON.stringify(subjects(d)))

// 把锁拿走，相当于人把冲突处理掉了，再点「开始」。
rmSync(path.join(d, '.git', 'index.lock'), { force: true })
holdLock = false
await postAction({ action: 'run' })
const dRecovered = await waitFor((payload) =>
  ['N1', 'N2'].every((id) => statusOf(payload, id)?.status === 'done'),
)
check('重试之后提交成功', subjects(d)[0] === 'openspec: foo', JSON.stringify(subjects(d)))
check('重试没给 N1 再开一次对话', calls.length === 2 && calls[0] === '执行 foo Change' && calls[1] === '执行 bar Change', JSON.stringify(calls))
check('两格都跑完了', ['N1', 'N2'].every((id) => statusOf(dRecovered, id)?.status === 'done'), statusText(dRecovered))

console.log(failures.length ? `\n${failures.length} 项没过` : '\n全部通过')
process.exit(failures.length ? 1 : 0)
