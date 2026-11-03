// 离线回归：一轮对话长时间没有任何新事件 = 卡住。
//
// 跑法：node test/stall.mjs
//
// 覆盖：
//   1. 连续 10 分钟没有新事件 → 取消那一轮、记失败、监工收到单子（单子里有「几分钟」和 peek 提示）；
//   2. 阈值为 0 → 一直等，不因为没动静取消任何一轮；
//   3. 跑了 40 分钟但一直有新事件 → 不判卡住。
//
// 时钟用假的偏移量往前推：阈值下限是 10 分钟，真等 10 分钟没法跑回归。
import { makeSandbox, makeProject, writePipeline, startHost, makeChecker, waitFor, endTurn, archiveChange } from './fake-host.mjs'

const sandbox = makeSandbox('osp-stall-')
const { check, finish } = makeChecker()
const realNow = Date.now.bind(Date)
let offset = 0
Date.now = () => realNow() + offset

let mode = 'wait'
let workTurnSeq = 0
let timer = null

const host = await startHost({
  onPrompt({ sessionId, session }) {
    if (mode === 'flaky' && sessionId !== 'sup-stall') {
      const round = ++workTurnSeq
      timer = setInterval(() => session.push({ type: 'assistant/token', data: { round } }), 100)
      setTimeout(() => {
        clearInterval(timer)
        endTurn(session, 'completed', '长任务做完了')
        archiveChange(project, changeName)
      }, 1600)
    }
    return { accepted: true }
  },
})

async function caseOne() {
  process.env.DSH_OPENSPEC_STALL_MS = String(10 * 60 * 1000)
  const proj = makeProject(sandbox, 'proj-stall', ['stall-one'])
  writePipeline(proj, [{ id: 'N1', change: 'stall-one', deps: ['start'], status: 'pending' }], {
    enabled: true,
    sessionId: 'sup-stall',
  })
  host.newSession('sup-stall')
  mode = 'wait'
  await host.post({ action: 'run', root: proj })
  const prompted = await waitFor(() => host.prompts.find((row) => row.sessionId !== 'sup-stall'))
  check('卡住用例先拉起一个工作对话', Boolean(prompted), JSON.stringify(host.prompts.map((row) => row.sessionId)))
  await new Promise((resolve) => setTimeout(resolve, 700))
  offset += 11 * 60 * 1000
  const failed = await waitFor(async () => {
    const view = (await host.getState(proj)).payload
    return (view.state?.nodes || []).find((item) => item.id === 'N1' && item.status === 'failed')
  }, 12000)
  check('10 分钟没有动静 → 记失败', Boolean(failed), JSON.stringify(failed))
  check('失败原因写了几分钟没动', /分钟/.test(String(failed?.note || '')), String(failed?.note || ''))
  await waitFor(() => host.cancels.find((row) => row.sessionId === prompted?.sessionId), 5000)
  check(
    '卡住的那一轮被取消',
    host.cancels.some((row) => row.sessionId === prompted?.sessionId),
    JSON.stringify(host.cancels),
  )
  const notice = await waitFor(
    () => host.prompts.find((row) => row.sessionId === 'sup-stall' && row.text.includes('卡住了')),
    5000,
  )
  check('监工收到卡住的值班单', Boolean(notice), JSON.stringify(host.prompts.filter((row) => row.sessionId === 'sup-stall').map((row) => row.text.slice(0, 40))))
  check('值班单写明多久没有动静', /分钟没有任何动静/.test(String(notice?.text || '')), notice?.text?.slice(0, 500))
  check('值班单提示先 peek', String(notice?.text || '').includes('peek'), notice?.text?.slice(0, 500))
  const stopped = (await host.getState(proj)).payload
  check('卡住之后这一轮收工', stopped.running === false, JSON.stringify(stopped.running))
  await host.post({ action: 'stop', root: proj })
  return { proj, workSessionId: prompted?.sessionId }
}

const first = await caseOne()

// 阈值为 0：一直等。
process.env.DSH_OPENSPEC_STALL_MS = '0'
offset = 0
const projTwo = makeProject(sandbox, 'proj-zero', ['zero-one'])
writePipeline(projTwo, [{ id: 'N1', change: 'zero-one', deps: ['start'], status: 'pending' }])
mode = 'wait'
const quietBefore = host.cancels.length
const runTwo = await host.post({ action: 'run', root: projTwo })
check('阈值为 0 时开跑成功', runTwo.ok === true, JSON.stringify(runTwo.error || runTwo.text))
const workTwo = await waitFor(() => host.prompts.find((row) => row.text.startsWith('执行 zero-one Change')))
await new Promise((resolve) => setTimeout(resolve, 700))
offset += 40 * 60 * 1000
await new Promise((resolve) => setTimeout(resolve, 1200))
const stillRunning = (await host.getState(projTwo)).payload.state?.nodes?.find((item) => item.id === 'N1')
check('阈值为 0：40 分钟没动静也不取消', stillRunning?.status === 'running', JSON.stringify(stillRunning?.status))
check('阈值为 0：没有取消任何一轮', host.cancels.length === quietBefore, JSON.stringify(host.cancels.slice(quietBefore)))
// 补一轮正常收尾，证明它只是「一直等」。
endTurn(host.sessions.get(workTwo.sessionId), 'completed', '做完了')
archiveChange(projTwo, 'zero-one')
const doneTwo = await waitFor(async () => {
  const view = (await host.getState(projTwo)).payload
  return (view.state?.nodes || []).find((item) => item.id === 'N1' && item.status === 'done')
})
check('阈值为 0：后来收尾了就正常记完成', Boolean(doneTwo), JSON.stringify(doneTwo))
await host.post({ action: 'stop', root: projTwo })

// 40 分钟长任务，但一直有事件。
process.env.DSH_OPENSPEC_STALL_MS = String(10 * 60 * 1000)
offset = 0
const project = makeProject(sandbox, 'proj-long', ['long-one'])
const changeName = 'long-one'
writePipeline(project, [{ id: 'N1', change: changeName, deps: ['start'], status: 'pending' }])
mode = 'flaky'
const cancelBefore = host.cancels.length
await host.post({ action: 'run', root: project })
const workThree = await waitFor(() => host.prompts.find((row) => row.text.startsWith('执行 long-one Change')))
check('长任务先拉起工作对话', Boolean(workThree), JSON.stringify(host.prompts.map((row) => row.text.slice(0, 20))))
offset += 40 * 60 * 1000
const doneThree = await waitFor(async () => {
  const view = (await host.getState(project)).payload
  return (view.state?.nodes || []).find((item) => item.id === 'N1' && item.status === 'done')
}, 15000)
check('一直有动静的 40 分钟长任务 → 不判卡住、正常完成', Boolean(doneThree), JSON.stringify(doneThree))
check('长任务没被取消', host.cancels.length === cancelBefore, JSON.stringify(host.cancels.slice(cancelBefore)))

host.close()
finish()
