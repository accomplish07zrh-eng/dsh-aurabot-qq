// token 用量与花费：算价（新输入 / 缓存命中 / 输出三段、峰谷翻倍）和按区间 / 模块 / 聊天 / 模型的汇总。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir
let usage

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aurabot-usage-'))
  process.env.AURABOT_DATA_DIR = dir
  usage = await import('../src/core/usage.js')
  usage.initUsage()
})

after(() => {
  delete process.env.AURABOT_DATA_DIR
  try { rmSync(dir, { recursive: true, force: true }) } catch (error) {}
})

// 北京时间：周五 10:00 = 峰时；周六 23:00 = 空闲
const PEAK_AT = Date.UTC(2026, 10, 6, 2, 0, 0)
const OFF_AT = Date.UTC(2026, 10, 7, 15, 0, 0)

// DSH 的 in 是「未命中」的那部分，cached 是命中前缀缓存的那部分：总输入 = 200k + 800k = 1M
const row = { model: 'deepseek-v4.1-flash', in: 200_000, cached: 800_000, out: 100_000 }

test('算价：新输入按未命中价，缓存命中单独算，输出单独算', () => {
  // 0.2M×1 + 0.8M×0.02 + 0.1M×4 = 0.2 + 0.016 + 0.4
  const c = usage.costOf(row, OFF_AT)
  assert.ok(Math.abs(c.cost - 0.616) < 1e-9, '实际 ' + c.cost)
  assert.ok(Math.abs(c.fresh - 0.2) < 1e-9)
  assert.ok(Math.abs(c.cached - 0.016) < 1e-9)
  assert.ok(Math.abs(c.output - 0.4) < 1e-9)
  assert.equal(c.unpriced, false)
})

test('算价：峰时翻倍，周末不翻', () => {
  const off = usage.costOf(row, OFF_AT).cost
  const peak = usage.costOf(row, PEAK_AT).cost
  assert.ok(Math.abs(peak - off * 2) < 1e-9, `峰时应该是闲时两倍：${peak} vs ${off}`)
  assert.equal(usage.costOf(row, PEAK_AT).peak, true)
  const sat = usage.costOf(row, Date.UTC(2026, 10, 7, 2, 0, 0)) // 同一个钟点的周六
  assert.ok(Math.abs(sat.cost - off) < 1e-9)
  assert.equal(sat.peak, false)
})

test('算价：pro 用 pro 价，认不出的模型算「未定价」', () => {
  assert.ok(usage.costOf({ ...row, model: 'deepseek-v4-pro' }, OFF_AT).cost > usage.costOf(row, OFF_AT).cost * 3)
  const unknown = usage.costOf({ ...row, model: 'some-local-llm' }, OFF_AT)
  assert.equal(unknown.unpriced, true)
  assert.equal(unknown.cost, 0)
})

test('汇总：今日 / 昨日 / 近 7 天 / 近 30 天各算各的，并按模块 / 聊天 / 模型分组', () => {
  const today = Date.UTC(2026, 10, 6, 2, 0, 0) // 北京 2026-11-06 10:00
  const day = 86_400_000
  const model = 'deepseek-v4.1-flash'
  usage.recordUsage({ module: '聊天', chat: 'group:1', model, usage: { inputTokens: 3000, outputTokens: 500 }, at: today })
  usage.recordUsage({ module: '聊天', chat: 'group:1', model, usage: { inputTokens: 2000, outputTokens: 200, cacheReadTokens: 1000 }, at: today })
  usage.recordUsage({ module: '记忆', model, usage: { inputTokens: 1000, outputTokens: 100 }, at: today })
  usage.recordUsage({ module: '聊天', chat: 'private:2', model, usage: { inputTokens: 4000, outputTokens: 400 }, at: today - day })
  usage.recordUsage({ module: '日记', model, usage: { inputTokens: 700, outputTokens: 70 }, at: today - 8 * day })

  const r = usage.usageReport({ now: today + 3600_000 })
  assert.equal(r.ranges.today.runs, 3)
  // 合计 = 总输入（未命中 6000 + 命中 1000）+ 输出 800
  assert.equal(r.ranges.today.totalTokens, 7000 + 800)
  assert.equal(r.ranges.today.cachedTokens, 1000)
  assert.equal(r.ranges.today.promptTokens, 3000 + 2000 + 1000 + 1000, '总输入 = 未命中 + 命中')
  assert.ok(r.ranges.today.cacheHitRate > 0 && r.ranges.today.cacheHitRate < 1)
  assert.equal(r.ranges.yesterday.runs, 1)
  assert.equal(r.ranges.last7.runs, 4, '近 7 天含今天和昨天，不含 8 天前')
  assert.equal(r.ranges.last30.runs, 5)

  assert.deepEqual(r.current.byModule.map((m) => m.key), ['聊天', '记忆'], '按花费从大到小')
  assert.equal(r.current.byModule[0].runs, 3)
  assert.equal(r.current.byChat.map((c) => c.key).includes('group:1'), true)
  assert.deepEqual(r.current.byModel.map((m) => m.key), [model])
  assert.ok(r.current.cost > 0)
})

test('未定价的调用单独列出来，不算进花费', () => {
  const at = Date.UTC(2026, 10, 6, 2, 0, 0)
  usage.recordUsage({ module: '聊天', model: 'weird-model-x', usage: { inputTokens: 5000, outputTokens: 500 }, at })
  const r = usage.usageReport({ now: at + 60_000 })
  assert.equal(r.current.unpricedCalls >= 1, true)
  assert.ok((r.current.unpricedModels || []).some((m) => m.model === 'weird-model-x'))
})

test('只记数字，不含内容；空用量直接跳过', () => {
  const before = usage.usageReport({ now: PEAK_AT }).ranges.last30.runs
  assert.equal(usage.recordUsage({ module: '聊天', usage: null }), null)
  assert.equal(usage.recordUsage({ module: '聊天', usage: { inputTokens: 0, outputTokens: 0 } }), null)
  assert.equal(usage.usageReport({ now: PEAK_AT }).ranges.last30.runs, before)
})

test('价格表可以覆盖（config.usage.pricing）', () => {
  // 同名条目会被整个替换（其余的价目表继续生效）
  usage.initUsage({ models: { 'deepseek-flash': { match: 'deepseek', in: 0, out: 0, cached: 0 } } })
  assert.equal(usage.costOf(row, OFF_AT).cost, 0, '全填 0 就是 0')
  usage.initUsage()
  assert.ok(usage.costOf(row, OFF_AT).cost > 0)
})

test('价目表：多家厂商都认，DeepSeek 之外的没有峰谷价', () => {
  // DeepSeek：官方价，峰时翻倍
  assert.equal(usage.priceOf('deepseek-v4.1-flash', OFF_AT).in, 1)
  assert.equal(usage.priceOf('trae/deepseek-v4.1-flash-max', OFF_AT).out, 4, '带前缀的模型名也认')
  assert.equal(usage.priceOf('deepseek-v4-pro', OFF_AT).out, 13.5, 'pro 走 pro 价')
  assert.equal(usage.priceOf('deepseek-v4.1-flash', PEAK_AT).in, 2)
  // 其它厂商：LiteLLM 价 ×7.2 折元，峰时不翻倍
  assert.equal(usage.priceOf('gpt-4o-mini', OFF_AT).in, 1.08)
  assert.equal(usage.priceOf('gpt-4o-mini', PEAK_AT).in, 1.08, '非 DeepSeek 没有峰谷价')
  assert.equal(usage.priceOf('claude-sonnet-4-5', OFF_AT).out, 108)
  assert.equal(usage.priceOf('gemini-2.5-flash', OFF_AT).in, 2.16)
  assert.equal(usage.priceOf('kimi-k2.6', OFF_AT).out, 28.8)
  assert.equal(usage.priceOf('qwen-max', OFF_AT).in, 12.17)
  assert.equal(usage.priceOf('glm-4.6', OFF_AT).out, 15.84)
  assert.equal(usage.priceOf('doubao-seed-2-0-pro', OFF_AT).in, 3.47)
  // 认不出来的还是未定价
  assert.equal(usage.priceOf('some-local-llm', OFF_AT), null)
  assert.equal(usage.priceOf('', OFF_AT), null)
})

test('价目表：可以在 config.usage.pricing 里加自己的模型（match 是字符串正则）', () => {
  usage.initUsage({ models: { 'my-llm': { match: '^my-llm-', in: 2, out: 8, cached: 0.5 } } })
  assert.deepEqual(usage.priceOf('my-llm-7b', OFF_AT), { in: 2, out: 8, cached: 0.5, peak: false })
  assert.ok(usage.priceOf('deepseek-v4.1-flash', OFF_AT), '自己加的条目是往上加，不冲掉内置价')
  usage.initUsage()
  assert.ok(usage.priceOf('deepseek-v4.1-flash', OFF_AT))
})

test('后台任务按功能分：聊天不拆，后台轮次按模块名拆开', () => {
  assert.equal(usage.moduleLabel('group:602656027'), '聊天')
  assert.equal(usage.moduleLabel('private:1316149505'), '聊天')
  assert.equal(usage.moduleLabel('system:diary'), '空间日记（后台）')
  assert.equal(usage.moduleLabel('system:ext-heybox'), '刷小黑盒（后台）')
  assert.equal(usage.moduleLabel('system:bili'), '刷 B 站（后台）')
  assert.equal(usage.moduleLabel('memory'), '记忆')
  assert.equal(usage.moduleLabel('mood'), '心情')
  assert.equal(usage.moduleLabel('未知模块'), '未知模块', '认不出的模块原样显示')
  assert.equal(usage.moduleLabel(''), '其他后台任务')

  const at = Date.UTC(2026, 10, 8, 4, 0, 0)
  usage.recordUsage({ module: usage.moduleLabel('system:diary'), model: 'deepseek-v4.1-flash', usage: { inputTokens: 1000, outputTokens: 100 }, at })
  usage.recordUsage({ module: usage.moduleLabel('system:purpose'), model: 'deepseek-v4.1-flash', usage: { inputTokens: 2000, outputTokens: 200 }, at })
  usage.recordUsage({ module: usage.moduleLabel('memory'), model: 'deepseek-v4.1-flash', usage: { inputTokens: 500, outputTokens: 50 }, at })
  const r = usage.usageReport({ now: at + 60_000, range: 'today' })
  const names = r.current.byModule.map((m) => m.key)
  assert.ok(names.includes('空间日记（后台）'), '后台轮次要按功能分开，不是一坨「后台会话」')
  assert.ok(names.includes('目的引擎（后台）'))
  assert.ok(names.includes('记忆'))
})

test('旧标签归置：打标签前的那批行读出来也要人看得懂', () => {
  // 有模型名 = 加了标签之前的 askModel 调用（回查是记忆模块）
  assert.equal(usage.moduleOf({ module: '后台任务', model: 'deepseek-v4.1-flash' }), '记忆（回查）')
  // 没模型名 = 从 v1 老格式摊出来的聚合行，查不出来就照实说
  assert.equal(usage.moduleOf({ module: '后台任务', model: '' }), '其他后台任务')
  assert.equal(usage.moduleOf({ module: '后台会话', model: '' }), '其他后台任务')
  // 新数据原样通过
  assert.equal(usage.moduleOf({ module: '聊天', model: 'deepseek-v4.1-flash' }), '聊天')
  assert.equal(usage.moduleOf({ module: '记忆', model: 'deepseek-v4.1-flash' }), '记忆')
  assert.equal(usage.moduleOf({ module: '', model: '' }), '其他后台任务')
  assert.equal(usage.moduleOf({ module: '其它后台', model: 'x' }), '其他后台任务', '认不出的一律归到「其他后台任务」')
})

test('旧数据没记模型名：按 DeepSeek flash 价估，不能算成「未定价」白用 token', () => {
  const old = { in: 3096, cached: 4992, out: 331, model: '' }
  const c = usage.costOf({ ...old, at: OFF_AT })
  // 3096×1 + 4992×0.02 + 331×4 都按百万算
  const expect = (3096 * 1 + 4992 * 0.02 + 331 * 4) / 1_000_000
  assert.ok(Math.abs(c.cost - expect) < 1e-9, `实际 ${c.cost} 期望 ${expect}`)
  assert.equal(c.unpriced, false)
  // 真认不出的模型名还是未定价
  assert.equal(usage.costOf({ ...old, model: 'mystery-llm', at: OFF_AT }).unpriced, true)

  const at = Date.UTC(2026, 10, 9, 4, 0, 0)
  usage.recordUsage({ module: '其他后台任务', model: '', usage: { inputTokens: 1000, outputTokens: 100 }, at })
  const r = usage.usageReport({ now: at + 60_000, range: 'today' })
  assert.ok(r.current.assumedCalls >= 1, '要能数出有几条是按默认价估的')
  assert.ok(r.current.cost > 0, '按默认价估之后要有花费')
})

test('口径：inputTokens 是未命中缓存的输入，cacheReadTokens 是命中的（两边相加才是总输入）', () => {
  // 对着 DSH 会话投影核对过：投影里就是 uncachedInputTokens / cacheReadTokens 两个字段，
  // 实测后者能是前者的几十倍。所以：
  //   总输入 = inputTokens + cacheReadTokens
  //   缓存命中率 = cacheReadTokens / (两者之和)
  // 按「inputTokens 已含缓存」算会把命中率算成 100%、未命中算成 0，花费少算一大截。
  const at = Date.UTC(2026, 10, 10, 4, 0, 0)
  usage.recordUsage({
    module: '聊天',
    model: 'deepseek-v4.1-flash',
    usage: { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 500 },
    at,
  })
  const r = usage.usageReport({ now: at + 60_000, range: 'today' })
  const t = r.ranges.today
  assert.equal(t.promptTokens, 10000, '总输入 = 未命中 1000 + 命中 9000')
  assert.equal(t.cachedTokens, 9000, '命中数就是 cacheReadTokens')
  assert.equal(t.completionTokens, 500)
  assert.equal(t.totalTokens, 10500)
  assert.equal(t.cacheHitRate, 0.9, '命中率按两者之和算')
  // 花费也按三段分别取价（空闲时段：未命中 1 元/百万、命中 0.02、输出 4）
  const expect = (1000 * 1 + 9000 * 0.02 + 500 * 4) / 1_000_000
  assert.ok(Math.abs(t.cost - expect) < 1e-9, `实际 ${t.cost} 期望 ${expect}`)
})