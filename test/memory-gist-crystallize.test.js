// 印象结晶：被反复想起的月印象到期前留成永久记忆，没人想的照常清掉。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { readMemoryState, writeMemoryState } from './helpers/memory-state.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createMemoryStore } from '../src/features/memory.js'

const OWNER = '10000001'
const DAY = 86400_000
const log = { info() {}, warn() {}, debug() {} }
const privateChat = (qq) => ({ kind: 'private', userId: qq, chatId: `private:${qq}` })

function setup(t, answer = () => '[]') {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-crystallize-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const calls = []
  const cfg = normalize({ ownerQQ: OWNER, botQQ: '20000001', model: { provider: 'p', model: 'm' }, memory: { keepChatlogDays: 0, keepChatlogSet: true } })
  const hub = { chatLogDays: () => [], chatLogOf: () => [], deleteChatLog: () => {}, speakersOf: () => [] }
  const dsh = { get: () => null, llm: { async *stream({ system, messages }) {
    const text = messages[0].content[0].text
    calls.push({ system, text })
    const response = await answer({ system, text, calls })
    if (response instanceof Error) throw response
    yield { type: 'text-delta', text: response || '[]' }
    yield { type: 'finish', reason: { kind: 'completed' } }
  } } }
  const make = () => createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
  const state = () => readMemoryState(dir)
  const put = (s) => writeMemoryState(dir, s)
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { cfg, calls, make, state, put }
}

const reflect = '{"insights":[],"style":[]}'

test('印象结晶：被想起够多次的到期印象留成永久记忆，没人想的不留', async (t) => {
  const s = setup(t)
  const now = Date.now()
  s.put({ items: [], gists: [
    { id: 'often', kind: 'gist', chatId: `private:${OWNER}`, about: OWNER, scope: '', level: 2, text: '主人爱我', at: now - 366 * DAY, saidAt: now - 400 * DAY, hits: 5 },
    { id: 'cold', kind: 'gist', chatId: `private:${OWNER}`, about: OWNER, scope: '', level: 2, text: '聊过一次围棋', at: now - 366 * DAY, saidAt: now - 500 * DAY, hits: 1 },
    { id: 'fresh', kind: 'gist', chatId: `private:${OWNER}`, about: OWNER, scope: '', level: 2, text: '最近很开心', at: now - 100 * DAY, saidAt: now - 100 * DAY, hits: 9 },
  ] })
  const mem = s.make()
  await mem.consolidate()
  const items = s.state().items
  const kept = items.find((m) => m.text === '主人爱我')
  assert.ok(kept, '被反复想起的印象要结晶成记忆')
  assert.equal(kept.tier, 0, '结晶出的是永久档')
  assert.equal(kept.source, 'gist')
  assert.equal(kept.chatId, `private:${OWNER}`)
  assert.ok(!items.some((m) => m.text === '聊过一次围棋'), '没人想的印象不结晶')
  assert.deepEqual(s.state().gists.map((g) => g.id), ['fresh'], '到期的印象都清掉，没到期的留下')
  assert.match(mem.recallHint(privateChat(OWNER), '主人爱我'), /主人爱我/, '结晶出的记忆还能被想起')
})

test('印象结晶：关掉梗概功能时不结晶也不清印象，行为不变', async (t) => {
  const s = setup(t)
  s.cfg.memory.gistEnabled = false
  const now = Date.now()
  s.put({ items: [], gists: [
    { id: 'often', kind: 'gist', chatId: `private:${OWNER}`, about: OWNER, scope: '', level: 2, text: '主人爱我', at: now - 366 * DAY, hits: 5 },
  ] })
  const mem = s.make()
  await mem.consolidate()
  assert.equal(s.state().gists.length, 1, '梗概关着时不清理印象')
  assert.equal(s.state().items.length, 0, '也不结晶')
})
