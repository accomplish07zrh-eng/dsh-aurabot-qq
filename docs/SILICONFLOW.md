# 用硅基流动的免费服务

> 价格与可用性会变，以 [硅基流动价格页](https://www.siliconflow.cn/pricing) 为准。
> 本文记录 2026-11-04 页面上标「免费」的模型，以及在本项目里怎么接。

## 当前免费清单（以价格页为准）

| 类型 | 模型 | 在本项目里怎么用 |
|---|---|---|
| 对话 | `XingChenAGI/Xing4.0-29B` | DSH 自定义 provider，当聊天模型；支持工具调用（已实测） |
| 翻译 | `tencent/Hunyuan-MT-7B` | 适合翻译/改写；不适合当人格聊天主模型 |
| Embedding | `BAAI/bge-m3` | 面板「语义检索」直接填，免费 |
| Embedding | `BAAI/bge-large-zh-v1.5` / `bge-large-en-v1.5` | 同上；中文优先 bge-m3 |
| Reranker | `BAAI/bge-reranker-v2-m3` | 面板「重排候选」直接填，免费 |
| 语音识别 | `FunAudioLLM/SenseVoiceSmall` | 面板「云端识别」直接填，免费 |
| 语音识别 | `XingChenAGI/XingChenASR-*` | 免费；实测 `XingChenAGI/XingChenASR-V3.2-Ultra` 走标准 `/audio/transcriptions` 可用，模型 ID 要带前缀 |
| 生图 | `Kwai-Kolors/Kolors` | 面板「生图」用 OpenAI 兼容 provider |
| OCR/视觉 | `PaddlePaddle/PaddleOCR-VL-1.5` | 代码暂未接；可用于图片文字识别 |

注意：免费不等于无限。通常有并发/频率限制，也可能随时调整；不要拿免费模型跑高敏感内容。

## 1. 免费聊天模型：Xing4.0-29B

DSH 的模型不在 Aurabot 面板里加，而是在 DSH：

1. 打开 **设置 → 模型**。
2. **添加提供方 → 自定义**。
3. 填：
   - Provider ID：`siliconflow`（小写，保存后不可改）
   - 基础 URL：`https://api.siliconflow.cn/v1`
   - API 协议：`openai-completions`
   - API Key：你的硅基 Key
   - 模型：`XingChenAGI/Xing4.0-29B`
4. 保存。回到 Aurabot 面板「模型」页，选中 `siliconflow/Xing4.0-29B`。

Xing4.0-29B 公开资料标 256K 上下文，工具调用实测可用；但它是免费 MoE 模型，人格稳定性/指令遵循通常不如 DeepSeek。建议：

- 主人私聊继续用 DeepSeek；
- 群聊/非主人私聊用免费模型（Aurabot「模型」页可以按聊天单独选）；
- 先观察几轮，工具调用、@、引用是否正常。

如果网关报 `developer` role 或 `max_tokens` 不认，在 `settings.yaml` 的 `llm-pi-ai` 里加：

```yaml
llm-pi-ai:
  providers:
    siliconflow:
      displayName: SiliconFlow
      apiKeyEnv: SILICONFLOW_API_KEY
      api: openai-completions
      baseURL: https://api.siliconflow.cn/v1
      defaultContextWindow: 262144
      defaultMaxTokens: 8192
      compat:
        supportsDeveloperRole: false
        maxTokensField: max_tokens
      models:
        - id: XingChenAGI/Xing4.0-29B
          name: Xing4.0-29B
          contextWindow: 262144
```

> `apiKeyEnv` 需要环境变量；不想配环境变量就用 UI 保存 Key。改完下一次请求生效，不用重启 DSH。

## 2. 免费 Embedding：bge-m3

面板 **心情与记忆 → 向量检索**：

- 服务地址：`https://api.siliconflow.cn/v1`
- 模型：`BAAI/bge-m3`（不要选 `Pro/BAAI/bge-m3`，那是付费）
- API Key：你的硅基 Key
- 保存 → 测试 → 重建索引

这是目前最划算的免费能力：记忆条目同步和每轮查询都不花 embedding 费用。详见 [EMBEDDING.md](EMBEDDING.md)。

## 3. 免费语音识别：SenseVoiceSmall

面板 **语音识别**（和「语音」「表情包」同级）：

- 云端识别：硅基流动
- 服务地址/模型留空，用预置（`FunAudioLLM/SenseVoiceSmall`）
- API Key：你的硅基 Key
- 先用谁：保持「先 QQ 自带」（云端实测一次约 14 秒，做兜底）
- 保存 → 测试云端识别

免费版适合「QQ 转不出来时兜底」，不建议默认放最前。

## 4. 免费生图：Kolors

面板 **生图**：

- 打开生图，provider 选 OpenAI 兼容
- 服务地址：`https://api.siliconflow.cn/v1`
- API Key：你的硅基 Key
- 模型：`Kwai-Kolors/Kolors`
- 尺寸：1024x1024
- 保存 → 先画一张测试

免费生图可能有排队/限速；失败会自动报错，不会假装画好。

## 5. Reranker / OCR

- `BAAI/bge-reranker-v2-m3` 是免费 reranker。面板「心情与记忆 → 重排候选」打开后，会先多取候选，再用它逐条打分重排；地址/Key 留空复用 embedding，失败/超时回退原顺序。
- `PaddlePaddle/PaddleOCR-VL-1.5` 是免费 OCR/视觉模型，当前没接；适合做「看图读字」工具，不适合替代聊天视觉模型。

OCR 属于新功能，不是填个配置就能用。

## 免费额度注意事项

- 免费模型可能有 RPM/TPM/并发限制，长会话或群里高频使用会 429。
- 免费模型可能不支持 tool calls / vision / JSON / 长上下文，接之前先用面板或 API 测一次。
- 免费服务的数据策略以硅基条款为准；不要把密码、身份证、聊天记录等敏感内容发给免费端点。
- 价格页的「免费」可能调整或结束；生产用途建议保留 DeepSeek 或其他付费兜底。
