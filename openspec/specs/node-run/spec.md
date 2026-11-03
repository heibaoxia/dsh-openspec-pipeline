# node-run Specification

## Purpose
每个节点在面板选定的工作区里新建一个顶层普通对话来执行它对应的 change。插件只负责把第一句话和这一轮该用的设置送到，运行结束后再按归档门禁决定这一格是不是完成。

## Requirements

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

### Requirement: 每格独立上下文

每个节点 MUST 使用自己的新会话，节点之间 MUST NOT 共享对话上下文。

#### Scenario: 两个并列节点

- **WHEN** 两个节点同一批开跑
- **THEN** 面板上 MUST 出现两个互不相关的对话，各自的提示词只含自己那个 change

### Requirement: 并行上限

同一轮最多同时执行 `maxParallel` 个节点；`maxParallel` 为 1 时 MUST 严格一个接一个跑。

#### Scenario: 上限为 1

- **WHEN** 图里有两个并列够格的节点，且 `maxParallel` 是 1
- **THEN** 第二个节点 MUST 等第一个收尾之后才开跑

### Requirement: 一个仓库同时只跑一条流水线

同一个仓库 MUST NOT 同时存在两条流水线；已经有 runner 在跑时，再点「开始」或右键「启动」MUST 被拒绝并说明原因。

#### Scenario: 已经有流水线在跑

- **WHEN** 仓库里已经有一条流水线在跑，用户又点「开始」
- **THEN** 插件 MUST 拒绝并提示先等它收尾或点「停止」，MUST NOT 在同一仓库里再起一条

### Requirement: 运行设置的来源

节点的四项运行设置（对话模式、运营商、模型、思考强度）MUST 优先取节点自己的值；四项全为空时才用默认组合的四项。附加提示词 MUST 永远取节点自己的值，默认组合 MUST NOT 覆盖节点上手写的提示词。

#### Scenario: 节点只设了模型

- **WHEN** 节点只选了模型，其余三项为空，而默认组合里三项都有值
- **THEN** 这一轮 MUST 只用节点选的模型，另外三项 MUST NOT 从默认组合补

### Requirement: 新节点播种默认组合

从列表单击、`add-all` 或 `wire` 新加的节点 MUST 自动带上默认组合的四项设置、提示词和「归档后提交」勾选；之后套用组合、用默认、套用到下游或全部时，提示词 MUST 一起换，组合里没写提示词就把节点上的提示词清空。

#### Scenario: 新加节点

- **WHEN** 默认组合里写了「做完就归档」，用户从列表单击一个新 change
- **THEN** 新节点的提示词 MUST 已经是这句，不用再手填

### Requirement: 停止只取消当前一轮

点「停止」MUST 取消当前这一轮，MUST NOT 关闭已经开起来的对话，也 MUST NOT 把失败或等归档的格子改成「完成」。

#### Scenario: 停止之后

- **WHEN** 用户点「停止」
- **THEN** 当前轮 MUST 中止，已经建好的对话 MUST 仍然可以继续聊

### Requirement: 选模型不改全局默认

节点选择模型时，插件 MUST 在同一个设置队列里把宿主的全局默认模型写回原值。

#### Scenario: 跑完流水线再新开对话

- **WHEN** 某个节点选了非默认模型并跑完
- **THEN** 用户新开一个对话时，默认模型 MUST 仍是原来的那个

### Requirement: 归档后自动提交

节点勾了「归档之后自动提交」时，归档门禁放行之后 Host MUST 在该工作区执行一次 `git add -A` 和 `git commit`，提交信息 MUST 是 `openspec: <change>`，正文写 `archive/<带日期的新名字>`。

没有改动可提交 MUST NOT 算失败；提交失败 MUST 把这一格记为「等你」并保留 git 的原话；修好之后点「开始」MUST 只补提交，不新开会话。并行上限大于 1 时，同一个工作区的提交 MUST 串行执行。

#### Scenario: 提交失败

- **WHEN** 工作区不是 git 仓库，或者 `index.lock` 被占用
- **THEN** 这一格 MUST 停在「等你」并显示 git 的原话，下游 MUST 不动

#### Scenario: 修好之后重试

- **WHEN** 提交失败的原因已经修好，用户点「开始」
- **THEN** 插件 MUST 只补一次提交，MUST NOT 重新开对话

### Requirement: 开始会回收失败的格子

点「开始」时 MUST 把上次处于「失败」或「等你」的格子放回「待跑」；「完成」是终态，MUST NOT 自动重跑。

#### Scenario: 失败重跑

- **WHEN** 一个节点上次失败，用户点「开始」
- **THEN** 这一格 MUST 用新对话重跑，而不是永久卡死

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
