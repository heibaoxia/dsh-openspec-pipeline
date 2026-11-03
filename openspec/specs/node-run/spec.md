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

### Requirement: 失败必须报给监工

runner 在这一轮的五个失败出口 MUST 各投一张值班单给监工：拉不起会话或这个模型用不了、工作会话没挂到宿主的 sessions 上、第一句话没送进去、没等到这一轮收尾、这一轮不是正常收尾（`reason` 不是 `completed`）。

值班单 MUST 带上：失败的原因原文、这一格最后说的那段话（读不到时明说读不到）、以及图当时的样子。没开监工时 MUST NOT 因此改变失败判定 —— 失败就是失败，只是这次没人替它出手。

#### Scenario: 对话以错误收尾

- **WHEN** 某一轮的 `turn/end` 给出的原因不是 `completed`（例如网络中断）
- **THEN** 监工 MUST 收到一张值班单，写明这一格、原因原文和它最后说的话

#### Scenario: 话没送进去

- **WHEN** 投递第一句话时宿主报错
- **THEN** 这一格 MUST 记为失败，监工 MUST 收到同一类值班单

#### Scenario: 没开监工

- **WHEN** 监工没开，某一格失败
- **THEN** 这一格 MUST 照常记为失败，MUST NOT 因为没人接单而改成「等你」或自动重试

### Requirement: 长时间没有动静算失败

一轮对话连续 15 分钟没有任何新事件时，插件 MUST 判定它卡住了：取消那一轮、把这一格记为失败并写明「多久没有动静」，投一张值班单，然后让这一轮收工。

判定阈值 MUST 可配置，默认 15 分钟，MUST NOT 小于 10 分钟；设成 0 MUST 关闭这条判定。同一轮里只要还有新事件（哪怕还没收尾），MUST NOT 判定卡住。

#### Scenario: 挂住不动

- **WHEN** 某一格进入「跑着」之后连续 15 分钟没有产生任何新事件
- **THEN** 插件 MUST 取消那一轮、把它记为失败，并让监工收到值班单

#### Scenario: 长任务但一直有动静

- **WHEN** 某一轮跑了 40 分钟，中间一直在产生新事件
- **THEN** 插件 MUST NOT 判定它卡住

#### Scenario: 关掉这条判定

- **WHEN** 阈值被设为 0
- **THEN** 插件 MUST NOT 因为「没有动静」取消任何一轮

### Requirement: 救活一格失败

`revive` MUST 接受一个节点和一段指导文本，默认在这一格**原来的对话**里接着说，然后把这一格放回「跑着」，只接着跑它和它的下游。

`fresh` 为真时，插件 MUST 换一个新对话：第一句话仍以 `执行 <change> Change` 开头，后面接节点自己的附加提示词、再接监工给的指导。原来的对话 MUST 就此不再收到任何话，MUST NOT 再等它收尾。

以下情况 MUST 拒绝并把原因写清楚：这一格没有原对话（且没要求 `fresh`）；这个仓库还有别的流水线在跑；这一轮其实还没结束（且没要求取消）。

`revive` MUST 立刻返回，MUST NOT 等到这一格跑完；返回值 MUST 说明用的是原对话还是新对话，以及 `fresh` 会让这一格从头做。

#### Scenario: 在原对话里接着做

- **WHEN** 监工对一个失败的格子调用 `revive` 并给了一段指导
- **THEN** 那段指导 MUST 出现在这一格原来的对话里，这一格 MUST 回到「跑着」，MUST NOT 新建对话

#### Scenario: 换新对话

- **WHEN** 监工带 `fresh` 调用 `revive`
- **THEN** 插件 MUST 新建一个对话，第一句话是 `执行 <change> Change` 加两段提示，原来的对话 MUST 不再收到任何话

#### Scenario: 原对话不在了

- **WHEN** 那一格的对话已经被删掉、或者宿主重启后读不到，而监工没带 `fresh`
- **THEN** MUST 拒绝，并说明只能换新对话重做

#### Scenario: 已经有流水线在跑

- **WHEN** 这个仓库还有一条流水线在跑
- **THEN** MUST 拒绝，并说明先等它收尾或者停止

#### Scenario: 那一轮还没结束

- **WHEN** 那一格这一轮还在进行，而监工没要求取消
- **THEN** MUST 拒绝，并说明这一轮还没结束

### Requirement: 只看不说话

`peek` MUST 返回指定格子对话的最后一段内容、以及这一轮有没有出错，MUST NOT 往那个对话里发送任何内容。返回内容 MUST 有长度上限，默认不超过 2000 字。

这一格的对话读不到时 MUST 明说读不到，MUST NOT 返回空串冒充「没有异常」。

#### Scenario: 读一段内容

- **WHEN** 监工对一个正在等归档的格子调用 `peek`
- **THEN** 它 MUST 拿到那段内容和这一轮有没有出错，那个对话 MUST 没有收到任何新消息

#### Scenario: 对话不在

- **WHEN** 那一格的对话已经读不到
- **THEN** MUST 明说读不到，MUST NOT 返回空串
