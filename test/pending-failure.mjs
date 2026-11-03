// 离线回归：没处理掉的失败不许丢（supervisor.pending）。
//
// 跑法：node test/pending-failure.mjs
//
// 覆盖三种情况：
//   1. 投出去之后监工那一轮没有正常收尾 → 待办留着；
//   2. 刚投过不重投；过了 5 分钟再读状态 → 按节奏补投一次；
//   3. 这一格被 revive 救回来、不再是失败状态 → 待办清掉，不再投递。
import { makeSandbox, makeProject, writePipeline, startHost, makeChecker, waitFor, endTurn, archiveChange } from './fake-host.mjs'

const sandbox = makeSandbox('osp-pending-')
const { check, finish } = makeChecker()
const realNow = Date.now.bind(Date)
let offset = 0
Date.now = () => realNow() + offset

const supId = 'sup-pending'
let revived = false
const proj = makeProject(sandbox, 'proj-pending', ['pending-one'])
const sup = await (async () => {
  const host = await startHost({
    onPrompt({ sessionId, session }) {
      // 监工那一轮永远不收尾：模拟「网络还没回来，监工也跑不动」。
      if (sessionId === supId) return { accepted: true }
      if (sessionId !== supId) {
        if (revived) {
          endTurn(session, 'completed', '网好了，做完了也归档了')
          archiveChange(proj, 'pending-one')
        } else {
          endTurn(session, 'network', '网断了，我先停在这')
        }
      }
      return { accepted: true }
    },
  })
  host.newSession(supId)
  return host
})()

writePipeline(
  proj,
  [{ id: 'N1', change: 'pending-one', deps: ['start'], status: 'pending' }],
  { enabled: true, sessionId: supId },
)

function pendingOf(view) {
  return view.state?.supervisor?.pending || []
}

await sup.post({ action: 'run', root: proj })
const failed = await waitFor(async () => {
  const view = (await sup.getState(proj)).payload
  return (view.state?.nodes || []).find((item) => item.id === 'N1' && item.status === 'failed')
})
check('这一格失败了', Boolean(failed), JSON.stringify(failed))
const firstNotice = await waitFor(() => sup.promptsFor(supId).find((row) => row.text.includes('N1 失败了')))
check('第一次失败投了值班单', Boolean(firstNotice), JSON.stringify(sup.promptsFor(supId).map((row) => row.text.slice(0, 30))))
const afterFail = (await sup.getState(proj)).payload
const entry = pendingOf(afterFail)[0]
check('失败留下了待办', pendingOf(afterFail).length === 1, JSON.stringify(pendingOf(afterFail)))
check('待办记了原因和最后说的话', String(entry?.reason || '').includes('network'), JSON.stringify(entry))
const noticesAfterFirst = sup.promptsFor(supId).length

// 1. 监工那一轮没收尾 → 待办不能被当成处理完。
check('监工没收尾时待办还在', pendingOf(afterFail).length === 1, JSON.stringify(pendingOf(afterFail)))
check('刚刚投过，不重投', sup.promptsFor(supId).length === noticesAfterFirst, String(sup.promptsFor(supId).length))

// 2. 过 5 分钟再读状态 → 补投一次，并写明已经投过几次。
offset += 5 * 60 * 1000
const secondNotice = await waitFor(async () => {
  const view = (await sup.getState(proj)).payload
  return pendingOf(view).length ? sup.promptsFor(supId).find((row) => row.text.includes('还是失败的')) : null
}, 5000)
check('过了 5 分钟按节奏补投', Boolean(secondNotice), JSON.stringify(sup.promptsFor(supId).map((row) => row.text.slice(0, 40))))
const afterRetry = (await sup.getState(proj)).payload
check('补投之后待办还在（监工还是没收尾）', pendingOf(afterRetry).length === 1, JSON.stringify(pendingOf(afterRetry)))
check('补投之后 tries 累加', Number(pendingOf(afterRetry)[0]?.tries) === 2, JSON.stringify(pendingOf(afterRetry)[0]))
const noticesAfterRetry = sup.promptsFor(supId).length
await sup.getState(proj)
check('同一分钟内不会连着补投', sup.promptsFor(supId).length === noticesAfterRetry, String(sup.promptsFor(supId).length))

// 监工那一轮正常收尾、但格子还失败着：不能当成处理完了。
endTurn(sup.sessions.get(supId), 'completed', '看了一眼，这次不用动手')
const afterHandledTurn = (await sup.getState(proj)).payload
check('监工正常收尾不等于处理完，待办还留着', pendingOf(afterHandledTurn).length === 1, JSON.stringify(pendingOf(afterHandledTurn)))

// 第三次补投：单子要写明已经投过几次。
offset += 5 * 60 * 1000
const thirdNotice = await waitFor(async () => {
  const view = (await sup.getState(proj)).payload
  return pendingOf(view).length ? sup.promptsFor(supId).find((row) => row.text.includes('投过 2 次')) : null
}, 5000)
check('第三次补投写明已经投过几次', Boolean(thirdNotice), JSON.stringify(sup.promptsFor(supId).map((row) => row.text.slice(0, 40))))
const afterThird = (await sup.getState(proj)).payload
check('第三次之后 tries 继续累加', Number(pendingOf(afterThird)[0]?.tries) === 3, JSON.stringify(pendingOf(afterThird)[0]))

// 3. 救回来之后清掉待办，不再投递。
const noticesBeforeRevive = sup.promptsFor(supId).length
revived = true
const reviveRes = await sup.post({ action: 'revive', root: proj, nodeId: 'N1', text: '网好了，接着做完并归档' })
check('revive 请求成功', reviveRes.ok === true, JSON.stringify(reviveRes.error || reviveRes.text))
const done = await waitFor(async () => {
  const view = (await sup.getState(proj)).payload
  return (view.state?.nodes || []).find((item) => item.id === 'N1' && item.status === 'done')
}, 12000)
// revive 之后 runner 会收到这句指导；模拟它接着做完并归档。
check('revive 之后这一格完成', Boolean(done), JSON.stringify(done))
const afterRevive = (await sup.getState(proj)).payload
check('不再是失败状态 → 待办清掉', pendingOf(afterRevive).length === 0, JSON.stringify(pendingOf(afterRevive)))
check('清掉之后不再投递', sup.promptsFor(supId).length === noticesBeforeRevive, String(sup.promptsFor(supId).length))

sup.close()
finish()
