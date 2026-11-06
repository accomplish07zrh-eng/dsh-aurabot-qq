// 用量记账的去重口径：一次模型调用最多记一行，聊天回合和后台任务两路不重叠。
//
// 这是 PR 评审要的那条保证：
//   · 后台任务走 askModel → llm.stream，只在流结束时按「最后一次 usage」记一行；
//     适配器分片上报多个 usage 块也只记一次。
//   · 聊天回合走 DSH 会话的 assistant/message 事件（hub 里记），askModel 不参与聊天回合，
//     所以同一次调用不会被两路各记一遍。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir
let usage
let askModel

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aurabot-accounting-'))
  process.env.AURABOT_DATA_DIR = dir
  usage = await import('../src/core/usage.js')
  usage.initUsage()
  ;({ askModel } = await import('../src/core/llm.js'))
})

after(() => {
  delete process.env.AURABOT_DATA_DIR
  try { rmSync(dir, { recursive: true, force: true }) } catch (error) {}
})

const snap = () => {
  const r = usage.usageReport({ range: 'today' })
  return { runs: r.current.runs, tokens: r.current.totalTokens, modules: r.current.byModule }
}
const moduleRuns = (modules, key) => (modules.find((m) => m.key === key) || { runs: 0 }).runs

/** 假宿主：llm.stream 按给定块吐，够 askModel 走完整流程。 */
function fakeDsh(chunks) {
  const llm = {
    async *stream() {
      for (const c of chunks) yield c
    },
    async resolveModelInfo() { return { inputModalities: ['text'], reasoningEfforts: null } },
  }
  return { llm, get: (name) => (name === 'llm' ? llm : null) }
}

test('一次调用只记一行：适配器分片上报多个 usage 也只按最后一次算', async () => {
  const before = snap()
  const dsh = fakeDsh([
    { type: 'text-delta', index: 0, text: '好' },
    { type: 'usage', usage: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 0 } }, // 中间分片
    { type: 'usage', usage: { inputTokens: 900, outputTokens: 50, cacheReadTokens: 800 } }, // 最终用量
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  await askModel(dsh, { system: 's', text: 't', module: 'memory', model: { provider: 'local', model: 'deepseek-v4.1-flash' } })
  const after = snap()
  assert.equal(after.runs - before.runs, 1, '一次调用只记一行')
  assert.equal(after.tokens - before.tokens, 900 + 800 + 50, '取最后一次 usage，不把中间分片也算进去')
  assert.equal(moduleRuns(after.modules, '记忆') - moduleRuns(before.modules, '记忆'), 1, '模块名按调用方 id 记')
})

test('流报错也记（已经计费了），但仍然只有一行', async () => {
  const before = snap()
  const dsh = fakeDsh([
    { type: 'usage', usage: { inputTokens: 500, outputTokens: 10, cacheReadTokens: 0 } },
    { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } },
  ])
  await assert.rejects(
    () => askModel(dsh, { system: 's', text: 't', module: 'stickers', model: { provider: 'local', model: 'deepseek-v4.1-flash' } }),
    /boom/,
  )
  const after = snap()
  assert.equal(after.runs - before.runs, 1, '报错那次也只记一行')
  assert.equal(moduleRuns(after.modules, '表情包') - moduleRuns(before.modules, '表情包'), 1)
})

test('聊天回合与后台任务口径互斥：各模块加起来正好等于总调用数', () => {
  // 会话事件那一路的入参形状：hub 在 assistant/message 上按 { module: 聊天, chat, model, usage } 记
  const before = snap()
  usage.recordUsage({ module: usage.moduleLabel('group:1'), chat: 'group:1', model: 'deepseek-v4.1-flash', usage: { inputTokens: 2000, outputTokens: 100 }, at: Date.now() })
  const after = snap()
  assert.equal(after.runs - before.runs, 1)
  assert.equal(moduleRuns(after.modules, '聊天') - moduleRuns(before.modules, '聊天'), 1)
  const sum = after.modules.reduce((n, m) => n + m.runs, 0)
  assert.equal(sum, after.runs, '各模块的调用数加起来必须等于总调用数，说明没有重复计入')
})
