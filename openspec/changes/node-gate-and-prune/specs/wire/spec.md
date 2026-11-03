# wire

## ADDED Requirements

### Requirement: 已归档的 change 不画回图里

`wire` 点名的 change 只在 `openspec/changes/archive/` 里时，MUST 跳过这一格：不新增节点、不接线、不改任何东西，其余点名的格子照常处理并落盘。回话 MUST 列出跳过了哪些、以及跳过是因为已经归档。

别的格子的上游写成这个已归档的名字时，MUST 把它当成「已经满足」处理——MUST NOT 因为找不到这个上游而整单拒绝，因为那个 change 确实已经完成。

#### Scenario: 一批里混了一个已归档的

- **WHEN** 用户对 A、B、C 三个 change 调 `wire`，其中 B 已经归档
- **THEN** A 和 C MUST 按这次的顺序接好并落盘；回话 MUST 写明 B 已经归档、没有加进来

### Requirement: plan 也校验名字

`plan` 重写整张图时，`nodes` 里出现「`changes/` 和 `archive/` 里都找不到」或者「只在 `archive/` 里」的 change 时 MUST 整单拒绝，一个字节都 MUST NOT 写入，并把有问题的名字原样返回。

#### Scenario: plan 里带了一个已归档的 change

- **WHEN** Agent 调 `plan` 重画整张图，其中一格是已经归档的 change
- **THEN** 插件 MUST 拒绝这次调用，`pipeline.json` MUST 保持原样
