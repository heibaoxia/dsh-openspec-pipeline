// 离线回归：一键清理（prune）。
//
// 要证明四件事：
//   1. 只删「永远不可能再跑」的两类格子：change 已经归档、或者 changes/ 和 archive/ 里都找不到；
//   2. 待跑、只差归档、正在跑的格子一个都不动（状态和 sessionId 原样保留）；
//   3. 下游指向被删格子的线一起摘掉；
//   4. dryRun 只算不写。
//
// 跑法（不需要起 DSH）：
//   node plugins/dsh-openspec-pipeline/test/prune.mjs
import { readFileSync, mkdtempSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const watchdog = setTimeout(() => {
  console.log('WATCHDOG：90 秒没跑完，判定卡住')
  process.exit(3)
}, 90000)
watchdog.unref?.()

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'osp-prune-'))
const profile = path.join(sandbox, 'profile')
mkdirSync(profile, { recursive: true })

const proj = path.join(sandbox, 'proj')
const changes = path.join(proj, 'openspec', 'changes')
mkdirSync(path.join(changes, 'archive'), { recursive: true })
mkdirSync(path.join(proj, 'openspec', 'specs'), { recursive: true })

const spec = (name) =>
  `## ADDED Requirements\n\n### Requirement: ${name}\n\nThe system SHALL do it.\n\n#### Scenario: works\n- **WHEN** 有人要它做\n- **THEN** 它做了\n`

function makeChange(name, tasks = '- [ ] 做事\n') {
  const dir = path.join(changes, name)
  mkdirSync(path.join(dir, 'specs', 'demo'), { recursive: true })
  writeFileSync(path.join(dir, 'proposal.md'), `# ${name}\n`, 'utf8')
  writeFileSync(path.join(dir, 'design.md'), `# ${name}\n`, 'utf8')
  writeFileSync(path.join(dir, 'specs', 'demo', 'spec.md'), spec(name), 'utf8')
  writeFileSync(path.join(dir, 'tasks.md'), tasks, 'utf8')
  return dir
}

// 四种格子：已归档、找不到、只差归档（待跑）、正在跑。
makeChange('done-old')
renameSync(path.join(changes, 'done-old'), path.join(changes, 'archive', '2026-11-01-done-old'))
makeChange('keep', '## 1. 任务\n\n- [x] 1.1 做完了\n')
makeChange('live')

const pipelineFile = path.join(proj, 'openspec', 'pipeline.json')
writeFileSync(
  pipelineFile,
  JSON.stringify(
    {
      version: 1,
      name: '清理测试',
      maxParallel: 1,
      profiles: [],
      defaultProfileId: '',
      nodes: [
        { id: 'start', kind: 'start', change: '', deps: [], status: 'done' },
        { id: 'N1', change: 'done-old', deps: ['start'], status: 'done' },
        { id: 'N2', change: 'lost', deps: ['N1'], status: 'failed' },
        // N3 等 N2（N2 那个 change 已经不存在了）：清理时必须把它这根线一起摘掉。
        { id: 'N3', change: 'keep', deps: ['N2'], status: 'pending' },
        { id: 'N4', change: 'live', deps: ['start'], status: 'pending' },
      ],
    },
    null,
    2,
  ),
  'utf8',
)

process.env.DSH_PROFILE_DIR = profile
const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

const routes = []
const sessions = new Map()
const calls = { created: 0 }
let sessionSeq = 0

const ctx = {
  tools: { register() { return () => {} } },
  webServer: { register(route) { routes.push(route); return () => {} } },
  get(name) {
    if (name === 'sessionController') {
      return {
        async create() {
          calls.created += 1
          const sessionId = `session-prune-${++sessionSeq}`
          sessions.set(sessionId, {
            seq: 0,
            // 永远不收尾：把这一格钉在「跑着」上，好证明清理不碰正在跑的格子。
            snapshotEvents() {
              return []
            },
          })
          return { sessionId }
        },
        async prompt() {},
        async cancel() {},
      }
    }
    if (name === 'agents') return { get: (id) => (sessions.has(id) ? { session: sessions.get(id) } : undefined) }
    if (name === 'sessions') return { get: (id) => sessions.get(id) }
    if (name === 'workspaceRegistry') {
      return { list: () => [{ id: 'ws', title: 'proj', path: proj }], create: (root) => ({ id: 'ws', title: 'p', path: root }) }
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
const getState = () => request('GET', '/openspec-pipeline/api/state').then((r) => r.payload)
const msgOf = (payload) => String(payload?.text || payload?.error || '')
const nodesOf = (payload) => payload?.state?.nodes || []
const nodeOf = (payload, id) => nodesOf(payload).find((node) => node.id === id) || null
// 仓库侧的事实（已归档 / 找不到）在顶层的 nodes 上，不在 state.nodes 里。
const repoOf = (payload, id) => (payload?.nodes || []).find((node) => node.id === id) || null
const idsOf = (payload) => nodesOf(payload).filter((n) => n.kind !== 'start').map((n) => n.id).sort()
const diskOf = () => JSON.parse(readFileSync(pipelineFile, 'utf8'))
const diskIds = () => (diskOf().nodes || []).filter((n) => n.kind !== 'start').map((n) => n.id).sort()

async function waitFor(predicate, timeout = 12000) {
  const started = Date.now()
  for (;;) {
    const payload = await getState()
    if (predicate(payload)) return payload
    if (Date.now() - started > timeout) {
      throw new Error(
        `等超时：${JSON.stringify(nodesOf(payload).map((n) => [n.id, n.status, n.note]))}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
}

// ---------- 1. 先让 N4 跑起来（证明清理不碰正在跑的格子） ----------

console.log('1. 起一条流水线，让 N4 跑着')
await post({ action: 'root', root: proj })
await post({ action: 'run' })
const running = await waitFor((payload) => {
  const node = nodeOf(payload, 'N4')
  return node?.status === 'running' && Boolean(node.sessionId)
})
const liveSession = nodeOf(running, 'N4').sessionId
check('N4 跑着', nodeOf(running, 'N4').status === 'running', JSON.stringify(nodeOf(running, 'N4')))
check(
  'N1 已归档、N2 找不到',
  repoOf(running, 'N1')?.archived === true && repoOf(running, 'N2')?.missing === true,
  JSON.stringify([repoOf(running, 'N1'), repoOf(running, 'N2')]),
)
// 等一下，让 runner 把「跑着」那一刻的状态都写完，免得下面的文件对比被它打断。
await new Promise((resolve) => setTimeout(resolve, 400))

// ---------- 2. dryRun：只算不写 ----------

console.log('\n2. dryRun：只说会删哪几格，一个字节都不写')
const before = readFileSync(pipelineFile, 'utf8')
const dry = await post({ action: 'prune', dryRun: true })
check('dryRun 说清要清几格', /可以清理 2 格/.test(msgOf(dry)), msgOf(dry))
check('dryRun 点名已归档的那一格', /N1/.test(msgOf(dry)) && /归档/.test(msgOf(dry)), msgOf(dry))
check('dryRun 点名找不到的那一格', /N2/.test(msgOf(dry)) && /找不到/.test(msgOf(dry)), msgOf(dry))
check('dryRun 不点名要保留的格子', !/N3/.test(msgOf(dry)) && !/N4/.test(msgOf(dry)), msgOf(dry))
check('dryRun 真的没写', readFileSync(pipelineFile, 'utf8') === before)

// ---------- 3. 真删：只删 N1 / N2 ----------

console.log('\n3. 真清理：只删已归档和找不到的，其余原样')
// 面板那条路：点「清理」时把当前画布一起送过去。
const panelState = (await getState()).state
const pruned = await post({ action: 'prune', state: panelState })
check('删掉了两格', idsOf(pruned).join() === 'N3,N4', JSON.stringify(idsOf(pruned)))
check('回话里写清删了哪几格、为什么', /清理了 2 格/.test(msgOf(pruned)) && /N1/.test(msgOf(pruned)) && /N2/.test(msgOf(pruned)), msgOf(pruned))
check('待跑的那一格原样保留', nodeOf(pruned, 'N3')?.status === 'pending', JSON.stringify(nodeOf(pruned, 'N3')))
check('正在跑的那一格还是「跑着」', nodeOf(pruned, 'N4')?.status === 'running', JSON.stringify(nodeOf(pruned, 'N4')))
check('正在跑的 sessionId 没变', nodeOf(pruned, 'N4')?.sessionId === liveSession, JSON.stringify([liveSession, nodeOf(pruned, 'N4')?.sessionId]))
check('落盘也是这两格删了', diskIds().join() === 'N3,N4', JSON.stringify(diskIds()))
check('只开过 N4 一个对话', calls.created === 1, String(calls.created))

// ---------- 4. 下游指向被删格子的线一起摘掉 ----------

console.log('\n4. 下游的线一起摘掉')
check('N3 指向 N2 的那根线被摘掉了', JSON.stringify(nodeOf(pruned, 'N3')?.deps || []) === '[]', JSON.stringify(nodeOf(pruned, 'N3')?.deps))
const again = await post({ action: 'prune' })
check('再点一次：没有可清理的格子', /没有可清理的格子/.test(msgOf(again)), msgOf(again))

await post({ action: 'stop' })

console.log(failures.length ? `\n${failures.length} 项没过` : '\n全部通过')
process.exit(failures.length ? 1 : 0)
