# pipeline-graph

## ADDED Requirements

### Requirement: 节点位置不受画布边界限制

节点 MUST 能被放到画布上的任意坐标，包括原点左上方的负坐标；插件 MUST NOT 把节点位置夹到非负区间，也 MUST NOT 为平移设边界。

节点的位置照常写进 `pipeline.json`，负数与其他值一视同仁。

#### Scenario: 拖到原点左上方

- **WHEN** 用户把一个节点往左上方拖过原点
- **THEN** 节点 MUST 停在指针所在的位置，坐标 MUST 允许是负数

#### Scenario: 负数坐标存盘再打开

- **WHEN** 一个节点的坐标是负数，用户刷新面板
- **THEN** 它 MUST 还在同一个位置，MUST NOT 被挪回原点
