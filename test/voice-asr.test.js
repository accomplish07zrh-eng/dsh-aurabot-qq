// 云端语音识别：配置收敛、预置默认值、multipart 请求、密钥遮罩。全部假 fetch，不联网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize, publicConfig, mergeFromPanel } from '../src/core/config.js'
import { asrConfigured, asrSettings, transcribeAudio, ASR_PRESETS } from '../src/voice/asr.js'
import { buildWav } from '../src/voice/wav.js'

const log = { info() {}, warn() {}, debug() {} }
const wav = () => buildWav(new Int16Array(24000), 24000)

test('默认关闭；选硅基只填 Key 就能用预置地址和模型', () => {
  const empty = normalize({})
  assert.deepEqual(empty.voice.asrApi, { provider: '', baseUrl: '', model: '', apiKey: '', language: '', prefer: 'qq' })
  assert.equal(asrConfigured(empty.voice), false)

  const cfg = normalize({ voice: { asrApi: { provider: 'siliconflow', apiKey: 'sk-asr' } } })
  const s = asrSettings(cfg.voice)
  assert.equal(s.baseUrl, ASR_PRESETS.siliconflow.baseUrl)
  assert.equal(s.model, ASR_PRESETS.siliconflow.model)
  assert.equal(s.apiKey, 'sk-asr')
  assert.equal(asrConfigured(cfg.voice), true)

  const custom = normalize({ voice: { asrApi: { provider: 'custom' } } })
  assert.equal(asrConfigured(custom.voice), false, '自定义服务必须填地址和模型')
})

test('密钥在面板不回显，保存时保留；显式清空才清掉', () => {
  const cfg = normalize({ voice: { asrApi: { provider: 'openai', apiKey: 'sk-secret' } } })
  const pub = publicConfig(cfg)
  assert.equal(pub.voice.asrApi.apiKey, '')
  assert.equal(pub.voice.asrApi.apiKeySet, true)
  assert.equal(JSON.stringify(pub).includes('sk-secret'), false)
  assert.equal(mergeFromPanel(cfg, pub).voice.asrApi.apiKey, 'sk-secret')
  assert.equal(mergeFromPanel(cfg, { voice: { asrApi: { apiKey: null } } }).voice.asrApi.apiKey, '')
})

test('运行时默认值：地址/模型留空用预置，prefer 乱写回 qq', () => {
  const cfg = normalize({ voice: { asrApi: { provider: 'openai', baseUrl: '', model: '', prefer: '乱写' } } })
  const s = asrSettings(cfg.voice)
  assert.equal(s.baseUrl, 'https://api.openai.com/v1')
  assert.equal(s.model, 'whisper-1')
  assert.equal(s.prefer, 'qq')
})

test('服务地址误填完整 /audio/transcriptions 时自动去掉，不会拼成双路径 404', async () => {
  const calls = []
  const fake = async (url) => {
    calls.push(url)
    return { ok: true, text: async () => JSON.stringify({ text: '好' }) }
  }
  const cfg = normalize({
    voice: {
      asrApi: {
        provider: 'custom',
        baseUrl: 'https://api.siliconflow.cn/v1/audio/transcriptions',
        model: 'XingChenAGI/XingChenASR-V3.2-Ultra',
        apiKey: 'sk-asr',
      },
    },
  })
  assert.equal(asrSettings(cfg.voice).baseUrl, 'https://api.siliconflow.cn/v1')
  const text = await transcribeAudio(wav(), cfg.voice, log, { fetchImpl: fake })
  assert.equal(text, '好')
  assert.equal(calls[0], 'https://api.siliconflow.cn/v1/audio/transcriptions')
})

test('multipart 上传 wav，取回 text；带 Authorization', async () => {
  const calls = []
  const fake = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, text: async () => JSON.stringify({ text: '今天想吃白米饭。' }) }
  }
  const cfg = normalize({ voice: { asrApi: { provider: 'siliconflow', apiKey: 'sk-asr' } } })
  const text = await transcribeAudio(wav(), cfg.voice, log, { fetchImpl: fake })
  assert.equal(text, '今天想吃白米饭。')
  assert.equal(calls[0].url, 'https://api.siliconflow.cn/v1/audio/transcriptions')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-asr')
  assert.ok(calls[0].init.body instanceof FormData)
  assert.equal(calls[0].init.body.get('model'), 'FunAudioLLM/SenseVoiceSmall')
  assert.ok(calls[0].init.body.get('file') instanceof Blob)
})

test('没密钥也能用；HTTP 失败报状态但不泄露密钥', async () => {
  const cfg = normalize({ voice: { asrApi: { provider: 'custom', baseUrl: 'http://127.0.0.1:8000/v1', model: 'whisper-1' } } })
  let seen
  const ok = await transcribeAudio(wav(), cfg.voice, log, {
    fetchImpl: async (url, init) => { seen = init; return { ok: true, text: async () => '{"text":"嗯"}' } },
  })
  assert.equal(ok, '嗯')
  assert.equal(seen.headers.Authorization, undefined, '本地服务不该硬塞 Bearer')

  const cfg2 = normalize({ voice: { asrApi: { provider: 'siliconflow', apiKey: 'sk-secret' } } })
  await assert.rejects(
    transcribeAudio(wav(), cfg2.voice, log, { fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"message":"bad key"}' }) }),
    (error) => /HTTP 401/.test(error.message) && !error.message.includes('sk-secret'),
  )
})

test('没配置或空音频时给人话，不发请求', async () => {
  let calls = 0
  const fake = async () => { calls++; return { ok: true, text: async () => '{"text":"x"}' } }
  await assert.rejects(transcribeAudio(wav(), normalize({}).voice, log, { fetchImpl: fake }), /没配置云端识别/)
  const cfg = normalize({ voice: { asrApi: { provider: 'siliconflow', apiKey: 'k' } } })
  await assert.rejects(transcribeAudio(Buffer.alloc(0), cfg.voice, log, { fetchImpl: fake }), /没有音频/)
  assert.equal(calls, 0)
})
