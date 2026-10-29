// 桌宠模块（内置模块，id='pet'；注册在 src/modules/index.js 的 BUILTINS，全新安装即有）
//
// ⚠ 来源与许可（别误当成自研）：桌宠的客户端形态（Electron 透明置顶窗 + 长轮询 + 气泡）、拖拽物理、
// pet pack 目录约定、以及工作状态六档 / 碎碎念动画的命名约定，都移植自 dsh-pet
// （https://github.com/PC2005-cloud/dsh-pet ，作者 PC2005-cloud，代码 MIT）。
// 本项目做的是把它接进 Aurabot 的模块体系（api.route 长轮询、载体互斥、面板设置、DSH 会话事件联动）。
// 形象/动画素材（「大肥鱼」）是 CC BY-NC-SA 4.0，**不随本仓库分发**，用户自备。
// 完整署名与许可原文见仓库根 THIRD-PARTY-NOTICES.md。
//
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
import { spawn as nodeSpawn } from 'node:child_process'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'

const ONLINE_TTL = 60_000        // 心跳超时：60 秒内没轮询过 /events 就算离线
const EVENT_LIMIT = 200          // 事件内存队列上限
const WAIT_CAP = 60_000          // 长轮询最长挂起时间（客户端用 25s）
const MIN_MS = 60_000            // 一分钟（碎碎念间隔/静默窗口都用它）

export default {
  id: 'pet',
  name: '桌宠',
  version: '1.0.0',
  api: 1,
  description: '桌面悬浮窗桌宠（移植自 dsh-pet，代码 MIT）：主动发言走气泡（可选语音），与 QQ 私聊载体互斥回落',
  files: ['modules/pet/pet-client/main.js', 'modules/pet/pet-client/preload.js', 'modules/pet/pet-client/index.html', 'modules/pet/pet-client/physics.js', 'modules/pet/pet-client/packmeta.js', 'modules/pet/pet-client/README.md'],

  defaults: {
    carrier: 'qq', modality: 'text', petFallbackToQQ: true, pack: 'default',
    // 碎碎念（桌宠自己的气泡流，与「主动搭话」完全独立：载体选 QQ 时她也会在桌面上自己嘟囔）
    whisperEnabled: true,
    whisperSource: 'model',       // 'model' = 现想一句（失败回落本地池）/ 'pool' = 只用文案池
    whisperMinMinutes: 45,
    whisperMaxMinutes: 120,
    whisperMaxPerDay: 6,
    whisperLines: '',             // 自定义文案（一行一句；留空用内置池）
    whisperPauseOnPetCarrier: true, // 主动搭话已经走桌宠气泡时，碎碎念暂停（不同时冒两个气泡）
    // DSH 干活状态（思考/干活/完成…）联动：动画切换 + 结束提醒
    workStatusEnabled: true,
    workBubble: true,             // 干完活弹一句气泡
    workNotify: true,             // 干完活发系统通知（Electron 原生通知）
  },
  settings: [
    { key: 'carrier', label: '主动搭话载体', type: 'select', options: [{ value: 'qq', label: 'QQ 私聊' }, { value: 'pet', label: '桌宠气泡' }], hint: 'pet 时桌宠不在线会按下面的开关回落到 QQ；两边永不双发' },
    { key: 'modality', label: '气泡形式', type: 'select', options: [{ value: 'text', label: '文字气泡' }, { value: 'voice', label: '文字 + 语音' }], hint: '语音失败自动降级为纯文字' },
    { key: 'petFallbackToQQ', label: '桌宠离线回落 QQ', type: 'switch' },
    { key: 'whisperEnabled', label: '碎碎念', type: 'switch', hint: '只出现在桌宠气泡里，不会发到 QQ；载体是 QQ 时照常生效' },
    { key: 'whisperSource', label: '碎碎念内容', type: 'select', options: [{ value: 'model', label: '她自己想一句（工作区看得到思考）' }, { value: 'pool', label: '用现成文案' }] },
    { key: 'whisperMinMinutes', label: '碎碎念最短间隔（分钟）', type: 'number', min: 1, max: 9999 },
    { key: 'whisperMaxMinutes', label: '碎碎念最长间隔（分钟）', type: 'number', min: 1, max: 9999 },
    { key: 'whisperMaxPerDay', label: '碎碎念每日上限', type: 'number', min: 0, max: 9999 },
    { key: 'whisperLines', label: '碎碎念文案池', type: 'textarea', hint: '一行一句；留空用内置文案。选了「用现成文案」或模型失败时从这里抽' },
    { key: 'whisperPauseOnPetCarrier', label: '载体是桌宠时暂停碎碎念', type: 'switch', hint: '避免和「主动搭话」的气泡同时出现' },
    { key: 'workStatusEnabled', label: '干活状态动画', type: 'switch', hint: '跟着 DSH 会话切动画：思考中/干活中/等确认/完成/出错' },
    { key: 'workBubble', label: '完工弹一句气泡', type: 'switch' },
    { key: 'workNotify', label: '完工发系统通知', type: 'switch' },
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
        // 端口未就绪写 null（客户端 readHost 的正则不匹配就一直等，不再写假的 :0 造成自举死锁）；
        // 真实端口由宿主启动时经 setWebPort() 注入，Host 头学习保留作漂移纠正。
        baseUrl: knownPort ? `http://127.0.0.1:${knownPort}` : null,
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

    /** 宿主启动时注入真实 Web 端口（host.js 知道服务端口；Host 头学习保留作漂移纠正）。 */
    function setWebPort(port) {
      const n = Number(port)
      if (!Number.isInteger(n) || n <= 0 || n >= 65536) return false
      if (String(n) === knownPort) return true
      knownPort = String(n)
      writeHostFile(true)
      api.log.info(`桌宠：宿主注入 Web 端口 ${knownPort}，host.json 已就绪`)
      return true
    }
    const portReady = () => Boolean(knownPort)

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

    // ---------- 干活状态 / 碎碎念的动画映射（默认按 dsh-pet 的中文命名约定识别，可被包配置覆盖） ----------
    const WORK_STATES = ['thinking', 'working', 'result', 'waiting', 'success', 'error']
    // default 包（dsh-pet 那 106 段）里的命名就是这套，所以零配置也能直接切对动画
    const WORK_HINTS = {
      thinking: ['工作状态-思考', '深度思考', '思考冒泡'],
      working: ['工作状态-忙碌', '写代码', '轻快记录', '工作状态-原地踱步'],
      result: ['工作状态-清点', '工作状态-忙碌'],
      waiting: ['工作状态-原地踱步', '东张西望', '哈欠'],
      success: ['工作状态-雀跃', '庆祝', '开心跃动', '元气挥手'],
      error: ['工作状态-垂头', '叹气', '冒汗'],
    }
    const WHISPER_HINTS = ['碎碎念']
    /** 把配置里写的「动画原名」或「id」统一解析成素材 id（客户端 packAnims 的键）；解析不到返回 ''。 */
    function resolveAnimId(raw, names, manifest) {
      const s = String(raw || '').trim()
      if (!s) return ''
      if (names.includes(s)) return s
      const man = manifest && typeof manifest === 'object' ? manifest : {}
      if (typeof man[s] === 'string' && names.includes(man[s])) return man[s]
      const lower = s.toLowerCase()
      const hit = names.find((n) => n.toLowerCase() === lower)
      return hit || ''
    }
    /** 按关键词找第一个命中的素材 id：**先认 manifest 里的中文原名，再认文件名本身**。
     *  （真实 default 包的素材文件名是 anim-001.webm 这类 ASCII 名，「工作状态-思考冒泡」只在
     *   manifest 的原名映射里——只按文件名匹配会全部落空。） */
    function findByName(names, hints, manifest) {
      const man = manifest && typeof manifest === 'object' ? manifest : {}
      const entries = Object.entries(man).filter(([, id]) => typeof id === 'string' && names.includes(id))
      for (const h of hints) {
        const byOrig = entries.find(([orig]) => orig.includes(h))
        if (byOrig) return byOrig[1]
      }
      for (const h of hints) {
        const byId = names.find((n) => n.includes(h))
        if (byId) return byId
      }
      return ''
    }
    /** 包视图附带的「状态 → 动画」映射与碎碎念动画池；缺素材就是空串/空数组（客户端回落 speak/idle）。 */
    function animMapOf(view, raw, names, manifest) {
      const ev = (raw && typeof raw.events === 'object' && raw.events) || {}
      const custom = (ev.workStatus && typeof ev.workStatus === 'object') ? ev.workStatus : {}
      const workStatus = {}
      for (const st of WORK_STATES) {
        workStatus[st] = resolveAnimId(custom[st], names, manifest) || findByName(names, WORK_HINTS[st] || [], manifest)
      }
      const customWhisper = Array.isArray(ev.whisper) ? ev.whisper : []
      const whisper = customWhisper.map((n) => resolveAnimId(n, names, manifest)).filter(Boolean)
      const man = manifest && typeof manifest === 'object' ? manifest : {}
      const fallback = Object.entries(man)
        .filter(([orig, id]) => typeof id === 'string' && names.includes(id) && WHISPER_HINTS.some((h) => orig.includes(h)))
        .map(([, id]) => id)
      view.workStatus = workStatus
      view.whisperAnims = whisper.length ? whisper : fallback
      return view
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
      const view = normalizePackConfig(name, raw, pack.anims)
      // 动画原名映射（<packs>/<名>-manifest.json：原名 → 池内 id），客户端菜单显示中文名用；缺文件就没有 labels 字段
      const manifest = readJson(join(packsDir(), `${name}-manifest.json`), null)
      if (manifest && typeof manifest === 'object') {
        const labels = {}
        for (const [orig, id] of Object.entries(manifest)) if (typeof id === 'string' && id) labels[id] = orig
        view.labels = labels
      }
      animMapOf(view, raw, (pack.anims || []).map((f) => String(f).replace(/\.webm$/i, '')), manifest)
      return view
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
     * @param {boolean} o.noFallback  桌面独占内容（碎碎念）用：桌宠离线时宁可不发，也绝不回落 QQ
     * @returns {Promise<{ok:boolean, via?:'pet'|'qq', reason?:string, fallback?:boolean, message?:object}>}
     */
    async function dispatch({ text, modality = '', purpose = '', force = false, anim = '', via = '', noFallback = false } = {}) {
      const t = String(text || '').trim()
      if (!t) return { ok: false, reason: 'empty' }
      const s = api.settings()
      if (via !== 'pet' && s.carrier !== 'pet') return { ok: false, via: 'qq', reason: 'carrier-qq' } // 载体是 QQ：交给 purpose 自己走 QQ，桌宠不碰（via=pet 是桌宠自身入口，可越过载体设置）
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
      if (!noFallback && s.petFallbackToQQ !== false) {
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
      const files = ['main.js', 'preload.js', 'index.html', 'physics.js', 'packmeta.js', 'README.md']
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

    // ---------- Electron 三键（面板按钮 / HTTP 路由共用）：安装 → 启动 → 停止 ----------
    // 安装走 npmmirror 镜像（真机直连 github release 会 fetch failed）；启动前必须清掉
    // 子进程环境的 ELECTRON_RUN_AS_NODE（宿主环境必带，不清则 Electron 以纯 Node 模式启动即崩）。
    const appDir = () => api.dataDir('app')
    const electronExe = () => {
      const rel = process.platform === 'win32' ? join('dist', 'electron.exe')
        : process.platform === 'darwin' ? join('dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
        : join('dist', 'electron')
      return join(appDir(), 'node_modules', 'electron', rel)
    }
    // 不经 shell 拼接：优先用同目录 node 自带的 npm-cli.js 直接跑；找不到就明确报错（Windows 上 spawn 'npm.cmd' 无 shell 会被拒）。
    // npmCli 也可被测试钩子覆盖（petHooks.npmCli = 一个真实存在的假 cli 路径）。
    const npmCli = () => {
      const cli = petHooks.npmCli || join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      return cli && existsSync(cli) ? cli : ''
    }
    // 测试钩子：测试注入 fake spawn/kill，不打真网络、不真启动 Electron
    const petHooks = api.__petTestHooks || {}
    const spawnFn = petHooks.spawn || nodeSpawn
    const killFn = petHooks.kill || ((pid) => { process.kill(Number(pid), 'SIGTERM'); return true })
    const cleanElectronEnv = () => {
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.ELECTRON_NO_ATTACH_CONSOLE
      return env
    }
    const procFile = () => api.dataDir('process.json')
    let electronProc = null // { pid, startedAt }
    const recordedPid = () => {
      if (electronProc) return electronProc
      const p = readJson(procFile(), null)
      if (p && Number.isInteger(p.pid) && p.pid > 0) electronProc = p
      return electronProc
    }

    async function electronInstall() {
      const exe = electronExe()
      if (existsSync(exe)) return { ok: true, alreadyInstalled: true, exe, message: 'Electron 已安装，不用重复装' }
      if (!existsSync(join(appDir(), 'main.js'))) return { ok: false, message: '还没生成客户端：先点「下载 / 生成客户端」' }
      const cli = npmCli()
      if (!cli) return { ok: false, message: '找不到 npm-cli.js，装不了 Electron（可手动在 app 目录 npm i -D electron）' }
      const out = await new Promise((resolve) => {
        let tail = ''
        let child = null
        try {
          child = spawnFn(process.execPath, [cli, 'install', '-D', 'electron'], {
            cwd: appDir(),
            env: { ...process.env, ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/' },
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        } catch (error) {
          return resolve({ code: -1, tail: String(error?.message || error) })
        }
        child.stdout?.on?.('data', (d) => { tail = (tail + String(d)).slice(-2000) })
        child.stderr?.on?.('data', (d) => { tail = (tail + String(d)).slice(-2000) })
        const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} ; resolve({ code: -1, tail, timeout: true }) }, 10 * 60_000)
        child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, tail: tail + String(error?.message || error) }) })
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, tail }) })
      })
      const ok = out.code === 0 && existsSync(exe)
      return {
        ok,
        exitCode: out.code,
        installed: ok,
        exe,
        message: out.timeout ? '安装超时（10 分钟，镜像可能慢），再试一次'
          : ok ? 'Electron 安装完成（npmmirror 镜像）'
          : `npm 安装失败（退出码 ${out.code}）：${(out.tail || '').slice(-300)}`,
      }
    }

    function launch() {
      if (online().online) return { ok: true, alreadyRunning: true, message: '桌宠已经在跑了（心跳正常），不用重复启动' }
      const exe = electronExe()
      if (!existsSync(exe)) return { ok: false, message: 'Electron 还没安装：先点「安装 Electron」' }
      if (!existsSync(join(appDir(), 'main.js'))) return { ok: false, message: 'app/main.js 不见了：先点「下载 / 生成客户端」' }
      try {
        // 分离进程启动；env 必须去掉 ELECTRON_RUN_AS_NODE（见 cleanElectronEnv）
        const child = spawnFn(exe, ['main.js'], { cwd: appDir(), env: cleanElectronEnv(), detached: true, stdio: 'ignore', windowsHide: true })
        child.unref?.()
        electronProc = { pid: child.pid, startedAt: Date.now() }
        try { writeJsonAtomic(procFile(), electronProc) } catch {}
        api.log.info(`桌宠已启动（pid ${child.pid}）`)
        return { ok: true, pid: child.pid, message: `桌宠已启动（pid ${child.pid}），等它连上就有心跳了` }
      } catch (error) {
        return { ok: false, message: '启动失败：' + String(error?.message || error).slice(0, 160) }
      }
    }

    function stop() {
      const p = recordedPid()
      if (!p) return { ok: false, message: '没有正在运行的桌宠进程记录' }
      let killed = true
      try { killFn(p.pid) } catch (error) {
        // ESRCH = 进程本来就不在了：清理记录、按已停止处理，别让面板卡在「停不掉」
        if (String(error?.code) === 'ESRCH') {
          electronProc = null
          try { unlinkSync(procFile()) } catch {}
          return { ok: true, pid: p.pid, message: `桌宠进程（pid ${p.pid}）已经不在了，清掉了记录` }
        }
        killed = false
        return { ok: false, pid: p.pid, message: '停止失败：' + String(error?.message || error).slice(0, 120) }
      }
      electronProc = null
      try { unlinkSync(procFile()) } catch {}
      api.log.info(`桌宠已停止（pid ${p.pid}）`)
      return { ok: killed, pid: p.pid, message: killed ? `已停止桌宠（pid ${p.pid}）` : '停止指令没有确认成功，看看进程还在不在' }
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
            // 客户端 <video> 拉素材时 URL 一定经过百分号编码，而分发层拿的是
            // new URL(req.url).pathname（保留编码、不解码）——所以编码后的 key 必须原样注册，
            // 否则中文/空格命名的素材永远 404。原始名与编码名都注册，手动 curl 两种写法都能命中。
            const keys = new Set([
              `/asset/${pack.name}/${f}`,
              `/asset/${encodeURIComponent(pack.name)}/${encodeURIComponent(f)}`,
            ])
            if ([...keys].every((k) => registeredAssets.has(k))) continue
            for (const key of keys) {
              if (registeredAssets.has(key)) continue
              registeredAssets.add(key)
              api.route(key, (req, res) => {
                if (!guard(req, res, { queryTokenOk: true }).ok) return
                learnHost(req)
                serveAsset(res, pack.name, f) // 严格隔离：只服务自己包里的这个文件，404 不回落 default
              })
            }
          }
        }
      } catch (error) { api.log.warn('注册素材路由失败：', String(error?.message || error)) }
    }

    // ================= 干活状态（DSH 会话事件 → 动画 / 结束提醒） =================
    // 订阅在 host.js（ctx.on('session/event') 已经有一条订阅了），转发到这里：
    //   api.use('pet').onSessionEvent(session, event) → 聚合出「当前她在干什么」→ emit('work')
    // 纯监听、不调模型；状态无变化不重复 emit（防刷屏）。档位与 dsh-pet 一致：
    //   thinking（思考中）/ working（干活中）/ result（出结果）/ waiting（等你确认）/ success / error
    const WORK_TTL_TERMINAL = 60_000   // 完成/出错只展示 60 秒，过期自然回空闲
    const WORK_TTL_ACTIVE = 10 * MIN_MS // 中途静默 10 分钟（回合被打断没收到 turn/end）也不许卡在干活
    const WORK_PRIORITY = { waiting: 60, error: 50, working: 40, thinking: 30, result: 25, success: 20 }
    const workMap = new Map() // sessionId → { state, task, at, seq }
    let workSeq = 0
    let workSnap = { state: null, task: '', at: 0 }
    const WORK_STATE_LABEL = { thinking: '思考中', working: '干活中', result: '出结果了', waiting: '等你确认', success: '忙完了', error: '出错了' }

    /** 展示快照：所有会话里优先级最高的那条（同优先级取最近更新），任务文案与状态同源。 */
    function workSnapshot() {
      const now = Date.now()
      let best = null
      for (const [sid, e] of workMap) {
        const ttl = e.state === 'success' || e.state === 'error' ? WORK_TTL_TERMINAL : WORK_TTL_ACTIVE
        if (now - e.at > ttl) { workMap.delete(sid); continue }
        if (!best || WORK_PRIORITY[e.state] > WORK_PRIORITY[best.state] || (WORK_PRIORITY[e.state] === WORK_PRIORITY[best.state] && e.seq > best.seq)) best = e
      }
      const next = { state: best ? best.state : null, task: best ? best.task : '', at: best ? best.at : 0 }
      const stateChanged = next.state !== workSnap.state
      workSnap = { ...next, at: next.at || Date.now() }
      // 只在「档位」变化时推事件：任务文案变了（todo/write）不需要客户端重播动画
      if (stateChanged) emit('work', { ...workSnap, label: WORK_STATE_LABEL[workSnap.state] || '', text: workEndText(workSnap), bubble: workSettings().bubble, notify: workSettings().notify })
      return workSnap
    }
    function workSettings() {
      const s = api.settings()
      return { enabled: s.workStatusEnabled !== false, bubble: s.workBubble !== false, notify: s.workNotify !== false }
    }
    /** 收尾那一句（只在 success/error 用；其它档位返回空串）。 */
    function workEndText(snap) {
      if (!snap || (snap.state !== 'success' && snap.state !== 'error')) return ''
      const task = String(snap.task || '').slice(0, 30)
      if (snap.state === 'success') return task ? `「${task}」搞定啦！` : '搞定啦，收工～'
      return task ? `「${task}」卡住了…` : '唔…这次没弄成。'
    }
    /** 一条 DSH 会话事件 → 更新该会话档位/任务文案（host.js 转发；子代理不参与，免得多路一起闪）。 */
    function onSessionEvent(session, event) {
      const w = workSettings()
      const type = String(event?.type || '')
      if (!type) return
      const header = session && typeof session.header === 'object' ? session.header : null
      if (header && (header.origin === 'subagent' || Number(header.delegationDepth) > 0)) return
      const sid = String((header && header.id) || session?.id || 'unknown')
      const prev = workMap.get(sid)
      const set = (state, task) => {
        const entry = { state, task: task === undefined ? (prev?.task || '') : task, at: Date.now(), seq: ++workSeq }
        workMap.set(sid, entry)
        workSnapshot()
      }
      if (type === 'todo/write') {
        // 任务文案只更新已有活动的会话（空闲会话写了也不会被展示，避免幽灵文案）
        if (!prev) return
        const todos = Array.isArray(event?.data?.todos) ? event.data.todos : []
        let cur = null
        for (const t of todos) if (t?.status === 'in_progress') cur = t
        if (!cur) cur = todos.find((t) => t?.status === 'pending')
        const text = String(cur?.content || '').trim().slice(0, 40)
        set(prev.state, text)
        return
      }
      if (type === 'turn/start') return set('thinking', '')
      if (type === 'tool/call') return set(String(event?.data?.name || '') === 'ask_user_question' ? 'waiting' : 'working')
      if (type === 'tool/result') return set('result', prev?.task || '')
      if (type === 'approval/asked') return set('waiting')
      if (type === 'turn/end') {
        const kind = String(event?.data?.reason?.kind || '')
        if (!w.enabled) { workMap.delete(sid); workSnapshot(); return }
        if (kind === 'completed') return set('success', prev?.task || '')
        if (kind === 'error' || kind === 'max-tokens' || kind === 'timeout') return set('error', prev?.task || '')
        if (kind === 'blocked') return set('waiting', prev?.task || '')
        workMap.delete(sid) // aborted 等：清掉，别卡在干活中
        workSnapshot()
      }
    }

    // ================= 碎碎念（桌宠自己的气泡流） =================
    // 和「主动搭话」彻底分开：主动搭话是 purpose 引擎按目的找人（载体 QQ / 桌宠二选一），
    // 碎碎念是桌宠自己的小动作——**载体选 QQ 时也照常生效**，只出现在气泡里，永远不发 QQ。
    const WHISPER_POOL = [
      '（趴在屏幕边上发呆）', '今天也一起加油吧…', '唔…要不要摸摸我？', '盯——（一直看着你）',
      '我在这儿呢。', '呼…（打了个哈欠）', '这个屏幕好亮呀。', '有点想吃小鱼干…',
      '（尾巴轻轻拍了两下桌面）', '你忙你的，我自己玩。', '刚刚是不是有只蚊子飞过去？', '（认真地擦桌子）',
      '安静得能听见风扇转…', '（对着屏幕碎碎念）', '偷偷伸个懒腰～', '嗯…今天天气不错。',
    ]
    const WHISPER_AFTER_PROACTIVE_MS = 20 * MIN_MS // 刚弹过主动气泡：碎碎念让位，别连着说（间隔调得很短时按最短间隔算）
    const WHISPER_TURN_TITLE = '桌宠 · 碎碎念（自己的回合）' // 工作区里那条会话的标题（和「主动搭话（目的回合）」并列，但两码事）
    const whisperFile = () => api.dataDir('whisper.json')
    let whisperBusy = false // 正在工作区里"想"这一句（后台系统回合不允许并发）
    function whisperSettings() {
      const s = api.settings()
      const clamp = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d }
      const minMinutes = clamp(s.whisperMinMinutes, 45, 1, 9999) // 面板口径：最短 1 分钟、最长 9999 分钟
      return {
        enabled: s.whisperEnabled !== false,
        source: s.whisperSource === 'pool' ? 'pool' : 'model',
        minMinutes,
        maxMinutes: Math.max(minMinutes, clamp(s.whisperMaxMinutes, 120, 1, 9999)),
        maxPerDay: clamp(s.whisperMaxPerDay, 6, 0, 9999),
        pauseOnPetCarrier: s.whisperPauseOnPetCarrier !== false,
        lines: String(s.whisperLines || '').split(/[\n\r]+/).map((x) => x.trim()).filter(Boolean).slice(0, 80),
      }
    }
    const dayKey = (now = Date.now()) => new Date(now).toDateString()
    function loadWhisper(now = Date.now()) {
      const raw = readJson(whisperFile(), null)
      const st = raw && typeof raw === 'object' ? { ...raw } : {}
      if (st.day !== dayKey(now)) { st.day = dayKey(now); st.count = 0; st.nextAt = 0 }
      st.count = Math.max(0, Math.round(Number(st.count) || 0))
      st.nextAt = Number(st.nextAt) || 0
      st.lastAt = Number(st.lastAt) || 0
      st.lastText = String(st.lastText || '')
      st.recent = Array.isArray(st.recent) ? st.recent.filter((x) => typeof x === 'string').slice(-8) : []
      return st
    }
    const saveWhisper = (st) => { try { writeJsonAtomic(whisperFile(), st) } catch {} }
    /** 醒着窗口（沿用「主动搭话」的 awakeFrom~awakeTo，不再造第二套真相）。 */
    function awakeWindow() {
      const su = api.config().speakUp || {}
      const from = Number.isFinite(su.awakeFrom) ? su.awakeFrom : 8
      const to = Number.isFinite(su.awakeTo) ? su.awakeTo : 23
      return { from, to }
    }
    function inQuietHours(now = Date.now()) {
      const { from, to } = awakeWindow()
      if (to >= 24 || from >= to) return false // 全天醒着 = 没有安静时段
      const d = new Date(now)
      const hour = d.getHours() + d.getMinutes() / 60
      return hour < from || hour >= to
    }
    /** 下一个「醒着」的起点：现在还在安静时段就等到醒着时间。 */
    function quietEndAfter(now = Date.now()) {
      const { from } = awakeWindow()
      const d = new Date(now)
      if (d.getHours() + d.getMinutes() / 60 < from) { d.setHours(from, 0, 0, 0); return d.getTime() }
      d.setDate(d.getDate() + 1)
      d.setHours(from, 0, 0, 0)
      return d.getTime()
    }
    function planWhisper(st, w, now = Date.now()) {
      const span = Math.max(1, w.maxMinutes - w.minMinutes)
      let at = now + (w.minMinutes + Math.round(Math.random() * span)) * MIN_MS
      if (inQuietHours(at)) at = quietEndAfter(at)
      st.nextAt = at
      return at
    }
    /** 「主动搭话」的真实载体真相（ext.speakup.carrier；pet settings 面只是镜像，可能过期）。 */
    function purposeCarrier() {
      const ext = (api.config().ext || {}).speakup
      if (ext && (ext.carrier === 'pet' || ext.carrier === 'qq')) return ext.carrier
      return api.settings().carrier === 'pet' ? 'pet' : 'qq'
    }
    /** 最近一次不是碎碎念/测试的气泡时间（主动搭话的桌宠气泡），用来避免两条气泡贴在一起。 */
    function lastOtherBubbleAt() {
      for (let i = delivered.length - 1; i >= 0; i--) {
        const p = delivered[i].purpose
        if (p === 'whisper' || p === 'test') continue
        return delivered[i].at || 0
      }
      return 0
    }
    function pickWhisperAnim() {
      try {
        const view = packView()
        const pool = (view && Array.isArray(view.whisperAnims) && view.whisperAnims) || []
        return pool.length ? pool[Math.floor(Math.random() * pool.length)] : ''
      } catch { return '' }
    }
    /** 本地文案池：优先用户在面板里写的，其次内置。 */
    function poolLine(w, st) {
      const pool = w.lines.length ? w.lines : WHISPER_POOL
      const fresh = pool.filter((x) => !st.recent.includes(x))
      const list = fresh.length ? fresh : pool
      return list[Math.floor(Math.random() * list.length)] || ''
    }
    const cleanWhisper = (raw) => {
      let s = String(raw ?? '')
      // 模型爱在正文前后加备忘段（【思考】/【记忆】/【状态】…）：正文后面的一律丢掉（内部备忘不上气泡），
      // 开头那一行备忘只丢这一行、正文留着（她有时先把"想到什么"写出来再说话）
      const MEMO = /^[ \t]*[*_#>\-\s]*[【\[]\s*(目的|需求|情绪|情绪值|类型|状态|记忆|思考|动作|备注|待续)\s*[】\]]/
      let lines = s.split(/\r?\n/)
      const at = lines.findIndex((l) => MEMO.test(l))
      if (at === 0) lines = lines.slice(1)
      else if (at > 0) lines = lines.slice(0, at)
      s = lines.join('\n').trim()
      s = s.replace(/^[「“"'']+/, '').replace(/[」”"'']+$/, '')
      s = s.replace(/^大肥鱼\s*[:：]\s*/, '')
      s = s.split('\n').map((x) => x.trim()).find(Boolean) || ''
      s = s.replace(/^[「“"'']+/, '').replace(/[」”"'']+$/, '')
      if (!s || /^[[（(【]?\s*(沉默|跳过|不想说)\s*[\]）)】]?$/.test(s)) return ''
      return s.slice(0, 60)
    }
    /**
     * 从记忆库取几条「这会儿可能会想起来的」事：先按当前在忙的事检索，检索不到就按重要度取。
     * 和主动搭话共用同一份记忆库（api.use('memory')），只是这边要得更少、更轻。
     */
    function memoryLines(limit = 8) {
      let mem = null
      try { mem = api.use('memory') } catch { mem = null }
      if (!mem || typeof mem.list !== 'function') return []
      const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }
      let items = []
      try {
        const q = String(workSnap.task || '').trim()
        if (q) items = mem.list(q) || []
        if (!items.length) items = mem.list('') || []
      } catch { items = [] }
      const seen = new Set()
      return items
        .filter((m) => m && m.text && !m.invalidAt)
        .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0)
          || (Number(b.importance) || 0) - (Number(a.importance) || 0)
          || (Number(b.at) || 0) - (Number(a.at) || 0))
        .map((m) => clip(m.text, 100))
        .filter((t) => (seen.has(t) ? false : (seen.add(t), true)))
        .slice(0, limit)
    }
    /** 碎碎念的提示词：人格 + 记忆 + 当下状态（DSH 干活状态/时段/心情/最近说过）——不是聊天回复，是自言自语。 */
    function whisperPrompt(w, st) {
      let persona = ''
      try { persona = api.core?.personas?.current?.() || '' } catch {}
      const snap = workSnap
      const busy = snap.state
        ? `宿主现在：${WORK_STATE_LABEL[snap.state] || snap.state}${snap.task ? '（' + snap.task + '）' : ''}`
        : '宿主现在：空闲（没在干活，可能在自己玩或不在电脑前）'
      const mem = memoryLines()
      const hh = new Date().getHours()
      const part = hh < 6 ? '凌晨' : hh < 11 ? '上午' : hh < 14 ? '中午' : hh < 18 ? '下午' : hh < 23 ? '晚上' : '深夜'
      return [
        '（这一轮没有人跟你说话。你在自己的桌面角落自言自语，不是在回复消息，也不是主动搭话找人聊天。）',
        persona ? `【你的人格设定】\n${String(persona).slice(0, 1200)}` : '',
        '【你是一只待在主人电脑桌面角落的小桌宠（大肥鱼）】',
        mem.length ? `【你记得的事】\n${mem.map((t) => '- ' + t).join('\n')}` : '【你记得的事】（记忆库还很空）',
        `【现在】\n${busy}\n时段：${part}。心情：${moodNow()}。`,
        st.recent.length ? `【你最近已经嘟囔过】\n${st.recent.slice(-3).map((x) => '「' + x + '」').join('、')}（不要重复这些话）` : '',
        [
          '【怎么写这一句】',
          '1) 只输出一句 20 字以内的自言自语，可以带一点括号里的动作（比如（打了个哈欠））；',
          '2) 可以轻轻想起上面某件你记得的事——一句带过，像忽然想起来，不要复述整件事、不要汇报；',
          '3) 不提问、不叫主人、不像通知或总结、不解释、不加引号、不加名字前缀；',
          '4) 这一轮不能用任何工具，直接输出那句话。实在不想说就整段只输出 [沉默]。',
        ].join('\n'),
      ].filter(Boolean).join('\n')
    }
    /**
     * 让她自己想一句。走「主动搭话」同款的后台系统回合（hub.runSystemTurn，noTools）：
     * 工作区里会出现一条「桌宠 · 碎碎念（自己的回合）」的会话，能当场看到她怎么想的
     * ——机制一样，但这条跟目的机制无关：不选目的、不算次数、不投递 QQ。
     */
    async function askWhisper(w, st) {
      const prompt = whisperPrompt(w, st)
      try {
        if (typeof api.think === 'function') {
          return cleanWhisper(await api.think(prompt, { title: WHISPER_TURN_TITLE, timeoutMs: 120_000, noTools: true }))
        }
        if (typeof api.ask === 'function') { // 老宿主没有 api.think：退回单次问答（工作区看不到思考）
          return cleanWhisper(await api.ask({ text: prompt, maxTokens: 200, temperature: 0.95 }))
        }
        return ''
      } catch (error) {
        api.log.debug?.('碎碎念生成失败，回落本地文案：', String(error?.message || error))
        return ''
      }
    }
    /**
     * 碎碎念一次。force=true（面板/右键手动）跳过排程与开关，但仍尊重专注模式与载体暂停。
     * @returns {Promise<{ok:boolean, reason?:string, via?:'pet', text?:string, nextAt?:number}>}
     */
    async function whisperOnce({ force = false, text = '', reason = 'timed' } = {}) {
      const w = whisperSettings()
      if (!force && !w.enabled) return { ok: false, reason: 'disabled' }
      if (api.config().enabled === false) return { ok: false, reason: 'plugin-off' }
      if (focusOn()) return { ok: false, reason: 'focus' }
      if (!online().online) return { ok: false, reason: 'pet-offline' } // 碎碎念只上桌宠：离线就静默，绝不回落 QQ（force 也一样）
      const st = loadWhisper()
      // 间隔可以调到 1 分钟，但一轮"想"要几十秒：上一轮还没想完就别再排一轮（后台会话不允许并发）
      if (whisperBusy) return { ok: false, reason: 'thinking' }
      const giveWayMs = Math.min(WHISPER_AFTER_PROACTIVE_MS, Math.max(MIN_MS, w.minMinutes * MIN_MS))
      const deferMs = Math.min(3 * MIN_MS, Math.max(MIN_MS, w.minMinutes * MIN_MS))
      if (!force) {
        if (w.pauseOnPetCarrier && purposeCarrier() === 'pet') return { ok: false, reason: 'carrier-pet' }
        if (inQuietHours()) { st.nextAt = quietEndAfter(); saveWhisper(st); return { ok: false, reason: 'quiet', nextAt: st.nextAt } }
        if (st.count >= w.maxPerDay) { st.nextAt = quietEndAfter(Date.now() + 12 * 60 * MIN_MS); saveWhisper(st); return { ok: false, reason: 'daily-max' } }
        if (!st.nextAt) { planWhisper(st, w); saveWhisper(st); return { ok: false, reason: 'scheduled', nextAt: st.nextAt } } // 首次/跨天：先排下一次，别一启动就说话
        if (Date.now() < st.nextAt) return { ok: false, reason: 'not-due', nextAt: st.nextAt }
        if (Date.now() - lastOtherBubbleAt() < giveWayMs) { planWhisper(st, w); saveWhisper(st); return { ok: false, reason: 'recent-proactive', nextAt: st.nextAt } }
        if (workSnap.state && workSettings().enabled) { st.nextAt = Date.now() + deferMs; saveWhisper(st); return { ok: false, reason: 'busy', nextAt: st.nextAt } } // 正在干活：别打断
      }
      let line = cleanWhisper(text)
      if (!line && w.source === 'model') {
        whisperBusy = true
        try { line = await askWhisper(w, st) } finally { whisperBusy = false }
      }
      if (!line) line = cleanWhisper(poolLine(w, st))
      if (!line) return { ok: false, reason: 'empty' }
      const r = await dispatch({ text: line, modality: 'text', purpose: 'whisper', via: 'pet', anim: pickWhisperAnim(), noFallback: true })
      if (!r || !r.ok) {
        // 专注/离线/载体等拒绝：按原样回报，别把次数算掉
        if (!force) { planWhisper(st, w); saveWhisper(st) }
        return { ok: false, reason: (r && r.reason) || 'dispatch-failed' }
      }
      st.count += 1
      st.lastAt = Date.now()
      st.lastText = line
      st.recent = [...st.recent, line].slice(-8)
      planWhisper(st, w)
      saveWhisper(st)
      api.log.info(`碎碎念（${reason}）：${line}`)
      return { ok: true, via: 'pet', text: line, nextAt: st.nextAt, today: st.count }
    }
    async function whisperTick() {
      try { await whisperOnce() } catch (error) { api.log.warn('碎碎念出错：', String(error?.message || error)) }
    }
    function whisperStatus() {
      const w = whisperSettings()
      const st = loadWhisper()
      return {
        enabled: w.enabled, source: w.source, minMinutes: w.minMinutes, maxMinutes: w.maxMinutes,
        maxPerDay: w.maxPerDay, pauseOnPetCarrier: w.pauseOnPetCarrier, lines: w.lines.join('\n'),
        today: st.count, lastAt: st.lastAt, lastText: st.lastText, nextAt: st.nextAt,
        online: online().online, carrier: purposeCarrier(), busy: workSnap.state || '',
        thinking: whisperBusy, turnTitle: WHISPER_TURN_TITLE, // 正在工作区那条会话里想这句
      }
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
        work: { ...workSnapshot(), label: WORK_STATE_LABEL[workSnap.state] || '' }, // 当前她在干什么（思考中/干活中/完成…）
        whisper: { ...whisperStatus() },
        portReady: portReady(), port: knownPort ? Number(knownPort) : null,
        electronInstalled: existsSync(electronExe()), pid: recordedPid()?.pid || null,
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
        pack: packView(), // 动画池/权重/事件映射/物理参数 + 干活状态/碎碎念动画映射；null = 没素材，客户端走静态形象
        work: { ...workSnapshot(), label: WORK_STATE_LABEL[workSnap.state] || '' },
        whisper: (({ enabled, source }) => ({ enabled, source }))(whisperStatus()),
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
      // 面板/客户端手动测试：默认绕过专注模式（force）；可带 anim 点播一段动作；via=pet 表示桌宠自身入口（越过载体设置）
      const r = await dispatch({ text: body.text, modality: body.modality, purpose: 'test', force: body.force !== false, anim: body.anim, via: body.via === 'pet' ? 'pet' : '' })
      api.core.http.send(res, 200, r)
    })
    // ---------- 碎碎念 / 干活状态 ----------
    api.route('/whisper', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      const r = await whisperOnce({ force: true, text: body.text, reason: 'api' })
      api.core.http.send(res, 200, r)
    })
    api.route('/work', (req, res) => {
      if (!guard(req, res).ok) return
      api.core.http.send(res, 200, { ok: true, work: { ...workSnapshot(), label: WORK_STATE_LABEL[workSnap.state] || '', text: workEndText(workSnap) } })
    })
    api.route('/client/install', async (req, res) => {
      if (!guard(req, res).ok) return
      api.core.http.send(res, 200, installClient())
    })
    // ---------- Electron 三键（面板按钮 / HTTP 路由共用）：安装 → 启动 → 停止 ----------
    api.route('/electron-install', async (req, res) => {
      if (!guard(req, res).ok) return
      api.core.http.send(res, 200, await electronInstall())
    })
    api.route('/launch', (req, res) => {
      if (!guard(req, res).ok) return
      api.core.http.send(res, 200, launch())
    })
    api.route('/stop', (req, res) => {
      if (!guard(req, res).ok) return
      api.core.http.send(res, 200, stop())
    })

    // ---------- 启动 ----------
    writeHostFile(true)
    ensureAssetRoutes()
    // 碎碎念排程先落一次盘：面板一打开就能看到「下次约 N 分钟后」，重启也不丢排程
    try { const st0 = loadWhisper(); if (!st0.nextAt) { planWhisper(st0, whisperSettings()); saveWhisper(st0) } } catch {}
    const offHostTimer = api.every(120_000, () => { writeHostFile(true); ensureAssetRoutes() }, '刷新 host.json 与素材路由')
    // 碎碎念：60s 心跳里读一次状态文件 + 纯逻辑判断（R12：别在 tick 里做重活）
    const offWhisper = api.every(60_000, () => whisperTick(), '碎碎念')
    api.onDispose(() => { offHostTimer(); offWhisper(); waiters.clear(); presence.clear(); workMap.clear() })
    api.log.info(`桌宠模块就绪：host.json 在 ${hostFile()}（端口由宿主注入，Host 头学习保留作漂移纠正）`)

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
      setWebPort,                            // 宿主（host.js）启动时注入真实 Web 端口，破自举死锁
      portReady,
      electronInstall,                       // 面板经 /panel/pet/electron-install 调（npmmirror 镜像装 Electron）
      launch,                                // 面板经 /panel/pet/launch 调（分离进程启动 electron.exe main.js）
      stop,                                  // 面板经 /panel/pet/stop 调（杀记录的 pid）
      packs: listPacks,
      activePack,
      packView,
      ensureAssetRoutes,
      // 碎碎念（桌宠自己的气泡流）与干活状态
      whisper: whisperOnce,                  // 手动/测试：立即碎碎念一句（force）
      whisperNow: whisperOnce,
      whisperStatus,
      whisperTick,
      onSessionEvent,                        // host.js 把 ctx.on('session/event') 转发进来
      workStatus: () => ({ ...workSnapshot(), label: WORK_STATE_LABEL[workSnap.state] || '', text: workEndText(workSnap) }),
      status: () => {
        const s = api.settings()
        const w = workSettings()
        return {
          ...online(), focus: focusOn(), carrier: s.carrier, modality: s.modality, bootId, seq,
          pack: activePack(), playbackCount: playbacks.length,
          work: { ...workSnapshot(), label: WORK_STATE_LABEL[workSnap.state] || '' },
          workEnabled: w.enabled, workBubble: w.bubble, workNotify: w.notify,
          workAnimMap: (packView() || {}).workStatus || null, // 面板展示「六档动画能不能对上」
          whisper: whisperStatus(),
          portReady: portReady(), port: knownPort ? Number(knownPort) : null,
          electronInstalled: existsSync(electronExe()), pid: recordedPid()?.pid || null,
        }
      },
      state: () => ({ count: delivered.length }),
    }
  },
}
