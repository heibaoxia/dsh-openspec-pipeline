# Design

## Context

基线来自 README（0.16.1，779 行）和 `lib/index.js` / `lib/client.js` 的现状。这次没有代码改动，所以设计只剩两个问题：能力怎么切，每条 requirement 写到什么粒度。

约束：规格是行为契约，不是产品手册；内部实现（函数名、路由路径、SSE 载荷、日志格式）不进去。

## Goals / Non-Goals

**Goals:**

- 用 5 个能力覆盖「一张图怎么跑完」的完整链路，名字稳定、边界不重叠；
- 每条 requirement 都能被现有 `test/*.mjs` 或 README 里的行为描述验证；
- 后续新增行为能明确落到某个能力的 `MODIFIED` 上，而不是再造一个能力。

**Non-Goals:**

- 不覆盖 UI 细节：缩放、拖拽手感、文案、列表标记的样式；
- 不描述 0.16 之前已经删掉的行为（子会话、`settle`、验收方式）；
- 不在这次给「值班监工」立能力：它留在下一次 change 里单独写，避免第一张规格表就摊得太宽。

## Decisions

### 按「一条流水线怎么走完」切，而不是按文件切

`lib/index.js` 一个文件里混着调度、归档、提交、工作区，按文件切会得到三个重叠的能力。按职责切：图与调度（`pipeline-graph`）、一次执行（`node-run`）、完成判据（`archive-gate`）、批量画图（`wire`）、多仓库隔离（`workspace-scope`）。

### 规格写现状，不写目标

baseline 最怕写成愿望清单。每条 requirement 都对照 README 的行为描述和对应测试；拿不准的就不写，留给以后补。

### 归档门禁与归档后提交分成两处

门禁回答「算不算完成」，只看 `archive/` 目录；提交是门禁放行之后的收尾动作，失败只会挂「等你」，不会把已归档的 change 打回 `changes/`。失败语义不同，所以提交写进 `node-run`，门禁留在 `archive-gate`。

### 默认组合放 `node-run`，图里只留字段

`profiles` 和 `defaultProfileId` 存在 `pipeline.json` 里，但它们的意义是「这一轮用什么设置跑」，所以行为写进 `node-run`；`pipeline-graph` 只声明这两个字段属于图。

### requirement 用 MUST，中文正文保留英文关键词

`openspec validate --strict` 按 `\b(SHALL|MUST)\b` 判规范性，中文里写「必须」过不了。统一写「MUST」，句子保持中文。

## Risks / Trade-offs

- **规格与代码漂移**：基线是 0.16.1 的快照。后续改动必须在同一个 change 里更新规格，否则一年后规格会变成历史文档。
- **粒度偏粗**：列表标记、红灯、SSE 只写了判据和分流，没写界面呈现。发现不够时用 `MODIFIED` 补，不改这次的结构。
- **5 个能力可能不够**：监工、安装/兼容、离线回归都没有独立能力。加新能力是便宜操作，硬塞进现有能力才是债。
