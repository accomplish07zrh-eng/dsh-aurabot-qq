import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createHub } from '../src/chat/hub.js'
import { createMemoryStore } from '../src/features/memory.js'

const OWNER = '10000001'
const OTHER = '10000002'
const log = { info() {}, warn() {}, debug() {} }
const chat = (qq) => ({ kind: 'private', userId: qq, chatId: `private:${qq}` })

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-platform-memory-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({ ownerQQ: OWNER, ownerName: '主人', model: { provider: 'p', model: 'm' }, memory: { keepChatlogDays: 0, keepChatlogSet: true } })
  const calls = []
  const dsh = { get: () => null, llm: { async *stream({ system, messages }) {
    calls.push({ system, text: messages[0].content[0].text })
    yield { type: 'text-delta', text: system.includes('整理长期记忆') ? '[]' : '{"insights":[],"style":[]}' }
    yield { type: 'finish', reason: { kind: 'completed' } }
  } } }
  const hub = createHub({ dsh, getConfig: () => cfg, log, onebot: {}, stickers: {}, tts: {} })
  const memory = createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
  t.after(() => {
    hub.dispose()
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { hub, memory, calls }
}

test('平台对话进入同一份私聊流水，提炼时标明平台', async (t) => {
  const { hub, memory, calls } = setup(t)
  const at = Date.now() - 1000
  assert.deepEqual(memory.noteVia({ via: 'douyin', qq: OWNER, who: 'user', text: '我喜欢吃芒果', at }), { ok: true })
  assert.deepEqual(memory.noteVia({ via: 'douyin', qq: OWNER, who: 'bot', text: '我记得啦', at }), { ok: true })
  assert.deepEqual(memory.noteVia({ via: 'heybox', qq: OWNER, who: 'user', text: '我喜欢玩游戏', at }), { ok: true })
  assert.deepEqual(memory.noteVia({ via: 'other', qq: OWNER, who: 'user', text: '我喜欢看电影', at }), { ok: true })
  const rows = hub.chatLogDays().flatMap((day) => hub.chatLogOf(day))
  assert.equal(rows.length, 4)
  assert.deepEqual(rows.map((r) => [r.chatId, r.who, r.uid, r.via, r.t]), [
    [`private:${OWNER}`, '主人', OWNER, 'douyin', at],
    [`private:${OWNER}`, 'bot', undefined, 'douyin', at],
    [`private:${OWNER}`, '主人', OWNER, 'heybox', at],
    [`private:${OWNER}`, '主人', OWNER, 'other', at],
  ])
  assert.equal((await memory.consolidate({ includeToday: true })).ok, true)
  const extraction = calls.find((c) => c.system.includes('整理长期记忆')).text
  assert.match(extraction, /\[抖音\].*我喜欢吃芒果/)
  assert.match(extraction, /\[小黑盒\].*我喜欢玩游戏/)
  assert.match(extraction, /\[other\].*我喜欢看电影/)
})

test('平台上下文和对应 QQ 私聊一致，非主人只看到自己的记忆', (t) => {
  const { memory } = setup(t)
  memory.setProfile(OWNER, '主人喜欢芒果')
  memory.setProfile(OTHER, '朋友喜欢芒果')
  memory.add({ text: '主人喜欢芒果蛋糕', about: OWNER, chatId: `private:${OWNER}` })
  memory.add({ text: '朋友喜欢芒果冰淇淋', about: OTHER, chatId: `private:${OTHER}` })
  const query = '芒果'
  for (const qq of [OWNER, OTHER]) {
    const expected = [memory.contextFor(chat(qq), ''), memory.recallHint(chat(qq), query, '', '')].filter(Boolean).join('\n')
    assert.equal(memory.contextVia({ qq, query }), expected)
  }
  const other = memory.contextVia({ qq: OTHER, query })
  assert.match(other, /朋友喜欢芒果/)
  assert.doesNotMatch(other, /主人喜欢芒果/)
  assert.match(memory.contextVia({ qq: OWNER, query }), /主人喜欢芒果/)
})

test('非法参数拒绝写入，不调用接口时普通流水不变', (t) => {
  const { hub, memory } = setup(t)
  for (const args of [
    { via: 'douyin', qq: 'abc', who: 'user', text: '你好' },
    { via: ' ', qq: OWNER, who: 'user', text: '你好' },
    { via: 'douyin', qq: OWNER, who: 'user', text: ' ' },
    { via: 'douyin', qq: OWNER, who: 'other', text: '你好' },
    {},
  ]) assert.deepEqual(memory.noteVia(args), { ok: false })
  assert.equal(memory.contextVia({ qq: '12x', query: '你好' }), '')
  assert.deepEqual(hub.chatLogDays(), [])
  hub.logChat(`private:${OWNER}`, '主人', '普通 QQ 消息', OWNER)
  const rows = hub.chatLogDays().flatMap((day) => hub.chatLogOf(day))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].text, '普通 QQ 消息')
  assert.equal(Object.hasOwn(rows[0], 'via'), false)
})
