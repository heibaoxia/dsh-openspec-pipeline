# Tasks

## 1. 失败收敛成一个出口

- [x] 1.1 新增 `failNode(root, state, node, reason, options)`：记状态、落盘、推一次面板刷新、投值班单，四件事一起做；把现有五条失败出口（拉不起会话、会话没挂上、第一句话没送进去、没等到收尾、`reason` 不是 `completed`）全部改成调它。验证：`node test/fail-notify.mjs` 通过，五条出口各投出一张单子
- [x] 1.2 值班单正文补「失败原因原文」「它最后说的话」「建议用 revive / peek 处理」三行。验证：`node test/fail-notify.mjs` 断言单子正文含原因与最后一段话
- [x] 1.3 值班监工的口径（`supervisorPrompt`）补第三个出手时机，以及 `revive` / `peek` 两个可用动作和它们的适用场景。验证：`node test/fail-notify.mjs` 断言口径正文里能读到 `revive` 与 `peek`
- [x] 1.4 README「值班监工」一节补第三个出手时机与两种救法。验证：README 里能查到「失败」这个时机，且与工具 description 口径一致

## 2. 卡住判定

- [x] 2.1 `waitForTurnEnd` 增加进展时间戳，超过阈值没有任何新事件时返回「卡住」，由调用方取消那一轮、走 `failNode`、收工。验证：`node test/stall.mjs` 通过，断言这一轮被取消、节点记失败、监工收到单子
- [x] 2.2 阈值默认 15 分钟，`DSH_OPENSPEC_STALL_MS` 可覆盖，设 0 关闭；`MUST NOT` 因为没动静取消任何一轮。验证：`node test/stall.mjs` 里「阈值为 0 时一直等」「持续有事件的 40 分钟长任务不判定卡住」两条断言通过
- [x] 2.3 卡住产生的单子里写明「多久没有动静」，并提示「可能只是慢，先 `peek` 看一眼」。验证：`node test/stall.mjs` 断言单子正文含时长
- [x] 2.4 README 补阈值这个环境变量与关掉它的方法。验证：README 里能查到 `DSH_OPENSPEC_STALL_MS`

## 3. 救活一格：revive 与 peek

- [x] 3.1 `PipelineRunner` 增加 `attach` 模式：不新建会话，用 `node.sessionId`，先记 `from = session.seq` 再把监工的话投进去，之后照常等收尾、看归档、记完成、往下跑（`from` 池只覆盖这一格和下游）。验证：`node test/revive.mjs` 通过，断言原对话收到那段指导、会话总数没有增加
- [x] 3.2 `revive` 的三条拒绝路径：没有原对话且没带 `fresh`、仓库已有 runner 在跑、那一轮还没结束且没要求取消；三条各回一句能照着做的人话。验证：`node test/revive.mjs` 三条拒绝断言通过
- [x] 3.3 `fresh: true` 复用 `start-node`：新建会话，第一句话是 `执行 <change> Change` 加节点提示词加监工指导，`sessionId` 被覆盖、老对话不再收到任何话。验证：`node test/revive.mjs` 断言新会话那句完整提示、且老会话零投递
- [x] 3.4 `peek` 只读：返回最后一段内容 + 这一轮有没有出错，默认上限 2000 字；读不到时明说读不到，不返回空串。验证：`node test/revive.mjs` 里 peek 两条断言通过，且被 peek 的会话没有收到新消息
- [x] 3.5 把 `revive` / `peek` / `start-node` 加进工具的动作枚举与说明，补 HTTP 入口。验证：`node test/supervisor.mjs` 通过，且工具 schema 里能读到这三个动作名
- [x] 3.6 面板上失败的那个格子给出可操作提示（原对话救 / 换新对话救 的代价差别）。验证：面板上手点一个失败格子能看到提示，且文字与 `revive` 返回值口径一致
- [x] 3.7 README 动作表补 `revive`（含 `fresh`）/ `peek` / `start-node`。验证：README 动作表里能查到这三项

## 4. 监工留痕与待办重投

- [x] 4.1 `notifySupervisor` 里「读不到会话」「宿主没有投递能力」两个静默返回改成写 `supervisor.lastError` 并推一次刷新；投递成功仍清空。验证：`node test/supervisor.mjs` 新增断言通过
- [x] 4.2 `supervisor.pending` 待办队列：失败时记一条，投出去后确认监工那一轮有没有正常收尾，没收尾就留着；同一个待办两次尝试至少隔 5 分钟；这一格不再是失败状态时清除；救过多次时单子写明次数。验证：`node test/pending-failure.mjs` 通过（不重投、按节奏补投、处理后清除三种情况）
- [x] 4.3 `normalizeSupervisor` 补 `pending` 默认值并确认旧 `pipeline.json` 能直接读。验证：用仓库里现有的 `openspec/pipeline.json` 跑一次 `node test/supervisor.mjs`，不报字段缺失
- [x] 4.4 面板监工那一行：`lastError` 非空时用错误色显示原因原文（已有）之外，补上「待处理失败 N 件」。验证：面板上能看到计数，且与 `pipeline.json` 里的 `pending` 一致
- [x] 4.5 README 补 `lastError` 与 `pending` 的口径。验证：README 里能查到这两个字段名

## 5. 集成检查

- [x] 5.1 全量跑一遍离线回归（`test/*.mjs`），确认没有把既有行为弄坏。验证：所有脚本都以 0 退出、无 `FAIL` 行
- [x] 5.2 `openspec validate supervisor-handles-failed-node --strict` 通过。验证：命令退出码 0
- [x] 5.3 版本号 0.18.0 → 0.19.0，提交信息 `feat: 监工能救活失败的格子（0.19.0）`。验证：`package.json` 的 version 与 `git log -1` 一致
