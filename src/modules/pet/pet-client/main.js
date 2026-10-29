// Aurabot 桌宠客户端（Electron 主进程）—— 本文件是模板/生成物：
// 由插件「桌宠」模块 POST /aurabot/api/ext/pet/client/install 生成到
//   <Aurabot 数据目录>/modules-data/pet/app/
// 运行前在本机装 Electron（插件本体不引入任何 npm 依赖）：
//   cd <app 目录> && npm init -y && npm i -D electron && npx electron main.js
//
// 行为：
//   · 读同目录上一级的 host.json（baseUrl + token 契约）→ 长轮询 GET /events?since=&wait=25
//   · proactive 事件弹气泡：优先播事件里的 anim（P2 点播，带 playbackId 回执），
//     否则从当前形象包的 speak 池里按权重抽一段（P1）；播完回 idle。
//   · 素材经 GET /asset/<包>/<文件>.webm?token= 拉（P1/P4；packs 目录在插件数据目录）。
//   · 端口漂移：baseUrl 失败或轮询出错都会重读 host.json 再试（R9）。
//   · 窗口：置顶、透明无边框、JS 拖拽 + 甩抛（physics.js，P3）、托盘退出、单实例锁。

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const physics = require('./physics.js')

const HOST_FILE = process.env.AURABOT_PET_HOST || path.join(__dirname, '..', 'host.json')
const POLL_WAIT_MS = 25_000
const FETCH_TIMEOUT_MS = 40_000

if (!app.requestSingleInstanceLock()) app.quit() // 单实例锁

let win = null
let tray = null
let cursor = null      // 事件游标（null = 首次连接只取水位）
let bootId = ''
let focusOn = false
let clientId = 'pet-' + Math.random().toString(16).slice(2, 10)
let pack = null        // 当前形象包视图（/config 的 pack 字段）
let apiBase = null     // { baseUrl, api, token }

function readHost() {
  try {
    const h = JSON.parse(fs.readFileSync(HOST_FILE, 'utf8'))
    if (!/^https?:\/\/127\.0\.0\.1(:\d+)?$/i.test(String(h.baseUrl || ''))) return null // 端口未知：等插件第一次被请求
    if (!/^[a-f0-9]{32,80}$/.test(String(h.token || ''))) return null
    if (!/^\/.+/.test(String(h.api || ''))) h.api = '/aurabot/api/ext/pet'
    return { baseUrl: String(h.baseUrl).replace(/\/+$/, ''), token: h.token, api: h.api }
  } catch { return null }
}

// ---------- 桌宠服务端访问 ----------
async function apiGet(pathname, query) {
  const host = readHost()
  if (!host) return null
  const url = `${host.baseUrl}${host.api}${pathname}${query ? '?' + new URLSearchParams(query) : ''}`
  const res = await fetch(url, { headers: { 'x-pet-token': host.token }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}
function apiPost(pathname, body) {
  const host = readHost()
  if (!host) return
  fetch(`${host.baseUrl}${host.api}${pathname}`, {
    method: 'POST',
    headers: { 'x-pet-token': host.token, 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).catch(() => {})
}
/** 素材地址：GET /asset/<包>/<文件>?token=（<video> 标签带不了自定义头，token 走查询参数）。 */
function assetUrl(packName, file) {
  const host = readHost()
  if (!host) return ''
  return `${host.baseUrl}${host.api}/asset/${encodeURIComponent(packName)}/${encodeURIComponent(file)}?token=${host.token}`
}
/** 把当前形象包推给渲染页：素材地址表 + 池 + 权重 + 物理参数。 */
function pushPackToRenderer() {
  if (!win || win.isDestroyed()) return
  const view = pack && pack.name ? pack : null
  const anims = {}
  if (view) {
    const names = new Set()
    for (const k of ['idle', 'speak', 'click']) for (const n of view.animations[k] || []) names.add(n)
    for (const n of names) anims[n] = assetUrl(view.name, `${n}.webm`)
  }
  const js = `window.__setPack && window.__setPack(${JSON.stringify({
    anims,
    pools: view ? view.animations : { idle: [], speak: [], click: [] },
    weights: view ? view.weights : {},
    events: view ? view.events : {},
    physics: view ? view.physics : null,
  })})`
  win.webContents.executeJavaScript(js).catch(() => {})
}
async function refreshConfig() {
  try {
    const cfg = await apiGet('/config')
    if (cfg && cfg.ok) {
      const changed = JSON.stringify(pack) !== JSON.stringify(cfg.pack || null)
      pack = cfg.pack || null
      focusOn = cfg.focus === true
      if (changed || !win.__packPushed) { win.__packPushed = true; pushPackToRenderer() }
    }
  } catch {}
}

// ---------- 气泡 / 动画点播（P2） ----------
async function showBubble(text, mood, modality, anim, playbackId) {
  if (!win) return
  const secs = Math.min(30, Math.max(6.5, 4.5 + String(text).length * 0.11))
  const js = `window.__bubble && window.__bubble(${JSON.stringify(String(text || ''))}, ${JSON.stringify(String(mood || 'neutral'))}, ${secs}, ${JSON.stringify(String(anim || ''))}, ${JSON.stringify(String(playbackId || ''))})`
  try {
    const played = await win.webContents.executeJavaScript(js)
    // __bubble 返回实际起播的动画与回执号（没有可用素材时 anim 为空 → 不上报）
    if (played && played.playbackId) apiPost('/playback', { playbackId: played.playbackId, anim: played.anim || '', status: 'played' })
  } catch {}
}
function hideBubble() {
  if (!win) return
  win.webContents.executeJavaScript('window.__hideBubble && window.__hideBubble()').catch(() => {})
}

// ---------- 长轮询主循环 ----------
let running = true
async function pollLoop() {
  let attempt = 0
  while (running) {
    const host = readHost()
    if (!host) { await sleep(5000); continue } // host.json 还没就绪（端口未知）：等插件第一次被请求
    try {
      const url = `${host.baseUrl}${host.api}/events?${new URLSearchParams({ ...(cursor != null ? { since: String(cursor) } : {}), wait: String(POLL_WAIT_MS / 1000), client: clientId })}`
      const res = await fetch(url, {
        headers: { 'x-pet-token': host.token },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const data = await res.json()
      attempt = 0
      const firstBoot = bootId && data.bootId !== bootId
      bootId = data.bootId
      cursor = data.cursor
      if (firstBoot) cursor = null // 插件重启过：这一轮只对齐水位，不消费旧事件，下一轮取增量
      for (const e of data.events || []) {
        if (e.type === 'pack') { pack = null; win.__packPushed = false; refreshConfig(); continue }
        if (e.type === 'proactive' && String(e.text || '').trim() && !firstBoot) {
          await showBubble(e.text, e.mood, e.modality, e.anim, e.playbackId)
        } else if (e.type === 'focus') {
          focusOn = e.enabled === true
          if (focusOn) hideBubble()
        }
      }
      refreshConfig() // 便宜：跟着轮询节奏对齐包配置与素材路由（新放素材也能被发现）
      await sleep(50)
    } catch {
      attempt++
      await sleep(Math.min(15_000, 1500 + attempt * 1500)) // 出错退避，并重读 host.json（端口可能漂了）
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 甩抛物理循环（P3：physics.throwStep，参数可被 pack 配置 physics 段覆盖） ----------
let thrower = null
function startThrow(vx, vy) {
  if (!win) return
  stopThrow()
  const [wx, wy] = win.getPosition()
  const [w, h] = win.getSize()
  const area = screen.getDisplayNearestPoint({ x: wx + w / 2, y: wy + h / 2 }).workArea
  const size = w
  const sideAllow = Math.round(size * 0.12) // 身体左右各内缩一点才贴边反弹
  const bounds = physics.throwBounds({ W: area.width, H: area.height, size, sideAllow })
  let st = { x: wx - area.x, y: wy - area.y, vx, vy }
  const ph = { ...physics.DEFAULT_PHYSICS, ...(pack && pack.physics ? pack.physics : {}) }
  let last = Date.now()
  const stepFrame = () => {
    if (!thrower || !win || win.isDestroyed()) return // 中途被 stopThrow / 关窗：停循环
    const now = Date.now()
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    let landed = 0
    const n = physics.throwSubsteps(st.vx, st.vy, dt)
    for (let i = 0; i < n; i++) {
      st = physics.throwStep(st, dt / n, bounds, ph)
      if (st.bounced && st.vy > 0) landed = Math.max(landed, Math.abs(st.vy))
      if (st.atRest) break
    }
    win.setPosition(Math.round(area.x + st.x), Math.round(area.y + st.y))
    if (landed > 60) win.webContents.executeJavaScript(`window.__squash && window.__squash(${Math.round(landed)})`).catch(() => {})
    if (st.atRest) {
      thrower = null
      win.webContents.executeJavaScript('window.__onThrowEnd && window.__onThrowEnd()').catch(() => {})
    } else {
      thrower = setImmediate(stepFrame)
    }
  }
  thrower = setImmediate(stepFrame)
}
function stopThrow() { thrower = null }

// ---------- IPC（渲染页拖拽/甩抛 → 主进程） ----------
ipcMain.on('pet:move', (_e, { x, y }) => { stopThrow(); if (win) win.setPosition(Math.round(x), Math.round(y)) })
ipcMain.on('pet:throw', (_e, { vx, vy }) => startThrow(Number(vx) || 0, Number(vy) || 0))
ipcMain.on('pet:throw-stop', () => stopThrow())
ipcMain.handle('pet:screen', () => {
  if (!win) return null
  const [x, y] = win.getPosition()
  const [w, h] = win.getSize()
  const area = screen.getDisplayNearestPoint({ x: x + w / 2, y: y + h / 2 }).workArea
  return { W: area.width, H: area.height, x, y, areaX: area.x, areaY: area.y, size: w }
})

// ---------- 窗口 / 托盘 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 280, height: 340,
    transparent: true, frame: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, resizable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.loadFile(path.join(__dirname, 'index.html'))
  win.once('ready-to-show', () => { pushPackToRenderer() })
  win.on('closed', () => { win = null })
}

function createTray() {
  try {
    const img = nativeImage.createFromBuffer(Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAEUlEQVR42mNk+M9Qz4AFMGETAG1hCQeukhTbAAAAAElFTkSuQmCC', 'base64'))
    tray = new Tray(img)
    tray.setToolTip('Aurabot 桌宠')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示 / 隐藏', click: () => (win ? (win.isVisible() ? win.hide() : win.show()) : createWindow()) },
      { label: '收起气泡', click: hideBubble },
      { type: 'separator' },
      { label: '退出桌宠', click: () => { running = false; app.quit() } },
    ]))
  } catch (e) { console.error('托盘创建失败（不影响气泡）：', e.message) }
}

app.on('second-instance', () => { if (win) { win.show(); win.focus() } })
app.whenReady().then(() => {
  createWindow()
  createTray()
  refreshConfig()
  pollLoop()
})
app.on('window-all-closed', () => {}) // 关窗不退出，从托盘退
