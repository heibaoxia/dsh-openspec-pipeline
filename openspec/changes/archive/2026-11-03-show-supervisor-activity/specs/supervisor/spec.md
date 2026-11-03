# Spec Delta

## ADDED Requirements

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
