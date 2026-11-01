// 语音和文件的发送回落：只在确定失败时换一种方式，超时不能重复发送。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'
import { OneBotError } from '../src/onebot/client.js'

function setup(t, failure, { ttsFailure = false, files = { enabled: true } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-send-fallback-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const file = join(dir, 'test.txt')
  writeFileSync(file, '音频或文件')
  const calls = [], logs = []
  const cfg = normalize({ enabled: true, dryRun: false, workspaceDir: dir, files, voice: { enabled: true }, stickers: { enabled: false } })
  const hub = createHub({ dsh: {}, getConfig: () => cfg,
    log: Object.fromEntries(['info', 'warn', 'debug', 'error'].map((k) => [k, (...v) => logs.push(v.join(' '))])),
    onebot: { async call(action, params, opts) { calls.push({ action, params, opts }); if (calls.length === 1 && failure) throw failure; return { message_id: 42 } } },
    tts: { async speak() { if (ttsFailure) throw new Error('合成失败'); return { file, engine: 'test' } } },
  })
  t.after(() => {
    hub.dispose()
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
    rmSync(dir, { recursive: true, force: true })
  })
  return { hub, file, calls, logs }
}

const timeout = () => new OneBotError('send_private_msg', { message: '超时' }, { uncertain: true })
const refused = () => new OneBotError('send_private_msg', { status: 'failed', retcode: 100, message: '明确拒绝' })
const disconnected = () => new OneBotError('send_private_msg', { message: '连接断开' }, { uncertain: true })
const notConnected = () => new OneBotError('send_private_msg', { message: '没连上' }, { transport: true })

for (const [name, make] of [['超时', timeout], ['发送后断线', disconnected], ['未知错误', () => new Error('未知')]]) {
  test(`语音${name}：只发一次并向调用方报告失败`, async (t) => {
    const s = setup(t, make())
    const result = await s.hub.deliver('private:1', '<voice>你好</voice>')
    assert.equal(s.calls.length, 1)
    assert.equal(s.calls[0].params.message[0].type, 'record')
    assert.equal(result.failed, 1)
    assert.ok(result.errors[0])
    assert.ok(s.logs.some((line) => line.includes('不再改发文字')))
  })
  test(`本机文件${name}：不改用 base64 重发`, async (t) => {
    const s = setup(t, make())
    await assert.rejects(s.hub.sendFile('private:1', s.file), /发文件失败/)
    assert.equal(s.calls.length, 1)
    assert.equal(s.calls[0].params.file, s.file)
    assert.ok(s.logs.some((line) => line.includes('不再重发')))
  })
}

for (const [name, make] of [['明确拒绝', refused], ['没连上', notConnected]]) {
  test(`语音${name}：改发文字并报告成功`, async (t) => {
    const s = setup(t, make())
    const result = await s.hub.deliver('private:1', '<voice>你好</voice>')
    assert.deepEqual(s.calls.map((c) => c.params.message[0].type), ['record', 'text'])
    assert.equal(result.failed, 0)
  })
  test(`文件${name}：改用 base64`, async (t) => {
    const s = setup(t, make())
    await s.hub.sendFile('private:1', s.file)
    assert.equal(s.calls.length, 2)
    assert.equal(s.calls[0].params.file, s.file)
    assert.match(s.calls[1].params.file, /^base64:\/\//)
  })
}

test('语音合成失败时仍然回落到文字', async (t) => {
  const s = setup(t, null, { ttsFailure: true })
  // 第一次实际发送就是文字，网关正常接收。
  s.hub.dispose()
  const sent = []
  const cfg = normalize({ enabled: true, dryRun: false, voice: { enabled: true }, stickers: { enabled: false } })
  const hub = createHub({ dsh: {}, getConfig: () => cfg, log: { info() {}, warn() {}, debug() {}, error() {} },
    onebot: { async call(action, params) { sent.push(params); return { message_id: 1 } } },
    tts: { async speak() { throw new Error('合成失败') } },
  })
  t.after(() => hub.dispose())
  const result = await hub.deliver('private:1', '<voice>你好</voice>')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].message[0].type, 'text')
  assert.equal(result.failed, 0)
})

test('语音传不上去：网关报 highway 失败（带 timeout 字样）也改发文字，语音等够两分钟', async (t) => {
  const s = setup(t, new OneBotError('send_private_msg', { status: 'failed', retcode: 1200, message: 'highway upload transport failed: highway response read timeout (peer idle)' }))
  const result = await s.hub.deliver('private:1', '<voice>你好</voice>')
  assert.equal(s.calls[0].params.message[0].type, 'record')
  assert.equal(s.calls[0].opts?.timeoutMs, 120000)
  assert.equal(s.calls.at(-1).params.message.at(-1).type, 'text')
  assert.equal(result.failed || 0, 0)
})

test('群里回复写本机图片：允许目录外的不发，数据目录里的照发', async (t) => {
  const s = setup(t, null)
  const outside = join(tmpdir(), 'aurabot-secret.png')
  writeFileSync(outside, '图')
  t.after(() => rmSync(outside, { force: true }))
  await s.hub.deliver('group:9', `![图](${outside})`)
  assert.equal(s.calls.length, 0)
  assert.ok(s.logs.some((line) => line.includes('不在允许的目录里')))
  await s.hub.deliver('group:9', `![图](${s.file})`)
  assert.equal(s.calls.length, 1)
})

// —— 发图：本地路径优先直发，只有网关明确拒绝才转 base64（#169）——

test('本地图片先按路径直发，网关认了就不读盘转 base64', async (t) => {
  const s = setup(t, null)
  const r = await s.hub.sendImage('private:1', s.file)
  assert.equal(s.calls.length, 1)
  assert.equal(s.calls[0].params.message[0].type, 'image')
  assert.equal(s.calls[0].params.message[0].data.file, pathToFileURL(s.file).href)
  assert.ok(r && r.message_id)
})

test('file:// 开头的本地图片也一样按路径直发', async (t) => {
  const s = setup(t, null)
  await s.hub.sendImage('private:1', pathToFileURL(s.file).href)
  assert.equal(s.calls[0].params.message[0].data.file, pathToFileURL(s.file).href)
})

test('路径直发被明确拒绝：改用 base64 再发一次', async (t) => {
  const s = setup(t, refused())
  await s.hub.sendImage('private:1', s.file)
  assert.equal(s.calls.length, 2)
  assert.equal(s.calls[0].params.message[0].data.file, pathToFileURL(s.file).href)
  assert.match(s.calls[1].params.message[0].data.file, /^base64:\/\//)
})

for (const [name, make] of [['超时', timeout], ['发送后断线', disconnected], ['未知错误', () => new Error('未知')]]) {
  test(`图片路径直发${name}：不改成 base64 重发`, async (t) => {
    const s = setup(t, make())
    const r = await s.hub.sendImage('private:1', s.file)
    assert.equal(s.calls.length, 1)
    assert.equal(r, null)
    assert.ok(s.logs.some((line) => line.includes('不再重发')))
  })
}

test('调用方要求 strict 时，不确定的失败会抛错（上层才好停下，别发第二份）', async (t) => {
  const s = setup(t, timeout())
  await assert.rejects(s.hub.sendImage('private:1', s.file, undefined, undefined, { strict: true }), /可能已经发出去了/)
  assert.equal(s.calls.length, 1)
})

test('关掉 imageByPath 就一直走 base64', async (t) => {
  const s = setup(t, null, { files: { enabled: true, imageByPath: false } })
  await s.hub.sendImage('private:1', s.file)
  assert.equal(s.calls.length, 1)
  assert.match(s.calls[0].params.message[0].data.file, /^base64:\/\//)
})

