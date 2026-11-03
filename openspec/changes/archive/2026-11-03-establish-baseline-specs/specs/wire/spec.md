# wire

## Purpose

`wire` 是给 Agent 的画图入口：一次调用把一批 change 的先后顺序写成图。它只加不删、只动点名的格子，并且可以先用 `dryRun` 算一遍再落笔。

## ADDED Requirements

### Requirement: 三种写法互斥

`wire` MUST 只接受 `order`（串行）、`stages`（串并）、`steps`（任意依赖）中的一种；同时给出多种时 MUST 整单拒绝并说明这次给了几个。上游一律写 change 名，MUST NOT 要求调用方提供节点 id。

#### Scenario: 同时给 order 和 stages

- **WHEN** 一次调用同时带 `order` 和 `stages`
- **THEN** 插件 MUST 拒绝这次调用，且一个字节都 MUST NOT 写入

### Requirement: 只动点名的格子

`wire` MUST NOT 删除节点，MUST NOT 修改这次没有点名的格子。图里没有的 change MUST 新增为「待跑」节点；图里已有且还在待跑的节点 MUST 按这次的接线处理；正在跑或已经跑完的节点，线和设置 MUST 都不动。

#### Scenario: 点名之外的格子

- **WHEN** 图里有 A、B、C 三格，用户只对 A 和 B 调 `wire`
- **THEN** C 的线、设置和状态 MUST 原样保留

### Requirement: 已有线默认不动

`rewire` 默认是 `false`：MUST NOT 把用户手工断开过的线悄悄接回去。只有显式传 `rewire: true` 才重排，并且跑完的、正在跑的格子仍然 MUST NOT 动。没重排时，回话 MUST 如实写出「已有线没动，要重排加 rewire」。

#### Scenario: 再次画图不复活断开

- **WHEN** 用户把 N8 从链上断开，之后 Agent 又用同一个 `order` 调 `wire`
- **THEN** N8 MUST 保持断开，回话 MUST 说明已有线没动

### Requirement: 坏图整单拒绝

以下三种情况 MUST 什么都不写、把问题原样返回：名字在 `openspec/changes/` 和 `archive/` 里都找不到；接线成环；同时给了两种以上写法。

#### Scenario: 成环

- **WHEN** 接线会出现 `a → b → a`
- **THEN** 插件 MUST 报出环的路径并拒绝整单，图 MUST 保持原样

### Requirement: settings 只认六项

`settings` MUST 只识别 `prompt`、`preset`、`provider`、`model`、`effort`、`commit` 六项，没写的项 MUST NOT 改动。已经跑完或正在跑的格子，设置 MUST NOT 被改。新加的格子 MUST 从默认组合播种。

#### Scenario: 只给提示词

- **WHEN** `settings` 里某一格只给了 `prompt`
- **THEN** 这一格的模式、运营商、模型、强度 MUST 保持原值

### Requirement: dryRun 只算不写

`dryRun: true` 时 MUST 只计算、不写 `pipeline.json`，回报内容 MUST 与真写一致：新增几格、改几条线、按第几批跑、每格等谁。回话 MUST 说明 `deps` 满足不等于真并行——`maxParallel` 不够时，并列的格子也会一个接一个跑。

#### Scenario: 先算一遍

- **WHEN** 用户带 `dryRun: true` 调 `wire`
- **THEN** 回话 MUST 给出批次和每格等谁，且 `pipeline.json` MUST 不变

### Requirement: 和 plan 分工

`plan` MUST 用于从零重画整张图，运行中 MUST 拒绝；`wire` MUST 用于在现有图上增量补接，运行中 MUST 允许。

#### Scenario: 运行中画图

- **WHEN** 流水线正在跑，Agent 调 `plan`
- **THEN** 插件 MUST 拒绝；改用 `wire` MUST 只影响还没开工的格子
