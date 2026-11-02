import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { normalize } from '../src/core/config.js'

const root = mkdtempSync(join(tmpdir(), 'aurabot-said-'))
process.env.AURABOT_WORKSPACE = join(root, 'workspace')
const { createHub } = await import('../src/chat/hub.js')
const OWNER = '10000001', BOT = '20000002', CHAT = `private:${OWNER}`
const ownerChat = { kind: 'private', chatId: CHAT, userId: OWNER, groupId: '', nickname: '主人' }
const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
function setup(t, { patch = {}, brain = async () => '', hooks, onebot, onActivity, moodEffects, tts, stickers } = {}) {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(root, 'data-'))
  const cfg = normalize({ enabled: true, dryRun: false, setupDone: true, ownerQQ: OWNER, botQQ: BOT,
    allow: { private: [], groups: [] }, voice: { enabled: false }, merge: { enabled: false },
    stickers: { autoChance: 0 }, ...patch })
  const fake = createFakeDsh({ brain })
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    onebot: onebot || { async call() { return { message_id: 1 } } },
    hooks, onActivity, moodEffects, tts, stickers })
  fake.ctx.effect(() => fake.ctx.on('session/event', hub.onSessionEvent))
  t.after(() => { hub.dispose(); fake.dispose() })
  return { hub, fake }
}

test('本轮发送被网关挂住时，模块插话仍进入下一轮提示词', { timeout: 5000 }, async (t) => {
  const entered = deferred(), gate = deferred(), finished = deferred()
  t.after(() => gate.resolve())
  const { hub, fake } = setup(t, {
    brain: async ({ text }) => text.includes('开始本轮') ? '本轮回复' : '',
    onActivity: (activity) => { if (activity.kind === 'out') finished.resolve() },
    onebot: { async call(action, params) {
      if (action === 'send_private_msg' && params.message.some((s) => s.data?.text === '本轮回复')) {
        entered.resolve()
        await gate.promise
      }
      return { message_id: 1 }
    } },
  })
  await hub.pushToSession(ownerChat, [{ type: 'text', text: '开始本轮' }], OWNER)
  await entered.promise
  try { await hub.sendText(CHAT, '模块插话') } finally { gate.resolve() }
  await finished.promise
  await hub.pushToSession(ownerChat, [{ type: 'text', text: '下一轮' }], OWNER)
  const prompt = fake.turns.at(-1).userText
  assert.match(prompt, /主动说过[\s\S]*模块插话/)
  assert.doesNotMatch(prompt, /本轮回复/)
})

test('群聊刹车按整轮计数，模块消息另计一次', { timeout: 5000 }, async (t) => {
  const decisions = []
  const { hub } = setup(t, {
    patch: { allow: { private: [], groups: ['559'] },
      group: { burstMax: 2, interjectChance: 1, minRelevance: 0, quietHours: [0, 0] } },
    moodEffects: () => ({ delay: 0, sticker: 1, voice: 1, chatty: 1 }),
    hooks: { groupDecide: (decision) => { decisions.push({ ...decision }); return { reply: false } } },
  })
  const groupEvent = { post_type: 'message', message_type: 'group', sub_type: 'normal',
    self_id: Number(BOT), group_id: 559, user_id: 710, message_id: 1,
    sender: { user_id: 710, nickname: '群友' }, message: [{ type: 'text', data: { text: '天气不错' } }] }
  await hub.deliver('group:559', '第一条|||第二条', { currentTurn: true })
  await hub.onMessage(groupEvent)
  assert.equal(decisions.at(-1).reply, true, '两个气泡只算一轮，未触发刹车')
  await hub.sendText('group:559', '模块说的话')
  await hub.onMessage({ ...groupEvent, message_id: 2 })
  assert.match(decisions.at(-1).reason, /刚说了太多（2 次）/, '模块消息再算一次')
})

test('语音已发出而补发表情失败，整轮仍成功', { timeout: 5000 }, async (t) => {
  const audio = join(root, 'said-failure.wav')
  writeFileSync(audio, 'voice')
  const calls = []
  const { hub } = setup(t, {
    patch: { voice: { enabled: true, autoChance: 0, emojiSeparate: true }, stickers: { faces: true, autoChance: 0 } },
    tts: { speak: async () => ({ file: audio, engine: 'test' }) },
    onebot: { async call(action, params) {
      if (action === 'send_private_msg') {
        calls.push(params.message)
        if (params.message.some((s) => s.type === 'face')) throw new Error('表情发送失败')
      }
      return { message_id: 1 }
    } },
  })
  const result = await hub.deliver(CHAT, '<voice>晚安<face:呲牙>😁</voice>', { currentTurn: true })
  assert.deepEqual(calls.map((message) => message[0].type), ['record', 'face'])
  assert.equal(result.failed, 0)
})

test('语音、补发表情、表情包和图片按消息来源记账', { timeout: 5000 }, async (t) => {
  const audio = join(root, 'said-voice.wav')
  writeFileSync(audio, 'voice')
  const { hub, fake } = setup(t, {
    patch: { voice: { enabled: true, autoChance: 0, emojiSeparate: true },
      stickers: { enabled: true, faces: true, autoChance: 0 } },
    tts: { speak: async () => ({ file: audio, engine: 'test' }) },
    stickers: { match: () => ({ name: '测试', md5: '12345678' }), segmentFor: () => ({ type: 'image', data: { file: 'sticker' } }) },
  })
  for (const reply of ['<voice>自己的语音😁</voice>', '<sticker:测试>', `![图](${join(root, 'said-image.png')})`]) {
    await hub.deliver(CHAT, reply, { currentTurn: true })
  }
  await hub.deliver(CHAT, '<voice>模块语音😁</voice>')
  await hub.pushToSession(ownerChat, [{ type: 'text', text: '下一轮' }], OWNER)
  const prompt = fake.turns.at(-1).userText
  assert.match(prompt, /主动说过[\s\S]*模块语音/)
  assert.match(prompt, /😁/)
  assert.doesNotMatch(prompt, /自己的语音|\[图片\]/)
})
