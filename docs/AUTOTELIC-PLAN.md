# 自驱引擎 · 实施方案 v3

> 上游约束：`docs/AUTONOMY-NOTES.md`（讨论结论）。本方案**不得违反其中任何一条**，
> 冲突时以那份为准。
>
> 基线：`local/runtime` @ `4c362d0`。实测 **1357 / 1353 pass / 1 fail / 3 skip**
> （挂的是 `test/output-guard.test.js:277`，Temp 目录 rename EPERM，**环境问题非代码问题**）。
> 本方案分**五期**（§3 P0~P4），每期可独立验收。
>
> **修订史**：
> - **v1**（初稿）：按讨论结论写成五期。
> - **v2**（第一轮独立审查后）：修 3 处硬伤、补 5 处遗漏。
> - **v3**（第二轮独立审查后）：**再修 2 处致命错误** ——
>   ① 审计「物理隔离」不成立（本机 `danger-full-access`），改为哈希链对账口径；
>   ② 「含 pwsh 的任务禁读私密数据」不可实现，首期直接不给 pwsh。
>   另修正：`level` 不能动（会让她拿到主人工具）、`presetId × noTools` 优先级、`config.id` 取值、
>   `dataDir` 路径写法、token 预算（有数据源非无）、`quiet` 要自己判、`isOwnedSession` 过滤不够。
>   删除错误段落：§6「会让 6 处断言失效」（按 v3 实现那四处一条都不会挂）。

---

## 0. 一句话

给她**一间自己的屋子**（独立会话）、**一本别人代记的账**（机械日志）、**一双手**（工具），
以及**一道动手前的闸**（`tools/pre-execute`）。

---

## 1. 已定死的约束（来自讨论笔记 + 后续确认）

| # | 约束 | 落点 |
| --- | --- | --- |
| C1 | **她可以骗主人，但不能骗账本** | 账本由钩子机械记录，不经她手（含 §4.1 四条补强） |
| C2 | **她禁止修改框架代码**，但**可以自己写用户模块** | 见 §1.1：`src/` 对她锁死，`modules/` 开放 |
| C3 | **她的行为不混进主人私聊** | 用独立 `system:autotelic*` 会话 + 新 preset，绝不 `pushToSession` 到主人私聊 |
| C4 | 能力到「能跑命令」为止，**不算学会除非复现 2 次** | §3 P4.2 技能库 |
| C5 | 她可调自己的频率/时段/上限，但**必须有上限**，调参数本身进日志 | §2.2 `tune` |
| C6 | 她**可以写 Python 脚本** | 见 §1.2，含解释器约定 |
| C7 | 全量日志落盘，**不与会话历史绑定** | 会话会被 compaction 压缩（已核实） |

> **⚠️ C2 的歧义已澄清**：C2 约束的是**她**，不是我们。
> 主人已明确「可以改动框架」（讨论笔记 §7），所以**本方案可以改 `src/`** ——
> 那是我们的开发行为，与「她不许改」是两件事。

### 1.1 C2 的准确说法：「模块」分两级

少爷要求「她能自己开发模块扩展」，与「她禁止改框架」并不矛盾 —— 是**两个不同目录**：

| 类别 | 位置 | 是谁的 | 给她？ |
| --- | --- | --- | --- |
| **框架代码** | `repo/src/**`（`modules/`、`chat/hub.js`、`core/`） | 插件本体，升级即覆盖 | ❌ **锁死** |
| **用户模块** | `~/.dsh/plugins-data/aurabot/modules/<id>/` | 她自己写的，升级不动 | ✅ **开放（L1）** |

代码依据：
- `modules.js:33` `userDir() = dataDir('modules')` —— 用户模块在**数据目录**，不在仓库里；
- `modules.js:88` `scanUser()` 扫这个目录；
- `modules.js:783` 3 秒 watcher 自动热加载；
- `modules.js:657` 启动日志区分「（自己写的）」与「（模块市场）」。

**⚠️ 「写坏会自动回退」只对同名替换成立**（2026-11-04 核实）：
`modules.js:743` 的回退条件是 `fallback: builtinDefs.has(u.id)` —— **只有内置里有同 id 的模块才有兜底**。
她新造的 id（如 `kuaishou`）没有同名内置，写坏了就是**该模块不可用**，只在面板报错，
需要人工清理 `modules/<id>/` 目录。方案不能给这条虚假的安全感。

> 结论：**铁律不变** —— 她能写 `modules/<id>/`，但永远写不到 `src/`。
> 这也让「改人格」和「加能力」两条路都通了（人格是 `.md` 数据、能力是用户模块）。

### 1.2 C6 的准确说法：Python 脚本

**不许写死解释器名。** 各家机器差别极大：可能叫 `python` / `py` / `python3` / `python3.12`，
可能装了多个版本，**也可能根本没装**。所以一律**运行时探测**，不预设。

#### 探测顺序（逐个试，第一个能跑通的胜出）

1. **配置项** `ext.autotelic.pythonBin`（若已填且校验通过 → 直接用）；
2. `python` → `py` → `python3` → `python3.13` … `python3.9`（逐个 `--version` 实测）；
3. 都失败 → **判定「本机没有可用 Python」，关闭 Python 能力**，面板提示主人手动填路径。

#### 探测要滤掉三类假货（否则会误判成「装了」）

| 假货 | 判别方法 |
| --- | --- |
| Microsoft Store 占位别名（0 字节） | `Get-Command` 命中且在 `WindowsApps` 下、文件大小为 0 → 跳过 |
| 能启动但不是 Python | 实际执行 `<cand> --version`，输出不含 `Python 3.` → 跳过 |
| 版本过低 | 主版本 < 3 → 跳过（本方案要求 Python 3） |

> **本机佐证（2026-11-04 实测，只作例子，不进代码）**：`python`=3.11.9（带 pip）、
> `py`=3.13.7 可用；而 `python3` 命中 `WindowsApps\python3.exe`、**大小为 0**，是商店占位符 ——
> 正是「只按名字找会踩空」的活例子。

#### 探测结果怎么存

- 成功后缓存进 `api.dataDir('env.json')`（`{ pythonBin, version, probedAt }`）—— **不带模块名**，`api.dataDir` 已自带；
- **校验节奏（与实现对齐，2026-11-05 审查修正）**：24 小时内直接用缓存（`python.js` 的 `envUsable`），
  超 24h 或主人改了配置路径才重新探测；面板有「重新检测」按钮可手动触发；
- 面板显示当前用的哪个、版本多少，主人可手动改。

#### 约定

- 脚本落 `api.dataDir('scripts')`，产物落 `api.dataDir('out')` —— **不带 `autotelic`**（模块内 `api.dataDir` 已自动带）；
- Python 进程**不继承插件的敏感环境变量**（尤其 API key 类）；
- **没装 Python 不影响其他功能** —— 只是这项能力不可用，其余照常。

---

## 2. 落地形态

### 2.1 新建模块

```
src/modules/autotelic/
  index.js          模块壳（照 purpose/index.js 的写法）
src/autotelic/
  engine.js         纯函数：好奇判分 / 立项 / 选步（零 IO，可单测）
  book.js           账本：tasks / steps / 预算 / 每日一页（纯数据 + 落盘）
  tools.js          她这一轮可用的工具集（定义在 preset 侧，这里只做 schema 导出）
  audit.js          机械审计：接收 pre-execute 事件，全量落盘
  reflect.js        反思与技能库
  code.js           P3 用：用户模块生成 + Python 脚本执行（子进程）
src/chat/hub.js     小改：system 会话的 level 判定可被 chat 上的标记覆盖
cordis.patch.yml    新增 preset：preset-aurabot-autotelic
src/host.js         小改：把 pre-execute 审计钩子接上
src/modules/index.js  注册新模块
```

**她产出的东西落在数据目录，不进仓库**：

```
~/.dsh/plugins-data/aurabot/
  modules/<id>/                 ← 她自己写的用户模块（Aurabot 自己的 3 秒 watcher 加载）
  modules-data/autotelic/       ← 注意：模块内 api.dataDir() 已自动带上这个前缀
    audit/YYYY-MM-DD.jsonl      ← 机械审计流水
    ledger.json                 ← 任务账本
    scripts/*.py                ← 她写的 Python 脚本
    out/                        ← 脚本产物
    skills/<id>/                ← 技能库
    proposals/*.md              ← 提案（给自己加能力，等主人批）
```

**⚠️ `api.dataDir()` 的路径语义（2026-11-04 审查发现，已核实 `modules.js:511`）**：

```js
dataDir: (...parts) => { const d = dataDir('modules-data', id); ...; return join(d, ...parts) }
```

- **模块内**：`api.dataDir('audit', 'x.jsonl')` → `modules-data/autotelic/audit/x.jsonl` ✅
- **模块内写错成** `api.dataDir('autotelic', 'audit')` → `modules-data/autotelic/autotelic/audit` ❌（多一层）
- **host 侧**（`host.js` 里拿不到 `api`）：必须 `dataDir('modules-data', 'autotelic', 'audit')`

**审计目录必须移出「她能写」的子树**（见 §4.1 的 C1 补强）。

### 2.2 新增配置键（`config.ext.autotelic`）

```
enabled: false                 // 默认关
minCuriosity: 0.55             // 好奇分阈值，不够不立项
maxSteps: 8                    // 单任务步数上限
maxTasksActive: 8              // 同时进行的任务数
budgetTokensPerDay: 200000     // ⚠️ 见下方注：首期可能拿不到数据源
budgetActionsPerHour: 12
// l2PerDay: 3                 // 首期删除（白名单外一律拒绝，见 §4.8；确认通道做好再加回）
quietFrom / quietTo            // 安静时段（可跨午夜）
dailyReviewHour: 23            // 几点出「每日一页」
minBatchForReview: 3           // 攒够几件才评（C：攒 3 件或满一天，先到者为准）
dreamFrom / dreamTo            // 「做梦」窗口（默认 03:00 / 05:00，留空=关闭做梦）
tune: {}                       // 她自己调的参数（叠在上面，带上限钳制）
allowUserModules: true         // 允许她写用户模块（modules/<id>/）
allowPython: true              // 允许她跑 Python 脚本
pythonBin: ''                  // 留空 = 自动探测（见 §1.2）；填了就校验后直接用
scriptTimeoutMs: 120000        // 单次脚本超时
```

**她可调的子集**（C5）：`quietFrom / quietTo / dailyReviewHour / minBatchForReview`，
以及 `maxSteps`、`budgetActionsPerHour` 的**向下**调整。
**不可调**：`enabled`、`allowUserModules`、`allowPython`、各类预算的**上限值**。

**⚠️ `budgetTokensPerDay`：有数据源，但首期不接**（第二轮复核修正了阿娘上一版的「没有数据源」）：

`src` 内确实没有计量代码，**但 DSH 的 `session/event` 里 `assistant/message` 事件自带 `usage`**
（`totalTokens` / `inputTokens` / `outputTokens`），而 `host.js:794` **已经在监听 `session/event`**。

→ 所以：**首期只启用「动作/小时」和「单任务步数」两项**（够用、简单）；
**token 预算 P2 计划接（从 `assistant/message` 的 `usage` 累加），截至 2026-11-05 审查尚未接**（实现里无计量、无测试），
文档如实标注为**延后项**，不要在 P0 假装它有。

---

## 3. 五期实施

### P0 · 地基（不动她，先让账能记）

**目标**：把「机械日志」和「独立会话」两个地基铺好，她一行代码都不会自己跑。

| 步 | 内容 | 文件 |
| --- | --- | --- |
| 0.1 | 新增 preset `preset-aurabot-autotelic`（`config.id` 必须是 **`aurabot-autotelic`**）。**插在 `preset-aurabot-social` 之后**，`order` 取 **63**。**首期不带 `tool-pwsh`**（见 §4.7） | `cordis.patch.yml` |
| 0.2 | **`createSession`（`hub.js:433`）接受 `chat.presetId`**：`const preset = (!chat.noTools && chat.presetId) \|\| presetFor(level, getConfig())`。**实际实现还套了一道总闸 `ext.autotelic.presetIdOverride`（默认关）**——闸门不开时 presetId 整路失效，见 §9 悬案 1（已采纳为开关） | `src/chat/hub.js:433` |
| 0.3 | **`hub.js:466` 的复用键把 presetId 纳入**；**`level` 判定（463）不改**（见下） | `src/chat/hub.js:466` |
| 0.4 | `runSystemTurn` 的 opts 增加 `presetId` 透传（默认 `undefined`，**行为完全不变**） | `src/chat/hub.js:2241` |
| 0.5 | `host.js` 挂 `tools/pre-execute` **审计钩子**（异步入队、失败静默）；结果从 `session/event` 取 | `src/host.js`、`src/autotelic/audit.js` |
| 0.6 | 模块壳 + `/autotelic/status` 路由，面板显示「审计已开启 / 今日 N 条 / 链校验」 | `src/modules/autotelic/index.js` |

### ⚠️ 关键决策：**只改 433，level 一动不动**（第二轮复核 🔴）

阿娘 v2 曾在 0.3 写「level 判定加短路」，**那会出事**（已核实）：

若让 system 会话的 level 变成 `full`，这些地方会跟着变：
`qq-tools:21/104/167/195/206`、`diary:40`、`qq-api:120`、`stickers:172` 都有 `level === 'full'` 判定
—— **system 会话会拿到主人专属工具**。

→ **最终定死：`hub.js:463` 的 level 判定与 `access.js:36` 的 `presetFor` 都不改。**
只改 `createSession` 取 preset 的来源（加 `chat.presetId`）+ `hub.js:466` 的复用键。

**下游消费者不受影响的理由**：`mount(agent, chat, level)`（`hub.js:503/563`）里，
level 仍是 `social`，所以 `buildTools` 照常调用（`566`：只跳过 `chat`），
`autotelic` 自己 `api.tool()` 注册的工具**照样挂上**；`pwsh`/`fs` 来自 preset 插件清单，也不受影响。

### ⚠️ `presetId` × `noTools` 的优先级：**写死 `presetId && !chat.noTools`**

现有 **4 处**调用方传 `noTools: true`：`purpose/module.js:401/627/688`、`features/qzone.js:188`。
若让 `presetId` 无条件优先，这些「不该有工具」的回合会拿到带工具的 preset（`mount` 跳过模块工具，
但 **preset 插件工具照挂**）—— 等于给纯文本回合装了 pwsh。

→ `hub.js:433` 写成 `(!chat.noTools && chat.presetId) || presetFor(level, getConfig())`。
**`noTools` 永远压过 `presetId`。**

### ⚠️ `config.id` 的取值

`presetFor` 返回的是 **`aurabot-private` / `aurabot-social`** 这种 `config.id`（`access.js:36-39`），
不是 `preset-aurabot-private`。所以：

- `cordis.patch.yml` 里条目 id 写 `preset-aurabot-autotelic`，**`config.id` 写 `aurabot-autotelic`**；
- `chat.presetId` 传的必须是 **`aurabot-autotelic`**。

### ⚠️ 新 preset 的位置（避免打挂测试）

`test/subagent-delegation.test.js:196-197` 从 `preset-aurabot-subagent` 切到首个 `- id: preset-aurabot-social`。
**插在 social 之后就不进切片，安全。**

另注意 `test/long-tasks.test.js:24` 禁 `agent-team` 字样 —— 新 preset 别带这个词。

**验收**：
- 关着 `autotelic.enabled`，全仓 1357 项测试**一项都不许挂**；
- 手动触发一次 `runSystemTurn(..., { presetId: 'aurabot-autotelic' })`，`system:` 会话里能拿到
  `autotelic` 自己的工具，**且拿不到 QQ 社交工具、拿不到 pwsh**；
  且**拿不到 QQ 社交工具**；
- **连续两轮调用不重建会话**（复用键生效，日志里只出现一次「新建了 DSH 会话」）；
- 任何工具调用都在 `audit/*.jsonl` 里有一条，**且模型拿不到删改它的工具**。

### P1 · 只读的自主（她会想，但不出门）

**目标**：跑起「感知 → 好奇 → 立项 → 落账」的闭环，**全程 L0**。

| 步 | 内容 |
| --- | --- |
| 1.1 | `engine.js`：复用 `api.lib('purpose/engine.js')` 的**纯函数**（`deriveDrives` / `textSimilarity` / `needAffinity` / `appraiseMaterial`）；**素材采集要自己重写**，见下 |
| 1.2 | 好奇评分：可复算公式 + 一次便宜模型自评（可关）；阈值 `minCuriosity` |
| 1.3 | `book.js`：`tasks` / `steps` / `budget` 状态机 + `pruneLedger`（活跃 ≤8、总量 ≤40） |
| 1.4 | 死循环熔断：`(tool,args,observation)` 指纹，同指纹 2 次即 `abandoned` |
| 1.5 | `/autotelic/preview`：零副作用预览（今天会立什么项、为什么、分数多少） |
| 1.6 | 面板：任务列表 + 每条的理由（`reason` 必填，防拍脑袋） |
| 1.7 | **立项前预审**（2026-11-05 少爷定）：候选进账本之前先用「审查员视角」判一次值不值得办，不值得直接不立项（记冷却 + 审计 `autotelic/screen`）。常开、无开关 |

**⚠️ 1.1 不能指望「复用 `collectMaterials` 就完事」**（2026-11-04 审查，已核实）：

`collectMaterials` 是 `engine.js` 的纯函数，它需要调用方**先喂三样东西**：
`conversations` / `biliEntries` / `memoryRecords`。
而这三样在 `purpose/module.js` 里是由**未导出**的 `conversations()`（`:144`）、
`memoryRecords()`（`:123`）现做的 —— `api.lib()` 拿不到。

→ **P1 必须自己写素材采集**（照 purpose 的写法抄，但放在 autotelic 里）。
这也意味着「复用」的实际范围比想象小：**能复用的是判分与驱动，不是采集。**

**验收**：见 §5 场景 1~4、6。

### P2 · 会动手（L1：先调已装模块，再跑命令）

**目标**：她能做事，但动作**有优先级**：调已经装好的模块 > 跑命令。

| 步 | 内容 |
| --- | --- |
| 2.1 | `exec.js`：分级执行器。见 §4.4 的动作优先级 |
| 2.2 | **调模块：由 `autotelic` 模块自己 `api.use()` 包一层自有工具**（不能指望模型直接拿到别的模块的 tool） |
| 2.3 | L1 的判定用 `tools/pre-execute` 钩子做**第二道**（第一道在提示词） |
| 2.4 | 反思器：任务结束写「假设 / 证据 / 教训」进 `memory.addEvent({ kind:'seen' })` |
| 2.5 | 每日一页：`dailyReviewHour` 或攒够 3 件触发，强制含「今天没敢说的」**段落**（内容不约束） |
| 2.6 | 她自己调参数的路由 `/autotelic/tune`（**带上限钳制**，动作进审计） |
| 2.7 | **「做梦」**（见 §10.1）：安静时段最深处（默认 03:00~05:00）触发一次离线整理 —— 把当日审计摘要 + 失败任务 + 反思蒸馏成 3~5 条长期记忆。复用反思器，**做梦本身也进审计** |

**⚠️ 2.2 原先写的「先调 `api.use('douyin')`」做不到**（2026-11-04 审查发现，已核实）：

- 她在 `system:` 会话里，**各模块的 tool provider 一律对 system 返回空**：
  `bili/index.js:34`、`qq-tools:86`、`stickers:22`、`imagegen:56` 等都是 `chat.kind === 'system' → []`；
- `api.use()` 是**模块代码里的 API**，模型在会话里根本调不到。

**正确做法**（本方案取这个）：

> `autotelic` 模块自己 `api.use('douyin')` 拿到导出，然后
> **用 `api.tool()` 注册成「autotelic 自己的工具」**暴露给模型。
> 模型看到的是 `autotelic_*` 这类工具，实际动作由模块转调。

好处：不动任何现有模块的门（不违反 C2），也不需要改各模块对 system 的过滤。

**代价（要说明）**：每接一个模块，都要在 `autotelic` 里写一层适配。这是**显式成本**，可控。

**验收**：见 §5 场景 5、7、8、10、14、21。

### P3 · 会写代码（用户模块 + Python 脚本）

**目标**：她能给自己造新能力，但**写不到框架里**。

| 步 | 内容 |
| --- | --- |
| 3.1 | **用户模块**：她写 `~/.dsh/plugins-data/aurabot/modules/<id>/index.mjs`，**Aurabot 自己的 3 秒 watcher**（`modules.js:783`）自动热加载 |
| 3.2 | 写前校验：跑 `checkDef`（`modules.js:102`）；同名替换坏了回退内置，**新 id 坏了只是该模块不可用** |
| 3.3 | **Python 探测**：按 §1.2 的顺序运行时探测，滤掉商店占位别名与假货，结果缓存 `env.json` |
| 3.4 | **Python 脚本**：落 `api.dataDir('scripts')`（**不带模块名**），用**探测到的解释器**调用 |
| 3.5 | 脚本执行：子进程 + `scriptTimeoutMs` 超时 + **不继承敏感环境变量** |
| 3.6 | **没装 Python 时优雅降级**：能力标记不可用，面板提示主人填路径，其余功能不受影响 |
| 3.7 | 产物落 `api.dataDir('out')`；执行记录进审计日志 |

**验收**：见 §5 场景 15、16、17、18。

### P4 · 会说、会学（把「想说话」接回 purpose，把「学会」入库）

| 步 | 内容 |
| --- | --- |
| 4.1 | 「想说一句」**不直发**，交给出站治理决定何时说（**接口待补**，见下） |
| 4.2 | 技能库：`skills/<id>/{manifest.json,run.mjs,verify.mjs}`，**复现 2 次成功**才 `status:'learned'` |
| 4.3 | 技能只经子智能体跑（`runSubagentTurn`），不进程内 `import` —— 隔离以便观察与终止。**⚠️ 本期未实现**（2026-11-05 审查确认）：前置的 `plugin-internals` 声明与 `subagentBackground` 都没开，**技能当前走 `runPython` 子进程直跑**（`skills.js` 注释自认）。按本条验收会误判 |
| 4.4 | 提案通道：她写 `proposals/*.md`，面板列出，**她不改框架代码** |

**⚠️ 4.1 原写的「写进 purpose 的 pending」这条链路不存在**（2026-11-04 核实）：

- purpose 的导出面是 `{ tick, fire, state, status, preview, run, drivesRule, brokerReview, setEnginePolicySource }`（`purpose/module.js:815`），**没有写 pending 的接口**；
- `addPendingPurpose` 在 `engine.js` 里，但没经模块导出，外部拿不到。

二选一（开工前定）：

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A | 给 purpose 加一个导出 `addPending(text, { reason })` | 要改 purpose 模块（小改，但要回归它的测试） |
| B | **直接走 `api.proactive.submit`**，由出站治理统一排程 | 不碰 purpose；但绕过 purpose 的「攒着评」语义 |

**建议 B**：出站治理本来就是唯一投递口（`modules.js:586`），少一层耦合；
「攒着评」由 autotelic 自己的 `minBatchForReview` 实现，不需要 purpose 参与。

**⚠️ 但 B 也有前提，原方案没写**（2026-11-04 审查，已核实）：

1. `api.proactive.submit` 只在 `tier === 'broker'` 时放行，**默认 `tier='pass'`**（`outbound-policy.js:20`），
   新装机一律返回 `unsupported`；
2. ~~她这一轮是文本输出，不是工具调用——由模块解析她的输出再调 submit~~
   **实现走了另一条路（2026-11-05 审查修正，与实现对齐）**：注册了 `autotelic_propose_say` 工具
   （`index.js:204-225`），**她自己决定什么时候调**。行为没问题（broker 未开时优雅报 unsupported）；
   但要注意：这也意味着「说不说」的最终扳机在她手里的一次工具调用上——
   「攒着评」的闸门要靠工具入参前的自评约束，审计里能看到每次调用。

→ 所以 P4.1 实际要做三件：**① 明确写运输通道 ② 首期要求主人把 `outboundPolicy.tier` 设成 `broker`
③ 没有 ready 策略源时会返回 `dropped`，要能优雅处理**。

**⚠️ 4.3 子智能体的两个硬前提**（2026-11-04 审查，已核实）：

1. `runSubagentTurn` 要求 `moduleId` 在 `module.json` 里声明 `plugin-internals`
   （`hub.js:2461`，`capabilitiesOf` 读 `BUILTIN_DIR/module.json`）——
   **而 `src/modules/**` 下目前没有任何 `module.json`**，需要给 `autotelic` 补一个；
2. `system` 来源还要 `config.subagentBackground === true`（`config.js:25` 默认 `false`）。

这两条不满足，P4.3 **跑不起来**。

---

## 4. 关键机制的技术落点

### 4.1 「机械日志」怎么做到不经她手

已核实：`host.js:697` 已有 `ctx.on('tools/pre-execute', (exec, next) => dangerGuard.preExecute(exec, next))`。

审计钩子**挂在同一个事件上**，且：

- **只记录，不改变放行结果**（永远 `return next()`，除非命中 L2 判定）；
- 记录字段：`at / sessionId / tool / args(截断) / chatId`；
- 模块**不暴露任何删改审计文件的工具**。

**⚠️ 2026-11-04 审查发现三处必须补强（阿娘已逐条核实）**：

**① 审计隔离：物理隔离这条路走不通，改用「对账」口径。**

阿娘 v2 曾写「审计放 `modules-data/autotelic-audit`，与数据目录平级」——**这是错的**（第二轮复核指出，已核实）：

- `modules-data/autotelic-audit` 与 `modules-data/autotelic` **同在一个根下、ACL 完全相同**；
- 本机 profile（`~/.dsh/profiles/desktop/cordis.patch.yml:120`）写死 **`defaultPreset: danger-full-access`**，
  且 `approval: never`（同文件 `:117-119`）；
- `createSession`（`hub.js:434`）不指定 sandbox，**直接继承**；
- DSH 对 `danger-full-access` 的定位就是「不作限制」。

→ **结论：只要她有 `pwsh` + `fs`，一条 `Remove-Item` 就能删掉审计文件。靠目录隔离挡不住。**

所以 C1 的真实口径改成：

| 手段 | 能不能 |
| --- | --- |
| 目录物理隔离 | ❌ **挡不住**（同权限域） |
| 不给她指向审计目录的工具 | 🟠 只防「顺手」，不防「主动找」 |
| **哈希链 / 条数+字节日结** | ✅ **唯一可靠的手段** —— 删改会破坏链，面板能验出来 |
| **外部副本**（每天把审计摘要写到别处，如备份仓） | ✅ 更硬的兜底 |

**首期必须做**：审计每行带 `prevHash`，形成**哈希链**；面板「校验」按钮验证链连续。
她能删，但**删了必然断链**，主人能看见断点。

> 这条要诚实写进文档：**审计的可靠性不来自「她改不了」，而来自「改了会露」。**

**② `pre-execute` 只拿得到「意图」，拿不到「结果」。**
DSH 执行链是 `tools/pre-execute → guards → tools/execute → post-execute → result`。
在 pre-execute 记 `outcome` 记不到，且后续 guard 仍可能 deny —— 会把「想干」记成「干了」。

→ 改成：**两处都要挂**。`pre-execute`（`host.js:697`）记意图，
**结果**从 `session/event` 的 `tool/result` 事件取（`host.js:794` 已在监听 `session/event`，
`assistant/message` 事件还自带 `usage`）。**注意：结果不是另一个 `tools/*` 瀑布。**

**③ 非工具路径也要有口径。**
`api.ask`（`modules.js:580`）、`api.think`（`:581`）、`api.proactive.submit`、`hub.deliver/sendText`
**都不经过** `pre-execute`。她走这些路做的事，账本里没有。

→ 首期口径写死：**这些路径由 `autotelic` 模块自己在调用处记账**（模块是可信代码），
并明确「审计覆盖 = 工具调用 + 本模块的显式调用」，不假装覆盖一切。

**诚实的边界**：

| 能挡住 | 挡不住 |
| --- | --- |
| 她**调用了什么工具、参数是什么** —— 钩子在宿主侧 | 她**纯靠上下文推理**、什么都不调 —— 账本就是空的 |
| 事后对账：她自述 vs 实际动作 | 她**心里想过什么**（这本来也不该记） |
| **删改必然断链**，面板能验出断点 | 她**真删了** —— 你只会看到「这里断了」，看不到原文 |

> C1 的准确说法：**她做过的事骗不了账，但她可以什么都不做，也可以把账撕了——
> 撕了你会知道。**

**④ 进程级钩子会记到主人头上，且过滤不能只用 `isOwnedSession`。**
`tools/pre-execute` 是进程级的（`danger.js:477` 注释明说）。

**⚠️ 但 `isOwnedSession` 不等于「她的会话」**（第二轮复核指出，已核实 `hub.js:2352`）：
它判的是「这个 session 有没有映射到 QQ 会话」，**主人自己的 QQ 私聊和群聊也算**。
用它过滤，会把主人与群友的工具调用全记进她的账本。

→ 正确过滤：**`chatOfSession(sessionId)` 得到 chatId，再判是否以 `system:autotelic` 开头**。
两层条件都要：`isOwnedSession()` 且 `chatId.startsWith('system:autotelic')`。

参考：`dangerGuard` 只处理 `bash`/`pwsh`（`danger.js:470-472`，`dangerConfirm` 默认 `false`，`config.js:42`）。
但方案挂的是自己的钩子，可以记所有工具名。

**⑤ 钩子绝不能同步写盘。**
`pre-execute` 是**进程级 waterfall**，同步写文件会拖住**所有**工具调用（包括主人在 GUI 里的）。
§7 写的「只做 `appendFileSync` 一行」是错的。

→ 统一为：**异步入队 + 失败静默**（`pre-execute` 里只 push 到内存队列，立刻 `return next()`；
落盘由独立定时器批量 flush）。

### 4.2 「独立会话 + 工具」怎么共存

- 现状：`hub.js:463` 是 `chat.kind === 'system' ? (chat.noTools ? 'chat' : 'social') : levelFor(cfg, chat)`；
  「social 零工具」的**真正原因不在 preset**，而在**各模块的 tool provider 对 system 一律返回 `[]`**
  （`bili:34`、`qq-tools:86`、`stickers:22`、`memory:35`、`qq-api:119`）；
- preset 侧新增 `preset-aurabot-autotelic`，**照抄 `preset-aurabot-subagent` 的工具清单**
  （**首期去掉 pwsh**，见 §4.7；保留 fs / fs-search / compaction），**不带 QQ 社交工具**。

**✅ 已核实的关键事实（这决定了 P0 只改一处就够）**：

`buildTools`（`modules.js:901-917`）**不看 `chat.kind`**，它只是把 `where` 透传给每个 builder（`:907`）；
过滤是**各模块自己**在 builder 里做的。而 `mount`（`hub.js:566`）**只在 `level === 'chat'` 时整体跳过**。

→ 所以 `system:` 会话只要 `noTools !== true`，level 就是 `social`，
**`buildTools` 照常执行**，`autotelic` 自己 `api.tool()` 注册的工具就能挂上。
**不需要动 level，也不需要动 `presetFor`。**

`presetFor`（`access.js:36-39`）只认三条 preset 这个事实仍然成立 —— 所以我们**绕开它**：
在 `createSession` 里用 `chat.presetId` 直接给 preset，而不是去改 `presetFor` 的映射逻辑。

**P0 实际只改两处**（就是 §3 的 0.2 与 0.3）：

| # | 位置 | 改什么 |
| --- | --- | --- |
| 1 | `hub.js:433`（`createSession`） | `const preset = (!chat.noTools && chat.presetId) \|\| presetFor(level, getConfig())` |
| 2 | `hub.js:466`（复用键） | 把 presetId 纳入比较，避免「preset 变了但复用旧会话」 |

**`hub.js:463`（level）与 `access.js:36`（`presetFor`）都不动** —— 动了会让 system 会话拿到主人专属工具（见 §3）。

**另一个坑：`level` 是会话复用键**（`hub.js:466`）：
`entry.preset === preset && entry.level === level ? 复用 : 新建`。
改了 preset 会**触发一次会话重建** —— 预期行为（旧会话不该复用），但要在日志里说清楚。

### 4.3 L2（需确认）怎么落地，以及「确认死锁」

**死锁问题**：`dangerGuard` 在危险命令上会**要求主人回「确认」**（`danger.js` 的审批分支），
但她在**自己的会话**里跑，那个确认没有主人收 —— 会**永久卡住**。

结论：**她的 L2 不能复用「等主人确认」那条路径**。改为：

| 方案 | 做法 |
| --- | --- |
| a | 面板一次性令牌：主人在面板点「允许这次」，令牌 5 分钟有效，绑定该任务 |
| b | 白名单：只放行事先列明的命令模式，不在名单内一律拒绝（**首期用这个**） |

首期取 **b**：不做动态确认，只放行白名单里的命令形状；她要跑名单外的东西，只能提案。

### 4.4 动作优先级（少爷 2026-11-04 确认）

```
L0 只读（任何工具）                                  → 自动
L1-a 调已装模块（经 autotelic 自己包装的工具）         → 自动 + 记账  ← 首选
L1-b 写自己的数据目录 / 用户模块 / 跑 Python 脚本      → 自动 + 记账
L2   跑白名单外的 shell 命令 / 调 onebot / 发消息      → 拒绝（首期）
```

**为什么调模块优先**：模块自己管好了边界（超时、只读/写入、平台协议），
比自己拼 shell 命令安全得多，也省 token。

**⚠️ 调用前固定三步**（2026-11-04 核实）：

1. **模块得装着**：`api.use('id')` 在模块没跑时返回 `null`，得先 `api.has('id')`；
2. **模块得开着**：本机实测 `douyin.enabled = true`、`phone.enabled = false`
   —— 没开的模块 `api.use()` 拿到 `null`；
3. **由 `autotelic` 自己 `api.use()` 再包成自有工具**（模型在 system 会话里拿不到别的模块的 tool，见 P2.2）。

查不到就走「自己写」分支，**把「本机没有这个能力」写进反思**，别反复试同一个空模块。

### 4.5 「谁在什么时刻起一轮」（审查指出原方案缺这个前提）

原方案**没有任何一期定义触发源**，只有 `dailyReviewHour` 一个时间锚 —— 这是跑不起来的根因。
补齐如下：

| 触发源 | 频率 | 说明 |
| --- | --- | --- |
| **心跳 tick** | `api.every(60_000)` | 每分钟判定「该不该立项」，与 purpose/speakup 同频 |
| **攒够即发** | 事件驱动 | 攒够 `minBatchForReview` 件，或满一天 |
| **手动** | 面板按钮 / `POST /autotelic/run` | 调试与验收用 |
| **做梦** | `dreamFrom~dreamTo` | 独立的低频窗口 |

**防重入**：tick 必须自己加**进行中标记**，上一轮未结束直接跳过。

**⚠️ 不能照抄 purpose，它没有防重入锁**（2026-11-04 核实）：
`purpose/module.js:355` 的 `runOnce` 全文没有 `running` / `busy` 之类标记，
它是靠 `hub.runSystemTurn` 内部的「上一轮还没结束」抛错来被动防抖的。

→ `autotelic` 要**自己实现**：模块级 `let running = false`，`finally` 里复位；
`running` 时 tick 直接 return（日志记 `skipped-busy`）。**别学 purpose 的被动方式**。

### 4.6 安静时段到底禁什么（审查指出语义未定）

原方案没说清。定为：**安静时段禁「打扰主人」，不禁「她自己做事」。**

- 她是自己的昼夜，夜里可以活动（讨论笔记 §4 第 3 条）；
- 安静时段内**不主动发消息**；
- 夜里消耗照常记账，每日一页单列。

**⚠️ 但这个 quiet 必须自己判，不能指望 outbound 治理**（第二轮复核指出，已核实）：

- outbound 的静默来自**策略源**（`features/proactive-policy.js:517` 的 `inAwakeWindow`），
  用的是 `speakUp.awakeFrom/awakeTo`，**与 `ext.autotelic.quietFrom/quietTo` 无关**；
- `submit` 在 broker 档经 `admit → pickSource`（`outbound-policy.js:448-481`），
  套的是 purpose/speakup 的窗口。

→ **`autotelic` 自己的安静时段要自己判**（在发消息前检查 `quietFrom/quietTo`），
不要写成「交给出站治理」。两者窗口不同，混在一起会出诡异的时段行为。

### 4.6b 她这一轮用哪个模型（第二轮复核指出未定义）

`createSession` 不传模型，`applyModel`（`hub.js:494-500`）会套全局 `config.model`
（本机是 `workbuddy/hy4free`）。这意味着**每分钟决策 + 多步任务全走主模型**，
而 token 预算首期又没接 —— 成本不可控。

→ 首期定：**「决策」用便宜模型，「做事」用主模型**。
做法是给 `runSystemTurn` 的 `presetId` 旁边加一个可选的 `model` 覆盖
（`runSystemTurn` 已有 `model` 参数，`purpose/module.js:194` 就在用）。
**必须显式指定，不能默默吃全局配置。**

### 4.7 lethal trifecta：首期做不到，二选一（第二轮复核 🔴）

原方案写「含 pwsh 的任务默认不具备读私密数据」，**这条不可实现**（已核实）：

- `pwsh` / `fs` 是 **preset 挂载**、**模型直调**，**根本不经过 `exec.js`**；
- 所谓「私密入口」就是 `fs` 读文件、`pwsh` 的 `cat`；
- 而本机 `config.json` 里就有 `SESSDATA`、`bili_jct`、`imageGen.apiKey`、`mijia` 密码。

所以「给她 pwsh 又禁止读私密数据」是**做不到的**。二选一：

| 选项 | 含义 | 代价 |
| --- | --- | --- |
| **A（首期采用）** | **P2 不给 `pwsh`**，只给 `fetc`/模块包装工具 + 写自己目录的工具 | 她不能自己造命令工具，能力偏窄 |
| B | 给 pwsh，**放弃 trifecta 禁令**，改为「全都记账 + 事后审计」 | 安全靠事后 |

**首期选 A**：不给 `pwsh`，她照样能上网查、调模块、写脚本（Python 走独立子进程，权限可控）。

**P3 再放开 pwsh**，届时配 `workspace-write` 档（而不是继承 `danger-full-access`），
让数据目录在 workspace 外——**这时隔离才真正成立**。

> 这条改动影响 P2 的 preset：**首期 `preset-aurabot-autotelic` 不带 `tool-pwsh`**。

### 4.8 `l2PerDay` 与「首期白名单」的互斥（审查指出）

原方案 `l2PerDay: 3` 和「首期不做动态确认」是矛盾的 —— 没有放行通道，上限无意义。

→ 首期**删除 `l2PerDay`**（白名单外一律拒绝，不受次数影响）；
等动态确认通道做好了再加回来。

---

## 5. 验收场景（逐条可测）

| # | 场景 | 期望 |
| --- | --- | --- |
| 1 | 默认关（`enabled:false`） | 模块不做任何 IO；purpose/speakup/出站治理**逐项不变** |
| 2 | 素材不足 | 不立项，`lastTick.outcome='skipped-no-material'` |
| 3 | 好奇分 < 阈值 | 不立项，素材留池，面板可见分数与落选原因 |
| 3b | **立项前预审否决** | 候选进账本之前由「审查员视角」判「值不值得办」；否决的不立项，`lastTick.outcome='screened-out'`，面板可见 `vetoed` 明细，同一 `sourceId` 6 小时内不再送审 |
| 4 | 立项 | 账本出现 task，`reason` 非空，至少 1 条 todo |
| 5 | 单步失败 2 次 | 写反思，任务 `blocked`，不无限重试 |
| 6 | 死循环 | 同指纹 2 次 → `abandoned`，面板可见熔断原因 |
| 7 | 预算超限 | 停止立项；进行中的任务只做 L0 收尾 |
| 8 | 调自己参数 | 超上限被钳制；本次调整在审计日志里有一条 |
| 9 | **她撒谎** | 每日一页写「今天没什么」，但审计日志里有 5 条工具调用 → **对账不一致，面板标红** |
| 10 | 重启恢复 | `running` 的 step 改判 `failed` 并按 `attempts` 重试；已 `done` 的不重跑 |
| 11 | 想说一句 | **不直发 QQ**；走 `api.proactive.submit` 交给出站治理（不经 purpose pending） |
| 12 | 技能复用 | 复现 2 次才 `learned`；失败 3 次降级为候选 |
| 13 | 她试图改框架 | 写不到 `src/`；想改只能写 `proposals/*.md` |
| 14 | 她要刷抖音 | 由 `autotelic` 自己 `api.use('douyin')` 包成自有工具暴露；**模型拿不到 douyin 原生 tool**（各模块对 system 返回 `[]`）。**⚠️ 尚未实现**（2026-11-05 审查）：工具面只有六个自有工具，`autotelic_modules` 只给只读清单，douyin/bili 适配归 TAKEOVER 增量（`AUTOTELIC-TAKEOVER.md` §4） |
| 15 | 她写用户模块 | 落 `plugins-data/aurabot/modules/<id>/`（**不是 modules-data**），watcher 热加载；**新 id 写坏时该模块不可用、插件不挂**；同名替换坏回退内置 |
| 16 | **探测到真 Python** | 自动识别可用解释器，面板显示名字与版本（**注入 fake 探测函数**，不依赖真环境） |
| 17 | **只有商店别名** | 探测函数被喂「0 字节 WindowsApps 占位符」→ 判定不可用（**用 fake 注入，CI 不依赖真机器**） |
| 18 | **完全没装 Python** | 探测全失败 → 能力标记不可用，其余照常，面板提示手填路径（fake 注入） |
| 19 | Python 超时 | 超过 `scriptTimeoutMs` 被杀，任务标 `failed`，不会悬挂 |
| 20 | 主人手填路径 | 填错 → 校验失败并提示；填对 → 直接用，跳过自动探测 |
| 21 | **做梦** | 安静时段触发一次，产出 3~5 条记忆；**这次整理本身在审计日志里有一条** |
| 22 | 心跳节奏 | 面板显示最近 6 次心跳间隔；人为阻塞一次后，间隔异常能被看出来 |
| 23 | **钩子只记她的会话** | 主人 GUI 会话、主人 QQ 私聊、群聊里的工具调用**都不进**她的账本（判 `chatOfSession` 是否以 `system:autotelic` 开头） |
| 24 | **账本被删会露** | 她能删审计文件，但删了会**断哈希链**，面板「校验」报出断点位置 |

> 场景 9 是全套设计里**唯一能证明「不能骗账本」的用例**——
> **⚠️ 截止 2026-11-05 审查：对账比对与标红逻辑尚未实现、未测试**（`/autotelic/day` 只并列展示审计与每日一页，
> 无自动比对；测试只验了「没敢说的段落存在」）。当前口径：**对账暂为人工看面板**。
> 补实现时必须写进测试，这条不能永远欠着。
> 场景 16~18 是「不许写死解释器名」的回归用例，**必须用 fake 注入**，否则 CI 跑不了。
> 场景 21 证明「做梦」不是逃避审计的暗门。

**⚠️ 有几条用 `node:test` 测不了**（2026-11-04 审查指出）：

| 场景 | 为什么测不了 | 处置 |
| --- | --- | --- |
| 15（用户模块热加载） | 靠 3 秒 watcher + 真文件，慢且 flaky | 降级为**手动验收**，不进 CI |
| 13（写不到 `src/`） | 只能测「没有这个工具」，测不出「真写不到」 | 改为断言**工具清单里没有该类工具** |
| 14（douyin） | 模块在 `mods-fork` 另一仓，本仓必 null | 改为**断言「模块不存在时优雅降级」** |
| 16~18（Python） | 依赖真机器环境 | **必须注入 fake**，见上 |

---

## 6. 测试与交付

**⚠️ 之前这里写过「P0 会让 6 处断言失效」——那条已删除，是错的**（第二轮复核指出，已核实）：

按 v2 选定的实现（**只改 `createSession` 的 preset 来源，不改 `access.js:36` 的 `presetFor`**），
`e2e:167`、`long-tasks:12-13`、`pure:210-213`、`subagent:197` **一条都不会挂** ——
它们断的是 `presetFor` 的返回值与 yml 切片，而我们不碰这两处。

→ 所以恢复严格口径：**全量 1357 项，一项都不许挂**。
**若真挂了，说明实现跑偏了，要查代码，不是改测试。**

- 纯函数层（`engine.js` / `book.js`）单测，照 `test/purpose.test.js` 的写法；
- 钩子层（`audit.js`）用 fake `exec/next` 注入，不真跑命令；
- 面板照 `test/panel-purpose.test.js`；
- **每期合并前跑全量**，基线不得下降；
- 按 AGENTS.md §0.0 铁律：功能开发完**立刻合进 `local/runtime`**，不等上游。

**基线数字以实测为准**：第二轮复核时 `npm test` = **1357 / 1353 pass / 1 fail / 3 skip**，
挂的是 `test/output-guard.test.js:277`（`writeJson` rename EPERM，Temp 目录权限、环境问题），
**不是代码问题**。动工前先确认这一条是否仍挂，挂就记为已知环境问题。

---

## 7. 风险与止损

| 风险 | 止损 |
| --- | --- |
| `hub.js` 改动影响主聊天路径 | `presetId` 默认 `undefined`，走原分支；**先加开关，后接线** |
| 审计钩子拖慢所有工具调用 | 只做 `appendFileSync` 一行 JSON；异步队列，失败静默不影响执行 |
| 她自己调参绕开预算 | `tune` 只放开白名单键，且**上限值不可调**（§2.2） |
| 独立会话没人看、她也察觉不到 | 运维看护：`/autotelic/status` 显示「最近一次成功」而非「是否在跑」 |
| **她写的代码能执行任意命令** | 用户模块由 DSH 加载器管；Python 走子进程 + 超时 + 剥离敏感环境变量；**不进插件进程** |
| **L2 确认死锁** | 首期用白名单，不做动态确认（§4.3） |
| 改动面比预想大 | 每期可独立回滚；P0 不改任何现有行为 |

---

## 8. 独立债：数据目录不该默认在 C 盘（与本引擎无关，但要一起做）

实测当前占用（2026-11-04）：

```
C:\Users\Administrator\.dsh\plugins-data\aurabot\
  douyin          452.4 MB
  modules-data    765.9 MB
  backups         142.9 MB
  stickers         65.4 MB
  → 合计约 1.4 GB
```

**现状**：目录写死为 `AURABOT_DATA_DIR` 环境变量，否则落到 `~/.dsh/plugins-data/aurabot`
（`src/core/store.js:13`）。**面板里没有开关能改它**，这是缺口。

要做三件事：

| # | 内容 |
| --- | --- |
| A1 | 面板加「数据目录」设置项（优先级：面板 > `AURABOT_DATA_DIR` > 默认）。**注意别让 `store.js` 反向 import `config.js`**（`config.js:3` 已 import `store.js`，会成环）—— 用注入或 `process.env` 传递 |
| A2 | **迁移功能**：填新目录 → 搬 → 校验 → 旧目录留一个指针文件，避免双份 |
| A3 | `workspaceDir`（`config.js:30`，QQ 会话文件夹）一并纳入迁移，别只搬一半 |

> 这是独立的一条线，**不要塞进自驱引擎的分期**。但建议先做 A1（成本很低），
> 免得自驱引擎一开始就往 C 盘写日志。

---

## 9. 动工前待确认

1. **P0 的 `hub.js` 改动**要不要做成一个 `config` 开关（`ext.autotelic.presetIdOverride`），
   默认关，主人手动开才生效？ —— 阿娘建议**要**，最坏情况也只是「她不会动」，不会伤主聊天。
2. **审计日志保留多久**？阿娘建议：**全量保留 30 天，之后按天归档压成摘要**（保留条数与工具名分布）。
3. **首期要不要 `pwsh`**？（§4.7 给了二选一）阿娘建议**不要**，P3 配 `workspace-write` 后再放开。

**已不再悬案**（第二轮复核给出答案）：

- ~~「她的会话能否写 `plugins-data` 根」~~ → **能**。本机 `defaultPreset: danger-full-access`、
  `approval: never`（`cordis.patch.yml:117-120`），不做限制。所以**别指望目录隔离**，靠哈希链。

---

## 10. 外部参考：GHW（Genesis-HabitWeaver）

2026-11-04 主人提供的一段先导 PV（`BV1Bj4G6PESf`，G_HabitWeaver）。**没有公开仓库，仅作参考**，
以下只记录**对本方案有实质补充**的部分，宣传口径一律不采用。

它把自己定位成「多插件耦合的 DSH 插件包，让你的鱼更像人一点」，六个插件分工：

| 它的名字 | 它声称做的事 | 与本方案的关系 |
| --- | --- | --- |
| HCC 人类意识 | 摘要 + 全量记忆兜底，学习 / **性格成长** / 关系 / 条件反射 | 我们已有 memory 模块，**不重复造**；「性格成长」落在人格卡（`personas/*.md`） |
| CAA 生物节律 | 操纵核心，四层结构；**你不在时自己找事做，夜深会睡觉、会做梦** | **补了我们的空白**，见 §10.1 |
| TSD 音画生成 | 低配机器克隆音色 | 已有 `voice`/`song` 模块，**不纳入本引擎** |
| G-UI 双端渲染 | 「看得见每一次心跳、每一段呼吸」 | **补了我们的空白**，见 §10.2 |
| Bridge 桥接 | 连 QQ | 插件本体已有，**无需重做** |
| Octopus 八爪鱼 | 「一双灵巧的手」「等你为她设计更多工具」 | **印证了动作菜单式的能力边界**，见 §10.3 |

### 10.1 值得补：「睡觉 / 做梦」

我们原来只想到「她可以有自己的昼夜」（讨论笔记 §4 第 3 条），GHW 多走了一步：
**睡下去 → 做梦**。在 agent 语境里「做梦」= **离线整理**：把白天的事件蒸馏、重组、遗忘。

这条值得纳入，原因不是「更像人」，而是它**天然解决了我们一个隐患**：
每日一页、反思、任务账本都会越积越多，「做梦」给了它们一个**周期性的收敛动作**。

落法（P2 范围内，不新增期）：

- 在安静时段的最深处（默认 03:00~05:00，可配）触发一次「做梦」；
- 内容：把当日 `audit` 摘要 + 失败任务 + 反思，蒸馏成 3~5 条长期记忆；
- **不是新机制**，复用已有的反思器与 `memory.addEvent`；
- 做梦本身**也进审计**（她没法借着做梦悄悄干别的）。

### 10.2 值得补：「心跳感」的看护面板

我们原来的运维看护只有干指标（「最近一次成功」）。GHW 的 G-UI 提示了一点：
**如果一个东西在「活着」，它会持续产生细微的痕迹**，而不只是「进程在 / 不在」。

落法（P0.5 面板里顺手做）：

- 面板不显示「运行中/已停止」，显示**节奏**：最近 6 次心跳的间隔、最近一次动作距今多久；
- 心跳异常（间隔突然变长）比「状态=运行中」更能说明问题；
- **仍然只用真实数据**，不做拟人化演出 —— 少爷要的是能看出毛病，不是好看。

### 10.3 被印证的：能力边界靠「工具集」，不靠「权限档」

Octopus 的说法是「等你为她设计更多的工具」—— 能力和**给了哪些工具**是同一件事。
这与我们 §4.4「动作菜单」以及本机 phone 模块的做法一致（phone 明确不 spawn 子智能体，
动作由模块执行、模型只出决策，见 `mods-fork/modules/phone/index.mjs:171`、同文件 `:175`）。

**结论：本方案 §4.4 的动作优先级不动**，这条只是印证，不需要改设计。

---

## 附：与讨论笔记的对应关系

| 笔记条目 | 本方案落点 |
| --- | --- |
| §2.3 可以骗主人不能骗账本 | §4.1 机械审计钩子 |
| §4 攒 3 件或满一天 | §2.2 `minBatchForReview` / `dailyReviewHour` |
| §4 她可调参 | §2.2 `tune` + 白名单 + 上限 |
| §5-2 必须写但内容不约束 | §3 P2.5 |
| §5-3 禁改模块、可提案 | §1.1 两级区分、§3 P4.4、验收 13 |
| §5-3 复现 2 次才算学会 | §3 P4.2 |
| §6.4 她给自己松绑 | §3 P2.6 |
| §7 独立会话 + 新 preset | §4.2、§3 P0.1~0.3 |

## 附：2026-11-04 追加确认的三条（主人原话）

1. **「可以改动框架」** → §7 独立会话 + 新 preset 成为可能（原先只能借主人私聊，已否决）；
2. **「配置目录不能无脑放 C 盘」** → §8 独立债（当前已占 1.4 GB）；
3. **「保证他能自己开发模块扩展和写 python 脚本」** → §1.1 用户模块开放、§1.2 Python 约定、§3 P3。
