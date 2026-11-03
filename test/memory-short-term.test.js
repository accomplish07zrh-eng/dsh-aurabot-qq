import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { readMemoryState } from './helpers/memory-state.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createHub } from '../src/chat/hub.js'
import { createMemoryStore } from '../src/features/memory.js'

const QQ = '10000001'
const OTHER = '10000002'
const log = { info() {}, warn() {}, debug() {} }
const chat = (qq) => ({ kind: 'private', chatId: `private:${qq}`, userId: qq })

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'short-term-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({ ownerQQ: QQ, model: { provider: 'p', model: 'm' }, memory: { dailyConsolidate: false, keepChatlogDays: -1, gistEnabled: false } })
  const calls = []
  let answer = '正在聊旅行，还答应帮忙查路线。'
  let hook = null
  const dsh = { get: () => null, llm: { async *stream({ system, messages }) {
    calls.push({ system, text: messages[0].content[0].text })
    if (hook) await hook()
    if (answer instanceof Error) throw answer
    yield { type: 'text-delta', text: answer }
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
  return { cfg, hub, memory, calls, answer: (value) => { answer = value }, hook: (value) => { hook = value }, state: () => readMemoryState(dir) }
}

const note = (memory, via, text, at, qq = QQ) => memory.noteVia({ via, qq, who: 'user', text, at })

test('空闲后跨平台整合，使用范围只限本人私聊', async (t) => {
  const { memory, hub, calls, answer, state } = setup(t)
  const now = Date.now()
  note(memory, 'douyin', '两小时前的旧话题', now - 3 * 3600_000)
  note(memory, 'douyin', '准备去旅行', now - 4 * 60_000)
  await memory.tick()
  assert.equal(calls.length, 1)
  assert.doesNotMatch(calls[0].text, /两小时前的旧话题/)
  assert.match(memory.recallHint(chat(QQ), '继续'), /正在聊旅行/)
  assert.match(memory.contextVia({ qq: QQ }), /正在聊旅行/)
  assert.doesNotMatch(memory.recallHint(chat(OTHER), '继续'), /正在聊旅行/)
  assert.doesNotMatch(memory.recallHint({ kind: 'group', chatId: 'group:123', groupId: '123', userId: QQ }, '继续'), /正在聊旅行/)
  assert.equal(memory.personaPerson(QQ).shortTerm.text, '正在聊旅行，还答应帮忙查路线。')
  await memory.tick()
  assert.equal(calls.length, 1)
  answer('旅行计划改为下周，对方有点累。')
  hub.logChat(`private:${QQ}`, '主人', '改到下周', QQ, { at: now - 1000 })
  await memory.tick()
  assert.equal(calls.length, 2) // 抖音切到 QQ
  assert.match(calls[1].text, /旧印象.*正在聊旅行/)
  assert.equal(state().shortTerm[QQ].text, '旅行计划改为下周，对方有点累。')
  assert.doesNotMatch(state().shortTerm[QQ].text, /答应帮忙查路线/)
})

test('未空闲不调用；noteVia 切换平台触发，失败后保留并重试', async (t) => {
  const { memory, calls, answer } = setup(t)
  const now = Date.now()
  note(memory, 'douyin', '最近的话', now - 2000)
  await memory.tick()
  assert.equal(calls.length, 0)
  note(memory, 'heybox', '换个平台继续', now - 1000)
  await memory.tick()
  assert.equal(calls.length, 1)
  answer(new Error('模型不可用'))
  note(memory, 'douyin', '再换一个平台', now)
  await memory.tick()
  assert.match(memory.contextVia({ qq: QQ }), /正在聊旅行/)
  const failed = calls.length
  answer('新的整合印象。')
  await memory.tick()
  assert.ok(calls.length > failed)
  assert.match(memory.contextVia({ qq: QQ }), /新的整合印象/)
})

test('过期、关闭和忘掉都不再使用；忘掉期间的结果丢弃', async (t) => {
  const { memory, cfg, calls, hook, state } = setup(t)
  const now = Date.now()
  note(memory, 'douyin', '计划去旅行', now - 4 * 60_000)
  await memory.tick()
  cfg.memory.shortTermHours = 0.001
  assert.doesNotMatch(memory.contextVia({ qq: QQ }), /正在聊旅行/)
  cfg.memory.shortTermHours = 2
  cfg.memory.shortTerm = false
  assert.doesNotMatch(memory.contextVia({ qq: QQ }), /正在聊旅行/)
  note(memory, 'heybox', '新内容', now)
  await memory.tick()
  assert.equal(calls.length, 1)
  cfg.memory.shortTerm = true
  hook(() => { memory.handleCommand(chat(QQ), '忘掉计划去旅行'); hook(null) })
  await memory.tick()
  assert.equal(state().shortTerm?.[QQ], undefined)
  assert.doesNotMatch(memory.contextVia({ qq: QQ }), /正在聊旅行/)
  cfg.memory.shortTermHours = 0.000001
  await memory.tick()
  assert.doesNotMatch(memory.contextVia({ qq: QQ }), /正在聊旅行/)
})
