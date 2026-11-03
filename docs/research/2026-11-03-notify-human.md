# 监工喊人：微信 / QQ 通道调研

调研时间：2026-11-03。星数、发布日按当天 GitHub API 实测；本机事实按机器上实际文件核对。
**这份文档只做调研，不含实现方案。**

## 1. 结论

1. **现在发不出去。** 监工是一个普通 DSH 会话，全部出口就是 DSH 面板；人不开面板，它没有通道。
2. **能力上其实够了。** 监工会话的 preset 是 `standard`，`standard` 带 shell —— 它今天就能
   `curl` 一个 webhook。卡住的是「谁来发、发什么、发不出去怎么办」，不是「能不能发」。
3. **「人回话」这条路本机已经有了。** Tailscale 把面板挂到 tailnet，手机微信内置浏览器已经打开过它。
   所以只缺「怎么让人第一时间知道要去看」。

## 2. 监工的边界（事实）

- 监工由 `sessionController.create()` 建，`sessionId` 记在 `pipeline.json` 的 `supervisor.sessionId`。
- 插件只在两种时刻往里投值班单（`notifySupervisor`），值班单里含手册原文、触发格、图的样子。
- 开场口径**硬编码在 `apply` 里**，只交代两件事：接续跑、按手册回话。用户改不了，只能改手册。
- **最该喊人的事最没人看得见**：值班单投递失败只写进 `supervisor.lastError` —— 面板会变红，
  但那一刻本来就没人看面板。
- 已核实：`~/.dsh/sessions/…/session-4dcf9e4b…` 头部 `agentPreset: "standard"`；
  本对话同为 `standard`，shell 可用。**所以监工手里有 shell。**

## 3. 本机现状

- DSH Web 只监听 `127.0.0.1:63817`，没有公网入口。
- `tailscale serve status`：
  ```
  https://desktop-ngh9j4e.tail81d867.ts.net (tailnet only)
  |-- / proxy http://127.0.0.1:63817
  ```
  iPhone 在同一 tailnet 且在线。
- `~/.dsh/remote-web-ui-devices.json` 里出现过的 UA：
  iPhone Safari、**MicroMessenger/8.0.79（微信内置浏览器）**、**QQ/9.3.75（QQ 小程序）**。

即：**「微信里点链接 → 回到面板那一格 → 打字回话」已经跑通过。**

## 4. 出向通道

**先分清一件事**：所谓「给微信发消息」，只有两种形态 ——
① 个人号之间聊天（要协议端，有风控）；② 推给你自己微信里的一个**服务号/公众号**（Server酱、WxPusher 都是这种）。
②不需要挂微信客户端、不封号，是绝大多数项目的选择。

| 通道 | 怎么发 | 公网 IP | 门槛 | 送达 / 限制 | 收人回话 |
|---|---|---|---|---|---|
| **企业微信群机器人**（消息推送） | `POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…` | 不需要 | 企业微信 + 一个群 | 文本 / markdown / news / 文件 / template_card；`mentioned_list` 可 @人 @all；官方有「消息发送频率限制」一节，社区答复 20 条/分钟 | ❌ 只出不进 |
| 企业微信应用消息 | 同上体系 + 应用 Secret | **要回调就得公网** | 企业微信 + 可信域名 | 可收可发，最重 | ✅ 需公网 + 验签解密 |
| 企业微信智能机器人（AI bot） | 官方 SDK **出网 WebSocket** | 不需要 | 要开通 AI 能力 | 双向、流式；掉线要自己重连 | ✅ 本地双向最现实的一种 |
| 公众号模板消息 | `cgi-bin/message/template/send` | 不需要 | 认证服务号 + 用户关注 + 模板审核 | 慢、审核烦、有类目限制 | ❌ |
| **Server酱 Turbo** | `POST https://sct.ftqq.com/<SendKey>.send` | 不需要 | 微信扫码 | 免费 **5 条/天**；会员 3 元/月 1000 条/天 | ❌ |
| **WxPusher** | `POST /api/send/message`（`appToken` + `uids`） | 不需要 | 微信扫码 | **永久免费，2000 条/天/用户**；另有「极简推送 SPT」扫码即用；多端（微信/App/桌面） | ❌ |
| PushPlus / Bark | 各自 HTTP | 不需要 | 扫码 / Device Key | 同类，额度更小 | ❌ |
| 短信（阿里云 / 腾讯云） | 各家 SDK 或 HTTP | 不需要 | 实名 + 签名 + 模板报备 | 按条计费；**不依赖人开微信** | ❌ |
| 语音通知 | 电话外呼 | 不需要 | 同上 | 最硬，适合半夜；成本最高 | ❌ |
| 个人微信：Wechaty | 框架 23.5k★，puppet 多为付费 padlocal | — | 个人微信号 | web 协议基本不可用；风控、封号 | ✅（协议端） |
| 个人微信：wxauto | Windows UIAutomation，7.4k★，Apache-2.0 | — | 本机微信 **3.9.X** | README 明写「禁止用于实际生产项目」；微信一升级就碎 | ✅（读窗口） |
| 个人微信：WeChatFerry | 6.8k★，**仓库已 archive** | — | — | hook 路线在收缩 | — |
| **QQ：NapCat** | NTQQ 协议端 + OneBot 11 | 不需要（正向 WS 连本机） | QQ 小号 | 12.2k★，v4.18.42（2026-10-30）活跃；**自定义非商用许可** | ✅ |
| QQ：Lagrange.Core | C#，V2，Milky 协议 | 不需要 | QQ 号 | 3.0k★，2026-10-30 有提交；无标准 SPDX 许可 | ✅ |
| QQ：go-cqhttp | OneBot 11 | 不需要 | QQ 号 | 10.6k★，**最新 release 停在 2023-10-09** | 已过时 |
| QQ：mirai | JVM | 不需要 | QQ 号 | 14.8k★，**最新停在 2023-10-22** | 已过时 |
| QQ：官方机器人 | 开放平台 appId + secret | 不需要 | 开发者审核 | 合规不封号；**群聊被动回复只有 5 分钟窗口**，长任务结果只能走主动消息（有配额）；`botpy` 停在 2024-09 | ✅ |
| 通用：Apprise | 17.7k★，BSD-2，100+ 服务（含 ServerChan） | — | — | Python 依赖；本插件纯 Node、无构建，不划算 | ❌ |

> QQ 侧格局：**老两条（go-cqhttp / mirai）三年没发版，活的是 NTQQ 系（NapCat / Lagrange）**。

传统告警系统是「升级阶梯」：先微信（便宜、够快），几分钟没人理再短信，再不行打电话。
这套阶梯里，**微信这一级用 Server酱 / WxPusher / 企微群机器人就够，不必碰个人号协议。**

## 5. 入向：三条路

1. **出网长连接**（推荐）：NapCat 正向 WS 连本机；企微智能机器人官方 SDK 出网 WS。
   不需要公网、不需要隧道。
2. **公网回调**：企微应用 / 公众号 / 飞书自建应用 + frp / cloudflared。
   换来合规，代价是域名、证书、验签解密、长期维护。本机目前连公网入口都没有，这条路等于新增基建。
3. **不用 IM 收**：通知里带 tailnet 面板链接，人点开在面板里回话。**本机已验证可用**，零新增。

## 6. DSH 生态里已经有的轮子

| 项目 | 是什么 | 对我们的价值 |
|---|---|---|
| [`a792883583/dsh-message-gateway`](https://github.com/a792883583/dsh-message-gateway) | MIT，6★，2026-10-13。DSH 插件：企微智能机器人 / QQ 官方机器人 / 钉钉 / 飞书 / Bark / Server酱 / Telegram / Discord / 公众号 / 邮件 | 有 `POST /gateway/push` 主动推送，还给 Agent 注册了 `send_chat_message` 工具。**要发通知可以直接 POST 给它，适配器一行不写** |
| [`FablerTan/dsh-qq-relay`](https://github.com/FablerTan/dsh-qq-relay) | 1★，2026-10-20。DSH ↔ QQ 桥：NapCat + OneBot 11、`qq_send`、群项目目录、命令层 | 真 QQ 号双向的完整参考；README 自己写了封号风险 |
| [`webkubor/im-notify-kit`](https://www.npmjs.com/package/im-notify-kit) | MIT，零依赖 npm，飞书 / 企微发送层 | 坑点：**企微、飞书在机器人被移出群、关键词不匹配时照样回 HTTP 200**，失败藏在 `body.errcode` |

## 7. 三条候选路线（只评估，不实施）

| | 做法 | 成本 | 风险 |
|---|---|---|---|
| A. 全靠手册 | 手册里写死 webhook 和一条 `curl`，监工自己判断什么时候发 | 0 行代码，10 分钟 | 靠模型自觉；无重试、无去重；监工自己挂了就没人喊 |
| B. 插件出向 | 插件在确定性时刻（值班单投递失败、archive 等人点头、整图跑完）自己 POST；监工只说「要人」 | 约 200 行，零依赖 | webhook 要存好；判成败得看 `errcode` |
| C. 双向 | 出网长连接收消息 + 白名单命令 | 大 | 引入 IM 协议端、封号面、权限面 |

A 只能当过渡。B 是「确定性」的那一步 —— 因为它不依赖监工还活着。
C 目前不必要：第 3 节已经证明面板能从手机进。

## 8. 风险清单

- **webhook URL 等于密码。** 企微官方原话：泄漏了别人就能拿你的机器人发垃圾消息。要存插件目录的 state，不进仓库。
- **个人微信号不要当主通道。** wxauto 作者自己写「禁止用于实际生产」；WeChatFerry 已 archive。
- **HTTP 200 不等于送达。** 企微 / 飞书的失败在 body 里；只看 `res.ok` 再加个去重窗口，会把告警整段堵死。
- **入向权限要收窄。** 真做 C 的话，命令集只给 `/status` `/run` `/tell` `/stop`，`/archive` 不给 ——
  归档要当场看验证报告。
- **NapCat 是非商用许可**，不能随插件分发；只能当外部进程。

## 9. 还没确定的事

1. 你手上**有没有企业微信**（未认证也能建群、加群机器人）—— 决定首选是「企微群机器人」还是「WxPusher」。
2. 微信内置浏览器打开 tailnet 那个 https 域名时，**登录态会不会丢**（device 列表里有记录，
   但没验证过长期复用体验）。

## 10. 来源

- 企业微信群机器人（消息推送）：<https://developer.work.weixin.qq.com/document/path/99110>
- 企微社区：单机器人 20 条/分钟 <https://developer.work.weixin.qq.com/community/question/detail?content_id=16540210694719932581>
- Server酱 额度 FAQ：<https://sct.ftqq.com/docs/getting-started/faq/>
- WxPusher 文档：<https://wxpusher.zjiecode.com/docs/>
- 2026 微信机器人方案盘点（Wechaty puppet 现状）：<https://wechatapi.net/blog/91-2026%e5%be%ae%e4%bf%a1%e6%9c%ba%e5%99%a8%e4%ba%ba%e6%96%b9%e6%a1%88%e7%9b%98%e7%82%b9.html>
- NapCat：<https://github.com/NapNeko/NapCatQQ>
- Lagrange.Core：<https://github.com/LagrangeDev/Lagrange.Core>
- wxauto：<https://github.com/cluic/wxauto>
- Wechaty：<https://github.com/wechaty/wechaty>
- Apprise：<https://github.com/caronc/apprise>
- DSH 消息网关：<https://github.com/a792883583/dsh-message-gateway>
- DSH QQ 桥：<https://github.com/FablerTan/dsh-qq-relay>
- im-notify-kit：<https://www.npmjs.com/package/im-notify-kit>
