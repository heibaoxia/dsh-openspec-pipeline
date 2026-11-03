# pipeline-graph

## ADDED Requirements

### Requirement: 一键清理不可执行的格子

图里存在「已归档」或「仓库里已经找不到」的格子时，面板 MUST 提供一键清理入口，并在回报里写清删掉了哪几格、分别是什么原因。

可清理的范围 MUST 只有这两类：change 已经进了 `openspec/changes/archive/`；或者 `changes/` 和 `archive/` 里都找不到。正在跑、停在「等你」、还没写好、以及任务全勾了只差归档的格子 MUST NOT 被清理。

清理 MUST 删掉这些节点，并把其它节点指向它们的依赖一并摘掉；MUST 和其它画布改动一样立即落盘。MUST 在流水线运行中允许清理；正在跑的格子 MUST NOT 被删掉。

#### Scenario: 清掉跑完的批次

- **WHEN** 图里 N2、N5 对应的 change 已经归档，N8 还在待跑，N8 等 N5
- **THEN** 点一下清理 MUST 删掉 N2、N5，并摘掉 N8 对 N5 的等待；N8 MUST 保留

#### Scenario: 只差归档的格子不清

- **WHEN** 图里有一格任务全勾了、change 还在 `changes/` 里没归档
- **THEN** 它 MUST NOT 出现在清理范围里

#### Scenario: 跑着的时候清理

- **WHEN** 流水线正在跑 N8，图里还有三格已归档
- **THEN** 清理 MUST 只删那三格，N8 MUST 保持「跑着」和它的 `sessionId`
