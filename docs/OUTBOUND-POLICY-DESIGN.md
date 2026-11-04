# 主动发言出站策略 · 设计方案（设计稿 v4，第一期已实施）

> 目的：解决「刷抖音 / 刷小黑盒 / 热榜巡游 / 贴吧 / 手机」等浏览型模块刷完就**各自强行私聊主人**、
> 绕过主动发言决策（目的引擎 / 主动搭话）的问题。给一个**开源社区通用**的方案：
> 不依赖第三方模块开发者按特定规则接入，规则长在框架的必经之路上。
>
> 版本史：
> - **v1**（2026-11-03）：初稿。拦截点选在 makeApi.sendText；被拦返回 `{ok:false}`。
> - **v2**：按内部架构审查修订——拦截点下沉 `scopeCoreForModule`；被拦返回 `null`；更正五处与代码不符表述。
> - **v3**（2026-11-03）：按第二轮设计审阅意见修订：收敛宿主统一发送服务、来源因果绑定、
>   预算预占生命周期、持久投递账本、收窄零改造承诺到主人私聊、故障降级语义显式化、动工分期去依赖倒置。
> - **v4**（本版，2026-11-03 实施回写）：**按真实代码核实并落地**。修正 v3 三处与代码不符的表述
>   （本仓无 hub outbox、无断线补发路径、低层无可达私聊直发），并记录已实施内容与遗留项。
>
> 改动集中在 `repo/src/chat/outbound-policy.js`（新增，宿主统一发送服务）、
> `repo/src/features/proactive-policy.js`（新增，两套策略源适配器）、
> `repo/src/chat/hub.js`（出口门闸）、`repo/src/core/modules.js`（api.proactive + 来源标记）、
> `repo/src/host.js`（装配 + 面板路由），以及模块库侧 tophub/douyin/heybox/phone 的迁移。

## 0-A. v4 实施状态速览（2026-11-03）

| 项 | 状态 | 位置 |
| --- | --- | --- |
| 宿主统一发送服务 | ✅ 已实现 | `src/chat/outbound-policy.js` |
| 策略源接口（reserve/commit/release + 四态） | ✅ 已实现 | `src/features/proactive-policy.js` |
| 共享预算域（按 owner，并发最多一个逻辑发言） | ✅ 已实现 | 同上 `createSharedBudget` |
| 来源因果（moduleId / 委托 / 背景分类） | ✅ 已实现 | `admit()` 的 `cause` 校验 |
| 持久投递账本（状态机 / TTL / 上限 / 同源合并 / ownerQQ 作废） | ✅ 已实现 | `outbound-policy.js` 账本段 |
| `api.proactive.submit / statusOf` | ✅ 已实现 | `modules.js` L339+ |
| hub 出口门闸 + 出口层第二道保险 | ✅ 已实现 | `hub.js` `setOutboundGuard` |
| 面板档位 / 四态 / 尚未纳管 | ✅ 已实现 | `host.js` `/panel/outbound-policy/*` |
| 模块迁移（tophub 记账修正、douyin/heybox/phone） | ✅ 已实现 | `mods-fork/modules/*` |
| 断线补发前策略复查 | ❌ **不需要** | 见 §1.3 修正：本仓无出站补发路径 |
| 传输阶段 `transport-queued` | ⏸ 保留状态位未启用 | 见 §6.2 修正：本仓无 outbox |
| 目的引擎 replace 主动门闸 | ⏸ 待接线 | 策略源已就绪，`hub.deliver` 门闸路径未启用 |
| `submit` 落账后自动投递 | ✅ 已实现 | 宿主注入 `send` 投递器；模块只调 submit，不管投递（§7 feed 语义） |
| 面板中文化 | ✅ 已实现 | `outboundView().view` 全中文；前端 `OutboundPolicy` 卡片直接渲染 |
| 白名单朋友不串额度 | ✅ 已实现 | 策略源 `scopeOf()` 只治理主人；朋友的额度仍归引擎自己（`tickFriends` / `stateFile(friend)`） |

**测试基线（v4 实测）**：`repo` 全量 **1255 项 / 1249 过 / 0 挂 / 3 skip / 3 todo**；
模块库 `mods-fork` **32 项全过**，tophub 16 项、douyin 63 项。

## 0. 一句话结论

把**规范化的 QQ 出站请求收敛到一个宿主统一发送服务**：模块快捷 API、scoped hub、pet QQ 回落
全部经它；宿主在该服务里绑定**来源与因果关系**，识别「主动私聊主人」，交给**当前活跃策略源**
（目的引擎 / 主动搭话）做「原子预算预占 → 发送 → 提交/释放」的门闸；实际网络发送与断线补发前
**再复查一次策略**。引擎没开则原样放行；用户没开纳管档位时面板明示「尚未纳管」。

**诚实的定位**：这是一套**可信扩展环境下的行为治理**。模块可以使用 Node 与
插件内部库，本方案**不承诺**对恶意任意代码建立不可绕过的安全沙箱——目标是让正常开发者
无需额外工作即被治理、让绕过行为显式化可观测，而非对抗故意的恶意绕过。


## 0-B. 交付分期（本 PR 的范围）

实施分三期提 PR，本 PR 是第一期的**宿主治理核心**：

| 期 | 内容 | 位置 |
| --- | --- | --- |
| ① 本 PR | 统一发送服务、策略源接口、hub 出口门闸、`api.proactive` 面 | `src/chat/outbound-policy.js`、`src/features/proactive-policy.js`、`src/chat/hub.js`、`src/core/modules.js`、`src/host.js` |
| ② 紧随其后 | 目的引擎侧的代发决断（`brokerReview`）与 §5.3 私有凭据（`enginePolicy`） | `src/purpose/*`、`src/modules/purpose/index.js` |
| ③ 面板 | `GET/POST /panel/outbound-policy` 与面板「主动发言策略」卡 | `src/host.js`（路由段）、`client/client.js` |

分期只影响**暴露面**，不影响行为：①②都落地前档位默认 `pass`，出站与改造前完全一致；
面板（③）没有时也能靠配置文件里的 `outboundPolicy.tier` 生效。

## 1. 现状（问题盘点，代码核实）

### 1.1 绕过决策的发信形态

| 模块 | 收尾发信方式 | 真实调用路径 |
| --- | --- | --- |
| douyin | 私聊主人 + 抖音站内私信 | `api.core.hub`（index.mjs L17）→ duty.mjs L94/L211 `hub.sendText`；截图走 `hub.sendSegments`（L99）；自建回合 `hub.runSystemTurn`（L166） |
| heybox | 独立后台会话判断分享 → 私聊主人 | `const { hub } = api.core`（index.mjs L19）→ site.mjs L1516 `hub.sendText` |
| phone | 主动逛/任务跑完私聊汇报 | `api.core.hub.sendText`（index.mjs L209/L264/L483） |
| tophub | 巡游完限量私聊分享 | `api.sendText`（index.mjs L47 → browse.mjs L155，**无视返回值无条件记 seen**） |
| tieba-reader | 定时浏览 → 私聊分享 | `api.sendText`（lib/index.mjs L128，`if (!sent)` 真值判断） |
| pet 回落 QQ | carrier=pet 桌宠离线回落 | `api.sendText(ownerChatId, …)`（pet/index.mjs L791） |

> 注：外部审阅核对的是 `.pr-review/work-11/modules` 副本（贴吧 1.5.0），行号可能与本仓
> mods-fork 略有漂移；结论（走 api.core.hub / 真值判断 / 无视返回值）两处核对一致。

### 1.2 两套主动发言引擎（都要兼容）

- **目的引擎**（`src/purpose/`，默认关）：素材 → 驱动 → 选目的 → 生成 → 投递。
  `evaluatePurposeTick`（engine.js L324-347）只做**判断不扣额度**（审阅探针实测：dailyMax=1
  连调两次都放行，countToday 仍为 0）；`markPurposeDelivered` 记的是**模型生成尝试额度**
  （生成前增加，沉默/失败也计入），与「实际打扰主人几次」**不是同一口径**。投递走
  `hub.deliver(chatId, text, { userText })`，刻意不带 `own:true`（module.js L322-324：让 hub
  桥接进下次对话）。
- **主动搭话 speakup**（`src/features/companion.js`，现行默认）：醒着窗口 / `maxPerDay` /
  `nextAt` / `idleMinutes`。**判断、schedule、计数都在 tick 内部，当前只导出 tick/fire/state**——
  并不存在一个可直接复用的外部 admit 函数，策略源接线需要从 tick 内抽出门闸判定为纯函数。
  发送走 `hub.pushToSession`，不经 sendText/deliver 直发面。

### 1.3 出站路径盘点（v4 按真实代码核实修正）

| 层 | 入口 | 现状 |
| --- | --- | --- |
| 快捷 API | `api.send / sendText / reply / sendImage / sendSegments / sendFile / sendVoiceFile`（modules.js L325-335） | 全部汇到 hub；v4 已带 `sourceModule` 来源标记进门闸 |
| scoped core | `scopeCoreForModule`（modules.js L171-198）转发 hub 大部分方法，**并保留 onebot** | douyin/heybox/phone 走这里 |
| 低层 | `api.onebot` / `api.core.onebot` 直调网关（modules.js L338） | **v4 核实：本仓 src 下只有 `send_poke`（hub.js L726）与 `send_qzone_msg`（qzone.js L64），没有 `send_private_msg` 直发**，故不构成私聊绕过面 |
| 传输兜底 | hub outbox `{queued:true, queuedId}` | **v4 核实：本仓不存在**。`sendText`/`sendSegments` 失败直接 `return null`，无排队对象 |
| 断线补发 | host.js「重连后 onebot.call 补发」 | **v4 核实：该处是 `pendingEvents.push(ev)`，攒的是「入站事件」，登录核对后回放；不是出站补发** |

**结论（v4 修正）**：v3 所述「传输兜底 + 断线补发绕过拦截域」在本代码版本中**不成立**，
因此 v3 §6.2 要求的「补发前策略复查」**无对应代码，首版不实现**。

真实治理落点收敛为两层：
① 各模块入口统一收敛到宿主统一发送服务（正常路径全覆盖，已实施）；
② `sendSegments` 出口层做**第二道保险**（模块直接调 scopedHub 的方法也被覆盖，已实施）。

v3 的「第三层最终投递复查」在未来若引入 outbox / 补发时再按 §6.2 补上——届时状态机已留 `transport-queued` 位。

### 1.4 发送返回值契约（现有调用方行为四类，逐类适配）

`hub.sendText` 现返回：网关结果对象（含 `message_id`）/ 排队对象 `{queued:true, queuedId}` /
`null`（失败/被拦/清洗为空）。**没有统一的 `{ok:boolean}` 契约**。现有调用方分四类：

| 类型 | 例子 | 被拦返回 `null` 后 |
| --- | --- | --- |
| 真值判断 | douyin L211 `if (sent \|\| dryRun)`、tieba L130 `if (!sent)` | ✅ 正确走「没发出去」分支 |
| 检查 message_id | （审阅提示存在此形态） | ✅ null 无 message_id，判失败 |
| 检查 `.ok` | （审阅提示存在此形态） | ⚠ null.ok 为 undefined（falsy）→ 判失败，语义仍正确 |
| 无视返回值 | tophub browse.mjs L155 无条件记 seen | ❌ 记账失真——**列入迁移清单，兜底层解决不了** |

**铁律：旧 API 的返回值语义不变**——被阻止时返回 `null`（旧调用方认得的失败值）；
结构化结果（pending/dropped/uncertain 等）只出现在**新 API / 显式版本化契约**里。
任何情况下不得在「不改旧模块」的同时改变旧调用口的真值含义。

## 2. 目标与非目标

**目标**

1. 主动私聊主人不再绕过决策：发不发、何时发，由当前策略源的规则定；
2. 旧模块**零改造可获得**：统一限流与拒绝（gate 的放行/拒绝语义）；
3. 显式接入的模块可获得：延迟代发、引擎重说、业务级记账闭环（feed/broker 协议）；
4. 目的引擎与主动搭话都被支持；两引擎与模块消息**竞争同一份共享预算**；
5. 门闸判定、预占、投递、补发全程有原子语义与回执状态机；故障时不静默失效。

**非目标**

1. 不管**站内动作**（抖音站内私信等浏览器自动化操作）；
2. 不拦**回应型发言**（有可信因果来源证明的回应，见 §5.2）；
3. 不做防恶意沙箱（见 §0 定位）；不引入数据库（原子状态变更用文件 + 按接收人串行化）。

**范围（首版收窄）**：首版只治理**当前 owner 的规范化私聊 ID**（`private:<ownerQQ>`）。
发给白名单朋友、其他业务接收人的主动私聊保持旧语义；purpose/speakup 对朋友本就有独立
状态与预算，不得把主人的素材、私密内容或预算套给朋友。治理全部私聊留二期（需按接收人
隔离策略接口、队列、配额与上下文）。

## 3. 总体架构（v3 最小架构）

```
模块快捷 API / scoped hub / 可访问的低层 onebot 发送 / pet QQ 回落
    → 宿主统一发送服务（绑定：moduleId、来源因果、目标、生命周期）
    → 分类与有效策略选择（§5）
    → 原子预算预占（reserve）+ 幂等投递记录（deliveryId）
    → 即时发送，或由唯一所有者登记 pending（§6 账本）
    → 实际网络发送 / 断线补发前策略复查（host.js 补发路径也走这里）
    → QQ 传输
    → 确认送达 / 排队 / 失败 / 不确定 的状态提交（commit / release / uncertain）
```

分工：**策略源负责决策**（要不要说、何时说），**宿主负责投递身份、状态、生命周期与传输回执**。
makeApi 仍有价值，但承担身份与上下文绑定；治理不只存在于快捷方法中。

## 4. 策略源接口（含预算预占生命周期）

```js
policy = {
  name: 'purpose' | 'speakup',
  ready() → boolean,                 // 供降级判定（§7），缺省 true
  // 原子预占：成功即锁定一份共享预算，返回 reserveId
  // 返回 { ok:true, reserveId } 或 { ok:false, reason:'quiet'|'budget'|'cooldown'|'busy'|… }
  reserve({ to, sourceModule, itemId, at }) → decision,
  // 预占后的提交/释放：
  commit(reserveId, { deliveryId, outcome }),   // outcome: 'sent'|'queued'|'uncertain'|'failed'
  release(reserveId, { reason }),               // 未发送释放额度（uncertain 不退款，见下）
}
```

**预算口径（先定义清楚再动工）**：
- `生成尝试额度`（purpose 现状 `markPurposeDelivered`）：模型生成前的尝试计数，沉默/失败也计入；
- `逻辑发言额度`：一次逻辑发言（可拆多条气泡）= 本方案治理的计量单位；
- `气泡额度`：物理消息条数，不单独设限，但**一次逻辑发言的多条气泡不重复扣同一逻辑预算**。

**关键语义**：
- 放行 ≠ 扣额度：现有 `evaluatePurposeTick` 只判不扣，必须走 reserve/commit 才真正占用；
  speakup 需从 tick 内抽出同构的判定 + 计数函数；
- **共享预算**：引擎自发消息与模块消息竞争同一份按 owner 的预算域，避免各自通过；
- **串行化**：按接收人/预算域串行化（内存队列或等效原子状态变更），并发时最多一个逻辑发言
  获得授权；
- **uncertain 不退款不自动重发**：投递结果不确定（网关超时等）单独记 `uncertain`，
  不能退款后重发造成双份打扰；
- **重启恢复**：预占状态落盘，重启后在途 reserve 判定失效释放，pending 走账本恢复（§6）。

## 5. 分类与来源因果

### 5.1 范围

只拦「**主动私聊当前 owner**」：目标 = 规范化 owner 私聊 ID 且无可信回应因果。

### 5.2 回应型判定：可信因果关系，不是启发式

「hub 会话在途」**不构成**回应证明——后台浏览本来就在跑系统会话；并发任务可能恰好在主人
聊天时结束；用户委托的长任务在原回合结束后回报，也不因此变成可延后的闲聊。
`replyId` 只是发送参数，不能单独证明来源。

v3 方案：**宿主在各入口记录显式来源**，形成因果链：

| 入口 | 记录 | 因果绑定 |
| --- | --- | --- |
| 入站消息 → 回合 | 会话上下文含触发消息 id、chatId | 回合内的发送继承该因果；目标 chatId == 源 chatId 即回应型 |
| 命令 / 面板 / 工具调用 | 记录触发者与授权的委托任务 id | **异步委托保留因果**：长任务回报带原任务 id，视作「主人委托的回报」，放行且**不可被 defer/drop** |
| 后台任务（模块自启） | 来源=模块，无主人因果 | 落入主动私聊分类 |

无可靠来源的历史模块（拿不到因果链的第三方）采用**保守兼容策略**：按主动私聊处理（宁可多管）。
首版明确「宁可漏拦改宁可误拦」要权衡：误拦主人委托的回报比漏拦闲聊更伤体验，
故**委托因果优先级最高**。

### 5.3 内部批准凭据（防伪造）

`origin:'engine'` 若是公开参数则可被任意模块填写。改为**宿主私有的投递凭据**：
内部投递（purpose deliver、speakup pushToSession）走独立调用路径或宿主私有凭据，
只跳过**重复的主动门闸**，仍执行总开关、禁言、生命周期检查。
注意 `own:true` 的语义（hub.js L1023/L1027：只控制 saidElsewhere 登记；正常会话回复也在用）
**与策略批准无关**，不得拿 own 充当引擎标记。

## 6. 延迟队列与投递账本

**原则：第一版只要支持 defer，就必须同时交付最小持久账本**；做不到就明确「只拒绝不改约」，
不假装改约。

### 6.1 账本状态机（deliveryId 串联全程）

```
pending → sending → transport-queued → sent
   │         │             │
   ↓         ↓             ↓
dropped   failed       uncertain     （+ expired：TTL 到期）
```

- 持久化：JSON 账本（`api.dataDir`），字段：deliveryId、moduleId、itemId?、to、渠道、
  状态、时间戳、因果引用、TTL；
- 上限：最大条数 / 字节数 / TTL / 同源合并（同 moduleId+itemId 的旧 pending 被新条目替换）/
  超限丢弃规则，全部显式定义；
- **pending 的唯一所有者**：宿主（引擎）或模块，**二选一**，杜绝「引擎代发 + 模块重试」双所有者
  重复投递；
- **到期不是无条件发送**：实际发送前**重新复查**当前策略、额度、目标、模块授权与有效期
  （模块已卸载 → 条目作废）；
- **接收人固定**：入队时绑定 ownerQQ；ownerQQ 变更后旧条目**不得**发给新主人，作废或丢弃。

### 6.2 与现有 outbox 的关系（v4 修正：本仓无 outbox）

**v3 假设的 hub outbox（`{queued:true, queuedId}`）与 host.js 断线补发在本代码版本中均不存在**
（核实过程见 §1.3 修正表）。因此：

- 首版**不实现**「传输阶段串联」与「补发前策略复查」——无对应代码可接；
- 账本状态机仍保留 `transport-queued` / `uncertain` 语义位，供未来引入 outbox 时复用，
  当前实现只会产生 `pending / sent / dropped / failed / uncertain / expired`；
- 若将来新增 outbox 或补发路径，**必须**先过账本复查再发，且与账本共用同一 `deliveryId`
  （届时按本节原文执行）。

### 6.3 跨渠道记账

渠道结果**分别登记**（qq / douyin-dm 各自的 sent/failed/uncertain）；跨渠道合并依赖**明确的
来源回执**——QQ 发送层无法仅凭当前参数判断抖音站内是否成功，不得把「某渠道已分享」
等同于所有渠道都成功。正文哈希只用于相同文本去重，不构成业务幂等。

## 7. 显式接入协议（broker/feed）

**承诺收窄**：旧模块零改造 → 只获得统一限流与拒绝；**延迟代发、重写、业务级记账（broker）
必须显式接入**，不向零改造模块承诺。

```js
// 显式接入的新 API（新命名空间，不动旧键）
api.proactive.submit({
  moduleId,            // 宿主绑定（scopeCore 已知），模块不可伪造
  itemId,              // 模块业务幂等键
  to,                  // 目标（首版限 owner 私聊）
  channel: 'qq',       // 渠道显式声明
  text, link?, at,
}) → { deliveryId }    // 稳定投递号
```

- 幂等键 = `moduleId + itemId + to + channel`（命名空间隔离，同 itemId 不同模块/接收人/渠道
  互不干扰）；
- 回执：`api.proactive.statusOf(deliveryId)` → 账本状态机当前态；
- 模块可选择：提交后由引擎全权决定（推荐路径 feed 语义），或保留 pending 所有权自行重试
  （须在接入时声明，二选一）。

## 8. 档位、降级与面板

### 8.1 档位语义（区分「用户选择」与「故障」）

| 情形 | 行为 |
| --- | --- |
| 用户显式选 `pass` | 旧行为直发（兼容迁移选择） |
| 两引擎确实均未启用 | pass 同上；**面板必须明示「尚未纳管」**——默认 pass 意味着升级后原问题仍在，不得把第一步宣传为已解决强行私聊 |
| 用户选 `gate`/`broker`，策略源 ready | 正常门闸 |
| 用户选 `gate`/`broker`，策略源 **configured 但未 ready / 初始化 / 重载 / 抛错 / 不支持该方法** | **暂缓或拒绝并显示原因**（面板 + 返回失败值），**绝不静默降级成 pass**——否则用户开启的治理在故障时悄悄失效 |

策略源生命周期显式化：`configured / running / ready / error` 四态，面板展示当前态与原因。

### 8.2 分期去依赖倒置（每期只暴露已实现的行为）

- 第一期不含 defer 就**不提供 gate 的改约语义**（只拒绝），面板不出 broker 入口；
- 每一期的面板开关与实际能力一一对应，不提前画饼。

## 9. 动工顺序与实施结果（v4 回写）

| 期 | v3 计划 | v4 实施结果 |
| --- | --- | --- |
| 第一期 | 盘点出口、统一发送服务骨架、来源因果、观测 | ✅ **已完成**：出口盘点纠正（§1.3）、`outbound-policy.js`、`cause` 分类、`stats` 统计、面板「尚未纳管」 |
| 第二期 | 两套策略源接线、共享预算、旧返回值适配、最小账本 | ✅ **已完成**：`proactive-policy.js`（purpose/speakup 双适配器 + `createSharedBudget`）、被拦返回 `null`、持久账本（TTL/上限/同源合并/ownerQQ 作废） |
| 第三期 | broker/feed、deliveryId 状态机、模块迁移 | ✅ **已完成**：`api.proactive.submit/statusOf`、账本状态机、tophub 记账修正、douyin/heybox/phone 迁移 |
| 补发复查 | host.js 补发前复查 | ❌ **不适用**：本仓无出站补发路径（§1.3 / §6.2 修正） |

**实施落点（实际文件）**

| 文件 | 内容 |
| --- | --- |
| `src/chat/outbound-policy.js`（新增 860 行） | 统一发送服务：`admit/commit/release/submit/statusOf/status/ledgerSnapshot` + 账本 |
| `src/features/proactive-policy.js`（新增 903 行） | `createPurposePolicy` / `createSpeakupPolicy` / `createSharedBudget` |
| `src/chat/hub.js` | `setOutboundGuard` 门闸（`sendText` 逻辑入口 + `sendSegments` 出口层二道保险） |
| `src/core/modules.js` | `api.proactive`（身份绑定 + `available` 取值器）、scopedCore 遮蔽 `outbound`、快捷 API 带 `sourceModule` |
| `src/host.js` | 装配服务、`wirePolicySources()` 懒装配、`/panel/outbound-policy/{status,config}` |
| `test/outbound-policy.test.js` / `test/proactive-policy.test.js` / `test/outbound-wiring.test.js` | 19 / 11 / 10 项 |

**关键设计取舍（实施时定案）**

1. **门闸只对带 `sourceModule` 的调用生效**：hub 内部发送（回复、命令回执、语音补表情）零影响，
   保证旧行为逐字节不变。
2. **`sendText` 判过之后摘掉标记再转 `sendSegments`**：避免同一条消息在出口层被重复判定、
   重复扣额度。
3. **门闸自身抛错按放行处理**：治理故障绝不阻断正常回复（与 §8.1「不得静默 pass」不冲突——
   后者针对的是策略源不可用时的**主动私聊**，不是日常回复）。
4. **scopedCore 遮蔽 `core.outbound`**：模块只能走 `api.proactive`，无法自填 `moduleId` 冒充他人。
5. **共享预算域不强制取两源最小值**：只负责「并发最多一个」与显式 `sharedDailyMax`，
   日额度判定留给各策略源（避免一个源配得严削掉另一个）。

## 10. 验收场景（v4 对应测试）

| 场景 | 覆盖情况 |
| --- | --- |
| 入口：api.sendText / sendSegments / scoped hub / pet 回落 | ✅ `outbound-wiring.test.js` 门闸/出口层/内部发送三条路径 |
| 分类：真实回复、后台任务、委托回报、伪造凭据 | ✅ `reply` chatId 不符降级 background、delegation 直通不可 defer |
| 兼容：被拦不得记成功 | ✅ tophub「网关返回 null 不记 seen」+ douyin「dropped 不算发到 QQ」 |
| 并发：最后额度只放一个、多气泡不重复扣 | ✅ 共享预算用例 + 「同一条消息只判一次」 |
| 队列：TTL / 容量 / 同源合并 / 卸载 / ownerQQ 变更 | ✅ 账本六项用例 |
| 传输：uncertain 不盲目重试 | ✅ uncertain 不退款用例 |
| 降级：pass / 引擎关闭 / 策略源出错 | ✅ gate 无源 managed=false、state=error → deny |
| 语义：生成尝试额度 vs 逻辑发言额度 | ✅ purpose 双口径用例 |

## 附：修订记录

### v1 → v2（内部架构审查）

| # | v1 表述 | 核实结论 | v2 处理 |
| --- | --- | --- | --- |
| 1 | 「makeApi 包 sendText 即全覆盖」「只有三条路」 | douyin/heybox/phone 走 `api.core.hub`（modules.js L171-198）；出站面 ≥8 条（L325-338） | 拦截点下沉 scopeCore；枚举发送类函数 |
| 2 | 「返回 `{ok:false}` 天然兼容」 | hub 契约是「结果对象/null」（hub.js L618/L646），真值判断会被当成功 | 被拦返回 `null`；结构化信息走旁路 |
| 3 | 「purpose 投递已用 own:true」 | module.js L322-324 刻意不带 | own 与 origin 职责分离 |
| 4 | 「speakup/purpose 自家发言也走出站路」 | speakup 走 `pushToSession` 不经直发面 | §5.2 重写 |
| 5 | — | tophub 无视返回值无条件记 seen | 列入迁移清单 |

### v2 → v3（第二轮审阅修订对照）

| OP | 级别 | 要点 | v3 处理 |
| --- | --- | --- | --- |

### v3 → v4（动工实施回写，2026-11-03）

| # | v3 表述 | 代码核实结论 | v4 处理 |
| --- | --- | --- | --- |
| 1 | hub outbox 返回 `{queued:true, queuedId}`（hub.js L650-654） | **本仓不存在**：`sendText`/`sendSegments` 失败直接 `return null`，全文件无 outbox/queued 出站逻辑 | §1.3 / §6.2 改写；`transport-queued` 保留状态位但不产生 |
| 2 | host.js L212-215「重连后 onebot.call 补发」 | **实为 `pendingEvents.push(ev)`**，攒的是入站事件，登录核对后回放 | 补发复查标为「不适用」，不写无对应代码的实现 |
| 3 | 低层 `api.onebot` 可达 `send_private_msg` 等 | src 下只有 `send_poke`（hub.js L726）/ `send_qzone_msg`（qzone.js L64），**无私人直发** | 低层不构成绕过面，不做包装 |
| 4 | 治理需三层落点 | 实际两层足够 | 逻辑入口（快捷 API + scopedHub 来源标记）+ `sendSegments` 出口层二道保险 |
| 5 | 「第一期只观测不拦截」 | 实施时直接落地了 gate/broker 全链路 | 见 §9 实施结果表 |

**实施中发现的额外事实**：`scopeCoreForModule` 的 hub 白名单副本把 `getPrototypeOf` 掐成 null，
模块无法经原型链摸回原始 hub——因此治理不能依赖模块自觉，必须在宿主侧的包装层完成（已按此实现）。

### v4 实施期发现的接口细节（与设计稿文字的出入，以代码为准）

| # | 设计稿/契约说法 | 实际实现 | 说明 |
| --- | --- | --- | --- |
| 1 | 档位读 `config.ext.outboundPolicy.tier` | 优先读 **`config.outboundPolicy.tier`**，`ext` 作兼容回落 | 面板按 `ext` 写仍生效；若有人写顶层会覆盖 `ext` |
| 2 | `submit` 非 broker 返回 `unsupported` | 另有 **`too-large`**（>8KB）与 **`error`** | 模块必须按 `deliveryId === null` 降级，不能只认 `unsupported` |
| 3 | `status().sources[name].reason` 有原因文本 | 初版恒为 `null` | **已补**：策略源暴露 `stateReason`/`lastReason`，面板可显示「为什么现在不发」 |
| 4 | `admit` 返回 `{action,reason,reserveId,deliveryId,cause}` | 另带 `managed`、`policy` | 已按实现消费 |
| 5 | 面板 `GET /panel/outbound-policy` | 同路径按 HTTP method 分流 | DSH route 只按 pathname 分发，无法注册两条同路径 |
| 6 | 策略源只回答能不能发 | 宿主在放行时一并返回 `settle(outcome)` 回调 | 否则预占永远挂着，下一轮被判 `busy`（实现期修的真实 bug） |

**实施期修掉的两个真实 bug**（原设计稿未提及）：
- `host.js` 的 `isMuted` 调用了 `mutes.has()`，而 `createMutes()` 只暴露 `muted(chatId)`——不存在的方会产生隐式 TypeError，已改；
- `lastPrivateAt` 曾把「按 QQ 号查询」的函数直接传给策略源，口径不符，已与 `companion.js` 对齐。

**未纳入治理的两条低层发送**：`send_poke` 与 `send_qzone_msg`（不在 `sendSegments` 路径上，
且都不属于「主动私聊主人」），按设计稿 §2 非目标处理。

### v4.1 补做项（2026-11-03 深夜追加）

1. **submit 补投递（模块零负担）**：宿主给服务注入 `send` 投递器后，`api.proactive.submit` 会
   直接发出并把状态推进到 `sent`/`failed`/`uncertain`。模块侧代码**一行不用改**——它们本来就在
   `await submit(...)` 并用返回的 `state` 判断（tophub/douyin/heybox/phone 四处都是）。
   同时补上：submit 也要**先过策略门闸**（此前只落账，等于让模块绕过决策），被拦返回
   `{deliveryId:null, state:'dropped', reason}`；投递完成后按结果结算预占（不结算会一直挂成 busy）。
2. **面板中文化**：`/panel/outbound-policy` 返回体新增 `view` 字段，含中文标题、一句话结论、
   档位/引擎/统计/账本的中文文案；`client/client.js` 新增 `OutboundPolicy` 卡片直接渲染，
   前端不再自己维护翻译表。
3. **面板原因文本**：策略源暴露 `lastReason`/`stateReason`，面板能显示「为什么现在不发」
   （如「今日额度已用完」），不再只有 ready/not-ready。
4. **白名单朋友**：主动搭话本就有 `speakUp.allow` 白名单（`companion.js` 的 `tickFriends` 每人
   单独计数），目的引擎亦有 `stateFile(friend)` 每人一份状态。本次在策略源加 `scopeOf()` 守卫：
   **只对主人私聊做预算判定**，非主人目标返回 `out-of-scope` 不占主人额度——
   防的是将来把治理范围放宽到全部私聊时静默串额度。
5. **两个低层调用确认不治理**（加注释说明）：`send_poke`（回应型动作，§2 非目标）与
   `send_qzone_msg`（QQ 空间动态，非私聊，§2 范围外）。
