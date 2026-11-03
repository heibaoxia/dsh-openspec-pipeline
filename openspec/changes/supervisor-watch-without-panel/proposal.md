# Proposal

## Why

0.16.0 的监工写着「人不在的时候，让整张图跑完」。但现在「归档了、却没人接着跑」这种值班单，靠的是盯 `openspec/changes/` 的归档监听；这份监听是挂在面板的推送连接上的——`/events` 一建立就开始盯，最后一个面板关掉就停。

也就是说：人把面板一关，监工就聋了。它还在线，`enabled` 还是 true，手册也还在，但再没有任何东西会告诉它「有一格归档了、后面那格没起来」。隔夜的无人值守恰好就是整晚不开面板的那种用法，这条链路断在最要它的时候。

（另一种卡法——某一格对话收尾但没归档——由 runner 自己投单，不依赖面板，不在这次范围里。）

## What Changes

- **归档监听 MUST 由宿主自己持有，MUST NOT 以「有没有面板连着」为生死。** 监工开着时，即使一个人都没打开面板，归档发生在 `openspec/changes/` 里也必须能触发值班单。
- **谁需要谁持有。** 面板、runner、监工三方各自登记一份关注；三方都不再需要时才停监听，MUST NOT 因为某一个面板关掉就把监听关掉。
- **宿主重启后能自己接回来。** 重启会丢掉内存里的监听，监工开着的话，下一次读状态、开跑或有人打开面板时 MUST 重新挂上，MUST NOT 需要人再点一次「启用监工」。
- **停用监工要收干净。** 停用后如果既没有 runner 在跑、也没有面板在看，MUST 停掉监听，MUST NOT 留一个没人用的 watcher。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `supervisor`: 值班单的触发 MUST NOT 依赖面板连接；监听生命周期改为由「谁在关注这个仓库」决定。

## Impact

- `lib/index.js`：`watchArchives` / `stopArchiveWatch` 的生命周期与引用计数、`/events` 连接的进出、`supervisor` 开关、`run` 起停、`snapshot` 的懒恢复、dispose。
- `test/supervisor.mjs`：删掉「先打开推送通道」那段准备，断言不打开 SSE 也能收到归档值班单；新增「最后一个面板断开后监听仍在」与「停用监工后监听停掉」两条。
- `README.md`：值班监工一节改掉「面板开着才盯着」的隐含前提。
- 依赖：要求 `fix-supervisor-prompt-signal` 先落地，否则值班单本来就投不出去，测不出这次的变化。
