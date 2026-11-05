# purpose 模块对外接口（目的引擎 · 实验性，默认关）

> 给面板/联调 agent 的接口说明。purpose 是**独立内置模块**（id **'purpose'**，默认关闭），
> 是从 surfcore 移植的「目的机制」主动搭话引擎：素材 → 目标假设（归属/置信度/风险）→ 选目的 →
> 生成一句话 → 投递主人私聊。
>
> 与「主动搭话」（speakup）的关系：speakup 的默认实现**保持不变**；purpose 是可选的新引擎。
> 想换引擎的主人：打开目的引擎开关，并关掉主动搭话的总开关（两套同时开会重复打扰）。
> 安静时段沿用主动搭话的醒着窗口（awakeFrom/awakeTo），所以两套的作息是同一份。
>
> 文件布局：引擎（纯函数）`src/purpose/engine.js`（移植自 Mieksido/surfcore 的
> `src/purpose-engine.js`，MIT，署名见 THIRD-PARTY-NOTICES.md）；接线 `src/purpose/module.js`
> （`createPurpose()`）；模块壳 `src/modules/purpose/index.js`。

## 1. 模块导出（host.js / 面板依赖）

`setup(api)` 同步返回，导出对象：

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `tick()` | `async () => void` | 60s 心跳（`api.every(60_000)` 已在 setup 注册），闸门判定 + 到点跑一轮 |
| `fire(reason)` | `async (reason?) => { outcome }` | 手动触发：跳过排程类闸门，不跳过总开关/禁言/ownerQQ。`outcome`: `sent / silent / failed / delivery-failed / skipped-materials / skipped-no-candidate / disabled / muted / no-owner` |
| `run({force})` | 同 `fire` | 别名 |
| `state()` | `() => { count, countToday, day, nextFireAt, lastOutcome, lastPurpose }` | **同步**，至少含 `count`（今日已投递次数） |
| `status()` | `() => summary` | `summarizePurposeState` 包装：今日次数/上次结果/下次时间/驱动向量/topNeeds/前 5 条目标假设/pending/history 摘要 |
| `preview()` | `() => preview` | **零副作用**预览：真收素材、真拼提示词，不写状态、不生成、不投递。`{ stats, materials, drives, goals, candidates, selected, prompt }` |
| `drivesRule()` | `() => string` | 驱动提示层（已 `api.rule` 注册进每轮系统提示词），面板不用调；引擎关着时返回空串 |

## 2. HTTP 路由（内置模块 prefix=''，即 `/aurabot/api/...`）

| 方法 | 路径 | 入参 | 返回 |
| --- | --- | --- | --- |
| POST | `/aurabot/api/purpose/fire` | 无 | `{ ok, message }` |
| GET/POST | `/aurabot/api/purpose/status` | 无 | `{ ok, status, state }` |
| GET/POST | `/aurabot/api/purpose/preview` | 无 | `{ ok, preview }`（零副作用；`prompt` 含记忆素材，别打进公开日志） |

面板另有 `/panel/purpose/*` 聚合代理（host.js）：`status / preview / run / config`，
模块没跑时降级返回 `available:false`，不炸。

## 3. 状态文件

- 路径：`api.dataDir('purpose', 'purpose-state.json')` → `~/.dsh/plugins-data/aurabot/purpose/purpose-state.json`
- 结构照 surfcore 引擎（`createPurposeState`）：`version, day, countToday, lastRunAt, lastAttemptAt, lastSentAt, lastOutcome('sent'|'silent'|'failed'|'delivery-failed'|'interrupted'|'pending'), lastPurpose, lastText, nextFireAt, attempts, drives{9维0~1}, drivesAt, lastEmotion(+Text), lastGoalId, lastMaterialCount, lastCandidateCount, goals[], observations[], pending[], history[], lastSkip`
- goals 条目：`id, owner('self'|'owner'|'member'|'media'), domain(9 need), object{type,name}, intent, evidence[≤4], confidence, value, urgency, risk, action, nextStep, status('hypothesis'|'active'|'confirmed'|'rejected'|'done'|'expired'), emotion, createdAt, lastSeenAt, expiresAt, attempts, sightings, source`
- 另有 `purpose/nudge.json`（追问去重标记，非引擎字段，勿展示）。
- 从旧版升级：`speakup.json` 只读迁移当日 count，之后不再读写（可保留不删）。

## 4. drives 向量结构

9 维 0~1：`play 玩 / learn 学 / install 装 / connect 陪 / care 关心 / share 分享 / identity 自我 / create 创作 / consume 体验`。
- 随时间向默认值衰减（半衰 8h）；`connect` 随主人沉默时长上升；素材亲和推高；`sent` 后对应维 ×0.45。
- **mood 对接**：`sent` 后按情绪 nudge `api.use('mood').nudge(delta, '主动搭话：<目的前20字>')`——
  `affectionate/excited +5、proud/amused +4、lonely -3、bored/worried/envious -2、content 0`；silent 不推。
- **心情判定兼容**：投递走 `hub.runSystemTurn` + `hub.deliver(text, { own:true, userText:'【系统提醒，…】' })`，
  userText 带前缀所以 mood.judge 的 `origin='speak-up'` 判定照常生效。
- top2 驱动（≥0.35）经 `api.rule` 写进每轮上下文：「你最近心里比较想要：玩、陪」。

## 5. 配置

**开关**：`config.ext.purpose.enabled`（模块 defaults 播种，**默认 false**）。
**调参**：`config.ext.purpose.*`：`minMaterials / initialDelayMinutes / maxCandidates / promptMaxChars`，
另有覆写位 `awakeFrom/awakeTo/minIntervalMinutes/maxIntervalMinutes/maxPerDay/idleMinutes`。
**沿用主动搭话的设置**（保持作息单一真相）：`config.speakUp.awakeFrom/awakeTo`（派生引擎安静时段；全天=关闭安静）、
`idleMinutes`（→ idleThreshold）、`minIntervalMinutes/maxIntervalMinutes`（→ gap）、`maxPerDay`（→ dailyMax）——
ext.purpose 同名键可覆写。

## 6. 其它接线事实

- 素材：聊天流水（hub.chatLogOf 最近 2 天，主人私聊 + 群）+ 记忆（`api.use('memory').list('')`，importance×100 适配）+ 人格（`api.core.personas.current()`）+ pending；B站留空扩展。
- 生成：`hub.runSystemTurn('purpose', …, { noTools:true })`，提示词无 QQ 发送工具指令；回包清洗：去内部备忘段/引号/「大肥鱼：」前缀，`[沉默]`/空 → `silent` 不硬发。
- 投递：`hub.deliver('private:'+ownerQQ)`；deliver 内部吞错，`sent` = deliver 返回 `{missedAt}` 对象，`undefined`（钩子拦截）记 silent，抛错记 `delivery-failed`。
- 闸门：`evaluatePurposeTick`（enabled/quiet/dailyMax/nextFireAt/ownerIdleMs）；`nextFireAt` 落盘 tick 重算，重启时在途 `pending` 改判 `interrupted` 不补发。
- 归属/回执/pending 语义与 surfcore 一致（群友目标重复≥3 或被点名才升 self；主人回复正/负/中性 → confirmed/rejected/微调；备忘【状态】待续/完成驱动 pending）。
- 投递载体：`ext.purpose.carrier`（默认 `qq`）。`carrier=pet` 时经桌宠模块（pet）推桌面气泡，
  桌宠离线按 `petFallbackToQQ` 回落 QQ 或静默；互斥铁律一轮只发一处，详见 docs/PET_MODULE_API.md（在社区库 modules/pet/ 里） §4。
- 旧 `createSpeakUp` 仍在 `src/features/companion.js`，是「主动搭话」的现行实现（mood 模块 files 与旧测试依赖，勿删）。
