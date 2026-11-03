# supervisor

## ADDED Requirements

### Requirement: 某一格失败了也要投单

除了原有的两种时机，某一格以异常收尾、或者被判定卡住时，插件 MUST 也投一张值班单。

单子里 MUST 写清：是哪一格、失败原因原文、它最后说的话、图当时的样子，以及可以用 `revive`（原对话接着做 / 换新对话重做）、`peek`（只看不说话）、`run`（整批重跑）来处理。

#### Scenario: 网络中断收尾

- **WHEN** 某一格的对话以错误收尾，插件把它记为失败
- **THEN** 监工 MUST 收到值班单，里面能读到失败原因和这一格的名字

#### Scenario: 卡住被取消

- **WHEN** 某一格连续 15 分钟没有动静，被取消并记为失败
- **THEN** 监工 MUST 收到值班单，里面写明它多久没有动静

#### Scenario: 没开监工

- **WHEN** 监工没开，某一格失败
- **THEN** 插件 MUST NOT 投单，也 MUST NOT 因为没投成而改变这一格的状态

### Requirement: 监工不在也要留痕

投递值班单时如果读不到监工的对话、宿主没有投递能力、或者投递本身报错，插件 MUST 把原因写进 `supervisor.lastError` 并推送一次状态刷新，MUST NOT 静默返回。下一次投递成功时 MUST 把 `lastError` 清空。

#### Scenario: 暂时读不到值班对话

- **WHEN** `supervisor.sessionId` 指向的对话这一刻读不到（被删，或者宿主还在启动）
- **THEN** `supervisor.lastError` MUST 出现「读不到值班对话」这类原因，面板 MUST 用错误色显示

#### Scenario: 之后恢复正常

- **WHEN** 值班对话又能读到了，下一次投递成功
- **THEN** `supervisor.lastError` MUST 变回空串

### Requirement: 没处理掉的失败不许丢

某一格失败后，插件 MUST 在状态里记下这件待处理的事。投出去之后 MUST 确认监工那一轮有没有正常收尾；没收尾（例如网络还没回来）MUST 留着，下一次投递时再带上，直到这一格不再是失败状态。

MUST NOT 因为「投出去过」就当它已经处理完了。

#### Scenario: 网络还没回来

- **WHEN** 失败单投出去之后，监工那一轮也因为没网没有跑完
- **THEN** 这件待处理的事 MUST 留在状态里，下一次有机会时 MUST 再投一次

#### Scenario: 处理完了

- **WHEN** 监工用 `revive` 把这一格救回来，它不再是失败状态
- **THEN** 这件待处理的事 MUST 被清掉，MUST NOT 再重复投递

#### Scenario: 一直没人处理

- **WHEN** 同一格反复失败、监工也反复救不回来
- **THEN** 值班单里 MUST 写明已经救过几次，并提示该由人来看
