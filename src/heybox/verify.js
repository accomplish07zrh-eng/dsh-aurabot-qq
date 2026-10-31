// 小黑盒「安全验证」通道：优先扫码（不开浏览器），实在不行才开浏览器窗口。
//
// 为什么优先扫码（参考 dph-heybox、astrobot-plugin-heybox-daily）：
//   · 小黑盒的验证挂在**会话**上，扫码登录直接换一个干净会话，压根不触发滑块；
//   · 不用弹窗、不用抢前台、不用找验证码位置，手机上扫一下完事。
// 扫码实现在 qr.js 里（纯接口）。这个文件只管「浏览器兜底」那一路。
//
// 浏览器兜底的原则（对齐抖音模块的做法）：**窗口默认不显示**。
//   · 启动时窗口放在屏幕外（-2400,-2400），不抢前台、不打断主人做事；
//   · 只有主人主动点「显示窗口」才挪进来；
//   · 验证完成后立刻挪回屏幕外。

import { createBrowser } from '../douyin/browser.js'
import { dataDir } from '../core/store.js'

const HOME = 'https://www.xiaoheihe.cn/'
const PROFILE = 'heybox/edge-profile'

/** 页面上看得见的安全验证 / 滑块。每次现查，不留标记。 */
export const VERIFY_PROBE = `(() => {
  const big = (n) => {
    const r = n.getBoundingClientRect()
    const s = getComputedStyle(n)
    return r.width > 200 && r.height > 120 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.1
  }
  const nodes = [...document.querySelectorAll(
    '[class*="captcha"], [id*="captcha"], [class*="verify"], [id*="verify"], iframe[src*="captcha"], iframe[src*="verify"], .nc-container, .nc_scale'
  )]
  const hit = nodes.find(big)
  if (!hit) return ''
  return (hit.innerText || hit.className || '页面弹了验证').toString().slice(0, 80)
})()`

/**
 * 造一个「浏览器兜底验证」通道。
 * @param {object} o
 * @param {()=>string} [o.browserPath] 面板里填的浏览器路径，留空自动找 Edge/Chrome
 * @param {object} [o.log]
 */
export function createVerifier({ browserPath = () => '', log } = {}) {
  let browser = null
  let session = null // { at, state, why, shot, visible }

  const b = () => {
    if (!browser) {
      browser = createBrowser({
        profileDir: dataDir(PROFILE),
        browserPath,
        log,
        // 小黑盒这边最重要的一条：**别打扰用户**。
        // 实测这台机器上 Edge Beta 会忽略 --headless（照样建窗口），
        // 也会忽略 --window-position，所以不能指望启动参数。
        // quietWindows 会开一个看门狗子进程，窗口一露头就立刻最小化
        // （实测窗口 ~1.1s 出现、~1.2s 就被压下去，之后全程不再出现）。
        quietWindows: true,
        startMinimized: true,
      })
    }
    return browser
  }

  const shot = () => b().screenshot().catch(() => '')
  const verifyNow = () => b().evaluate(VERIFY_PROBE).catch(() => '')

  /**
   * 连上浏览器并停在小黑盒首页。
   * @param {{visible?:boolean}} [o] visible=true 才挪进屏幕里（默认屏幕外，不打扰主人）
   */
  async function open({ visible = false } = {}) {
    const r = await b().open()
    if (!r.ok) return { ok: false, message: r.message }
    const href = String(await b().evaluate('location.href').catch(() => ''))
    if (!/^https:\/\/www\.xiaoheihe\.cn\//.test(href)) await b().goto(HOME, 15000)
    // 默认把窗口收进任务栏：不占屏幕、不抢焦点。只有主人主动要看才恢复。
    if (visible) await b().restoreWindow()
    else await b().hideWindow().catch(() => {})
    return { ok: true }
  }

  /**
   * 开始浏览器兜底验证。**默认不显示窗口**：先把页面打开、状态查一次，
   * 主人要看截图就返回截图；需要操作时再自己点「显示窗口」。
   */
  async function begin({ visible = false } = {}) {
    const r = await open({ visible })
    if (!r.ok) return { ok: false, message: r.message }
    const why = await verifyNow()
    session = { at: Date.now(), state: why ? 'waiting' : 'clear', why, shot: await shot(), verified: false, visible: Boolean(visible) }
    return {
      ok: true,
      state: session.state,
      why,
      shot: session.shot,
      visible: session.visible,
      message: why
        ? `浏览器已在后台打开，页面弹了安全验证（${why}）。截图在下面；要在窗口里点的话按「显示窗口」。`
        : '浏览器已在后台跑起来（窗口会自动收进任务栏，不占你的屏幕），这会儿没看到验证框。要走扫码就点「扫码登录」。',
    }
  }

  /** 主人主动要看窗口（处理滑块 / 手动登录） */
  async function showWindow(visible = true) {
    const r = await b().open()
    if (!r.ok) return r

    if (visible) await b().restoreWindow()
    else await b().hideWindow().catch(() => {})
    if (session) session.visible = Boolean(visible)
    return { ok: true, message: visible ? '窗口挪到屏幕里了，点完再点「收回窗口」' : '窗口挪回屏幕外了，不打扰你' }
  }

  /** 用户点完验证后回来收：检查页面、把 Cookie 收下来，并把窗口挪回屏幕外 */
  async function finish() {
    const r = await b().open()
    if (!r.ok) return { ok: false, message: r.message }
    const why = await verifyNow()
    const raw = await b().cookies()
    const list = raw.filter((c) => /xiaoheihe\.cn/.test(c.domain))
    const cookie = list.map((c) => `${c.name}=${c.value}`).join('; ')
    const hasPkey = /pkey=|user_pkey=/.test(cookie)
    session = { at: Date.now(), state: why ? 'waiting' : 'clear', why, shot: await shot(), verified: !why && Boolean(cookie), visible: false }
    // 收完就把窗口挪走，别留在屏幕里
    await b().hideWindow().catch(() => {})
    if (!cookie) return { ok: false, message: '浏览器里没拿到小黑盒 Cookie：先在窗口里登录一下再点这里（或者直接用「扫码登录」）。', shot: session.shot }
    if (why) return { ok: false, message: `页面上还有验证没点完（${why}）。点完再回来。`, shot: session.shot, cookie }
    return {
      ok: true,
      cookie,
      hasPkey,
      count: list.length,
      shot: session.shot,
      message: hasPkey
        ? `验证过了，已收回 ${list.length} 个 Cookie${/x_xhh_tokenid=/.test(cookie) ? '（带发帖令牌）' : '（缺 x_xhh_tokenid，写操作可能会被拒）'}`
        : '验证过了，但收回的 Cookie 里没有 pkey —— 窗口里可能还没登录。',
    }
  }

  function status() {
    return { open: Boolean(browser && browser.connected()), session }
  }

  function hide() { return b().hideWindow().catch(() => {}) }
  function dispose() { try { browser?.close() } catch { /* 关了就算了 */ } }

  return { begin, finish, status, hide, showWindow, dispose, verifyNow, screenshot: shot, open }
}
