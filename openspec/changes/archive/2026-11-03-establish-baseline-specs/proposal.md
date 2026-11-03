# Proposal

## Why

仓库在 0.11 → 0.16 的三天里发了六个版本，但 `openspec/specs/` 一直是空的。归档门禁、断线重连、`wire` 的接线语义这些行为契约，只存在于 52KB 的 README 和 `test/*.mjs` 里，没有任何可被 `explore` / `propose` 引用的「现状」。

后果是具体的：

- 新 change 没有既有能力可对齐，每个都从 `ADDED` 起步，能力名和边界只能临时发明；
- `explore` 讨论时拿不到「今天承诺了什么」，只能从实现反推，容易把已有行为当成新需求；
- 归档时每个新能力各写各的 `Purpose`，时间一长就会出现几张描述重叠行为的规格。

这次只做一件事：把 0.16.1 已经发布的行为固化成 5 个能力的主规格，作为后续改动的基线。

## What Changes

纯基线变更，不改代码、不改行为、不改 API：

- 新增 5 个能力的 delta 规格（`ADDED Requirements`），覆盖图与调度、节点执行、归档门禁、`wire`、工作区隔离；
- 归档后由 `openspec archive` 合并成 `openspec/specs/<能力>/spec.md`，以后的行为改动从 `ADDED` 转为 `MODIFIED`；
- 每条 requirement 描述的是 0.16.1 的现状，不是目标态。发现规格与实现不一致时，先改规格再改代码。

不在这次范围里：补全所有历史行为、写设计文档、改 README、动 `lib/` 或 `test/`。

## Capabilities

### New Capabilities

- `pipeline-graph`: 一张流水线图以 `openspec/pipeline.json` 为准：开工节点、依赖与够格判定、节点状态、运行中改图、恢复与暂停开关。
- `node-run`: 每个节点在新顶层对话里执行一个 change：提示词拼接、并行上限、设置来源、停止、归档后提交、失败回收。
- `archive-gate`: 判定「这一格算完成」的唯一附加条件是 change 进了 `archive/`：等待、自动续跑、先验后归的归档按钮。
- `wire`: Agent 的画图入口：三种接线写法、只动点名的格子、已有线默认不动、坏图整单拒绝、`dryRun`。
- `workspace-scope`: 一个面板一个工作区：解析顺序、`settings.root` 的改写时机、多工作区并行、推送分流。

### Modified Capabilities

无。

## Impact

- 归档后新增 `openspec/specs/pipeline-graph/spec.md`、`node-run`、`archive-gate`、`wire`、`workspace-scope` 五个目录；
- 不改 `lib/`、`test/`、`package.json`、README；
- 后续 change 引用这些能力时用 `MODIFIED Requirements`，不再新建同名能力。
