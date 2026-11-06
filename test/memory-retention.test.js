// 遗忘曲线的时间基数（retentionBase）：默认 20 天。
// 面板「忘得多快」调的就是它——调小忘得更快、更像真人，调大记得更久。
// 这组测试盯住三件事：默认值不变老用户感受、调小确实忘得快、调大确实记得久。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { retention } = await import('../src/features/memory.js')
const { normalize, DEFAULTS } = await import('../src/core/config.js')

const DAY = 86400_000

test('遗忘基数：默认 20 天，且配置能读出来', () => {
  assert.equal(DEFAULTS.memory.retentionBase, 20)
  assert.equal(normalize({}).memory.retentionBase, 20)
  // 显式填了就用填的
  assert.equal(normalize({ memory: { retentionBase: 8 } }).memory.retentionBase, 8)
})

test('遗忘基数：越界值被钳到安全区（1~365），脏值落回默认', () => {
  assert.equal(normalize({ memory: { retentionBase: 0 } }).memory.retentionBase, 1, '0 不许（会除以零）')
  assert.equal(normalize({ memory: { retentionBase: -3 } }).memory.retentionBase, 1)
  assert.equal(normalize({ memory: { retentionBase: 999 } }).memory.retentionBase, 365)
  assert.equal(normalize({ memory: { retentionBase: 'abc' } }).memory.retentionBase, 20, '脏值落回默认 20')
})

test('遗忘基数：同一条记忆，基数越小忘得越快', () => {
  const m = { at: Date.now() - 30 * DAY, importance: 0.5, hitDays: 0 }
  const now = Date.now()
  const slow = retention(m, now, 20)   // 默认：记得久
  const fast = retention(m, now, 8)    // 调小：忘得快
  assert.ok(fast < slow, `基数 8 应该比 20 衰减更多（fast=${fast.toFixed(3)} slow=${slow.toFixed(3)}）`)
})

test('遗忘基数：默认 20 天时，普通记忆一个月后还剩大半', () => {
  const now = Date.now()
  const r = retention({ at: now - 30 * DAY, importance: 0.5, hitDays: 0 }, now, 20)
  // tau = 20 * 1 * (0.5 + 0.5) = 20 天；30 天后剩 exp(-1.5) ≈ 0.22
  assert.ok(r > 0.15 && r < 0.35, `30 天后应剩 15%~35%，实际 ${(r * 100).toFixed(1)}%`)
})

test('遗忘基数：调到 8 天时，一个月后基本淡忘', () => {
  const now = Date.now()
  const r = retention({ at: now - 30 * DAY, importance: 0.5, hitDays: 0 }, now, 8)
  assert.ok(r < 0.05, `调到 8 天时 30 天后应低于 5%，实际 ${(r * 100).toFixed(2)}%`)
})

test('遗忘基数：被反复想起（hitDays 高）的记忆更抗遗忘', () => {
  const now = Date.now()
  const m = { at: now - 30 * DAY, importance: 0.5 }
  const cold = retention({ ...m, hitDays: 0 }, now, 20)
  const warm = retention({ ...m, hitDays: 5 }, now, 20)
  assert.ok(warm > cold, 'hitDays=5 的应该比 hitDays=0 忘得慢')
})

test('遗忘基数：重要度高（importance 大）的记忆更抗遗忘', () => {
  const now = Date.now()
  const m = { at: now - 30 * DAY, hitDays: 0 }
  const light = retention({ ...m, importance: 0.3 }, now, 20)
  const heavy = retention({ ...m, importance: 0.9 }, now, 20)
  assert.ok(heavy > light, 'importance=0.9 的应该比 0.3 忘得慢')
})

test('遗忘基数：非法基数（0 / 负数 / NaN）落回默认，不会算出 NaN', () => {
  const now = Date.now()
  const m = { at: now - 10 * DAY, importance: 0.5, hitDays: 0 }
  for (const bad of [0, -1, NaN, undefined, null, 'x']) {
    const r = retention(m, now, bad)
    assert.ok(Number.isFinite(r) && r > 0 && r <= 1, `基数 ${String(bad)} 应落回默认并给出有限值，实际 ${r}`)
  }
})

test('遗忘基数：刚记住的记忆强度接近 1', () => {
  const now = Date.now()
  assert.ok(retention({ at: now, importance: 0.5, hitDays: 0 }, now, 20) > 0.999)
})
