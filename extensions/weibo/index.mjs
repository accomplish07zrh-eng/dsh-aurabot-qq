/** 微博（整合版）—— 参照内置 bili / douyin 模块的规格
 *
 * 一个模块管全部微博能力：
 *   ① 热搜（公共数据，免登录）
 *   ② 账号：扫码登录 / Cookie 导入 / 状态 / 登出
 *   ③ 读：我的微博、单条正文、评论
 *   ④ 写：发博、转发、评论、删除（HTTP 直连，带频率刹车与风控停手）
 *
 * 与内置模块对齐的部分：
 *   - enabled 总开关（关掉后不挂工具）
 *   - caps：每类每日上限 + 最小间隔
 *   - 工具按 chat.kind 挂载：群聊只给只读，写操作只给主人私聊
 *   - 统一路由 /ext/weibo/*
 *   - api.every 定时 tick（扫码轮询、可选热搜播报）
 *
 * 独立性：只用公开模块 API，不 import 插件内部源码，不写插件 config.json，
 * 不依赖其它模块；状态全在 api.dataDir()。卸载 = 删两个目录。
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const HOME = 'https://weibo.com/'
const HOT_API = 'https://weibo.com/ajax/side/hotSearch'
const SIGNIN = 'https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog&disp=popup&url=https%3A%2F%2Fweibo.com%2F'
const QR_IMAGE = 'https://login.sina.com.cn/sso/qrcode/image?entry=weibo&size=180&callback=wb'
const QR_CHECK = 'https://login.sina.com.cn/sso/qrcode/check?entry=weibo&callback=wb&qrid='
const QR_TTL_MS = 4 * 60_000

let api = null
let cfg = {}
let browser = null
let uidCache = { uid: '', at: 0 }

// ============ 存储 ============
const D = () => api.dataDir()
const P = {
  cookies: () => join(D(), 'cookies.json'),
  counts: () => join(D(), 'counts.json'),
  state: () => join(D(), 'state.json'),
  qr: () => join(D(), 'login-qr.png'),
}
const ensureDir = () => { try { mkdirSync(D(), { recursive: true }) } catch {} }
const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return d } }
const writeJson = (p, v, mode) => { ensureDir(); writeFileSync(p, JSON.stringify(v, null, 2)); if (mode) { try { chmodSync(p, mode) } catch {} } }

/**
 * 生效配置：唯一来源是面板设置（存在插件 config.ext.weibo）。
 * 以前还叠了一层 dataDir/config.json，两份配置互相覆盖——"改了不生效"就是这么来的，已删除。
 */
const PRESETS = {
  safe:   { dryRun: true,  minGapMinutes: 30, caps: { post: 2,  repost: 2,  comment: 2  } },
  normal: { dryRun: true,  minGapMinutes: 10, caps: { post: 5,  repost: 5,  comment: 5  } },
  open:   { dryRun: false, minGapMinutes: 5,  caps: { post: 15, repost: 15, comment: 15 } },
}
const PRESET_LABEL = { safe: '🟢 安全', normal: '🟡 正常', open: '🔴 全开', custom: '⚙️ 自定义' }

const eff = () => {
  const s = api.settings() || {}
  return {
    enabled: s.enabled !== false,
    preset: String(s.preset || 'normal'),
    dryRun: s.dryRun !== false,
    minGapMinutes: Number(s.minGapMinutes ?? 10),
    caps: {
      post: Number(s.caps?.post ?? 5),
      repost: Number(s.caps?.repost ?? 5),
      comment: Number(s.caps?.comment ?? 5),
    },
    hotCount: Number(s.hotCount ?? 10),
    readLimit: Number(s.readLimit ?? 10),
    browserPath: String(s.browserPath ?? ''),
    loginMode: String(s.loginMode ?? 'browser'),
    hotDigestHours: Number(s.hotDigestHours ?? 0),
  }
}

/** 一键预设：把整组参数一次性写进面板设置 */
function applyPreset (name) {
  const key = String(name || '').trim().toLowerCase()
  const map = { '安全': 'safe', safe: 'safe', '正常': 'normal', normal: 'normal', '全开': 'open', open: 'open' }
  const id = map[key]
  if (!id) throw new Error('档位只有：安全 / 正常 / 全开')
  api.saveSettings({ ...PRESETS[id], preset: id })
  cfg = api.settings()
  return api.settings()
}

const loadCookies = () => readJson(P.cookies(), null)?.cookies || null
const loadCookiesAt = () => readJson(P.cookies(), null)?.savedAt || 0
const saveCookies = (cookies) => { writeJson(P.cookies(), { savedAt: Date.now(), cookies }, 0o600); uidCache = { uid: '', at: 0 } }
const jar = () => loadCookies() || {}
const cookieHeader = (j) => Object.entries(j).map(([k, v]) => `${k}=${v}`).join('; ')
const hasLogin = () => Boolean(jar().SUB || jar().SUBP)

const dayKey = () => new Date().toISOString().slice(0, 10)
function counts() {
  const c = readJson(P.counts(), { day: '', post: 0, repost: 0, comment: 0, lastAt: 0 })
  if (c.day !== dayKey()) { c.day = dayKey(); c.post = 0; c.repost = 0; c.comment = 0 }
  if (c.pausedDay !== dayKey()) { c.pausedDay = ''; c.pauseReason = '' }
  return c
}
const saveCounts = (c) => writeJson(P.counts(), c, 0o600)
const bump = (kind) => { const c = counts(); c[kind] += 1; c.lastAt = Date.now(); saveCounts(c) }

// ============ HTTP ============
async function rawGet(url, { html = false } = {}) {
  const res = await fetch(url, {
    headers: {
      'user-agent': UA, referer: 'https://weibo.com/',
      cookie: cookieHeader(jar()), 'x-requested-with': 'XMLHttpRequest',
      accept: html ? 'text/html,application/xhtml+xml' : 'application/json, text/plain, */*',
    },
    signal: AbortSignal.timeout(20000),
  })
  const text = await res.text()
  if (html) return { status: res.status, text }
  try { return { status: res.status, json: JSON.parse(text) } } catch { throw new Error(`微博返回非 JSON（HTTP ${res.status}）`) }
}

async function apiGet(path, params = {}) {
  const u = new URL('https://weibo.com' + path)
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, String(v))
  return (await rawGet(u.href)).json
}

async function apiPost(path, params) {
  if (!hasLogin()) throw new Error('还没登录微博，先发 /微博登录')
  const res = await fetch('https://weibo.com' + path, {
    method: 'POST',
    headers: {
      'user-agent': UA, referer: 'https://weibo.com/', origin: 'https://weibo.com',
      cookie: cookieHeader(jar()), 'x-xsrf-token': jar()['XSRF-TOKEN'] || '',
      'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20000),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  if (!json) throw new Error(`微博返回非 JSON（HTTP ${res.status}），接口可能变了`)
  const hit = JSON.stringify(json).match(/验证码|操作太频繁|访问过于频繁|账号异常|行为异常/)
  if (hit) { pauseDay(hit[0]); throw new Error(`被风控拦下（${hit[0]}），今天已停手`) }
  return json
}

// ============ 工具函数 ============
const fmtNum = (n) => {
  const v = Number(n) || 0
  if (v >= 1e8) return (v / 1e8).toFixed(1) + '亿'
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万'
  return String(v)
}
const clean = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
/** 认出用户给的是"某条微博"还是"某人的主页"。
 *  以前一律取最后一段数字，导致主页链接 /u/<uid> 被当成微博 id 用，然后报"可能被删" —— 误导。 */
function parseRef (target) {
  const t = String(target || '').trim()
  if (!t) throw new Error('要给微博链接或 id')
  if (/^\d{6,}$/.test(t)) return { kind: 'post', mid: t }

  const noQuery = t.split('?')[0].split('#')[0]
  // 主页：/u/<uid>、/profile/<uid>、/user/<uid>、或 weibo.com/<uid> 结尾
  const prof = noQuery.match(/weibo\.(?:com|cn)\/(?:u|profile|user)\/(\d+)/) ||
               noQuery.match(/weibo\.(?:com|cn)\/(\d{6,})\/?$/)
  if (prof) return { kind: 'profile', uid: prof[1] }

  // 正文：/detail/<id>、/status/<id>、/<uid>/<mid>
  const post = noQuery.match(/\/(?:detail|status)\/([A-Za-z0-9]{6,})/) ||
               noQuery.match(/weibo\.(?:com|cn)\/\d{6,}\/([A-Za-z0-9]{6,})/)
  if (post) return { kind: 'post', mid: post[1] }

  const all = [...noQuery.matchAll(/(\d{6,})/g)].map((m) => m[1])
  if (all.length >= 2) return { kind: 'post', mid: all[all.length - 1] }
  throw new Error('认不出这是正文还是主页：给 https://weibo.com/<uid>/<微博id> 这种正文链接，或纯数字微博 id')
}

/** 取正文 id；给的是主页就报一句能指导人的错，而不是"可能被删" */
function midOf (t) {
  const r = parseRef(t)
  if (r.kind === 'profile') {
    throw new Error(`这是主页链接（uid ${r.uid}），不是某条微博。看某条请给带 /<uid>/<微博id> 的正文链接；想读这个人的微博用 weibo_user_posts / /TA的微博`)
  }
  return r.mid
}

// ============ 账号 ============
/** 把登录态写进模块设置，客户端标签页的绿点读的是 ext.<id>.loggedIn */
function setLoggedIn (v) {
  try {
    const cur = api.settings() || {}
    if (Boolean(cur.loggedIn) === Boolean(v)) return
    api.saveSettings({ loggedIn: Boolean(v) })
    cfg = api.settings()
  } catch (e) { /* 设置不可写时忽略，不影响功能 */ }
}

async function whoami() {
  if (!hasLogin()) return { loggedIn: false, reason: '本地没有 cookie' }
  try {
    const { text } = await rawGet(HOME, { html: true })
    const uid = (text.match(/"uid":(\d{5,})/) || [])[1] || ''
    if (!uid) { setLoggedIn(false); return { loggedIn: false, reason: 'cookie 已失效' } }
    const nickname = (text.match(/"screen_name":"([^"]{1,40})"/) || [])[1] || ''
    uidCache = { uid, at: Date.now() }
    setLoggedIn(true)
    return { loggedIn: true, uid, nickname, savedAt: loadCookiesAt() }
  } catch (e) { setLoggedIn(false); return { loggedIn: false, reason: e.message } }
}

async function myUid() {
  if (uidCache.uid && Date.now() - uidCache.at < 3600_000) return uidCache.uid
  const w = await whoami()
  if (!w.loggedIn) throw new Error(w.reason || '没登录')
  return w.uid
}

function parseCookieInput(raw) {
  const txt = String(raw || '').trim()
  if (!txt) throw new Error('没收到 cookie')
  const out = {}
  if (txt.startsWith('[') || txt.startsWith('{')) {
    const j = JSON.parse(txt)
    for (const c of (Array.isArray(j) ? j : [j])) if (c && c.name) out[String(c.name)] = String(c.value ?? '')
  } else {
    for (const seg of txt.split(/[;\n\r]+/)) {
      const i = seg.indexOf('=')
      if (i > 0) out[seg.slice(0, i).trim()] = seg.slice(i + 1).trim()
    }
    if (!out.SUB && !out.SUBP && !txt.includes('=') && txt.length > 20) out.SUB = txt
  }
  if (!out.SUB && !out.SUBP) throw new Error('里面没有 SUB 或 SUBP')
  const keep = {}
  for (const k of ['SUB', 'SUBP', 'SUHB', 'ALF', 'SCF', 'SSOLoginState', 'XSRF-TOKEN']) if (out[k]) keep[k] = out[k]
  return keep
}

// ---- 浏览器（扫码登录用）----
function findBrowser() {
  const e = eff()
  const cands = [String(e.browserPath || ''), process.env.CHROME_PATH,
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].filter(Boolean)
  try {
    const root = join(process.env.HOME || '/home/dmomo', '.cache/ms-playwright')
    for (const d of readdirSync(root)) {
      if (!d.startsWith('chromium-')) continue
      for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
        if (existsSync(join(root, d, sub))) cands.push(join(root, d, sub))
      }
    }
  } catch {}
  for (const p of cands) { try { if (existsSync(p)) return p } catch {} }
  return ''
}
const freePort = () => new Promise((res, rej) => {
  const s = createServer(); s.unref(); s.on('error', rej)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)) })
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pend = new Map()
  ws.addEventListener('message', (e) => {
    let m = null
    try { m = JSON.parse(e.data) } catch { return }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || m); pend.delete(m.id) }
  })
  return new Promise((res, rej) => {
    ws.addEventListener('open', () => res({
      send: (method, params = {}) => new Promise((r) => {
        const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params }))
        setTimeout(() => { if (pend.has(i)) { pend.delete(i); r({}) } }, 20000)
      }),
      close: () => { try { ws.close() } catch {} },
    }))
    ws.addEventListener('error', () => rej(new Error('CDP 连接失败')))
  })
}

async function ensureBrowser({ visible = false } = {}) {
  if (browser?.cdp) return browser
  const bin = findBrowser()
  if (!bin) throw new Error('找不到 Chrome：设 CHROME_PATH 或填 config.json 的 browserPath')
  const port = await freePort()
  const prof = join(D(), 'browser')
  ensureDir(); mkdirSync(prof, { recursive: true })
  // 桌面环境（用户自己电脑）→ 开一个正常的可见窗口，用户直接在里面扫码
  // 无头服务器 → Xvfb 里跑，再把二维码截图发给用户
  const pos = visible ? ['--window-position=120,80', '--window-size=1120,820'] : ['--window-position=-2400,-2400', '--window-size=1280,900']
  const args = [
    `--user-data-dir=${prof}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-dev-shm-usage',
    ...pos, 'about:blank',
  ]
  const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
  const needXvfb = !hasDisplay
  const child = spawn(needXvfb ? 'xvfb-run' : bin,
    needXvfb ? ['-a', '--server-args=-screen 0 1280x900x24', bin, ...args] : args,
    { stdio: 'ignore', detached: true })
  child.unref()
  let up = false
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) { up = true; break } } catch {}
    await sleep(500)
  }
  if (!up) { try { process.kill(-child.pid) } catch {}; throw new Error('浏览器没起来') }
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(SIGNIN)}`, { method: 'PUT' })).json()
  const c = await cdp(tab.webSocketDebuggerUrl)
  await c.send('Page.enable'); await c.send('Runtime.enable')
  browser = { child, port, cdp: c }
  return browser
}

async function closeBrowser() {
  if (!browser) return
  try { browser.cdp.close() } catch {}
  try { process.kill(-browser.child.pid) } catch { try { browser.child.kill('SIGKILL') } catch {} }
  browser = null
}

async function qrViaBrowser() {
  await ensureBrowser()
  let box = null
  for (let i = 0; i < 25 && !box; i++) {
    const r = await browser.cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const q = document.querySelector('img[src*="qr" i], canvas, [class*="qrcode" i]');
        if (!q) return null;
        const b = q.getBoundingClientRect();
        return (b.width >= 60) ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
      })()`, returnByValue: true,
    })
    box = r?.result?.value
    if (!box) await sleep(800)
  }
  if (!box) throw new Error('页面上没找到二维码（网络慢或被风控）')
  const pad = 12
  const shot = await browser.cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.w + pad * 2, height: box.h + pad * 2, scale: 3 },
  })
  if (!shot?.data) throw new Error('截图失败')
  writeFileSync(P.qr(), Buffer.from(shot.data, 'base64'))
  return P.qr()
}

async function browserCookies() {
  const r = await browser?.cdp?.send('Storage.getCookies', {})
  const keep = {}
  for (const c of (r?.cookies || [])) {
    if (!/weibo\.(com|cn)$/.test(String(c.domain || '').replace(/^\./, ''))) continue
    keep[c.name] = c.value
  }
  return keep
}

// ---- 纯接口二维码（备选）----
async function qrViaHttp() {
  const r = await fetch(QR_IMAGE, { headers: { 'user-agent': UA, referer: 'https://weibo.com/' }, signal: AbortSignal.timeout(12000) })
  const j = JSON.parse(String(await r.text()).match(/\{[\s\S]*\}/)[0])
  if (j.retcode !== 20000000 || !j.data?.qrid) throw new Error(j.msg || '取二维码失败')
  const img = String(j.data.image || '')
  const url = img.startsWith('http') ? img : 'https:' + img
  const buf = Buffer.from(await (await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000) })).arrayBuffer())
  ensureDir(); writeFileSync(P.qr(), buf)
  return { qrid: j.data.qrid, path: P.qr() }
}

async function httpCheck(qrid) {
  const r = await fetch(QR_CHECK + encodeURIComponent(qrid), { headers: { 'user-agent': UA, referer: 'https://weibo.com/' }, signal: AbortSignal.timeout(12000) })
  const j = JSON.parse(String(await r.text()).match(/\{[\s\S]*\}/)[0])
  if (j.retcode === 20000000) return 'ok'
  if (j.retcode === 50114002) return 'scanned'
  if (j.retcode === 50114003) return 'expired'
  return 'wait'
}

/** 统一登录入口：
 *  桌面环境（有 DISPLAY）→ 弹出一个可见的微博登录窗口，用户自己扫码/账密登录，我们在后台轮询 cookie
 *  无头服务器              → 在 Xvfb 里开，截二维码图返回，用户扫图；扫完同样自动接住
 *  两条路都**不需要用户手动复制 cookie**；只有扫码被风控挡住时才需要"粘 cookie"这个兜底。
 */
async function startLogin() {
  const desktop = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
  const mode = eff().loginMode === 'http' ? 'http' : (desktop ? 'desktop' : 'browser')

  if (mode === 'http') {
    const q = await qrViaHttp()
    writeJson(P.state(), { ...readJson(P.state(), {}), pending: { mode: 'http', qrid: q.qrid, at: Date.now() } }, 0o600)
    return { mode, image: 'data:image/png;base64,' + readFileSync(q.path).toString('base64'), hint: '把这张二维码用微博 App 扫一下，扫完点确认' }
  }

  if (mode === 'desktop') {
    await ensureBrowser({ visible: true })
    writeJson(P.state(), { ...readJson(P.state(), {}), pending: { mode: 'desktop', at: Date.now() } }, 0o600)
    return { mode, windowOpened: true, hint: '已经在你的桌面打开微博登录窗口：扫码或用账号密码登录，完成后我会自动接住（不用复制任何东西）' }
  }

  const path = await qrViaBrowser()
  writeJson(P.state(), { ...readJson(P.state(), {}), pending: { mode: 'browser', at: Date.now() } }, 0o600)
  return { mode, image: 'data:image/png;base64,' + readFileSync(path).toString('base64'), hint: '这台机器没有图形桌面，所以把二维码发给你：微博 App 扫一下，扫完点确认' }
}

/** data:image/png;base64,... → 落成文件，供 api.sendImage 用 */
function qrPathFromDataUrl (dataUrl) {
  const b64 = String(dataUrl || '').replace(/^data:image\/png;base64,/, '')
  ensureDir()
  const p = join(D(), 'login-qr.png')
  writeFileSync(p, Buffer.from(b64, 'base64'))
  return p
}

// ============ 闸门 ============
function pauseDay(reason) {
  const c = counts()
  c.pausedDay = dayKey(); c.pauseReason = String(reason).slice(0, 60)
  saveCounts(c)
  const owner = String(api.config().ownerQQ || '')
  if (owner) api.send(`private:${owner}`, `⚠️ 微博要验证/被限制，今天停手了：${c.pauseReason}`).catch(() => {})
}

function gate(kind) {
  const e = eff(); const c = counts()
  if (!e.enabled) return '微博模块总开关是关的'
  if (c.pausedDay === dayKey()) return `今天已暂停：${c.pauseReason || '被风控'}`
  if (c[kind] >= (e.caps[kind] || 5)) return `今天${kind}次数已满（上限 ${e.caps[kind]}）`
  const gap = e.minGapMinutes * 60000 - (Date.now() - (c.lastAt || 0))
  if (gap > 0) return `操作太密，还要等 ${Math.ceil(gap / 60000)} 分钟`
  return ''
}

// ============ 读 ============
async function hotList() {
  const r = await fetch(HOT_API, {
    headers: { 'user-agent': UA, referer: 'https://weibo.com/', accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  })
  const j = await r.json()
  const list = j?.data?.realtime
  if (!Array.isArray(list) || !list.length) throw new Error('热搜接口没返回数据')
  return list.filter((x) => x && x.word && !x.is_ad).map((x) => ({
    word: String(x.word), hot: Number(x.num) || 0,
    label: x.label_name || x.icon_desc || '',
    link: `https://s.weibo.com/weibo?q=${encodeURIComponent('#' + x.word + '#')}`,
  }))
}

/** 读自己的微博：真的翻页（一页 20 条），最多读 200 条 / 20 页 */
async function myPosts(limit) {
  const uid = await myUid()
  const want = Math.min(500, Math.max(1, Number(limit) || 10))
  const out = []
  let page = 1
  let pages = 0
  while (out.length < want && page <= 40) {
    const j = await apiGet('/ajax/statuses/mymblog', { uid, page, feature: 0 })
    const list = (j?.data?.list) || []
    if (!list.length) break
    pages += 1
    for (const m of list) {
      out.push({
        id: m.idstr || String(m.id || ''), at: m.created_at || '',
        text: clean(m.text_raw || m.text).slice(0, 300),
        reposts: m.reposts_count || 0, comments: m.comments_count || 0, likes: m.attitudes_count || 0,
        isRepost: Boolean(m.retweeted_status),
        url: `https://weibo.com/${uid}/${m.idstr || m.id}`,
      })
      if (out.length >= want) break
    }
    if (list.length < 20) break        // 到底了
    page += 1
    await sleep(250)                    // 翻页别太急
  }
  out.pages = pages
  return out
}

/** 在自己的微博里按关键词搜（能直接命中很多年前的） */
async function searchMyPosts(keyword, limit) {
  const uid = await myUid()
  const q = String(keyword || '').trim()
  if (!q) throw new Error('要给关键词')
  const want = Math.min(100, Math.max(1, Number(limit) || 20))
  const out = []
  let page = 1
  while (out.length < want && page <= 10) {
    const j = await apiGet('/ajax/statuses/searchProfile', { uid, page, q })
    const list = (j?.data?.list) || []
    if (!list.length) break
    for (const m of list) {
      out.push({
        id: m.idstr || String(m.id || ''), at: m.created_at || '',
        text: clean(m.text_raw || m.text).slice(0, 300),
        reposts: m.reposts_count || 0, comments: m.comments_count || 0, likes: m.attitudes_count || 0,
        isRepost: Boolean(m.retweeted_status),
        url: `https://weibo.com/${uid}/${m.idstr || m.id}`,
      })
      if (out.length >= want) break
    }
    if (list.length < 20) break
    page += 1
    await sleep(250)
  }
  return out
}

/** 按 uid 读某人的微博（内部复用） */
async function userPostsByUid (uid, limit, keyword) {
  const want = Math.min(200, Math.max(1, Number(limit) || 10))
  const kw = String(keyword || '').trim()
  const out = []
  let page = 1
  while (out.length < want && page <= 20) {
    const j = kw
      ? await apiGet('/ajax/statuses/searchProfile', { uid, page, q: kw })
      : await apiGet('/ajax/statuses/mymblog', { uid, page, feature: 0 })
    const list = (j?.data?.list) || []
    if (!list.length) break
    for (const m of list) {
      out.push({
        id: m.idstr || String(m.id || ''), at: m.created_at || '',
        text: clean(m.text_raw || m.text).slice(0, 300),
        reposts: m.reposts_count || 0, comments: m.comments_count || 0, likes: m.attitudes_count || 0,
        isRepost: Boolean(m.retweeted_status),
        author: m.user?.screen_name || '',
        url: `https://weibo.com/${uid}/${m.idstr || m.id}`,
      })
      if (out.length >= want) break
    }
    if (list.length < 20) break
    page += 1
    await sleep(250)
  }
  return out
}

/** 读某个人的微博（自己或别人都可以）：uid / 主页链接 / 正文链接都认 */
async function userPosts (target, limit, keyword) {
  const raw = String(target || '').trim()
  // 纯数字在"读某人微博"的语境下按 uid 理解（同一个数也可能是微博 id，这里按调用意图走）
  if (/^\d{6,}$/.test(raw)) return userPostsByUid(raw, limit, keyword)
  const ref = parseRef(raw)
  let uid = ref.uid
  if (!uid && ref.kind === 'post') {
    const p = await readPost(ref.mid)          // 正文链接 → 先读出作者 uid
    const j = await apiGet('/ajax/statuses/show', { id: ref.mid })
    uid = String((j?.user?.id) || (j?.data?.user?.id) || '')
    if (!uid) throw new Error('从这条微博认不出作者 uid，换成主页链接再试')
  }
  if (!uid) throw new Error('要给 uid 或主页链接')
  return userPostsByUid(uid, limit, keyword)
}

async function readPost(target) {
  const mid = midOf(target)
  const j = await apiGet('/ajax/statuses/show', { id: mid, isGetLongText: 'true' })
  const m = j?.data || j
  if (!m || !(m.text_raw || m.text)) throw new Error('接口没返回正文：可能这条被删/设了权限，或者给的 id 其实不是微博 id')
  return {
    id: m.idstr || mid, at: m.created_at || '', author: m.user?.screen_name || '',
    text: clean(m.text_raw || m.text).slice(0, 1000),
    reposts: m.reposts_count || 0, comments: m.comments_count || 0, likes: m.attitudes_count || 0,
    isRepost: Boolean(m.retweeted_status),
    original: m.retweeted_status ? clean(m.retweeted_status.text_raw || m.retweeted_status.text).slice(0, 300) : '',
  }
}

async function readComments(target, limit) {
  const mid = midOf(target)
  const j = await apiGet('/ajax/statuses/buildComments', {
    id: mid, flow: 0, is_reply: 0, load_more: 1, is_show_bulletin: 2, count: 20,
  })
  return (j?.data || []).slice(0, Math.min(20, Number(limit) || 10)).map((c) => ({
    id: c.idstr || String(c.id || ''), user: c.user?.screen_name || '',
    text: clean(c.text_raw || c.text).slice(0, 200), at: c.created_at || '', likes: c.like_counts || 0,
  }))
}

// ============ 写 ============
async function doPost(text) {
  const e = eff()
  const t = String(text || '').trim()
  if (!t) throw new Error('内容不能为空')
  if (e.dryRun) return { dryRun: true, action: 'post', text: t, message: `[试运行] 会发这条微博：${t}` }
  const why = gate('post'); if (why) throw new Error(why)
  const j = await apiPost('/ajax/statuses/update', { content: t, visible: 0, ajwvr: 6 })
  const id = j?.data?.idstr || j?.data?.id || 'unknown'
  bump('post')
  return { ok: true, action: 'post', text: t, id, message: `发了（id ${id}）` }
}

async function doRepost(target, comment = '') {
  const e = eff()
  const mid = midOf(target)
  if (e.dryRun) return { dryRun: true, action: 'repost', target, comment, message: `[试运行] 会转发 ${target}${comment ? '，并说：' + comment : ''}` }
  const why = gate('repost'); if (why) throw new Error(why)
  const j = await apiPost('/ajax/statuses/repost', { id: mid, comment, is_repost: 0, comment_ori: 0, visible: 0, ajwvr: 6 })
  const st = j?.statuses || j?.data?.statuses || {}
  const id = st.idstr || st.id || 'unknown'
  bump('repost')
  return { ok: true, action: 'repost', target, comment, id, message: `转发了（新微博 id ${id}）` }
}

async function doComment(target, text) {
  const e = eff()
  const mid = midOf(target)
  const t = String(text || '').trim()
  if (!t) throw new Error('评论内容不能为空')
  if (e.dryRun) return { dryRun: true, action: 'comment', target, text: t, message: `[试运行] 会评论 ${target}：${t}` }
  const why = gate('comment'); if (why) throw new Error(why)
  const j = await apiPost('/ajax/comments/create', { id: mid, comment: t, ajwvr: 6, comment_ori: 0, is_repost: 0 })
  const id = j?.data?.idstr || j?.data?.id || 'unknown'
  bump('comment')
  return { ok: true, action: 'comment', target, text: t, id, message: `评论了（id ${id}）` }
}

async function doDelPost(id) {
  await apiPost('/ajax/statuses/destroy', { id: String(id) })
  return { ok: true, id: String(id), message: `删了微博 ${id}` }
}
async function doDelComment(cid) {
  const j = await apiPost('/aj/comment/del', { id: String(cid), cid: String(cid), ajwvr: 6 })
  if (j?.code !== '100000') throw new Error(j?.msg || '删除失败')
  return { ok: true, cid: String(cid), message: `删了评论 ${cid}` }
}

// ============ 渲染 ============
const renderHot = (items, n) => items.slice(0, n).map((x, i) => `${i + 1}. ${x.word}${x.label ? ' [' + x.label + ']' : ''} · ${fmtNum(x.hot)}`).join('\n')
const renderPosts = (ps, cap = 60) => ps.slice(0, cap).map((p, i) => `${i + 1}. [${String(p.at).slice(0, 16)}] ${p.text.slice(0, 80)}${p.text.length > 80 ? '…' : ''}\n   👍${fmtNum(p.likes)} 💬${fmtNum(p.comments)} 🔁${fmtNum(p.reposts)}${p.isRepost ? ' · 转发' : ''}`).join('\n')
  + (ps.length > cap ? `\n… 还有 ${ps.length - cap} 条没显示（可以加大数字，或用 /找微博 关键词 直接搜）` : '')
const renderComments = (cs) => cs.map((c, i) => `${i + 1}. ${c.user}：${c.text}`).join('\n')

function statusText(w) {
  const e = eff(); const c = counts()
  const acc = (w && w.loggedIn)
    ? `${w.nickname || '已登录'}（uid ${w.uid}）`
    : (hasLogin() ? '已登录' : '未登录')
  const next = !hasLogin()
    ? '下一步：发 /微博登录 扫码，或 /微博导入 粘 Cookie'
    : (e.dryRun ? '下一步：试运行中，确认内容没问题后用 /微博设置 全开 才会真发' : '下一步：已可真实发送')
  return [
    `账号：${acc}`,
    `档位：${PRESET_LABEL[e.preset] || e.preset} · ${e.dryRun ? '试运行' : '真实发送'} · 间隔 ${e.minGapMinutes} 分钟`,
    `今日用量：发博 ${c.post}/${e.caps.post} · 转发 ${c.repost}/${e.caps.repost} · 评论 ${c.comment}/${e.caps.comment}`,
    c.pausedDay === dayKey() ? `⛔ 今天已停手：${c.pauseReason}` : '状态：正常',
    next,
  ].join('\n')
}

// ============ 模块定义 ============
export default {
  id: 'weibo',
  name: '微博',
  version: '1.1.0',
  flag: 'loggedIn',   // 标签页状态点看 ext.weibo.loggedIn（Aurabot 1.2.0+）
  api: 1,
  description: '热搜 / 扫码登录 / 读自己的微博 / 发博转发评论。写操作默认试运行，支持一键预设档位',
  panel: 'panel.js',
  defaults: {
    enabled: true,
    preset: 'normal',
    dryRun: true,
    minGapMinutes: 10,
    caps: { post: 5, repost: 5, comment: 5 },
    hotCount: 10,
    readLimit: 10,
    browserPath: '',
    loginMode: 'browser',
    hotDigestHours: 0,
  },
  settings: [
    // 放在第一位：用户在「微博」标签页上第一眼就看到的操作入口
    { key: 'action', label: '⚡ 快捷操作', type: 'select', options: [
      { value: '', label: '（不操作）' },
      { value: 'login', label: '① 登录微博（桌面弹窗 / 服务器发二维码）' },
      { value: 'logout', label: '② 退出登录' },
      { value: 'status', label: '③ 查看当前状态（私聊发你）' },
    ], hint: '选一项立刻执行，执行完自动复位。档位切换请用下面的「当前档位」' },

    { key: 'enabled', label: '微博功能开关', type: 'switch', hint: '只管微博这一个模块。和页面顶部那个「总开关」（管整个机器人）不是一回事；关掉后她不再主动用微博能力，命令仍可查状态' },
    { key: 'preset', label: '当前档位（选完立刻生效）', type: 'select',
      options: [{ value: 'custom', label: '⚙️ 自定义（你手动调过下面某项）' }, { value: 'safe', label: '🟢 安全：试运行 · 间隔 30 分钟 · 每天 2 条' },
                { value: 'normal', label: '🟡 正常：试运行 · 间隔 10 分钟 · 每天 5 条' },
                { value: 'open', label: '🔴 全开：真发 · 间隔 5 分钟 · 每天 15 条' }],
      hint: '改这里等于用上面的快捷操作切档，二者是同一个东西' },
    { key: 'dryRun', label: '试运行（不真发）', type: 'switch', hint: '开：只回你「会发这条：xxx」；关：真的发到微博' },
    { key: 'minGapMinutes', label: '两次操作至少间隔（分钟）', type: 'number', min: 0, max: 240, step: 1,
      hint: '太密容易被微博要求验证码，默认 10' },
    { key: 'hotCount', label: '热搜默认显示几条', type: 'number', min: 1, max: 50, step: 1, hint: '发 /热搜 不带数字时用这个条数' },
    { key: 'readLimit', label: '读微博默认读几条', type: 'number', min: 1, max: 30, step: 1, hint: '发 /我的微博 不带数字时用这个条数' },
    { key: 'hotDigestHours', label: '热搜定时私聊（小时，0=关）', type: 'number', min: 0, max: 48, step: 1,
      hint: '大于 0 时，每 N 小时私聊你一条热搜' },

    // —— 下面两项基本不用动，所以标注清楚 ——
    { key: 'loginMode', label: '登录方式（一般不用改）', type: 'select',
      options: [{ value: 'browser', label: '自动：有桌面就弹窗，没桌面就发二维码' }, { value: 'http', label: '强制用纯接口二维码' }],
      hint: '默认就好。只有在自动方式失败时才需要改成「纯接口」' },
    { key: 'browserPath', label: '浏览器路径（一般不用填）', type: 'text',
      placeholder: '留空即可；找不到浏览器时才填，例如 /usr/bin/google-chrome',
      hint: '扫码登录需要 Chrome/Chromium。留空会自动在系统里找；找不到时把浏览器可执行文件路径填这里' },
  ],

  setup(a) {
    api = a
    cfg = api.settings()
    api.on('config', () => { cfg = api.settings() })
    api.onDispose(() => { closeBrowser() })
    api.log.info('微博模块已加载')
    // 启动时把登录态同步给客户端的标签页绿点
    whoami().then((w) => setLoggedIn(Boolean(w && w.loggedIn))).catch(() => {})

    // 快捷操作：设置里选了动作 → 立刻执行 → 自动复位（这样在「微博」标签页上就能一键干活）
    let acting = false
    let applying = false   // 自己写配置时避免重入（applyPreset 会再触发一次 config 事件）
    let snap = null
    const snapshot = () => {
      const x = api.settings() || {}
      return { preset: String(x.preset || 'normal'), dryRun: x.dryRun !== false }
    }

    async function runAction (a) {
      const owner = String(api.config().ownerQQ || '')
      const say = async (text, imgPath) => {
        try {
          if (imgPath) await api.sendImage(`private:${owner}`, imgPath)
          await api.send(`private:${owner}`, text)
        } catch (e) { api.log.warn('快捷操作回消息失败：' + e.message) }
      }
      if (a === 'login') {
        const r = await startLogin()
        if (r.image) await say('微博登录二维码（4 分钟内有效）：微博 App → 我 → 扫一扫，扫完点确认', qrPathFromDataUrl(r.image))
        else await say(r.hint || '已打开微博登录窗口，请在窗口里完成登录')
        return
      }
      if (a === 'logout') { if (existsSync(P.cookies())) unlinkSync(P.cookies()); uidCache = { uid: '', at: 0 }; setLoggedIn(false); await closeBrowser(); await say('已退出微博登录'); return }
      if (a === 'status') { await say(statusText(await whoami())); return }
    }

    /** 设置变了：先套档位，再处理手动改动，最后执行快捷操作。
     *  用自己维护的快照判断"改了什么"——不能依赖事件回调里的参数顺序（之前踩过）。 */
    async function onConfigChanged () {
      cfg = api.settings()
      const now = snapshot()
      const before = snap
      snap = now
      if (applying || !before) return

      // ① 档位下拉变了 → 真的套用参数
      if (now.preset !== before.preset && now.preset !== 'custom') {
        applying = true
        try { applyPreset(now.preset) } catch (e) { api.log.warn('套用档位失败：' + e.message) } finally { applying = false; snap = snapshot() }
        return
      }
      // ② 手动改了「试运行」→ 标成自定义，避免显示与实际不符
      if (now.dryRun !== before.dryRun && now.preset !== 'custom') {
        applying = true
        try { api.saveSettings({ preset: 'custom' }) } catch {} finally { applying = false; snap = snapshot() }
        return
      }
      // ③ 快捷操作
      const a = String((cfg && cfg.action) || '')
      if (!a || acting) return
      acting = true
      try { api.saveSettings({ action: '' }); snap = snapshot() } catch {}
      try { await runAction(a) } catch (e) { api.log.warn('快捷操作失败：' + e.message) }
      acting = false
    }

    api.on('config', onConfigChanged)
    snap = snapshot()

    // 启动时清掉可能残留的未执行动作
    try { if (cfg && cfg.action) api.saveSettings({ action: '' }) } catch {}

    // ---------------- 命令 ----------------
    api.command({ name: '微博帮助', aliases: ['wbhelp'], desc: '微博模块怎么用（一步步来）', run: async () => [
      '📖 微博模块 · 上手指南',
      '',
      '第 1 步 · 登录（点一下就行，不用复制 cookie）',
      '  · 面板「微博」页 → 第一项「⚡ 快捷操作」→ 选「① 登录微博」',
      '  · 或者直接发 /微博登录',
      '  · 有桌面的机器会弹出微博登录窗口，你在窗口里扫码即可',
      '  · 服务器没有桌面时，我会把二维码图发给你，手机微博扫一下',
      '  · 扫完点「确认登录」，我会自己把 cookie 存好（你不用看到它）',
      '  备用：扫码被风控挡住时，发 /微博导入 粘 Cookie（详见 README 第三节）',
      '',
      '📌 两个面板入口（别找错地方）',
      '  · 侧栏 Aurabot →「微博」标签页：这里是设置表单，第一项「⚡ 快捷操作」可以直接'
      + '登录/退出/切档/看状态（结果会私聊发你）',
      '  · 侧栏 Aurabot →「扩展」页 → 微博 → 图形面板：带二维码图片、档位按钮、用量进度条',
      '',
      '第 2 步 · 选档位（一键，不用自己算参数）',
      '  /微博设置 安全   → 试运行 · 间隔 30 分钟 · 每天 2 条（先用这个）',
      '  /微博设置 正常   → 试运行 · 间隔 10 分钟 · 每天 5 条（默认）',
      '  /微博设置 全开   → 真发   · 间隔 5 分钟  · 每天 15 条',
      '',
      '第 3 步 · 试发一条',
      '  /发微博 你好   → 试运行时会回「会发这条：你好」，不会真发',
      '  确认没问题后 /微博设置 全开 ，再发就会真发',
      '',
      '常用：/微博状态 看登录态和今日用量 · /热搜 看热搜',
      '读自己的：/我的微博 10 读最近 10 条；/我的微博 200 会翻页读更多；',
      '          /找微博 关键词 在全部历史微博里搜（找很多年前那条用这个最快）',
      '读某条：/看微博 <链接> ；看评论：/看评论 <链接> ；发评论：/评论 <链接> 内容',
      '',
      '遇到问题看 modules/weibo/README.md 的「常见问题」。',
    ].join('\n') })

    api.command({ name: '微博设置', aliases: ['wbset'], desc: '一键切档：/微博设置 安全|正常|全开', run: async (arg) => {
      try {
        applyPreset(arg)
        const e = eff()
        return `已切到 ${PRESET_LABEL[e.preset]}：${e.dryRun ? '试运行' : '真实发送'} · 间隔 ${e.minGapMinutes} 分钟 · 每天 ${e.caps.post} 条`
      } catch (e) { return e.message }
    } })

    api.command({ name: '热搜', aliases: ['微博热搜', 'wbhot'], desc: '微博热搜榜，可带条数', run: async (arg) => {
      const n = Math.min(50, Math.max(1, parseInt(String(arg || '').trim(), 10) || eff().hotCount))
      try { return `微博热搜 · ${new Date().toLocaleString('zh-CN', { hour12: false })}\n${renderHot(await hotList(), n)}` } catch (e) { return `热搜没取到：${e.message}` }
    } })

    api.command({ name: '微博登录', aliases: ['wblogin'], desc: '登录微博（桌面直接弹窗，服务器发二维码）', run: async (arg, msg) => {
      try {
        const r = await startLogin()
        if (r.image) { try { await api.sendImage(msg.chatId, qrPathFromDataUrl(r.image)) } catch {} }
        return r.hint + (r.image ? '\n二维码 4 分钟内有效，过期就再发一次 /微博登录。' : '')
      } catch (e) { await closeBrowser(); return `登录启动失败：${e.message}` }
    } })

    api.command({ name: '微博导入', aliases: ['wbimport'], desc: '导入微博 cookie（整串 / JSON / 裸 SUB 都行）', run: async (arg) => {
      try {
        const c = parseCookieInput(arg)
        saveCookies(c)
        const w = await whoami()
        return w.loggedIn ? `导入成功：${w.nickname}（uid ${w.uid}）` : `存下了 ${Object.keys(c).length} 个字段，但微博不认（${w.reason}）—— 可能 cookie 不全或过期`
      } catch (e) { return `导入失败：${e.message}` }
    } })

    api.command({ name: '微博状态', aliases: ['wbstatus'], desc: '看登录态与今日配额', run: async () => statusText(await whoami()) })

    api.command({ name: '微博登出', desc: '清掉本地登录态', run: async () => {
      try { if (existsSync(P.cookies())) unlinkSync(P.cookies()); uidCache = { uid: '', at: 0 }; setLoggedIn(false); await closeBrowser(); return '已清掉本地登录态' } catch (e) { return `清理失败：${e.message}` }
    } })

    api.command({ name: '我的微博', aliases: ['wbme'], desc: '读自己最近的微博：/我的微博 [条数，最多 500]', run: async (arg) => {
      try {
        const n = parseInt(String(arg || '').trim(), 10) || eff().readLimit
        const ps = await myPosts(n)
        if (!ps.length) return '微博列表是空的'
        const head = `你最近的微博（读到 ${ps.length} 条，翻了 ${ps.pages || 1} 页）`
        return `${head}：\n${renderPosts(ps)}`
      } catch (e) { return `读不到：${e.message}` }
    } })

    api.command({ name: '找微博', aliases: ['wbfind'], desc: '在自己的微博里搜关键词：/找微博 关键词', run: async (arg) => {
      const q = String(arg || '').trim()
      if (!q) return '格式：/找微博 关键词'
      try {
        const ps = await searchMyPosts(q, 20)
        return ps.length ? `在你微博里搜「${q}」，找到 ${ps.length} 条：\n${renderPosts(ps)}` : `你微博里没有包含「${q}」的内容`
      } catch (e) { return `搜不到：${e.message}` }
    } })

    api.command({ name: '看微博', aliases: ['wbsee'], desc: '读某条微博正文', run: async (arg) => {
      try {
        const p = await readPost(arg)
        return `${p.author} · ${p.at}\n${p.text}\n\n👍${fmtNum(p.likes)} 💬${fmtNum(p.comments)} 🔁${fmtNum(p.reposts)}${p.original ? '\n\n【原微博】' + p.original : ''}`
      } catch (e) { return `读不到：${e.message}` }
    } })

    api.command({ name: 'TA的微博', aliases: ['wbu'], desc: '读某人的微博：/TA的微博 <主页链接或uid> [条数]', run: async (arg) => {
      const s2 = String(arg || '').trim()
      const i = s2.lastIndexOf(' ')
      const target = i > 0 ? s2.slice(0, i) : s2
      const n = i > 0 ? parseInt(s2.slice(i + 1), 10) : eff().readLimit
      try {
        const ps = await userPosts(target, n)
        return ps.length ? `读到 ${ps.length} 条：\n${renderPosts(ps)}` : '没读到这个人的微博'
      } catch (e) { return `读不到：${e.message}` }
    } })

    api.command({ name: '看评论', aliases: ['wbcsee'], desc: '读某条微博的评论', run: async (arg) => {
      try {
        const cs = await readComments(arg)
        return cs.length ? renderComments(cs) : '这条还没有评论'
      } catch (e) { return `读不到：${e.message}` }
    } })

    api.command({ name: '发微博', aliases: ['wbpost'], desc: '发一条微博', run: async (arg) => {
      try { return (await doPost(arg)).message } catch (e) { return `没发成：${e.message}` }
    } })

    api.command({ name: '转发', aliases: ['wbrepost'], desc: '转发：/转发 <链接> #可选评论', run: async (arg) => {
      const s = String(arg || '').trim()
      const i = s.indexOf('#')
      const target = (i >= 0 ? s.slice(0, i) : s).trim()
      const comment = i >= 0 ? s.slice(i + 1).trim() : ''
      try { return (await doRepost(target, comment)).message } catch (e) { return `没转发成：${e.message}` }
    } })

    api.command({ name: '评论', aliases: ['wbcomment'], desc: '评论：/评论 <链接> 内容', run: async (arg) => {
      const s = String(arg || '').trim()
      const i = s.indexOf(' ')
      if (i < 0) return '格式：/评论 <链接或id> 内容'
      try { return (await doComment(s.slice(0, i), s.slice(i + 1))).message } catch (e) { return `没评论成：${e.message}` }
    } })

    api.command({ name: '删微博', aliases: ['wbdel'], desc: '/删微博 <微博id>', run: async (arg) => {
      const id = String(arg || '').trim()
      if (!/^\d{6,}$/.test(id)) return '格式：/删微博 <微博id>（纯数字，从 /我的微博 的结果里看）'
      try { return (await doDelPost(id)).message } catch (e) { return `删除失败：${e.message}` }
    } })

    api.command({ name: '删评论', aliases: ['wbcdel'], desc: '/删评论 <评论id>', run: async (arg) => {
      const id = String(arg || '').trim()
      if (!/^\d{6,}$/.test(id)) return '格式：/删评论 <评论id>（纯数字）'
      try { return (await doDelComment(id)).message } catch (e) { return `删除失败：${e.message}` }
    } })

    // ---------------- 工具（按聊天类型挂） ----------------
    api.tool(({ chat }) => {
      const e = eff()
      if (!e.enabled || chat.kind === 'system') return []
      const tools = [
        api.defineTool({
          name: 'weibo_hot',
          description: '微博热搜榜（实时，带热度和标签）。有人问"微博上有什么热搜"时用。',
          properties: { limit: { type: 'number', description: '几条，默认 10' } }, required: [],
          execute: async ({ limit }) => { try { return { ok: true, message: renderHot(await hotList(), Math.min(30, Number(limit) || e.hotCount)) } } catch (err) { return { ok: false, message: err.message } } },
        }),
      ]
      if (!hasLogin()) return tools
      tools.push(
        api.defineTool({
          name: 'weibo_my_posts',
          description: '读主人自己的微博。可以给关键词，直接在他全部历史微博里搜（能搜到很多年前的）。问"我最近发了什么""我以前发过关于XX的吗"时用。',
          properties: {
            limit: { type: 'number', description: '读几条（默认 10，最多 200）' },
            keyword: { type: 'string', description: '可选：按关键词搜自己的历史微博' },
          }, required: [],
          execute: async ({ limit, keyword }) => {
            try {
              const kw = String(keyword || '').trim()
              const ps = kw ? await searchMyPosts(kw, limit || 20) : await myPosts(limit)
              const head = kw ? `在你微博里搜「${kw}」，找到 ${ps.length} 条：\n` : ''
              return { ok: true, message: ps.length ? head + renderPosts(ps) : (kw ? `没搜到包含「${kw}」的微博` : '列表是空的') }
            } catch (err) { return { ok: false, message: `读不到：${err.message}` } }
          },
        }),
        api.defineTool({
          name: 'weibo_read_post',
          description: '读指定微博正文（给链接或 id）。别人发来微博链接、问"这条说什么"时用。',
          properties: { url: { type: 'string', description: '微博链接或 id' } }, required: ['url'],
          execute: async ({ url }) => { try { const p = await readPost(url); return { ok: true, message: `${p.author}：${p.text}` } } catch (err) { return { ok: false, message: `读不到：${err.message}` } } },
        }),
        api.defineTool({
          name: 'weibo_user_posts',
          description: '读某个人的微博（不限自己）：给主页链接、uid 或某条微博链接，也可带关键词搜这个人的历史微博。',
          properties: {
            target: { type: 'string', description: '主页链接 / uid / 某条微博链接' },
            limit: { type: 'number', description: '读几条（默认 10，最多 200）' },
            keyword: { type: 'string', description: '可选：在这个人的微博里搜关键词' },
          }, required: ['target'],
          execute: async ({ target, limit, keyword }) => {
            try {
              const ps = await userPosts(target, limit, keyword)
              return { ok: true, message: ps.length ? renderPosts(ps) : '没有读到微博（可能没有权限或是空号）' }
            } catch (err) { return { ok: false, message: `读不到：${err.message}` } }
          },
        }),
        api.defineTool({
          name: 'weibo_read_comments',
          description: '读某条微博的评论（问"评论区怎么说"时用）。',
          properties: { url: { type: 'string', description: '微博链接或 id' }, limit: { type: 'number', description: '几条' } }, required: ['url'],
          execute: async ({ url, limit }) => { try { const cs = await readComments(url, limit); return { ok: true, message: cs.length ? renderComments(cs) : '没有评论' } } catch (err) { return { ok: false, message: `读不到：${err.message}` } } },
        }),
      )
      if (chat.kind === 'private') {
        tools.push(
          api.defineTool({
            name: 'weibo_post', description: '发一条微博。只在主人明确要求时用，内容别自己加戏。',
            properties: { text: { type: 'string', description: '正文' } }, required: ['text'],
            execute: async ({ text }) => { try { return { ok: true, message: (await doPost(text)).message } } catch (err) { return { ok: false, message: err.message } } },
          }),
          api.defineTool({
            name: 'weibo_comment', description: '评论某条微博（主人给链接并明确要评论时用）。',
            properties: { url: { type: 'string', description: '微博链接或 id' }, text: { type: 'string', description: '评论内容' } }, required: ['url', 'text'],
            execute: async ({ url, text }) => { try { return { ok: true, message: (await doComment(url, text)).message } } catch (err) { return { ok: false, message: err.message } } },
          }),
          api.defineTool({
            name: 'weibo_status', description: '查微博登录态与今日配额。',
            properties: {}, required: [],
            execute: async () => ({ ok: true, message: statusText(await whoami()) }),
          }),
        )
      }
      return tools
    })

    api.rule((kind) => (kind === 'social'
      ? ''
      : '你有微博能力：热搜（weibo_hot）、读自己的微博（weibo_my_posts）、读某人的微博（weibo_user_posts）、读指定微博（weibo_read_post）、读评论（weibo_read_comments）。主人问到时用这些工具真去读，读不到就说读不到，不要编内容；**不要用 bash 去 curl 微博接口**——那样会灌一堆原始 JSON 把对话搞乱。'))

    // ---------------- 路由 ----------------
    api.route('/state', async () => {
      const c = eff()
      return { ok: true, config: c, counts: counts(), hasLogin: hasLogin(), account: await whoami(), presets: PRESETS, danger: !c.dryRun }
    })
    api.route('/preset', async (req) => {
      try {
        const b = await readBody(req)
        const saved = applyPreset(b.name || b.preset || '')
        return { ok: true, config: eff(), saved }
      } catch (e) { return { ok: false, message: e.message } }
    })
    api.route('/diag', async () => {
      const w = await whoami()
      return {
        ok: true,
        config: eff(),
        counts: counts(),
        account: w,
        cookieFields: Object.keys(jar()),
        cookieSavedAt: loadCookiesAt(),
        settingsSource: '面板设置（config.ext.weibo）',
      }
    })
    api.route('/hot', async () => { try { const items = await hotList(); return { ok: true, count: items.length, items: items.slice(0, 30) } } catch (e) { return { ok: false, message: e.message } } })
    api.route('/mine', async (req) => {
      try {
        const u = new URL(req.url, 'http://x')
        const kw = u.searchParams.get('q')
        const lim = Number(u.searchParams.get('limit')) || eff().readLimit
        const posts = kw ? await searchMyPosts(kw, lim) : await myPosts(lim)
        return { ok: true, count: posts.length, pages: posts.pages || 1, posts }
      } catch (e) { return { ok: false, message: e.message } }
    })
    api.route('/read', async (req) => { try { const u = new URL(req.url, 'http://x'); return { ok: true, ...(await readPost(u.searchParams.get('url') || '')) } } catch (e) { return { ok: false, message: e.message } } })
    api.route('/comments', async (req) => { try { const u = new URL(req.url, 'http://x'); return { ok: true, items: await readComments(u.searchParams.get('url') || '', Number(u.searchParams.get('limit')) || 10) } } catch (e) { return { ok: false, message: e.message } } })
    api.route('/login/start', async () => {
      try { return { ok: true, ...(await startLogin()) } } catch (e) { await closeBrowser(); return { ok: false, message: e.message } }
    })
    api.route('/import', async (req) => {
      try {
        const b = await readBody(req)
        const c = parseCookieInput(b.cookie || b.value || '')
        saveCookies(c)
        const w = await whoami()
        return { ok: true, saved: Object.keys(c).length, ...w }
      } catch (e) { return { ok: false, message: e.message } }
    })
    api.route('/logout', async () => { try { if (existsSync(P.cookies())) unlinkSync(P.cookies()); uidCache = { uid: '', at: 0 }; setLoggedIn(false); await closeBrowser(); return { ok: true } } catch (e) { return { ok: false, message: e.message } } })
    api.route('/post', async (req) => { try { return { ...(await doPost((await readBody(req)).text)) } } catch (e) { return { ok: false, message: e.message } } })
    api.route('/repost', async (req) => { try { const b = await readBody(req); return { ...(await doRepost(b.url || b.target, b.comment || '')) } } catch (e) { return { ok: false, message: e.message } } })
    api.route('/comment', async (req) => { try { const b = await readBody(req); return { ...(await doComment(b.url || b.target, b.text || b.comment || '')) } } catch (e) { return { ok: false, message: e.message } } })

    // ---------------- 定时 ----------------
    api.every(3000, async () => {
      const s = readJson(P.state(), {})
      if (!s.pending) return
      if (Date.now() - s.pending.at > QR_TTL_MS) { writeJson(P.state(), { ...s, pending: null }, 0o600); return }
      try {
        let cookies = null
        if (s.pending.mode === 'browser') {
          const c = await browserCookies()
          if (c.SUB || c.SUBP) cookies = c
        } else {
          const st = await httpCheck(s.pending.qrid)
          if (st === 'expired') { writeJson(P.state(), { ...s, pending: null }, 0o600); return }
        }
        if (cookies) {
          saveCookies(cookies)
          setLoggedIn(true)
          writeJson(P.state(), { ...s, pending: null }, 0o600)
          await closeBrowser()
          api.log.info('微博扫码登录成功')
          const owner = String(api.config().ownerQQ || '')
          if (owner) api.send(`private:${owner}`, '✅ 微博登录好了').catch(() => {})
        }
      } catch (e) { api.log.warn('微博登录轮询出错：' + e.message) }
    }, '微博扫码轮询')

    api.every(30 * 60_000, async () => {
      const e = eff()
      if (!e.hotDigestHours) return
      const f = join(D(), 'last-digest.json')
      const last = readJson(f, { at: 0 }).at || 0
      if (Date.now() - last < e.hotDigestHours * 3600_000) return
      const owner = String(api.config().ownerQQ || '')
      if (!owner) return
      try {
        await api.send(`private:${owner}`, `📰 微博热搜\n${renderHot(await hotList(), e.hotCount)}`)
        writeJson(f, { at: Date.now() })
      } catch (err) { api.log.warn('热搜播报失败：' + err.message) }
    }, '微博热搜播报')

    // 导出给别的模块用（保持 fetchHot 老名字，早报模块在用）
    return { hotList, fetchHot: hotList, myPosts, searchMyPosts, userPosts, readPost, readComments, doPost, doRepost, doComment, doDelPost, doDelComment, whoami }
  },
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    let done = false
    const fin = (v) => { if (!done) { done = true; resolve(v) } }
    try {
      req.on('data', (c) => { data += c; if (data.length > 1e6) fin({}) })
      req.on('end', () => { try { fin(JSON.parse(data || '{}')) } catch { fin({}) } })
      req.on('error', () => fin({}))
    } catch { fin({}) }
    setTimeout(() => fin({}), 5000)
  })
}

// 供单元测试使用（纯函数，不依赖宿主）
export { parseRef, midOf }
