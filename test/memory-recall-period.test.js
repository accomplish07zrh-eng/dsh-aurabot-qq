// 定点查记忆：recall_memory 的 period 时间窗透传到检索层，过期记忆在窗口内仍能翻出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import memoryModule from '../src/modules/memory/index.js'

const OWNER = '10000001'
const DAY = 86400_000
const log = { info() {}, warn() {}, debug() {} }
const dayStr = (offset) => {
  const d = new Date(Date.now() - offset * DAY)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-recall-period-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({ ownerQQ: OWNER, botQQ: '20000001', model: { provider: 'p', model: 'm' } })
  const builders = []
  const mem = memoryModule.setup({
    core: { hub: {}, http: { query: () => ({}), body: async () => ({}) } },
    config: () => cfg,
    log,
    dsh: { get: () => null, llm: { async *stream() { throw new Error('测试不该调用模型') } } },
    context: () => {},
    on: () => {},
    every: () => {},
    route: () => {},
    tool: (builder) => builders.push(builder),
  })
  const chat = { kind: 'private', userId: OWNER, chatId: `private:${OWNER}` }
  const tool = builders.flatMap((b) => b({ chat, level: 'full', sessionId: 's1' })).find((x) => x.name === 'recall_memory')
  assert.ok(tool, '应该注册 recall_memory 工具')
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { mem, tool }
}

test('recall_memory：period 定点翻出已过期的记忆，不填保持原行为', async (t) => {
  const { mem, tool } = setup(t)
  const r = mem.add({ text: '主人约了那天一起看樱花', about: OWNER, source: 'tool', chatId: `private:${OWNER}`, validFrom: dayStr(40), validUntil: dayStr(10), importance: 0.6 })
  assert.equal(r.ok, true)

  const outside = await tool.execute({ query: '樱花' })
  assert.equal(outside.ok, true)
  assert.equal(outside.message, '没想起相关的事', '过期的记忆默认不翻出')

  const inside = await tool.execute({ query: '樱花', period: `${dayStr(40)}..${dayStr(10)}` })
  assert.equal(inside.ok, true)
  assert.match(inside.message, /樱花/)

  const oneDay = await tool.execute({ query: '樱花', period: dayStr(40) })
  assert.equal(oneDay.ok, true)
  assert.match(oneDay.message, /樱花/)
})

test('recall_memory：period 格式不对时拒绝并提示，不影响不带 period 的调用', async (t) => {
  const { mem, tool } = setup(t)
  const bad = await tool.execute({ query: '樱花', period: '那天之前' })
  assert.equal(bad.ok, false)
  assert.match(bad.message, /period 没认出来/)

  const reversed = await tool.execute({ query: '樱花', period: `${dayStr(10)}..${dayStr(40)}` })
  assert.equal(reversed.ok, false)

  const plain = await tool.execute({ query: '普通的一句' })
  assert.equal(plain.ok, true)
})
