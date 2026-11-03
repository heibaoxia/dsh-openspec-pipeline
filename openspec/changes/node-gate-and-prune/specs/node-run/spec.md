# node-run

## MODIFIED Requirements

### Requirement: 一个节点一个新顶层对话

点「开始」或右键「启动」时，插件 MUST 先确认这一格达到了执行标准；达到时才通过宿主的 `sessionController` 新建一个顶层普通会话并挂到该工作区，然后投递第一句话。没达到标准时 MUST NOT 新建会话，整批开跑的路上把它记成「等你」（见「不够格的格子记等你并自动放行」），手动「启动」直接拒绝并说明原因。MUST NOT 使用只能挂在父对话下的隐形子会话。

第一句话 MUST 是 `执行 <change> Change`；节点写了附加提示词时，MUST 在这句后面空一行再接提示词原文。

#### Scenario: 没有附加提示词

- **WHEN** 节点的附加提示词为空时开跑
- **THEN** 对话收到的第一句话 MUST 恰好是 `执行 <change> Change`

#### Scenario: 有附加提示词

- **WHEN** 节点写了「只做任务 1 到 3；做完跑 pnpm test；全过了再归档」
- **THEN** 对话收到的内容 MUST 是 `执行 <change> Change`、一个空行、再是这段提示词

#### Scenario: 没写好的格子不建会话

- **WHEN** 一个节点对应的 change 还没有 `tasks.md`，这一批正好轮到它
- **THEN** 插件 MUST NOT 为它新建会话，MUST 把它记成「等你」并写明「还没有任务清单」

## ADDED Requirements

### Requirement: 执行标准

一个节点 MUST 在以下三条同时成立时才算「达到执行标准」：`openspec/changes/<change>/` 目录还在；那个目录里有 `tasks.md` 且至少有一条任务；`openspec status` 读到的规划状态是 `isPlanningComplete` 为真。

第三条 MUST 允许降级：`openspec` 命令不可用、执行失败、或者输出里没有这一项时，插件 MUST NOT 因此判定这一格不够格，只看前两条。

#### Scenario: 没有任务清单

- **WHEN** 一个 change 只有 `proposal.md`，没有 `tasks.md`
- **THEN** 这一格 MUST 判成没达到执行标准

#### Scenario: 规划没写完

- **WHEN** change 有 `tasks.md`，但 `openspec status` 显示 `isPlanningComplete` 为假（还差 `design`）
- **THEN** 这一格 MUST 判成没达到执行标准

#### Scenario: 读不到 CLI

- **WHEN** 这台机器上没有 `openspec` 命令，而 change 目录里 `tasks.md` 有一项任务
- **THEN** 这一格 MUST 判成达到执行标准，MUST NOT 因为读不到规划状态被拦下

### Requirement: 不够格的格子记等你并自动放行

整批开跑时，前置都满足但没达到执行标准的格子 MUST 记成「等你」，说明里 MUST 写清差什么（还差哪几件产物，或者还没有任务清单）。

这一轮 MUST NOT 因为只在等这些格子就收工：MUST 持续重读它们的仓库状态，格子一达到执行标准就把状态放回「待跑」并接着跑，不需要人再点「开始」；MUST 在写完之后十秒内自动接着跑。

等待期间 MUST 处理两种变化：change 进了 `archive/` 时 MUST 按已归档处理、补记「完成」并放行下游；change 在 `changes/` 和 `archive/` 里都找不到时 MUST 记「失败」并写明。

#### Scenario: 写完提案后自动接着跑

- **WHEN** 某一格记着「等你 · 还没有任务清单」，之后有人补上了 `tasks.md`
- **THEN** 这一格 MUST 在十秒内变回「待跑」并开跑，用户不用再点「开始」

#### Scenario: 等待中被归档

- **WHEN** 某一格还在等写好，它的 change 被人归档了
- **THEN** 这一格 MUST 记「完成」，下游 MUST 接着跑，MUST NOT 为它新建会话

#### Scenario: 不想等了

- **WHEN** 格子还在等写好，用户点了「停止」
- **THEN** 这一轮 MUST 收工，格子 MUST 保持「等你」，下次点「开始」MUST 重新按执行标准判

### Requirement: 手动启动也按执行标准

右键「启动」一格时，这一格没达到执行标准 MUST 被拒绝，并把差什么写在按钮下面；MUST NOT 新建会话，也 MUST NOT 起一条只会空等的流水线。

#### Scenario: 启动一个还没写好的格子

- **WHEN** 用户右键一个没有 `tasks.md` 的格子点「启动」
- **THEN** 插件 MUST 拒绝，并说明这一格还没有任务清单
