// 分条发出的中间段（chat.everyStep）只发原话：不转语音、不补表情、不按概率改形态。
// 判定「哪一段该发」在 steps.test.js；这里管「发的时候别加戏」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'

function setup(t, patch = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-interim-deliver-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const file = join(dir, 'voice.wav')
  writeFileSync(file, 'wav')
  // 一个 1x1 的 PNG，够 sendImage 认出来是图
  const png = join(dir, 'dot.png')
  writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  const calls = []
  const cfg = normalize({
    enabled: true,
    dryRun: false,
    workspaceDir: dir,
    files: { enabled: true, imageByPath: true, dirs: [dir] },
    voice: { enabled: true, autoChance: 1, autoMaxChars: 300 },
    stickers: { enabled: true, autoChance: 1 },
    ...patch,
  })
  const stickers = { match: () => null, segmentFor: () => null, pickForReply: () => null, markUsed: () => {} }
  const hub = createHub({
    dsh: {},
    stickers,
    getConfig: () => cfg,
    log: Object.fromEntries(['info', 'warn', 'debug', 'error'].map((k) => [k, () => {}])),
    onebot: { async call(action, params) { calls.push({ action, params }); return { message_id: 1 } } },
    tts: { async speak() { return { file, engine: 'test' } } },
  })
  t.after(() => {
    hub.dispose()
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
    rmSync(dir, { recursive: true, force: true })
  })
  return { hub, calls, png }
}

const segmentsOf = (calls) => calls.flatMap((c) => (c.params && c.params.message) || [])

test('中间段不转语音：就算对方要语音、概率也是 1', async (t) => {
  const s = setup(t)
  await s.hub.deliver('private:1', '这段是一句普通闲聊，长度完全在语音阈值内', { interim: true, wantVoice: true })
  const types = segmentsOf(s.calls).map((x) => x.type)
  assert.ok(!types.includes('record'), '中间段不该被改成语音条：' + JSON.stringify(types))
  assert.ok(types.includes('text'), '原话要以文字发出去')
})

test('中间段不补表情：表情概率 1 也不加', async (t) => {
  const s = setup(t)
  await s.hub.deliver('private:1', '一句短话', { interim: true })
  const segs = segmentsOf(s.calls)
  assert.equal(segs.length, 1, '只该有这一段文字：' + JSON.stringify(segs.map((x) => x.type)))
  assert.equal(segs[0].type, 'text')
})

test('普通回复照旧加戏：同样配置下会转语音', async (t) => {
  const s = setup(t)
  await s.hub.deliver('private:1', '一句短话', {})
  const types = segmentsOf(s.calls).map((x) => x.type)
  assert.ok(types.includes('record'), '对照组：不标 interim 时该转成语音：' + JSON.stringify(types))
})

test('中间段里的标签还是解析的：markdown 图片不会当文字发', async (t) => {
  const s = setup(t, { voice: { enabled: false }, stickers: { enabled: false } })
  await s.hub.deliver('private:1', '看这个 ![图](' + s.png + ')', { interim: true })
  const segs = segmentsOf(s.calls)
  assert.ok(segs.some((x) => x.type === 'image'), '图片段要发出来：' + JSON.stringify(segs.map((x) => x.type)))
  const text = segs.filter((x) => x.type === 'text').map((x) => x.data && x.data.text).join('')
  assert.ok(!text.includes('!['), 'markdown 语法不该漏成文字：' + text)
})
