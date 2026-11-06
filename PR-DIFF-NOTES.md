# 关于本 PR 的 diff 体积（写给 reviewer）

这个 PR 的完整 diff 看起来很大（`client/client.js` 显示 `+6789 / -5402`），
但**真实改动只有 1475 增 / 88 删**。原因和证据都在下面。

## 一句话结论

> 那些「整文件重写」是 **CRLF / LF 换行符差异**造成的，不是内容被重写。
> 用 `git diff --ignore-all-space` 就能看到真实改动。

## 怎么看真实改动

```bash
# 真实改动（推荐 reviewer 用这个看）
git diff --ignore-all-space origin/beta...HEAD

# 或者只看每个 commit 的真实规模
git log --oneline --numstat --ignore-all-space origin/beta..HEAD
```

本 PR 的真实改动规模（`--ignore-all-space`）：

| 文件 | +/- | 说明 |
|---|---|---|
| `src/features/memory-graph.js` | +995 | 记忆星图算法（新建文件，原样搬自记忆中枢 0.9.2） |
| `src/features/memory.js` | +594 / -31 | 联想建边、多跳、交付分层、升档、遗忘基数、降级提示 |
| `test/memory-assoc.test.js` | +529 | 联想回归（27 用例） |
| `src/features/memory-vector-local.js` | +232 | 本地向量模型（离线 bge-small） |
| `src/modules/memory/index.js` | +304 / -4 | 星图 12 个路由 + 分页 + 联想预览 |
| `client/client.js` | **+1475 / -88** | 星图组件、联想面板、Fold 折叠组、分页按钮 |
| `test/memory-graph.test.js` | +333 | 星图纯函数/布局回归（20 用例） |
| `src/features/vector-*.js` | +376 | 向量运行时的三个小模块 |
| `test/memory-pagination.test.js` | +156 | 分页回归（10 用例，本 PR 新增） |
| `test/memory-retention.test.js` | +75 | 遗忘基数回归（9 用例，本 PR 新增） |
| `src/core/config.js` | +53 | assoc / tierGrow / retentionBase / vector.mode 配置项 |
| `HANDOFF.md` | +720 | 开发记录（**可以不合**，只作为实现说明） |
| 其余 | +36 / -18 | CHANGELOG、package.json、README、测试微调 |

## 为什么会有换行符差异

- `origin/beta` 的 `client/client.js` 是 **CRLF**（5402 行）
- 本次改动过程中，编辑工具把文件写成了 **LF**，于是 git 认为「整个文件每行都变了」
- 仓库没有 `.gitattributes`，`core.autocrlf=false`，所以 git 不做任何归一化

**受影响的是历史上 5 个 commit**（它们本身的内容改动都很小）：

| commit | 表面 diff | 真实改动 |
|---|---|---|
| `a3abd3e` 星图渲染换原版 | +6309 / -5513 | **1138 行** |
| `8e7a2c0` 记忆页重排 | +6361 / -6338 | **73 行** |
| `0836bab` 星团清单默认收起 | +6507 / -6504 | **33 行** |
| `190e574` 补回星图前端 | +6680 / -5468 | **1212 行** |
| `98109dd` 折叠组 | +6789 / -6733 | **252 行** |

## 为后续提交准备的建议

如果这个 PR 被接受，建议顺手加一个 `.gitattributes` 固定行为，避免以后再出现同类噪音：

```gitattributes
# 源码统一 LF 入库；Windows 检出按平台自动转换
* text=auto eol=lf
*.md text eol=lf
*.js text eol=lf
*.json text eol=lf
*.yml text eol=lf
```

本 PR **没有**改 `.gitattributes`，因为那会再产生一次全库换行变更，会把 diff 弄得更乱。
等这个 PR 合了之后单独提一个小 PR 加它更合适。

## 测试情况

在 `release/1.3.0`（与 `beta` 同一提交 `cf821ef`）上跑全量：

```
node --test --test-concurrency=1 "test/*.test.js"

tests 1394
pass  1391
fail  0
skipped 3
```

记忆相关专项：

| 文件 | 用例 | 结果 |
|---|---|---|
| `test/memory-assoc.test.js` | 27 | 全过 |
| `test/memory-graph.test.js` | 20 | 全过 |
| `test/memory-pagination.test.js` | 10 | 全过（本 PR 新增） |
| `test/memory-retention.test.js` | 9 | 全过（本 PR 新增） |
| `test/memory-vector.test.js` | 18 | 全过 |
| `test/memory.test.js` | 20 | 全过 |
| `test/persona-panel.test.js` | 14 | 全过 |
| `test/memory-config-limit.test.js` | 3 | 全过 |

## 这个 PR 里各功能的实现位置

| 功能 | 后端 | 前端 | 测试 |
|---|---|---|---|
| 记忆星图 | `src/features/memory-graph.js` | `client/client.js` 的 `StarMap` | `test/memory-graph.test.js` |
| 记忆联想（A→B→C 多跳） | `memory.js` 的 `buildAssoc` / `search` | 面板「记忆联想与加深」组 | `test/memory-assoc.test.js` |
| 交付分层（直接 N + 联想 M + 总数） | `memory.js` 的 `recallHint` | 面板「每轮想起多少」组 | `test/memory-assoc.test.js` |
| 记忆加深（行为驱动升档） | `memory.js` 的 `growTier` / `touch` | 面板「记忆加深」 | `test/memory-assoc.test.js` |
| 遗忘基数（忘得多快） | `memory.js` 的 `retention` | 面板「分层记忆与遗忘」组 | `test/memory-retention.test.js` |
| 翻一翻分页 | `src/modules/memory/index.js` 的 `/memories` | 面板「翻一翻」的加载更多 | `test/memory-pagination.test.js` |
| 向量检索（本地模型） | `memory-vector.js` / `memory-vector-local.js` | 面板「向量检索」组 | `test/memory-vector.test.js` |
