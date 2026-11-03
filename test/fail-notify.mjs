// 离线回归：runner 的五条失败出口都投一张值班单。
//
// 跑法：node test/fail-notify.mjs
//
// 覆盖：
//   1. 对话以错误收尾（reason !== completed）→ 单子里有原因原文和它最后说的话；
//   2. 第一句话没送进去；
//   3. 拉不起会话（create 抛错）；
//   4. 会话没挂到宿主 sessions 上；
//   5. 这个模型用不了；
//   6. 没开监工时失败照样记失败，只是不投单；
//   7. 监工口径里有 revive / peek 和「失败」这个出手时机。
import { makeSandbox, makeProject, writePipeline, startHost, makeChecker, waitFor, endTurn } from './fake-host.mjs'

const sandbox = makeSandbox('osp-fail-')
const { check, finish } = makeChecker()
let mode = ''
let supervisorId = ''

const host = await startHost({
  onCreate({ session }) {
    if (mode === 'create') throw new Error('宿主：拉不起会话')
    if (mode === 'detach') host.sessions.delete(session.id)
  },
  onSelectModel() {
    if (mode === 'model') throw new Error('这个模型用不了')
    return {}
  },
  onPrompt({ sessionId, text, session }) {
    if (sessionId === supervisorId) return { accepted: true }
    if (mode === 'reason') endTurn(session, 'network', '我先做一半，网断了')
    if (mode === 'prompt') throw new Error('宿主：这一条没送进去')
    return { accepted: true }
  },
})

async function enableSupervisor(proj) {
  mode = ''
  const enabled = await host.post({ action: 'supervisor', root: proj, enabled: true })
  const state = (await host.getState(proj)).payload.state
  supervisorId = state.supervisor.sessionId
  return state.supervisor.sessionId
}

async function runCase({ name, change, node = {}, failureMode, expectLast }) {
  const proj = makeProject(sandbox, name, [change])
  writePipeline(proj, [{ id: 'N1', change, deps: ['start'], status: 'pending', ...node }])
  const sup = await enableSupervisor(proj)
  mode = failureMode
  await host.post({ action: 'run', root: proj })
  const failed = await waitFor(async () => {
    const view = (await host.getState(proj)).payload
    return (view.state?.nodes || []).find((item) => item.id === 'N1' && item.status === 'failed')
  })
  check(`${name}：这一格记为失败`, Boolean(failed), JSON.stringify(failed))
  const notice = await waitFor(() => host.promptsFor(sup).find((row) => row.text.includes('N1 失败了')))
  check(`${name}：投出一张值班单`, Boolean(notice), JSON.stringify(host.promptsFor(sup).map((row) => row.text.slice(0, 30))))
  const text = String(notice?.text || '')
  check(`${name}：单子写明失败原因`, text.includes('失败原因：'), text.slice(0, 300))
  check(`${name}：单子带上最后说的话`, text.includes(expectLast), text.slice(0, 500))
  check(`${name}：单子提示 revive 与 peek`, text.includes('revive') && text.includes('peek'), text.slice(0, 500))
  await host.post({ action: 'stop', root: proj })
  return { proj, notice: text }
}

const reasonCase = await runCase({
  name: 'proj-reason',
  change: 'reason-one',
  node: { reviveCount: 3 },
  failureMode: 'reason',
  expectLast: '我先做一半，网断了',
})
check('错误收尾的单子写的是那个 reason', reasonCase.notice.includes('network'), reasonCase.notice.slice(0, 300))
check('反复救不回来会写明救过几次', reasonCase.notice.includes('救过 3 次'), reasonCase.notice.slice(0, 500))

await runCase({
  name: 'proj-prompt',
  change: 'prompt-one',
  failureMode: 'prompt',
  expectLast: '（读不到',
})
await runCase({
  name: 'proj-create',
  change: 'create-one',
  failureMode: 'create',
  expectLast: '（读不到',
})
await runCase({
  name: 'proj-detach',
  change: 'detach-one',
  failureMode: 'detach',
  expectLast: '（读不到',
})
await runCase({
  name: 'proj-model',
  change: 'model-one',
  node: { provider: 'p', model: 'm' },
  failureMode: 'model',
  expectLast: '（读不到',
})

// 没开监工：失败还是失败，只是没人接单。
const quietProj = makeProject(sandbox, 'proj-quiet', ['quiet-one'])
writePipeline(quietProj, [{ id: 'N1', change: 'quiet-one', deps: ['start'], status: 'pending' }])
mode = 'reason'
const beforeQuiet = host.prompts.length
await host.post({ action: 'run', root: quietProj })
const quietFailed = await waitFor(async () => {
  const view = (await host.getState(quietProj)).payload
  return (view.state?.nodes || []).find((item) => item.id === 'N1' && item.status === 'failed')
})
check('没开监工：这一格照常记失败', Boolean(quietFailed), JSON.stringify(quietFailed))
await new Promise((resolve) => setTimeout(resolve, 300))
const quietNotices = host.prompts.slice(beforeQuiet).filter((row) => row.text.includes('N1 失败了'))
check('没开监工：不投值班单', quietNotices.length === 0, JSON.stringify(quietNotices.map((row) => row.text.slice(0, 40))))

// 监工口径：第三个出手时机 + 两个新动作。
const intro = host.promptsFor(supervisorId).find((row) => row.text.includes('值班监工'))
check('启用口径里写了「失败」这个时机', Boolean(intro?.text.includes('某一格失败了')), intro?.text?.slice(0, 400))
check('值班单口径里有 revive', reasonCase.notice.includes('- revive'), reasonCase.notice.slice(0, 800))
check('值班单口径里有 peek', reasonCase.notice.includes('- peek'), reasonCase.notice.slice(0, 800))

host.close()
finish()
