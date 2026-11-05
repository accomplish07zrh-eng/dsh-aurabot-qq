import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryLine } from '../src/features/memory.js'
import video, { videoFile } from '../src/modules/video/index.js'
import { SLOTS } from '../src/local/local.js'

function setup({ owner = true, result = 'D:/out/a.mp4', active = true, sendFails = false } = {}) {
  const sent = []
  const calls = []
  let tool = null
  let finish
  const done = new Promise((r) => { finish = r })
  const hub = {
    turnSendersAllOwner: () => owner,
    sendSegments: async (chatId, segs) => { if (sendFails) throw new Error('网关不收'); sent.push({ chatId, segs }); finish() },
    sendFile: async (chatId, file) => { sent.push({ chatId, file }); finish() },
    sendText: async (chatId, text) => { sent.push({ chatId, text }); finish() },
  }
  const local = { active: () => active, call: async (slot, args) => { calls.push({ slot, args }); if (result instanceof Error) throw result; return result } }
  const rules = []
  const api = { core: { hub, local }, log: { warn() {} }, rule: (f) => rules.push(f), tool: (f) => { tool = f }, onDispose() {} }
  video.setup(api)
  const chat = { chatId: 'private:1', kind: 'private' }
  return { get: (c = chat) => tool({ chat: c, sessionId: 's' }), rules, sent, calls, done }
}

test('video 槽位默认等 20 分钟', () => {
  assert.equal(SLOTS.video.file, 'video.mjs')
  assert.equal(SLOTS.video.timeoutMs, 20 * 60_000)
})

test('脚本返回路径或 { file }', () => {
  assert.equal(videoFile('a.mp4'), 'a.mp4')
  assert.equal(videoFile({ file: 'b.mp4' }), 'b.mp4')
  assert.equal(videoFile(null), '')
})

test('工具马上返回，做好后自动按视频发回聊天', async () => {
  const s = setup()
  const r = await s.get().execute({ prompt: '一条鱼', seconds: '3' })
  assert.equal(r.ok, true)
  await s.done
  assert.deepEqual(s.calls[0], { slot: 'video', args: { prompt: '一条鱼', seconds: 3 } })
  assert.equal(s.sent[0].segs[0].type, 'video')
  assert.match(s.sent[0].segs[0].data.file, /^file:/)
})

test('发视频失败时改发文件', async () => {
  const s = setup({ sendFails: true })
  await s.get().execute({ prompt: '一条鱼' })
  await s.done
  assert.equal(s.sent[0].file, 'D:/out/a.mp4')
})

test('失败时告诉对方', async () => {
  const s = setup({ result: new Error('显存不够') })
  await s.get().execute({ prompt: '一条鱼' })
  await s.done
  assert.match(s.sent[0].text, /没做成.*显存不够/)
})

test('只有主人能生成，后台会话和没开时没有工具，规则跟着开关走', async () => {
  const s = setup({ owner: false })
  assert.equal((await s.get().execute({ prompt: 'x' })).ok, false)
  assert.equal(s.calls.length, 0)
  assert.deepEqual(s.get({ chatId: 'system:x', kind: 'system' }), [])
  const off = setup({ active: false })
  assert.deepEqual(off.get(), [])
  assert.deepEqual(off.rules[0](), [])
  assert.match(setup().rules[0]()[0], /十几分钟/)
})

test('一次只跑一段', async () => {
  const s = setup()
  await s.get().execute({ prompt: 'a' })
  assert.equal((await s.get().execute({ prompt: 'b' })).ok, false)
  await s.done
})

test('记忆行带 QQ 号，重名分得清；已经带了就不重复', () => {
  assert.match(memoryLine({ at: Date.now(), text: '喜欢吃辣', aboutName: '小明', about: '123' }), /\[小明\(123\)\] 喜欢吃辣/)
  assert.match(memoryLine({ at: Date.now(), text: 'x', aboutName: '小明(123)', about: '123' }), /\[小明\(123\)\] x/)
  assert.match(memoryLine({ at: Date.now(), text: 'x', aboutName: '小明', about: '' }), /\[小明\] x/)
})
