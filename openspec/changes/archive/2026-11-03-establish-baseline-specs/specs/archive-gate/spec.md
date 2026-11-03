# archive-gate

## Purpose

判定「这一格算完成」的唯一附加条件是 change 真的进了 `archive/`。门禁只查目录事实，不做质量判断，也不要求 tasks 全部勾完。

## ADDED Requirements

### Requirement: 完成需要两条同时成立

一个节点 MUST 在「这一轮正常收尾」并且「`openspec/changes/<x>/` 已经消失、`archive/` 里出现名字为 `<x>` 或以 `-<x>` 结尾的目录」时才记为「完成」。

门禁 MUST 只查目录，MUST NOT 要求 tasks 全部勾完，也 MUST NOT 在判定里运行 `openspec validate`。

#### Scenario: 任务没勾完但已归档

- **WHEN** 对话把 change 归档了，但 `tasks.md` 里还有没勾的项
- **THEN** 这一格 MUST 记「完成」并放行下游

### Requirement: 没归档就等你

这一轮收尾后 change 仍在 `changes/` 时，节点 MUST 记「等你」并写明没归档，下游 MUST NOT 启动。

#### Scenario: 对话干完活没归档

- **WHEN** 一轮正常结束，但 change 的目录还在 `changes/`
- **THEN** 面板 MUST 显示「等你」并写清没归档，后面的格子 MUST 一动不动

### Requirement: 等待不退出，归档后自动继续

挂上「等你」之后 runner MUST NOT 退出，MUST 持续监视 `archive/`；change 一出现，MUST 在一秒内补记「完成」并接着开下一格，不需要用户再点「开始」。

#### Scenario: 手动归档

- **WHEN** 用户在别处手动跑了 `openspec archive <x> -y`
- **THEN** 一秒内这一格 MUST 变成「完成」，下游自动接着跑

### Requirement: 归档按钮先验后归

「归档」按钮 MUST 只在「这一轮已经停下」且「change 还在 `changes/`」时出现。点击之后 MUST 先跑 `openspec validate <change> --strict`：通过才执行 `openspec archive <change> -y`；没通过 MUST 不归档、把问题逐条返回，只有人明确选择「仍然归档」才强制归档，并在节点说明里留下「validate 没过，人选择了仍然归档」。

#### Scenario: 验证没过

- **WHEN** 用户点「归档」，而 `validate --strict` 报了问题
- **THEN** 插件 MUST 只展示问题、不归档，等用户改完再点，或者选择「仍然归档」

#### Scenario: 验证通过

- **WHEN** `validate --strict` 通过
- **THEN** 插件 MUST 直接归档，并在归档后由监视器自动开下一格

### Requirement: 验证只能在归档前做

归档按钮 MUST 在归档之前完成验证，因为 change 一旦进了 `archive/`，`openspec validate` 用老名字或带日期的新名字都只会返回 `Unknown item`。

#### Scenario: 归档之后再验

- **WHEN** change 已经归档，用户再对老名字跑 `openspec validate`
- **THEN** 命令 MUST 返回 `Unknown item`，面板 MUST NOT 提供归档后的补验

### Requirement: 已归档的格子不再开对话

开跑时如果节点对应的 change 已经在 `archive/` 里，插件 MUST 直接把它补记为「完成」，MUST NOT 新建对话。

#### Scenario: 图里留着已归档的格子

- **WHEN** 用户点「开始」，图里有一格对应的 change 已经归档
- **THEN** 这一格 MUST 直接显示「完成」，不出现新对话

### Requirement: 失败不开下游

对话异常中断（abort / error）时，这一格 MUST 记「失败」并保留原因，下游 MUST NOT 启动；点「开始」可以回收重跑。

#### Scenario: 对话崩了

- **WHEN** 一轮以错误收尾
- **THEN** 节点 MUST 标「失败」，后面的格子 MUST 不动
