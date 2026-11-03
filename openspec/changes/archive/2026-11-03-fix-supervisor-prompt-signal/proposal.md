# Proposal

## Why

面板上点「启用监工」现在是直接报错的：`监工没切换成功：Cannot read properties of undefined (reading 'throwIfAborted')`。

根因是宿主的 `sessionController.prompt(request, signal)` 第二个参数必填（实现第一行就是 `signal.throwIfAborted()`），而插件有三处 `prompt` 调用只传了 `request`：启用监工、`tell`、给监工发值班单。只有开跑那条传了信号，所以跑图一直正常，断的全是「监工」这条支线。

后果是三层的：人点不动监工；就算点得动，值班单也发不出去（异常被 catch 吞掉，只在诊断日志留一行，面板上什么也看不见）；每次失败的点击还会先在侧栏建一个会话，然后把 `sessionId` 丢在原地不记进 `pipeline.json`——点几次就有几个孤儿对话。0.16.0 承诺的「人不在的时候让整张图跑完」，现在等于没开。

## What Changes

- **三条投递路径都真的能送达。** 启用监工、`tell`、值班单投递 MUST 带取消信号；缺信号这种失败 MUST 立刻暴露，不许把支线静默停摆。
- **开监工不再留孤儿会话。** 先记下会话再发值班口径；发口径失败时那个会话 MUST 留下来复用，重试 MUST NOT 再建一个新的。
- **值班单发不出去要看得见。** 失败原因 MUST 写进一个新字段 `supervisor.lastError` 并触发状态刷新，不再只写诊断日志；`lastNote` 仍然只放最近一次的标题。
- **回归盯住这三条路。** 离线测试里假的 `sessionController.prompt` MUST 要求第二个参数，缺了当场抛错；新增一条脚本覆盖「失败后重试复用同一个会话」。

## Capabilities

### New Capabilities

- `supervisor`: 值班监工的送达契约 —— 开监工、投值班单、`tell` 三条路径都必须真的把话送进会话；失败必须留下记录，重试必须复用已经建好的会话。

### Modified Capabilities

（无）

## Impact

- `lib/index.js`：`supervisor` 动作（建会话、记会话、发口径的顺序与失败处理）、`tell` 动作、`notifySupervisor`（失败落库）、`normalizeSupervisor` 补 `lastError` 默认值。
- `test/supervisor.mjs`：假 `sessionController` 的 `prompt` 收紧成两参数；新增重试复用与失败记录的断言。
- README：「值班监工与项目手册」一节补「口径/值班单发不出去会记在哪里」。
