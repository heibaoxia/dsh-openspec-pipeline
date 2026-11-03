// 离线回归：默认组合真的会进到 create / selectModel；提示词只有「执行 xxx Change」，
// 除非节点或它用的组合里写了附加提示词。
//
// 跑法（不需要起 DSH）：
//   node plugins/dsh-openspec-pipeline/test/default-preset-run.mjs
//
// 假 ctx 提供 sessionController / agents / agentDefaultModel / workspaceRegistry，
// 只跑一个节点：对话一收尾就算这一格完成，不验收、不归档、不跑 openspec。
import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'osp-defaults-'))
const profile = path.join(sandbox, 'profile')
const proj = path.join(sandbox, 'demo-project')
mkdirSync(profile, { recursive: true })
mkdirSync(path.join(proj, 'openspec', 'changes', 'foo', 'specs', 'demo'), { recursive: true })
mkdirSync(path.join(proj, 'openspec', 'changes', 'archive'), { recursive: true })
mkdirSync(path.join(proj, 'openspec', 'specs'), { recursive: true })
writeFileSync(path.join(proj, 'openspec', 'changes', 'foo', 'proposal.md'), '# foo\n', 'utf8')
writeFileSync(path.join(proj, 'openspec', 'changes', 'foo', 'tasks.md'), '- [ ] 做事\n', 'utf8')
// 四件规划写完才达到执行标准（否则这一格不开跑，测试就跑不起来）。
writeFileSync(path.join(proj, 'openspec', 'changes', 'foo', 'design.md'), '# foo\n', 'utf8')
writeFileSync(
  path.join(proj, 'openspec', 'changes', 'foo', 'specs', 'demo', 'spec.md'),
  '## ADDED Requirements\n\n### Requirement: foo\n\nThe system SHALL do it.\n\n#### Scenario: works\n- **WHEN** 有人要它做\n- **THEN** 它做了\n',
  'utf8',
)

// 模拟那个对话自己归档：把目录挪进 archive/。
function archiveChange(name) {
  renameSync(
    path.join(proj, 'openspec', 'changes', name),
    path.join(proj, 'openspec', 'changes', 'archive', `2026-10-29-${name}`),
  )
}
function unarchiveChange(name) {
  renameSync(
    path.join(proj, 'openspec', 'changes', 'archive', `2026-10-29-${name}`),
    path.join(proj, 'openspec', 'changes', name),
  )
}

process.env.DSH_PROFILE_DIR = profile

const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

const tools = []
const routes = []
const calls = { created: [], selected: [], prompted: [], restored: [] }
const sessions = new Map()
let sessionSeq = 0
const userDefault = { provider: 'user-default', model: 'user-model', reasoningEffort: 'medium' }

const ctx = {
  tools: { register(definition) { tools.push(definition); return () => {} } },
  webServer: { register(route) { routes.push(route); return () => {} } },
  get(name) {
    if (name === 'sessionController') {
      return {
        async create(request) {
          calls.created.push(request)
          const sessionId = `session-test-${++sessionSeq}`
          sessions.set(sessionId, {
            seq: 0,
            snapshotEvents(from) {
              return from <= 1
                ? [{ type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } }]
                : []
            },
          })
          return { sessionId }
        },
        async selectModel(request) {
          calls.selected.push(request)
          return {
            selected: {
              provider: request.provider,
              model: request.model,
              ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
            },
          }
        },
        async prompt(request) {
          calls.prompted.push(request)
          // 假的对话：收到「执行 xxx Change」就当场归档，再收尾。
          const text = String(request.content?.[0]?.text || '')
          const match = /^执行 (\S+) Change/m.exec(text)
          if (match) archiveChange(match[1])
          return undefined
        },
      }
    }
    if (name === 'agents') return { get: (id) => (sessions.has(id) ? { session: sessions.get(id) } : undefined) }
    if (name === 'sessions') return { get: (id) => sessions.get(id) }
    if (name === 'agentDefaultModel') {
      return {
        currentSelection: () => ({ ...userDefault }),
        async saveSelection(selection) { calls.restored.push(selection) },
      }
    }
    if (name === 'workspaceRegistry') {
      return {
        list: () => [{ id: 'ws-demo', title: 'demo-project', path: proj }],
        create: async () => ({ id: 'ws-demo', title: 'demo-project', path: proj }),
      }
    }
    return undefined
  },
}

apply(ctx)
if (!tools.length) throw new Error('工具没注册上')
if (!routes.length) throw new Error('路由没注册上')

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
    end(bodyText) { this.body = bodyText },
  }
  await routes[0].handler(req, res)
  return JSON.parse(res.body || '{}')
}

async function waitFor(predicate, timeout = 5000) {
  const started = Date.now()
  for (;;) {
    const state = await getState()
    if (predicate(state)) return state
    if (Date.now() - started > timeout) throw new Error(`等超时：${JSON.stringify(state.state?.nodes?.map((n) => [n.id, n.status]))}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const failures = []
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`)
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    failures.push(name)
  }
}

const combo = { id: 'p1', name: '快档', preset: 'standard', provider: 'pp', model: 'mm', effort: 'low' }

// 1. 节点四样全空 → 用默认组合；没写提示词 → 只发「执行 foo Change」。
await postAction({ action: 'root', root: proj })
await postAction({
  action: 'save',
  state: {
    name: '默认组合测试',
    maxParallel: 1,
    profiles: [combo],
    defaultProfileId: 'p1',
    nodes: [{ id: 'N1', change: 'foo', deps: ['start'] }],
  },
})
await postAction({ action: 'run' })
const first = await waitFor((payload) => payload.state?.nodes?.some((node) => node.change === 'foo' && node.status === 'done'))

check('默认组合的对话模式进了 create', calls.created[0]?.agentPreset === 'standard', JSON.stringify(calls.created[0]))
check(
  '默认组合的模型进了 selectModel',
  calls.selected[0]?.provider === 'pp' && calls.selected[0]?.model === 'mm' && calls.selected[0]?.reasoningEffort === 'low',
  JSON.stringify(calls.selected[0]),
)
check('默认组合节点挂到了工作区', calls.created[0]?.workspaceId === 'ws-demo', JSON.stringify(calls.created[0]))
check(
  '全局默认模型被写回原值',
  calls.restored.length >= 1 &&
    calls.restored[0]?.provider === userDefault.provider &&
    calls.restored[0]?.model === userDefault.model,
  JSON.stringify(calls.restored[0]),
)
check(
  '没写提示词时只发「执行 foo Change」',
  String(calls.prompted[0]?.content?.[0]?.text || '') === '执行 foo Change',
  JSON.stringify(String(calls.prompted[0]?.content?.[0]?.text || '')),
)
const firstNode = first.state.nodes.find((node) => node.change === 'foo')
check('对话收尾且已归档就标 done', firstNode?.status === 'done', JSON.stringify(firstNode))
check('done 的说明写明已归档', String(firstNode?.note || '').includes('已归档'), firstNode?.note)

// 2. 节点自己设了四样 → 按节点自己的；写了提示词 → 接在后面。
//    先把 foo 挪回 changes/，好让这一格重新开一次对话。
//    重置用 plan（重写整张图），不用 save：0.12 起 save 只改画布上的东西，
//    状态一律以服务器为准 —— 否则自动落盘会把客户端的旧状态写回文件。
unarchiveChange('foo')
await waitFor((payload) => payload.running === false)
calls.created.length = 0
calls.selected.length = 0
calls.restored.length = 0
calls.prompted.length = 0
await postAction({
  action: 'plan',
  name: '默认组合测试',
  defaultProfileId: 'p1',
  nodes: [
    {
      id: 'N1',
      change: 'foo',
      deps: ['start'],
      preset: 'own',
      provider: 'op',
      model: 'om',
      effort: 'high',
      prompt: '只做任务清单里的第 1 项；做完就跑一遍 pnpm test。',
    },
  ],
})
await postAction({ action: 'run' })
await waitFor((payload) => payload.state?.nodes?.some((node) => node.change === 'foo' && node.status === 'done'))

check('节点自己的对话模式优先', calls.created[0]?.agentPreset === 'own', JSON.stringify(calls.created[0]))
check(
  '节点自己的模型优先',
  calls.selected[0]?.provider === 'op' && calls.selected[0]?.model === 'om' && calls.selected[0]?.reasoningEffort === 'high',
  JSON.stringify(calls.selected[0]),
)
check('节点自己设了也仍然保护全局默认', calls.restored.length >= 1, JSON.stringify(calls.restored))
check(
  '附加提示词接在「执行 foo Change」后面',
  String(calls.prompted[0]?.content?.[0]?.text || '') === '执行 foo Change\n\n只做任务清单里的第 1 项；做完就跑一遍 pnpm test。',
  JSON.stringify(String(calls.prompted[0]?.content?.[0]?.text || '')),
)

// 3. 组合带提示词：组合里的提示词要存得住，新加的节点连提示词一起播种。
mkdirSync(path.join(proj, 'openspec', 'changes', 'bar', 'specs', 'demo'), { recursive: true })
writeFileSync(path.join(proj, 'openspec', 'changes', 'bar', 'proposal.md'), '# bar\n', 'utf8')
writeFileSync(path.join(proj, 'openspec', 'changes', 'bar', 'tasks.md'), '- [ ] 做事\n', 'utf8')
writeFileSync(path.join(proj, 'openspec', 'changes', 'bar', 'design.md'), '# bar\n', 'utf8')
writeFileSync(
  path.join(proj, 'openspec', 'changes', 'bar', 'specs', 'demo', 'spec.md'),
  '## ADDED Requirements\n\n### Requirement: bar\n\nThe system SHALL do it.\n\n#### Scenario: works\n- **WHEN** 有人要它做\n- **THEN** 它做了\n',
  'utf8',
)
const comboPrompt = '做完跑一遍 pnpm test；全过了再按 openspec-archive-change 归档。'
await postAction({
  action: 'save',
  state: {
    name: '默认组合测试',
    maxParallel: 1,
    profiles: [{ ...combo, prompt: comboPrompt, commit: true }],
    defaultProfileId: 'p1',
    nodes: [{ id: 'N1', change: 'foo', deps: ['start'], status: 'done' }],
  },
})
const beforeAdd = await getState()
check(
  '组合的提示词存进了 pipeline.json',
  beforeAdd.state?.profiles?.[0]?.prompt === comboPrompt,
  JSON.stringify(beforeAdd.state?.profiles?.[0]),
)
await postAction({ action: 'add-all' })
const afterAdd = await getState()
const barNode = afterAdd.state?.nodes?.find((node) => node.change === 'bar')
check('add-all 新加的节点带上组合的提示词', barNode?.prompt === comboPrompt, JSON.stringify(barNode))
check('add-all 新加的节点也带上组合的四样', barNode?.preset === 'standard' && barNode?.model === 'mm', JSON.stringify(barNode))
// 0.15 起「归档后提交」也进组合：存过这一项，新加的节点就带上；没存过的老组合不碰节点上的勾。
check('组合里的归档后提交存进了 pipeline.json', beforeAdd.state?.profiles?.[0]?.commit === true, JSON.stringify(beforeAdd.state?.profiles?.[0]))
check('add-all 新加的节点也带上组合里的归档后提交', barNode?.commit === true, JSON.stringify(barNode?.commit))

console.log(failures.length ? `\n${failures.length} 项失败` : '\n全部通过')
process.exit(failures.length ? 1 : 0)
