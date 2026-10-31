// 小黑盒扫码登录：纯接口，**不开浏览器窗口**。
//
// 参考 dph-heybox / astrbot-plugin-heybox-daily 的做法：
//   1. GET /account/get_qrcode_url?app=web  → 拿 qr_url 和 qr token
//   2. 用小黑盒 App 扫二维码
//   3. GET /account/qr_state/?app=web&qr=<token> 轮询 → result.error = wait | ready | ok
//   4. 成功时服务端通过 Set-Cookie 下发 pkey；result 里也可能直接带 pkey / user_pkey
//
// 这条路比「开浏览器让用户点验证码」友好得多：不弹窗、不抢前台、不用找滑块，手机上扫一下就行。
// 所以 captcha 也优先走这条，实在不行才开浏览器窗口（见 verify.js）。

import { HeyboxClient } from './api.js'
import { encodeQrPng } from './qrpng.js'

/**
 * 合并 Set-Cookie 到 cookie 对象。
 * @param {Record<string,string>} cookies
 * @param {string[]} setCookies
 */
export function mergeSetCookies(cookies, setCookies) {
  const out = { ...cookies }
  for (const raw of setCookies || []) {
    const first = String(raw).split(';')[0]
    const idx = first.indexOf('=')
    if (idx <= 0) continue
    const name = first.slice(0, idx).trim()
    const value = first.slice(idx + 1).trim()
    if (name) out[name] = value
  }
  return out
}

/** cookie 对象 → 整串 Cookie（给 HeyboxClient 用） */
export const cookieHeader = (cookies) => Object.entries(cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ')

/** 只留小黑盒相关的 key，避免把别的域的东西带进来 */
const keepHeyboxCookies = (cookies) => Object.fromEntries(
  Object.entries(cookies || {}).filter(([k]) => /^(pkey|user_pkey|x_xhh_tokenid|heybox_id|user_heybox_id|_user_token)$/.test(k)),
)

/** 第一步：拿二维码地址和 token */
export async function startQrLogin() {
  const client = new HeyboxClient({ cookie: '', interval: 0 })
  const data = await client.get('/account/get_qrcode_url', { app: 'web' })
  const qrUrl = data?.result?.qr_url
  if (!qrUrl) throw new Error('接口没有返回二维码地址')
  let token = ''
  try { token = new URL(qrUrl).searchParams.get('qr') || '' } catch { token = '' }
  if (!token) throw new Error('二维码地址里没有 qr token')
  return { qrUrl, token, expire: Number(data?.result?.expire ?? 120), png: qrPng(qrUrl) }
}

/** 二维码内容 → dataURL（自己画，不依赖 qrcode 库） */
function qrPng(text, scale = 5) {
  try { return encodeQrPng(text, { scale }) } catch (error) { return '' }
}

/**
 * 第二步起：轮询扫码状态。
 * @returns {{state, cookies?, cookie?, hasPkey?, heyboxId?, nickname?, verified?, verifyError?}}
 */
export async function pollQrLogin(token, sessionCookies = {}) {
  const c = new HeyboxClient({ cookie: cookieHeader(sessionCookies), interval: 0 })
  const { data, setCookies } = await c.request({
    path: '/account/qr_state',
    params: { app: 'web', qr: token },
    captureCookies: true,
  })
  const cookies = mergeSetCookies(sessionCookies, setCookies)
  const result = data?.result ?? {}
  const state = String(result.error ?? '')

  if (state !== 'ok') return { state: state || 'unknown', cookies }

  // 成功：pkey 可能在 Set-Cookie 里，也可能直接写在 result 里，两处都收
  if (result.pkey) cookies.pkey = String(result.pkey)
  if (result.user_pkey) cookies.user_pkey = String(result.user_pkey)

  const profile = result.profile ?? {}
  const detail = result.account_detail ?? {}
  const heyboxId = String(profile.heybox_id ?? detail.userid ?? result.heybox_id ?? '')
  if (heyboxId) { cookies.heybox_id = heyboxId; cookies.user_heybox_id = heyboxId }

  const merged = keepHeyboxCookies(cookies)
  const hasPkey = Boolean(merged.pkey || merged.user_pkey)

  // 拿到 cookie 后立刻验一次：没验通就是「扫了但没登录」，别骗用户说成功了
  let verified = false
  let verifyError = ''
  if (hasPkey) {
    try {
      const check = new HeyboxClient({ cookie: cookieHeader(merged), interval: 0 })
      const r = await check.get('/account/restore_login')
      const rr = r?.result ?? {}
      const id = String(rr.profile?.heybox_id ?? rr.heybox_id ?? rr.account_detail?.userid ?? '')
      verified = Boolean(id)
      if (!verified) verifyError = 'restore_login 没返回账号'
    } catch (err) {
      verifyError = String(err?.message ?? err)
    }
  }

  return {
    state: 'ok',
    cookies: merged,
    cookie: cookieHeader(merged),
    hasPkey,
    heyboxId,
    nickname: String(profile.username ?? profile.nickname ?? ''),
    verified,
    verifyError,
  }
}
