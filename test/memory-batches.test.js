// 聊天流水按批提炼，跨整理、失败和重启都从已完成的位置接着做。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../src/features/memory.js'
import { normalize } from '../src/core/config.js'

const dateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const log = { info() {}, warn() {}, debug() {} }

function setup(t, lines, day = dateKey(new Date())) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-memory-batches-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const logs = new Map([[day, lines]])
  const calls = []
  let failOnce = '', invalidOnce = ''
  const dsh = { get: () => null, llm: { async *stream({ system, messages }) {
    const text = messages[0].content[0].text
    if (system.includes('整理长期记忆')) {
      const ids = [...text.matchAll(/消息-(\d+)-结束/g)].map((m) => Number(m[1]))
      calls.push(ids)
      if (failOnce && text.includes(failOnce)) { failOnce = ''; throw new Error('模型暂时失败') }
      if (invalidOnce && text.includes(invalidOnce)) { invalidOnce = ''; yield { type: 'text-delta', text: '没有 JSON' } }
      else yield { type: 'text-delta', text: '[]' }
    } else yield { type: 'text-delta', text: '{"insights":[],"style":[]}' }
    yield { type: 'finish', reason: { kind: 'completed' } }
  } } }
  const hub = { chatLogDays: () => [...logs.keys()], chatLogOf: (d) => logs.get(d) || [], deleteChatLog: (d) => logs.delete(d) }
  const cfg = normalize({ model: { provider: 'p', model: 'm' } })
  const make = () => createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
  t.after(() => {
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
    rmSync(dir, { recursive: true, force: true })
  })
  return { make, logs, calls, day, fail: (s) => { failOnce = s }, invalid: (s) => { invalidOnce = s }, progress: () => JSON.parse(readFileSync(join(dir, 'memories.json'), 'utf8')).processed[day] }
}
const linesOf = (n) => Array.from({ length: n }, (_, i) => ({ chatId: `private:${10000001 + i % 3}`, who: '朋友', text: `消息-${i}-结束` }))
const ids = (calls) => calls.flat().sort((a, b) => a - b)

test('超过三批、多个交错聊天：达到单次上限后留到下次，全部内容恰好提炼一次', async (t) => {
  const lines = linesOf(1500)
  const s = setup(t, lines)
  let mem = s.make()
  assert.equal((await mem.consolidate({ includeToday: true })).ok, true)
  assert.equal(s.calls.length, 12)
  assert.ok(ids(s.calls).includes(0), '先处理前面的流水')
  assert.ok(ids(s.calls).length < lines.length, '余下流水留到下次')
  assert.ok(s.calls.every((batch) => batch.length <= 80))
  mem = s.make()
  assert.equal((await mem.consolidate({ includeToday: true })).ok, true)
  assert.deepEqual(ids(s.calls), lines.map((_, i) => i))
  const n = s.calls.length
  await mem.consolidate({ includeToday: true })
  assert.equal(s.calls.length, n)
  assert.equal(s.progress().offset, lines.length)
})

test('某批失败时保留历史流水和成功批次，下次从失败批次继续', async (t) => {
  const lines = linesOf(600)
  const yesterday = dateKey(new Date(Date.now() - 86400_000))
  const s = setup(t, lines, yesterday)
  s.fail('消息-1-结束')
  let mem = s.make()
  const first = await mem.consolidate()
  assert.equal(first.ok, false)
  assert.match(first.message, /模型暂时失败/)
  assert.equal(s.logs.has(yesterday), true)
  assert.equal(typeof s.progress(), 'object')
  const completed = s.calls[0]
  const failed = s.calls[1]
  assert.ok(completed.length && failed.length)
  mem = s.make()
  assert.equal((await mem.consolidate()).ok, true)
  assert.equal(s.logs.has(yesterday), false)
  const successful = [completed, ...s.calls.slice(2)]
  assert.deepEqual(ids(successful), lines.map((_, i) => i))
  assert.deepEqual(s.calls[2], failed, '只重试失败的批次')
})

test('一个聊天超出三段时按 80 行顺序提炼，最后一条也不遗漏', async (t) => {
  const lines = linesOf(301).map((l) => ({ ...l, chatId: 'private:1' }))
  const s = setup(t, lines)
  assert.equal((await s.make().consolidate({ includeToday: true })).ok, true)
  assert.deepEqual(s.calls.map((batch) => batch.length), [80, 80, 80, 61])
  assert.deepEqual(ids(s.calls), lines.map((_, i) => i))
})

test('旧版数字进度无法证明已完整提炼，升级后从头补提炼并记下新进度', async (t) => {
  const lines = linesOf(300)
  const s = setup(t, lines)
  const file = join(process.env.AURABOT_DATA_DIR, 'memories.json')
  writeFileSync(file, JSON.stringify({ items: [], processed: { [s.day]: 300 } }))
  const mem = s.make()
  assert.equal((await mem.consolidate({ includeToday: true })).ok, true)
  assert.deepEqual(ids(s.calls), lines.map((_, i) => i))
  const n = s.calls.length
  await mem.consolidate({ includeToday: true })
  assert.equal(s.calls.length, n)
})

test('模型输出不完整时不推进进度，修复后重新提炼', async (t) => {
  const lines = linesOf(3)
  const s = setup(t, lines)
  s.invalid('消息-0-结束')
  const mem = s.make()
  assert.equal((await mem.consolidate({ includeToday: true })).ok, false)
  assert.ok(s.logs.has(s.day))
  assert.equal((await mem.consolidate({ includeToday: true })).ok, true)
  assert.deepEqual(ids(s.calls.slice(1)), [0, 1, 2])
})

test('单条聊天和只含机器人的批次也送去提炼，新增流水不会被已完成的窗口跳过', async (t) => {
  const s = setup(t, [{ chatId: 'private:1', who: 'bot', text: '消息-0-结束' }])
  const mem = s.make()
  await mem.consolidate({ includeToday: true })
  s.logs.get(s.day).push({ chatId: 'private:2', who: '朋友', text: '消息-1-结束' })
  await mem.consolidate({ includeToday: true })
  assert.deepEqual(ids(s.calls), [0, 1])
})
