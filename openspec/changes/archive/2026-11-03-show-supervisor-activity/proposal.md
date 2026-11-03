# Proposal

## Why

监工开着的时候，面板上只有一句「值班中：上一格归档没人接着跑、或者某一格停住等人回话，它会按手册处理」。这句话说的是规则，不是事实。

人真正想知道的是三件：它最近一次被打扰是什么时候、那次是为了哪一格、做完还是没送出去。这三样状态里都有——`supervisor.lastAt`、`lastNote`，以及 `lastError`——但面板从来没读过它们。结果就是：监工开了等于开了个盲盒，看不出来它是在干活，还是早就在投递那一步静默失败。

## What Changes

- **监工那一行 MUST 报「最近一次值班」。** 开着且出过手时，显示最近一次值班的时间和结论；从来没被叫过时，MUST 明说「还没出过手」，不要让人把「没消息」误当成「一切正常」。
- **送不出去的值班单 MUST 在面板上看得见。** `supervisor.lastError` 非空时，MUST 用错误色显示并保留原因原文，MUST NOT 和正常值班记录长得一样。
- **时间 MUST 按人看的本地时间显示。** 状态里存的是 ISO 字符串，面板 MUST 转成本地时间，MUST NOT 直接甩原文。
- **这行仍然只管展示。** 点开值班对话、改手册、开关监工这些入口不改位置。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `supervisor`: 补上「值班状态必须对人有交代」这一条 —— 面板要显示最近一次值班的时间、结论，以及投递失败的原因。

## Impact

- `lib/client.js`：监工那一行的渲染，读取 `supervisor.lastAt` / `supervisor.lastNote` / `supervisor.lastError`。
- `lib/index.js`：不需要改；三个字段随着状态一起下发（`lastError` 由 `fix-supervisor-prompt-signal` 引入）。
- `README.md`：面板一节补一句「这一行会显示最近一次值班」。
- 依赖：本 change 用到的 `lastError` 由 `fix-supervisor-prompt-signal` 引入，那一个 MUST 先归档。
