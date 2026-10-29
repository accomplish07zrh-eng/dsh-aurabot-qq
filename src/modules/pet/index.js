// 桌宠模块（内置模块，id='pet'；注册在 src/modules/index.js 的 BUILTINS，全新安装即有）
// 作用：给「主动搭话」提供一个桌面悬浮窗载体。插件侧只做三件事：
//   1. 在 /aurabot/api/* 挂一组 HTTP 长轮询接口（内置模块 route 无前缀；api.route 没有 WebSocket/SSE，R6）；
//   2. 往自己的数据目录写 host.json（baseUrl+token 契约，照 surfcore 的桌宠发现协议）；
//   3. 暴露 dispatch({text,...})：carrier=pet 且桌宠在线 → 推气泡；离线 → 回落 QQ；永不双发。
// 数据一律写 api.dataDir()（R11：模块文件夹不写数据，会被拍快照；api.dataDir 已带模块名 pet）。
// 桌宠 Electron 客户端源码在旁边的 pet-client/ 里，由 POST /client/install 生成到数据目录，Electron 由用户自装。
//
// 载体契约（给 purpose/speakup 模块用，详见 docs/PET_MODULE_API.md）：
//   · 配置：ext.pet.carrier（'qq'|'pet'，默认 qq）、ext.pet.modality（'text'|'voice'）、ext.pet.petFallbackToQQ（默认 true）
//   · api.use('pet').dispatch({ text, modality?, purpose?, force?, anim? }) → { ok, via:'pet'|'qq', ... }
//   · focus.json 开着时自动轮次一律不发（也不回落）；force=true（面板手动测试）可绕过

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, renameSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'

const ONLINE_TTL = 60_000        // 心跳超时：60 秒内没轮询过 /events 就算离线
const EVENT_LIMIT = 200          // 事件内存队列上限
const WAIT_CAP = 60_000          // 长轮询最长挂起时间（客户端用 25s）

export default {
  id: 'pet',
  name: '桌宠',
  version: '1.0.0',
  api: 1,
  description: '桌面悬浮窗桌宠：主动发言走气泡（可选语音），与 QQ 私聊载体互斥回落',
  files: ['modules/pet/pet-client/main.js', 'modules/pet/pet-client/preload.js', 'modules/pet/pet-client/index.html', 'modules/pet/pet-client/physics.js', 'modules/pet/pet-client/README.md'],

  defaults: { carrier: 'qq', modality: 'text', petFallbackToQQ: true, pack: 'default' },
  settings: [
    { key: 'carrier', label: '主动搭话载体', type: 'select', options: [{ value: 'qq', label: 'QQ 私聊' }, { value: 'pet', label: '桌宠气泡' }], hint: 'pet 时桌宠不在线会按下面的开关回落到 QQ；两边永不双发' },
    { key: 'modality', label: '气泡形式', type: 'select', options: [{ value: 'text', label: '文字气泡' }, { value: 'voice', label: '文字 + 语音' }], hint: '语音失败自动降级为纯文字' },
    { key: 'petFallbackToQQ', label: '桌宠离线回落 QQ', type: 'switch' },
  ],

  setup(api) {
    const voiceDir = () => api.dataDir('voice')
    const hostFile = () => api.dataDir('host.json')
    const tokenFile = () => api.dataDir('host-token')
    const focusFile = () => api.dataDir('focus.json')

    const readJson = (file, fallback = null) => {
      try {
        const raw = readFileSync(file, 'utf8')
        return raw.trim() ? JSON.parse(raw) : fallback
      } catch { return fallback }
    }
    const writeJsonAtomic = (file, data) => {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.${randomBytes(3).toString('hex')}.tmp`
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
      try { renameSync(tmp, file) } catch { writeFileSync(file, JSON.stringify(data, null, 2), 'utf8') }
    }

    // ---------- 令牌（host-token：32~80 位 hex，已生成过就直接复用） ----------
    let tokenCache = ''
    function token() {
      if (tokenCache) return tokenCache
      try {
        const raw = readFileSync(tokenFile(), 'utf8').trim()
        if (/^[a-f0-9]{32,80}$/.test(raw)) { tokenCache = raw; return raw }
      } catch {}
      const next = randomBytes(24).toString('hex') // 48 位 hex
      try {
        mkdirSync(dirname(tokenFile()), { recursive: true })
        writeFileSync(tokenFile(), next, 'utf8')
      } catch (error) { api.log.warn('写 host-token 失败：', String(error.message || error)) }
      tokenCache = next
      return next
    }
    const safeEqual = (a, b) => {
      if (!a || !b || a.length !== b.length) return false
      try { return timingSafeEqual(Buffer.from(a), Buffer.from(b)) } catch { return false }
    }

    // ---------- host.json（baseUrl 端口会漂移：从请求 Host 头学习，R9） ----------
    let knownPort = ''
    let lastHostWriteAt = 0
    function writeHostFile(force = false) {
      const now = Date.now()
      if (!force && now - lastHostWriteAt < 5000) return
      lastHostWriteAt = now
      const data = {
        version: 1,
        baseUrl: `http://127.0.0.1:${knownPort || '0'}`, // 端口未知时写 0：客户端探测失败会重读本文件
        token: token(),
        api: `/aurabot/api`,
        pluginVersion: api.version,
        updatedAt: new Date(now).toISOString(),
      }
      try { writeJsonAtomic(hostFile(), data) } catch (error) { api.log.warn('写 host.json 失败：', String(error.message || error)) }
    }
    /** 从请求 Host 头学习真实端口（回环校验也看它）；变了就重写 host.json。 */
    function learnHost(req) {
      const raw = String(req?.headers?.host || '')
      // IPv6 字面量 [::1]:端口 或 普通主机:端口；贪婪匹配会把端口吃进主机名，这里显式分分支
      const m = raw.match(/^\[([^\]]+)\](?::(\d+))?$/) || raw.match(/^([^:\]]+)(?::(\d+))?$/)
      if (!m) return null
      const host = String(m[1] || '').toLowerCase()
      const port = m[2] || ''
      if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return { host, port, loopback: false }
      if (port && port !== knownPort) { knownPort = port; writeHostFile(true) }
      return { host, port, loopback: true }
    }

    // ---------- 准入：回环 Host → 非 GET 同源 + JSON → 定长令牌比对 ----------
    function deny(res, code, message) {
      api.core.http.send(res, code, { ok: false, message })
      return { ok: false, code, message }
    }
    function guard(req, res, { queryTokenOk = false } = {}) {
      const learned = learnHost(req)
      if (!learned || !learned.loopback) return deny(res, 403, '只接受本机回环访问（Host 头必须指向 127.0.0.1）')
      const isGet = (req.method || 'GET').toUpperCase() === 'GET'
      if (!isGet) {
        const origin = String(req.headers?.origin || '')
        if (origin) {
          try {
            const o = new URL(origin)
            if (!['127.0.0.1', 'localhost', '[::1]'].includes(o.hostname.toLowerCase())) return deny(res, 403, '跨站请求被拒绝')
          } catch { return deny(res, 403, '跨站请求被拒绝') }
        }
        const ct = String(req.headers?.['content-type'] || '')
        if (!ct.includes('application/json')) return deny(res, 415, '写操作必须是 application/json')
      }
      const q = api.core.http.query(req)
      const given = String(req.headers?.['x-pet-token'] || (queryTokenOk ? q.token || '' : '') || '')
      if (!safeEqual(given, token())) return deny(res, 401, '桌宠令牌无效：先运行一次桌宠客户端（令牌在数据目录 pet/host-token）')
      return { ok: true, query: q }
    }

    // ---------- 事件队列（纯内存，重启即丢；bootId 变了客户端要重取水位） ----------
    let seq = 0
    const queue = []
    const bootId = randomBytes(6).toString('hex')
    const presence = new Map() // clientId → lastSeenAt
    const waiters = new Set()  // 长轮询的唤醒函数
    const wakeAll = () => { for (const w of [...waiters]) { waiters.delete(w); try { w() } catch {} } }

    function emit(type, payload = {}) {
      queue.push({ id: ++seq, at: Date.now(), type, ...payload })
      if (queue.length > EVENT_LIMIT) queue.splice(0, queue.length - EVENT_LIMIT)
      wakeAll()
    }

    const prunePresence = (now = Date.now()) => { for (const [k, t] of presence) if (now - t > ONLINE_TTL) presence.delete(k) }
    function online() {
      prunePresence()
      let lastSeenAt = 0
      for (const t of presence.values()) lastSeenAt = Math.max(lastSeenAt, t)
      return { online: lastSeenAt > 0, lastSeenAt, clients: presence.size }
    }

    // ---------- 专注模式（focus.json：读不到 / 坏了一律按关闭，fail-open 但不 crash） ----------
    function focusOn() {
      const f = readJson(focusFile(), null)
      return Boolean(f && typeof f === 'object' && f.enabled === true)
    }
    function setFocus(enabled, source = 'pet') {
      const data = { enabled: enabled === true, updatedAt: new Date().toISOString(), source: String(source || '').slice(0, 24) }
      try { writeJsonAtomic(focusFile(), data) } catch (error) { api.log.warn('写 focus.json 失败：', String(error.message || error)) }
      emit('focus', { enabled: data.enabled })
      return data
    }

    // ---------- pet pack（换形象，仿 dsh-pet 目录约定；素材只放数据目录，插件目录禁放 .webm） ----------
    // <dataDir>/packs/<名>-config.json + <名>-animation/*.webm；default 包 = default-animation/。
    // 素材版权注意：dsh-pet 形象「大肥鱼」是 CC BY-NC-SA 4.0，用户自备，不随插件分发（见 README / PET_MODULE_API.md）。
    const packsDir = () => api.dataDir('packs')
    const NAME_RE = /^[\w\u4e00-\u9fa5-]{1,40}$/
    const FILE_RE = /^[\w\u4e00-\u9fa5 .()（）-]{1,80}\.(webm|png|json)$/i
    const animsDirOf = (name) => join(packsDir(), `${name}-animation`)
    const configOfPack = (name) => join(packsDir(), `${name}-config.json`)

    /** 扫描 packs/：返回 [{name, hasConfig, anims:[文件名]}]。坏目录/坏配置只跳过不炸。 */
    function listPacks() {
      const out = []
      let entries = []
      try { mkdirSync(packsDir(), { recursive: true }); entries = readdirSync(packsDir(), { withFileTypes: true }) } catch { return out }
      for (const e of entries) {
        const m = String(e.name || '').match(/^(.+)-animation$/)
        if (!e.isDirectory() || !m || !NAME_RE.test(m[1])) continue
        const name = m[1]
        let anims = []
        try { anims = readdirSync(animsDirOf(name)).filter((f) => FILE_RE.test(f) && /\.webm$/i.test(f)) } catch {}
        out.push({ name, hasConfig: existsSync(configOfPack(name)), anims })
      }
      return out
    }
    /** 归一化一个包的配置：动画池（idle/speak/click）+ 权重 + 事件映射 + 物理参数；缺失回落默认。
     *  池里写「动画名」（不带 .webm 扩展名，仿 dsh-pet 约定），只保留目录里真实存在的。 */
    function normalizePackConfig(name, raw, anims) {
      const names = (anims || []).map((f) => String(f).replace(/\.webm$/i, ''))
      const pools = (raw && typeof raw === 'object' && raw.animations && typeof raw.animations === 'object') ? raw.animations : {}
      const poolOf = (k) => (Array.isArray(pools[k]) ? pools[k].filter((n) => names.includes(String(n))) : [])
      const weights = { idle: 60, speak: 25, click: 15, ...((raw && typeof raw.weights === 'object') ? raw.weights : {}) }
      const events = { proactive: 'speak', focus: '', ...((raw && typeof raw.events === 'object') ? raw.events : {}) }
      const physics = { gravity: 1400, restitution: 0.78, groundFriction: 2.5, ceilingBounce: true, throwPower: 1, ...((raw && typeof raw.physics === 'object') ? raw.physics : {}) }
      return { name, animations: { idle: poolOf('idle'), speak: poolOf('speak'), click: poolOf('click') }, weights, events, physics }
    }
    /** 当前生效的包：settings.pack 优先，其次 default，其次第一个扫到的，再没有就是 null（客户端回静态形象）。 */
    function activePack() {
      const s = api.settings()
      const packs = listPacks()
      const hit = packs.find((p) => p.name === s.pack)
      if (hit) return hit.name
      if (packs.some((p) => p.name === 'default')) return 'default'
      return packs[0]?.name || null
    }
    /** 给客户端的包视图（/config 的 pack 字段）：null = 没有任何素材，走静态形象。 */
    function packView() {
      const name = activePack()
      if (!name) return null
      const pack = listPacks().find((p) => p.name === name)
      const raw = pack?.hasConfig ? readJson(configOfPack(name), null) : null
      return normalizePackConfig(name, raw, pack.anims)
    }

    // ---------- 动作点播回执（P2：客户端播完 /playback 上报，留最近 50 条） ----------
    const playbacks = []
    function recordPlayback(entry) {
      playbacks.push({ ...entry, at: Date.now() })
      if (playbacks.length > 50) playbacks.splice(0, playbacks.length - 50)
    }

    // ---------- 心情 → 表情枚举（客户端按枚举切姿态） ----------
    const moodOf = (v) => (v >= 85 ? 'very-happy' : v >= 70 ? 'happy' : v >= 50 ? 'neutral' : v >= 35 ? 'low' : 'sad')
    function moodNow() {
      try {
        const m = api.use('mood')
        const v = typeof m?.current === 'function' ? Number(m.current()) : NaN
        return Number.isFinite(v) ? moodOf(v) : 'neutral'
      } catch { return 'neutral' }
    }

    // ---------- TTS 转存（voice.speak 产物 24h 清理，推给桌宠前先拷进 pet 数据目录，R13） ----------
    const audioRoutes = new Set()
    function pruneVoiceDir() {
      try {
        for (const n of readdirSync(voiceDir())) {
          const p = join(voiceDir(), n)
          if (Date.now() - statSync(p).mtimeMs > 86400_000) { try { unlinkSync(p) } catch {} ; audioRoutes.delete(n) }
        }
      } catch {}
    }
    function registerAudioRoute(key, file) {
      const path = `/audio/${key}`
      if (audioRoutes.has(path)) return
      audioRoutes.add(path)
      api.route(path, async (req, res) => {
        if (!guard(req, res, { queryTokenOk: true }).ok) return
        let buf = null
        try { buf = readFileSync(file) } catch {}
        if (!buf) return api.core.http.send(res, 404, { ok: false, message: '音频不存在或已过期' })
        try {
          res.statusCode = 200
          res.setHeader?.('content-type', 'audio/wav')
          res.setHeader?.('cache-control', 'private, max-age=86400') // 带 token 的 URL 不能进共享缓存
          res.setHeader?.('content-length', String(buf.length))
          res.end?.(buf)
        } catch {}
      })
    }
    /** 把一个音频文件转存进 pet 数据目录（内容寻址），返回 {key,url,durationMs}；失败返回 null。 */
    function storeVoice(file) {
      try {
        if (!file || !existsSync(file)) return null
        const buf = readFileSync(file)
        const key = `${createHash('sha1').update(buf).digest('hex')}.wav`
        mkdirSync(voiceDir(), { recursive: true })
        const dest = join(voiceDir(), key)
        if (!existsSync(dest)) writeFileSync(dest, buf)
        pruneVoiceDir()
        registerAudioRoute(key, dest)
        return { key: key.replace(/\.wav$/, ''), url: `/aurabot/api/audio/${key}?token=${token()}`, durationMs: Math.max(1200, Math.round(buf.length / 32)) }
      } catch (error) {
        api.log.warn('转存桌宠语音失败：', String(error?.message || error))
        return null
      }
    }

    // ---------- 气泡投递（载体互斥 + 回落；永不双发） ----------
    const delivered = [] // 最近推过的气泡（/history 用）
    const ownerChatId = () => `private:${api.config().ownerQQ}`

    async function speakFor(text) {
      try {
        const voice = api.has('voice') ? api.use('voice') : null
        if (!voice || typeof voice.speak !== 'function') return { ok: false, error: 'voice 模块没在跑' }
        const { file } = await voice.speak(text)
        const audio = storeVoice(file)
        return audio ? { ok: true, audio } : { ok: false, error: '语音转存失败' }
      } catch (error) {
        return { ok: false, error: String(error?.message || error).slice(0, 120) }
      }
    }

    /**
     * 主动发言的唯一入口（purpose/speakup 调这个，别自己两边发）。
     * @param {object} o
     * @param {string} o.anim   可选：指定点播的动作名（P2），事件会带 anim + playbackId 回执号
     * @returns {Promise<{ok:boolean, via?:'pet'|'qq', reason?:string, fallback?:boolean, message?:object}>}
     */
    async function dispatch({ text, modality = '', purpose = '', force = false, anim = '' } = {}) {
      const t = String(text || '').trim()
      if (!t) return { ok: false, reason: 'empty' }
      const s = api.settings()
      if (s.carrier !== 'pet') return { ok: false, via: 'qq', reason: 'carrier-qq' } // 载体是 QQ：交给 purpose 自己走 QQ，桌宠不碰
      if (!force && focusOn()) return { ok: false, reason: 'focus' } // 专注模式：不发也不回落
      const on = online()
      if (on.online) {
        const mode = modality === 'voice' || (!modality && s.modality === 'voice') ? 'voice' : 'text'
        let audio = null
        let voiceError = ''
        if (mode === 'voice') {
          const v = await speakFor(t)
          if (v.ok) audio = v.audio
          else voiceError = v.error // TTS 失败：降级纯文字气泡
        }
        const animName = String(anim || '').slice(0, 40)
        const playbackId = animName ? randomBytes(4).toString('hex') : '' // 点播动画带回执号，客户端播完 POST /playback
        const message = {
          type: 'proactive',
          text: t.slice(0, 600),
          modality: mode,
          audio,
          voiceError: audio ? '' : voiceError,
          mood: moodNow(),
          purpose: String(purpose || '').slice(0, 40),
          messageId: randomBytes(6).toString('hex'),
        }
        if (animName) { message.anim = animName; message.playbackId = playbackId } // P2：可选动画点播字段
        emit('proactive', message)
        delivered.push({ ...message, at: Date.now() })
        if (delivered.length > 100) delivered.splice(0, delivered.length - 100)
        api.log.info(`桌宠气泡（${mode}${audio ? '+语音' : ''}${animName ? '+' + animName : ''}）：${t.slice(0, 40)}`)
        return { ok: true, via: 'pet', message }
      }
      if (s.petFallbackToQQ !== false) {
        try {
          await api.sendText(ownerChatId(), t)
          api.log.info(`桌宠离线，主动发言回落 QQ：${t.slice(0, 40)}`)
          return { ok: true, via: 'qq', fallback: true }
        } catch (error) {
          return { ok: false, reason: 'fallback-failed', error: String(error?.message || error).slice(0, 120) }
        }
      }
      return { ok: false, reason: 'pet-offline' }
    }

    // ---------- 长轮询 /events ----------
    async function pollEvents(req, res) {
      const g = guard(req, res)
      if (!g.ok) return
      learnHost(req)
      const q = g.query
      const client = String(q.client || '').slice(0, 40) || 'anon'
      presence.set(client, Date.now())
      let since = q.since === undefined || q.since === '' ? null : Number(q.since)
      if (since !== null && !Number.isFinite(since)) since = null
      let wait = Number(q.wait)
      if (!Number.isFinite(wait) || wait < 0) wait = 0
      wait = Math.min(WAIT_CAP, wait)
      const deadline = Date.now() + wait
      for (;;) {
        prunePresence()
        presence.set(client, Date.now()) // 等待期间也算心跳
        if (since === null || since > seq) {
          // 新客户端 / 插件重启过的旧游标：只对齐水位，不重放旧气泡
          api.core.http.send(res, 200, { ok: true, bootId, cursor: seq, events: [], online: online(), serverTime: Date.now() })
          return
        }
        const events = queue.filter((e) => e.id > since)
        if (events.length || Date.now() >= deadline) {
          api.core.http.send(res, 200, { ok: true, bootId, cursor: seq, events, focus: focusOn(), serverTime: Date.now() })
          return
        }
        await new Promise((resolve) => {
          const timer = setTimeout(done, Math.max(50, Math.min(1000, deadline - Date.now())))
          const wake = () => { clearTimeout(timer); done() }
          function done() { waiters.delete(wake); resolve() }
          waiters.add(wake)
        })
      }
    }

    // ---------- 客户端安装：把 pet-client 源码生成到数据目录（模块目录禁写数据，R11） ----------
    function installClient() {
      const src = join(api.dir, 'pet-client')
      const dest = api.dataDir('app')
      const files = ['main.js', 'preload.js', 'index.html', 'physics.js', 'README.md']
      const copied = []
      try {
        mkdirSync(dest, { recursive: true })
        for (const f of files) {
          const from = join(src, f)
          if (!existsSync(from)) continue
          copyFileSync(from, join(dest, f))
          copied.push(f)
        }
        // 数据目录里的 host.json 已经写好，客户端起来就能发现插件
        writeHostFile(true)
        return {
          ok: copied.length > 0,
          dir: dest,
          files: copied,
          message: copied.length
            ? `客户端已生成到 ${dest}。在本机装好 Electron 后，在该目录运行 npx electron main.js（详见 README.md）。`
            : `模块目录里没找到 pet-client 源码（${src}）`,
        }
      } catch (error) {
        return { ok: false, message: '生成客户端失败：' + String(error?.message || error).slice(0, 160) }
      }
    }

    // ---------- pet pack 与素材路由（P1/P4）：packs 目录只读给客户端，404 绝不回落别的包 ----------
    // 注意：模块 route 是「全路径精确匹配」（mods.handle 不做前缀匹配），所以素材按
    //   /asset/<包名>/<文件名> 一条条注册；ensureAssetRoutes() 在启动和每次客户端拉配置时刷新
    //   （新放了素材/新换了包，客户端下一次 /config 就能把路由补齐）。
    const MIME = { '.webm': 'video/webm', '.png': 'image/png', '.json': 'application/json; charset=utf-8' }
    const registeredAssets = new Set()
    function serveAsset(res, pack, file) {
      const dir = animsDirOf(pack)
      const full = join(dir, file)
      let buf = null
      try { buf = readFileSync(full) } catch {}
      if (!buf || !full.startsWith(dir)) return api.core.http.send(res, 404, { ok: false, message: '素材不存在' })
      try {
        res.statusCode = 200
        res.setHeader?.('content-type', MIME[file.toLowerCase().slice(file.lastIndexOf('.'))] || 'application/octet-stream')
        res.setHeader?.('cache-control', 'private, max-age=3600') // 带 token 的 URL 不能进共享缓存
        res.setHeader?.('content-length', String(buf.length))
        res.end?.(buf)
      } catch {}
    }
    function ensureAssetRoutes() {
      try {
        for (const pack of listPacks()) {
          for (const f of pack.anims) {
            const key = `/asset/${pack.name}/${f}`
            if (registeredAssets.has(key)) continue
            registeredAssets.add(key)
            api.route(key, (req, res) => {
              if (!guard(req, res, { queryTokenOk: true }).ok) return
              learnHost(req)
              serveAsset(res, pack.name, f) // 严格隔离：只服务自己包里的这个文件，404 不回落 default
            })
          }
        }
      } catch (error) { api.log.warn('注册素材路由失败：', String(error?.message || error)) }
    }

    // ---------- 路由 ----------
    api.route('/events', (req, res) => pollEvents(req, res))
    api.route('/status', (req, res) => {
      if (!guard(req, res).ok) return
      learnHost(req)
      const s = api.settings()
      api.core.http.send(res, 200, {
        ok: true, name: 'aurabot-pet', version: api.version,
        online: online(), focus: focusOn(), bootId, seq,
        carrier: s.carrier, modality: s.modality, fallbackToQQ: s.petFallbackToQQ !== false,
        pack: activePack(), playbackCount: playbacks.length,
        hostFile: hostFile(), clientDir: api.dataDir('app'), serverTime: Date.now(),
      })
    })
    api.route('/config', (req, res) => {
      if (!guard(req, res).ok) return
      learnHost(req)
      ensureAssetRoutes()
      const s = api.settings()
      api.core.http.send(res, 200, {
        ok: true,
        carrier: s.carrier, modality: s.modality, fallbackToQQ: s.petFallbackToQQ !== false,
        focus: focusOn(),
        moods: ['very-happy', 'happy', 'neutral', 'low', 'sad'],
        pack: packView(), // 动画池/权重/事件映射/物理参数；null = 没素材，客户端走静态形象
        serverTime: Date.now(),
      })
    })
    api.route('/packs', (req, res) => {
      if (!guard(req, res).ok) return
      learnHost(req)
      ensureAssetRoutes()
      api.core.http.send(res, 200, { ok: true, active: activePack(), packs: listPacks() })
    })
    api.route('/pack', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      const name = String(body.name || '').trim()
      if (!NAME_RE.test(name) || !listPacks().some((p) => p.name === name)) {
        return api.core.http.send(res, 404, { ok: false, message: `没有形象包「${name}」（packs/ 下要有 <名>-animation/ 目录）` })
      }
      api.saveSettings({ pack: name })
      ensureAssetRoutes()
      emit('pack', { pack: name })
      api.core.http.send(res, 200, { ok: true, pack: packView() })
    })
    // ---------- 动画播放回执（P2）：客户端播完点播动画后 POST {playbackId,status} ----------
    api.route('/playback', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      const playbackId = String(body.playbackId || '').slice(0, 32)
      if (!playbackId) return api.core.http.send(res, 400, { ok: false, message: '缺 playbackId' })
      recordPlayback({ playbackId, status: body.status === 'error' ? 'error' : 'played', anim: String(body.anim || '').slice(0, 40) })
      api.core.http.send(res, 200, { ok: true })
    })
    api.route('/history', (req, res) => {
      if (!guard(req, res).ok) return
      learnHost(req)
      api.core.http.send(res, 200, { ok: true, bootId, messages: delivered.slice(-60), playbacks: playbacks.slice(-20) })
    })
    api.route('/focus', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      const focus = setFocus(body.enabled === true, body.source || 'pet')
      api.core.http.send(res, 200, { ok: true, focus })
    })
    api.route('/bubble', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      // 面板/客户端手动测试：默认绕过专注模式（force）；可带 anim 点播一段动作
      const r = await dispatch({ text: body.text, modality: body.modality, purpose: 'test', force: body.force !== false, anim: body.anim })
      api.core.http.send(res, 200, r)
    })
    api.route('/client/install', async (req, res) => {
      if (!guard(req, res).ok) return
      api.core.http.send(res, 200, installClient())
    })

    // ---------- 启动 ----------
    writeHostFile(true)
    ensureAssetRoutes()
    const offHostTimer = api.every(120_000, () => { writeHostFile(true); ensureAssetRoutes() }, '刷新 host.json 与素材路由')
    api.onDispose(() => { offHostTimer(); waiters.clear(); presence.clear() })
    api.log.info(`桌宠模块就绪：host.json 在 ${hostFile()}（端口等第一次请求后自动校准）`)

    return {
      dispatch,
      push: dispatch,
      online,
      focus: focusOn,
      setFocus,
      moodOf,
      storeVoice,
      writeHostFile,
      installClient,
      download: async () => installClient(), // 面板经 /panel/pet/download 调这个（host.js 降级路径按有没有这个函数判断）
      packs: listPacks,
      activePack,
      packView,
      ensureAssetRoutes,
      status: () => ({ ...online(), focus: focusOn(), carrier: api.settings().carrier, modality: api.settings().modality, bootId, seq, pack: activePack(), playbackCount: playbacks.length }),
      state: () => ({ count: delivered.length }),
    }
  },
}
