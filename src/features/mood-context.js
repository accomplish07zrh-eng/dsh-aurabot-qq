import { cleanText } from '../core/text.js'

const REASON_TTL_MS = 3 * 3600_000

/** 理由是过去发生的事；旧存档沿用当时的更新时间，不能当作现在刚发生。 */
export function moodReason(state, value, base, now = Date.now()) {
  const at = Number(state.reasonAt ?? state.at)
  const age = now - at
  if (!state.reason || !Number.isFinite(at) || at <= 0 || age < 0 || age >= REASON_TTL_MS || Math.abs(value - base) <= 1) return ''
  const elapsed = age < 3600_000 ? `${Math.max(1, Math.floor(age / 60_000))} 分钟前` : `${Math.floor(age / 3600_000)} 小时前`
  return `，${elapsed}因为${cleanText(state.reason)}`
}
