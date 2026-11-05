// 通用 HTTP 语音引擎：GET 带 {text}，或者 POST 自己填请求头/请求体（接火山、阿里、讯飞这类要鉴权的云厂商）。
// 起一个本地假服务，看它到底发了什么、又把什么当音频收下来。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 生成的音频别落到主人真实的语音缓存里
const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-http-tts-'))
process.env.AURABOT_DATA_DIR = dataDir

const { httpSynth } = await import('../src/voice/tts.js')
const { normalize } = await import('../src/core/config.js')

const wav = Buffer.alloc(800)
wav.write('RIFF', 0, 'ascii')
wav.write('WAVE', 8, 'ascii')
const mp3 = Buffer.alloc(800, 0x55)
mp3.write('ID3', 0, 'ascii')

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
const base = `http://127.0.0.1:${server.address().port}`

after(() => {
  server.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test('GET：地址里的 {text} 换成编码过的文字，返回二进制直接落盘', async () => {
  hits.length = 0
  respond = (res) => { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav) }

  const file = await httpSynth('你好 世界', { urlTemplate: `${base}/tts?text={text}` })

  assert.equal(hits[0].method, 'GET')
  assert.equal(hits[0].url, '/tts?text=' + encodeURIComponent('你好 世界'))
  assert.ok(file.endsWith('.wav'), file)
  assert.ok(existsSync(file))
  assert.equal(readFileSync(file).length, wav.length)
})

test('GET：地址里没有 {text} 就明确报错', async () => {
  await assert.rejects(() => httpSynth('嗨', { urlTemplate: `${base}/tts` }), /\{text\}/)
})

test('GET 是老配置的默认方式（不写 method 也走 GET）', async () => {
  hits.length = 0
  respond = (res) => { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav) }
  await httpSynth('嗨', { urlTemplate: `${base}/tts?text={text}`, method: '' })
  assert.equal(hits[0].method, 'GET')
})

test('POST：请求头一行一个、{text} 在 JSON 里自动转义、{reqid} 每次不同、JSON 里的 base64 能解出来', async () => {
  hits.length = 0
  respond = (res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 3000, data: mp3.toString('base64') }))
  }

  const text = '他说"走吧"\n那就算了'
  const conf = {
    urlTemplate: `${base}/tts`,
    method: 'POST',
    headers: 'Authorization: Bearer;abc123\n# 注释行不算\n\nX-Extra: 1',
    body: '{"request":{"reqid":"{reqid}","text":"{text}"}}',
  }

  const file = await httpSynth(text, conf)
  const hit = hits[0]

  assert.equal(hit.method, 'POST')
  assert.equal(hit.headers.authorization, 'Bearer;abc123')
  assert.equal(hit.headers['x-extra'], '1')
  assert.match(hit.headers['content-type'], /^application\/json/)

  const sent = JSON.parse(hit.body)
  assert.equal(sent.request.text, text, '引号和换行要原样还原，不能把 JSON 撑破')
  assert.match(sent.request.reqid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.ok(file.endsWith('.mp3'), file)

  await httpSynth(text, conf)
  assert.notEqual(JSON.parse(hits[1].body).request.reqid, sent.request.reqid, '每次 reqid 都要换')
})

test('POST：不填 content-type 时自己补 json；填了就照用户的来', async () => {
  hits.length = 0
  respond = (res) => { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav) }

  await httpSynth('嗨', { urlTemplate: `${base}/tts`, method: 'POST', body: '{"text":"{text}"}' })
  assert.match(hits[0].headers['content-type'], /^application\/json/)

  await httpSynth('嗨', { urlTemplate: `${base}/tts`, method: 'POST', body: 'text={text}', headers: 'Content-Type: application/x-www-form-urlencoded' })
  assert.equal(hits[1].headers['content-type'], 'application/x-www-form-urlencoded')
})

test('POST：{text_raw} 不转义，适合表单', async () => {
  hits.length = 0
  respond = (res) => { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav) }
  await httpSynth('你好世界', { urlTemplate: `${base}/tts`, method: 'POST', body: 'text={text_raw}' })
  assert.equal(hits[0].body, 'text=你好世界')
})

test('POST：没填请求体就报错，不会发一个空请求出去', async () => {
  await assert.rejects(() => httpSynth('嗨', { urlTemplate: `${base}/tts`, method: 'POST' }), /请求体/)
})

test('云厂商把错误写在 JSON 里时，报错要带上 code 和 message', async () => {
  hits.length = 0
  respond = (res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 3001, message: 'requested grant not found' }))
  }
  await assert.rejects(
    () => httpSynth('嗨', { urlTemplate: `${base}/tts`, method: 'POST', body: '{"text":"{text}"}' }),
    /3001.*requested grant not found/,
  )
})

test('对方返回 500 时把响应体带进报错，方便排查', async () => {
  hits.length = 0
  respond = (res) => { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('内部错误了') }
  await assert.rejects(() => httpSynth('嗨', { urlTemplate: `${base}/tts?text={text}` }), /500.*内部错误了/s)
})

// ---- 手改 config.json 写脏了，也不能把请求发歪 ----

test('归一化：method 只认 GET / POST，大小写和多余空格都吃掉，其余当 GET', () => {
  const method = (v) => normalize({ voice: { http: { method: v } } }).voice.http.method
  assert.equal(method('post'), 'POST')
  assert.equal(method(' POST '), 'POST')
  assert.equal(method('get'), 'GET')
  assert.equal(method(''), 'GET')
  assert.equal(method(undefined), 'GET')
  // 面板只给两个选项；写成别的（尤其 PUT，请求体会被当成 GET 发出去）一律不放过
  assert.equal(method('PUT'), 'GET')
  assert.equal(method(1), 'GET')
})

test('归一化：headers / body 写成对象、数组、数字时转成字符串，不出现 [object Object]', () => {
  assert.equal(normalize({ voice: { http: { headers: { Authorization: 'Bearer;x' } } } }).voice.http.headers, 'Authorization: Bearer;x')
  assert.equal(normalize({ voice: { http: { headers: ['A: 1', 'B: 2'] } } }).voice.http.headers, 'A: 1\nB: 2')
  assert.equal(normalize({ voice: { http: { body: 123 } } }).voice.http.body, '123')

  const body = normalize({ voice: { http: { body: { request: { text: '{text}' } } } } }).voice.http.body
  assert.equal(JSON.parse(body).request.text, '{text}', '对象要能序列化回去，占位符还得留着')
  assert.ok(!body.includes('[object'), body)

  // 地址两端的空白会让 fetch 报 invalid URL，先去掉
  assert.equal(normalize({ voice: { http: { urlTemplate: '  https://x/y  ' } } }).voice.http.urlTemplate, 'https://x/y')
  // 整个 http 被写成字符串（手滑）时回到默认值，不炸
  assert.equal(normalize({ voice: { http: 'oops' } }).voice.http.method, 'GET')
})

test('归一化之后再发请求：手写成对象的 headers 和 body 也能真用上', async () => {
  hits.length = 0
  respond = (res) => { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav) }

  const conf = normalize({
    voice: {
      http: {
        urlTemplate: `${base}/tts`,
        method: 'post',
        headers: { Authorization: 'Bearer;abc' },
        body: { request: { reqid: '{reqid}', text: '{text}' } },
      },
    },
  }).voice.http

  await httpSynth('你好', conf)
  assert.equal(hits[0].method, 'POST')
  assert.equal(hits[0].headers.authorization, 'Bearer;abc')
  assert.equal(JSON.parse(hits[0].body).request.text, '你好')
})
