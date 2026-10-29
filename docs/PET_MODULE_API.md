# 桌宠模块 API（id='pet'）

> 给三个读者：面板/前端（agent C）、桌宠 Electron 客户端、以及产出主动发言的
> purpose/speakup 模块。通信只有 HTTP 长轮询（`api.route` 没有 WebSocket/SSE，R6）。
> 本模块已注册为**内置模块**（src/modules/pet/，收口进 src/modules/index.js 的 BUILTINS）：
> 内置模块 route 无前缀，所有接口挂在 **`/aurabot/api/*`** 下。

## 1. 数据目录（全部在模块名下 `modules-data/pet/`，R11：模块文件夹本身禁写数据）

| 路径 | 内容 |
|---|---|
| `host.json` | 桌宠发现文件：`{version:1, baseUrl:"http://127.0.0.1:<端口>", token, api:"/aurabot/api", pluginVersion, updatedAt}`。setup 时写一次 + 每 120 秒刷新 + **每次请求从 Host 头学习真实端口，端口变了立即重写**（R9 端口漂移）。端口还未知时写 `:0`，客户端探测失败会重读 |
| `host-token` | 令牌：32~80 位 hex，生成一次永久复用 |
| `focus.json` | 专注模式：`{enabled, updatedAt, source}`。**读不到 / 坏了 / enabled≠true 一律按关闭**（fail-open，不 crash） |
| `voice/<sha1>.wav` | TTS 产物转存（推气泡前**即刻**从 voice-cache 拷入，R13：voice-cache 24h 清理不能直接指给客户端）；>24h 自动清理 |
| `app/` | Electron 客户端生成目录（`POST /client/install` 或面板「下载客户端」从模块自带 pet-client 模板拷入：main.js / preload.js / index.html / physics.js / README.md） |
| `packs/<名>-animation/*.webm` | 形象包动画素材（P1/P4，用户自备；**插件目录里不存放任何 .webm**） |
| `packs/<名>-config.json` | 形象包配置（动画池/权重/事件映射/物理参数，见 §6） |

## 2. 鉴权（照抄 surfcore 四道闸门，顺序不能换）

1. **回环**：`Host` 头必须是 `127.0.0.1` / `localhost` / `[::1]` → 否则 403（不看对端地址，防 DNS rebinding）
2. **非 GET 同源**：带 `Origin` 时 hostname 必须回环 → 否则 403；非浏览器客户端可以不带 Origin
3. **非 GET 必须是 `application/json`** → 否则 415
4. **令牌**：`x-pet-token` 请求头，或（素材/音频）`?token=` 查询参数；定长比较（timingSafeEqual）→ 否则 401

## 3. 路由一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/events?since=&wait=&client=` | **长轮询**。`since` 空=只取水位不重放；`since > 当前序号`（bootId 变过）同样只回水位；`wait≤60s`（客户端用 25）。返回 `{ok, bootId, cursor, events[], focus, serverTime}`。每次调用刷新该 `client` 的心跳（60s TTL） |
| GET | `/status` | `{online:{online,lastSeenAt,clients}, focus, bootId, seq, carrier, modality, fallbackToQQ, pack, playbackCount, hostFile, clientDir}` |
| GET | `/config` | 客户端配置：carrier/modality/fallbackToQQ/focus + `moods` 表情枚举 + `pack`（当前形象包视图，null=无素材走静态形象）。**顺带刷新素材路由**（新放素材被发现） |
| GET | `/history` | 最近推过的气泡（≤60 条）+ 最近动画回执 `playbacks`（≤20 条） |
| POST | `/focus` | body `{enabled, source?}` → 写 focus.json + 广播 `focus` 事件（唤醒长轮询） |
| POST | `/bubble` | body `{text, modality?, force?, anim?}`：测试气泡，默认 `force=true`（绕过专注模式）；`anim` 点播动作 |
| POST | `/playback` | body `{playbackId, anim?, status}`：客户端播完点播动画的上报回执（P2），登记进 `/history` |
| GET | `/packs` | `{active, packs:[{name, hasConfig, anims[]}]}`：形象包扫描结果（P4，面板列包用） |
| POST | `/pack` | body `{name}`：切换当前形象包（写 `ext.pet.pack` 设置 + 广播 `pack` 事件）；不存在的包 404 |
| GET | `/asset/<包>/<文件>.webm?token=` | 形象包素材（P1）。**严格隔离**：只服务该包 `-animation/` 目录里的文件；缺文件/越包访问/路径穿越一律 404，**绝不回落 default**。`Cache-Control: private` |
| GET | `/audio/<sha1>.wav?token=` | 语音文件；`Cache-Control: private`；不存在 404 |
| POST | `/client/install` | 把模块自带 `pet-client/` 生成到 `app/`，返回 `{ok, dir, files, message}` |

> 实现细节：模块 route 是全路径**精确匹配**（`mods.handle` 不做前缀匹配），所以素材路由是按文件
> 一条条注册的（`ensureAssetRoutes()`：启动时 + 每次 `/config` `/packs` `/pack` 时刷新）。

### 事件格式（`events[]` 元素）

```jsonc
{ "id": 12, "at": 1730000000000, "type": "proactive",
  "text": "主人怎么还不理我…", "modality": "text",   // 'text' | 'voice'
  "audio": null,                                     // voice 时 {key, url:"…/audio/<sha1>.wav?token=…", durationMs}
  "voiceError": "",                                  // TTS 失败降级纯文字时的原因
  "mood": "happy",                                   // 表情枚举：very-happy/happy/neutral/low/sad（api.use('mood').current() 映射）
  "anim": "wave",                                    // 【可选，P2】点播动作名；带它时必有 playbackId
  "playbackId": "a1b2c3d4",                          // 【可选，P2】动画回执号：客户端播完 POST /playback {playbackId,status:'played'}
  "purpose": "…", "messageId": "a1b2c3" }
```

另有 `{"type":"focus","enabled":bool}`（专注开关）与 `{"type":"pack","pack":"fish"}`（形象包切换）两种事件。
事件队列纯内存（≤200 条，重启即丢）；`bootId` 每次插件重启换新，客户端发现变了要重取水位。

## 4. 给 purpose/speakup 的载体互斥接口（模块导出）

```js
const pet = api.use('pet')          // 没装/没开时是 null，用 ?. 调
pet.online()      // → {online, lastSeenAt, clients}：60 秒内有客户端轮询过 /events 即在线
pet.focus()       // → true 表示专注模式开着（fail-open 语义，读不到=关）
pet.dispatch({ text, modality?, purpose?, force?, anim? })
// → { ok:true, via:'pet', message }                      桌宠在线：推气泡（voice 失败自动降级文字）
// → { ok:true, via:'qq', fallback:true }                 桌宠离线且 petFallbackToQQ：回落 QQ 私聊
// → { ok:false, reason:'carrier-qq' }                    载体是 QQ：purpose 自己走 QQ，桌宠不碰
// → { ok:false, reason:'focus' }                         专注模式：不发也不回落（force=true 可绕）
// → { ok:false, reason:'pet-offline' }                   离线且关闭回落
```

**互斥约定（永不双发）**：purpose 读自己的设置 `carrier`（与 `ext.pet.carrier` 保持一致，由面板统一保存）；
`carrier='pet'` 时**只调** `pet.dispatch()`，不要自己再发 QQ；`carrier='qq'` 时正常走 QQ 投递、不碰 pet。
专注模式下 purpose 的自动 tick 也应直接跳过（双保险）。
配置项（本模块 settings）：`ext.pet.carrier`、`ext.pet.modality`（'text'|'voice'）、
`ext.pet.petFallbackToQQ`（默认 true）、`ext.pet.pack`（当前形象包名，默认 'default'）。

## 5. 面板对接（host.js 经 /panel/pet/* 代理，模块只需提供三个导出）

| 导出 | 用途 |
|---|---|
| `status()` | 同步返回 `{online, lastSeenAt, clients, focus, carrier, modality, bootId, seq, pack, playbackCount}`（面板状态卡） |
| `download()` | 异步：生成客户端到数据目录，返回 `{ok, dir, files, message}`（面板「下载/重装客户端」按钮） |
| `setFocus(enabled)` | 写 focus.json + 广播事件（面板专注开关） |

host.js 对三者都有降级路径（缺函数 → `available:false`），所以模块没启动时面板不崩。

## 6. pet pack 约定（P4，仿 dsh-pet）

```
modules-data/pet/packs/
├─ default-config.json          ← 可选；默认包（没有它就只有静态小鲸鱼）
├─ default-animation/*.webm     ← default 包素材（平铺）
├─ fish-config.json             ← 额外包：文件名前缀 = 包名
└─ fish-animation/*.webm
```

`<名>-config.json`（全部字段可选，缺失回落默认；非法字段被过滤，不炸）：

```jsonc
{
  "animations": { "idle": ["idle-a", "idle-b"], "speak": ["speak-a"], "click": [] },
  //  ↑ 动画名不带 .webm；只保留目录里真实存在的文件
  "weights": { "idle": 60, "speak": 25, "click": 15 },   // 池权重（客户端按权重抽）
  "events":   { "proactive": "speak" },                   // 事件默认从哪个池抽（anim 点播优先）
  "physics":  { "gravity": 1400, "restitution": 0.78, "groundFriction": 2.5, "throwPower": 1 }
  //  ↑ 覆盖客户端拖拽物理参数（physics.js 的 DEFAULT_PHYSICS）
}
```

素材规格：VP9 透明通道 webm（640×360 左右）。**版权**：dsh-pet 的宠物形象是
CC BY-NC-SA 4.0 + 禁止商用，**不随本插件分发，用户自备**（引用 dsh-pet Release 需附署名；
自制可参考 dsh-pet 的 MAKE-YOUR-OWN-PET 配方）。

## 7. 桌宠客户端（pet-client）

- 源码模板：插件仓库 `src/modules/pet/pet-client/`（main.js + preload.js + index.html + physics.js + README）。
- 安装：面板 `download()`（或手动复制）到 `app/`，在该目录 `npm i -D electron && npx electron main.js`
  （**Electron 由用户本机安装，插件不加依赖**）。
- 客户端要求：读 `../host.json` 发现插件；HTTP 长轮询（wait=25s，失败退避并重读 host.json 适应端口漂移）；
  置顶、透明无边框、JS 拖拽 + 甩抛（physics.js）、托盘退出、单实例锁；按事件 `mood` 切姿态；
  动画池轮播（idle）/说话抽 speak 池/`anim` 点播优先，播完回 idle 并上报 playbackId；
  没有任何素材时回静态形象，一切功能照常。

## 8. 测试

`test/pet.test.js`（假 api 面 + `AURABOT_DATA_DIR` 隔离，R14）：12 例，覆盖互斥不双发、回落 QQ、
心跳在线判定、focus 开关（含坏文件 fail-open）、TTS 转存路径、anim 事件回执、pack 加载/严格隔离、
download 安装、physics 移植（弹簧/软钳速/抛体/松手初速/挤压）。

## 9. 不做清单（防返工，对齐 PROJECT_MAP §17.5）

不引入 dsh-pet 的协议/state 计数器长轮询、不做无鉴权、不做余额/工作状态/系统通知、
不用它的 edge-tts（aurabot 已有 voice 模块）、不整包嵌它的渲染端、不在插件目录放任何 .webm。
