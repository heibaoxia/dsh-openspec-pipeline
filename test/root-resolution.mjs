// 离线回归：工作区解析不再看「当前对话」。
//
// 这是 0.5.0 修的那个坑：旧版 resolveRoot() 第一步读当前对话的目录，
// 所以在多个 OpenSpec 仓库之间切会话时，面板会跟着换成另一张图。
//
// 跑法（不需要起 DSH）：
//   node plugins/dsh-openspec-pipeline/test/root-resolution.mjs
//
// 它用一个假 ctx 调真正的 apply()，只走 status / root / GET state 三条路：
// 假 Profile 目录 + 两个带 openspec/ 的临时仓库，断言「换对话目录不改结果」。
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'osp-root-'))
const profile = path.join(sandbox, 'profile')
const projA = path.join(sandbox, 'aaa-project')
const projB = path.join(sandbox, 'zzz-project')
for (const dir of [profile, projA, projB]) mkdirSync(dir, { recursive: true })
for (const dir of [projA, projB]) {
  mkdirSync(path.join(dir, 'openspec', 'changes'), { recursive: true })
  mkdirSync(path.join(dir, 'openspec', 'specs'), { recursive: true })
}

// 插件在模块加载时就把状态目录定死，所以必须在 import 之前设好。
process.env.DSH_PROFILE_DIR = profile

const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

const tools = []
const routes = []
let currentConversationDir = projB
const ctx = {
  tools: { register(definition) { tools.push(definition); return () => {} } },
  webServer: { register(route) { routes.push(route); return () => {} } },
  get(name) {
    if (name === 'workingDirectory') return { ensure: async () => currentConversationDir, defaultDirectory: currentConversationDir }
    if (name === 'agents') return { get: () => undefined, roots: () => [{ header: { cwd: currentConversationDir } }] }
    if (name === 'workspaceRegistry') {
      return {
        list: () => [
          { id: 'a', title: 'aaa-project', path: projA },
          { id: 'b', title: 'zzz-project', path: projB },
        ],
      }
    }
    return undefined
  },
}

const dispose = apply(ctx)
if (!tools.length) throw new Error('工具没注册上，测试没法继续')
const tool = tools[0]
const settingsFile = path.join(profile, 'openspec-pipeline-settings.json')

const failures = []
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`)
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    failures.push(name)
  }
}
const rootOf = (text) => String(text).match(/仓库：(.+)/)?.[1]?.trim()

// 1. 没有任何选择时：首次解析就写进设置，之后固定。
const first = await tool.execute({ action: 'status' }, { agent: {} })
check('第一次解析出一个仓库', Boolean(rootOf(first.text)), first.text.split('\n')[0])
check('首次就把选择写进插件设置', existsSync(settingsFile), settingsFile)
const saved = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {}
check('写入的 root 与解析结果一致', saved.root === rootOf(first.text), JSON.stringify(saved))

// 2. 换一个「当前对话目录」再读：结果必须一模一样。
currentConversationDir = projA
const second = await tool.execute({ action: 'status' }, { agent: {} })
check('换对话目录后仍是同一个仓库', rootOf(second.text) === rootOf(first.text), `${rootOf(first.text)} vs ${rootOf(second.text)}`)

// 3. 再换一次，仍然一样。
currentConversationDir = path.join(sandbox, 'not-a-project')
const third = await tool.execute({ action: 'status' }, { agent: {} })
check('对话目录不在任何仓库里也还是同一个', rootOf(third.text) === rootOf(first.text), `${rootOf(first.text)} vs ${rootOf(third.text)}`)

// 4. 显式切工作区（等于面板下拉框）之后，所有对话都跟着变。
const switched = await tool.execute({ action: 'root', root: projB }, { agent: {} })
check('action=root 能切过去', rootOf(switched.text) === projB, rootOf(switched.text))
currentConversationDir = projA
const fourth = await tool.execute({ action: 'status' }, { agent: {} })
check('切换后对话 A 也读到新仓库', rootOf(fourth.text) === projB, rootOf(fourth.text))

// 5. 面板真正的入口：GET /openspec-pipeline/api/state（不再带 session）。
if (!routes.length) throw new Error('路由没注册上，测试没法继续')
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
    end(body) { this.body = body },
  }
  await routes[0].handler(req, res)
  return { status: res.statusCode, payload: JSON.parse(res.body || '{}') }
}
const stateA = await getState()
check('GET /state 返回 200', stateA.status === 200, String(stateA.status))
check('GET /state 的 root 就是插件设置里的那份', stateA.payload.root === projB, stateA.payload.root)
check('GET /state 带上了工作区列表', Array.isArray(stateA.payload.workspaces) && stateA.payload.workspaces.length === 2)
const stateB = await getState()
check('连续两次 /state 的 root 不变', stateB.payload.root === stateA.payload.root, `${stateA.payload.root} vs ${stateB.payload.root}`)

// 6. 默认组合：保存、删组合自动清空、add-all 自动带上、plan 保留。
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

const combo = { id: 'p1', name: '快档', preset: 'standard', provider: 'pp', model: 'mm', effort: 'low' }
const savedDefault = await postAction({
  action: 'save',
  state: { name: '默认组合测试', maxParallel: 1, profiles: [combo], defaultProfileId: 'p1', nodes: [] },
})
check('save 保留默认组合 id', savedDefault.payload.state.defaultProfileId === 'p1', JSON.stringify(savedDefault.payload.state))
check('save 保留组合四样', savedDefault.payload.state.profiles?.[0]?.model === 'mm', JSON.stringify(savedDefault.payload.state.profiles))
const reread = await getState()
check('GET /state 读到默认组合', reread.payload.state.defaultProfileId === 'p1', JSON.stringify(reread.payload.state))

const cleared = await postAction({
  action: 'save',
  state: { name: '默认组合测试', maxParallel: 1, profiles: [], defaultProfileId: 'p1', nodes: [] },
})
check('组合删掉后默认 id 自动清空', cleared.payload.state.defaultProfileId === '', JSON.stringify(cleared.payload.state))

const changeDir = path.join(projB, 'openspec', 'changes', 'foo')
mkdirSync(changeDir, { recursive: true })
writeFileSync(path.join(changeDir, 'proposal.md'), '# foo\n', 'utf8')
await postAction({
  action: 'save',
  state: { name: '默认组合测试', maxParallel: 1, profiles: [combo], defaultProfileId: 'p1', nodes: [] },
})
const added = await postAction({ action: 'add-all' })
const foo = (added.payload.state.nodes || []).find((node) => node.change === 'foo')
check('add-all 加进来了', Boolean(foo), JSON.stringify(added.payload.state.nodes))
check(
  'add-all 的新节点自动带上默认四样',
  foo?.preset === 'standard' && foo?.provider === 'pp' && foo?.model === 'mm' && foo?.effort === 'low',
  JSON.stringify(foo),
)

const planned = await postAction({ action: 'plan', nodes: [{ id: 'N1', change: 'foo' }], defaultProfileId: 'p1' })
check('plan 保留默认组合', planned.payload.state.defaultProfileId === 'p1', JSON.stringify(planned.payload.state))
const statusWithDefault = await tool.execute({ action: 'status' }, { agent: {} })
check('status 写出默认组合', String(statusWithDefault.text).includes('默认运行设置：快档'), String(statusWithDefault.text).split('\n').slice(0, 3).join(' | '))

dispose()
console.log(failures.length ? `\n${failures.length} 项失败` : '\n全部通过')
process.exit(failures.length ? 1 : 0)
