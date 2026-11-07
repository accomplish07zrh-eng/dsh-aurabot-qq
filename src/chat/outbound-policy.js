// 来源：本仓库自研（2026-11-03 主动发言出站治理）。设计说明见 docs/OUTBOUND-POLICY-DESIGN.md。
//       本文件是该设计稿的核心实现：宿主统一发送服务的判定层与账本层。
// 作用：出站（主动私聊 owner）的统一判定与账本层。给 hub.js / modules.js / host.js 消费，
//       把「模块想主动说话」这件事收敛成 admit → reserve → commit/release，并维护一份可落盘的最小账本。
// 契约：对外导出/档位/故障语义/分类与因果/账本状态机（见设计稿 §4、§6、§8）。
//       本文件只依赖 Node 内置模块，**不 import 仓库内任何 src 文件**；全部 API 同步返回、不抛异常。
// 边界：本文件只回答「能不能发 / 记没记账」，不自己发消息（发由 hub 做）。

import fs from 'node:fs'
import { join } from 'node:path'

// ── 常量（契约第三节「账本」） ───────────────────────────────────────────────

const LEDGER_FILE = 'ledger.json'
const LEDGER_VERSION = 1
const LEDGER_MAX_ITEMS = 200 // 最多 200 条
const LEDGER_TTL_MS = 24 * 60 * 60 * 1000 // TTL 24h
const MAX_TEXT_BYTES = 8 * 1024 // 单条文本 8KB

const DEFAULT_TIER = 'pass' // 契约 L74：pass 是兼容旧行为的默认档
const TIERS = ['pass', 'gate', 'broker']
const ACTIVE_MODES = ['purpose', 'speakup', 'auto']
const POLICY_READY_STATE = 'ready'
const CAUSES = ['reply', 'delegation', 'background', 'unknown']
const KNOWN_STATES = ['pending', 'sending', 'sent', 'dropped', 'failed', 'uncertain', 'expired']

// 策略源 reserve 失败原因 → 宿主对外 reason（策略源自报的原因优先保留）
const RESERVE_REASONS = ['quiet', 'budget', 'cooldown', 'busy', 'error']

// ── 内部小工具 ─────────────────────────────────────────────────────────────

/** 从任意配置形状里取全局配置；外面传对象、函数、都没给都兜得住。 */
function resolveConfig(getConfig) {
  try {
    if (typeof getConfig === 'function') return getConfig() || {}
    return getConfig || {}
  } catch {
    return {}
  }
}

/** 读档位：只认 config.outboundPolicy.tier（兼容旧变量名 config.ext.outboundPolicy.tier），其余一律回落 pass。 */
function readTier(cfg) {
  const c = cfg || {}
  const raw = (c.outboundPolicy && c.outboundPolicy.tier) ??
    (c.ext && c.ext.outboundPolicy && c.ext.outboundPolicy.tier)
  const tier = String(raw ?? DEFAULT_TIER).trim().toLowerCase()
  return TIERS.includes(tier) ? tier : DEFAULT_TIER
}

/** 读主人 QQ，统一成字符串去空格（保存值与快照比较都用它）。 */
function readOwnerQQ(cfg) {
  const c = cfg || {}
  const raw = (c.outboundPolicy && c.outboundPolicy.ownerQQ) ?? c.ownerQQ
  if (raw === null || raw === undefined) return ''
  return String(raw).trim()
}

/** 把 to 规范化：'private:123456' / 'private: 123456 ' 都收敛成 'private:123456'。 */
function normalizeTarget(to) {
  if (to === null || to === undefined) return ''
  const s = String(to).trim()
  const m = /^private\s*:\s*(.*)$/i.exec(s)
  if (m) return `private:${String(m[1]).trim()}`
  return s
}

/** 幂等键：moduleId|itemId|to|channel（契约 L97）。 */
function idempotentKey(moduleId, itemId, to, channel) {
  return [moduleId, itemId, to, channel].map((x) => String(x ?? '')).join('|')
}

/** 文本字节数（按 UTF-8 计，8KB 上限用）。 */
function textBytes(text) {
  if (text === null || text === undefined) return 0
  const s = String(text)
  // Buffer 是 Node 内置全局，不额外 import
  return Buffer.byteLength(s, 'utf8')
}

/** 生成一个稳定前缀的 id（不需要加密强度，够本地唯一即可）。 */
let seq = 0
function makeId(prefix, at) {
  seq = (seq + 1) % 1e9
  const stamp = Number.isFinite(at) ? Math.floor(at) : Date.now()
  return `${prefix}_${stamp.toString(36)}_${seq.toString(36)}`
}

/** 因果分类：无 cause / unknown 一律按 background 保守处理（契约 L87）。 */
function normalizeCause(cause) {
  if (!cause || typeof cause !== 'object') return { kind: 'background', raw: null }
  const kindRaw = typeof cause.kind === 'string' ? cause.kind.trim().toLowerCase() : ''
  const kind = CAUSES.includes(kindRaw) ? kindRaw : 'background'
  return { kind, raw: cause }
}

/**
 * 判定一次发送是否「在治理范围内」。
 * 治理范围：to === 'private:' + ownerQQ（规范化后比较）；delegation 与 reply 另有专门规则。
 * 返回 { managed, reason }：managed=false 表示不治理（直接放行且面板不算纳管）。
 */
function isGovernedTarget(to, ownerQQ) {
  if (!ownerQQ) return false
  return normalizeTarget(to) === `private:${ownerQQ}`
}

// ── 主工厂 ─────────────────────────────────────────────────────────────────

/**
 * 创建宿主统一发送服务。
 *
 * @param {object} [opts]
 * @param {() => object} [opts.getConfig] 取全局配置（档位 / ownerQQ / outboundPolicy）
 * @param {string|null} [opts.dataDir]    账本落盘目录；为空则退化为纯内存（测试用）
 * @param {(msg: string) => void} [opts.log] 日志函数
 * @param {() => number} [opts.now]       取当前时间的函数（测试可注入）
 * @param {object} [opts.hooks]           测试钩子：{ fsSync }，fsSync=false 时只跑内存账本
 * @param {Function} [opts.send]          实际投递函数（宿主注入）。给了它，submit 就会自己把
 *                                        条目发出去——模块只调 submit 即可，不必自己管投递与重试；
 *                                        不给则只记账（旧行为，模块自己按 statusOf 跟进）。
 */
export function createOutboundPolicy(opts = {}) {
  const getConfig = opts.getConfig
  const dataDir = opts.dataDir || null
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  const hooks = opts.hooks || {}
  // 宿主投递器：由 hub 侧注入（一般是 (to, text) => hub.sendText(...)，带 outboundDone 免重复判定）
  let deliverer = typeof opts.send === 'function' ? opts.send : null
  // hooks.fsSync === false 时彻底不碰磁盘（测试用）；默认同步落盘
  const fsEnabled = hooks.fsSync !== false && Boolean(dataDir)

  /** 策略源登记表：name -> policy（幂等，同 name 覆盖） */
  const sources = new Map()
  /** 活跃策略源选择：'purpose' | 'speakup' | 'auto'（auto=取 ready 的那个） */
  let activeMode = 'auto'
  /** 内存账本：deliveryId -> item */
  let items = new Map()
  /** reserveId -> { policyName, key, deliveryId } —— 等待 commit/release 的预占 */
  const reservations = new Map()
  /** 已结算的 reserveId -> { outcome, at }（重复调用返回 settled，不抛错） */
  const settled = new Map()
  /**
   * 幂等键 -> 门闸判定结果。submit 过完门闸后把预占挂在这里，
   * 投递完成时按 sent/failed/uncertain 结算——不结算的话预占会一直挂着，
   * 下一次判定就变成 busy（这也是实现期踩过的坑）。
   */
  const reservedByItem = new Map()
  /** 统计（status() 里给面板看） */
  const stats = {
    admitted: 0,
    allowed: 0,
    denied: 0,
    deferred: 0,
    passThrough: 0, // 未纳管（managed:false）的放行次数
    committed: 0,
    released: 0,
    submitted: 0,
    errors: 0,
  }
  /** 上一次观察到的 ownerQQ（用于惰性比对，变了就作废旧 pending） */
  let lastOwnerQQ = ''

  // ── 落盘 ────────────────────────────────────────────────────────────────

  /** 读账本文件；任何异常都退回空账本（服务不因磁盘问题挂掉）。 */
  function loadLedger() {
    items = new Map()
    if (!fsEnabled) return
    try {
      const file = join(dataDir, LEDGER_FILE)
      if (!fs.existsSync(file)) return
      const raw = fs.readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed && parsed.items) ? parsed.items : []
      for (const it of list) {
        if (!it || !it.deliveryId) continue
        const state = KNOWN_STATES.includes(it.state) ? it.state : 'pending'
        items.set(String(it.deliveryId), { ...it, state })
      }
    } catch (err) {
      stats.errors++
      log(`[outbound-policy] 账本读取失败，按空账本继续：${err && err.message ? err.message : err}`)
      items = new Map()
    }
  }

  /** 同步落盘账本；失败只记日志不抛（契约：持久化不得阻塞/打断调用）。 */
  function saveLedger() {
    if (!fsEnabled) return
    try {
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
      const payload = { version: LEDGER_VERSION, items: ledgerArray() }
      const file = join(dataDir, LEDGER_FILE)
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
      fs.renameSync(tmp, file)
    } catch (err) {
      stats.errors++
      log(`[outbound-policy] 账本落盘失败：${err && err.message ? err.message : err}`)
    }
  }

  loadLedger()

  // ── 账本基础操作 ─────────────────────────────────────────────────────────

  function getItem(deliveryId) {
    if (deliveryId === null || deliveryId === undefined) return null
    return items.get(String(deliveryId)) || null
  }

  function ledgerArray() {
    return Array.from(items.values()).sort((a, b) => (a.at || 0) - (b.at || 0))
  }

  /** 记账：写一条 pending 条目。 */
  function putItem(entry) {
    items.set(entry.deliveryId, entry)
    return entry
  }

  /** 状态迁移：只改内存，调用方决定何时落盘。 */
  function setState(item, state, extra = {}) {
    if (!item) return null
    item.state = state
    item.updatedAt = now()
    Object.assign(item, extra)
    return item
  }

  /** TTL 过期清理：pending 超 TTL 置 expired。 */
  function sweepExpired() {
    const t = now()
    let dirty = false
    for (const it of items.values()) {
      if (it.state !== 'pending' || !it.ttl) continue
      const exp = Number(it.at || 0) + Number(it.ttl)
      if (Number.isFinite(exp) && t >= exp) {
        setState(it, 'expired')
        dirty = true
      }
    }
    return dirty
  }

  /** 上限裁剪：超 200 条时优先清最老的非 pending（pending 受 TTL 保护）。 */
  function trimLedger() {
    if (items.size <= LEDGER_MAX_ITEMS) return false
    const all = ledgerArray()
    // 先清非 pending（按时间从老到新），仍超再清最老的 pending
    const evictOrder = [
      ...all.filter((it) => it.state !== 'pending'),
      ...all.filter((it) => it.state === 'pending'),
    ]
    let removed = false
    for (const it of evictOrder) {
      if (items.size <= LEDGER_MAX_ITEMS) break
      items.delete(it.deliveryId)
      removed = true
    }
    return removed
  }

  /**
   * 作废：模块卸载 / ownerQQ 变更 → 相关 pending 置 dropped。
   * predicate 为真且仍 pending 的条目才动。
   */
  function dropPending(predicate, reason) {
    let changed = 0
    for (const it of items.values()) {
      if (it.state !== 'pending') continue
      if (!predicate(it)) continue
      setState(it, 'dropped', { dropReason: reason })
      changed++
    }
    return changed
  }

  /** 同源合并：同幂等键且旧条目仍 pending → 旧条目 dropped(superseded)。 */
  function supersede(key) {
    let dropped = 0
    for (const it of items.values()) {
      if (it.state !== 'pending') continue
      if (it.key !== key) continue
      setState(it, 'dropped', { dropReason: 'superseded' })
      dropped++
    }
    return dropped
  }

  // ── 策略源 ──────────────────────────────────────────────────────────────

  /** 安全调 state()：策略源抛错时按 'error' 处理（故障语义要求 deny，不能静默 pass）。 */
  function stateOf(policy) {
    try {
      const s = typeof policy.state === 'function' ? policy.state() : policy.state
      const v = String(s || '').trim()
      return ['configured', 'running', 'ready', 'error'].includes(v) ? v : 'error'
    } catch (err) {
      stats.errors++
      log(`[outbound-policy] 策略源 state() 抛错，按 error 处理：${err && err.message ? err.message : err}`)
      return 'error'
    }
  }

  function isReady(policy, state) {
    const s = state ?? stateOf(policy)
    if (s !== POLICY_READY_STATE) return false
    try {
      if (typeof policy.ready === 'function') return Boolean(policy.ready())
    } catch {
      return false
    }
    return true
  }

  /**
   * 选出本轮真正生效的策略源。
   * 返回 { name, policy, state, ready } 或 { name:null, policy:null, reason }。
   */
  function pickSource() {
    if (activeMode === 'auto') {
      // auto：优先 purpose，其次 speakup；都不可用则降级（交给上层按故障语义处理）
      for (const name of ['purpose', 'speakup']) {
        const p = sources.get(name)
        if (p && isReady(p)) return { name, policy: p, state: 'ready', ready: true }
      }
      // 没有 ready 的：如果有已配置策略源，就报它（非 ready → deny）
      for (const name of ['purpose', 'speakup']) {
        const p = sources.get(name)
        if (p) return { name, policy: p, state: stateOf(p), ready: false }
      }
      return { name: null, policy: null, state: null, ready: false }
    }
    const p = sources.get(activeMode)
    if (!p) return { name: activeMode, policy: null, state: null, ready: false, missing: true }
    const st = stateOf(p)
    return { name: activeMode, policy: p, state: st, ready: isReady(p, st) }
  }

  function registerPolicySource(policy) {
    try {
      if (!policy || typeof policy !== 'object' || !policy.name) {
        stats.errors++
        return { ok: false, reason: 'invalid-policy' }
      }
      const name = String(policy.name)
      sources.set(name, policy) // 幂等：同 name 覆盖
      return { ok: true, name }
    } catch (err) {
      stats.errors++
      log(`[outbound-policy] 注册策略源失败：${err && err.message ? err.message : err}`)
      return { ok: false, reason: 'error' }
    }
  }

  function unregisterPolicySource(name) {
    try {
      const key = String(name ?? '')
      const had = sources.delete(key)
      // 契约 L96：模块卸载 → 相关 pending 置 dropped
      const dropped = dropPending((it) => it.moduleId === key || it.policySource === key, 'module-unloaded')
      if (dropped) saveLedger()
      return { ok: true, removed: had, dropped }
    } catch (err) {
      stats.errors++
      log(`[outbound-policy] 注销策略源失败：${err && err.message ? err.message : err}`)
      return { ok: false, reason: 'error' }
    }
  }

  function setActivePolicy(mode) {
    try {
      const m = String(mode ?? '').trim().toLowerCase()
      if (!ACTIVE_MODES.includes(m)) return { ok: false, reason: 'invalid-active' }
      activeMode = m
      return { ok: true, activePolicy: activeMode }
    } catch (err) {
      stats.errors++
      return { ok: false, reason: 'error' }
    }
  }

  /** 对外口径的 activePolicy：auto 时给实际生效的名字（没有就 null）。 */
  function effectiveActiveName() {
    if (activeMode !== 'auto') return sources.has(activeMode) ? activeMode : null
    const picked = pickSource()
    return picked.name && picked.ready ? picked.name : null
  }

  // ── 核心判定 ────────────────────────────────────────────────────────────

  /**
   * 是否应拦截一次「主动私聊 owner」。
   *
   * 返回 { action:'allow'|'deny'|'defer', reason?, reserveId?, deliveryId?, cause, managed }
   *
   * 判定顺序（契约 L74-89）：
   *  1. delegation → 直接 allow，不可 defer/drop（最高优先级，且不参与治理计数）
   *  2. 目标不在治理范围（不是 owner 私聊）→ allow 且 managed:false
   *  3. 档位 pass → allow，managed:false（旧行为直发）
   *  4. 档位 gate/broker 且完全没有策略源 → allow 且 managed:false（面板明示尚未纳管）
   *  5. 有策略源但非 ready → deny(policy-error)，绝不静默 pass
   *  6. 策略源 reserve → 失败按原因 deny（quiet/budget/cooldown/busy/error）
   *  7. 成功 → broker 档且 allowDefer 时 defer（进账本排队），否则 allow + reserveId/deliveryId
   */
  function admit(ask = {}) {
    try {
      stats.admitted++
      const at = Number.isFinite(ask.at) ? Number(ask.at) : now()
      const cfg = resolveConfig(getConfig)
      const ownerQQ = ensureOwnerFresh(readOwnerQQ(cfg))
      const tier = readTier(cfg)
      const to = normalizeTarget(ask.to)
      const moduleId = String(ask.moduleId ?? '')
      const itemId = String(ask.itemId ?? '')
      const { kind: causeKind, raw: causeRaw } = normalizeCause(ask.cause)

      // 1) delegation：最高优先级，直接 allow，不可 defer
      if (causeKind === 'delegation') {
        stats.allowed++
        return { action: 'allow', reason: 'delegation', cause: causeKind, managed: false }
      }

      // reply 需要校验 chatId == to（不符视为伪造 → 按 background 保守处理）
      let cause = causeKind
      if (cause === 'reply') {
        const chatId = causeRaw && causeRaw.chatId !== undefined ? normalizeTarget(causeRaw.chatId) : null
        if (chatId !== null && chatId !== to) cause = 'background'
      }

      // 2) 治理范围外（非 owner 私聊）→ allow 不治理
      if (!isGovernedTarget(to, ownerQQ)) {
        stats.allowed++
        stats.passThrough++
        return { action: 'allow', reason: 'out-of-scope', cause, managed: false }
      }

      // 3) pass 档：旧行为直发
      if (tier === 'pass') {
        stats.allowed++
        stats.passThrough++
        return { action: 'allow', reason: 'tier-pass', cause, managed: false }
      }

      // 4)/5) gate / broker
      const picked = pickSource()
      if (!picked.policy) {
        if (picked.missing) {
          // 显式选了某个策略源但它没注册：视为「有策略源但不可用」→ deny，不能悄悄 pass
          stats.denied++
          return { action: 'deny', reason: 'policy-error', cause, managed: false }
        }
        // 完全没有策略源（两引擎都没启用）→ allow 但未纳管
        stats.allowed++
        stats.passThrough++
        return { action: 'allow', reason: 'no-policy-source', cause, managed: false }
      }
      if (!picked.ready) {
        // 有策略源但非 ready → deny，绝不静默 pass（契约 L79）
        stats.denied++
        return { action: 'deny', reason: 'policy-error', cause, managed: true, policy: picked.name }
      }

      // 6) 交给策略源预占（同步）
      let reserved
      try {
        reserved = picked.policy.reserve({ to, sourceModule: moduleId, itemId, at })
      } catch (err) {
        stats.errors++
        log(`[outbound-policy] 策略源 reserve 抛错，按 policy-error 处理：${err && err.message ? err.message : err}`)
        stats.denied++
        return { action: 'deny', reason: 'policy-error', cause, managed: true, policy: picked.name }
      }
      if (!reserved || reserved.ok !== true || !reserved.reserveId) {
        const rawReason = reserved && reserved.reason ? String(reserved.reason) : 'error'
        const reason = RESERVE_REASONS.includes(rawReason) ? rawReason : 'error'
        stats.denied++
        return { action: 'deny', reason, cause, managed: true, policy: picked.name }
      }

      const reserveId = String(reserved.reserveId)

      // 7) broker 档 + 调用方允许 defer → 进账本排队
      if (tier === 'broker' && ask.allowDefer) {
        const deliveryId = makeId('dlv', at)
        const key = idempotentKey(moduleId, itemId, to, 'qq')
        supersede(key)
        putItem({
          deliveryId,
          moduleId,
          itemId,
          to,
          channel: 'qq',
          state: 'pending',
          at,
          updatedAt: at,
          ttl: LEDGER_TTL_MS,
          ownerQQ,
          cause,
          key,
          reserveId,
          policySource: picked.name,
        })
        reservations.set(reserveId, { policyName: picked.name, key, deliveryId })
        sweepExpired()
        trimLedger()
        saveLedger()
        stats.deferred++
        return { action: 'defer', reason: 'tier-broker', reserveId, deliveryId, cause, managed: true, policy: picked.name }
      }

      // 8) 正常放行：只留一份 reservation 供 commit/release。
      // 首版 gate 放行不入账（账本只服务 broker 排队与 api.proactive），避免与策略源重复记账。
      // tier 一并带回：模块包装层据此判断这条要不要走「代发决断」（broker 档的模块消息也要引擎过目）。
      const deliveryId = makeId('dlv', at)
      const key = idempotentKey(moduleId, itemId, to, 'qq')
      reservations.set(reserveId, { policyName: picked.name, key, deliveryId, deferred: false })
      stats.allowed++
      return { action: 'allow', reserveId, deliveryId, cause, managed: true, policy: picked.name, tier }
    } catch (err) {
      // 契约：任何意外都收敛成 deny，不抛
      stats.errors++
      log(`[outbound-policy] admit 异常已收敛为 deny：${err && err.message ? err.message : err}`)
      return { action: 'deny', reason: 'error', cause: 'background', managed: false }
    }
  }

  /** 内部：安全调用策略源 commit。 */
  function callCommit(policyName, reserveId, payload) {
    const p = sources.get(policyName)
    if (!p || typeof p.commit !== 'function') return { ok: false, reason: 'missing' }
    try {
      const r = p.commit(reserveId, payload)
      if (r && r.ok === false) return { ok: false, reason: String(r.reason || 'error') }
      return { ok: true }
    } catch (err) {
      stats.errors++
      log(`[outbound-policy] 策略源 commit 抛错：${err && err.message ? err.message : err}`)
      return { ok: false, reason: 'error' }
    }
  }

  /** 内部：安全调用策略源 release。uncertain 不退款（契约 L41）。 */
  function callRelease(policyName, reserveId, payload) {
    const p = sources.get(policyName)
    if (!p || typeof p.release !== 'function') return { ok: false, reason: 'missing' }
    try {
      const r = p.release(reserveId, payload)
      if (r && r.ok === false) return { ok: false, reason: String(r.reason || 'error') }
      return { ok: true }
    } catch (err) {
      stats.errors++
      log(`[outbound-policy] 策略源 release 抛错：${err && err.message ? err.message : err}`)
      return { ok: false, reason: 'error' }
    }
  }

  /**
   * 结算一次预占：把 reserve 转成终态。
   * outcome: 'sent' | 'queued' | 'uncertain' | 'failed'
   * uncertain 不退款（不调 release）；其余非 sent 走 release。
   */
  function commit(reserveId, payload = {}) {
    try {
      const id = String(reserveId ?? '')
      if (!id) return { ok: false, reason: 'invalid-reserve' }
      if (settled.has(id)) return { ok: false, reason: 'settled' }
      const res = reservations.get(id)
      if (!res) return { ok: false, reason: 'unknown-reserve' }

      const outcomeRaw = String(payload && payload.outcome ? payload.outcome : 'sent').toLowerCase()
      const outcome = ['sent', 'queued', 'uncertain', 'failed'].includes(outcomeRaw) ? outcomeRaw : 'failed'
      const deliveryId = payload && payload.deliveryId ? String(payload.deliveryId) : res.deliveryId
      const at = now()

      // 账本状态：sent -> sent；queued -> pending；uncertain -> uncertain；failed -> failed
      const item = getItem(deliveryId)
      if (item) {
        if (outcome === 'sent') setState(item, 'sent')
        else if (outcome === 'queued') setState(item, 'pending')
        else if (outcome === 'uncertain') setState(item, 'uncertain')
        else setState(item, 'failed', { failReason: String((payload && payload.reason) || 'commit-failed') })
      }

      let policyRes
      if (outcome === 'uncertain') {
        // 不确定 = 可能已经发出去了：告知策略源终态，**不退款**（契约 L41「uncertain 不退款」）
        policyRes = callCommit(res.policyName, id, { deliveryId, outcome })
      } else if (outcome === 'sent') {
        policyRes = callCommit(res.policyName, id, { deliveryId, outcome })
      } else {
        // queued / failed：只 commit，不在这里 release。
        // 契约 L41：failed 是否退款由策略源自定（purpose 生成额度不退款、逻辑发言额度退款；speakup 一律不退款），
        // 所以退款判断留在策略源的 commit(outcome) 里，宿主不代替它决定。
        policyRes = callCommit(res.policyName, id, { deliveryId, outcome })
      }

      reservations.delete(id)
      settled.set(id, { outcome, at })
      if (settled.size > 500) {
        // 只需要「重复调用返回 settled」，历史不必无限留：清最早的
        const first = settled.keys().next()
        if (!first.done) settled.delete(first.value)
      }
      stats.committed++
      if (item) saveLedger()
      return { ok: true, outcome, deliveryId, policy: res.policyName, policyResult: policyRes }
    } catch (err) {
      stats.errors++
      log(`[outbound-policy] commit 异常已收敛：${err && err.message ? err.message : err}`)
      return { ok: false, reason: 'error' }
    }
  }

  /**
   * 释放一次未发送的预占（退款）。
   * uncertain 不退款：若该 reserve 已 commit 成 uncertain，release 只能返回 settled。
   */
  function release(reserveId, payload = {}) {
    try {
      const id = String(reserveId ?? '')
      if (!id) return { ok: false, reason: 'invalid-reserve' }
      if (settled.has(id)) return { ok: false, reason: 'settled' }
      const res = reservations.get(id)
      if (!res) return { ok: false, reason: 'unknown-reserve' }

      const reason = String((payload && payload.reason) || 'released')
      // 账本：仍 pending 的排队条目置 dropped
      const item = getItem(res.deliveryId)
      if (item && item.state === 'pending') setState(item, 'dropped', { dropReason: reason })

      const policyRes = callRelease(res.policyName, id, { reason })
      reservations.delete(id)
      settled.set(id, { outcome: 'released', at: now() })
      stats.released++
      if (item) saveLedger()
      return { ok: true, reason, deliveryId: res.deliveryId, policy: res.policyName, policyResult: policyRes }
    } catch (err) {
      stats.errors++
      log(`[outbound-policy] release 异常已收敛：${err && err.message ? err.message : err}`)
      return { ok: false, reason: 'error' }
    }
  }

  // ── broker / feed 显式接入（api.proactive 底层） ────────────────────────

  /**
   * 显式提交一条主动发言到账本。
   * 契约：非 broker 档 → { deliveryId:null, state:'unsupported' }（不抛错，便于模块降级）。
   * 这是 background 语义（api.proactive 路径一律视为 background，契约 L88）。
   */
  /**
   * 显式接入（broker/feed）。宿主注入了投递器时，这个调用会**直接把内容发出去**
   * （返回的 state 已经是发送结果）；没注入时只落账，返回 pending 由模块自行跟进。
   *
   * 幂等：同 moduleId+itemId+to+channel 的旧 pending 条目会被新条目顶掉（supersede），
   * 所以模块即使重试提交同一件事，也不会重复打扰主人。
   */
  async function submit(input = {}, opts = {}) {
    try {
      stats.submitted++
      const at = Number.isFinite(input.at) ? Number(input.at) : now()
      const cfg = resolveConfig(getConfig)
      const tier = readTier(cfg)
      if (tier !== 'broker') return { deliveryId: null, state: 'unsupported' }

      const ownerQQ = ensureOwnerFresh(readOwnerQQ(cfg))
      const moduleId = String(input.moduleId ?? '')
      const itemId = String(input.itemId ?? '')
      const to = normalizeTarget(input.to)
      const channel = String(input.channel ?? 'qq')
      const text = input.text === null || input.text === undefined ? '' : String(input.text)
      const link = input.link === null || input.link === undefined ? null : String(input.link)

      // 治理范围外（非 owner 私聊）：仍然记账但不参与治理
      const managed = isGovernedTarget(to, ownerQQ)

      // 单条文本 8KB 上限：超限直接拒绝落账（不抛错）
      if (textBytes(text) > MAX_TEXT_BYTES) return { deliveryId: null, state: 'too-large' }

      const key = idempotentKey(moduleId, itemId, to, channel)
      supersede(key) // 同源合并：旧 pending 置 dropped(superseded)

      // 治理范围内的主动私聊要先过策略门闸：不通过就别落账、更别投递。
      // 这是 broker 档的核心语义——模块「显式接入」不等于「可以绕过决策」，
      // 只是把投递交出来由宿主统筹。过不了就明确告诉模块（dropped + 原因），
      // 让它可以据此重试或放弃，而不是以为提交成功。
      // hostDelegate=true（模块打包层把 broker 档的快捷发送改交给宿主）时跳过这里：
      // 宿主投递器内部自己做审查预占（reserveReview，不占引擎说话额度、不看排程），
      // 再走一次 admit 会把「代发不占她额度」的口径打回去、还会二次扣额度。
      if (managed && opts.hostDelegate !== true) {
        const verdict = admit({ to, moduleId, origin: 'module', cause: input.cause || { kind: 'background' }, itemId, at, allowDefer: true })
        if (verdict.action !== 'allow' && verdict.action !== 'defer') {
          stats.denied++
          return { deliveryId: null, state: 'dropped', reason: verdict.reason || 'denied' }
        }
        // gate/broker 档：把预占挂在条目上，投递成功/失败时结算
        reservedByItem.set(key, verdict)
      }

      const deliveryId = makeId('dlv', at)
      putItem({
        deliveryId,
        moduleId,
        itemId,
        to,
        channel,
        text,
        link,
        state: 'pending',
        at,
        updatedAt: at,
        ttl: LEDGER_TTL_MS,
        ownerQQ,
        cause: 'background',
        key,
        managed,
        supersededKey: key,
      })
      sweepExpired()
      trimLedger()
      saveLedger()
      // 宿主注入了投递器就直接发：模块只调 submit，不必自己管投递与状态流转
      // （设计稿 §7 的「feed 语义」）。没注入时保持只记账，模块按 statusOf 自行跟进。
      if (deliverer) {
        const done = awaitDeliver(deliveryId)
        return done
      }
      return { deliveryId, state: 'pending' }
    } catch (err) {
      stats.errors++
      log(`[outbound-policy] submit 异常已收敛：${err && err.message ? err.message : err}`)
      return { deliveryId: null, state: 'error' }
    }
  }

  /**
   * 把已落账的条目真正发出去，并把账本状态推进到位：
   * pending → sending → sent / failed / uncertain。
   *
   * 返回体给调用方（模块）用：模块只需要判断 `state` 是否算发出去了，
   * 不必自己关心发送、超时、状态回写这些事——这就是「不给模块加负担」的落点。
   * 失败与结果未明的区分沿用 hub 的口径：明确失败（开关关着/试运行/参数非法）算 failed，
   * 网关超时这种「不知道发没发出去」算 uncertain，且不重试（避免重复打扰）。
   */
  function deliverItem(item) {
    if (!item) return { deliveryId: null, state: 'unknown' }
    if (!deliverer) return { deliveryId: item.deliveryId, state: item.state }
    setState(item, 'sending')
    saveLedger()
    let result
    try {
      result = deliverer(item.to, item.text, { link: item.link, item })
    } catch (err) {
      // 同步抛错：这里**不能**一律当「明确失败」。投递器同步抛出的多半是网关/参数问题，
      // 其中超时、断线这类「可能已经发出去了」必须算 uncertain（不退款、不重试），
      // 否则会当作失败再发一遍，造成重复打扰。判据与异步分支共用一套。
      return finishDeliverError(item, err)
    }
    // 异步结果：投递器返回 Promise 时等它；返回普通值也照常处理
    if (result && typeof result.then === 'function') {
      return result.then((r) => finishDeliver(item, r), (err) => finishDeliverError(item, err))
    }
    return finishDeliver(item, result)
  }

  /** 投递成功/明确失败的收尾。 */
  function finishDeliver(item, result) {
    // 投递器的约定：返回真值 = 已发出；返回 null/undefined/false = 没发出去。
    // 抛错且是「结果不确定」类（超时/断线）由 finishDeliverError 处理。
    if (result) {
      setState(item, 'sent')
      stats.committed++
    } else {
      setState(item, 'failed', { dropReason: 'deliverer-returned-falsey' })
      stats.committed++
    }
    saveLedger()
    settleForItem(item)
    return { deliveryId: item.deliveryId, state: item.state }
  }

  /** 投递抛错的收尾：区分「明确失败」与「结果未明」，未明的不重试也不退款。 */
  function finishDeliverError(item, err) {
    const message = String(err && err.message ? err.message : err).slice(0, 200)
    const uncertain = /超时|timeout|timed out|abort|ECONNRESET|断线|not connected|未连接/i.test(message)
    setState(item, uncertain ? 'uncertain' : 'failed', { dropReason: message })
    saveLedger()
    stats.committed++
    settleForItem(item)
    log(`[outbound-policy] 投递${uncertain ? '结果未明' : '失败'}（${item.deliveryId}）：${message}`)
    return { deliveryId: item.deliveryId, state: item.state }
  }

  /**
   * 条目投递完成后结算它挂着的门闸预占。
   * uncertain 一律按 uncertain 结算（不退款、不重试），与设计稿 §4 一致。
   */
  function settleForItem(item) {
    if (!item || !item.key) return
    const verdict = reservedByItem.get(item.key)
    if (!verdict) return
    reservedByItem.delete(item.key)
    if (!verdict.reserveId) return
    try {
      const outcome = item.state === 'sent' ? 'sent' : item.state === 'uncertain' ? 'uncertain' : 'failed'
      commit(verdict.reserveId, { deliveryId: item.deliveryId, outcome })
    } catch (err) {
      log(`[outbound-policy] 结算预占失败（${item.deliveryId}）：${err && err.message ? err.message : err}`)
    }
  }

  /** submit 内部用：发一条刚落账的条目并返回结果。 */
  function awaitDeliver(deliveryId) {
    return deliverItem(getItem(deliveryId))
  }

  /**
   * 异步补发：把账本里 pending 的条目重新尝试一遍（宿主可选调用，例如启动后恢复）。
   * 只处理 pending，且**不改约**：过了 TTL 的已经被 sweepExpired 置 expired，不会发出去。
   * 同一 deliveryId 不会被重复投递（发送前先置 sending）。
   */
  function flushPending(limit = 20) {
    if (!deliverer) return { ok: true, flushed: 0, skipped: 0 }
    sweepExpired()
    const list = ledgerArray().filter((it) => it.state === 'pending').slice(0, Math.max(1, Number(limit) || 20))
    for (const it of list) deliverItem(it)
    saveLedger()
    return { ok: true, flushed: list.length, skipped: 0 }
  }

  /**
   * 注入/替换实际投递函数（宿主在 hub 装配好之后调用）。
   * 传 null 可撤销（回到「只记账不投递」的旧行为，测试与降级用）。
   * 投递函数签名：(to, text, { link, item }) → 真值/Promise<真值> 表示已发出。
   */
  function setDeliverer(fn) {
    deliverer = typeof fn === 'function' ? fn : null
    return deliverer !== null
  }

  /** 查一条投递的状态。 */
  function statusOf(deliveryId) {
    try {
      const it = getItem(deliveryId)
      if (!it) return { deliveryId: deliveryId === null || deliveryId === undefined ? null : String(deliveryId), state: 'unknown' }
      return {
        deliveryId: it.deliveryId,
        state: it.state,
        at: it.at,
        updatedAt: it.updatedAt,
        moduleId: it.moduleId,
        itemId: it.itemId,
        to: it.to,
        channel: it.channel,
        cause: it.cause,
        managed: it.managed !== false,
        ttl: it.ttl,
        dropReason: it.dropReason ?? null,
      }
    } catch (err) {
      stats.errors++
      return { deliveryId: null, state: 'unknown' }
    }
  }

  /** 账本快照（面板用），按 at 升序。 */
  function ledgerSnapshot() {
    try {
      const dirty = sweepExpired()
      if (dirty) saveLedger()
      return ledgerArray().map((it) => ({ ...it }))
    } catch (err) {
      stats.errors++
      log(`[outbound-policy] ledgerSnapshot 异常已收敛：${err && err.message ? err.message : err}`)
      return []
    }
  }

  /** 面板/日志读状态。 */
  function status() {
    try {
      const cfg = resolveConfig(getConfig)
      const tier = readTier(cfg)
      // 惰性比对主人身份：变了先把旧 pending 作废，面板与判定口径一致
      ensureOwnerFresh(readOwnerQQ(cfg))
      const picked = pickSource()
      const sourcesOut = {}
      for (const [name, p] of sources.entries()) {
        // 原因文本：设计稿 §8.1 要求面板能显示「为什么不在正常状态」。
        // 策略源按需提供 lastReason（最近一次拒绝的 reason 键）或 stateReason（当前态原因描述）；
        // 注意 reasonText(reason) 是「键→中文」的翻译函数，不能无参调用，所以这里不碰它。
        // 两者都没有就如实给 null，不编造。
        let reason = null
        try {
          const cur = p.stateReason !== null && p.stateReason !== undefined ? String(p.stateReason).trim() : ''
          const last = p.lastReason !== null && p.lastReason !== undefined ? String(p.lastReason).trim() : ''
          if (cur) reason = cur
          else if (last) reason = typeof p.reasonText === 'function' ? String(p.reasonText(last) || last) : last
        } catch (err) {
          stats.errors++
          log(`[outbound-policy] 策略源「${name}」取原因文本出错：${err && err.message ? err.message : err}`)
        }
        sourcesOut[name] = { state: stateOf(p), reason }
      }
      // 账本统计前先做一次 TTL 与上限维护（只读调用也不该返回脏数据）
      if (sweepExpired()) saveLedger()
      if (trimLedger()) saveLedger()
      const byState = {}
      for (const s of KNOWN_STATES) byState[s] = 0
      for (const it of items.values()) {
        byState[it.state] = (byState[it.state] || 0) + 1
      }
      let pending = 0
      for (const it of items.values()) if (it.state === 'pending') pending++
      const managed = tier !== 'pass' && Boolean(picked.policy) && Boolean(picked.ready)
      return {
        tier,
        activePolicy: effectiveActiveName(),
        activeMode,
        sources: sourcesOut,
        managed,
        stats: { ...stats },
        ledger: { pending, byState },
      }
    } catch (err) {
      stats.errors++
      log(`[outbound-policy] status 异常已收敛：${err && err.message ? err.message : err}`)
      return {
        tier: DEFAULT_TIER,
        activePolicy: null,
        activeMode,
        sources: {},
        managed: false,
        stats: { ...stats },
        ledger: { pending: 0, byState: {} },
      }
    }
  }

  // ── 供 hub/modules 复用的辅助面（契约 L102/L108 的接线基石） ────────────

  /**
   * ownerQQ 变更时调用：把旧主人的 pending 全部置 dropped。
   * 返回被作废的条数。
   * （内部每次 admit/submit/status 前都会自动比对一次，见 ensureOwnerFresh）
   */
  function syncOwnerQQ(ownerQQIn) {
    try {
      const ownerQQ = ownerQQIn === undefined ? readOwnerQQ(resolveConfig(getConfig)) : String(ownerQQIn ?? '')
      let changed = 0
      for (const it of items.values()) {
        if (it.state !== 'pending') continue
        if (String(it.ownerQQ ?? '') === ownerQQ) continue
        setState(it, 'dropped', { dropReason: 'owner-changed' })
        it.ownerQQ = ownerQQ
        changed++
      }
      lastOwnerQQ = ownerQQ
      if (changed) saveLedger()
      return changed
    } catch (err) {
      stats.errors++
      log(`[outbound-policy] syncOwnerQQ 异常已收敛：${err && err.message ? err.message : err}`)
      return 0
    }
  }

  /**
   * 每次对外调用前比对一次主人身份：变了就把旧 pending 作废（契约 L96）。
   * 首版没有配置变更事件总线，用「读配置时惰性比对」实现，语义等价且零额外依赖。
   * @param {string} [ownerQQ] 已读到的主人 QQ（省一次 getConfig）
   */
  function ensureOwnerFresh(ownerQQ) {
    const qq = ownerQQ === undefined ? readOwnerQQ(resolveConfig(getConfig)) : ownerQQ
    if (qq !== lastOwnerQQ) syncOwnerQQ(qq)
    return qq
  }

  /**
   * 模块卸载：把该模块的 pending 置 dropped。
   * 返回被作废的条数。
   */
  function dropModule(moduleId) {
    try {
      const name = String(moduleId ?? '')
      const changed = dropPending((it) => it.moduleId === name, 'module-unloaded')
      if (changed) saveLedger()
      return changed
    } catch (err) {
      stats.errors++
      return 0
    }
  }

  // 初始化时同步一次主人状态（历史账本可能属于旧 ownerQQ）
  syncOwnerQQ()

  /**
   * 目标是否在治理范围内（= owner 私聊）。给模块包装层判断「要不要改走宿主代发」用：
   * 模块层拿不到配置也没关系，服务的 getConfig 里就有 ownerQQ。
   */
  function isGoverned(to) {
    try {
      const cfg = resolveConfig(getConfig)
      const ownerQQ = ensureOwnerFresh(readOwnerQQ(cfg))
      return isGovernedTarget(normalizeTarget(to), ownerQQ)
    } catch {
      return false
    }
  }

  return {
    // 策略源
    registerPolicySource,
    unregisterPolicySource,
    setActivePolicy,
    status,
    isGoverned,
    // 核心判定
    admit,
    commit,
    release,
    // broker / feed
    submit,
    statusOf,
    ledgerSnapshot,
    // 宿主投递器与补发（可选能力：注入投递器后 submit 会自己发，模块零负担）
    setDeliverer,
    flushPending,
    // 辅助
    syncOwnerQQ,
    dropModule,
  }
}

export default createOutboundPolicy
