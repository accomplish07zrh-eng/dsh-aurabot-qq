# 语义检索（Embedding RAG）

> 这是可选功能，默认关闭。它提高的是「从长期记忆里按意思找到相关几条」的能力，
> **不会扩大模型上下文窗口，也不会自动记住更多轮原始对话**。

## 它做什么 / 不做什么

- 做：把每条长期记忆发给 embedding 服务换成本机向量；每轮回复前，用对方这句话去向量索引里找相似记忆，和关键词结果一起排序后交给模型。
- 不做：不把聊天原文全部塞进上下文，不改变模型的上下文长度，不替代 DSH 的会话历史。
- 失败时：查询超时、服务报错、维度不一致都会静默退回纯关键词；不会阻塞回复。

## 支持的服务

所有服务都走 OpenAI 兼容的 `POST {服务地址}/embeddings`，返回 `data[].embedding`（float 数组或 base64 float32）。

| 服务 | 服务地址 | 推荐模型 | 说明 |
|---|---|---|---|
| 硅基流动 | `https://api.siliconflow.cn/v1` | `BAAI/bge-m3`（1024 维） | 中文强、便宜，8192 token |
| 火山方舟 | `https://ark.cn-beijing.volces.com/api/v3` | 控制台开通的 `doubao-embedding-*` | 中文云服务；单批 input 上限较小 |
| OpenAI | `https://api.openai.com/v1` | `text-embedding-3-small` / `large` | 支持 `dimensions` 截断 |
| 本地 Ollama | `http://127.0.0.1:11434/v1` | `bge-m3` / `qwen3-embedding` | 不需要 Key，完全本地 |
| 其他兼容服务 | 自填 | 自填 | LM Studio、OneAPI、NewAPI、Xinference、vLLM 等 |

> Qwen3-Embedding 0.6B / 4B / 8B 也是 OpenAI 兼容服务；支持 32K 上下文和 1024/2560/4096 维（可截断）。
> 记忆条目通常只有几十到两百字，bge-m3 已经够用，不必为了「更大」盲目换 8B。

## 面板配置

「心情与记忆 → 向量检索（实验性）」：

1. 打开开关。
2. 选服务预设，点「填入推荐值」会自动填地址和模型（仍可改）。
3. 填 API Key（本地服务留空）。
4. 点底部「保存设置」。
5. 点「测试」确认能返回向量；再点「重建索引」按当前记忆重来。

「服务地址」「模型」「API Key」之外的参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| 自定义请求头 | 空 | 一行一个 `Key: Value`；填了 `Authorization` 就不再自动加 `Bearer`。**不要把长期 API Key 写在这里**，优先用上面的 API Key 字段；这个字段会随面板配置明文返回给本机页面 |
| 向量维度 | 0 | 0 = 不传；Qwen3 / OpenAI 的 MRL 模型可截断，改完建议重建 |
| 每批多少条 | 10 | 方舟等单次 input 上限小，10 最稳；本地服务可调大 |
| 查询超时 | 3000ms | 超过就这一轮先用关键词，不拖慢回复 |

## 可选精排（Reranker）

Embedding 负责“找得到”，reranker 负责“找得准”。打开「重排候选」后：

1. 关键词 + 向量先多取一些候选（默认 20 条）；
2. 把「这一句查询 + 每条候选」一起发给 reranker 打分；
3. 按分数重排，取前几条进提示词。

推荐免费模型：`BAAI/bge-reranker-v2-m3`（硅基流动），接口是 `POST {baseUrl}/rerank`。

- 服务地址、API Key 留空时复用上面的 embedding 服务；
- 自定义请求头目前只用于 embedding，不会自动带到 reranker；需要额外 Header 的网关，reranker 会失败并回退原顺序；
- 候选数默认 20，越大越慢；
- 超时默认 2000ms；失败/超时保留原顺序，不会阻塞回复；
- 只处理已经通过群聊/人物权限过滤的候选，不会把不该带出的记忆送给 reranker；
- 只有候选至少 2 条时才发请求。

## 隐私与成本

- 只有**记忆文本**和**当前这一句查询**会发给配置的 embedding 服务；开启 reranker 时，候选记忆文本和查询也会发给 reranker 服务；聊天原文不会整段上传。
- 向量和校验文件只存在本机：`memory-vectors.json`、`memory-vectors-meta.json`。
- 云端按 token 计费；本地 Ollama 没有 API 费用，但会占本机 CPU/GPU。
- Key 存在本机配置，面板不回显，日志不打印原文。

## 排错

| 现象 | 先看 |
|---|---|
| 401 / 403 | Key 不对、没开通模型、余额不足 |
| 404 | 服务地址是否以 `/v1` 结尾；方舟是 `/api/v3`，不要写成 `/v1` |
| 400 / batch 相关 | 把「每批多少条」调小（方舟常见） |
| 维度不一致 / 向量无效 | 模型或 `dimensions` 改了；点「重建索引」 |
| 一直 0 条 | 记忆库本身为空；先聊天 / 手动加记忆 / 点「现在整理一次」 |
| 查询超时 | 云端慢或网络差；调大「查询超时」，或先用关键词 |
| 换了服务后没生效 | 保存设置后点「重建索引」；模型/地址变化会自动丢弃旧向量 |

## 开发与测试

- 向量逻辑在 `src/features/memory-vector.js`，配置在 `core/config.js` 的 `memory.vector`。
- 测试全部使用假 `fetchImpl`，不访问网络：`node --test test/memory-vector.test.js`。
- 新增服务只需要 OpenAI 兼容接口；如果接口形状不同（Gemini / Cohere / Azure），需要单独适配，不要硬塞进当前实现。
