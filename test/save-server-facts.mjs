// 离线回归：保存 = 画布出图、服务器出状态（0.12 自动落盘之后必须这么分工）。
//
// 为什么要有这条：没有「保存」按钮之后，画布每改一下就写一次文件，
// 客户端手里那份状态随时可能旧一截（它记着 running，宿主早就收尾了）。
// 如果整份覆盖，一次拖动就能把「完成」写回「跑着」，下次打开被判成失败。
//
// 要证明三件事：
//   1. 客户端送来的旧状态不会盖掉服务器事实（done 不会被写回 running）；
//   2. 画布上的东西（连线、提示词、位置）照常生效；
//   3. 画布上新加的格子一律从「待跑」开始，不继承客户端写的状态。
//
// 跑法：
//   node plugins/dsh-openspec-pipeline/test/save-server-facts.mjs
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'osp-save-facts-'))
const profile = path.join(sandbox, 'profile')
const proj = path.join(sandbox, 'proj')
mkdirSync(profile, { recursive: true })
mkdirSync(path.join(proj, 'openspec', 'specs'), { recursive: true })
for (const name of ['foo', 'bar']) {
  mkdirSync(path.join(proj, 'openspec', 'changes', name), { recursive: true })
  writeFileSync(path.join(proj, 'openspec', 'changes', name, 'proposal.md'), `# ${name}\n`, 'utf8')
}
mkdirSync(path.join(proj, 'openspec', 'changes', 'archive'), { recursive: true })

const pipelineFile = path.join(proj, 'openspec', 'pipeline.json')
writeFileSync(
  pipelineFile,
  JSON.stringify(
    {
      version: 1,
      name: '保存分工',
      maxParallel: 1,
      profiles: [],
      defaultProfileId: '',
      nodes: [
        { id: 'start', kind: 'start', change: '', deps: [], status: 'done' },
        {
          id: 'N1',
          change: 'foo',
          deps: ['start'],
          status: 'done',
          note: '对话跑完了，已归档（archive/2026-10-31-foo）',
          sessionId: 'session-old',
          approved: '2026-10-31T01:00:00.000Z',
        },
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
const ctx = {
  tools: { register() { return () => {} } },
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

const failures = []
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`)
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    failures.push(name)
  }
}
const nodeOf = (payload, id) => (payload?.state?.nodes || []).find((node) => node.id === id) || null

await post({ action: 'root', root: proj })

// 客户端手里这一格还是「跑着」，服务器上早就是「完成」了。
const saved = await post({
  action: 'save',
  state: {
    name: '保存分工',
    maxParallel: 1,
    profiles: [],
    defaultProfileId: '',
    nodes: [
      { id: 'start', kind: 'start', change: '', deps: [], status: 'done' },
      {
        id: 'N1',
        change: 'foo',
        deps: ['start'],
        x: 120,
        y: 40,
        prompt: '画布上新写的提示词',
        status: 'running',
        note: '',
        sessionId: '',
      },
      // 画布上新加的格子，客户端给了个 done —— 不该被当真。
      { id: 'N2', change: 'bar', deps: ['N1'], status: 'done', note: '假的' },
    ],
  },
})

const n1 = nodeOf(saved, 'N1')
check('旧状态没盖掉服务器事实：done 还是 done', n1?.status === 'done', JSON.stringify(n1))
check('归档说明还在', String(n1?.note || '').includes('已归档'), n1?.note)
check('sessionId 还在', n1?.sessionId === 'session-old', n1?.sessionId)
check('批准时间还在', n1?.approved === '2026-10-31T01:00:00.000Z', n1?.approved)
check('画布上的提示词生效了', n1?.prompt === '画布上新写的提示词', n1?.prompt)
check('画布上的位置生效了', n1?.x === 120 && n1?.y === 40, JSON.stringify({ x: n1?.x, y: n1?.y }))

const n2 = nodeOf(saved, 'N2')
check('新加的格子从待跑开始', n2?.status === 'pending', JSON.stringify(n2))
check('新加的格子说明是空的', !n2?.note, n2?.note)

const onDisk = JSON.parse(readFileSync(pipelineFile, 'utf8'))
const diskN1 = onDisk.nodes.find((node) => node.id === 'N1')
check('落盘的也是服务器事实', diskN1?.status === 'done', JSON.stringify(diskN1))
check('落盘带上了画布改动', diskN1?.prompt === '画布上新写的提示词', diskN1?.prompt)

console.log(failures.length ? `\n${failures.length} 项没过` : '\n全部通过')
process.exit(failures.length ? 1 : 0)
