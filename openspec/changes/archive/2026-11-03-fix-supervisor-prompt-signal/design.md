# Design

## Context

宿主 `sessionController.prompt(request, signal)` 的 `signal` 是必填参数，实现第一行就是 `signal.throwIfAborted()`；`create(request)` 只收一个参数。插件现有的四处 `prompt` 调用里，只有 runner 那一处（`lib/index.js` 开跑分支）传了 `this.controller.signal`，其余三处只传了 `request`。

监工不是 runner 的一部分：它比一条流水线活得久，runner 停了、重跑、换仓库，监工都还在。所以不能直接复用 runner 的 `AbortController`。

## Goals / Non-Goals

**Goals:**

- 三条投递路径都拿到一个有效的取消信号，且信号的生命周期与「投递一次」一致，不与 runner 绑定。
- 开监工失败后可重试，且重试复用同一个会话。
- 投递失败有可读的落点（`supervisor.lastNote`）。

**Non-Goals:**

- 不改「什么时候投值班单」的判定（那是另一个 change 的事）。
- 不给监工加新的动作（它仍然只有 `status` / `run` / `tell` / `archive`）。
- 不清理已经留在用户侧栏里的历史孤儿对话。

## Decisions

### 一次性投递用 `AbortSignal.timeout`

三处调用各传 `AbortSignal.timeout(30_000)`。理由：信号要表达的是「这次投递等太久就算了」，而不是「整轮对话到此为止」。宿主收到消息就入队，30 秒足够覆盖排队；超时只影响这一次调用的返回，不影响已经在跑的对话。

备选：给监工也建一个长生命周期 `AbortController`。放弃的原因是它引入一个额外的生命周期要管（停用监工、仓库切换、插件卸载都得记得 abort），而收益只是省掉一次 timeout 对象。

### 先落 `sessionId`，再发口径

顺序改成：`create` → 写 `state.supervisor.sessionId` → `saveState` → `prompt` 发口径 → 再 `saveState`（把 `enabled` 置真）。这样口径发送失败时，会话身份已经在 `pipeline.json` 里；下次启用 `liveSession(sessionId)` 命中，走「复用」分支，只补发口径。

备选：失败时删掉刚建的会话。放弃的原因是宿主的会话删除要另找接口，而且删掉会连对话历史一起丢；留着复用更省事，也和「停用不删对话」的既有语义一致。

### 失败写进 `lastError`，不靠文案前缀

`notifySupervisor` 的 catch 里把 `supervisor.lastError` 写成失败原因，并 `pushEvent({ type: 'nodes' })`；投递成功时把 `lastError` 清回空串。`lastNote` 继续只放「最近一次值班的标题」，两个字段各管一件事。

备选：复用 `lastNote`、失败时加「没送出去」前缀。放弃的原因是「这条记录是不是失败」要靠匹配中文前缀来判，改一次文案就失效；面板也不该靠猜。`normalizeSupervisor` 补一个 `lastError` 默认值，老状态文件读出来是空串。

## Risks / Trade-offs

- **30 秒超时对极慢的宿主偏短** → 只影响这一次投递的返回；消息已入队时对话照常收到，失败会记进 `lastNote`，能看出来。
- **失败信息要等下一次成功才消失** → `lastError` 只在投递成功时清空；期间面板会一直显示它。这是有意的：在没有下一次值班之前，那条失败仍然是事实。
- **先落 `sessionId` 带来一个中间态**（会话有了、口径还没发） → 只在 `prompt` 抛错的瞬间存在，重试即修复；状态文件里 `enabled` 仍是 `false`，不会误以为监工已经在值班。
