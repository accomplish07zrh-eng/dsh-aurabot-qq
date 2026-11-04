// ---------------------------------------------------------------------------
// 出站策略源：主动发言的「门闸判定」与「额度账本」（B 线）
//
// 来源：
//   · 接口契约 —— 见 docs/OUTBOUND-POLICY-DESIGN.md §4「策略源接口」；
//   · 「主动搭话」判定口径 —— `src/features/companion.js` 的 createSpeakUp（L165-280）：
//     tick 里的 `awake && idleOk && count < maxPerDay && Date.now() >= nextAt`；
//     reserve 复用同一判定，commit 成功才 `count++` 并重排 nextAt；
//   · 「目的引擎」判定口径 —— `src/purpose/engine.js` 的 evaluatePurposeTick（L324-348，只判不扣）
//     与 markPurposeDelivered（L351-359，投递即占「生成尝试额度」，沉默/失败也计入）。
//
// 作用：
//   给宿主出站策略服务（A 线 `src/chat/outbound-policy.js`）提供两个可注册的策略源：
//     · purpose —— 目的引擎（src/purpose/module.js 的主动找人）；
//     · speakup —— 主动搭话（src/features/companion.js 的 tick）。
//   二者竞争**同一份**按 ownerQQ 的逻辑发言预算域（createSharedBudget），
//   同一时刻最多一个逻辑发言获授权；一次逻辑发言的多条气泡不重复扣额度。
//
// 契约（CONTRACT §2，逐条对应）：
//   policy = {
//     name: 'purpose' | 'speakup',
//     state(): 'configured' | 'running' | 'ready' | 'error',
//     ready(): boolean,                                  // = state() === 'ready'
//     reserve({ to, sourceModule, itemId, at })          // 同步返回，内部状态同步变更
//       → { ok: true, reserveId } | { ok: false, reason: 'quiet'|'budget'|'cooldown'|'busy'|'error' },
//     commit(reserveId, { deliveryId, outcome }),        // outcome: sent|queued|uncertain|failed
//     release(reserveId, { reason }),                    // 未发送释放；uncertain 不退款
//     reasonText?(reason) → string,                      // 中文原因（面板/日志用）
//   }
//   · reserve 必须同步返回；落盘只写 dataDir，小文件同步写（<2KB），不影响返回语义；
//   · 同一 reserveId 只允许 commit 或 release 一次，重复调用 → { ok:false, reason:'settled' }，不抛错；
//   · 策略源只回答「能不能发」，**自己不发送任何消息**（发送仍由 hub/A 线完成）。
//
// 独立性：
//   本文件不 import `src/` 内任何模块——判定逻辑自带实现（清醒窗口 / 每日额度 / 间隔冷却 /
//   读状态 / 写盘），便于单测、便于移植，也避免与 companion.js / engine.js 形成环。
//
// 落盘（只写 dataDir）：
//   <dataDir>/purpose-policy.json   目的引擎逻辑发言 + 生成尝试账本
//   <dataDir>/speakup-policy.json   主动搭话每日次数与 nextAt
//   <dataDir>/shared-budget.json    两个策略源共享的按 ownerQQ 预算域
//   没给 dataDir（或给空）时全部退化为内存，不碰磁盘。
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const MINUTE = 60_000
const VERSION = 1

// reserve 的 reason 全集（契约 §2），reasonText 只翻译这几个 + 'settled'
const REASONS = ['quiet', 'budget', 'cooldown', 'busy', 'error', 'settled']
const OUTCOMES = ['sent', 'queued', 'uncertain', 'failed']

const REASON_TEXT = {
  quiet: '当前不宜开口（未启用 / 不在清醒时段 / 已被禁言）',
  budget: '今日额度已用完（生成尝试额度或逻辑发言额度）',
  cooldown: '还没到下次可开口的时间（间隔未到，或主人刚说完话）',
  busy: '另一次主动发言正在流程中',
  error: '策略源内部错误（读配置或读状态失败）',
  settled: '这次预占已经结算过了',
  'out-of-scope': '不是主人私聊（白名单朋友等各有各的额度，不归这套策略管）',
}

// ---------------- 小工具（自带实现，不依赖 src/core） ----------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 本地日期键（跨天重置次数用；与 purpose/engine.js 的 localDateKey 同口径）。 */
function localDateKey(at) {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 清醒窗口 [from, to)；to >= 24 或区间非法视为全天清醒（同 purpose/module.js 的派生规则）。 */
function inAwakeWindow(at, from, to) {
  if (to >= 24 || from >= to) return true
  const h = new Date(at).getHours()
  return h >= from && h < to
}

/** 下一个「窗口开始」时刻（严格晚于 at），用于把落在安静时段的排程推到明早。 */
function awakeStartAfter(at, from) {
  const d = new Date(at)
  d.setHours(clampInt(from, 0, 0, 23), 0, 0, 0)
  while (d.getTime() <= at) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** dataDir 允许传字符串或函数（模块 api.dataDir 是函数），空值 → 内存模式。 */
function resolveDir(dataDir) {
  if (!dataDir) return ''
  try {
    const v = typeof dataDir === 'function' ? dataDir() : dataDir
    return v ? String(v) : ''
  } catch {
    return ''
  }
}

/** now 允许传数字（冻结时间，测试友好）、函数（生产）或省略（Date.now）。 */
function clockOf(now) {
  if (typeof now === 'function') {
    return () => {
      const t = Number(now())
      return Number.isFinite(t) ? t : Date.now()
    }
  }
  if (Number.isFinite(Number(now))) return () => Number(now)
  return () => Date.now()
}

function readJsonFile(file, fallback) {
  if (!file) return fallback
  try {
    let text = readFileSync(file, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** 先写临时文件再改名：断电/并发下不会留下半截 JSON；写失败只记日志，不影响内存态。 */
function writeJsonFile(file, value, log) {
  if (!file) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
    writeFileSync(tmp, JSON.stringify(value), 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    log?.warn?.(`策略源落盘失败（不影响内存态）：${error?.message || error}`)
  }
}

let idSeq = 0
function makeReserveId(name, at) {
  idSeq = (idSeq + 1) % 1e9
  return `${name}-${at.toString(36)}-${idSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeOutcome(outcome) {
  const v = String(outcome ?? 'sent')
  return OUTCOMES.includes(v) ? v : 'sent'
}

/** 上限语义：0 / 负数 / 非法值 = 不限（Infinity）。purpose 的 dailyMax 就是这层语义。 */
function unlimitedIfZero(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return Infinity
  return Math.round(n)
}

// ---------------- 共享预算域（按 ownerQQ 唯一） ----------------

const BUDGET_REGISTRY = new Map()

function normalizeBudgetState(raw, at, ownerQQ) {
  const src = isPlainObject(raw) ? raw : {}
  const s = {
    version: VERSION,
    ownerQQ: String(ownerQQ ?? ''),
    day: typeof src.day === 'string' ? src.day : localDateKey(at),
    used: clampInt(src.used, 0, 0, 99999),
    lastSettledAt: Number(src.lastSettledAt) || 0,
    // 全局共享硬上限（默认不限）；各策略源自己的日额度仍在策略源内判，避免互相削额度
    dailyMax: Number(src.dailyMax) > 0 ? Math.round(Number(src.dailyMax)) : 0,
    minGapMs: clampInt(src.minGapMs, 0, 0, 24 * 60 * MINUTE),
    sourceLimits: {},
    inFlight: [], // 预占中；**不落盘生效**——重启一律视为未结算，见 persist()
  }
  const limits = isPlainObject(src.sourceLimits) ? src.sourceLimits : {}
  for (const [name, lim] of Object.entries(limits)) {
    if (!isPlainObject(lim)) continue
    s.sourceLimits[name] = {
      dailyMax: clampInt(lim.dailyMax, 0, 0, 999),
      minGapMs: clampInt(lim.minGapMs, 0, 0, 24 * 60 * MINUTE),
    }
  }
  return s
}

/**
 * 共享预算域：两个策略源抢同一份「按 ownerQQ 的逻辑发言额度」。
 *
 * 语义：
 *   · 占用口径 = `used`（已结算的逻辑发言数）+ `inFlight`（已预占未结算）；
 *   · 硬上限 `dailyMax` 默认不限（0），只由显式配置打开（config.ext.outboundPolicy.sharedDailyMax
 *     或构造参数 dailyMax）；各策略源自己的日额度由策略源自己判——否则一个源设得严就会
 *     把另一个源的额度一起削掉；
 *   · 同一时刻最多一个逻辑发言获授权（inFlight ≤ 1）→ 两个引擎不会同时开口；
 *   · 结算：`settle(id, {refund:false})` 记一次占用；`settle(id, {refund:true})` 只退还预占；
 *   · 重启：`used` 保留（额度不被重复授予），`inFlight` 丢弃（在途结果未知，不额外扣也不补发）。
 *
 * 单例：同进程内 `${dataDir}|${ownerQQ}` 唯一，两个策略源各建一次拿到的仍是同一份域。
 */
export function createSharedBudget({ ownerQQ, dataDir, now, log, dailyMax, minGapMs } = {}) {
  const clock = clockOf(now)
  const dir = resolveDir(dataDir)
  const owner = String(ownerQQ ?? '')
  const regKey = `${dir || '<memory>'}|${owner}`
  if (BUDGET_REGISTRY.has(regKey)) return BUDGET_REGISTRY.get(regKey)

  const file = () => (dir ? join(dir, 'shared-budget.json') : '')
  const t0 = clock()
  const state = normalizeBudgetState(readJsonFile(file(), null), t0, owner)
  if (Number(dailyMax) > 0) state.dailyMax = Math.round(Number(dailyMax))
  if (Number(minGapMs) > 0) state.minGapMs = Math.round(Number(minGapMs))

  const persist = () => writeJsonFile(file(), { ...state, inFlight: [] }, log)

  function rollDay(at) {
    const day = localDateKey(at)
    if (state.day !== day) {
      state.day = day
      state.used = 0
      state.lastSettledAt = 0
    }
  }

  /** 硬上限快照：globalDailyMax = 共享域自己的上限；minGapMs = 全局最小间隔。 */
  function limits() {
    return {
      dailyMax: state.dailyMax > 0 ? state.dailyMax : Infinity,
      minGapMs: Math.max(0, Number(state.minGapMs) || 0),
    }
  }

  /**
   * 记录/更新某个策略源的自报额度（只做记账与面板展示，不参与共享硬上限判定）。
   * sharedDailyMax：显式给共享域设上限（传 0 表示恢复不限）。
   */
  function setLimits({ source, dailyMax: srcDailyMax, minGapMs: srcMinGap, sharedDailyMax } = {}) {
    const name = String(source ?? '').trim() || 'unknown'
    state.sourceLimits[name] = {
      dailyMax: clampInt(srcDailyMax, 0, 0, 999),
      minGapMs: clampInt(srcMinGap, 0, 0, 24 * 60 * MINUTE),
    }
    if (sharedDailyMax !== undefined && sharedDailyMax !== null) {
      const n = Number(sharedDailyMax)
      state.dailyMax = Number.isFinite(n) && n > 0 ? Math.round(n) : 0
    }
    return limits()
  }

  /**
   * 原子预占一份共享逻辑发言额度（同步）。
   * 判定顺序：日额度 → 冷却 → 并发（最多一个在途）。额度先于并发检查，
   * 这样「抢最后一个额度」失败的一方拿到的是 budget 而不是笼统的 busy。
   */
  function tryAcquire({ reserveId, source, at } = {}) {
    const t = Number(at) || clock()
    rollDay(t)
    const lim = limits()
    const usedTotal = state.used + state.inFlight.length
    if (usedTotal >= lim.dailyMax) {
      return { ok: false, reason: 'budget', detail: `shared:${usedTotal}/${lim.dailyMax}`, source: String(source ?? '') }
    }
    if (lim.minGapMs > 0 && state.lastSettledAt > 0 && t - state.lastSettledAt < lim.minGapMs) {
      return { ok: false, reason: 'cooldown', detail: 'shared:min-gap', source: String(source ?? '') }
    }
    if (state.inFlight.length >= 1) {
      return { ok: false, reason: 'busy', detail: 'shared:in-flight', source: String(source ?? '') }
    }
    state.inFlight.push({ reserveId: String(reserveId ?? ''), source: String(source ?? ''), at: t })
    persist()
    return { ok: true, day: state.day, used: state.used }
  }

  /**
   * 结算一份预占。
   * refund=true  → 退还预占（未发送释放；不计占用）
   * refund=false → 计入一次逻辑发言占用（sent/queued/uncertain/策略源自定的失败口径）
   */
  function settle(reserveId, { refund = false, at } = {}) {
    const t = Number(at) || clock()
    rollDay(t)
    const idx = state.inFlight.findIndex((x) => x.reserveId === String(reserveId ?? ''))
    if (idx < 0) return { ok: false, reason: 'settled', detail: 'unknown-reserve' }
    state.inFlight.splice(idx, 1)
    if (!refund) {
      state.used += 1
      state.lastSettledAt = t
    }
    persist()
    return { ok: true, used: state.used, refund: Boolean(refund) }
  }

  function snapshot() {
    const lim = limits()
    return {
      ownerQQ: owner,
      day: state.day,
      used: state.used,
      inFlight: state.inFlight.map((x) => ({ ...x })),
      remaining: Math.max(0, lim.dailyMax - (state.used + state.inFlight.length)),
      limits: lim,
      sourceLimits: JSON.parse(JSON.stringify(state.sourceLimits)),
      file: file(),
    }
  }

  const budget = {
    ownerQQ: owner,
    kind: 'shared-budget',
    limits,
    setLimits,
    tryAcquire,
    settle,
    snapshot,
  }
  BUDGET_REGISTRY.set(regKey, budget)
  return budget
}

/** 重启/测试用：清掉进程内共享预算单例（不影响已落盘文件）。 */
export function resetSharedBudgets() {
  BUDGET_REGISTRY.clear()
}

// ---------------- 目的引擎策略源 ----------------

function normalizePurposePolicyState(raw, at) {
  const src = isPlainObject(raw) ? raw : {}
  const s = {
    version: VERSION,
    day: typeof src.day === 'string' ? src.day : localDateKey(at),
    // 生成尝试额度：每次真正走到「投递生成」都算一次（含沉默/失败），沿用 markPurposeDelivered 语义
    attemptCount: clampInt(src.attemptCount, 0, 0, 99999),
    // 逻辑发言额度：只有 reserve 成功并 commit 结算才占用
    speechCount: clampInt(src.speechCount, 0, 0, 99999),
    nextFireAt: Number(src.nextFireAt) || 0,
    lastAttemptAt: Number(src.lastAttemptAt) || 0,
    lastSpeakAt: Number(src.lastSpeakAt) || 0,
    lastOutcome: String(src.lastOutcome ?? '').slice(0, 24),
    goalId: String(src.goalId ?? '').slice(0, 24),
  }
  ensurePurposePolicyDay(s, at)
  return s
}

function ensurePurposePolicyDay(s, at) {
  const day = localDateKey(at)
  if (s.day !== day) {
    s.day = day
    s.attemptCount = 0
    s.speechCount = 0
  }
  return s
}

/**
 * 目的引擎策略源。
 * 两个额度口径严格分开：
 *   1) 生成尝试额度（attemptCount / attemptMax，默认 = cfg.ext.purpose.maxPerDay ?? speakUp.maxPerDay）
 *      —— 由 noteAttempt() 记账：沉默、失败、模型没吐出东西都算（回合已经花钱了）；
 *   2) 逻辑发言额度（speechCount / speechMax，默认 = attemptMax，可用 cfg.ext.purpose.speechMaxPerDay 单列）
 *      —— 只有 reserve 成功才挂起，commit 结算才算数；failed / release 退还。
 * commit('failed') → 退逻辑发言额度、不退生成尝试额度（契约 §2）。
 * commit('uncertain') → 不退款（到底发没发不知道，保守按已占处理）。
 */
export function createPurposePolicy({ getConfig, engine, state, now, dataDir, log, budget: injectedBudget } = {}) {
  const name = 'purpose'
  const clock = clockOf(now)
  const dir = resolveDir(dataDir)
  const stateFile = () => (dir ? join(dir, 'purpose-policy.json') : '')

  const cfgOf = () => {
    const cfg = typeof getConfig === 'function' ? getConfig() : null
    return isPlainObject(cfg) ? cfg : {}
  }
  const engineState = () => {
    try {
      const raw = typeof state === 'function' ? state() : state
      return isPlainObject(raw) ? raw : null
    } catch {
      return null
    }
  }
  const engineStateThrows = () => {
    if (typeof state !== 'function') return false
    try {
      state()
      return false
    } catch {
      return true
    }
  }

  const t0 = clock()
  let cache = null
  function load(at = t0) {
    if (cache) return cache
    const raw = stateFile() ? readJsonFile(stateFile(), null) : null
    const s = normalizePurposePolicyState(raw, at)
    if (!raw) {
      // 首次启用：从引擎自己的状态里接管当日已用次数与排程，避免重启后额度被「重置」再发一次
      const es = engineState()
      if (es) {
        s.attemptCount = Math.max(s.attemptCount, clampInt(es.countToday, 0, 0, 99999))
        s.nextFireAt = Math.max(s.nextFireAt, Number(es.nextFireAt) || 0)
        s.lastAttemptAt = Math.max(s.lastAttemptAt, Number(es.lastAttemptAt) || 0)
      }
    }
    cache = s
    return s
  }

  const persist = () => {
    const f = stateFile()
    if (f && cache) writeJsonFile(f, cache, log)
  }

  const pending = new Map() // reserveId → { at, to, itemId, sourceModule }
  // 最近一次拒绝的 reason / detail（面板显示「为什么现在不发」，见 §8.1）
  let lastReason = null
  let lastDetail = null
  const ownerQQ = (() => {
    try {
      return String(cfgOf().ownerQQ ?? '')
    } catch {
      return ''
    }
  })()
  const budget = injectedBudget || createSharedBudget({ ownerQQ, dataDir, now: clock, log })

  function enabled() {
    const cfg = cfgOf()
    return cfg.enabled !== false && cfg.ext?.purpose?.enabled === true
  }

  /** 配置 → 门闸参数（与 purpose/module.js 的 purposeConfig 同口径，这里自带一份）。 */
  function gateConf() {
    const cfg = cfgOf()
    const ext = (cfg.ext && cfg.ext.purpose) || {}
    const su = cfg.speakUp || {}
    const awakeFrom = clampInt(ext.awakeFrom ?? su.awakeFrom, 8, 0, 24)
    const awakeTo = clampInt(ext.awakeTo ?? su.awakeTo, 23, 0, 24)
    const attemptMaxRaw = clampInt(ext.maxPerDay ?? su.maxPerDay, 4, 0, 24)
    const attemptMax = unlimitedIfZero(attemptMaxRaw)
    const speechMax = unlimitedIfZero(clampInt(ext.speechMaxPerDay ?? attemptMaxRaw, attemptMaxRaw, 0, 24))
    const gapMinMin = clampInt(ext.minIntervalMinutes ?? su.minIntervalMinutes, 90, 5, 2880)
    const gapMaxMin = Math.max(gapMinMin, clampInt(ext.maxIntervalMinutes ?? su.maxIntervalMinutes, 240, 5, 2880))
    return {
      awakeFrom,
      awakeTo,
      attemptMax,
      speechMax,
      gapMinMs: gapMinMin * MINUTE,
      gapMaxMs: gapMaxMin * MINUTE,
    }
  }

  /** 引擎侧 evaluatePurposeTick 的 reason → 契约 reason 的映射。 */
  function mapEngineReason(reason) {
    const r = String(reason ?? '')
    if (r === 'quiet' || r === 'disabled' || r === 'paused' || r === 'owner-not-allowed') return 'quiet'
    if (r === 'daily-max' || r === 'budget') return 'budget'
    if (r === 'busy') return 'busy'
    if (r === 'waiting' || r === 'owner-active' || r === 'not-friend') return 'cooldown'
    return 'error'
  }

  /**
   * 纯判定（只读，不改任何状态）：现在能不能预占。
   * 与 purpose/engine.js evaluatePurposeTick 同序：开关 → 安静时段 → 日额度 → 忙。
   * 注意：**不看 nextFireAt**——「她下次什么时候主动开口」是引擎自己排程的领地（engine.js /
   * purpose-state.json），策略源再养一份只会漂移互锁（2026-11-04 实测：引擎到点开口反被
   * 策略账本的旧排程以 cooldown 拦死）。排程时间在这里只做面板展示。
   * role='review'（broker 代发审查）更宽：只看开关/安静时段/在途串行，
   * 不占任何额度（代发不占目的引擎的说话额度，审查只凭记忆与心情）。
   */
  function evaluate({ at } = {}, role = 'speak') {
    const t = Number(at) || clock()
    if (engineStateThrows()) return { ok: false, reason: 'error', detail: 'state-provider' }
    if (!enabled()) return { ok: false, reason: 'quiet', detail: 'disabled' }
    // 注入了引擎就给引擎判（口径以引擎为准）；否则用自带同口径实现
    if (role !== 'review' && typeof engine?.evaluateTick === 'function') {
      try {
        const cfg = cfgOf()
        const res = engine.evaluateTick({
          now: t,
          config: (cfg.ext && cfg.ext.purpose) || {},
          state: engineState() || load(t),
          env: typeof engine.env === 'function' ? engine.env() || {} : engine.env || {},
        })
        if (res && (res.action === 'run' || res.action === 'allow')) return { ok: true, via: 'engine' }
        return {
          ok: false,
          reason: mapEngineReason(res?.reason),
          detail: `engine:${res?.reason ?? 'unknown'}`,
          nextAt: res?.nextFireAt,
        }
      } catch {
        return { ok: false, reason: 'error', detail: 'engine-tick' }
      }
    }
    const conf = gateConf()
    const s = load(t)
    ensurePurposePolicyDay(s, t)
    if (role === 'review') {
      // 代发审查：只看开关 + 在途串行（一次只审查/投递一条，防轰炸）。
      // 不占额度、不看排程，也**不守安静时段**（2026-11-04 主人定的口径）：
      // 深夜收到模块提交也照常过目——说不说由引擎看内容决断，安静时段拦的只能是她自己开口。
      if (pending.size > 0) return { ok: false, reason: 'busy', detail: 'in-flight' }
      return { ok: true }
    }
    if (!inAwakeWindow(t, conf.awakeFrom, conf.awakeTo)) return { ok: false, reason: 'quiet', detail: 'asleep' }
    if (s.attemptCount >= conf.attemptMax) return { ok: false, reason: 'budget', detail: 'attempt-budget' }
    if (s.speechCount + pending.size >= conf.speechMax) return { ok: false, reason: 'budget', detail: 'speech-budget' }
    if (pending.size > 0) return { ok: false, reason: 'busy', detail: 'in-flight' }
    return { ok: true }
  }

  /** 下一次开口时刻：引擎能算就用引擎，否则按 gapMin~gapMax 抖动，落在安静时段推到窗口开始。 */
  function planNext(at) {
    const cfg = cfgOf()
    if (typeof engine?.planNextFire === 'function') {
      try {
        const s = load(at)
        const n = Number(engine.planNextFire({
          now: at,
          config: (cfg.ext && cfg.ext.purpose) || {},
          lastRunAt: at,
          countToday: s.attemptCount,
        }))
        if (Number.isFinite(n) && n > at) return n
      } catch {
        /* 引擎算不出来就回落自带实现 */
      }
    }
    const conf = gateConf()
    let next = at + conf.gapMinMs + Math.random() * (conf.gapMaxMs - conf.gapMinMs)
    if (!inAwakeWindow(next, conf.awakeFrom, conf.awakeTo)) next = awakeStartAfter(next, conf.awakeFrom)
    return Math.round(next)
  }

  function syncLimits() {
    const conf = gateConf()
    const sharedDailyMax = cfgOf().ext?.outboundPolicy?.sharedDailyMax
    budget.setLimits({
      source: name,
      dailyMax: Number.isFinite(conf.speechMax) ? conf.speechMax : 0,
      minGapMs: 0,
      sharedDailyMax,
    })
  }

  /** 四态：error（读配置/读状态炸了）> configured（已注册未启用）> running（有预占在途）> ready */
  function stateOf() {
    try {
      if (engineStateThrows()) return 'error'
      if (!enabled()) return 'configured'
      if (pending.size > 0) return 'running'
      return 'ready'
    } catch {
      return 'error'
    }
  }

  /**
   * 统一的拒绝出口：顺手把原因记进 lastReason，面板据此显示「为什么现在不发」
   * （设计稿 §8.1：面板要能看到原因，而不是只有 ready/not-ready）。
   */
  function deny(reason, detail, nextAt) {
    lastReason = reason || null
    lastDetail = detail || null
    return { ok: false, reason, detail, nextAt, name }
  }

  /**
   * 目标是否本策略源该管的人：只治理主人。
   * 目的引擎对白名单朋友本就各有各的状态（purpose/module.js 的 stateFile(friend)），
   * 不能拿主人的额度去卡朋友，也不能让朋友的消息刷新主人的冷却。
   * 详见 speakup 侧同名函数的注释。
   */
  function scopeOf(to) {
    const target = String(to ?? '').trim()
    if (!target) return { managed: true }
    if (!target.startsWith('private:')) return { managed: false, reason: 'out-of-scope' }
    const qq = target.slice('private:'.length)
    if (ownerQQ && qq === ownerQQ) return { managed: true }
    return { managed: false, reason: 'out-of-scope' }
  }

  /** 原子预占：同步返回，内部状态同步变更。 */
  function reserve({ to, sourceModule, itemId, at } = {}) {
    const t = Number(at) || clock()
    const scope = scopeOf(to)
    if (!scope.managed) return deny(scope.reason)
    let gate
    try {
      gate = evaluate({ at: t })
    } catch (error) {
      log?.warn?.(`purpose 策略判定异常：${error?.message || error}`)
      return deny('error')
    }
    if (!gate.ok) return deny(gate.reason, gate.detail, gate.nextAt)
    const reserveId = makeReserveId(name, t)
    // 先挂起（占住本地逻辑发言额度），再抢共享域：共享域拒绝就立刻撤回本地挂起
    pending.set(reserveId, { at: t, to, itemId, sourceModule })
    syncLimits()
    const shared = budget.tryAcquire({ reserveId, source: name, at: t })
    if (!shared.ok) {
      pending.delete(reserveId)
      return deny(shared.reason, shared.detail)
    }
    const s = load(t)
    ensurePurposePolicyDay(s, t)
    s.lastOutcome = 'pending'
    persist()
    return { ok: true, reserveId, name, at: t }
  }

  /**
   * 结算一次预占。
   * role='review'（代发审查预占）：只清挂起、退共享域，**不动任何额度、不重排任何排程**——
   *   代发不占目的引擎的说话额度，也不碰她「下次什么时候主动开口」。
   * speak（引擎自发发言/默认）：
   *   sent / queued → 占用逻辑发言额度（uncertain 同样占用不退款）
   *   failed        → 退还逻辑发言额度，不重排（可以下次再试）；生成尝试额度不退
   */
  function commit(reserveId, { deliveryId, outcome } = {}, role = 'speak') {
    const rid = String(reserveId ?? '')
    if (!pending.has(rid)) return { ok: false, reason: 'settled', name }
    const oc = normalizeOutcome(outcome)
    const t = clock()
    pending.delete(rid)
    const s = load(t)
    ensurePurposePolicyDay(s, t)
    if (role === 'review') {
      const shared = budget.settle(rid, { refund: true, at: t })
      s.lastOutcome = 'review-done'
      persist()
      return { ok: true, name, outcome: oc, deliveryId: deliveryId ?? null, refund: true, review: true, shared }
    }
    const refund = oc === 'failed'
    const shared = budget.settle(rid, { refund, at: t })
    if (refund) {
      s.lastOutcome = 'failed'
    } else {
      s.speechCount += 1
      s.lastSpeakAt = t
      s.lastOutcome = oc
      s.nextFireAt = planNext(t)
    }
    persist()
    return {
      ok: true,
      name,
      outcome: oc,
      deliveryId: deliveryId ?? null,
      refund,
      speechCount: s.speechCount,
      nextFireAt: s.nextFireAt,
      shared,
    }
  }

  /** 未发送释放：退逻辑发言额度（本来就没占），不影响生成尝试额度。 */
  function release(reserveId, { reason } = {}) {
    const rid = String(reserveId ?? '')
    if (!pending.has(rid)) return { ok: false, reason: 'settled', name }
    pending.delete(rid)
    const t = clock()
    const shared = budget.settle(rid, { refund: true, at: t })
    const s = load(t)
    ensurePurposePolicyDay(s, t)
    s.lastOutcome = 'released'
    persist()
    return { ok: true, name, released: true, reason: String(reason ?? '').slice(0, 80), shared }
  }

  /**
   * 生成尝试记账（沿用 markPurposeDelivered 语义：投递出去就先占今日次数，
   * 不管最后她有没有发消息——模型回合已经花钱了）。沉默/失败都算。
   */
  function noteAttempt({ at, planned, text } = {}) {
    const t = Number(at) || clock()
    const s = load(t)
    ensurePurposePolicyDay(s, t)
    s.attemptCount += 1
    s.lastAttemptAt = t
    persist()
    const es = engineState()
    if (es && typeof engine?.markPurposeDelivered === 'function') {
      try {
        engine.markPurposeDelivered(es, { now: t, planned: planned || (text ? { text } : null) })
      } catch {
        /* 镜像失败不影响本策略账本 */
      }
    }
    return { ok: true, name, attemptCount: s.attemptCount, day: s.day }
  }

  function snapshot() {
    const s = load(clock())
    const conf = gateConf()
    return {
      name,
      ownerQQ,
      state: stateOf(),
      day: s.day,
      attemptCount: s.attemptCount,
      attemptMax: Number.isFinite(conf.attemptMax) ? conf.attemptMax : 0,
      speechCount: s.speechCount,
      speechMax: Number.isFinite(conf.speechMax) ? conf.speechMax : 0,
      nextFireAt: s.nextFireAt,
      lastOutcome: s.lastOutcome,
      pending: [...pending.keys()],
      budget: budget.snapshot(),
      file: stateFile(),
    }
  }

  /**
   * 代发审查预占（broker 档 api.proactive.submit 专用）：
   * 只做「引擎开着 + 清醒时段 + 在途串行」三道闸，**不占生成尝试/逻辑发言额度、不看排程**
   * （代发审查不参考目的引擎自己的说话剩余时间，只凭记忆与心情决断内容）。
   * 结算必须走 commit(reserveId, …, 'review')：只清挂起，不动账。
   */
  function reserveReview({ to, itemId, at } = {}) {
    const t = Number(at) || clock()
    const scope = scopeOf(to)
    if (!scope.managed) return { ok: false, reason: 'quiet', detail: 'out-of-scope', name }
    let gate
    try {
      gate = evaluate({ at: t }, 'review')
    } catch (error) {
      log?.warn?.(`purpose 审查判定异常：${error?.message || error}`)
      return { ok: false, reason: 'error', name }
    }
    if (!gate.ok) return { ...deny(gate.reason, gate.detail, gate.nextAt) }
    const reserveId = makeReserveId(name, t)
    pending.set(reserveId, { at: t, to, itemId, sourceModule: 'review' })
    return { ok: true, reserveId, name, at: t, role: 'review' }
  }

  return {
    name,
    kind: 'policy',
    state: stateOf,
    ready: () => stateOf() === 'ready',
    reserve,
    reserveReview,
    commit,
    release,
    evaluate,
    noteAttempt,
    planNext,
    snapshot,
    // 面板显示「为什么现在不发」：最近一次拒绝的 reason 键与中文说明（设计稿 §8.1）。
    get lastReason() { return lastReason },
    get stateReason() { return lastReason ? (REASON_TEXT[lastReason] || `未知原因（${lastReason}）`) : null },
    reasonText: (reason) => REASON_TEXT[reason] || `未知原因（${reason}）`,
    reasons: () => [...REASONS],
    paths: () => ({ state: stateFile(), budget: budget.snapshot().file }),
    budget,
  }
}

// ---------------- 主动搭话策略源 ----------------

function normalizeSpeakupPolicyState(raw, at) {
  const src = isPlainObject(raw) ? raw : {}
  const s = {
    version: VERSION,
    day: typeof src.day === 'string' ? src.day : localDateKey(at),
    count: clampInt(src.count, 0, 0, 99999),
    nextAt: Number(src.nextAt) || 0,
    last: Number(src.last) || 0,
    lastOutcome: String(src.lastOutcome ?? '').slice(0, 24),
  }
  ensureSpeakupDay(s, at)
  return s
}

function ensureSpeakupDay(s, at) {
  const day = localDateKey(at)
  if (s.day !== day) {
    s.day = day
    s.count = 0
  }
  return s
}

/**
 * 主动搭话策略源：复刻 companion.js tick 的判定
 *   `awake && idleOk && count < maxPerDay && Date.now() >= nextAt`
 * 并拆成「纯判定（reserve 用）」与「结算才落账（commit 用）」两步：
 *   · reserve 不改 count、不改 nextAt，只挂起；
 *   · commit（sent/queued/uncertain/failed 一律不退款，契约 §2）→ count++ 并重排 nextAt；
 *   · release（未发送）→ 退预占，不占次数。
 */
export function createSpeakupPolicy({ getConfig, speakup, now, dataDir, log, lastPrivateAt, isMuted, budget: injectedBudget } = {}) {
  const name = 'speakup'
  const clock = clockOf(now)
  const dir = resolveDir(dataDir)
  const stateFile = () => (dir ? join(dir, 'speakup-policy.json') : '')

  const cfgOf = () => {
    const cfg = typeof getConfig === 'function' ? getConfig() : null
    return isPlainObject(cfg) ? cfg : {}
  }
  /** 配置 → 判定参数（与 core/config.js 的 speakUp 默认值对齐）。 */
  function confOf() {
    const cfg = cfgOf()
    const c = cfg.speakUp || {}
    const gapMin = Math.max(1, clampInt(c.minIntervalMinutes, 60, 1, 525600))
    const gapMax = Math.max(gapMin, clampInt(c.maxIntervalMinutes, 180, 1, 525600))
    return {
      enabled: cfg.enabled !== false && c.enabled !== false,
      awakeFrom: clampInt(c.awakeFrom, 8, 0, 24),
      awakeTo: clampInt(c.awakeTo, 23, 0, 24),
      idleMs: Math.max(0, clampInt(c.idleMinutes, 40, 0, 525600) * MINUTE),
      // 0 = 今天一次都不发（与 companion 的 `count < maxPerDay` 一致），不是「不限」
      maxPerDay: Math.max(0, clampInt(c.maxPerDay, 20, 0, 1e6)),
      gapMinMs: gapMin * MINUTE,
      gapMaxMs: gapMax * MINUTE,
    }
  }

  const companionState = () => {
    try {
      const raw = typeof speakup?.state === 'function' ? speakup.state() : null
      return isPlainObject(raw) ? raw : null
    } catch {
      return null
    }
  }
  const companionThrows = () => {
    if (typeof speakup?.state !== 'function') return false
    try {
      speakup.state()
      return false
    } catch {
      return true
    }
  }
  /** 和主人私聊的「最近一次来往」（companion 里是 max(lastOwnerChatAt, lastBotToOwner.at)）。 */
  const lastPrivate = () => {
    try {
      const fn = typeof lastPrivateAt === 'function' ? lastPrivateAt : speakup?.lastPrivateAt
      if (typeof fn === 'function') return Number(fn()) || 0
    } catch {
      /* 探针失败按 0 处理（= 冷场很久） */
    }
    return 0
  }

  const t0 = clock()
  let cache = null
  function load(at = t0) {
    if (cache) return cache
    const raw = stateFile() ? readJsonFile(stateFile(), null) : null
    const s = normalizeSpeakupPolicyState(raw, at)
    if (!raw) {
      const cs = companionState()
      if (cs) {
        // 首次接管：承接 companion 自己那份 speakup.json（同一天才算）
        if (cs.day === new Date(at).toDateString()) s.count = Math.max(s.count, clampInt(cs.count, 0, 0, 99999))
        s.nextAt = Math.max(s.nextAt, Number(cs.nextAt) || 0)
        s.last = Math.max(s.last, Number(cs.last) || 0)
      }
    }
    cache = s
    return s
  }
  const persist = () => {
    const f = stateFile()
    if (f && cache) writeJsonFile(f, cache, log)
  }

  const pending = new Map()
  // 最近一次拒绝的 reason / detail（面板显示「为什么现在不发」，见 §8.1）
  let lastReason = null
  let lastDetail = null
  const ownerQQ = (() => {
    try {
      return String(cfgOf().ownerQQ ?? '')
    } catch {
      return ''
    }
  })()
  const budget = injectedBudget || createSharedBudget({ ownerQQ, dataDir, now: clock, log })

  function schedule(at) {
    const conf = confOf()
    return Math.round(at + conf.gapMinMs + Math.random() * (conf.gapMaxMs - conf.gapMinMs))
  }

  /**
   * 纯判定：把 companion tick 的条件逐条拆开，只读状态，不扣次数。
   * reason 与 tick 语义一一对应：
   *   asleep / muted / 未启用 → quiet；超过每日上限 → budget；
   *   间隔没到 / 主人刚说过话 → cooldown；有在途 → busy；读状态炸了 → error。
   */
  function evaluate({ at } = {}) {
    const t = Number(at) || clock()
    if (companionThrows()) return { ok: false, reason: 'error', detail: 'companion-state' }
    const conf = confOf()
    if (!conf.enabled) return { ok: false, reason: 'quiet', detail: 'disabled' }
    if (typeof isMuted === 'function' && isMuted(`private:${ownerQQ}`)) {
      return { ok: false, reason: 'quiet', detail: 'muted' }
    }
    if (!inAwakeWindow(t, conf.awakeFrom, conf.awakeTo)) return { ok: false, reason: 'quiet', detail: 'asleep' }
    const s = load(t)
    ensureSpeakupDay(s, t)
    if (s.count + pending.size >= conf.maxPerDay) return { ok: false, reason: 'budget', detail: 'daily-max' }
    if (s.nextAt && t < s.nextAt) return { ok: false, reason: 'cooldown', detail: 'interval', nextAt: s.nextAt }
    // 与 companion 同口径：`Date.now() - lastPrivateAt() > idleMinutes * 60_000`（严格大于）
    if (conf.idleMs > 0) {
      const last = lastPrivate()
      if (t - last <= conf.idleMs) return { ok: false, reason: 'cooldown', detail: 'owner-active', nextAt: last + conf.idleMs }
    }
    if (pending.size > 0) return { ok: false, reason: 'busy', detail: 'in-flight' }
    return { ok: true }
  }

  function syncLimits() {
    const conf = confOf()
    budget.setLimits({
      source: name,
      dailyMax: conf.maxPerDay,
      minGapMs: 0,
      sharedDailyMax: cfgOf().ext?.outboundPolicy?.sharedDailyMax,
    })
  }

  function stateOf() {
    try {
      if (companionThrows()) return 'error'
      if (!confOf().enabled) return 'configured'
      if (pending.size > 0) return 'running'
      return 'ready'
    } catch {
      return 'error'
    }
  }

  /** 统一的拒绝出口：顺手把原因记进 lastReason，面板据此显示「为什么现在不发」。 */
  function deny(reason, detail, nextAt) {
    lastReason = reason || null
    lastDetail = detail || null
    return { ok: false, reason, detail, nextAt, name }
  }

  /**
   * 目标是否本策略源该管的人：只治理主人。
   *
   * 主动搭话本来就有白名单（companion.js 的 speakUp.allow / tickFriends）：白名单里的人
   * 每人单独算次数和间隔，是「她和对方自己的聊天」，跟主人的额度、冷却互不相干。
   * 目的引擎同理（purpose/module.js 的 stateFile(friend) 每人一份状态）。
   *
   * 所以这里守一条线：**本策略源只对主人私聊做预算判定**。收到非主人目标时返回 out-of-scope，
   * 由调用方按「不治理」放行——绝不能拿主人的额度去卡朋友，也不能让朋友的消息刷新主人的 nextAt。
   * 出站策略首版本来也只在 admit 里治理 owner 私聊（设计稿 §2），这里是第二道防线，
   * 防的是将来把范围放宽到全部私聊时，忘了按接收人隔离而静默串额度。
   */
  function scopeOf(to) {
    const target = String(to ?? '').trim()
    if (!target) return { managed: true } // 没给目标：按主人处理（调用方缺省面向主人）
    if (!target.startsWith('private:')) return { managed: false, reason: 'out-of-scope' }
    const qq = target.slice('private:'.length)
    if (ownerQQ && qq === ownerQQ) return { managed: true }
    // 非主人的私聊（白名单朋友等）：不归本策略源管
    return { managed: false, reason: 'out-of-scope' }
  }

  function reserve({ to, sourceModule, itemId, at } = {}) {
    const t = Number(at) || clock()
    const scope = scopeOf(to)
    if (!scope.managed) return deny(scope.reason)
    let gate
    try {
      gate = evaluate({ at: t })
    } catch (error) {
      log?.warn?.(`speakup 策略判定异常：${error?.message || error}`)
      return deny('error')
    }
    if (!gate.ok) return deny(gate.reason, gate.detail, gate.nextAt)
    const reserveId = makeReserveId(name, t)
    pending.set(reserveId, { at: t, to, itemId, sourceModule })
    syncLimits()
    const shared = budget.tryAcquire({ reserveId, source: name, at: t })
    if (!shared.ok) {
      pending.delete(reserveId)
      return deny(shared.reason, shared.detail)
    }
    return { ok: true, reserveId, name, at: t }
  }

  /**
   * 结算：未被 release 的终局 commit 一律不退款（契约 §2「speakup 一律不退款」），
   * 因此 sent/queued/uncertain/failed 都 `count++` 并重排 nextAt——
   * 只有 reserve 阶段（尚未真正尝试）才不占次数，这正是 tick 里「判定通过才 count++」的拆分。
   */
  function commit(reserveId, { deliveryId, outcome } = {}) {
    const rid = String(reserveId ?? '')
    if (!pending.has(rid)) return { ok: false, reason: 'settled', name }
    const oc = normalizeOutcome(outcome)
    const t = clock()
    pending.delete(rid)
    const s = load(t)
    ensureSpeakupDay(s, t)
    s.count += 1
    s.last = t
    s.nextAt = schedule(t)
    s.lastOutcome = oc
    persist()
    const shared = budget.settle(rid, { refund: false, at: t })
    return { ok: true, name, outcome: oc, deliveryId: deliveryId ?? null, count: s.count, nextAt: s.nextAt, shared }
  }

  function release(reserveId, { reason } = {}) {
    const rid = String(reserveId ?? '')
    if (!pending.has(rid)) return { ok: false, reason: 'settled', name }
    pending.delete(rid)
    const t = clock()
    const shared = budget.settle(rid, { refund: true, at: t })
    const s = load(t)
    ensureSpeakupDay(s, t)
    s.lastOutcome = 'released'
    persist()
    return { ok: true, name, released: true, reason: String(reason ?? '').slice(0, 80), shared }
  }

  function snapshot() {
    const s = load(clock())
    const conf = confOf()
    return {
      name,
      ownerQQ,
      state: stateOf(),
      day: s.day,
      count: s.count,
      maxPerDay: conf.maxPerDay,
      nextAt: s.nextAt,
      last: s.last,
      lastOutcome: s.lastOutcome,
      pending: [...pending.keys()],
      budget: budget.snapshot(),
      file: stateFile(),
    }
  }

  return {
    name,
    kind: 'policy',
    state: stateOf,
    ready: () => stateOf() === 'ready',
    reserve,
    commit,
    release,
    evaluate,
    snapshot,
    // 面板显示「为什么现在不发」：最近一次拒绝的 reason 键与中文说明（设计稿 §8.1）。
    // 取值器而非快照，面板每次读都要最新值。
    get lastReason() { return lastReason },
    get stateReason() { return lastReason ? (REASON_TEXT[lastReason] || `未知原因（${lastReason}）`) : null },
    reasonText: (reason) => REASON_TEXT[reason] || `未知原因（${reason}）`,
    reasons: () => [...REASONS],
    paths: () => ({ state: stateFile(), budget: budget.snapshot().file }),
    budget,
  }
}

export { REASON_TEXT, REASONS, OUTCOMES }
