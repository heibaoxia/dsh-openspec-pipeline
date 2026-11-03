# workspace-scope

## Purpose

一个面板只看一个工作区，多个面板和多个工作区可以同时各跑各的流水线。切换面板或工作区不会打断正在跑的那一条。

## ADDED Requirements

### Requirement: 工作区按面板算

每个面板 MUST 记录自己选中的仓库，并且每次请求都带上它；切到 B MUST NOT 停止 A 的 runner，切回 A MUST 看到 A 当前的进度。

#### Scenario: A 在跑时切到 B

- **WHEN** 面板 A 的流水线正在跑，用户把工作区切到 B
- **THEN** A 的 runner MUST 继续跑，B MUST 显示自己的图

### Requirement: 工作区解析顺序

面板打开时 MUST 按这个顺序选工作区：当前对话所在且含 `openspec/` 的仓库；否则上一次打开的仓库（`settings.root`）；再否则走兜底链（上次用过的仓库 → 任一登记过的 OpenSpec 工作区 → 当前目录）。结果来源 MUST 通过 `rootFrom` 回报为 `seat` / `default` / `panel`。

#### Scenario: 当前对话就在目标仓库

- **WHEN** 面板在一个含 `openspec/` 的仓库对话里第一次打开
- **THEN** MUST 选中这个仓库，`rootFrom` MUST 是 `seat`

### Requirement: 只有首次解析和手动切换改写默认

`settings.root` MUST 只在面板第一次解析工作区和用户手动切换工作区时改写；刷新、自动落盘、开跑这些请求 MUST NOT 改写它。

#### Scenario: 刷新面板

- **WHEN** 用户在面板 B 点「刷新」
- **THEN** 上一次打开的工作区 MUST 保持原来的值

### Requirement: 工具的 root 语义

`openspec_pipeline` 工具省略 `root` 时 MUST 用这份默认工作区；带上 `root` 时 MUST 只操作那一个仓库，且 MUST NOT 打断别的工作区里正在跑的流水线。

#### Scenario: 指定另一个仓库

- **WHEN** 面板 A 在跑，Agent 带 `root` 调工具查 B
- **THEN** 查询 MUST 只落在 B，A 的状态 MUST 不受影响

### Requirement: 自动登记工作区

选中的仓库还没有登记成工作区时，插件 MUST 自动登记一次，否则新建的会话在侧栏里看不见。

#### Scenario: 没登记过的仓库

- **WHEN** 用户选了一个含 `openspec/` 但没登记过的目录
- **THEN** 插件 MUST 登记它，再开跑

### Requirement: 只接受 OpenSpec 仓库

工作区下拉 MUST 只列真的含 `openspec/` 的目录；没有 `openspec/` 的目录 MUST 被拒绝并说明原因。

#### Scenario: 选错目录

- **WHEN** 用户选了一个没有 `openspec/` 的目录
- **THEN** 面板 MUST 拒绝并提示，不把它当成工作区

### Requirement: 推送按工作区分流

面板的推送 MUST 按工作区分开：A 的格子跑完或归档 MUST 只惊动看 A 的面板，MUST NOT 推给看 B 的连接。

#### Scenario: 两个面板各看一个仓库

- **WHEN** A 的某个 change 归档了
- **THEN** 只有看 A 的面板收到事件，看 B 的面板 MUST 不被惊动
