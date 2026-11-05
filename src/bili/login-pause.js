import { createHash } from 'node:crypto'

const loginReasons = new Set(['B 站没登录或 Cookie 过期了', 'Cookie 里的 bili_jct 不对'])
export function loginSessionKey(cookie) {
  const values = Object.fromEntries(String(cookie || '').split(/;\s*/).map((part) => {
    const index = part.indexOf('=')
    return [part.slice(0, index).trim(), part.slice(index + 1).trim()]
  }))
  if (!values.SESSDATA || !values.bili_jct) return ''
  return createHash('sha256').update(JSON.stringify([values.SESSDATA, values.bili_jct])).digest('hex')
}

/** 只恢复登录失败造成的暂停；同一凭证若再次被拒绝，不反复解除暂停。 */
export function recoverLoginPause(state, { isLogin, sessionKey, day, now = Date.now() }) {
  if (!isLogin || !sessionKey || state.pauseDay !== day || !loginReasons.has(state.pauseReason)) return false
  if (state.loginPauseRecovery?.sessionKey === sessionKey) return false
  state.loginPauseRecovery = { sessionKey, at: now, previousReason: state.pauseReason }
  delete state.pauseDay
  delete state.pauseReason
  return true
}
