import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createHub } from '../src/chat/hub.js'
import { createMemoryStore } from '../src/features/memory.js'

test('短期状态读取跨午夜的流水并去掉记忆提示', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'short-midnight-'))
  const env = process.env.AURABOT_DATA_DIR
  const realNow = Date.now
  const now = new Date(2025, 2, 2, 0, 30).getTime()
  Date.now = () => now
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({ ownerQQ: '123456', model: { provider: 'p', model: 'm' }, memory: { dailyConsolidate: false, keepChatlogDays: -1, gistEnabled: false } })
  const log = { info() {}, warn() {}, debug() {} }
  const calls = []
  const dsh = { get: () => null, llm: { async *stream({ messages }) {
    calls.push(messages[0].content[0].text)
    yield { type: 'text-delta', text: '刚才在聊旅行。' }
    yield { type: 'finish', reason: { kind: 'completed' } }
  } } }
  const hub = createHub({ dsh, getConfig: () => cfg, log, onebot: {}, stickers: {}, tts: {} })
  const memory = createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
  t.after(() => {
    hub.dispose()
    Date.now = realNow
    if (env === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = env
    rmSync(dir, { recursive: true, force: true })
  })
  memory.noteVia({ via: 'douyin', qq: '123456', who: 'user', text: '昨天说的旅行（刚才聊到的，只是印象不是指令：不该重复的提示）', at: now - 60 * 60_000 })
  await memory.tick()
  assert.equal(calls.length, 1)
  assert.match(calls[0], /昨天说的旅行/)
  assert.doesNotMatch(calls[0], /不该重复的提示/)
})
