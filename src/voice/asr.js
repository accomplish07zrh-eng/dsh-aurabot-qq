// 云端语音识别：把 QQ 语音转好的 16kHz 单声道 WAV 交给 OpenAI 兼容的
// POST {baseUrl}/audio/transcriptions，换回文字。失败由聊天中枢继续试 QQ / DSH。
//
// 内置硅基流动（SenseVoiceSmall）和 OpenAI（whisper-1）；也可以选「自定义」填任意
// 兼容 /audio/transcriptions 的服务。没有密钥的本地服务把 apiKey 留空即可。

export const ASR_PRESETS = {
  siliconflow: {
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/SenseVoiceSmall',
    hint: 'FunAudioLLM/SenseVoiceSmall，中文短语音便宜；实测一次约 14 秒',
  },
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'whisper-1',
    hint: 'whisper-1；网络不通时可以填兼容网关的地址',
  },
}

const str = (v) => String(v ?? '').trim()

/** 面板 / 聊天用的有效配置；没选服务或地址模型不全时返回 null。 */
export function asrSettings(voice) {
  const c = voice?.asrApi
  if (!c || typeof c !== 'object') return null
  const provider = str(c.provider)
  if (!provider) return null
  const preset = ASR_PRESETS[provider] || null
  if (!preset && provider !== 'custom') return null
  // 服务地址只填到 /v1；用户把完整 /audio/transcriptions 贴进来时自动去掉，避免拼成双路径 404
  const baseUrl = str(c.baseUrl || preset?.baseUrl).replace(/\/+$/, '').replace(/\/audio\/(?:speech|transcriptions)\/?$/i, '')
  const model = str(c.model || preset?.model)
  if (!baseUrl || !model) return null
  try {
    const u = new URL(baseUrl)
    if (!['http:', 'https:'].includes(u.protocol)) return null
  } catch (error) {
    return null
  }
  return {
    provider,
    baseUrl,
    model,
    apiKey: str(c.apiKey),
    language: str(c.language),
    prefer: c.prefer === 'cloud' ? 'cloud' : 'qq',
  }
}

/** 现在有没有配置云端识别。 */
export function asrConfigured(voice) {
  return Boolean(asrSettings(voice))
}

function timeoutSignal(ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(ms) || 60000))
  return { signal: controller.signal, done: () => clearTimeout(timer) }
}

/**
 * @param {Buffer} buffer 16kHz 单声道 PCM16 WAV
 * @param {object} voice 整份 voice 配置
 * @returns {Promise<string>} 文字（可能为空）
 */
export async function transcribeAudio(buffer, voice, log, { fetchImpl = globalThis.fetch, timeoutMs = 60000 } = {}) {
  const c = asrSettings(voice)
  if (!c) throw new Error('没配置云端识别')
  if (!buffer || !buffer.length) throw new Error('没有音频')
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: 'audio/wav' }), 'voice.wav')
  form.append('model', c.model)
  if (c.language) form.append('language', c.language)
  const headers = {}
  if (c.apiKey) headers.Authorization = `Bearer ${c.apiKey}`
  const t = timeoutSignal(timeoutMs)
  const started = Date.now()
  try {
    const r = await fetchImpl(`${c.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers,
      body: form,
      signal: t.signal,
      redirect: 'error',
    })
    const raw = await r.text().catch(() => '')
    if (!r.ok) throw new Error(`HTTP ${r.status}${raw ? '：' + raw.slice(0, 160) : ''}`)
    let json = null
    try { json = JSON.parse(raw) } catch (error) {}
    if (!json) throw new Error('识别服务返回的不是 JSON：' + raw.slice(0, 160))
    const text = str(json.text || json.transcript)
    log?.debug?.(`云端识别（${c.provider}）用时 ${Date.now() - started}ms，得到 ${text.length} 字`)
    return text
  } finally {
    t.done()
  }
}
