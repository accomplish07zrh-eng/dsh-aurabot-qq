// DeepSeek 峰谷定价：判断「现在是不是峰时」，给后台模型调用让路（默认关，主人手动开）。
//
// 官方规则（2026-11-02 核对）：峰时 = UTC 01:00–04:00、06:00–10:00 的周一~周五（不含中国法定节假日，
// 周末和法定节假日全天谷价）。换成北京时间就是工作日 09:00–12:00、14:00–18:00。
//
// 这里只做纯计算，不依赖时区库：统一按固定 UTC+8 算北京时间（中国无夏令时）。
// 注意「周一~周五 / 节假日」看的是北京时间的日期，峰/谷的小时看的是 UTC 小时——两套口径叠加。

const TZ_OFFSET_MS = 8 * 3600_000 // 北京时间 = UTC+8
const DAY_MS = 86400_000

/** UTC 毫秒 → 北京时间的日期字段（用 getUTC* 读，避免宿主时区影响）。 */
function beijingParts (ms) {
  const d = new Date(ms + TZ_OFFSET_MS)
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay() }
}

const pad = (n) => String(n).padStart(2, '0')

/** UTC 毫秒 → 北京时间日期 'YYYY-MM-DD'。 */
export function beijingDayKey (ms) {
  const p = beijingParts(Number(ms))
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`
}

/** date 参数容错：Date / 毫秒时间戳都接受；非法值返回 NaN。 */
function toMs (date) {
  if (date instanceof Date) return date.getTime()
  if (typeof date === 'number') return date
  return Number(date)
}

function holidaySet (holidays) {
  const out = new Set()
  if (!Array.isArray(holidays)) return out
  for (const h of holidays) {
    const s = String(h ?? '').trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) out.add(s)
  }
  return out
}

/**
 * 现在是不是 DeepSeek 峰时。
 * @param {Date|number} [date] 默认现在
 * @param {{holidays?: string[]}} [opts] holidays：北京时间日期 'YYYY-MM-DD'（中国法定节假日，全天谷价）
 * @returns {boolean}
 */
export function isPeak (date = new Date(), { holidays = [] } = {}) {
  const ms = toMs(date)
  if (!Number.isFinite(ms)) return false
  const p = beijingParts(ms)
  if (p.dow === 0 || p.dow === 6) return false // 周六 / 周日：全天谷价
  if (holidaySet(holidays).has(beijingDayKey(ms))) return false // 法定节假日：全天谷价
  const hh = new Date(ms).getUTCHours()
  // UTC 01:00–04:00 / 06:00–10:00（左闭右开）= 北京时间 09:00–12:00 / 14:00–18:00
  return (hh >= 1 && hh < 4) || (hh >= 6 && hh < 10)
}

/** 现在是不是谷时（isPeak 的反面）。 */
export function isOffPeak (date = new Date(), opts = {}) {
  return !isPeak(date, opts)
}

/**
 * 下一次峰↔谷切换的时间点。
 * @param {Date|number} [date]
 * @param {{holidays?: string[]}} [opts]
 * @returns {{at:number, offPeak:boolean}|null} at：时间戳（毫秒）；offPeak：切换之后是不是谷时。
 *   找不到（理论上不会）返回 null。
 */
export function nextChange (date = new Date(), { holidays = [] } = {}) {
  const ms = toMs(date)
  if (!Number.isFinite(ms)) return null
  const nowPeak = isPeak(ms, { holidays })
  const p = beijingParts(ms)
  // 峰谷只会在北京时间的这些整点变：00:00（日期切换）、06:00/09:00/12:00/14:00/18:00
  // （峰时开始/结束；周末和节假日的影响也只在日期切换后才体现，多扫几天覆盖整周）。
  const hours = [0, 6, 9, 12, 14, 18]
  const candidates = []
  for (let off = 0; off <= 8; off++) {
    // 北京时间当天 0 点对应的 UTC 毫秒：Date.UTC(y, m-1, d+off) 是「伪 UTC 0 点」，再减 8 小时
    const dayStart = Date.UTC(p.y, p.m - 1, p.d + off) - TZ_OFFSET_MS
    for (const hh of hours) {
      const at = dayStart + hh * 3600_000
      if (at > ms) candidates.push(at)
    }
  }
  candidates.sort((a, b) => a - b)
  for (const at of candidates) {
    if (isPeak(at, { holidays }) !== nowPeak) return { at, offPeak: !isPeak(at, { holidays }) }
  }
  return null
}

/**
 * 后台模型调用现在要不要推迟到谷时。
 * 配置没开（默认）/配置缺失 → 永远 false（行为不变）；开着且现在峰时 → true。
 * @param {object} cfg 插件配置
 * @param {Date} [now]
 */
export function shouldDeferBackground (cfg, now = new Date()) {
  if (cfg?.cost?.offPeak !== true) return false
  const holidays = Array.isArray(cfg.cost.offPeakHolidays) ? cfg.cost.offPeakHolidays : []
  return isPeak(now, { holidays })
}
