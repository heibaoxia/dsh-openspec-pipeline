# supervisor Specification

## Purpose
值班监工是一个常驻的普通对话：没人看着的时候，它按项目手册把停住的那一轮接着跑、把停下来问事的对话回过去。这个能力规定监工与那些对话之间「话必须真的送到」的契约。

## Requirements

### Requirement: 启用监工要建一个值班对话

启用监工时，插件 MUST 在目标工作区新建一个顶层普通会话，把值班口径投进这个会话，并把会话身份记进 `pipeline.json` 的 `supervisor.sessionId`。停用 MUST 只停止自动投递，MUST NOT 删掉那个对话。

#### Scenario: 第一次启用

- **WHEN** 该仓库从来没有开过监工，用户点「启用监工」
- **THEN** 插件 MUST 新建一个会话、把值班口径发进去，并且 `supervisor.sessionId` MUST 记下这个会话

#### Scenario: 停用后再启用

- **WHEN** 监工被停用过、原来的会话还在
- **THEN** 再次启用 MUST 复用原会话，MUST NOT 新建第二个

### Requirement: 口径发不出去时不许丢会话

值班口径投递失败时，插件 MUST 保留已经建好的会话并把它记进状态；下一次启用 MUST 复用这个会话，MUST NOT 再建一个新的。

#### Scenario: 口径投递失败

- **WHEN** 会话建成了，但把值班口径投进去时报错
- **THEN** 插件 MUST 返回失败原因，并且 `supervisor.sessionId` MUST 已经落盘；再次启用 MUST 复用同一个会话

### Requirement: 值班单必须真的送到

监工开着时，插件 MUST 在两种时刻往监工对话投一张值班单：某一格对话收尾了但 change 还没归档，或者上一格已经归档、却没人接着跑。值班单 MUST 带上这个项目的手册原文、触发它的那一格、以及图当时的样子。

#### Scenario: 某一格停住了

- **WHEN** 某一格的对话收尾了，它的 change 还在 `openspec/changes/` 里没归档
- **THEN** 监工对话 MUST 收到一张值班单，内容含手册原文和这一格最后说的那段话

#### Scenario: 归档了没人接着跑

- **WHEN** 某一格的 change 进了 `archive/`，而当时没有 runner 在跑
- **THEN** 监工对话 MUST 收到一张值班单，写明是哪一格、还有哪些格子够格没开跑

### Requirement: 值班单发不出去要留下记录

值班单投递失败时，插件 MUST 把失败原因写进 `supervisor.lastError` 并推送一次状态刷新，MUST NOT 只写进内部诊断日志。成功投递一次之后，`lastError` MUST 回到空。

#### Scenario: 宿主拒绝投递

- **WHEN** 投值班单那一步出错
- **THEN** `supervisor.lastError` MUST 出现这次失败的原因，状态刷新一次之后 MUST 能读到它

#### Scenario: 下一次投递成功

- **WHEN** 上一次投递失败、这一次投递成功
- **THEN** `supervisor.lastError` MUST 变回空串

### Requirement: 给某一格说话

`tell` MUST 把指定文本投进那一格的对话。带了等待时，插件 MUST 等到那一轮收尾并带回它最后那段回复；等待 MUST 有超时，超时后 MUST 返回「话送进去了但没收尾」，MUST NOT 一直挂着。

#### Scenario: 等到了回复

- **WHEN** 监工对 N3 调用 `tell` 并要求等待，N3 这一轮在超时前收尾
- **THEN** 返回内容 MUST 含 N3 最后那段回复文字

#### Scenario: 等到超时

- **WHEN** 等待超过给定的超时时间
- **THEN** 插件 MUST 返回「话送进去了但这一轮没收尾」，MUST NOT 卡住不返回

### Requirement: 三条投递都要能被打断

启用监工、投值班单、`tell` 三条路径的投递 MUST 显式携带取消信号；缺少信号时 MUST 立即失败并返回原因，MUST NOT 静默跳过或让整条支线停摆。

#### Scenario: 宿主在投递时检查取消

- **WHEN** 宿主在投递入口检查取消信号
- **THEN** 三条路径 MUST 都能正常送达，MUST NOT 出现「读不到取消信号」这一类报错

### Requirement: 面板要报最近一次值班

监工开着时，面板 MUST 显示最近一次值班的时间与结论；从来没投过值班单时，MUST 明说「还没出过手」，MUST NOT 用空白或「值班中」代替。

#### Scenario: 出过手

- **WHEN** 监工开着，并且已经投过至少一张值班单
- **THEN** 监工那一行 MUST 显示这张值班单的时间与结论

#### Scenario: 从来没出过手

- **WHEN** 监工刚开，一张值班单都还没投过
- **THEN** 监工那一行 MUST 明说「还没出过手」

### Requirement: 投递失败要一眼认得出来

`supervisor.lastError` 非空时，面板 MUST 用错误色显示这次失败的原因原文，MUST NOT 与正常值班记录共用同一种外观。

#### Scenario: 上一次值班没送出去

- **WHEN** `supervisor.lastError` 里有一条投递失败的原因
- **THEN** 面板 MUST 用错误色显示这条原因，MUST NOT 只显示上一次成功的标题

### Requirement: 时间按本地时间显示

面板 MUST 把状态里的 ISO 时间转成本地时间显示，MUST NOT 直接显示 ISO 原串。

#### Scenario: 显示上次值班时间

- **WHEN** 状态里的时间是 `2026-11-03T06:11:47.227Z`
- **THEN** 面板 MUST 显示同一时刻的本地时间，而不是这个字符串本身
