// 回归：某天提炼预算用完后，每日整理不能每分钟重试刷屏（runs 要标记成今天跑过）。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { readMemoryState } from './helpers/memory-state.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'aurabot-budget-'))
let normalize
let createMemoryStore
before(async () => {
  process.env.AURABOT_DATA_DIR = join(ROOT, 'boot')
  mkdirSync(process.env.AURABOT_DATA_DIR, { recursive: true })
  ;({ normalize } = await import('../src/core/config.js'))
  ;({ createMemoryStore } = await import('../src/features/memory.js'))
})
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const hhmm = (d = new Date()) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

function setup () {
  const dir = join(ROOT, 'case')
  mkdirSync(dir, { recursive: true })
  process.env.AURABOT_DATA_DIR = dir
  const today = dayKey()
  const cfg = normalize({
    ownerQQ: '10000001',
    memory: { dailyConsolidate: true, extractDailyBatches: 0, consolidateTimes: [hhmm()], keepChatlogDays: 0, keepChatlogSet: true },
  })
  const logs = []
  const log = { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('WARN ' + a.join(' ')), debug: () => {} }
  const dsh = { get: () => null, llm: { async *stream () { yield { type: 'text-delta', text: '[]' }; yield { type: 'finish', reason: { kind: 'completed' } } }, listProviders: () => ['p'] } }
  const line = { chatId: 'group:9', who: '小明', text: '今天吃了白米饭', t: Date.now(), uid: '10000111' }
  const hub = { chatLogDays: () => [today], chatLogOf: () => [line], deleteChatLog: () => {}, speakersOf: () => [], lastTextOf: () => '', prevTextOf: () => '' }
  const mem = createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
  return { dir, cfg, mem, logs }
}

test('提炼预算用完：当天标记跑过，下一分钟不再重复整理刷屏', async () => {
  const { dir, mem, logs } = setup()
  await mem.tick()
  const first = logs.filter((l) => l.includes('整理临时记忆')).length
  assert.equal(first, 1, '第一次整理应该跑一次')
  assert.ok(logs.some((l) => l.includes('提炼预算')), '应该说明今天预算用完')
  const state = readMemoryState(dir)
  const runs = Object.values(state.runs || {})
  assert.ok(runs.includes(dayKey()), '今天的整理时间点要标记成跑过')

  const beforeCount = logs.filter((l) => l.includes('整理临时记忆')).length
  await mem.tick()
  await mem.tick()
  const afterCount = logs.filter((l) => l.includes('整理临时记忆')).length
  assert.equal(afterCount, beforeCount, '预算用完后不能每分钟重试整理')
})
