# pipeline-graph Specification

## Purpose
一张流水线图以目标仓库的 `openspec/pipeline.json` 为唯一事实：哪些 change 参与、谁等谁、每格什么状态。画布上的每次改动都立即落盘，不需要「保存」这一步。

## Requirements

### Requirement: 图持久化为 openspec/pipeline.json

流水线 MUST 把整张图保存在目标仓库的 `openspec/pipeline.json`，至少包含 `version`、`name`、`maxParallel`、`pauseAfterNode`、`defaultProfileId`、`profiles`、`supervisor` 与 `nodes`；每个节点 MUST 记录 `id`、`kind`、`change`、`deps`、位置、四项运行设置、`prompt`、`commit`、`approved`、`status`、`note`、`sessionId`。

#### Scenario: 拖动节点后无需保存

- **WHEN** 用户在画布上拖动一个节点
- **THEN** 位置改动 MUST 在约 350ms 内写入 `pipeline.json`，刷新页面后节点仍在拖到的位置

#### Scenario: 连续拖动合并成一次写盘

- **WHEN** 用户连续拖动同一个节点多次
- **THEN** 这一串拖动 MUST 合并成一次写盘，而不是每动一下就写一次

### Requirement: 写盘失败不丢画布

写入 `pipeline.json` 失败时，插件 MUST 保留画布上的改动、在面板写明原因、自动重试三次，并提供「现在再存一次」和「以磁盘为准」两个出口；开跑、归档、切换工作区之前 MUST 先等这一轮写盘完成。

#### Scenario: 磁盘写不进去

- **WHEN** 写盘失败，用户直接点「开始」
- **THEN** 插件 MUST 停下并说明原因，MUST NOT 拿一张没落盘的图去跑

### Requirement: 开工节点是唯一入口

图 MUST 始终包含一个 `id` 为 `start`、`kind` 为 `start` 的「开工」节点，它的状态恒为「完成」；只有从它经依赖可达的节点才会被执行，没有接线的节点 MUST 只摆在画布上。

#### Scenario: 孤立节点不开跑

- **WHEN** 用户把一个 change 加进图但没有接到「开工」
- **THEN** 点「开始」时这一格 MUST 保持「待跑」，不新建对话

### Requirement: 依赖全部满足才够格

一个节点 MUST 在它的每一个前置都处于「完成」后才够格开跑；有多个前置时，任何一条分支没完成都 MUST 阻止它启动。手动「启动」是唯一例外：前置已完成，或者前置对应的 change 已经进 `archive/`，都算放行。

#### Scenario: 分支合并

- **WHEN** 一个节点有两个前置，其中一个还在跑或挂在「等你」
- **THEN** 合并节点 MUST 不动，两个前置都「完成」之后才开跑

#### Scenario: 手动启动遇到已归档的前置

- **WHEN** 用户右键一个节点点「启动」，而它的前置 change 已经归档
- **THEN** 这一格 MUST 直接开跑，不必等上游那一轮收尾

### Requirement: 状态由 Host 写入

节点的对外状态 MUST 取「待跑」「跑着」「完成」「等你」「失败」五种，由 Host 写入 `pipeline.json`；面板 MUST NOT 自己编造状态。文件里遗留的 `skipped` MUST 按「跳过」呈现并当作终态；0.7 遗留的 `verifying` / `archiving` MUST 按「失败」处理。

#### Scenario: 旧文件里的遗留状态

- **WHEN** `pipeline.json` 里某节点的状态是 `verifying` 或 `archiving`
- **THEN** 面板 MUST 显示「失败」，点「开始」可以把它放回「待跑」

### Requirement: 运行中改图只影响未开工的格子

流水线运行期间，连线、断开、位置、设置、增删 MUST 只作用于还没开工的格子；正在跑和已经跑完的格子 MUST 保留 Host 上的状态、开工时间与 `sessionId`。断开 MUST 当场落盘，并在下一轮调度立刻生效。

#### Scenario: 跑一半断开下游

- **WHEN** N2 正在跑时用户把 N3 从 N1 → N2 → N3 的链上断开
- **THEN** N2 收尾后 N3 MUST NOT 被拉起，刷新之后断开仍然有效

### Requirement: 上次中断的格子记为失败

Host 启动时 MUST 把文件里仍为 `running` 的节点改记为「失败」并注明「上次运行中断」；但同一个进程里正在运行的 runner 读这个文件时 MUST NOT 做这种改写。

#### Scenario: 进程被杀后重开

- **WHEN** 流水线跑到一半 Host 被关掉，之后重新打开面板
- **THEN** 那一格 MUST 显示「失败」并带中断说明，而不是永远停在「跑着」

### Requirement: 跑完当前这一格就停

图 MUST 支持 `pauseAfterNode` 开关：打开后，当前一轮收尾且手上没有别的格子时 runner MUST 收工，不再拉起下游；运行中打开 MUST 立即生效。

#### Scenario: 运行中勾上开关

- **WHEN** 用户在运行中勾上「跑完当前这一格就停」
- **THEN** 当前格完成后 MUST 停下，下游保持「待跑」

### Requirement: 默认组合随仓库走

图 MUST 在 `profiles` 里保存设置组合、用 `defaultProfileId` 指向默认组合；`defaultProfileId` 指向不存在的组合时 MUST 视为未设置；组合被删除时默认 MUST 一并清空。

#### Scenario: 删掉默认组合

- **WHEN** 用户删除了当前的默认组合
- **THEN** `defaultProfileId` MUST 变空，新加节点不再播种这套设置

### Requirement: 节点位置不受画布边界限制

节点 MUST 能被放到画布上的任意坐标，包括原点左上方的负坐标；插件 MUST NOT 把节点位置夹到非负区间，也 MUST NOT 为平移设边界。

节点的位置照常写进 `pipeline.json`，负数与其他值一视同仁。

#### Scenario: 拖到原点左上方

- **WHEN** 用户把一个节点往左上方拖过原点
- **THEN** 节点 MUST 停在指针所在的位置，坐标 MUST 允许是负数

#### Scenario: 负数坐标存盘再打开

- **WHEN** 一个节点的坐标是负数，用户刷新面板
- **THEN** 它 MUST 还在同一个位置，MUST NOT 被挪回原点

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
