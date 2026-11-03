# Spec Delta

## ADDED Requirements

### Requirement: 值班单不依赖面板连没连着

监工开着时，归档监听 MUST 由宿主自己持有。没有任何面板连接时，归档 MUST 照常被看见，并 MUST 照常投出值班单；MUST NOT 因为没人看着面板就不投。

#### Scenario: 一个人都没开面板

- **WHEN** 监工开着、某个面板都没连上，而某一格的 change 被移进了 `openspec/changes/archive/`，且当时没有 runner 在跑
- **THEN** 监工对话 MUST 收到这一格的值班单

#### Scenario: 最后一个面板刚断开

- **WHEN** 面板全部断开之后才发生归档
- **THEN** 值班单 MUST 照常投递，MUST NOT 因为连接没了而静默

### Requirement: 谁关注谁持有监听

归档监听 MUST 由关注方共同持有：面板连接、runner、以及开着的监工各自算一份。只有所有关注方都不再需要时，监听才可以停；MUST NOT 因为其中一个面板断开就停掉整个监听。

#### Scenario: 还有一个面板在看

- **WHEN** 同一个仓库有两个面板连着，其中一个关掉了
- **THEN** 归档监听 MUST 继续运行，剩下的那个面板 MUST 继续收到归档事件

#### Scenario: 面板关掉但监工还开着

- **WHEN** 最后一个面板断开，而这个仓库的监工仍然开着、也没有 runner 在跑
- **THEN** 归档监听 MUST 继续运行

### Requirement: 宿主重启后能自己接回来

宿主重启会丢掉监听。监工仍然开着时，接下来任意一次读状态、开跑、或者有人打开面板，MUST 把这个仓库的归档监听重新挂上；MUST NOT 要求人再点一次「启用监工」。

#### Scenario: 重启之后 Agent 读了一次状态

- **WHEN** 宿主重启过、`supervisor.enabled` 仍是 true，Agent 对这个仓库调了一次 `status`
- **THEN** 归档监听 MUST 重新挂上，之后发生的归档 MUST 能触发值班单

### Requirement: 停用监工要收干净

停用监工后，如果这个仓库既没有 runner 在跑、也没有面板连着，归档监听 MUST 停掉，MUST NOT 留下没人用的监听。

#### Scenario: 停用之后没人在看

- **WHEN** 只有监工在关注这个仓库，用户点了「停用」
- **THEN** 归档监听 MUST 停掉；之后再发生归档 MUST NOT 触发值班单
