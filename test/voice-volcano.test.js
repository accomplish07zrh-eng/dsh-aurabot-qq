// 豆包语音（火山引擎）预设：面板里只填 API Key，请求头 / 请求体 / 模型版本都由插件凑好。
// 起一个本地假服务，看它到底发了什么、流式返回的多段音频能不能拼成一个文件。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 生成的音频别落到主人真实的语音缓存里
const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-volcano-'))
process.env.AURABOT_DATA_DIR = dataDir

const hits = []
let respond = () => {}
const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    hits.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
    respond(res)
  })
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
// 接口地址本来写死在上游，这里指到假服务
process.env.AURABOT_VOLCANO_URL = `http://127.0.0.1:${server.address().port}/tts`

const { volcanoSynth, volcanoResourceFor } = await import('../src/voice/tts.js')
const { VOLCANO_VOICES } = await import('../src/voice/volcano-voices.js')
const { normalize, publicConfig, mergeFromPanel, DEFAULTS } = await import('../src/core/config.js')

const mp3 = Buffer.alloc(900, 0x55)
mp3.write('ID3', 0, 'ascii')
const b64 = mp3.toString('base64')
// 火山真实返回：几段 JSON 连着吐，最后一段是「合成结束」
const stream = () => [
  JSON.stringify({ header: { code: 0, message: '' }, data: b64.slice(0, 300) }),
  JSON.stringify({ header: { code: 0, message: '' }, data: b64.slice(300) }),
  JSON.stringify({ header: { code: 20000000, message: 'ok' } }),
].join('')

after(() => {
  server.close()
  rmSync(dataDir, { recursive: true, force: true })
})

const conf = (extra = {}) => ({ apiKey: 'sk-test-key', voiceType: 'zh_female_vv_uranus_bigtts', ...extra })

test('2.0 音色：Key 走 X-Api-Key，模型版本自动配 2.0，语速换算成 v3 的百分比', async () => {
  hits.length = 0
  respond = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(stream()) }

  const file = await volcanoSynth('你好呀', conf({ speedRatio: 1.2 }))
  assert.equal(readFileSync(file).length, mp3.length, '流式那几段要拼成完整文件')

  const h = hits[0]
  assert.equal(h.method, 'POST')
  assert.equal(h.headers['x-api-key'], 'sk-test-key')
  assert.equal(h.headers['x-api-resource-id'], 'seed-tts-2.0')
  assert.ok(h.headers['x-api-request-id'], '要带 X-Api-Request-Id')
  const body = JSON.parse(h.body)
  assert.equal(body.req_params.text, '你好呀')
  assert.equal(body.req_params.speaker, 'zh_female_vv_uranus_bigtts')
  assert.equal(body.req_params.audio_params.format, 'mp3')
  assert.equal(body.req_params.audio_params.speech_rate, 20)
})

test('1.0 音色不写 resourceId 也能自己认成 seed-tts-1.0', async () => {
  hits.length = 0
  respond = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(stream()) }
  await volcanoSynth('你好', conf({ voiceType: 'zh_female_qinqienvsheng_moon_bigtts' }))
  assert.equal(hits[0].headers['x-api-resource-id'], 'seed-tts-1.0')

  assert.equal(volcanoResourceFor('zh_female_vv_uranus_bigtts'), 'seed-tts-2.0')
  assert.equal(volcanoResourceFor('zh_female_qinqienvsheng_moon_bigtts'), 'seed-tts-1.0')
})

test('原速不传 speech_rate（有些音色不认这个字段）', async () => {
  hits.length = 0
  respond = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(stream()) }
  await volcanoSynth('正常语速', conf())
  assert.equal(JSON.parse(hits[0].body).req_params.audio_params.speech_rate, undefined)
})

test('没填 API Key 在本地就拦下来，不发请求', async () => {
  hits.length = 0
  await assert.rejects(() => volcanoSynth('嗨', { apiKey: '  ' }), /API Key/)
  assert.equal(hits.length, 0)
})

test('Key 不对：报错说人话，不是甩一串 code', async () => {
  respond = (res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ header: { code: 45000010, message: 'Invalid X-Api-Key' } }))
  }
  await assert.rejects(() => volcanoSynth('嗨', conf()), /API Key 没被认出来/)
})

test('音色和模型版本对不上：报错里点出来是音色的问题', async () => {
  respond = (res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ header: { code: 55000000, message: 'mismatched with speaker' } }))
  }
  await assert.rejects(() => volcanoSynth('嗨', conf({ resourceId: 'seed-tts-1.0' })), /音色和模型版本对不上/)
})

test('模型没开通：直接说去「开通管理」点一下', async () => {
  respond = (res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ header: { code: 45000030, message: 'resource not granted' } }))
  }
  await assert.rejects(() => volcanoSynth('嗨', conf()), /开通/)
})

test('音色清单：360 个上下、id 不重复、1.0 / 2.0 都有、中文男女都占一批', () => {
  const ids = VOLCANO_VOICES.map((v) => v.id)
  assert.ok(ids.length > 300, '预置音色数量：' + ids.length)
  assert.equal(new Set(ids).size, ids.length, '音色 id 不能重复')
  assert.ok(VOLCANO_VOICES.some((v) => v.ver === '2.0'))
  assert.ok(VOLCANO_VOICES.some((v) => v.ver === '1.0'))
  assert.ok(VOLCANO_VOICES.some((v) => v.group === '中文 · 女声'))
  assert.ok(VOLCANO_VOICES.some((v) => v.group === '中文 · 男声'))
  // 每条都得能落进一个组，面板才不会出现没有表头、也没有名字的空选项
  assert.ok(VOLCANO_VOICES.every((v) => v.id && v.name && v.group && (v.ver === '1.0' || v.ver === '2.0')))
})

test('配置归一化：engine 认 volcano，脏值落回安全的一侧', () => {
  const c = normalize({
    voice: {
      engine: 'volcano',
      volcano: { apiKey: '  sk-abc  ', voiceType: '', resourceId: 'seed-tts-9.9', speedRatio: 9 },
    },
  })
  assert.equal(c.voice.engine, 'volcano')
  assert.equal(c.voice.volcano.apiKey, 'sk-abc')
  assert.equal(c.voice.volcano.voiceType, DEFAULTS.voice.volcano.voiceType)
  assert.equal(c.voice.volcano.resourceId, '', '只认 1.0 / 2.0 两个值，别的当没填')
  assert.equal(c.voice.volcano.speedRatio, 2, '语速限在 0.5~2')
})

test('面板不回传 API Key 原文，只说存没存', () => {
  const p = publicConfig(normalize({ voice: { volcano: { apiKey: 'sk-secret-123' } } }))
  assert.equal(p.voice.volcano.apiKey, '')
  assert.equal(p.voice.volcano.apiKeySet, true)
})

test('面板没动密码框（传空串）时保留原来的 Key', () => {
  const cur = normalize({ voice: { engine: 'volcano', volcano: { apiKey: 'sk-keep-me' } } })
  const next = mergeFromPanel(cur, { voice: { volcano: { apiKey: '' } } })
  assert.equal(next.voice.volcano.apiKey, 'sk-keep-me')
})
