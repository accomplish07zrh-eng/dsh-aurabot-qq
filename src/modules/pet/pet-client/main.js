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
const { execFile } = require('node:child_process')
const physics = require('./physics.js')
// 形象包元数据（池 ∪ 目录全量、菜单树），与 main.js 同目录生成。
// 容错：手工同步客户端时可能只拷了 main.js —— 缺了就退回「只认三个池」的老行为，绝不因此起不来。
let packmeta = null
try { packmeta = require('./packmeta.js') } catch (e) { console.error('缺少 packmeta.js，右键菜单只能列出 idle/speak/click 三个池：', e.message) }
const metaApi = packmeta || {
  knownAnims: (pools) => Object.values(pools || {}).flat(),
  animUrlMap: (names, makeUrl) => Object.fromEntries((names || []).map((n) => [n, makeUrl(n)]).filter(([, u]) => u)),
  labelsOf: (m) => Object.fromEntries(Object.entries(m || {}).filter(([, id]) => typeof id === 'string' && id).map(([o, id]) => [id, o])),
  resolveMenu: () => [],
}

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
  let anims = {}
  if (view) {
    // 关键：右键「动作」菜单能列出的动画远多于三个池（default 包 106 段里只有 26 段在池里）。
    // 地址表只按池建 → 菜单里另外 80 段点下去查不到 URL，渲染页静默 return false，
    // 桌宠就"一直在播自己的动画"。所以这里按「池 ∪ 包目录里的全部 webm」建表。
    const names = metaApi.knownAnims(view.animations, loadPackMeta().files)
    anims = metaApi.animUrlMap(names, (n) => assetUrl(view.name, `${n}.webm`))
  }
  const js = `window.__setPack && window.__setPack(${JSON.stringify({
    anims,
    pools: view ? view.animations : { idle: [], speak: [], click: [] },
    weights: view ? view.weights : {},
    events: view ? view.events : {},
    workStatus: view ? (view.workStatus || {}) : {}, // 干活状态 → 动画（服务端按命名约定/包配置解析好）
    physics: view ? view.physics : null,
  })})`
  win.webContents.executeJavaScript(js).catch(() => {})
}
let lastWorkKey = ''
async function refreshConfig() {
  try {
    const cfg = await apiGet('/config')
    if (cfg && cfg.ok) {
      const changed = JSON.stringify(pack) !== JSON.stringify(cfg.pack || null)
      pack = cfg.pack || null
      focusOn = cfg.focus === true
      if (changed || !win.__packPushed) { win.__packPushed = true; pushPackToRenderer() }
      // 干活状态：/config 也带当前档位（客户端重启/漏事件时靠它对一次，不弹提示、不再提醒）
      const key = `${(cfg.work && cfg.work.state) || ''}|${(cfg.work && cfg.work.task) || ''}`
      if (key !== lastWorkKey) {
        lastWorkKey = key
        applyWork({ state: (cfg.work && cfg.work.state) || '', task: (cfg.work && cfg.work.task) || '', text: '', notify: false })
      }
    }
  } catch {}
}

// ---------- 气泡 / 动画点播（P2） ----------
const BUBBLE_TAG = { test: '碎碎念', whisper: '碎碎念' }
async function showBubble(text, mood, modality, anim, playbackId, purpose, tagOverride) {
  if (!win) return
  const secs = Math.min(30, Math.max(6.5, 4.5 + String(text).length * 0.11))
  // 标签：菜单「碎碎念」/ 定时碎碎念 / 干活结束各有各的标签，别都标成「主动来找你」
  const tag = tagOverride || BUBBLE_TAG[purpose] || ''
  const js = `window.__bubble && window.__bubble(${JSON.stringify(String(text || ''))}, ${JSON.stringify(String(mood || 'neutral'))}, ${secs}, ${JSON.stringify(String(anim || ''))}, ${JSON.stringify(String(playbackId || ''))}, ${JSON.stringify(tag)})`
  try {
    const played = await win.webContents.executeJavaScript(js)
    // __bubble 返回实际起播的动画与回执号（没有可用素材时 anim 为空 → 不上报）
    if (played && played.playbackId) apiPost('/playback', { playbackId: played.playbackId, anim: played.anim || '', status: 'played' })
  } catch {}
}

// ---------- 干活状态（DSH 会话事件 → 动画 + 结束提醒） ----------
const WORK_TAG = { success: '干完啦', error: '出错了', waiting: '等你确认', thinking: '思考中', working: '干活中', result: '出结果了' }
let lastNotifyAt = 0
/** 系统通知（Windows 需要 AppUserModelID 才会显示；失败静默，不影响气泡）。 */
function notifyEnd(title, body) {
  try {
    const { Notification } = require('electron')
    if (!Notification || !Notification.isSupported()) return
    if (Date.now() - lastNotifyAt < 4000) return // 多会话同时收尾别连弹
    lastNotifyAt = Date.now()
    new Notification({ title: String(title || '大肥鱼'), body: String(body || ''), silent: false }).show()
  } catch {}
}
function applyWork(e) {
  const state = String(e.state || '')
  const text = String(e.text || '')
  const task = String(e.task || '')
  if (win && !win.isDestroyed()) {
    win.webContents.executeJavaScript(`window.__setWork && window.__setWork(${JSON.stringify(state)}, ${JSON.stringify(task)})`).catch(() => {})
  }
  if (!text) return
  // 结束提醒：气泡（workBubble）+ 系统通知（workNotify），两个开关都来自面板设置（服务端判定后下发）
  if (e.bubble !== false) showBubble(text, '', 'text', '', '', 'work', WORK_TAG[state] || '干活状态')
  if (e.notify !== false) notifyEnd(state === 'error' ? '出错了…' : '忙完啦', text)
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
        if (e.type === 'work') { applyWork(e); continue }
        if (e.type === 'proactive' && String(e.text || '').trim() && !firstBoot) {
          await showBubble(e.text, e.mood, e.modality, e.anim, e.playbackId, e.purpose)
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
// 两个坑（都是「扔出去就卡死」的直接原因）：
//   1) 不能用 setImmediate 递归驱动：每秒会跑几千帧，每帧同步调一次 win.setPosition，
//      主进程/窗口线程被空转调用打满，桌宠看起来就定住了。这里固定 60fps。
//   2) 边界必须用真实身体盒：素材是 1:1 正方形（宽 240 → 高也是 240），宠物画在窗口底部，
//      若按 宽×9/16 当身体高，静止点会比屏幕底还低 183px —— 一扔就掉出屏幕外再也不回来。
const THROW_FRAME_MS = 16   // ≈60fps
const THROW_MAX_MS = 10000  // 一次抛掷最多算 10 秒，之后强制落地（兜底，绝不留半空死状态）
const BODY = { left: 20, bottom: 16, width: 240, height: 240 } // 与 index.html 的 #stage 一致（1:1 素材）
let thrower = null          // 抛掷循环定时器句柄（非空 = 正在飞）

/** 可见身体（#stage）在窗口内的盒子：offsetX/offsetY 是身体左上角相对窗口左上角的偏移。 */
function bodyBox(w, h) {
  const width = Math.min(BODY.width, w)
  const height = Math.min(BODY.height, Math.max(32, h - BODY.bottom))
  return { width, height, offsetX: Math.max(0, Math.min(BODY.left, w - width)), offsetY: Math.max(0, h - BODY.bottom - height) }
}
function stopThrow() {
  if (thrower) { clearTimeout(thrower); thrower = null }
}
/** 把窗口拉回工作区（历史 bug 可能已把桌宠扔到屏幕外，启动/显示时兜一下）。 */
function clampWindowToArea() {
  if (!win || win.isDestroyed()) return
  const [wx, wy] = win.getPosition()
  const [w, h] = win.getSize()
  const area = screen.getDisplayNearestPoint({ x: wx + w / 2, y: wy + h / 2 }).workArea
  const nx = Math.round(Math.min(Math.max(wx, area.x), area.x + area.width - w))
  const ny = Math.round(Math.min(Math.max(wy, area.y), area.y + area.height - h))
  if (nx !== Math.round(wx) || ny !== Math.round(wy)) win.setPosition(nx, ny)
}
function startThrow(vx, vy) {
  if (!win || win.isDestroyed()) return
  stopThrow()
  const [wx, wy] = win.getPosition()
  const [w, h] = win.getSize()
  const area = screen.getDisplayNearestPoint({ x: wx + w / 2, y: wy + h / 2 }).workArea
  const body = bodyBox(w, h)
  const bounds = physics.throwBounds({
    W: area.width,
    H: area.height,
    bodyW: body.width,
    bodyH: body.height,
    offsetX: body.offsetX,
    offsetY: body.offsetY,
    sideAllow: Math.round(body.width * 0.08), // 身体左右各内缩一点才贴边反弹
  })
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)
  // 起点也夹进边界：上次若被扔到屏幕外，这一次甩就自动把桌宠拉回来
  let st = { x: clamp(wx - area.x, bounds.minX, bounds.maxX), y: clamp(wy - area.y, bounds.minY, bounds.maxY), vx, vy }
  const ph = { ...physics.DEFAULT_PHYSICS, ...(pack && pack.physics ? pack.physics : {}) }
  const t0 = Date.now()
  let last = t0
  let lastPos = ''
  let squashAt = 0
  let squashCount = 0
  const finish = () => {
    stopThrow()
    if (win && !win.isDestroyed()) win.webContents.executeJavaScript('window.__onThrowEnd && window.__onThrowEnd()').catch(() => {})
  }
  const stepFrame = () => {
    thrower = null
    if (!win || win.isDestroyed()) return
    const now = Date.now()
    const dt = Math.min(0.05, Math.max((now - last) / 1000, 1e-4)) // 巨帧/同毫秒多帧都夹住
    last = now
    let impact = 0
    const n = physics.throwSubsteps(st.vx, st.vy, dt)
    for (let i = 0; i < n; i++) {
      st = physics.throwStep(st, dt / n, bounds, ph)
      if (st.bounced && st.vy > 0) impact = Math.max(impact, Math.abs(st.vy))
      if (st.atRest) break
    }
    if (now - t0 > THROW_MAX_MS) st = { ...st, y: bounds.maxY, vx: 0, vy: 0, atRest: true } // 超时兜底：直接落地
    const px = Math.round(area.x + st.x)
    const py = Math.round(area.y + st.y)
    const key = px + ',' + py
    if (key !== lastPos) { // 位置没变就不调原生接口：每秒几百次空搬运同样能把窗口拖死
      lastPos = key
      try { win.setPosition(px, py) } catch { finish(); return } // 窗口没了/参数异常：立刻收尾，不留半空状态
    }
    // 落地挤压限流：一次抛掷最多挤 2 次、间隔 400ms（原来每帧都发，渲染页会堆几十个 rAF 循环）
    if (impact > 600 && squashCount < 2 && now - squashAt > 400) {
      squashCount++
      squashAt = now
      win.webContents.executeJavaScript(`window.__squash && window.__squash(${Math.round(impact)})`).catch(() => {})
    }
    if (st.atRest) { finish(); return }
    thrower = setTimeout(stepFrame, THROW_FRAME_MS)
  }
  thrower = setTimeout(stepFrame, THROW_FRAME_MS)
}

// ---------- IPC（渲染页拖拽/甩抛 → 主进程） ----------
ipcMain.on('pet:move', (_e, { x, y }) => {
  stopThrow()
  if (!win || !Number.isFinite(x) || !Number.isFinite(y)) return
  win.setPosition(Math.round(x), Math.round(y))
})
ipcMain.on('pet:throw', (_e, { vx, vy }) => startThrow(Number(vx) || 0, Number(vy) || 0))
ipcMain.on('pet:throw-stop', () => stopThrow())
// 渲染页命中检测：true=鼠标在宠物/气泡上（恢复窗口交互），false=在透明区（放行点击）
ipcMain.on('pet:hit', (_e, hit) => {
  if (!win || win.isDestroyed()) return
  try { win.setIgnoreMouseEvents(!hit, { forward: true }) } catch {}
})
ipcMain.handle('pet:screen', () => {
  if (!win) return null
  const [x, y] = win.getPosition()
  const [w, h] = win.getSize()
  const area = screen.getDisplayNearestPoint({ x: x + w / 2, y: y + h / 2 }).workArea
  return { W: area.width, H: area.height, x, y, areaX: area.x, areaY: area.y, size: w }
})

// ---------- 右键菜单（仿 dsh-pet 的菜单树：工具项 + 「动作」分类级联，动画显示原名） ----------
/** 读形象包配置、原名映射与素材文件表：直接读盘（packs 就在 host.json 旁边），不依赖插件版本。
 *  返回 { manifest: 原名→id, cfg: 包配置（含 menu 分类）, labels: id→原名, files: 包目录里的文件名 }。 */
function loadPackMeta() {
  const name = (pack && pack.name) || 'default'
  const dir = path.join(path.dirname(HOST_FILE), 'packs')
  const readJsonFile = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return null } }
  const manifest = readJsonFile(`${name}-manifest.json`) || {}
  const cfg = readJsonFile(`${name}-config.json`) || {}
  let files = []
  // 菜单要列全量动画，素材文件表是唯一可靠来源（插件 /config 只回三个池）
  try { files = fs.readdirSync(path.join(dir, `${name}-animation`)) } catch {}
  return { manifest, cfg, labels: metaApi.labelsOf(manifest), files }
}
/** 点播任意动画：交给渲染页强制插播（分类子菜单 / 单项都用它）。
 *  渲染页返回 false（地址表里没有这段，通常是刚放了素材 / 端口刚漂）→ 重推一次配置再试。 */
let playRetryPending = false
async function playAnimById(id) {
  if (!win || win.isDestroyed()) return false
  const run = () => win.webContents
    .executeJavaScript(`window.__playAnim && window.__playAnim(${JSON.stringify(String(id))})`)
    .catch(() => false)
  const ok = await run()
  if (ok !== false) return ok
  if (playRetryPending) return false
  playRetryPending = true
  try {
    win.__packPushed = false // 强制重推一次素材地址表
    await refreshConfig()
  } finally { playRetryPending = false }
  return win && !win.isDestroyed() ? run() : false
}
/** 回到初始位置：停掉飞行，回主屏右下角（仿 dsh-pet 的 home）。 */
function goHome() {
  if (!win || win.isDestroyed()) return
  stopThrow()
  const [w, h] = win.getSize()
  const area = screen.getPrimaryDisplay().workArea
  win.setPosition(area.x + area.width - w - 24, area.y + area.height - h - 16)
}
// 手动碎碎念文案池（真正的碎碎念由插件按面板里的间隔/文案池生成，这里只是插件不可达时的兜底）
const WHISPERS = ['在吗在吗？', '戳戳你～', '今天也要加油鸭！', '（盯着你看）', '摸鱼一时爽～', '想你啦！']
/** 碎碎念：先请插件走自己的碎碎念流程（/whisper：会带碎碎念动画 + 现想一句）；
 *  插件不可达/没这接口时才退回「本地文案 + 本地气泡」。专注模式下插件会拒绝——那就安静。 */
function whisper() {
  const sayLocal = (text) => win?.webContents.executeJavaScript(`window.__whisper && window.__whisper(${JSON.stringify(text)})`).catch(() => {})
  const h = readHost()
  if (!h) return sayLocal(WHISPERS[Math.floor(Math.random() * WHISPERS.length)])
  fetch(`${h.baseUrl}${h.api}/whisper`, {
    method: 'POST',
    headers: { 'x-pet-token': h.token, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  }).then((r) => r.json()).then((d) => {
    if (d && d.ok === true) return
    if (d && d.reason === 'focus') return // 专注模式：不打扰
    sayLocal(WHISPERS[Math.floor(Math.random() * WHISPERS.length)])
  }).catch(() => sayLocal(WHISPERS[Math.floor(Math.random() * WHISPERS.length)]))
}
/** 打开面板：DSH 面板在宿主窗口/浏览器标签里（根路径要一次性 token，不能直连），
 *  所以按「含本插件端口」的窗口标题把那个窗口切到前台；找不到再退 DSH 主窗口。 */
function openPanel() {
  const h = readHost()
  const port = h ? ((h.baseUrl.match(/:(\d+)/) || [])[1] || '') : ''
  const ps = [
    `$pat = ${JSON.stringify(port ? `*127.0.0.1:${port}*` : '*127.0.0.1*')}`,
    '$p = Get-Process | Where-Object { $_.MainWindowTitle -like $pat } | Select-Object -First 1',
    "if (-not $p) { $p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like '*DeepSeek*' } | Select-Object -First 1 }",
    'if (-not $p) { exit 1 }',
    "Add-Type -Namespace W -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int n);'",
    '[W.U]::ShowWindow($p.MainWindowHandle, 9) | Out-Null',
    '[W.U]::SetForegroundWindow($p.MainWindowHandle) | Out-Null',
    'exit 0',
  ].join('; ')
  const b64 = Buffer.from(ps, 'utf16le').toString('base64')
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', b64], (err) => {
    if (!err) return
    // 切不过去：至少告诉用户面板在哪
    win?.webContents.executeJavaScript(`window.__whisper && window.__whisper(${JSON.stringify('面板在浏览器标签 ' + (h ? h.baseUrl : '127.0.0.1') + ' 里～')})`).catch(() => {})
  })
}
ipcMain.on('pet:menu', () => {
  if (!win || win.isDestroyed()) return
  const { manifest, cfg } = loadPackMeta()
  const pools = (pack && pack.animations) || {}
  // 「动作」：优先用包配置里的全量分类（menu 段），没有就回落 idle/speak/click 三个池
  const cats = (pack && pack.name) ? metaApi.resolveMenu(cfg, manifest, pools) : []
  const actionSub = cats.length
    ? {
        label: '动作',
        submenu: cats.map((c) => ({
          label: c.label,
          submenu: c.items.map((it) => ({ label: it.label, click: () => { playAnimById(it.id) } })),
        })),
      }
    : null
  const menu = Menu.buildFromTemplate([
    { label: '碎碎念', click: whisper },
    { label: '回到初始位置', click: goHome },
    ...(actionSub ? [actionSub] : []),
    { label: '收起气泡', click: hideBubble },
    { type: 'separator' },
    { label: '打开面板', click: openPanel },
    { label: focusOn ? '关闭专注模式' : '开启专注模式', click: () => { focusOn = !focusOn; apiPost('/focus', { enabled: focusOn, source: 'pet-menu' }) } },
    { label: '隐藏桌宠', click: () => win?.hide() },
    { type: 'separator' },
    { label: '退出桌宠', click: () => { running = false; app.quit() } },
  ])
  menu.popup({ window: win })
})

// ---------- 窗口 / 托盘 ----------
function createWindow() {
  win = new BrowserWindow({
    // 窗口 280×430：16(底距) + 240(1:1 素材) + 12(缝) + 154(气泡) + 8(顶距)
    width: 280, height: 430,
    transparent: true, frame: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, resizable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  // 透明区域放行鼠标点击（不然 280×430 的窗口会挡住身后的一切）；
  // 渲染页检测到悬停在宠物/气泡上时发 pet:hit=true 恢复交互，离开再放行。
  try { win.setIgnoreMouseEvents(true, { forward: true }) } catch {}
  win.loadFile(path.join(__dirname, 'index.html'))
  win.once('ready-to-show', () => { clampWindowToArea(); pushPackToRenderer() })
  win.on('show', () => { clampWindowToArea(); stopThrow() }) // 重新显示时确保回到屏幕内、且没有残留的飞行循环
  win.on('hide', () => stopThrow())
  win.on('closed', () => { stopThrow(); win = null })
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
  // Windows 上没设 AppUserModelID 时系统通知会被静默丢掉（完工提醒依赖它）
  try { app.setAppUserModelId('com.aurabot.pet') } catch {}
  createWindow()
  createTray()
  refreshConfig()
  pollLoop()
})
app.on('window-all-closed', () => {}) // 关窗不退出，从托盘退
