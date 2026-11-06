# Aurabot 向量记忆库 — 交接文档

> 新会话请**先读这一份**，不要翻历史记录。这里包含全部背景、决策、现状和下一步。

最后更新：2026-11-04 23:32

---

## ⭐ 开工看这里（30 秒版）

**做到哪了**：向量检索 ✅ → 记忆联想（A→B→C 多跳 + 防套娃 + 面板可调）✅ → 记忆加深（联想到的也加深、够门槛升档）✅ → 联想预览面板 ✅ → 交付分层（直接 N + 联想 M + 总数护栏）✅ → 新用户路径验收 ✅ → 模型降级提示 ✅ → **记忆星图 ✅** → **记忆页重排 ✅**
**最近更新（2026-11-05 下午）**：
- **记忆页重排**：6 组设置折叠收起，记忆库/星图/常用项默认展开，星图默认打开；挖出被死变量埋住的 2 个设置
- **新增记忆星图**：3D 星团可视化 + 复习/编辑/删除/恢复/新增/手动分层/重新布局，全部功能都在
  - 算法原样搬自 `memory-constellation 0.9.2` 的 `graph.mjs`（40KB 纯函数，零外部依赖）
  - **只搬可视化，不搬 assoc.mjs / pipeline.mjs / takeoverRecall** —— 联想和加深仍是我们唯一的一套
- 去掉 `recallHint` 里写死的 `slice(0,4)`；直接命中与联想各自限量、合并交付；面板加「每轮最多直接想起几条 / 每轮最多带几条联想 / 想起总数上限」
- 修 **新用户永远升不了档** 的 bug（无档位记忆被 `growTier` 直接 return 掉）
- 新增 `stats.vectorLocal`，模型没就绪时面板明确说「联想还没生效」
**测试**：全项目 **1263/1266**（3 skipped，0 failed），联想专项 **27/27**，星图专项 **16/16**
**代码**：`git-rebuild` 11 个提交，**未推 PR**（用户明确说先别推）
**数据**：489 条记忆 / 476 条联想边 / 490 颗星（含 1 颗归档）/ `tierSince` 40 条

**唯一没解决的（用户说「等全部修改完了再说」，暂时别动）**：§六.1 模型分发路线从未落地。
30 个 release 的 assets 全为 0、没有 workflow、npm 上也没包、模型没进 git。
**诊断已完成，结论和 A/B/C 三个方案都写在 §六.1**，届时直接照做即可。

**动手前跑一遍** §九「动手前先确认」那 4 条命令（代码是否同步 / 测试是否全绿 / 实机端口 / 联想是否还活着）。

**⚠️ 端口每次重启都会变**，别用 HANDOFF 里写死的端口，以 DSH Web GUI URL 为准。

---

## 一、这个项目在做什么

**给 Aurabot（QQ AI 伴侣插件）加上「本地离线向量记忆库」**，让 AI 能按意思找记忆，而不是只按字面匹配。

用户的原始需求（原话）：
> 记忆库同时也做向量库，id 一一对应才能真正共用
> 他有我也有，他没我也没
> 默认关闭但默认是本地向量，用户可以选择用那个
> 以此功能为基础推出记忆联想和记忆加深

**用户就是官方**（仓库 owner，`aureth-labs` 组织），不需要走外部沟通流程，直接定方向即可。

---

## 二、关键路径（全部已验证存在）

| 用途 | 路径 |
|---|---|
| **开发/运行目录**（唯一改动区） | `C:\Aurabot\rc1-20261104-1251` |
| **干净 PR 仓库**（对比官方，用于生成 diff） | `C:\Aurabot\git-rebuild` |
| **官方 rc1 原版源码** | `C:\Aurabot\official-rc1\aureth-labs-dsh-aurabot-qq-0a6dac8` |
| **临时测试脚本** | `C:\Aurabot\work\` |
| **所有备份** | `C:\Aurabot\backups\` |
| **DSH 数据目录** | `%USERPROFILE%\.dsh\plugins-data\aurabot` |
| **Node** | `D:\deepseek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe` |
| **Python** | `D:\deepseek\resources\runtime\primary-runtime\dependencies\python\python.exe` |
| **git** | `C:\Users\Administrator\Desktop\git\cmd\git.exe` |

**junction**：`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-aurabot-qq` → `C:\Aurabot\rc1-20261104-1251`

---

## 三、已完成的功能（全部实测通过）

### 1. 本地向量库（离线、免费）
- 模型：`bge-small-zh-v1.5-int8`，512 维，纯离线
- 实测效果：搜「睡不好」→ 命中「睡觉最近经常熬夜」(0.681)
- 三种模式：关闭 / 本地模型（默认） / 在线服务（老配置兼容）

### 2. 记忆库 ↔ 向量库严格镜像
- 每分钟 tick 比对，新增/改写/删除/遗忘全部同步
- 实测：482 条记忆 = 482 条向量，缺失 0、孤儿 0
- 删除/遗忘会清理孤儿向量

### 3. 面板搜索走向量
- 「翻一翻」= 关键词 + 向量双路
- 搜「他喜欢吃什么」→ 命中「主人不把爱吃白米饭当成毛病」

### 4. 面板拆分
- 「心情与记忆」拆成「心情」页（情绪、半衰期、说话方式）
- 和「记忆」页（记忆库、整理、容量、向量检索、搜索、导入）

### 5. 模型自动下载
- 首次要算向量时从 GitHub Release 拉，不拖慢启动
- 下载到 `.part`，校验通过才改名
- 断网/404/HTML错误页/空body/中断残留 全部安全

### 6. 记忆联想（向量建边）— 2026-11-04 新增
- 官网 `related` 边用关键词建，且 `event`/`diary` 被 L772 排除，用户数据里 **0 条**
- 新增按向量余弦建边，**存在顶层 `state.assoc`**（`{[id]: [[otherId, weight, walkCount]]}`）
  - **刻意不往记忆条目上加字段**：条目的结构是官方契约，`memory-upgrade.test.js` 要求旧条目一个字段都不能变
- 建边规则：只在**同 chatId + about + scope + status** 的桶里连边（和 `related` 同一套可见性），否则群友私事会漏进主人私聊
- 每条最多 4 条边（度上限），每算完一个桶 `setImmediate` 让出事件循环
- 签名 `assocSig`：条目集合 + 每条文字哈希 + **已有向量的 id 集合**。第一次跑是**纯本地** 405 节点/477 边/121ms；签名没变自动跳过
- 实测：484 条记忆 → 405 个节点、477 条边、**跨可见性泄漏 0**

### 7. 多跳联想 A→B→C — 2026-11-04 新增（用户明确要求）
- `hops` 默认 **2**（A→B→C），可配 0/1/2/3；`ASSOC_HOPS_MAX=3` 是硬上限，**配置突破不了**
- **三重防套娃**：
  1. 跳数上限（≤3）
  2. 总数上限 `assoc.recall`（默认 3 条）
  3. `visited` 集合（整轮每个条目只出现一次，天然不成环、不绕回起点）
- **名额按跳分配**（关键）：第 1 跳拿 `max(1, ceil(剩余/2))`，剩下留给深跳。
  不分的话 1 跳会吃光名额，2 跳永远是 0 条（**实测真实数据全库 2 跳都是 0，等于没做多跳**）
- 每多跳一跳乘 `hopDecay`（默认 0.55），所以越远分越低，最后自然沉底
- 实机实测：`睡不好/考试/做饭` 每轮都是 **1 跳 2 条 + 2 跳 1 条**，分数 7.61→3.31 递减

### 8. 记忆加深（行为驱动升档）— 2026-11-04 新增
- 在 `touch()` 里给真正交给她看的记忆涨 `importance`，够门槛升档
- 参数（默认值，面板可改）：`+0.02/天`、`hitDays>=3` 才开始算、上限 `0.85`、tier2 需 `5天且≥0.6`、tier3 需 `10天且≥0.75`
- 新增 `tierSince` 字段；**永久档 `tier:0` 不升不降**；**`tier:'core'` 长期印象不参与升档**
- ⚠️ 关键坑：老记忆没有 `tierSince` 时**不能拿 `at` 当起点**——3 个月前的记忆今天刚凑够天数会一次涨 1.8 直接封顶。已改成第一次进入可增长态时把起点钉在 `now`
- **联想带出来的记忆也算加深**（用户要求）：`assocPerHitDay` 默认 2，即联想 2 次折算「想起来一天」
  - 同一天最多折算一天（100 次联想也只 +1），`assocHits` 封顶在 `assocPerHitDay`，跨天才结算

### 9. 联想/加深的安全闸（防失控）
| 闸门 | 值 | 作用 |
|---|---|---|
| `hopDecay` | 0.55 | 跳得越远分越低 |
| `assoc.recall` | 3 | 每轮联想总量上限 |
| `ASOC_HOPS_MAX` | 3 | 跳数硬上限 |
| `hitDaysCap` | 40 | 联想怎么加都不会把记忆变成永不遗忘 |
| `cap` | 0.85 | importance 天花板 |
| `assocHits` 折天 | 1 天 1 次 | 同一天被联想 100 次也只算 1 天 |
| `tier:0` / `tier:'core'` | 不改 | 永久档和长期印象不被自动改档 |

### 13. 记忆星图 — 2026-11-05 新增（用户要求「保留星图内的全部功能」）

来源：`C:\Users\Administrator\Desktop\memory-constellation-backup-20261105.zip`（sha256 已校验一致）。

**⚠️ 第一版踩的坑（重要教训）**
第一版我「自己重写了一个精简版星图」（约 270 行），结果被用户一眼看出来：
**「比文档里的星图少了很多功能，而且还很丑」**。
原因是原版 `panel.js` 那 800 行渲染里堆了大量**反复调优出来的效果**，自写版全部丢失：
辉光 bloom 后处理、星团光环+外圈虚线环、层级射线、短辐条、模块核心星、
团内子星云分色、太阳状记忆中枢脉动、标签避让粘滞、星点按 tier 的金环/虚线环、
惯性旋转、镜头平滑飞行、自适应字号……
**教训：这类经过调优的视觉代码，能整段搬就别重写。**

**最终做法：整段搬渲染，只改接线**
`client/client.js` 里的 `smDraw()` 就是原版 `draw()` 函数，逐行搬过来，只改了 3 处：
1. React `useEffect` 闭包 → 显式参数（`opt` 对象传面板开关）
2. `setState` 调用 → 返回命中表，由外层处理
3. 数据结构对接 rc1（tier 已映射好）

**搬了什么、没搬什么**

| 来源 | 处理 | 原因 |
|---|---|---|
| `graph.mjs`（40KB 算法） | ✅ **原样搬成** `src/features/memory-graph.js`，只追加 tier 映射 | 纯函数、零外部依赖，亮度/建边/布局全部自包含 |
| `panel.js` 的 `draw()`（约 800 行渲染） | ✅ **整段搬进** `client/client.js` 的 `smDraw()` | 视觉效果全靠它，自写版被用户判定「很丑」 |
| `assoc.mjs`（38KB 联想） | ❌ **不搬** | 和我们 `state.assoc` + `search()` 是两套完全不同的边，会打架 |
| `pipeline.mjs`（每日读写） | ❌ **不搬** | `dailyConsolidate` 保持 rc1 现状 |
| `takeoverRecall`（接管自动回忆） | ❌ **不搬** | 否则会绕过我们刚做好的联想/加深系统 |

**渲染数据契约**（`/memory/graph` 必须回这些，少一个就画不出来）
```
stars[]: id text about aboutName tags tier importance at lastHit S source
         region hits child archivedAt invalidAt brightness x y z cluster
layout:  { version, radius, groups[], clusters{} }
stats:   { total live archived outdated bright dim }
edges[]: { a, b, kind, weight }        kind = person | tag | similar | conflict
```
- `region` 决定颜色（`regionOf()`），`hits` 决定代表星排序，`child` 决定子星云归属
- **`regionOf` 一开始漏了导入**，route 直接回 `{"ok":false,"message":"regionOf is not defined"}`，
  面板一片空白。补导入后正常 —— 以后加字段务必先跑一遍 route 层验证。

**tier 值域映射**（用户确认：`0` → core）
```
rc1 0 永久档   → 星图 core（永久）
rc1 1 琐碎     → 星图 short（临时）
rc1 2 一般     → 星图 long（长期）
rc1 3 重要     → 星图 core（永久）
rc1 'core'     → 星图 core
rc1 undefined  → 星图 long
反查：short→1, long→2, core→3（认不出来的返回 null，调用方据此拒绝）
```

**给 `memory.js` 补的 5 个接口**（中枢要用、rc1 原本没有）

| API | 作用 | 注意 |
|---|---|---|
| `metaAll()` | 每条记忆的 `tau`/`tier`/`lastHit` | 只读。tau 公式和 `retention()` 一致 |
| `archived()` | 过时/归档的记忆（星图「归档星云」） | 只读 |
| `setTier(id, t)` | 手动改层级 | 只认 0~3；`'core'` 长期印象**拒绝改**；改档后重置 `tierSince` |
| `setAutoRecall(on)` | 星图那个总开关 | **映射到 `recallMode`**（always/trigger），不另造开关。必须走宿主注入的 `setConfig` |
| `touch` | 点击复习 | 原本是内部函数，现在导出 |

**星图的 10 个 route**（`src/modules/memory/index.js`）
`/memory/graph` `/review` `/restore` `/update` `/remove` `/add` `/tier` `/sync` `/optimize` `/state` `/autorecall`

**面板**：`client/client.js` 里新增 `StarMap` 组件，在「记忆」页「联想预览」下面，**可展开区块**（用户选的）。
交互：拖动旋转、滚轮缩放、悬停高亮、点选详情、搜索、区域筛选、重置视角、复习、改层级、删除、恢复、新增一颗星、重新布局。

**主动加深 vs 被动加深（用户明确要的两个来源）**
- 被动：联想带出的记忆自动加深（`assocSeen` 折算）
- 主动：星图上点「还记得（复习）」→ 调 `memory.touch()`，真的涨 `hitDays` / 刷新 `lastHit`

**实测（实机，端口每次重启都变）**
```
/memory/graph        → 490 颗星 / 11 个星团 / 664 条边 / 7 个子星云 / radius=470
   边类型：tag=456  person=184  similar=24
   区域分布：event=373 knowledge=48 person=63 core=5 archived=1
   tier 分布：short=266 long=202 core=22
/memory/graph/state  → total=490 live=489 archived=1 bright=383 dim=0 lastSync 正常
POST /memory/graph/review → {"ok":true,"message":"已确认还记得（长期，清晰度 76%）"}
   复核存储：hitDays=1, lastHit 刷新到当天, lastHitDay 写入 ✅ 真的加深了
```
建边 24ms / 布局 8ms（490 条真实数据）。

**硬线**：星图的任何接口都不许改 `state.assoc`。已有测试守着这条。

**验证方法**：改了 star 字段或 route 之后，先跑一个「模块级 route 测试」
（mock `api`，直接调 `routes.get('/memory/graph')`），确认 `regionOf` 这类漏导入
能在几秒内暴露，而不是等重启后打开面板才发现一片空白。

### 13.5 星图接口审计：修掉的 6 个 bug — 2026-11-05

用户要求「检查接口转换 + 查 bug」后逐条审计出来的。全部已修 + 有测试/实机复验。

| # | Bug | 后果 | 修法 |
|---|---|---|---|
| 1 | `memory.remove()` 对**任何 id** 都返回 `{ok:true}`（它只是 filter 一下） | 面板提示「已删除」，其实什么都没删；空 id 还会递增 `rev` 并写盘 | route 里先确认这条真的存在，再调 remove |
| 2 | `add` 传非法 tier（如 `'xx'`）时 `toHostTier` 返回 null，被静默当成「不填」 | 用户选了层级却变成长期，以为没生效 | 非法 tier 直接返回错误 |
| 3 | `state.stats.clusters` 用 `(g.clusters \|\| []).length`，但 `clusters` 是**对象**不是数组 | 恒为 `undefined`，面板显示「undefined 个星团」 | 改成读 `layout.groups.length` |
| 4 | **`setTier` 只会升不会降**（`Math.max(m.tier, t)`） | 星图上点「临时」永远无效，用户没法把一条降下来 | 手动改档直接赋值；`0` 时清掉 `tierSince` |
| 5 | 鼠标每移动一次就 `setHover` + `setHoverGroup` | 60fps 下疯狂触发 React 重渲染 | 悬停目标改走 ref，只在「换了一颗星」时 setState（只为切光标） |
| 6 | `/state` 调 `buildGraph()`，会**顺带把布局写盘** | 一个只读接口有副作用，还会得写 79ms 算一次布局 | 改成直接读原始数据 + 复用缓存里的 `layout.groups`，mtime 实测 0ms 不变 |

**另外补齐了漏掉的原版交互**：`编辑星星`（改文字和重要度，走 `/update`）。
原版 `panel.js` 有 `editing` / `saveEdit`，我第一版只做了删除和分层，漏了编辑。

**接口对照结果**（11 个后端 route vs 前端调用）
```
前端调了但后端没有：无 ✅
后端有但前端没用：/update（已补编辑交互）、/sync、/state、/autorecall
  —— sync/state/autorecall 是给「外部调试 / 未来接线」留的，不是死代码
body 字段对照：6 个 POST 接口全部对上 ✅
返回字段使用：stars / layout.groups / layout.radius / stats / edges 前端都在用 ✅
```

### 13.6 记忆页重排 — 2026-11-05

用户原话：「优化一下记忆这个模块的面板，太杂乱了，然后星图是默认打开的」。

**问题**：原来整页 40 多个开关**平铺**在一起，没有分组，一进来要滚半天；
星图反而默认收着，最直观的东西藏在最下面。

**现在的结构（什么默认展开、什么收起来）**

| 顺序 | 区块 | 默认 |
|---|---|---|
| ① | 记忆库（统计三格 + 每日整理 + 容量 + 聊天流水天数 + 整理时合并） | 收起 |
| ② | **记忆星图**（常驻画布） | **展开** |
| ③ | 每轮想起多少（直接几条 / 联想几条 / 总数封顶 / 何时翻旧账） | 收起 |
| ④ | 记忆联想与加深（含联想预览） | 收起 |
| ⑤ | 向量检索（实验性） | 收起 |
| ⑥ | 人物与群印象 | 收起 |
| ⑦ | 分层记忆与遗忘 | 收起 |
| ⑧ | 手动加一条 | 常驻 |
| ⑨ | 翻一翻 | 常驻 |

**用户后来又调了两轮**：
- 第一轮：③④ 改收起
- 第二轮：① 也改收起 —— **最终六个设置组全部收起，星图是这一页唯一默认展开的东西**

新增 `Fold` 组件：点标题展开/收起，**收起后标题右侧仍显示一行摘要**
（比如「495 条 · 上次整理 2026/11/5」「联想 2 跳 · 已建 477 条」），
所以折叠不等于信息消失。右上角控件（如记忆总开关）带 `stopPropagation`，
点开关不会误触折叠。

**星团清单（画布左上角浮层）**

第一版我把清单**堆在画布下方**，占了半屏空白，用户截图指出位置不对。
对照原版 `panel.js`（L1676-1770）改成浮在画布左上角的半透明面板：

| 参数 | 值 | 说明 |
|---|---|---|
| `position` | `absolute, left:10, top:10` | 浮在画布上 |
| `width` / `maxHeight` | `152px` / `52%` | **限高 52% 是关键**：第一版我设成 `calc(100% - 20px)`，几乎全高，把画布左半边整个盖住了 |
| 背景 | `rgba(6,11,22,0.6)` + 1px 边框 | 不能太实，要能看见后面的星 |
| 圆点 | 7px + `boxShadow 0 0 6px` 发光 | 色相和画布上星团光环同一套 `SM_GROUP_TINTS` |

内容从上到下：**层级筛选**（永久/长期/临时，带各档条数，点一下只看这档）→
**模块列表**（圆点 + 名称 + 总数）→ 展开后是**子星云**（缩进 18px，小一号圆点）。
点模块/子星云就聚焦到画布对应位置，和直接点画布是同一套行为。

**这轮又踩的一个坑（值得记下来）**

改的时候我把 `Fold` 的调用写进去了，但**组件定义在 git 回滚里丢了**。
`node --check` **照样通过** —— 因为语法上 `Fold` 只是个未定义变量，不是语法错误。
运行时会直接 ReferenceError，整页白屏。

**教训**：改 React 组件后，`node --check` 只能证明括号配平，**证明不了组件存在**。
应该再跑一次「引用扫描」：把所有 `h(Xxx, ...)` 里的组件名和定义列表对一遍。
这轮就是这么查出来的，另外还顺手发现 `Fragment` 之外无遗漏。

**顺带挖出的真 bug**：`moodCard` 这个变量**定义了但从未被使用**（心情页早就独立成 tab 了），
而里面埋着两个**记忆设置**——「聊天流水留多久」和「整理时合并重复记忆」。
也就是说这两项用户在界面上**根本调不到**。已挪到记忆库折叠组里。

### 14. 模型未就绪时的降级提示 — 2026-11-05 新增

**问题**：本地模型没装好时 `createVectorIndexByMode()` **直接返回 `null`**（`memory-vector.js:280`），
于是 `stats.vector / vectorMode / vectorModel` 全是空。面板原本的判断（`vectorModel.error && !vectorReady`）
**一个条件都不成立**，什么都不显示。用户看到的是「联想开关打开了、参数也调了，怎么一条联想都没有」——
以为是 bug，其实是模型没下载。

**修法**：`stats()` 新增独立字段 `vectorLocal: { wanted, ready, enabled }`
- 不依赖 `vector` 是否存在，直接调 `resolveAssets(dataDir())` 看磁盘上有没有模型文件
- `wantLocal` 由 `memory.vector.mode !== 'remote'` 判断
- `resolveAssets` 从 `memory-vector-local.js` 导出（原来没 export）

**面板两处提示**（都用 `stats.vectorLocal`）：
1. 「记忆联想」节：`wanted && !ready` → 「⚠️ 记忆联想现在还没生效：本地向量模型还没就绪…」
2. 「向量检索」节：同上且不正在下载、也无报错 → 「⏳ 本地模型还没下载好：记忆能用，但联想要等模型就绪」

**三态实测**：

| 场景 | `vectorLocal.ready` | 面板 |
|---|---|---|
| 模型缺失 + Release 404 | `false` | ⚠️ 联想还没生效 |
| 模型已就绪 | `true` | 无提示（正常） |
| 模型缺失 + 无网络 | `false` | ⚠️ 联想还没生效 |

### 12. 新用户路径验收 — 2026-11-05 新增（**这一节最重要**）

之前所有测试都用「483 条记忆的老用户」数据，**新用户从零开始的路径完全不同**。逐项模拟过：

| 步骤 | 结果 |
|---|---|
| ① 首次启动（空库） | ✅ count=0，`buildAssoc` 返回「还没有向量」而不是崩 |
| ② 聊几天，记忆被提炼 | ✅ 6 条正常入库 |
| ③ 第一次 `tick()` | ✅ **向量 6/6 自动算好、联想边 10 条**，耗时 179ms |
| ④ 联想召回 | ✅ 直接 2 条 + 1 跳 2 条 + 2 跳 1 条，A→B→C 真的通 |
| ⑤ 交付 | ✅ 5 条进 hint，符合「直接 6 + 联想 3」 |
| ⑥ 连续 6 天被想起 | ✅ 第 3 天开始涨 importance、**第 5 天升到 tier2** |
| ⑦ 重启 | ✅ 记忆/边/tierSince 全保留 |

**⚠️ 关键发现：向量同步和建边都在 `tick()` 里**，不在 `add()` 里。
新用户加完记忆后，必须等下一次 `tick()`（约每分钟一次）才会算向量、建联想边。
测试里直接调 `add()` 然后 `buildAssoc()` 会一直返回「还没有向量」——**别误判成 bug**。

**⚠️ 另一个关键发现：本机测不出「Release 缺模型」的问题。**
`memory-vector-local.js` 按三级找模型：①数据目录 `models/` → ②（缓存）→ ③**插件自带 `models/`**。
开发目录里 `models/` 存在，所以**永远不会触发下载**，404 根本走不到。
真正的新用户从 Release 安装 → 包里没 `models/` → 才走下载 → Release assets=0 → **404 → 无向量 → 联想功能完全不可用**（记忆和关键词召回仍正常，不崩不卡）。

实测（临时把 `models/` 移走后）：`vector: 0/2`、`vectorReady: false`、`assoc: 0`，`vectorModel: null`，关键词召回正常。

### 11. 交付分层：直接 N 条 + 联想 M 条 + 总数护栏 — 2026-11-05 新增（用户定稿的设计）
用户原话：**「每轮最多想起是直接想起，条数也是限制他的，联想是间接的，条数是他自己规定的，最后合在一起，在设置面板加一个想起总数，可以设置比如直接想起2＋联想4，用户可以随时设置」**

实现：
- `recallCount` = **直接命中**上限（面板「每轮最多直接想起几条」，默认 6）
- `assoc.recall` = **联想**上限（面板「每轮最多带几条联想」，默认 3）
- `recallTotal` = **总数护栏**（面板「想起总数上限」，默认 0 = 不额外限制，最大 24）
- 交付逻辑：`direct.slice(0, recallCount)` + `assoc.slice(0, assoc.recall)` → 合并 → 再 `slice(0, recallTotal)`

**修掉的致命问题**：`recallHint` 里原来写死 `.slice(0, 4)`。
实测过：`recallCount` 调成 6 或 12，**进 hint 永远是 4 条**，联想几乎全被砍掉（只有直接命中不足 4 条时才挤进来）。面板怎么设都没用。

**字符预算改成动态**：`min(600, max(280, 条数×75+40))`
- 原来写死 300 字，真实记忆平均 72 字/条（实测 489 条，90% 分位 113 字），只够 3 条
- 现在设「直接 2 + 联想 4」能真的进 5 条、「直接 6 + 联想 3」进 6 条
- 代价：hint 从约 350 字涨到约 530~710 字（**用户已确认要效果**）

**第 1 跳改成每个起点轮转分名额**：修掉「联想全挤在分数最高的第一条」的问题，现在 6 条直接命中能带出 6 个方向的联想。

### 10. 面板「联想预览」— 2026-11-04 新增
- 记忆页新增可折叠卡片：输一句话 → 看见「直接命中 N 条 / 1 跳 N 条 / 2 跳 N 条」
- 每条标出**第几跳、分数、从谁联想过来**
- 接口 `GET /aurabot/api/memory/assoc/preview?q=`
- **后端用 `shown:false`**：预览不会把记忆算成「想起过」，不会偷偷加深记忆
- 注意：面板「翻一翻」（`/memories`）走的是 `list()`，**不经过联想扩散**，所以那边看不到跳数

---

## 四、修掉的 6 个真实 Bug（按严重度）

| # | Bug | 后果 | 位置 |
|---|---|---|---|
| 1 | `search()` 返回 `sim`，上层按 `similarity` 过滤 0.55 | **向量命中全被丢掉** | `memory-vector-local.js` |
| 2 | `!vector.validIds(...).length` 判空，但本地版返回 Set（无 length） | **语义检索永远短路返回空，且不报错** | `memory.js` `vectorHits()` |
| 3 | 签名只用「文本长度」判断改写 | **改字但长度不变时不重算，返回旧语义** | `memory-vector-local.js` `sigOfItem` |
| 4 | `vector.count()` 在 vector 为 null 时崩溃 | 关掉向量后开面板就崩 | `memory.js` `stats()` |
| 5 | 孤儿向量清理后不落盘 | 删除的记忆向量残留 | `memory-vector-local.js` `sync()` |
| 6 | 空文本也建向量 | 空文本向量全都一样，是噪声 | `memory-vector-local.js` `sync()` |

**#1 #2 #3 都是静默失效**——不报错、日志无痕，最危险。

### 联想/升档新增的 4 个 Bug（2026-11-04 模拟查出并修复）

| # | Bug | 后果 | 修法 |
|---|---|---|---|
| 7 | `Number.isInteger('core')` 为 false → `cur=-1` → `cur<3` 成立 | **长期印象被强行升成 `tier:3`**，`compressionClusters` 里 `tier==='core'` 的排除失效，长期印象被反复压缩 | 档位不是整数就直接 `return`，不参与升档 |
| 8 | `Number(g.cap) \|\| 0.85` | **`cap: 0` 是合法配置（不许自动涨），但 0 是假值被吞成 0.85**，用户调 0 完全没用 | 显式 `Number.isFinite` 判断 |
| 9 | `assocSignature` 只算记忆文字，**没算向量覆盖度** | 向量分批同步（每轮 300 条），签名不变就 `skipped` → **新补上向量的条目永远建不了边** | 签名混入「哪些 id 已有向量」 |
| 10 | `touch()` 走 `storage.save()` **绕过 `save()` 里的 `cleanAssocMap`** | 记忆被删/失效后，**指向它的脏边一直存着** | `touch()` 保存前也跑一遍 `cleanAssocMap` |

**#7 #9 都是静默的**：不报错，只是数据慢慢变脏。这 4 个都有对应的回归测试了。

### 多跳 + 联想加深阶段又抓出的 3 个 Bug（2026-11-04 深夜）

| # | Bug | 后果 | 修法 |
|---|---|---|---|
| 11 | `countDay` 拿**已经刷成现在**的 `lastHit` 判断「今天是否算过」 | 兜底分支永远成立 → **hitDays 永远不涨**，联想加深完全失效 | 只看 `lastHitDay`，删掉那个错误兜底 |
| 12 | `assocHits` 攒够就清零，即使当天已折算过 | 同一天反复联想把计数清掉又重来 → **永远折算不出一天** | 攒够但当天已算过时**不清零、封顶**，留到跨天结算 |
| 13 | `hops` 用 `Math.min(ASSOC_HOPS, ...)` 夹紧，而 `ASSOC_HOPS=2` 是**默认值** | 面板调成 3 跳**静默无效**，多跳做不出来 | 新增 `ASSOC_HOPS_MAX=3` 作为硬上限，默认值和上限分开 |
| 14 | 联想计数用 `assocHits`，而库里有 **59 条旧模块（memory-constellation）残留的 `assocHits=1` + `assocDay/assocLast`** | 旧值被当成「已攒 1 次」→ 下一次联想白捡一天、**多涨一档** | 改字段名 **`assocSeen`**，旧数据一律从 0 起算 |
| 15 | **`growTier` 把「无档位」(`tier === undefined`) 当成非法值直接 return** | **新用户所有记忆默认就是无档位**（`add()` 不设 tier）→ **记忆加深功能对新用户完全失效，永远升不了档**。只有老用户（已有档位）才看得见效果 | `if (m.tier === 'core') return`，`undefined` 按 `-1` 起算参与升档 |

另外还发现并修正一个**设计缺陷**（不是 bug）：第 1 跳会吃光全部联想名额，**2 跳永远是 0 条**，多跳等于没做。改成按跳配额分配（第 1 跳 `ceil(剩余/2)`，其余留给深跳）。

**旧模块字段清单**（认出来别当自己的）：`assocDay` / `assocLast` / `strength` / `lastStrengthAt` / `tierChangedAt` 都是 `memory-constellation` 那套留下的，共 59 条的 `assocHits=1`。当前代码**不读也不写**这些，只写 `assocSeen` / `lastHitDay` / `tierSince`。

### 与现有模块的冲突检查（重要，2026-11-05 逐条实测）

| 模块 | 影响 | 结论 |
|---|---|---|
| `memory-upgrade.test.js`（12 个升级测试） | 断言旧条目**一个字段都不能变** | ✅ 联想边存顶层 `state.assoc`，不碰条目 |
| `tierExpired()` 过期判定 | 它用 **`item.at`** 算，而升档用 `tierSince`。升档后保留期变长（tier1 7天 → tier3 90天） | ✅ 实测：40 天前的老记忆升到 tier3 后「活下来」（本来该 7 天过期）；但**最迟 90 天仍会过期，不会永久堆积** |
| `tier:0` / `tier:'core'` | 永久档和长期印象永久保留 | ✅ `growTier` 明确不碰这两个，只有 tier1/2/3 参与升档 |
| `retention()` / `shouldForget()` 遗忘曲线 | `hitDays` 参与算寿命（`strength=1+min(10,hitDays)`），联想会加分 → 更抗遗忘 | ⚠️ 符合「加深」意图。实测 hitDays≥10 后 retention 饱和在 0.672、**再加也不变**（`min(10,...)` 天然封顶） |
| `consolidate()` / `compressDetails()` 压缩 | 跳过 `tier:'core'`、`tier:0`、`abstract` | ✅ `growTier` 已不再把 `core` 改成 `tier:3`（修的是 #7） |
| `add()` 容量清理 | 只丢 `!Number.isInteger(tier)` 的无档位条目 | ⚠️ 被升到 tier2/3 的记忆受档位保护、不被容量删掉。这是「加深」该有的效果，且 tierExpired 会兜底 |
| `linkRelated()` 官方关键词边 | 与向量边完全独立 | ✅ 实测两套各自标记「相关的事」/「（联想）」，互不覆盖。**注意官方 related 只在起点被关键词命中时才扩散**，联想则能从任何已选中条目继续走——这正是联想更强的地方 |
| 检索排序 | 联想分永远低于起点分 | ✅ 实测 A=6.50 / B=5.85 / C=2.73 严格递减 |
| 上下文长度上限 | 每轮联想总量封顶 3 条 | ✅ `memory-time-related-seen` 的字数断言仍过 |
| `recallHint` 300 字限制 | 联想进 hint 也受同一截断 | ✅ 测试仍过 |

**特别注意**：`recallHint` 内部先 `recall(..., shown:false)` 再自己调 `touch(hits)`。
所以**真实聊天的召回是会加深记忆的**（不是只有面板预览才加深）——已实测确认 `assocSeen` 被写入。

### 额外修的（官方原版就有）
- `src/local/templates/README-本地接口.md` 在 rc1 里文件名是乱码（`README-鏈湴鎺ュ彛.md`），导致官方自己的 `local.test.js` 挂 2 个。已修正。

---

## 五、验证数据（全部通过）

| 测试 | 结果 |
|---|---|
| 全项目测试 | **1263 / 1266**（3 skipped，0 failed） |
| 记忆专项 | 198 / 200（2 skipped） |
| 联想专项（新增） | **27 / 27** |
| 星图专项（新增） | **16 / 16** |
| 下载器测试 | 18 / 18 |
| 端到端模拟 | 15 / 15（另一版 25 / 25） |
| 边界压力测试 | 30+ 场景全过 |

### 2026-11-05 全链路实测证据（用户重申需求后逐条复验）

| 需求 | 实测结果 |
|---|---|
| ① 通过向量库 A→B→C，不是「提到才知道」 | 查「最近老是睡不好」→ A 直接命中 ×6.50、B 第 1 跳 ×5.85、C 第 2 跳 ×2.73。**A 和 C 没有任何共同关键词**，纯靠向量边连起来 |
| ② 原版 related 确实是 0 条 | 官方 `linkRelated()` 排除 `event`/`diary`，用户库里 related 边 = **0 条** |
| ③ 面板可调 | 14 个控件全部生效：改 `hops=3 recall=5 minSim=0.7 limit=6 hopDecay=0.3 perDay=0.05 cap=0.9` 全部读到；乱填 `hops=99 recall=99 limit=999` 被夹成 `3/5/8` |
| ④ 防无限套娃 | hops=0→A、1→A B、2→A B C、3→A B C D、**99→也只到 D**（硬上限 3 生效）；40 条全互连稠密图+3 跳只带出 4 条（上限 8）、重复 0、不绕回起点 |
| ⑤ 联想到的也加深 | 联想 1 次 `assocSeen=1` 不折算；联想 2 次 `hitDays 4→5` 折算一天；再联想 100 次 `hitDays` 仍 5（一天最多 1 天） |
| ⑥ 够等级就升档 | 同一条：联想带出 → `tier=1` 不变（攒不够）；直接命中 → **`tier=3`、`importance=0.85`** |

**真实 `recallHint` 全链路**（这是关键，之前只测了 `search()` 纯函数）：
```
hint 返回：「…[今天 私聊] 最近老是睡不好；[今天 私聊] 连着熬夜刷手机；[今天 私聊] 明天要考试心里发慌」
召回日志 why：["（联想）", "（联想·2 跳）"]
存储：B/C 都记了 assocSeen=1
```
→ **联想到底能不能进真实聊天上下文：能。**

**性能基线**（不变）：
- 建索引：1000 条 1.8s / 5000 条 9.1s（分批，主线程最长阻塞 112ms）
- 检索：2 万条 42ms
- 存储：每万条约 26 MB
- 日常增量：每天约 55ms
- **联想建边：405 节点/476 边 = 121ms（纯本地，不调模型）**

---

## 六、⚠️ 当前卡住的地方

### 1. Release 里还没有模型文件（**必须解决**）

**2026-11-05 完整诊断结论**（已查到底，不用再重查）：

| 检查项 | 结果 |
|---|---|
| 30 个 release（v1.0.4 → v1.2.0-rc.1）的 assets | **全部是 0** |
| 仓库里的 `.github/` workflow | **不存在** |
| `git-rebuild` 的 `git remote -v` | **空的**（没配 remote） |
| `package.json` 的 `files` | **包含 `models`** —— 原计划是走 npm 打包分发 |
| npm registry 上的 `dsh-aurabot-qq` | **404，从未发布** |
| `git ls-files models/*` | **空** —— 模型从没提交过 |

**结论：模型的分发路线从来没落地过。**
代码按 Release assets 下载（URL 和字节数都对得上：`model_int8.onnx` 23,903,394 / `vocab.txt` 109,540），
但没人上传；`package.json` 声明 `models` 要进包，但模型既没进 git 也没发 npm。

所以：**开发机上 `models/` 就在插件目录里，一切正常；换台机器装，模型就没了。**

**三个方案（用户暂时决定先放着，说「等全部修改完了再说」）**：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A 手动传 Release**（短期推荐） | 把两个文件传到 `v1.2.0-rc.1`，代码不用改 | 每个版本都要重传 |
| **B 模型提交进 git**（长期推荐） | `models/` 只有 22.9MB，进 git 后 `files` 打包即可 | git 历史永久 +22.9MB |
| **C GitHub Actions** | 打 tag 时自动上传 | 要配 workflow + token |

文件在 `C:\Aurabot\rc1-20261104-1251\models\`
**注意**：`vector-model.js:17` 的 `MODEL_ASSETS.base` 写死了 `v1.2.0-rc.1`，换 tag 必须同步改。

**已经做好的兜底**（不管选哪个方案都受益）：§三.13 的降级提示——
模型没就绪时面板会明确说「记忆联想现在还没生效」，用户不会以为功能坏了。

### 2. 用户说「还没修改好」
已问过，用户选的是「做记忆联想 + 记忆升档」。已全部做完（见第三节 6/7/8/11/12/13）。

### 3. ~~最初的核心需求还没做~~
**已做完**：记忆联想（向量建边 + 限量召回）+ 记忆加深（行为驱动升档）。
实机已验证：477 条边、6 轮召回每轮恰好 2 条联想、14 条 importance 上涨、tierSince 已落盘。

---

## 七、代码结构

### 新增的 4 个文件（相对官方 rc1）

| 文件 | 行数 | 作用 |
|---|---|---|
| `src/features/vector-store.js` | 89 | 向量存储（base64 + 暴力点积 + 只读接口） |
| `src/features/vector-embed.js` | 151 | bge 分词/推理/归一化，onnxruntime 缺失时降级 |
| `src/features/memory-vector-local.js` | 232 | 本地索引，对齐 core 的 6 个接口 |
| `src/features/vector-model.js` | 136 | 模型自动下载器 |

### 修改的文件

| 文件 | 改了什么 |
|---|---|
| `src/features/memory-vector.js` | 加 `createVectorIndexByMode` 分派；原 `createVectorIndex` 一行没动 |
| `src/features/memory.js` | 「翻一翻」走向量；`stats()` 补 vectorReady/Mode/Model；修 2 个 bug；**联想建边 `buildAssoc` + `cleanAssocMap` + 升档 `growTier` + `touch()` 边权强化**（+258 行） |
| `src/core/config.js` | `mode` 进 normalize 白名单；默认 `enabled: true, mode: 'local'`；**`memory.assoc` / `memory.tierGrow` 两组新配置的 default + normalize 夹紧** |
| `src/modules/memory/index.js` | `/memories` 路由先算 `vectorHits`；**新增 `/memory/assoc/rebuild`** |
| `client/client.js` | 面板拆两页；「检索方式」用**原生 radio**（不能用 Select，它吃 useState 槽位会让面板测试错位）；显示下载进度；**新增「记忆联想与记忆加深」设置组 + 每条记忆显示「联想：」** |
| `package.json` | `optionalDependencies: onnxruntime-node` |
| 3 个测试文件 | 适配新布局（`capacityTest` 同时导出 `MemoryPage` 和 `Mood`） |
| `test/memory-assoc.test.js` | **新增 400+ 行 / 26 个测试**：建边清理、限量召回、多跳与防套娃、可见性隔离、升档参数与坑、旧字段残留、交付分层 |

### 关键设计决策（别推翻）

1. **`validIds` 必须返回数组，不能返回 Set** —— 上层用 `.length` 判空和当 limit
2. **`search` 必须返回 `similarity` 字段** —— 上层按这个名字过滤阈值
3. **面板「检索方式」不能用 `Select` 组件** —— 它内部 useState，会打乱测试的 hook 槽位
4. **老配置（有 baseUrl 无 mode）必须走 remote** —— 否则升级后向量断档
5. **分批同步 `SYNC_MAX_PER_RUN=300`、`BATCH=10`** —— 不分批 2000 条阻塞主线程 4 秒
6. **`recallHint` 里的 `.slice(0,4)` 已经去掉** —— 它是官方原版写死的，会让「每轮最多想起几条」调大后完全失效（实测调到 6/12 进 hint 仍是 4 条）。现在按 `recallCount + assoc.recall + recallTotal` 三层算
7. **hint 的字符预算必须跟着条数动态算** —— 写死 300 字只够 3 条（真实记忆平均 72 字/条）。现在 `min(600, max(280, 条数×75+40))`
8. **第 1 跳联想按每个起点轮转分名额** —— 不轮转的话分数最高的第一条会吃光配额，`recallCount` 调大也没用（第 2~6 条完全不参与联想）
6. **联想边必须存在顶层 `state.assoc`，不能挂到记忆条目上** —— `memory-upgrade.test.js` 断言旧条目一个字段都不能变；挂上去会让 12 个升级测试全红
7. **联想边必须和 `related` 同一套可见性桶** —— 只在同 chatId+about+scope+status 内连边，否则群友私事会漏进主人私聊
8. **升档不能用 `at` 当起点** —— 老记忆第一次凑够 hitDays 会一次涨满（0.02×90天=1.8），必须把 `tierSince` 钉在第一次结算时
9. **联想带出的条目也算加深**（用户要求），但打折：`assocPerHitDay=2` 折算 1 天，且**同一天最多折算 1 天**、`assocHits` 封顶。不限量就是「全体普涨」
10. **配置默认值和上限必须是两个常量** —— `ASSOC_HOPS=2` 是默认，`ASSOC_HOPS_MAX=3` 才是上限。用 `Math.min(默认值, 配置)` 会让面板调大**静默失效**（踩过）
11. **判断「今天算过没有」只能用 `lastHitDay`** —— `lastHit` 在 touch 里已经刷成现在了，拿它比日期永远相等（踩过，导致 hitDays 永不增长）
12. **联想名额必须按跳分配** —— 全给第 1 跳会让 2 跳永远是 0 条，多跳等于没做（踩过）

---

## 八、常用命令

### 跑测试
```powershell
$node='D:\deepseek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
Set-Location 'C:\Aurabot\rc1-20261104-1251'
& $node --test --test-concurrency=1 "test/memory*.test.js"    # 记忆专项 200 个
& $node --test --test-concurrency=1 "test/memory-assoc.test.js"  # 联想+升档 22 个
& $node --test --test-concurrency=1 "test/*.test.js"          # 全项目 1249 个
```

### 重启 DSH
```powershell
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c "C:\Aurabot\work\restart-dsh.cmd"' }
```

### 查运行状态
```powershell
# 端口在 DSH Web GUI URL 里，或者：
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -ge 40000 -and $_.LocalPort -le 65535 } | Select-Object -ExpandProperty LocalPort -Unique
# 然后：
Invoke-WebRequest "http://127.0.0.1:<端口>/aurabot/api/state"
Invoke-WebRequest "http://127.0.0.1:<端口>/aurabot/api/memories?q=<查询>"
```

### 生成 PR diff
```powershell
$git='C:\Users\Administrator\Desktop\git\cmd\git.exe'
Set-Location 'C:\Aurabot\git-rebuild'
& $git log --oneline                                  # 两个提交：upstream + feat
& $git diff 2887fb1..HEAD --stat                      # 这就是 PR 内容
```

---

## 九、下一步要做的事

### 用户核心需求 — ✅ **全部完成**（2026-11-04 23:00）

> 记忆联想（A→B→C 多跳、面板可调、防套娃）+ 记忆加深（联想到的也加深、够门槛升档）

| 需求 | 状态 | 落点 |
|---|---|---|
| 1. 向量建关联 | ✅ | `buildAssoc()` + `cleanAssocMap()`，477 边 / 405 节点 |
| 2. A→B→C 多跳 | ✅ | `search()` 联想段，`hops` 默认 2、硬上限 3、按跳配额 |
| 3. 面板可调 | ✅ | 记忆页 14 个控件 + 「联想预览」卡片 |
| 4. 防无限套娃 | ✅ | 跳数上限 / 总量上限 / `visited` 成环防护 / 跳数折扣 |
| 5. 联想也加深 | ✅ | `touch()` 里 `assocPerHitDay=2` 折算，一天最多 1 次 |
| 6. 联动升档 | ✅ | 联想攒够天数会走 `growTier()` |
| 7. 限制防失控 | ✅ | 7 道闸门见 §三.9 |

---

### ⏭️ 明天从这里开始（按优先级）

#### P0：Release 模型分发（唯一未解的硬伤，§六.1）
所有 tag 的 assets 都是 **0**（v1.0.4 → v1.2.0-rc.1）。代码是对的，但用户装完拿不到 22.8 MB 模型。
- **需要先问用户**：你的 Release assets 是怎么传的？GitHub Actions workflow，还是手动传？
- 若是手动：`model_int8.onnx`(23,903,394 字节) + `vocab.txt`(109,540 字节) 传到 `v1.2.0-rc.1`
- 若换了 tag：必须同步改 `src/features/vector-model.js:17` 的 `MODEL_ASSETS.base`
- 验证：`Invoke-WebRequest https://github.com/aureth-labs/dsh-aurabot-qq/releases/download/v1.2.0-rc.1/model_int8.onnx -Method Head`

#### P1：观察真实效果（需要时间，不是写代码）
- 联想/升档**刚上线几小时**，还没有跨天数据。明天再看：
  - `stats.tierSince` 有多少条（今天 16）
  - 档位分布有没有从 266/183/12 往上走
  - 用「联想预览」抽查几个词，看 2 跳结果是否跑题
- 如果 2 跳跑题严重 → 调高 `minSim` 或调低 `hopDecay`
- 如果记忆涨太慢 → 调低 `minHitDays` 或调高 `perDay`

#### P2：在线向量模式支持联想（可选）
`buildAssoc()` 现在要求 `vector.all()`，在线模式没有这个接口，会直接返回「当前向量实现不支持联想」。
- 要给在线模式也支持，需在 `memory-vector.js` 里补同形状的 `all()`（返回 `Map<id, Float32Array>`）
- **注意**：在线模式算向量要花钱，全库两两点积会很贵，得先问用户愿不愿意

#### P3：关键词边 `related` 要不要放开
官方 `linkRelated()` 排除 `event`/`diary`，导致用户库里 **0 条** related 边。联想层已补上语义召回，官方那套要不要一起放开——**得问用户**，别自己改（会影响可见性语义）

---

### 🔧 明天动手前先确认

```powershell
# 1. 代码是否还是同步的
$git='C:\Users\Administrator\Desktop\git\cmd\git.exe'
Set-Location 'C:\Aurabot\git-rebuild'; & $git status --short

# 2. 测试是否还是全绿（约 4 分钟）
$node='D:\deepseek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
Set-Location 'C:\Aurabot\rc1-20261104-1251'
& $node --test --test-concurrency=1 "test/*.test.js" 2>&1 | Select-Object -Last 8

# 3. 实机端口（每次重启都会变！）
#    看 DSH Web GUI URL，或：
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -ge 40000 } | Select-Object -ExpandProperty LocalPort -Unique

# 4. 联想是否还活着
Invoke-WebRequest "http://127.0.0.1:<端口>/aurabot/api/memory/assoc/preview?q=睡不好" -UseBasicParsing
```

---

## 十、当前真实数据状态

```
记忆：483 条存活（items 里另有 1 条过时）
向量库：483 条，与记忆库完全镜像
档位分布：tier0=10 / tier1=266 / tier2=183 / tier3=12（另 12 条无档位）
来源分布：event 368 / self-learn 37 / auto 30 / diary 19 / panel 12 / pipeline 12 / tool 4
关联边：related = 0 条（官方关键词建边仍未生效）
联想边：assoc = 477 条 / 405 个节点（2026-11-04 23:25 重建，121ms）
tierSince：16 条（升档已在实机真实发生）
配置：config.json 里 assoc={enabled:true, minSim:0.45, limit:4, recall:3, hops:2, hopDecay:0.55}
      tierGrow={enabled:true, perDay:0.02, minHitDays:3, cap:0.85, assocPerHitDay:2, ...}
```

**面板实测**（2026-11-04 23:25，端口会变，看 DSH Web GUI URL）：
```
stats: count=483 vector=483 vectorReady=true assoc=477 tierSince=16
「睡不好」→ 直接命中 6 + 1 跳 2 + 2 跳 1（1 跳 3.85/3.76，2 跳 1.53）
「考试」  → 直接命中 3 + 1 跳 2 + 2 跳 1（1 跳 7.61/6.75，2 跳 3.31）
「做饭」  → 直接命中 6 + 1 跳 2 + 2 跳 1
```

---

## 十一、注意事项（踩过的坑）

1. **别把 `models/` 提交到 git** —— 22.8 MB，改走 Release 下载
2. **测试需要 `node_modules`** —— `git-rebuild` 里没有，可以临时 junction 借用，用完 `cmd /c rmdir` 移除（**别用 Remove-Item -Recurse**，会删到目标）
3. **`git-rebuild` 里的 `node_modules` junction 已经清理**，真实 `node_modules` 在 `rc1-20261104-1251`
4. **改完代码要重启 DSH 才生效**
5. **面板改动后浏览器要 Ctrl+Shift+R 强制刷新**
6. **备份在 `C:\Aurabot\backups\`**，包括 git bundle：`git-history-20261104-210341.bundle`
   - 联想前：`pre-assoc-20261104-220829`
   - 修 bug 前：`pre-fix-20261104-224345`
   - 多跳前：`pre-hop-20261104-230042`
7. **`memory-upgrade.test.js` 是条硬线** —— 它断言旧条目「文字、时间、tier、过时历史均不变」。任何往记忆条目上加字段的想法都会被它拦下，联想边因此存在顶层 `state.assoc`
8. **重启会杀掉当前 DSH 会话** —— 用 `restart-dsh.cmd`（内含 10 秒延迟），**每次重启端口都会变，必须用新的 DSH Web GUI URL**
9. **改配置要重启才生效** —— 插件把 config 读进内存了，改 `config.json` 后不重启读不到
10. **面板「翻一翻」不显示联想** —— 它走 `list()`，不经过联想扩散。要看跳数用「联想预览」卡片或 `/memory/assoc/preview`

---

## 十二、和用户沟通的要点

- 用户**就是官方**（Aurabot 项目 owner），不用请示外部维护者
- 用户明确说过：**分发他有办法**（走 Release）、**默认要开启**（否则用户不知道就不会开）
- 用户说「**不要提交 PR，我还没修改好，只是测试能不能交**」—— 所以**先别推 PR**
- 用户在意「布数太多、缓存命中太多」—— 说明他关心上下文效率，回复要简洁、别重复已验证的结论
