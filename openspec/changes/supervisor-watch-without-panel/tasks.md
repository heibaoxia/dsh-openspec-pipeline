# Tasks

## 1. 监听改成按持有者登记

- [ ] 1.1 把 `watchArchives` / `stopArchiveWatch` 改成 `watchArchives(root, holder)` / `releaseArchiveWatch(root, holder)`，内部用持有者集合，集合空了才真正关 watcher；验证：`node test/event-stream.mjs` 与 `node test/supervisor.mjs` 仍全绿
- [ ] 1.2 面板连接建立时登记 `panel`、断开时只退掉 `panel`；验证：`node test/event-stream.mjs` 全绿，并且手动把同一仓库的两个面板关掉一个后，剩下的那个还能收到归档事件

## 2. 监工自己持有监听

- [ ] 2.1 启用监工时登记 `supervisor`，停用时退掉；验证：`test/supervisor.mjs` 新增一条断言 —— 停用监工之后归档 MUST NOT 再投值班单
- [ ] 2.2 在读状态、开跑、`supervisor` 动作三处，看到 `enabled` 为真就补登记；验证：新增用例 —— 先把 `enabled` 写成 true 但不开任何面板，调一次 `status` 之后归档，MUST 收到值班单
- [ ] 2.3 插件卸载时把所有持有者清掉；验证：跑完 `test/supervisor.mjs` 后进程能正常退出，MUST NOT 因为 watcher 残留而挂着

## 3. 回归：不开面板也能值守

- [ ] 3.1 删掉 `test/supervisor.mjs` 第 4 节里「先打开推送通道」那段准备，改成直接归档；验证：这一节 MUST 仍然收到归档值班单
- [ ] 3.2 新增「最后一个面板断开后归档照常投单」；验证：这一条 MUST 绿，且脚本里没有任何「先连 SSE 才能收到单」的前置
- [ ] 3.3 README 值班监工一节去掉「面板开着才盯着」的隐含前提；验证：`openspec validate supervisor-watch-without-panel --strict` 通过
