// 离线回归：对话模式（预置）和思考强度这两份名单只能来自这台机器，不能跟着插件走。
//
// 要证明四件事：
//   1. 宿主回 { presets: [...] }（它真的是这么回的）时，面板拿到的是这台机器上的预置；
//   2. 宿主没有 agentPresets 服务时，名单是空的 —— 不拿一份写死的名单顶上；
//   3. 老形状（裸数组）也认，别因为宿主换了个包装就把名单丢了；
//   4. 预置「组不起来」的原因（broken）要原样带到面板，人家才知道为什么选了开不了对话。
//
// 另外静态查一下源码：开发机那 5 个预置 id 不许再出现（它们是别人机器上的东西）。
//
// 跑法：
//   node plugins/dsh-openspec-pipeline/test/presets-from-host.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
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

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'osp-presets-'))
const profile = path.join(sandbox, 'profile')
const proj = path.join(sandbox, 'proj')
mkdirSync(profile, { recursive: true })
mkdirSync(path.join(proj, 'openspec', 'changes', 'archive'), { recursive: true })
mkdirSync(path.join(proj, 'openspec', 'specs'), { recursive: true })
writeFileSync(
  path.join(proj, 'openspec', 'pipeline.json'),
  JSON.stringify({ version: 1, name: '预置测试', nodes: [{ id: 'start', kind: 'start' }] }, null, 2),
  'utf8',
)

process.env.DSH_PROFILE_DIR = profile
const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)

// 每一种宿主长什么样，就挂一次插件，读一次面板看到的名单。
function mount(services) {
  const routes = []
  apply({
    tools: { register: () => () => {} },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => [{ id: 'ws', title: 'proj', path: proj }] }
      return services[name]
    },
  })
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

  return {
    post: (body) => request('POST', '/openspec-pipeline/api/action', body),
    getState: () => request('GET', '/openspec-pipeline/api/state'),
  }
}

async function viewWith(services) {
  const api = mount(services)
  await api.post({ action: 'root', root: proj })
  return api.getState()
}

// ---------- 1. 宿主真实形状 ----------
const realView = await viewWith({
  agentPresets: {
    list: async () => ({
      presets: [
        { id: 'mine-a', name: '我的模式 A', description: '本机装的' },
        { id: 'mine-b', name: '我的模式 B', isDefault: true },
        { id: 'broken-one', name: '坏掉的模式', broken: '缺 .agents/presets/broken-one.md' },
      ],
    }),
  },
})
const real = realView.presets
check('拿到的是这台机器上的预置', Array.isArray(real) && real.length === 3, JSON.stringify(real))
check(
  'id 原样带过来',
  JSON.stringify((real || []).map((preset) => preset.id)) === JSON.stringify(['mine-a', 'mine-b', 'broken-one']),
  JSON.stringify((real || []).map((preset) => preset.id)),
)
check('名字没被改写', real?.[0]?.name === '我的模式 A', JSON.stringify(real?.[0]))
check('默认预置的标记带过来', real?.[1]?.isDefault === true, JSON.stringify(real?.[1]))
check('组不起来的原因带过来', real?.[2]?.broken === '缺 .agents/presets/broken-one.md', JSON.stringify(real?.[2]))
check('读到了就不写错误原因', realView.presetError === '', String(realView.presetError))

// ---------- 2. 宿主没有这个服务：空名单 + 说清原因 ----------
const absentView = await viewWith({})
const absent = absentView.presets
check('没有 agentPresets 服务时是空名单', Array.isArray(absent) && absent.length === 0, JSON.stringify(absent))
check('空名单要说明原因', /agentPresets/.test(String(absentView.presetError || '')), String(absentView.presetError))
check(
  '不拿写死的名单顶上',
  !(absent || []).some((preset) => ['standard', 'ptc', 'minimal', 'cordis', 'master-control'].includes(preset.id)),
  JSON.stringify(absent),
)

// ---------- 3. 老形状（裸数组）也认 ----------
const legacy = (await viewWith({ agentPresets: { list: async () => [{ id: 'legacy-mode', name: '老格式' }] } }))
  .presets
check('裸数组也读得到', legacy?.[0]?.id === 'legacy-mode', JSON.stringify(legacy))

// ---------- 4. 服务抛异常：空名单，不炸 ----------
const throwingView = await viewWith({
  agentPresets: {
    list: async () => {
      throw new Error('宿主还没醒')
    },
  },
})
const throwing = throwingView.presets
check('服务抛异常时是空名单', Array.isArray(throwing) && throwing.length === 0, JSON.stringify(throwing))
check('抛异常也要说清原因', /读不到对话模式/.test(String(throwingView.presetError || '')), String(throwingView.presetError))

// ---------- 5. 源码里不许再有开发机那 5 个预置 ----------
const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
// 只查「写死成选项」的赋法；说明注释里提这几个 id 是为了告诉后来人别再捡回来。
const hardcodedPreset = /id:\s*['"](standard|ptc|minimal|cordis|master-control)['"]/
check('lib/index.js 里没有写死的预置名单', !hardcodedPreset.test(source), source.match(hardcodedPreset)?.[0] || '')

const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
check('lib/client.js 里没有写死的思考强度名单', !/EFFORTS\s*=/.test(clientSource))
check('面板里没有开发机的仓库路径', !clientSource.includes('agent-forge'))

console.log(failures.length ? `\n${failures.length} 项没过` : '\n全部通过')
if (failures.length) process.exitCode = 1
