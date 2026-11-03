// 离线回归：救活一格失败（revive 原对话 / fresh 换新对话）与只读的 peek。
//
// 跑法：node test/revive.mjs
//
// 覆盖：
//   1. 默认接回原对话：指导就是下一句话，不新建会话，原 sessionId 不变；
//   2. fresh：新会话第一句话 = 执行 <change> Change + 节点提示词 + 指导，老会话零投递；
//   3. 三条拒绝：没有原对话、原对话读不到、仓库已有流水线在跑 / 这一轮还没结束；
//   4. peek 只读：拿得到最后一段和收尾状态，不往会话里发话；读不到时明说读不到；长度默认封顶 2000。
import { makeSandbox, makeProject, writePipeline, startHost, makeChecker, waitFor, endTurn, archiveChange } from './fake-host.mjs'

const sandbox = makeSandbox('osp-revive-')
const { check, finish } = makeChecker()
let onWorkPrompt = null

const host = await startHost({
  onPrompt(context) {
    if (onWorkPrompt) return onWorkPrompt(context)
    return { accepted: true }
  },
})

function message(text) {
  return { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}

// 工具 schema 里必须真的能读到这三个动作（面板和 Agent 都按枚举调用）。
const actionEnum = host.tools[0]?.parameters?.properties?.action?.enum || []
check(
  '工具动作枚举里有 revive / peek / start-node',
  ['revive', 'peek', 'start-node'].every((name) => actionEnum.includes(name)),
  JSON.stringify(actionEnum),
)

// ---------- 1. 原对话接着做 ----------
const attachProj = makeProject(sandbox, 'proj-attach', ['attach-one'])
const oldAttach = host.newSession('old-attach')
oldAttach.push(message('原对话里已经有上下文'))
writePipeline(attachProj, [
  { id: 'N1', change: 'attach-one', deps: ['start'], status: 'failed', sessionId: 'old-attach' },
])
const createdBefore = host.created.length
onWorkPrompt = ({ sessionId, text, session }) => {
  if (sessionId !== 'old-attach') return { accepted: true }
  check('revive 把指导原样送进原对话', text === '接着做，把归档补上', text)
  endTurn(session, 'completed', '接着做完了，也归档了')
  archiveChange(attachProj, 'attach-one')
  return { accepted: true }
}
const revived = await host.post({ action: 'revive', root: attachProj, nodeId: 'N1', text: '接着做，把归档补上' })
check('revive 立刻返回成功', revived.ok === true, JSON.stringify(revived.error || revived.text))
check('返回值说明用的是原对话', String(revived.text || '').includes('接着原来的对话'), revived.text)
const attachDone = await waitFor(async () => {
  const view = (await host.getState(attachProj)).payload
  return (view.state?.nodes || []).find((item) => item.id === 'N1' && item.status === 'done')
})
check('原对话接着做之后这一格完成', Boolean(attachDone), JSON.stringify(attachDone))
check('没有新建对话', host.created.length === createdBefore, `${createdBefore} → ${host.created.length}`)
check('sessionId 没被换掉', attachDone?.sessionId === 'old-attach', JSON.stringify(attachDone?.sessionId))

// ---------- 2. fresh 换新对话 ----------
const freshProj = makeProject(sandbox, 'proj-fresh', ['fresh-one'])
const oldFresh = host.newSession('old-fresh')
oldFresh.push(message('这段老上下文不要了'))
writePipeline(freshProj, [
  {
    id: 'N1',
    change: 'fresh-one',
    deps: ['start'],
    status: 'failed',
    sessionId: 'old-fresh',
    prompt: '节点自己的口径：做完要归档',
  },
])
const createdBeforeFresh = host.created.length
let freshText = ''
onWorkPrompt = ({ sessionId, text, session }) => {
  if (sessionId === 'old-fresh') return { accepted: true }
  freshText = text
  endTurn(session, 'completed', '从头做完了')
  archiveChange(freshProj, 'fresh-one')
  return { accepted: true }
}
const fresh = await host.post({ action: 'revive', root: freshProj, nodeId: 'N1', text: '这次从头做一遍，先看 tasks', fresh: true })
check('fresh 返回成功', fresh.ok === true, JSON.stringify(fresh.error || fresh.text))
check('返回值说明换了新对话', String(fresh.text || '').includes('新对话'), fresh.text)
// runner 的 loop 是异步起的：revive 返回时新对话可能还没来得及建，等它一下。
const freshCreated = await waitFor(() => (host.created.length === createdBeforeFresh + 1 ? host.created.length : null))
check('fresh 建了一个新对话', Boolean(freshCreated), `${createdBeforeFresh} → ${host.created.length}`)
const freshDone = await waitFor(async () => {
  const view = (await host.getState(freshProj)).payload
  return (view.state?.nodes || []).find((item) => item.id === 'N1' && item.status === 'done')
})
check('fresh 之后这一格完成', Boolean(freshDone), JSON.stringify(freshDone))
check('sessionId 换成了新对话', freshDone?.sessionId && freshDone.sessionId !== 'old-fresh', JSON.stringify(freshDone?.sessionId))
check('新对话第一句话以「执行 fresh-one Change」开头', freshText.startsWith('执行 fresh-one Change'), freshText)
check('新对话带节点自己的提示词', freshText.includes('节点自己的口径：做完要归档'), freshText)
check('新对话带监工给的指导', freshText.includes('这次从头做一遍，先看 tasks'), freshText)
check('老对话没有收到任何话', host.promptsFor('old-fresh').length === 0, JSON.stringify(host.promptsFor('old-fresh')))

// ---------- 3. 拒绝路径 ----------
const noSessionProj = makeProject(sandbox, 'proj-nosession', ['nosession-one'])
writePipeline(noSessionProj, [{ id: 'N1', change: 'nosession-one', deps: ['start'], status: 'failed' }])
const noSession = await host.post({ action: 'revive', root: noSessionProj, nodeId: 'N1', text: '接着做' })
check('没有原对话也没 fresh → 拒绝', noSession.status === 400, JSON.stringify(noSession))
check('拒绝说清只能换新对话', String(noSession.error || '').includes('fresh'), String(noSession.error || ''))

const ghostProj = makeProject(sandbox, 'proj-ghost', ['ghost-one'])
writePipeline(ghostProj, [
  { id: 'N1', change: 'ghost-one', deps: ['start'], status: 'failed', sessionId: 'gone-session' },
])
const ghost = await host.post({ action: 'revive', root: ghostProj, nodeId: 'N1', text: '接着做' })
check('原对话读不到 → 拒绝', ghost.status === 400, JSON.stringify(ghost))
check('拒绝说清只能换新对话重做', String(ghost.error || '').includes('读不到'), String(ghost.error || ''))

const busyProj = makeProject(sandbox, 'proj-busy', ['busy-one', 'busy-two'])
writePipeline(busyProj, [
  { id: 'N1', change: 'busy-one', deps: ['start'], status: 'pending' },
  { id: 'N2', change: 'busy-two', deps: ['start'], status: 'failed', sessionId: 'busy-old' },
])
host.newSession('busy-old')
onWorkPrompt = () => ({ accepted: true }) // 永远不收尾，runner 一直跑着
await host.post({ action: 'run', root: busyProj })
const busyRunning = await waitFor(async () => {
  const view = (await host.getState(busyProj)).payload
  return (view.state?.nodes || []).find((item) => item.id === 'N1' && item.status === 'running')
})
check('忙碌用例先让 N1 跑着', Boolean(busyRunning), JSON.stringify(busyRunning))
const stillRunning = await host.post({ action: 'revive', root: busyProj, nodeId: 'N1', text: '接着做' })
check('这一轮还没结束 → 拒绝', stillRunning.status === 400, JSON.stringify(stillRunning))
check('拒绝说清这一轮还没结束', String(stillRunning.error || '').includes('还没结束'), String(stillRunning.error || ''))
const busy = await host.post({ action: 'revive', root: busyProj, nodeId: 'N2', text: '接着做' })
check('仓库已有流水线在跑 → 拒绝', busy.status === 400, JSON.stringify(busy))
check('拒绝说清等它收尾或停止', String(busy.error || '').includes('流水线在跑'), String(busy.error || ''))
await host.post({ action: 'stop', root: busyProj })

// 磁盘上还写着「跑着」、但其实没有 runner：不 cancel 就拒绝，带了 cancel 才接管。
const staleProj = makeProject(sandbox, 'proj-stale', ['stale-one'])
host.newSession('stale-run')
writePipeline(staleProj, [
  { id: 'N1', change: 'stale-one', deps: ['start'], status: 'running', sessionId: 'stale-run' },
])
const staleReject = await host.post({ action: 'revive', root: staleProj, nodeId: 'N1', text: '接着做' })
check('磁盘上还跑着 → 不 cancel 就拒绝', staleReject.status === 400, JSON.stringify(staleReject))
check('拒绝提示带 cancel', String(staleReject.error || '').includes('cancel'), String(staleReject.error || ''))
onWorkPrompt = ({ sessionId, session }) => {
  if (sessionId === 'stale-run') {
    endTurn(session, 'completed', '旧的一轮收尾了，这一句是新活')
    archiveChange(staleProj, 'stale-one')
  }
  return { accepted: true }
}
const staleRevive = await host.post({ action: 'revive', root: staleProj, nodeId: 'N1', text: '接着做', cancel: true })
check('带 cancel 就能接管', staleRevive.ok === true, JSON.stringify(staleRevive.error || staleRevive.text))
check(
  '接管前取消了旧的那一轮',
  host.cancels.some((row) => row.sessionId === 'stale-run'),
  JSON.stringify(host.cancels),
)
const staleDone = await waitFor(async () => {
  const view = (await host.getState(staleProj)).payload
  return (view.state?.nodes || []).find((item) => item.id === 'N1' && item.status === 'done')
})
check('接管之后这一格完成', Boolean(staleDone), JSON.stringify(staleDone))

// ---------- 4. peek 只读 ----------
const peekBefore = host.prompts.length
const peeked = await host.post({ action: 'peek', root: attachProj, nodeId: 'N1' })
check('peek 成功返回', peeked.status === 200 && peeked.ok === true, JSON.stringify(peeked))
check('peek 拿到最后一段', String(peeked.text || '').includes('接着做完了，也归档了'), peeked.text)
check('peek 说清这一轮正常收尾', String(peeked.text || '').includes('正常收尾'), peeked.text)
check('peek 没往会话里发任何话', host.prompts.length === peekBefore, String(host.prompts.length - peekBefore))

const peekGoneProj = makeProject(sandbox, 'proj-peek-gone', ['peek-gone'])
writePipeline(peekGoneProj, [
  { id: 'N1', change: 'peek-gone', deps: ['start'], status: 'failed', sessionId: 'missing-peek' },
])
const peekGone = await host.post({ action: 'peek', root: peekGoneProj, nodeId: 'N1' })
check('peek 读不到时明说读不到', String(peekGone.text || '').includes('读不到'), peekGone.text)
check('peek 读不到时不返回空串', String(peekGone.text || '').trim().length > 0, JSON.stringify(peekGone.text))

const longProj = makeProject(sandbox, 'proj-peek-long', ['peek-long'])
const longSession = host.newSession('long-peek')
longSession.push(message('长'.repeat(3000)))
writePipeline(longProj, [
  { id: 'N1', change: 'peek-long', deps: ['start'], status: 'failed', sessionId: 'long-peek' },
])
const longPeek = await host.post({ action: 'peek', root: longProj, nodeId: 'N1' })
const shown = String(longPeek.text || '').split('最后说的：\n')[1] || ''
check('peek 默认最多 2000 字', shown.length > 0 && shown.length <= 2000, String(shown.length))

host.close()
finish()
