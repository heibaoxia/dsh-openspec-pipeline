# Tasks

## 1. 先让回归能抓到漏传

- [x] 1.1 把 `test/supervisor.mjs` 里假 `sessionController.prompt` 的签名改成 `(request, signal)`，`signal` 为 `undefined` 时当场抛错；验证：在未修改的 `lib/index.js` 上跑 `node test/supervisor.mjs`，「开监工成功」那一条 MUST 变红
- [x] 1.2 给同一个假 `create` 加调用计数；验证：脚本只在预期的几个位置红，其余条目不因计数改动而变红

## 2. 三条投递路径接上取消信号

- [x] 2.1 启用监工：`create` 成功后先写 `supervisor.sessionId` 并保存状态，再投递值班口径，投递带 `AbortSignal.timeout(30_000)`；验证：`node test/supervisor.mjs` 的「开监工成功」「sessionId 记进了 pipeline.json」「开了之后先发口径」三条转绿
- [x] 2.2 `tell` 投递同样带超时信号；验证：脚本新增一条断言 —— `tell` 对 N1 说话并等待，返回值里 MUST 出现那一格的回复文字
- [x] 2.3 `notifySupervisor` 投递带超时信号，失败时把原因写进 `supervisor.lastError` 并推一次状态刷新，投递成功时清空该字段；验证：脚本新增一条断言 —— 让假宿主拒收值班单后，`supervisor.lastError` MUST 含失败原因，之后成功投一次 MUST 变回空串
- [x] 2.4 README「值班监工与项目手册」补一句：口径或值班单送不出去时记在 `supervisor.lastError`；验证：`openspec validate fix-supervisor-prompt-signal --strict` 通过，且改过的段落读起来不需要再翻代码

## 3. 失败之后能重试

- [x] 3.1 让假宿主第一次发口径失败、第二次成功，断言 `create` 只被调用一次、第二次启用复用同一个 `sessionId`；验证：新增断言 MUST 转绿
- [x] 3.2 跑 `test/*.mjs` 全部脚本；验证：全部退出码为 0，没有别的脚本因为签名收紧而红
