# Tasks

## 1. 先确认状态里拿得到

- [ ] 1.1 在 `test/supervisor.mjs` 里加一条断言：`getState` 拿到的 `state.supervisor` MUST 含 `lastAt`、`lastNote`、`lastError` 三个字段；验证：跑 `node test/supervisor.mjs`，这一条 MUST 绿

## 2. 监工那一行说人话

- [ ] 2.1 开着且 `lastAt` 非空时，这一行显示最近一次值班的本地时间与 `lastNote`；验证：开监工后把某一格停住触发一次值班，面板这一行 MUST 出现时间与结论
- [ ] 2.2 开着但 `lastAt` 为空时，这一行显示「还没出过手」；验证：刚开监工时，这一行 MUST 显示这句话，MUST NOT 只显示「值班中」
- [ ] 2.3 `supervisor.lastError` 非空时，这一行用错误色显示原因原文；验证：让假宿主拒收值班单复现一次，面板这一行 MUST 变红且带原因，状态词仍然是「值班中」
- [ ] 2.4 时间按本地时间显示；验证：把状态里的 ISO 时间与系统时钟对一眼，面板显示 MUST 是本地时刻而不是 ISO 原串

## 3. 文档

- [ ] 3.1 README 面板一节补一句「监工这一行会显示最近一次值班」；验证：`openspec validate show-supervisor-activity --strict` 通过，且这一节读完能知道该看哪里
