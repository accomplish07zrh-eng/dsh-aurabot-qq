// token 用量与花费：按「每次调用一行」存，读的时候再聚合（口径参考 qq-agent-plus）。
//
// 一行 = { at, module, chat, model, provider, in, out, cached }
//   module   记账模块：聊天 / 后台会话 / 记忆 / 日记 / 心情 / 目的引擎……
//   chat     哪个聊天（group:123 / private:456 / system:xxx）；后台任务的 ask 没有这个
//   model    这次实际用的模型（拿不到就空着，按默认价估）
//   in/out   prompt / completion tokens；cached = 其中命中前缀缓存的输入
// 只记数字，不记聊天内容；按北京时间分天，保留 90 天。

import { dataDir, readJson, writeJson } from './store.js'
import { beijingDayKey, isPeak } from './offpeak.js'

export const KEEP_DAYS = 90
const SAVE_DELAY = 1500
const DAY_MS = 86_400_000

// 价目表（元 / 百万 tokens）。单位、口径和 qq-agent-plus 的 prices.json 一致。
//
// 来源（2026-11-06 抓的）：
//   · DeepSeek：官方定价页（元/百万，空闲价；peak 是高峰价，北京时间周一~周五 9:00-12:00、
//     14:00-18:00，周末和法定节假日算空闲）
//   · 其它厂商：LiteLLM 维护的 model_prices_and_context_window.json（USD/百万），按 1 USD = 7.2 元
//     折成人民币；这些厂商没有峰谷价，所以不写 peak。
// 匹配：先按模型的完整名字找同名条目，找不到就按定义顺序试每条的 match 正则（不区分大小写）。
// 认不出来的模型 = 未定价（面板里单列，不计花费）——想加自己的价，在 config.usage.pricing.models
// 里补一条即可（match 写成字符串形式的正则，例如 "^my-llm-"）。
export const DEFAULT_PRICING = {
  currency: '元',
  fx: 7.2, // 美元价 → 人民币用的汇率，只影响下面按 USD 收录的条目
  models: {
    // ── DeepSeek（官方价，带峰谷）───────────────────────────────
    'deepseek-pro': { match: 'deepseek.*pro|v4-pro', in: 4.5, out: 13.5, cached: 0.15, peak: { in: 9, out: 27, cached: 0.3 }, note: '官方价，峰时翻倍' },
    'deepseek-flash': { match: 'deepseek', in: 1, out: 4, cached: 0.02, peak: { in: 2, out: 8, cached: 0.04 }, note: '官方价，峰时翻倍' },
    // ── OpenAI（USD 折元）─────────────────────────────────────
    'gpt-5.6': { match: 'gpt-5\\.6', in: 28.8, out: 144, cached: 2.88 },
    'gpt-5.5': { match: 'gpt-5\\.5', in: 36, out: 216, cached: 3.6 },
    'gpt-5.4': { match: 'gpt-5\\.4', in: 18, out: 108, cached: 1.8 },
    'gpt-5.2': { match: 'gpt-5\\.2', in: 12.6, out: 100.8, cached: 1.26 },
    'gpt-5': { match: 'gpt-5', in: 9, out: 72, cached: 0.9 },
    'gpt-4.1': { match: 'gpt-4\\.1', in: 14.4, out: 57.6, cached: 3.6 },
    'gpt-4o-mini': { match: 'gpt-4o-mini', in: 1.08, out: 4.32, cached: 0.54 },
    'gpt-4o': { match: 'gpt-4o', in: 18, out: 72, cached: 9 },
    // ── Anthropic ────────────────────────────────────────────
    'claude-opus': { match: 'claude.*opus', in: 36, out: 180, cached: 3.6 },
    'claude-sonnet': { match: 'claude.*sonnet', in: 21.6, out: 108, cached: 2.16 },
    'claude-haiku': { match: 'claude.*haiku', in: 7.2, out: 36, cached: 0.72 },
    // ── Google Gemini ────────────────────────────────────────
    'gemini-3.1-pro': { match: 'gemini-3(\\.1)?-pro', in: 14.4, out: 86.4, cached: 1.44 },
    'gemini-3-flash': { match: 'gemini-3.*flash', in: 3.6, out: 21.6, cached: 0.36 },
    'gemini-2.5-pro': { match: 'gemini-2\\.5-pro', in: 9, out: 72, cached: 0.9 },
    'gemini-2.5-flash': { match: 'gemini-2\\.5-flash', in: 2.16, out: 18, cached: 0.22 },
    // ── 月之暗面 Kimi ─────────────────────────────────────────
    'kimi-k3': { match: 'kimi-k3|moonshot.*k3', in: 21.6, out: 108, cached: 2.16 },
    'kimi-k2.6': { match: 'kimi-k2\\.6', in: 6.84, out: 28.8, cached: 1.15 },
    'kimi-k2.5': { match: 'kimi-k2\\.5', in: 4.32, out: 21.6, cached: 0.72 },
    'kimi': { match: 'kimi|moonshot', in: 6.84, out: 28.8, cached: 1.15 },
    // ── 智谱 GLM ─────────────────────────────────────────────
    'glm-5.3': { match: 'glm-5\\.3(?!-flash)', in: 8.23, out: 28.8, cached: 2.06 },
    'glm-5-flash': { match: 'glm-5.*flash', in: 0.82, out: 2.88, cached: 0.24 },
    'glm-4': { match: 'glm-4', in: 4.32, out: 15.84, cached: 0.86 },
    // ── 阿里通义千问 ──────────────────────────────────────────
    'qwen-max': { match: 'qwen.*max', in: 12.17, out: 36.5, cached: 1.22 },
    'qwen-plus': { match: 'qwen.*plus', in: 2.03, out: 8.12, cached: 0.41 },
    'qwen-flash': { match: 'qwen.*flash', in: 0.81, out: 2.74, cached: 0.1 },
    'qwen': { match: 'qwen', in: 2.03, out: 8.12, cached: 0.41 },
    // ── 字节豆包 ─────────────────────────────────────────────
    'doubao-pro': { match: 'doubao.*(pro|seed-2-0-pro)', in: 3.47, out: 17.36, cached: 0.69 },
    'doubao': { match: 'doubao', in: 0.65, out: 3.91, cached: 0.13 },
    // ── 其它常见开源/国产 ─────────────────────────────────────
    'minimax': { match: 'minimax', in: 2.13, out: 8.52, cached: 0.43 },
    'ernie': { match: 'ernie', in: 4.06, out: 18.25, cached: 4.06 },
    'step': { match: 'step-', in: 1.58, out: 9.5, cached: 0.32 },
  },
}

// 旧行没记模型名时按这个估（他们当时只用过 DeepSeek flash）
const ASSUMED_MODEL = 'deepseek-flash'

let state = null // { days: { 'YYYY-MM-DD': [row, ...] } }
let pricing = DEFAULT_PRICING
let holidays = []
let saveTimer = null

const file = () => dataDir('usage.json')
const dayKey = (at) => beijingDayKey(Number(at || Date.now()))

const reCache = new Map()
/** 条目里的 match 是字符串形式的正则（这样 config.json 里也能加），编译一次缓存起来。 */
function matches(entry, name) {
  if (!entry || !entry.match) return false
  let re = reCache.get(entry.match)
  if (re === undefined) {
    try { re = new RegExp(entry.match, 'i') } catch (error) { re = null }
    reCache.set(entry.match, re)
  }
  return Boolean(re && re.test(name))
}

/** 找模型对应的价目：先同名，再按定义顺序试 match；都认不出返回 null（= 未定价）。 */
function priceEntry(p, model) {
  const name = String(model || '').trim().toLowerCase()
  if (!name) return null
  if (p.models[name]) return p.models[name]
  for (const entry of Object.values(p.models)) if (matches(entry, name)) return entry
  return null
}

/** 一次调用的单价（按时刻区分峰谷，只有写了 peak 的（DeepSeek）才有峰谷价）；未定价返回 null。 */
export function priceOf(model, at = Date.now(), p = pricing) {
  const entry = priceEntry(p, model)
  if (!entry) return null
  const usePeak = Boolean(isPeak(at, { holidays })) && entry.peak
  const src = usePeak ? entry.peak : entry
  return { in: Number(src.in) || 0, out: Number(src.out) || 0, cached: Number(src.cached) || 0, peak: Boolean(usePeak) }
}

// 记账用的模块名：模块 id → 中文；system:xxx 的后台轮次标成「xxx（后台）」
const MODULE_LABELS = {
  memory: '记忆', mood: '心情', diary: '空间日记', purpose: '目的引擎', 'purpose-nudge': '目的引擎（追问）',
  stickers: '表情包', imagegen: '生图', bili: '刷 B 站', heybox: '刷小黑盒', douyin: '刷抖音', video: '生视频',
  voice: '语音', song: '翻唱', pet: '桌宠', profile: '改资料', contacts: '好友申请',
  'qq-tools': 'QQ 工具', 'qq-api': 'QQ 接口', 'group-admin': '群管', 'qzone-social': '空间互动',
  speakup: '主动搭话', bridge: '联动接口', 'bili-vision': 'B 站看画面', persona: '人格生成', 'model-ping': '模型测试', background: '其他后台任务',
}

/**
 * 把「聊天 id」或「模块 id」变成记账用的名字。
 *   group:123 / private:456 → 聊天
 *   system:diary / system:bili → 空间日记（后台）/ 刷 B 站（后台）
 *   memory / mood / … → 记忆 / 心情 …
 */
export function moduleLabel(key) {
  const s = String(key || '').trim()
  if (!s) return '其他后台任务'
  if (s.startsWith('system:')) {
    const id = s.slice(7).replace(/^ext-/, '')
    return (MODULE_LABELS[id] || id) + '（后台）'
  }
  if (s.startsWith('group:') || s.startsWith('private:')) return '聊天'
  return MODULE_LABELS[s] || s
}

// 分不出来的就一律记「其他后台任务」，别在主表里摊成一堆看不懂的名字：
//   「后台任务」/「后台会话」/「其它后台」/ 空 → 其他后台任务
//   （打标签之前那批带模型名的 askModel 调用回查下来是记忆模块，单独给个「记忆（回查）」）
export const OTHER_BACKGROUND = '其他后台任务'
const LEGACY_MODULES = {
  后台任务: OTHER_BACKGROUND,
  后台会话: OTHER_BACKGROUND,
  其它后台: OTHER_BACKGROUND,
  其他后台: OTHER_BACKGROUND,
  '旧数据（未分模块）': OTHER_BACKGROUND, // 之前那版归置时写进文件的，统一收回来
}

/** 一行记录该归到哪个模块名下（兼容旧标签；认不出的一律「其他后台任务」）。 */
export function moduleOf(row) {
  const m = String(row?.module || '').trim()
  if (!m) return OTHER_BACKGROUND
  if ((m === '后台任务' || m === '后台会话') && row?.model) return '记忆（回查）'
  return LEGACY_MODULES[m] || m
}

/**
 * 一次调用的花费（元）：新输入 / 缓存命中 / 输出三段分开算，峰谷按时刻取价。
 *
 * ⚠️ 字段口径（2026-11-06 对着 DSH 的会话投影核对）：DSH 上报的 usage.inputTokens 是
 * **未命中缓存的**输入，命中前缀缓存那部分单独在 cacheReadTokens 里（投影里两个字段就是
 * uncachedInputTokens / cacheReadTokens，实测后者能是前者的几十倍）。
 * 所以总输入 = inputTokens + cacheReadTokens，命中率按这两者算；早先按「input 含缓存」
 * 算会把命中率算成 100%、未命中算成 0，花费也少算一大截。
 * @returns {{cost:number, fresh:number, cached:number, output:number, unpriced:boolean, peak:boolean}}
 */
export function costOf(row, at = row?.at) {
  const fresh = Number(row?.in) || 0
  const out = Number(row?.out) || 0
  const cached = Number(row?.cached) || 0
  // 没记模型名的（旧版本记下来的行）按默认模型估，别让它变成「未定价」白用 token；真认不出的模型名仍算未定价
  const price = priceOf(String(row?.model || '').trim() || ASSUMED_MODEL, at)
  if (!price) return { cost: 0, fresh: 0, cached: 0, output: 0, unpriced: true, peak: false }
  const freshCost = (fresh / 1_000_000) * price.in
  const cachedCost = (cached / 1_000_000) * price.cached
  const outputCost = (out / 1_000_000) * price.out
  return { cost: freshCost + cachedCost + outputCost, fresh: freshCost, cached: cachedCost, output: outputCost, unpriced: false, peak: price.peak }
}

function emptyTotals() {
  return {
    runs: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0,
    cost: 0, peakCost: 0, offPeakCost: 0, peakTokens: 0,
    freshCost: 0, cachedCost: 0, outputCost: 0,
    unpricedCalls: 0, unpricedTokens: 0, assumedCalls: 0,
  }
}

/** 把一批调用行汇总成面板要的数字。 */
function totalsOf(rows) {
  const t = emptyTotals()
  const unpricedModels = new Map()
  for (const r of rows) {
    // inputTokens 是未命中缓存的输入，命中那部分在 cached 里 —— 总输入要把两段加起来
    const fresh = Number(r.in) || 0
    const out = Number(r.out) || 0
    const cached = Number(r.cached) || 0
    const prompt = fresh + cached
    const tk = prompt + out
    const c = costOf(r)
    t.runs += 1
    t.promptTokens += prompt
    t.completionTokens += out
    t.cachedTokens += cached
    t.totalTokens += tk
    t.cost += c.cost
    t.freshCost += c.fresh
    t.cachedCost += c.cached
    t.outputCost += c.output
    if (c.peak) { t.peakCost += c.cost; t.peakTokens += tk } else t.offPeakCost += c.cost
    if (!String(r.model || '').trim()) t.assumedCalls += 1
    if (c.unpriced) {
      t.unpricedCalls += 1
      t.unpricedTokens += tk
      const key = r.model || '（未知模型）'
      const cur = unpricedModels.get(key) || { model: key, calls: 0, tokens: 0 }
      cur.calls += 1
      cur.tokens += tk
      unpricedModels.set(key, cur)
    }
  }
  t.cacheHitRate = t.promptTokens ? Math.min(1, t.cachedTokens / t.promptTokens) : 0
  t.peakRatio = t.totalTokens ? t.peakTokens / t.totalTokens : 0
  t.unpricedModels = [...unpricedModels.values()].sort((a, b) => b.tokens - a.tokens)
  return t
}

/** 按某个字段分组后各自汇总（按花费从大到小）。 */
function groupBy(rows, field, limit = 0) {
  const map = new Map()
  for (const r of rows) {
    const key = String(r[field] || '（未知）')
    const list = map.get(key) || []
    list.push(r)
    map.set(key, list)
  }
  let out = [...map.entries()].map(([key, list]) => ({ key, ...totalsOf(list) }))
  out.sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens)
  if (limit > 0) out = out.slice(0, limit)
  return out
}

function prune() {
  const cut = dayKey(Date.now() - (KEEP_DAYS - 1) * DAY_MS)
  for (const k of Object.keys(state.days)) if (k < cut) delete state.days[k]
}

function saveSoon() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try { writeJson(file(), state) } catch (error) {}
  }, SAVE_DELAY)
  saveTimer.unref?.()
}

/**
 * 启动时调一次：把已经存下来的用量读进内存。
 * @param {object} [override] 价格表覆盖（config.usage.pricing）
 * @param {string[]} [holidayList] 中国法定节假日（config.cost.offPeakHolidays）——整天算空闲价
 */
export function initUsage(override, holidayList) {
  const raw = readJson(file(), {})
  const days = raw && typeof raw.days === 'object' && raw.days ? raw.days : {}
  // 老版本存的是「天 → 模块 → 累计 tokens」，读到就按调用次数摊成行，别丢数据
  for (const [day, v] of Object.entries(days)) {
    if (Array.isArray(v)) continue
    const rows = []
    for (const [module, b] of Object.entries(v || {})) {
      const calls = Math.max(1, Number(b?.calls) || 1)
      rows.push({
        at: Date.parse(day + 'T00:00:01+08:00') || Date.now(),
        module,
        chat: '',
        model: '',
        provider: '',
        in: Math.round((Number(b?.in) || 0) / calls),
        out: Math.round((Number(b?.out) || 0) / calls),
        cached: Math.round((Number(b?.hit) || 0) / calls),
      })
    }
    if (rows.length) days[day] = rows
  }
  state = { days }
  holidays = Array.isArray(holidayList) ? holidayList : []
  pricing = override && typeof override === 'object'
    ? { ...DEFAULT_PRICING, ...override, models: { ...DEFAULT_PRICING.models, ...(override.models || {}) } }
    : DEFAULT_PRICING
  return state
}

/**
 * 记一次模型调用。
 * @param {{module?:string, chat?:string, provider?:string, model?:string, usage?:object, at?:number}} o
 *        usage 就是模型流 / session 事件里那块 { inputTokens, outputTokens, cacheReadTokens }
 */
export function recordUsage({ module = '其它', chat = '', provider = '', model = '', usage, at = Date.now() } = {}) {
  if (!state || !usage) return null
  const prompt = Number(usage.inputTokens) || 0
  const out = Number(usage.outputTokens) || 0
  if (!prompt && !out) return null
  const row = {
    at: Number(at) || Date.now(),
    module,
    chat: String(chat || ''),
    provider: String(provider || ''),
    model: String(model || ''),
    in: prompt,
    out,
    cached: Number(usage.cacheReadTokens) || 0,
  }
  const day = dayKey(row.at)
  ;(state.days[day] || (state.days[day] = [])).push(row)
  prune()
  saveSoon()
  return row
}

function rowsBetween(startMs, endMs) {
  const out = []
  for (const [day, rows] of Object.entries(state?.days || {})) {
    const dayStart = Date.parse(day + 'T00:00:00+08:00')
    if (!Number.isFinite(dayStart) || dayStart > endMs || dayStart + DAY_MS <= startMs) continue
    for (const r of rows) if (r.at >= startMs && r.at <= endMs) out.push(r)
  }
  return out
}

/**
 * 面板要的汇总：ranges 只给总量（今日 / 昨日 / 近 7 天 / 近 30 天），
 * current 给所选区间 + 模块 / 聊天 / 模型三个维度的明细。
 * @param {{now?:number, range?:'today'|'yesterday'|'7'|'30'|'all'}} o
 */
export function usageReport({ now = Date.now(), range = '7' } = {}) {
  const todayStart = Date.parse(dayKey(now) + 'T00:00:00+08:00')
  const slim = (t) => ({
    runs: t.runs,
    promptTokens: t.promptTokens,
    completionTokens: t.completionTokens,
    cachedTokens: t.cachedTokens,
    totalTokens: t.totalTokens,
    cost: t.cost,
    cacheHitRate: t.cacheHitRate,
  })
  const pick = String(range || '7')
  const start = pick === 'today' ? todayStart
    : pick === 'yesterday' ? todayStart - DAY_MS
      : pick === '30' ? todayStart - 29 * DAY_MS
        : pick === 'all' ? 0
          : todayStart - 6 * DAY_MS
  const end = pick === 'yesterday' ? todayStart - 1 : now
  const rows = rowsBetween(start, end)
  return {
    currency: pricing.currency || '元',
    peak: Boolean(isPeak(now, { holidays })),
    days: KEEP_DAYS,
    range: pick,
    ranges: {
      today: slim(totalsOf(rowsBetween(todayStart, now))),
      yesterday: slim(totalsOf(rowsBetween(todayStart - DAY_MS, todayStart - 1))),
      last7: slim(totalsOf(rowsBetween(todayStart - 6 * DAY_MS, now))),
      last30: slim(totalsOf(rowsBetween(todayStart - 29 * DAY_MS, now))),
    },
    current: {
      ...totalsOf(rows),
      byModule: groupBy(rows.map((r) => ({ ...r, module: moduleOf(r) })), 'module'),
      byChat: groupBy(rows, 'chat', 12),
      byModel: groupBy(rows, 'model'),
    },
  }
}
