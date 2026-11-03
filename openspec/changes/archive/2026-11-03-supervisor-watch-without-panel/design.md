# Design

## Context

`archiveWatches` 是一张 `runnerKey -> { watchers, timer, seen }` 的表，现在只有两个入口会往里放东西：面板的 `/events` 连接建立时（`openEventStream` → `watchArchives`），以及开跑时「如果已经有面板连着」再补一次。删除只有一个入口：同一工作区最后一个面板断开（`close` → `stopArchiveWatch`）。插件卸载时统一停。

`reportArchives` 自己还有两个前置：必须存在监听，且当时没有 runner 在跑（有 runner 时它自己会推进，不需要打扰监工）。

## Goals / Non-Goals

**Goals:**

- 把「有没有人看面板」从监工能否收单的条件里拿掉。
- 监听的生命周期可解释：谁需要谁持有，没人需要就停。

**Non-Goals:**

- 不改值班单的判定逻辑（什么时候该投、投什么内容）。
- 不做跨进程的持久化监听——宿主重启后靠下一次访问懒恢复，不追求「重启瞬间自动接上」。
- 不改 runner 自己的归档轮询。

## Decisions

### 用持有者集合，不用「常驻」

把 `watchArchives` 改成按持有者登记：`Map<runnerKey, { holders: Set<'panel'|'supervisor'>, watchers, timer, seen }>`。`watchArchives(root, holder)` 加一份，`releaseArchiveWatch(root, holder)` 减一份，集合空了才真正关 watcher。

runner 不占一份：`reportArchives` 见到 runner 在跑就直接返回（runner 自己会推进），那时候 watcher 对它没有用处。面板多个连接也只算一份 `panel`——退的时候按「这个工作区还有没有连接」判断，不是按连接计数。

备选：监工一开就常驻 watcher，谁都不管。放弃的原因是停用监工之后会留下一个没人用的递归 watcher，而「停用」的语义就是不要再为这个仓库付出任何后台动作。

### 懒恢复，不在 apply 时枚举仓库

宿主重启后 `archiveWatches` 是空的。恢复点放在三条常见路径上：`snapshot`（面板刷新和 Agent 读状态都走它）、`run` 启动、`supervisor` 动作。只要该仓库的 `supervisor.enabled` 是真，就顺手 `watchArchives(root, 'supervisor')`。

备选：apply 时枚举 `workspaceRegistry` 里的工作区。放弃的原因是注册表里的工作区不一定都是 OpenSpec 仓库，逐个读 `pipeline.json` 会把插件启动变成 N 次磁盘读，而且这些人可能一整晚都不会碰那些仓库。

### 面板断开只退自己那份

SSE 的 `close` 从「停整个监听」改成「退掉 `panel` 这一份」。同一工作区还有别的面板、或者 runner 在跑、或者监工开着，监听都继续。

## Risks / Trade-offs

- **无人访问就恢复不了** → 这是刻意留的边界：宿主重启后、又没人打开面板也没人调工具时，监听确实不在了。但那种状态下 runner 也不在，本来就没人推进流水线；一次面板打开或一次 `status` 就能补上。
- **递归 watcher 的常驻成本** → 只在「监工开着」这种明确有人要结果的情况下常驻；停用即退。
- **同一仓库多份持有** → 计数按 `runnerKey` 归并，不会出现两份 watcher；漏退一份会让 watcher 活得比预期久，靠 dispose 兜底。
