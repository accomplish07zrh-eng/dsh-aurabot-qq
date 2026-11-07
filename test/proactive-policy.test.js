// 出站策略源（proactive-policy）单测：
//   purpose / speakup 两个策略源的 reserve→commit/release 口径、共享预算竞争、重启恢复。
// 全部走 dataDir 临时目录 + 冻结时钟，不打网络、不发消息。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createPurposePolicy,
  createSpeakupPolicy,
  createSharedBudget,
  resetSharedBudgets,
} from '../src/features/proactive-policy.js'

const MIN = 60_000
const OWNER = '10000001'

// 固定「白天 12:00」当基准（本地时区）：清醒窗口判定不受跑测试的钟点影响
const NOON = new Date(2026, 0, 15, 12, 0, 0, 0).getTime()
const NIGHT = new Date(2026, 0, 15, 3, 0, 0, 0).getTime()

let dirSeq = 0
function freshDir() {
  dirSeq += 1
  return mkdtempSync(join(tmpdir(), `aurabot-policy-${dirSeq}-`))
}

const baseCfg = () => ({
  enabled: true,
  ownerQQ: OWNER,
  speakUp: {
    enabled: true,
    awakeFrom: 0,
    awakeTo: 24,
    idleMinutes: 0,
    minIntervalMinutes: 5,
    maxIntervalMinutes: 5,
    maxPerDay: 20,
  },
  ext: { purpose: { enabled: true, awakeFrom: 0, awakeTo: 24, maxPerDay: 4, minIntervalMinutes: 5, maxIntervalMinutes: 5 } },
})

function purposePolicy({ cfg = baseCfg(), dir = freshDir(), clock, state, engine, budget } = {}) {
  let t = clock ?? NOON
  const policy = createPurposePolicy({
    getConfig: () => cfg,
    engine,
    state,
    now: () => t,
    dataDir: dir,
    log: { warn() {}, info() {} },
    budget,
  })
  return { policy, cfg, dir, at: () => t, advance: (ms) => { t += ms } }
}

function speakupPolicy({ cfg = baseCfg(), dir = freshDir(), clock, speakup, lastPrivateAt, isMuted, budget } = {}) {
  let t = clock ?? NOON
  const policy = createSpeakupPolicy({
    getConfig: () => cfg,
    speakup,
    now: () => t,
    dataDir: dir,
    log: { warn() {}, info() {} },
    lastPrivateAt,
    isMuted,
    budget,
  })
  return { policy, cfg, dir, at: () => t, advance: (ms) => { t += ms } }
}

beforeEach(() => {
  resetSharedBudgets()
})

// ---------------- 1. purpose：reserve→commit 占额度，reserve→release 不占 ----------------

test('purpose: reserve→commit 占用逻辑发言额度；reserve→release 不占', () => {
  const { policy, advance } = purposePolicy({ cfg: baseCfg() })
  assert.equal(policy.name, 'purpose')
  assert.equal(policy.state(), 'ready')
  assert.equal(policy.ready(), true)

  const r1 = policy.reserve({ to: `private:${OWNER}`, itemId: 'i-1', at: NOON })
  assert.equal(r1.ok, true, JSON.stringify(r1))
  assert.equal(typeof r1.reserveId, 'string')
  // reserve 必须同步：返回的不是 Promise
  assert.equal(typeof r1.then, 'undefined')
  // 预占期间四态是 running
  assert.equal(policy.state(), 'running')

  const c1 = policy.commit(r1.reserveId, { deliveryId: 'd-1', outcome: 'sent' })
  assert.equal(c1.ok, true)
  assert.equal(c1.speechCount, 1)
  assert.equal(policy.snapshot().speechCount, 1)
  assert.equal(policy.snapshot().budget.used, 1)
  assert.equal(policy.state(), 'ready')

  // 时间推进到 nextFireAt 之后，再走一次「预占 → 释放」：逻辑发言额度不该被占
  advance(6 * MIN)
  const r2 = policy.reserve({ to: `private:${OWNER}`, itemId: 'i-2', at: NOON + 6 * MIN })
  assert.equal(r2.ok, true, JSON.stringify(r2))
  const rel = policy.release(r2.reserveId, { reason: 'net-error' })
  assert.equal(rel.ok, true)
  const snap = policy.snapshot()
  assert.equal(snap.speechCount, 1, 'release 不占逻辑发言额度')
  assert.equal(snap.budget.used, 1, '释放只退预占，不计占用')
  assert.equal(snap.pending.length, 0)
})

// ---------------- 2. purpose：生成尝试额度 vs 逻辑发言额度 口径分离 ----------------

test('purpose: 生成尝试额度（沉默/失败也计入）与逻辑发言额度分开计', () => {
  // 尝试额度 2：沉默两次也算用满，此时 reserve 必须 budget，但逻辑发言额度一次没动
  const dirA = freshDir()
  const a = purposePolicy({
    dir: dirA,
    cfg: {
      ...baseCfg(),
      ext: { purpose: { enabled: true, awakeFrom: 0, awakeTo: 24, maxPerDay: 2, minIntervalMinutes: 5, maxIntervalMinutes: 5 } },
    },
  })
  a.policy.noteAttempt({ at: NOON })
  a.policy.noteAttempt({ at: NOON + 1000 })
  const blocked = a.policy.reserve({ to: `private:${OWNER}`, at: NOON + 2000 })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'budget')
  assert.equal(blocked.detail, 'attempt-budget')
  assert.equal(a.policy.snapshot().speechCount, 0, 'attempt 记账不占用逻辑发言额度')

  // 逻辑发言额度 1：commit 一次就满，但 attemptCount 仍然是 0（这是「发言额度」不是「尝试额度」）
  resetSharedBudgets()
  const b = purposePolicy({
    cfg: {
      ...baseCfg(),
      ext: {
        purpose: {
          enabled: true, awakeFrom: 0, awakeTo: 24,
          maxPerDay: 4, speechMaxPerDay: 1, minIntervalMinutes: 5, maxIntervalMinutes: 5,
        },
      },
    },
  })
  const r = b.policy.reserve({ to: `private:${OWNER}`, at: NOON })
  assert.equal(r.ok, true, JSON.stringify(r))
  b.policy.commit(r.reserveId, { outcome: 'sent' })
  assert.equal(b.policy.snapshot().attemptCount, 0, 'commit 不记生成尝试额度（那是 noteAttempt 的事）')
  assert.equal(b.policy.snapshot().speechCount, 1)
  const again = b.policy.reserve({ to: `private:${OWNER}`, at: NOON + 60 * MIN })
  assert.equal(again.ok, false)
  assert.equal(again.reason, 'budget')
  assert.equal(again.detail, 'speech-budget')

  // 失败：退逻辑发言额度、不退生成尝试额度
  resetSharedBudgets()
  const c = purposePolicy({
    cfg: {
      ...baseCfg(),
      ext: { purpose: { enabled: true, awakeFrom: 0, awakeTo: 24, maxPerDay: 4, minIntervalMinutes: 5, maxIntervalMinutes: 5 } },
    },
  })
  c.policy.noteAttempt({ at: NOON })
  const rf = c.policy.reserve({ to: `private:${OWNER}`, at: NOON + 1000 })
  assert.equal(rf.ok, true, JSON.stringify(rf))
  const cf = c.policy.commit(rf.reserveId, { outcome: 'failed' })
  assert.equal(cf.ok, true)
  assert.equal(cf.refund, true)
  const snapF = c.policy.snapshot()
  assert.equal(snapF.speechCount, 0, 'failed 退逻辑发言额度')
  assert.equal(snapF.attemptCount, 1, 'failed 不退生成尝试额度')
  assert.equal(snapF.budget.used, 0)
})

// ---------------- 3. speakup：reserve 判定复刻 tick ----------------

test('speakup: reserve 判定复刻 awake && idleOk && count < maxPerDay && now >= nextAt', () => {
  // 未启用 → quiet
  const off = speakupPolicy({ cfg: { ...baseCfg(), speakUp: { ...baseCfg().speakUp, enabled: false } } })
  assert.deepEqual(
    (({ ok, reason, detail }) => ({ ok, reason, detail }))(off.policy.reserve({ at: NOON })),
    { ok: false, reason: 'quiet', detail: 'disabled' },
  )
  resetSharedBudgets()

  // 被禁言 → quiet
  const muted = speakupPolicy({ isMuted: () => true })
  assert.equal(muted.policy.reserve({ at: NOON }).reason, 'quiet')
  assert.equal(muted.policy.reserve({ at: NOON }).detail, 'muted')
  resetSharedBudgets()

  // 睡着（3 点，清醒窗口 8~23）→ quiet / asleep
  const nightCfg = {
    ...baseCfg(),
    speakUp: { ...baseCfg().speakUp, awakeFrom: 8, awakeTo: 23 },
  }
  const night = speakupPolicy({ cfg: nightCfg, clock: NIGHT })
  const nightRes = night.policy.reserve({ at: NIGHT })
  assert.equal(nightRes.ok, false)
  assert.equal(nightRes.reason, 'quiet')
  assert.equal(nightRes.detail, 'asleep')
  resetSharedBudgets()

  // 超过每日上限 → budget
  const dirCount = freshDir()
  mkdirSync(dirCount, { recursive: true })
  writeFileSync(
    join(dirCount, 'speakup-policy.json'),
    JSON.stringify({ version: 1, day: '2026-01-15', count: 3, nextAt: 0, last: 0 }),
  )
  const atCapCfg = { ...baseCfg(), speakUp: { ...baseCfg().speakUp, maxPerDay: 3 } }
  const atCap = speakupPolicy({ cfg: atCapCfg, dir: dirCount })
  const capRes = atCap.policy.reserve({ at: NOON })
  assert.equal(capRes.ok, false)
  assert.equal(capRes.reason, 'budget')
  assert.equal(capRes.detail, 'daily-max')
  resetSharedBudgets()

  // 间隔没到（nextAt 在未来）→ cooldown
  const dirNext = freshDir()
  writeFileSync(
    join(dirNext, 'speakup-policy.json'),
    JSON.stringify({ version: 1, day: '2026-01-15', count: 0, nextAt: NOON + 10 * MIN, last: 0 }),
  )
  const waiting = speakupPolicy({ dir: dirNext })
  const waitRes = waiting.policy.reserve({ at: NOON })
  assert.equal(waitRes.ok, false)
  assert.equal(waitRes.reason, 'cooldown')
  assert.equal(waitRes.detail, 'interval')
  assert.equal(waitRes.nextAt, NOON + 10 * MIN)
  resetSharedBudgets()

  // 主人刚说完话（idle 不足）→ cooldown
  const idleCfg = { ...baseCfg(), speakUp: { ...baseCfg().speakUp, idleMinutes: 40 } }
  const active = speakupPolicy({ cfg: idleCfg, lastPrivateAt: () => NOON - 5 * MIN })
  const idleRes = active.policy.reserve({ at: NOON })
  assert.equal(idleRes.ok, false)
  assert.equal(idleRes.reason, 'cooldown')
  assert.equal(idleRes.detail, 'owner-active')
  resetSharedBudgets()

  // 四项都满足 → ok（且 reserve 不扣次数、不改 nextAt）
  const readyCfg = { ...baseCfg(), speakUp: { ...baseCfg().speakUp, idleMinutes: 40, maxPerDay: 3 } }
  const okCase = speakupPolicy({ cfg: readyCfg, lastPrivateAt: () => NOON - 120 * MIN })
  const okRes = okCase.policy.reserve({ at: NOON })
  assert.equal(okRes.ok, true, JSON.stringify(okRes))
  const snap = okCase.policy.snapshot()
  assert.equal(snap.count, 0, 'reserve 不占次数')
  assert.equal(snap.nextAt, 0, 'reserve 不改 nextAt')
  // commit 成功才 count++ 并重排 nextAt
  const committed = okCase.policy.commit(okRes.reserveId, { outcome: 'sent' })
  assert.equal(committed.ok, true)
  assert.equal(committed.count, 1)
  assert.ok(committed.nextAt >= NOON + 5 * MIN, 'commit 后重排 nextAt')
})

// ---------------- 4. 两策略源抢共享预算最后一个额度 ----------------

test('共享预算: 两个策略源抢最后一个额度，只有一个 ok', () => {
  const dir = freshDir()
  const cfg = {
    ...baseCfg(),
    // 共享域硬上限 1（A 线契约里由 config.ext.outboundPolicy 下发）
    ext: {
      purpose: { enabled: true, awakeFrom: 0, awakeTo: 24, maxPerDay: 4, minIntervalMinutes: 5, maxIntervalMinutes: 5 },
      outboundPolicy: { sharedDailyMax: 1 },
    },
  }
  const p = purposePolicy({ cfg, dir })
  const s = speakupPolicy({ cfg, dir, lastPrivateAt: () => NOON - 120 * MIN })

  // 同一 ownerQQ + 同一 dataDir → 拿到同一份共享域
  assert.equal(p.policy.budget, s.policy.budget)

  const pr = p.policy.reserve({ to: `private:${OWNER}`, itemId: 'p-1', at: NOON })
  assert.equal(pr.ok, true, JSON.stringify(pr))
  assert.equal(p.policy.state(), 'running')

  const sr = s.policy.reserve({ to: `private:${OWNER}`, itemId: 's-1', at: NOON })
  assert.equal(sr.ok, false, '同一时刻只允许一个逻辑发言获授权')
  assert.equal(sr.reason, 'budget', '抢最后一个额度失败应报 budget')
  // 失败方不留下挂起
  assert.equal(s.policy.snapshot().pending.length, 0)
  assert.equal(s.policy.state(), 'ready')

  // 只有拿到额度的那一个能真正 commit
  const pc = p.policy.commit(pr.reserveId, { outcome: 'sent' })
  assert.equal(pc.ok, true)
  assert.equal(pc.shared.used, 1)
  const later = p.policy.reserve({ to: `private:${OWNER}`, at: NOON + 60 * MIN })
  assert.equal(later.ok, false)
  assert.equal(later.reason, 'budget', '额度用尽后同源也拿不到')
  assert.equal(later.detail, 'shared:1/1')
})

test('共享预算: 没给 dataDir 时退化为内存，不碰磁盘、且同 owner 仍唯一', () => {
  const b1 = createSharedBudget({ ownerQQ: OWNER })
  const b2 = createSharedBudget({ ownerQQ: OWNER })
  assert.equal(b1, b2)
  assert.equal(b1.snapshot().file, '')
  assert.equal(b1.tryAcquire({ reserveId: 'x', source: 'purpose', at: NOON }).ok, true)
  const second = b1.tryAcquire({ reserveId: 'y', source: 'speakup', at: NOON })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'busy', '额度未设上限时并发仍只允许一个在途')
  assert.equal(b1.settle('x', { refund: false, at: NOON }).ok, true)
  assert.equal(b1.snapshot().used, 1)
})

// ---------------- 5. 多气泡不重复扣 ----------------

test('一次逻辑发言的多条气泡不重复扣额度（同 reserveId 只结算一次）', () => {
  const { policy, advance } = purposePolicy({ cfg: baseCfg() })
  const r = policy.reserve({ to: `private:${OWNER}`, itemId: 'multi', at: NOON })
  assert.equal(r.ok, true, JSON.stringify(r))

  // 第 1 条气泡：正常结算
  const first = policy.commit(r.reserveId, { deliveryId: 'd-1', outcome: 'sent' })
  assert.equal(first.ok, true)
  assert.equal(first.speechCount, 1)
  assert.equal(first.shared.used, 1)

  // 同一次逻辑发言的第 2、3 条气泡：再 commit 同 reserveId → settled，不再扣
  advance(1000)
  const second = policy.commit(r.reserveId, { deliveryId: 'd-2', outcome: 'sent' })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'settled')
  const third = policy.commit(r.reserveId, { deliveryId: 'd-3', outcome: 'queued' })
  assert.equal(third.ok, false)
  assert.equal(third.reason, 'settled')

  const snap = policy.snapshot()
  assert.equal(snap.speechCount, 1, '多条气泡只扣一次')
  assert.equal(snap.budget.used, 1)
})

// ---------------- 6. 重复 commit / release → settled ----------------

test('重复 commit / release → {ok:false, reason:"settled"}，不抛错', () => {
  const { policy, advance } = purposePolicy({ cfg: baseCfg() })

  const r1 = policy.reserve({ at: NOON })
  assert.equal(r1.ok, true)
  assert.equal(policy.commit(r1.reserveId, { outcome: 'sent' }).ok, true)
  advance(1000)
  const dupCommit = policy.commit(r1.reserveId, { outcome: 'sent' })
  assert.deepEqual({ ok: dupCommit.ok, reason: dupCommit.reason }, { ok: false, reason: 'settled' })
  const dupRelease = policy.release(r1.reserveId, { reason: 'late' })
  assert.deepEqual({ ok: dupRelease.ok, reason: dupRelease.reason }, { ok: false, reason: 'settled' })
  // 不存在的 id 也走 settled，不抛
  assert.doesNotThrow(() => policy.commit('nope', { outcome: 'sent' }))
  assert.equal(policy.release('nope', {}).reason, 'settled')

  // 先 release 再 commit 同样 settled，且额度不被二次占用
  advance(6 * MIN)
  const r2 = policy.reserve({ at: NOON + 6 * MIN })
  assert.equal(r2.ok, true, JSON.stringify(r2))
  assert.equal(policy.release(r2.reserveId, { reason: 'cancel' }).ok, true)
  assert.equal(policy.commit(r2.reserveId, { outcome: 'sent' }).reason, 'settled')
  assert.equal(policy.snapshot().speechCount, 1)
  assert.equal(policy.reasonText('settled'), '这次预占已经结算过了')
})

test('speakup: 重复结算同样 settled，且 count 只加一次', () => {
  const { policy } = speakupPolicy({ lastPrivateAt: () => NOON - 120 * MIN })
  const r = policy.reserve({ at: NOON })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(policy.commit(r.reserveId, { outcome: 'sent' }).ok, true)
  assert.equal(policy.commit(r.reserveId, { outcome: 'sent' }).reason, 'settled')
  assert.equal(policy.release(r.reserveId, {}).reason, 'settled')
  assert.equal(policy.snapshot().count, 1)
})

// ---------------- 7. uncertain 不退款 ----------------

test('uncertain 不退款（purpose 与 speakup 口径一致）', () => {
  const p = purposePolicy({ cfg: baseCfg() })
  const pr = p.policy.reserve({ at: NOON })
  assert.equal(pr.ok, true, JSON.stringify(pr))
  const pc = p.policy.commit(pr.reserveId, { outcome: 'uncertain' })
  assert.equal(pc.ok, true)
  assert.equal(pc.refund, false, 'uncertain 不退款')
  const pSnap = p.policy.snapshot()
  assert.equal(pSnap.speechCount, 1)
  assert.equal(pSnap.budget.used, 1)

  resetSharedBudgets()
  const s = speakupPolicy({ lastPrivateAt: () => NOON - 120 * MIN })
  const sr = s.policy.reserve({ at: NOON })
  assert.equal(sr.ok, true, JSON.stringify(sr))
  const sc = s.policy.commit(sr.reserveId, { outcome: 'uncertain' })
  assert.equal(sc.ok, true)
  assert.equal(s.policy.snapshot().count, 1, 'uncertain 也占一次')
  assert.equal(s.policy.snapshot().budget.used, 1)
  resetSharedBudgets()
})

// ---------------- 8. 重启恢复 ----------------

test('重启恢复: 新实例读回持久状态后逻辑发言额度不被重复授予', () => {
  const dir = freshDir()
  const cfg = {
    ...baseCfg(),
    ext: { purpose: { enabled: true, awakeFrom: 0, awakeTo: 24, maxPerDay: 4, speechMaxPerDay: 1, minIntervalMinutes: 5, maxIntervalMinutes: 5 } },
  }
  const first = purposePolicy({ cfg, dir })
  const r = first.policy.reserve({ to: `private:${OWNER}`, itemId: 'once', at: NOON })
  assert.equal(r.ok, true, JSON.stringify(r))
  first.policy.commit(r.reserveId, { outcome: 'sent' })
  assert.equal(first.policy.snapshot().speechCount, 1)

  // 模拟进程重启：清进程内单例 + 新建实例（同一 dataDir）
  resetSharedBudgets()
  const second = purposePolicy({ cfg, dir, clock: NOON + 60 * MIN })
  const snap = second.policy.snapshot()
  assert.equal(snap.speechCount, 1, '逻辑发言额度从磁盘恢复')
  assert.equal(snap.budget.used, 1, '共享域已用额度也恢复')
  const again = second.policy.reserve({ to: `private:${OWNER}`, at: NOON + 60 * MIN })
  assert.equal(again.ok, false, '重启后不能重复授予已经用掉的额度')
  assert.equal(again.reason, 'budget')
  assert.equal(again.detail, 'speech-budget')

  // 生成尝试额度同样跨重启保留
  resetSharedBudgets()
  const dir2 = freshDir()
  const attemptCfg = {
    ...baseCfg(),
    ext: { purpose: { enabled: true, awakeFrom: 0, awakeTo: 24, maxPerDay: 1, minIntervalMinutes: 5, maxIntervalMinutes: 5 } },
  }
  const a1 = purposePolicy({ cfg: attemptCfg, dir: dir2 })
  a1.policy.noteAttempt({ at: NOON })
  resetSharedBudgets()
  const a2 = purposePolicy({ cfg: attemptCfg, dir: dir2, clock: NOON + 60 * MIN })
  assert.equal(a2.policy.snapshot().attemptCount, 1)
  const aRes = a2.policy.reserve({ at: NOON + 60 * MIN })
  assert.equal(aRes.ok, false)
  assert.equal(aRes.detail, 'attempt-budget')

  // speakup 次数同样跨重启保留
  resetSharedBudgets()
  const dir3 = freshDir()
  const speakCfg = { ...baseCfg(), speakUp: { ...baseCfg().speakUp, idleMinutes: 0, maxPerDay: 1 } }
  const s1 = speakupPolicy({ cfg: speakCfg, dir: dir3, lastPrivateAt: () => NOON - 120 * MIN })
  const sr = s1.policy.reserve({ at: NOON })
  assert.equal(sr.ok, true, JSON.stringify(sr))
  s1.policy.commit(sr.reserveId, { outcome: 'sent' })
  resetSharedBudgets()
  const s2 = speakupPolicy({ cfg: speakCfg, dir: dir3, clock: NOON + 60 * MIN, lastPrivateAt: () => NOON - 120 * MIN })
  assert.equal(s2.policy.snapshot().count, 1)
  const sRes = s2.policy.reserve({ at: NOON + 60 * MIN })
  assert.equal(sRes.ok, false)
  assert.equal(sRes.detail, 'daily-max')
  resetSharedBudgets()
})

// ---------------- 附加：四态与中文原因 ----------------

test('代发审查预占（reserveReview）：不占额度、不看排程、在途串行', () => {
  // speechMaxPerDay=1：发言一次就用满普通 reserve 的额度；审查不受影响
  const cfgA = {
    ...baseCfg(),
    ext: { purpose: { enabled: true, awakeFrom: 0, awakeTo: 24, maxPerDay: 4, speechMaxPerDay: 1, minIntervalMinutes: 5, maxIntervalMinutes: 5 } },
  }
  const a = purposePolicy({ cfg: cfgA })
  const r1 = a.policy.reserve({ to: `private:${OWNER}`, itemId: 'own', at: NOON })
  assert.equal(r1.ok, true, JSON.stringify(r1))
  a.policy.commit(r1.reserveId, { outcome: 'sent' }) // speechCount=1（满），引擎侧重排 nextFireAt
  const s1 = a.policy.snapshot()
  assert.equal(s1.speechCount, 1)
  assert.ok(s1.nextFireAt > NOON, '前置：引擎排程被重排到未来')
  const blocked = a.policy.reserve({ to: `private:${OWNER}`, itemId: 'own-2', at: NOON + 60 * 1000 })
  assert.equal(blocked.ok, false, '前置：普通 reserve 此时被 speechMax 拦')
  assert.equal(blocked.reason, 'budget')

  // 审查：同样的时刻照常放行，且不占任何额度
  const rev = a.policy.reserveReview({ to: `private:${OWNER}`, itemId: 'mod-1', at: NOON + 61 * 1000 })
  assert.equal(rev.ok, true, JSON.stringify(rev))
  assert.equal(rev.role, 'review')
  const snapA = a.policy.snapshot()
  assert.equal(snapA.attemptCount, s1.attemptCount, '审查不占生成尝试额度')
  assert.equal(snapA.speechCount, s1.speechCount, '审查不占逻辑发言额度')
  assert.equal(snapA.nextFireAt, s1.nextFireAt, '审查不动引擎排程')

  // 在途串行：审查中再来一条 → busy
  const second = a.policy.reserveReview({ to: `private:${OWNER}`, itemId: 'mod-2', at: NOON + 62 * 1000 })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'busy')

  // review 结算：只清挂起，额度与排程纹丝不动
  a.policy.commit(rev.reserveId, { outcome: 'sent' }, 'review')
  const snapB = a.policy.snapshot()
  assert.equal(snapB.speechCount, s1.speechCount, 'review 结算不占逻辑发言额度')
  assert.equal(snapB.nextFireAt, s1.nextFireAt, 'review 结算不重排排程')
  assert.equal(snapB.pending.length, 0)
})

test('代发审查预占：引擎没开 → quiet；非主人私聊 → 拒（朋友走各自的额度）', () => {
  const off = purposePolicy({ cfg: { ...baseCfg(), ext: { purpose: { enabled: false } } } })
  const r = off.policy.reserveReview({ to: `private:${OWNER}`, at: NOON })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'quiet')
  resetSharedBudgets()

  const p = purposePolicy()
  const friend = p.policy.reserveReview({ to: `private:20000009`, at: NOON })
  assert.equal(friend.ok, false, '朋友不归主人这套审查管')
})

test('代发审查预占：安静时段照常过目（深夜收到也由引擎看完再决断，不按排程拦）', () => {
  const cfg = {
    ...baseCfg(),
    ext: { purpose: { enabled: true, awakeFrom: 8, awakeTo: 23, maxPerDay: 4, minIntervalMinutes: 5, maxIntervalMinutes: 5 } },
  }
  const p = purposePolicy({ cfg, clock: NIGHT })
  // 对照：她自己开口（普通 reserve）在安静时段被拦
  const own = p.policy.reserve({ to: `private:${OWNER}`, at: NIGHT })
  assert.equal(own.ok, false)
  assert.equal(own.detail, 'asleep')
  // 代发审查不受安静时段约束
  const r = p.policy.reserveReview({ to: `private:${OWNER}`, at: NIGHT })
  assert.equal(r.ok, true, JSON.stringify(r))
})

test('四态与 reasonText: configured / running / ready / error', () => {
  const offCfg = { ...baseCfg(), ext: { purpose: { enabled: false } } }
  const off = purposePolicy({ cfg: offCfg })
  assert.equal(off.policy.state(), 'configured')
  assert.equal(off.policy.ready(), false)
  assert.equal(off.policy.reserve({ at: NOON }).reason, 'quiet')
  assert.equal(off.policy.reasonText('quiet'), '当前不宜开口（未启用 / 不在清醒时段 / 已被禁言）')
  resetSharedBudgets()

  const broken = purposePolicy({ state: () => { throw new Error('bad state') } })
  assert.equal(broken.policy.state(), 'error')
  assert.equal(broken.policy.reserve({ at: NOON }).reason, 'error')
  assert.match(broken.policy.reasonText('error'), /错误/)
  resetSharedBudgets()

  const ok = speakupPolicy({ lastPrivateAt: () => NOON - 120 * MIN })
  assert.equal(ok.policy.state(), 'ready')
  const r = ok.policy.reserve({ at: NOON })
  assert.equal(ok.policy.state(), 'running')
  ok.policy.release(r.reserveId, { reason: 'peek' })
  assert.equal(ok.policy.state(), 'ready')
  for (const reason of ok.policy.reasons()) {
    assert.equal(typeof ok.policy.reasonText(reason), 'string')
  }
})
