# Tasks

## 1. 现状盘点

- [x] 1.1 读 README（0.16.1）与 `lib/index.js`，确认要写成规格的行为范围
- [x] 1.2 定下 5 个能力名与边界，写进 proposal 的 Capabilities

## 2. 写 delta 规格

- [x] 2.1 `pipeline-graph`：图持久化、开工节点、依赖、状态、运行中改图、恢复与暂停开关
- [x] 2.2 `node-run`：开跑对话、提示词拼接、并行上限、设置来源、停止、归档后提交
- [x] 2.3 `archive-gate`：完成判据、等你、自动续跑、先验后归
- [x] 2.4 `wire`：三种写法、只动点名格子、坏图拒绝、dryRun
- [x] 2.5 `workspace-scope`：面板级工作区、解析顺序、自动登记、推送分流

## 3. 校验与归档

- [x] 3.1 `openspec validate establish-baseline-specs --strict` 通过
- [ ] 3.2 人工复核规格与 0.16.1 行为一致，尤其归档门禁与 `wire`
- [ ] 3.3 归档：`openspec archive establish-baseline-specs -y`，确认 `openspec/specs/` 下出现 5 个能力
