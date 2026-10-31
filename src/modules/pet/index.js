// 桌宠模块（内置模块，id='pet'；注册在 src/modules/index.js 的 BUILTINS，全新安装即有）
//
// ⚠ 来源与许可（别误当成自研）：桌宠的客户端形态（Electron 透明置顶窗 + 长轮询 + 气泡）、拖拽物理、
// pet pack 目录约定、以及工作状态六档 / 碎碎念动画的命名约定，都移植自 dsh-pet
// （https://github.com/PC2005-cloud/dsh-pet ，作者 PC2005-cloud，代码 MIT）。
// 本项目做的是把它接进 Aurabot 的模块体系（api.route 长轮询、载体互斥、面板设置、DSH 会话事件联动）。
// 形象/动画素材（「大肥鱼」）是 CC BY-NC-SA 4.0：体积大（50MB+）不进本仓库，由插件**启动时自动下载**落位
// 到数据目录 packs/（用户零操作；下载失败回落客户端内置形象）。默认地址是独立素材仓库
// dsh-aurabot-qq-mods（GitHub archive zip 直链，可在面板设置里换成任意镜像/Gitee 地址），署名见 THIRD-PARTY-NOTICES.md。
//
// 作用：给「主动搭话」提供一个桌面悬浮窗载体。插件侧只做三件事：
//   1. 在 /aurabot/api/* 挂一组 HTTP 长轮询接口（内置模块 route 无前缀；api.route 没有 WebSocket/SSE，R6）；
//   2. 往自己的数据目录写 host.json（baseUrl+token 的桌宠发现契约，见 docs/PET_MODULE_API.md）；
//   3. 暴露 dispatch({text,...})：carrier=pet 且桌宠在线 → 推气泡；离线 → 回落 QQ；永不双发。
// 数据一律写 api.dataDir()（模块文件夹本身不写数据——会被拍快照；api.dataDir 已带模块名 pet）。
// 桌宠 Electron 客户端源码在旁边的 pet-client/ 里，由 POST /client/install 生成到数据目录，Electron 由用户自装。
//
// 载体契约（给 purpose/speakup 模块用，详见 docs/PET_MODULE_API.md）：
//   · 配置：ext.pet.carrier（'qq'|'pet'，默认 qq）、ext.pet.modality（'text'|'voice'）、ext.pet.petFallbackToQQ（默认 true）
//   · api.use('pet').dispatch({ text, modality?, purpose?, force?, anim? }) → { ok, via:'pet'|'qq', ... }
//   · focus.json 开着时自动轮次一律不发（也不回落）；force=true（面板手动测试）可绕过

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, renameSync, copyFileSync, rmSync } from 'node:fs'
import { join, dirname, sep, basename, extname } from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'

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
  files: ['modules/pet/pet-client/main.js', 'modules/pet/pet-client/preload.js', 'modules/pet/pet-client/index.html', 'modules/pet/pet-client/physics.js', 'modules/pet/pet-client/packmeta.js', 'modules/pet/pet-client/behavior.js', 'modules/pet/pet-client/README.md'],

  defaults: {
    carrier: 'qq', modality: 'text', petFallbackToQQ: true, pack: 'default',
    // 默认素材包下载地址（「大肥鱼」形象包不进插件仓库，从素材仓库拉；网络不佳可换成任意镜像直链）
    petPackUrl: 'https://github.com/accomplish07zrh-eng/dsh-aurabot-qq-mods/archive/refs/heads/main.zip',
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
    // AI 行为大脑（决策层）：独立配额，与碎碎念/主动搭话完全无关
    behaviorEnabled: false, // 默认关（主人在 #115 审查时要求：先关着，面板里手动打开才会自己动）
    behaviorMinMinutes: 10,       // 独立触发间隔下限（硬下限 1 分钟，见 behaviorSettings 的 clamp）
    behaviorMaxMinutes: 25,
    behaviorMaxPerDay: 99999,     // 默认不设实际限制
    behaviorIdleCursorMinutes: 8, // 鼠标闲置多久后凑过去戳（反应层阈值，客户端读 /config）
    behaviorMoodCloseWindowBelow: 35, // 心情低于此值 AI 才可能关窗（第三批生效）
    behaviorCloseWindowEnabled: false, // 🔴 高危独立开关，只拦 AI 路径（物理闸：force 也不绕）
    behaviorIconMischiefEnabled: true, // 图标动作独立开关（第二批生效）
    behaviorIconQuarantineDays: 7,     // 隔离区自动归还天数（第二批生效）
    behaviorDisabledActions: '',       // 逗号分隔动作名：不进入 AI 动作表（手动按钮不受影响）
    behaviorWindowWhitelist: '',       // 窗口操作白名单，空=仅普通窗口（第三批生效）
    petScale: 1,                       // 人物大小倍率（0.5~2.0，1 = 原始 240px；客户端按窗口宽等比缩放）
  },
  settings: [
    { key: 'carrier', label: '主动搭话载体', type: 'select', options: [{ value: 'qq', label: 'QQ 私聊' }, { value: 'pet', label: '桌宠气泡' }], hint: 'pet 时桌宠不在线会按下面的开关回落到 QQ；两边永不双发' },
    { key: 'modality', label: '气泡形式', type: 'select', options: [{ value: 'text', label: '文字气泡' }, { value: 'voice', label: '文字 + 语音' }], hint: '语音失败自动降级为纯文字' },
    { key: 'petFallbackToQQ', label: '桌宠离线回落 QQ', type: 'switch' },
    { key: 'petPackUrl', label: '素材包下载地址', type: 'text', hint: '「大肥鱼」形象包 zip 直链（默认走 GitHub 素材仓库 dsh-aurabot-qq-mods；国内网络可换成 Gitee 等镜像直链）。zip 里素材要放文件夹（如 pet-pack/default-animation/），archive 自带的单层仓库目录会自动剥。装完插件后缺包自动下载，也可在面板手动重下' },
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
    // 行为大脑（AI 只挑动作，本地执行器按单办事；第三批关窗相关键现在一并声明，骨架预留）
    { key: 'behaviorEnabled', label: '行为大脑', type: 'switch', hint: 'AI 定时挑一个小动作（追鼠标/溜达/打盹…），本地确定性执行；反应层（点击/摸摸）也归它管' },
    { key: 'behaviorMinMinutes', label: '行为最短间隔（分钟）', type: 'number', min: 1, max: 9999 },
    { key: 'behaviorMaxMinutes', label: '行为最长间隔（分钟）', type: 'number', min: 1, max: 9999 },
    { key: 'behaviorMaxPerDay', label: '行为每日上限', type: 'number', min: 0, max: 999999, hint: '默认 99999 约等于不限' },
    { key: 'behaviorIdleCursorMinutes', label: '鼠标闲置凑近（分钟）', type: 'number', min: 1, max: 240, hint: '鼠标停这么久没动，她凑过去戳一下' },
    { key: 'behaviorCloseWindowEnabled', label: '允许 AI 关闭窗口', type: 'switch', hint: '⚠ 高危：会真的关闭程序窗口，未保存的工作可能丢失。只拦 AI 路径，手动「试一下」也要先开这个开关' },
    { key: 'behaviorMoodCloseWindowBelow', label: '关窗心情闸（低于才关）', type: 'number', min: 0, max: 100, hint: '只有她闹脾气（心情低于此值）AI 才可能选关窗动作' },
    { key: 'behaviorIconMischiefEnabled', label: '图标小动作', type: 'switch', hint: '叼着桌面图标拖一拖 / 收走图标（可一键归还）' },
    { key: 'behaviorIconQuarantineDays', label: '图标隔离归还天数', type: 'number', min: 1, max: 365, hint: '被收走的图标超过这么多天自动放回原位' },
    { key: 'behaviorDisabledActions', label: '禁用 AI 动作', type: 'textarea', hint: '这些动作不进入 AI 动作表（手动按钮不受影响）。逗号分隔动作名，如：hide_icon,steal_cursor' },
    { key: 'behaviorWindowWhitelist', label: '窗口操作白名单', type: 'textarea', hint: '一行一个进程/标题关键词；留空 = 只碰普通窗口。DSH 自己的窗口、桌宠、资源管理器永远不碰' },
    { key: 'petScale', label: '人物大小（倍）', type: 'number', min: 0.5, max: 2, hint: '桌宠整体缩放倍率：0.5 = 一半大，2 = 两倍大，1 = 原始大小。内置模块的表单不渲染，实际走面板「桌宠」卡的大小滑条' },
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

    // ---------- host.json（baseUrl 端口会漂移：从请求 Host 头学习） ----------
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

    /** 人物大小倍率（0.5~2.0）：读不到 / 坏值一律回落 1（原始大小），别让配置坏了把桌宠缩没。 */
    function petScale() {
      const s = Number(api.settings().petScale)
      return Number.isFinite(s) && s > 0 ? Math.min(2, Math.max(0.5, s)) : 1
    }

    // ---------- pet pack（换形象，仿 dsh-pet 目录约定；运行数据只写数据目录） ----------
    // <dataDir>/packs/<名>-config.json + <名>-animation/*.webm；default 包 = default-animation/。
    // 素材版权注意：dsh-pet 形象「大肥鱼」是 CC BY-NC-SA 4.0。素材不进本仓库（50MB+），
    // 由 ensureDefaultPack() 从素材仓库（petPackUrl，默认 dsh-aurabot-qq-mods）自动下载落位，见下方下载段。
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
    /** 心情数值（0~100）；拿不到返回 null —— 高危动作的心情闸拿不到值时按「不满足」处理。 */
    function moodValue() {
      try {
        const m = api.use('mood')
        const v = typeof m?.current === 'function' ? Number(m.current()) : NaN
        return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null
      } catch { return null }
    }

    // ---------- TTS 转存（voice.speak 产物 24h 清理，推给桌宠前先拷进 pet 数据目录） ----------
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

    // ---------- 客户端生成物完整性（治「旧壳」）----------
    // 事故背景：app/ 里只剩旧 main.js、缺 behavior.js 时，客户端 require 失败**只打日志**，
    // 表现是「行为层整体不生效」而面板一切正常，极难发现。这里拿「模板签名」和「生成时记下的签名」
    // 对账：缺文件 / 内容不符 / 模板比生成物新，一律在 status 里明说，面板据此提示重新生成。
    // 只读对账，绝不自动覆盖用户手改过的 app/（生成走 installClient，由面板按钮触发）。
    const CLIENT_FILES = ['main.js', 'preload.js', 'index.html', 'physics.js', 'packmeta.js', 'behavior.js']
    const CLIENT_OPTIONAL = ['README.md'] // 只复制不校验：文档缺失不影响运行
    const CLIENT_STAMP = 'client-stamp.json' // 生成时写进 app/ 的签名凭据
    const fileHash = (p) => {
      try { return createHash('sha1').update(readFileSync(p)).digest('hex').slice(0, 12) } catch { return '' }
    }
    const hashCache = new Map() // 绝对路径 → { key, hash }：status 会每 8 秒被面板拉一次，别重复读盘
    const fileHashCached = (p) => {
      try {
        const st = statSync(p)
        const key = `${st.size}:${Math.round(st.mtimeMs)}`
        const old = hashCache.get(p)
        if (old && old.key === key) return old.hash
        const hash = fileHash(p)
        hashCache.set(p, { key, hash })
        return hash
      } catch { return '' }
    }
    let tplCache = { key: '', sig: '', files: [] }
    /** 模板签名：按各文件 size+mtime 做缓存键，模板不变就不重算 hash。 */
    function clientTemplate() {
      const src = join(api.dir, 'pet-client')
      const stamps = CLIENT_FILES.map((f) => {
        try { const st = statSync(join(src, f)); return `${f}:${st.size}:${Math.round(st.mtimeMs)}` } catch { return `${f}:-` }
      })
      const key = stamps.join('|')
      if (tplCache.key === key) return tplCache
      const files = CLIENT_FILES.map((f) => ({ name: f, hash: fileHash(join(src, f)) })).filter((f) => f.hash)
      const sig = files.length
        ? createHash('sha1').update(files.map((f) => `${f.name}:${f.hash}`).join('|')).digest('hex').slice(0, 12)
        : ''
      tplCache = { key, sig, files }
      return tplCache
    }
    /** 真机生成物对账。healthy=true 才算「行为层真能跑起来」。 */
    function clientStatus() {
      const dest = appDir()
      const tpl = clientTemplate()
      const stamp = readJson(join(dest, CLIENT_STAMP), null)
      const generatedSig = stamp && typeof stamp.sig === 'string' ? stamp.sig : ''
      const files = tpl.files.map((f) => {
        const p = join(dest, f.name)
        if (!existsSync(p)) return { name: f.name, state: 'missing' }
        const h = fileHashCached(p)
        return { name: f.name, state: h && h !== f.hash ? 'changed' : 'ok' }
      })
      const installed = existsSync(join(dest, 'main.js'))
      const missing = files.filter((f) => f.state === 'missing').map((f) => f.name)
      // 模板比生成物新（含「从没生成过 / 升级前生成的」：那时没有 stamp，generatedSig 为空）
      const outdated = installed && Boolean(tpl.sig) && generatedSig !== tpl.sig
      const changed = files.filter((f) => f.state === 'changed').map((f) => f.name)
      const running = Boolean(recordedPid()?.pid)
      const needsRestart = installed && (missing.length > 0 || outdated) && running
      let message = '客户端与插件版本一致'
      if (!installed) message = '还没生成客户端：点「下载 / 生成客户端」'
      else if (missing.length) message = `客户端缺 ${missing.join('、')}：点「重新生成客户端」，再重启 Electron 才会生效`
      else if (outdated) message = running ? '插件里的客户端更新了：点「重新生成客户端」并重启 Electron 才生效' : '插件里的客户端更新了：重新生成后再启动 Electron'
      else if (changed.length) message = `客户端文件与模板不一致（${changed.join('、')}）：可能被手改过，重新生成会覆盖`
      return {
        installed, healthy: installed && !missing.length && !outdated,
        outdated, sig: tpl.sig, generatedSig, files, missing, changed,
        needsRestart, running, message,
      }
    }

    // ---------- 客户端安装：把 pet-client 源码生成到数据目录（模块目录禁写数据） ----------
    function installClient() {
      const src = join(api.dir, 'pet-client')
      const dest = api.dataDir('app')
      const files = [...CLIENT_FILES, ...CLIENT_OPTIONAL]
      const copied = []
      try {
        mkdirSync(dest, { recursive: true })
        for (const f of files) {
          const from = join(src, f)
          if (!existsSync(from)) continue
          copyFileSync(from, join(dest, f))
          copied.push(f)
        }
        // 生成凭据：下次 status 对账时用它判断「app/ 是哪个版本的模板生成的」
        const tpl = clientTemplate()
        if (tpl.sig) {
          try {
            writeFileSync(join(dest, CLIENT_STAMP), JSON.stringify({ sig: tpl.sig, at: Date.now(), files: tpl.files.map((f) => f.name) }, null, 2))
          } catch (error) { api.log.warn('写客户端签名失败（不影响使用）：', String(error?.message || error)) }
        }
        hashCache.clear() // 刚覆盖过，缓存全作废
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
    // 不经 shell 拼接：找 npm-cli.js 直接跑（Windows 上 spawn 'npm.cmd' 无 shell 会被拒）；都找不到就返回空串，
    // 由 electronInstall 走「zip 直装」兜底（目标电脑可能根本没有 Node/npm 环境）。
    // npmCli 也可被测试钩子覆盖（petHooks.npmCli = 一个真实存在的假 cli 路径）。
    const npmCli = () => {
      // 'npmCli' in hooks = 显式覆盖（含空串「强制没有 npm」，测试用来逼出 zip 直装路径）
      const candidates = 'npmCli' in petHooks ? [petHooks.npmCli] : [
        join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        // Unix 系统级 node（如 /usr/bin/node）的 npm 实际在 /usr/lib/node_modules 下
        join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      ]
      return candidates.find((c) => c && existsSync(c)) || ''
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

    // ---------- zip 直装（无 npm 环境的兜底，自动化优先） ----------
    // 背景：DSH 自带运行时（dsh-runtimes/.../node）不带 npm-cli.js，目标电脑也可能没装 Node/npm。
    // Electron 的 npm 包本质就是「下载官方 zip → 解压到 node_modules/electron/dist」，这里跳过 npm 直接干：
    // 下载走 npmmirror 镜像（同 npm 路径的 ELECTRON_MIRROR），解压用 Node 自带 zlib（纯 JS，零外部依赖、零环境要求）。
    const ELECTRON_VERSION_FALLBACK = '45.1.0' // 与 pet-client 模板 app/package.json 的 devDependencies.electron 对齐
    const electronZipUrl = () => {
      let ver = ELECTRON_VERSION_FALLBACK
      try {
        const pkg = JSON.parse(readFileSync(join(appDir(), 'package.json'), 'utf8'))
        const m = String(pkg?.devDependencies?.electron || '').match(/\d+\.\d+\.\d+/)
        if (m) ver = m[0]
      } catch {} // package.json 读不到就用兜底版本
      const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'
      return { ver, url: `https://npmmirror.com/mirrors/electron/${ver}/electron-v${ver}-${platform}-${process.arch}.zip` }
    }

    // 纯 JS zip 解压（支持存储/deflate 两种压缩法；带 zip-slip 防护；unix 上恢复可执行位）
    function unzipTo(zip, destDir) {
      const u32 = (o) => zip.readUInt32LE(o)
      const u16 = (o) => zip.readUInt16LE(o)
      // 从尾部往前找 EOCD（0x06054b50），兼容最长 64KB 的 zip 注释区
      let eocd = -1
      for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
        if (u32(i) === 0x06054b50) { eocd = i; break }
      }
      if (eocd < 0) throw new Error('不是有效的 zip 文件（找不到目录结尾标记）')
      const count = u16(eocd + 10)
      let ptr = u32(eocd + 16)
      for (let n = 0; n < count; n++) {
        if (u32(ptr) !== 0x02014b50) throw new Error(`zip 目录损坏（条目 ${n}）`)
        const method = u16(ptr + 10)
        const csize = u32(ptr + 20)
        const nameLen = u16(ptr + 28)
        const extraLen = u16(ptr + 30)
        const commentLen = u16(ptr + 32)
        const externAttr = u32(ptr + 38)
        const localOff = u32(ptr + 42)
        const name = zip.toString('utf8', ptr + 46, ptr + 46 + nameLen)
        ptr += 46 + nameLen + extraLen + commentLen
        if (name.endsWith('/')) { mkdirSync(join(destDir, name), { recursive: true }); continue }
        if (externAttr >>> 31) continue // 符号链接条目：安全起见直接跳过
        const target = join(destDir, name)
        if (target !== destDir && !target.startsWith(destDir + sep)) throw new Error(`zip 里的可疑路径：${name}`) // 防 zip-slip
        if (u32(localOff) !== 0x04034b50) throw new Error(`zip 局部头损坏：${name}`)
        const dataOff = localOff + 30 + u16(localOff + 26) + u16(localOff + 28)
        const data = method === 0 ? Buffer.from(zip.subarray(dataOff, dataOff + csize)) : inflateRawSync(zip.subarray(dataOff, dataOff + csize))
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, data)
        if (process.platform !== 'win32' && ((externAttr >>> 16) & 0o111)) chmodSync(target, 0o755) // unix 可执行位
      }
    }

    // 下载（可被测试钩子 petHooks.fetchZip 覆盖，不打真网络）
    async function fetchZipTo(url, file) {
      const fetchZip = petHooks.fetchZip || ((u) => fetch(u))
      const res = await fetchZip(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      writeFileSync(file, buf)
      return buf
    }

    // ---------- 默认素材包自动下载（装完即有，用户零操作） ----------
    // 背景：「大肥鱼」素材 50MB+（106 个 webm），不进插件仓库也不进 PR；放独立素材仓库
    // dsh-aurabot-qq-mods，插件启动发现 default 包缺失/为空就自动下载落位到 <dataDir>/packs/。
    // 失败不炸（客户端自己有静态形象兜底），走 every 兜底轮询重试；地址可在面板换镜像。
    // zip 内容约定：素材放在**文件夹**里（别把 106 个 webm 摊在仓库根目录），文件夹名随意：
    //   <任意文件夹>/default-config.json + default-manifest.json + default-animation/*.webm
    // —— archive zip 自带的 <仓库名>-<分支>/ 顶层目录也会自动剥，所以 <仓库>-<分支>/pet-pack/… 同样认。
    const PACK_CHECK_MS = 10 * MIN_MS        // 兜底轮询间隔（只在缺包时才真的下载）
    let packDownloading = false              // 并发闸：面板手动 + every 轮询同时触发时不重复下

    /** default 包是否缺失（没 config 或 animation 目录里一个 webm 都没有）。 */
    function defaultPackMissing() {
      try {
        if (!existsSync(configOfPack('default'))) return true
        return readdirSync(animsDirOf('default')).filter((f) => /\.webm$/i.test(f)).length === 0
      } catch { return true }
    }

    /**
     * 在解压暂存目录里找素材包根（含 default-animation/ 的那一层）。找不到返回 null。
     * 素材仓库约定：**素材必须放文件夹里**（不在仓库根目录摊 106 个 webm），文件夹名随意（pet-pack/、default/、大肥鱼/ 都行）。
     * 所以要按层找：包根 = 暂存目录本身 / <仓库名>-<分支>/ / <任意一层文件夹>/ / <仓库名>-<分支>/<任意一层文件夹>/。
     */
    function findPackRoot(stage) {
      const isPackRoot = (dir) => { try { return existsSync(join(dir, 'default-animation')) } catch { return false } }
      const subDirs = (dir) => {
        try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name)) } catch { return [] }
      }
      if (isPackRoot(stage)) return stage
      for (const d1 of subDirs(stage)) {
        if (isPackRoot(d1)) return d1
        for (const d2 of subDirs(d1)) if (isPackRoot(d2)) return d2 // archive 顶层目录 + 素材文件夹 两层组合
      }
      return null
    }

    /**
     * 下载并落位 default 素材包。
     * @param {boolean} force true = 包已在也重新下载（面板「重新下载素材包」）；false = 只在缺包时下载
     * @returns {Promise<{ok:boolean, skipped?:boolean, count?:number, message:string}>}
     */
    async function ensureDefaultPack(force = false) {
      if (packDownloading) return { ok: false, message: '素材包正在下载中，别急' }
      if (!force && !defaultPackMissing()) return { ok: true, skipped: true, message: 'default 素材包已就位，不用下载' }
      const url = String(api.settings().petPackUrl || '').trim()
      if (!url) return { ok: false, message: '没有配置素材包下载地址（面板「桌宠」→「素材包下载地址」）' }
      packDownloading = true
      const stage = api.dataDir('packs-staging') // 解压暂存目录：校验通过才落位，失败不污染 packs/
      try {
        const zip = await fetchZipTo(url, api.dataDir('packs-download.zip'))
        try { rmSync(stage, { recursive: true, force: true }) } catch {}
        mkdirSync(stage, { recursive: true })
        unzipTo(zip, stage)
        const root = findPackRoot(stage)
        if (!root) throw new Error('zip 里找不到 default-animation/（内容结构不对：素材要放文件夹里，如 pet-pack/default-animation/）')
        mkdirSync(animsDirOf('default'), { recursive: true })
        let copied = 0
        for (const f of readdirSync(join(root, 'default-animation'))) {
          const src = join(root, 'default-animation', f)
          try { if (!statSync(src).isFile()) continue } catch { continue }
          copyFileSync(src, join(animsDirOf('default'), f))
          copied++
        }
        if (copied === 0) throw new Error('default-animation/ 里没有动画文件（.webm）')
        for (const f of ['default-config.json', 'default-manifest.json']) {
          const src = join(root, f)
          try { if (statSync(src).isFile()) copyFileSync(src, join(packsDir(), f)) } catch {}
        }
        api.log.info(`桌宠：素材包已下载落位（${copied} 个动画 → packs/default-animation/）`)
        ensureAssetRoutes()
        return { ok: true, count: copied, message: `素材包下载完成（${copied} 个动画）` }
      } catch (error) {
        const msg = `素材包下载失败：${String(error?.message || error).slice(0, 200)}`
        api.log.warn(msg)
        return { ok: false, message: msg }
      } finally {
        packDownloading = false
        try { rmSync(stage, { recursive: true, force: true }) } catch {}
        try { unlinkSync(api.dataDir('packs-download.zip')) } catch {}
      }
    }

    // 自动落位调度：真机启动后 5 秒补一次 + 每 10 分钟兜底查一次（只在缺包时才下载）。
    // 测试环境（注入了 __petTestHooks）一律跳过——测试不打真网络，靠手动调 ensureDefaultPack + fake fetchZip。
    if (!api.__petTestHooks) {
      const kick = setTimeout(() => { ensureDefaultPack().catch(() => {}) }, 5_000)
      kick.unref?.()
      api.every(PACK_CHECK_MS, () => { if (defaultPackMissing()) ensureDefaultPack().catch(() => {}) }, '素材包自动落位')
    }

    async function electronInstallZip(exe) {
      const { ver, url } = electronZipUrl()
      const zipFile = join(appDir(), 'electron.zip')
      try {
        const zip = await fetchZipTo(url, zipFile)
        mkdirSync(join(appDir(), 'node_modules'), { recursive: true })
        unzipTo(zip, join(appDir(), 'node_modules', 'electron'))
        if (!existsSync(exe)) throw new Error('解压完成但没找到可执行文件（版本/平台可能不匹配）')
        return { ok: true, installed: true, exe, message: `Electron v${ver} 安装完成（npmmirror 直下 zip，无需 npm）` }
      } catch (error) {
        return { ok: false, message: `zip 直装失败：${String(error?.message || error).slice(0, 240)}（可换个网络再点一次，或看 USER-MANUAL 的手动安装教程）` }
      } finally {
        try { unlinkSync(zipFile) } catch {}
      }
    }

    async function electronInstall() {
      const exe = electronExe()
      if (existsSync(exe)) return { ok: true, alreadyInstalled: true, exe, message: 'Electron 已安装，不用重复装' }
      if (!existsSync(join(appDir(), 'main.js'))) return { ok: false, message: '还没生成客户端：先点「下载 / 生成客户端」' }
      // 有 npm-cli 就走 npm（老行为，保持不变）；没有（DSH 自带运行时/裸机）就走 zip 直装，零环境依赖。
      const cli = npmCli()
      if (!cli) return electronInstallZip(exe)
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
    /** 「目的引擎」的真实载体真相（ext.purpose.carrier；pet settings 面只是镜像，可能过期）。 */
    function purposeCarrier() {
      const ext = (api.config().ext || {}).purpose
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

    // ================= AI 行为大脑（决策层） =================
    // 铁律 1：动作清单是硬编码枚举，AI 只能从清单里选、按参数格式填；
    // 解析失败 / 选了不存在的动作 / 选了暂未开放的动作 → 一律丢弃，回退本地默认行为。
    // 第一批开放 8 个动作；第二批放开 drag_icon / hide_icon（隐藏走服务端隔离区，铁律 2：只 rename、可归还）；
    // 第三批放开 nudge_window / close_window（铁律 3：关窗只发 WM_CLOSE，绝不 taskkill）。
    // 2026-10-30 用户裁撤：peek_window（探头）已删除。
    // say = 这个动作的**默认台词**：主人点「试一下」时 AI 不会给 say，没有它桌上就只是默默动一下，
    // 主人根本不知道她在干嘛。AI 自己给的 say 优先，没给才用这里的兜底。
    // （`say` 动作的默认台词留空——它自己会拿 params.text 弹气泡。）
    const BEHAVIOR_ACTIONS = [
      { action: 'chase_cursor', desc: '扑过去追主人的鼠标指针，追到后把指针按住 5 秒再松开（最雀跃）', params: '无参数 {}', say: '（扑过去追你的鼠标！）' },
      { action: 'wander', desc: '自己溜达到屏幕另一头', params: '无参数 {}', say: '（去那边看看）' },
      { action: 'idle_anim', desc: '自己找点事做：随便播一段小动作（摇尾巴、眨眼这类），不移动', params: '无参数 {}', say: '（自己找点事做）' },
      { action: 'steal_cursor', desc: '叼鼠标：快速冲到鼠标位置叼住，带着鼠标一起同步移动一段再松口（闹脾气才用）', params: '可选 {"x":落点屏幕横坐标,"y":落点纵坐标}，不填就每次随机一个位置', say: '（叼走你的鼠标）' },
      { action: 'drag_icon', desc: '走到桌面图标旁叼住，把图标**挪到另一个位置放下**（真的搬走，不是原地抖一下）', params: '可选 {"icon":"桌面上的文件名","x":落点横坐标,"y":落点纵坐标}；不填 icon 就随机叼一个，不填 x/y 就随机落点', say: '（这个图标我挪个地方）' },
      { action: 'hide_icon', desc: '把桌面图标「收走」藏进隔离区（可随时放回原位，绝不真删）', params: '可选 {"icon":"桌面上的文件名"}；不填就随机收一个', say: '（这个我先收起来）' },
      { action: 'nudge_window', desc: '把你正在用的窗口一路推到屏幕边界外（只剩一条边露着），按住 5 秒再同步拉回原位（不改任何内容）', params: '可选 {"title":"窗口标题片段"}，不填就用前台窗口', say: '（把这个窗口推出去）' },
      { action: 'close_window', desc: '🔴 把你正在用的窗口优雅关掉（等价点右上角 X，程序会自己问要不要保存）', params: '可选 {"title":"窗口标题片段"}，不填就用前台窗口', say: '（这个窗口碍事，关掉）' },
      { action: 'say', desc: '只说一句话不做动作', params: '{"text":"要说的话"}', say: '' },
    ]
    /** 动作 → 默认台词（`say` 动作用 params.text，不在这里）。 */
    const BEHAVIOR_SAY = Object.fromEntries(BEHAVIOR_ACTIONS.map((a) => [a.action, a.say || '']))
    // 「暂未开放」占位：新动作先在这里登记（手动通道也拒），实现后再挪进上表。
    const BEHAVIOR_DEFERRED = []
    // 图标动作（第二批）：受 iconMischiefEnabled 独立开关闸。口径参照 closeWindowEnabled？
    // 不：closeWindowEnabled 是「能不能关」的物理闸（force 也不绕）；iconMischiefEnabled 默认 true、
    // 可回滚（隔离区一键归还），只拦 AI 路径，手动 force 按钮随时可测。
    const ICON_ACTIONS = new Set(['drag_icon', 'hide_icon'])
    // 窗口动作（第三批）：真正碰到「别人的窗口」——白名单/排除名单在客户端执行层判（只有它能枚举窗口），
    // 服务端只管心情闸、开关闸、下发与记录。
    const WINDOW_ACTIONS = new Set(['nudge_window', 'close_window'])
    // 落点动作（drag_icon / steal_cursor）：AI 可以指定「放到哪」，省了就让客户端随机一个位置。
    const DROP_ACTIONS = new Set(['drag_icon', 'steal_cursor'])
    const OPEN_ACTIONS = new Set(BEHAVIOR_ACTIONS.map((a) => a.action))
    const ALL_ACTIONS = new Set([...OPEN_ACTIONS, ...BEHAVIOR_DEFERRED]) // 手动「试一下」通道认全表
    const BEHAVIOR_FALLBACK_POOL = [
      '（自己转了个圈，没盯住鼠标）', '（趴下打了个盹）', '（尾巴甩了甩）',
      '（伸了个懒腰）', '（盯着鼠标发了一会儿呆）', '（原地踱了两步）',
    ]
    const BEHAVIOR_TURN_TITLE = '桌宠 · 行为大脑（自己的回合）'
    const behaviorFile = () => api.dataDir('behavior.json')
    // 客户端定时上报的「桌面环境·窗口清单」（2026-10-30）：窗口只有客户端能枚举（它已经有 PowerShell 桥），
    // 服务端不重复造一套；过期（10 分钟没更新）就当没读到，绝不让 AI 拿着十分钟前的窗口名去点名。
    let envWin = { at: 0, list: [] }
    const ENV_WIN_TTL_MS = 10 * 60_000
    const ENV_WIN_MAX = 12
    /** 上报消毒：标题/进程名去控制字符、截断、去空；最多 ENV_WIN_MAX 条。 */
    function cleanWindowReport(list) {
      if (!Array.isArray(list)) return []
      const out = []
      for (const it of list) {
        if (out.length >= ENV_WIN_MAX) break
        if (!it || typeof it !== 'object') continue
        const title = String(it.title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80)
        if (!title) continue
        out.push({
          title,
          proc: String(it.proc || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40),
          fg: it.fg === true,
        })
      }
      return out
    }
    /** 有效期内的窗口清单（过期返回空表）。 */
    function envWindows() {
      return envWin.at && Date.now() - envWin.at <= ENV_WIN_TTL_MS ? envWin : { at: 0, list: [] }
    }
    let behaviorBusy = false // 一轮决策要几十秒：不允许并发（仿 whisperBusy）
    function behaviorSettings() {
      const s = api.settings()
      const clamp = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d }
      const minMinutes = clamp(s.behaviorMinMinutes, 10, 1, 9999) // 铁律：行为间隔下限 1 分钟
      // 每动作 AI 开关：逗号分隔动作名 → Set（手动 /behavior 通道不受它限制，只影响 AI 动作表）
      // 只收「真实存在的动作名」：写错/写多余的字不影响解析，面板也只渲染真动作的开关状态。
      const disabledSet = new Set(
        String(s.behaviorDisabledActions || '').split(',')
          .map((x) => x.trim().toLowerCase())
          .filter((x) => x && ALL_ACTIONS.has(x)),
      )
      return {
        enabled: s.behaviorEnabled !== false,
        minMinutes,
        maxMinutes: Math.max(minMinutes, clamp(s.behaviorMaxMinutes, 25, 1, 9999)),
        maxPerDay: clamp(s.behaviorMaxPerDay, 99999, 0, 999999),
        idleCursorMinutes: clamp(s.behaviorIdleCursorMinutes, 8, 1, 240),
        moodCloseWindowBelow: clamp(s.behaviorMoodCloseWindowBelow, 35, 0, 100),
        closeWindowEnabled: s.behaviorCloseWindowEnabled === true, // 🔴 物理闸：force 也不绕
        iconMischiefEnabled: s.behaviorIconMischiefEnabled !== false,
        iconQuarantineDays: clamp(s.behaviorIconQuarantineDays, 7, 1, 365),
        disabledSet,
        disabledActions: [...disabledSet], // 面板渲染开关状态用（Set 不能直接 JSON）
        windowWhitelist: String(s.behaviorWindowWhitelist || '').trim(),
      }
    }
    function loadBehavior(now = Date.now()) {
      const raw = readJson(behaviorFile(), null)
      const st = raw && typeof raw === 'object' ? { ...raw } : {}
      if (st.day !== dayKey(now)) { st.day = dayKey(now); st.count = 0; st.nextAt = 0 }
      st.count = Math.max(0, Math.round(Number(st.count) || 0))
      st.nextAt = Number(st.nextAt) || 0
      st.lastAt = Number(st.lastAt) || 0
      st.lastReaction = st.lastReaction && typeof st.lastReaction === 'object'
        ? { kind: String(st.lastReaction.kind || '').slice(0, 32), at: Number(st.lastReaction.at) || 0, detail: String(st.lastReaction.detail || '').slice(0, 120) }
        : null
      st.recent = Array.isArray(st.recent) ? st.recent.filter((x) => typeof x === 'string').slice(-8) : []
      // 第三批：关窗记录（面板「关窗记录」卡用；坏数据一律丢弃，宁可少一条也不让面板炸）
      st.closeLog = Array.isArray(st.closeLog)
        ? st.closeLog.filter((x) => x && typeof x === 'object' && Number.isFinite(Number(x.at))).slice(-20)
        : []
      return st
    }
    const saveBehavior = (st) => { try { writeJsonAtomic(behaviorFile(), st) } catch {} }
    function planBehavior(st, b, now = Date.now()) {
      const span = Math.max(1, b.maxMinutes - b.minMinutes)
      let at = now + (b.minMinutes + Math.round(Math.random() * span)) * MIN_MS
      if (inQuietHours(at)) at = quietEndAfter(at)
      st.nextAt = at
      return at
    }
    /** 现状简报（一次约几百 token）：心情/记忆/干活档位/时段/反应层事件/上次回执/桌面图标清单/硬编码动作表。 */
    function behaviorPrompt(b, st) {
      let persona = ''
      try { persona = api.core?.personas?.current?.() || '' } catch {}
      const snap = workSnap
      const busy = snap.state
        ? `宿主现在：${WORK_STATE_LABEL[snap.state] || snap.state}${snap.task ? '（' + snap.task + '）' : ''}`
        : '宿主现在：空闲（没在干活，可能在自己玩或不在电脑前）'
      const mem = memoryLines(3)
      const hh = new Date().getHours()
      const part = hh < 6 ? '凌晨' : hh < 11 ? '上午' : hh < 14 ? '中午' : hh < 18 ? '下午' : hh < 23 ? '晚上' : '深夜'
      const react = st.lastReaction
      const reactLine = react && react.kind
        ? `主人刚刚在桌宠身上：${react.kind}${react.detail ? '（' + react.detail + '）' : ''}`
        : '（最近反应层没有动静）'
      const lastReceipt = st.recent.length ? st.recent[st.recent.length - 1] : '（还没执行过动作）'
      // 桌面图标清单：只列「真能碰」的那些文件名，AI 只能照着名字挑；
      // 读不到桌面/桌面空 → 图标动作直接列入禁选，别让它瞎报一个不存在的文件名。
      const icons = listDesktopIcons(30)
      // 打开的窗口（客户端上报，见 /behavior/env）：★=前台。窗口动作的 title 只能从这份清单里抄片段，
      // 「主人正在用什么窗口」是行为大脑唯一拿不到、又必须知道的环境信息。
      const env = envWindows()
      const winLines = env.list.map((w) => `${w.fg ? '★' : '- '} ${w.title}${w.proc ? '（' + w.proc + '）' : ''}`)
      const winAgeMin = env.at ? Math.max(1, Math.round((Date.now() - env.at) / 60_000)) : 0
      // 禁选清单：暂未开放的 + 图标小动作被独立开关关掉/没有可挑的图标时 + 主人手动禁用的动作
      const banned = [...BEHAVIOR_DEFERRED]
      if (!b.iconMischiefEnabled || !icons.length) banned.push('drag_icon', 'hide_icon')
      // 关窗：物理闸关着、或心情没低到「闹脾气」的档位 → 直接禁选，别让 AI 选一个注定被拦的动作
      const mv = moodValue()
      if (!b.closeWindowEnabled || mv == null || mv >= b.moodCloseWindowBelow) banned.push('close_window')
      for (const a of b.disabledActions) if (!banned.includes(a)) banned.push(a)
      const table = BEHAVIOR_ACTIONS.map((a) => `- ${a.action}：${a.desc}（参数：${a.params}）`).join('\n')
      return [
        '（这一轮是桌宠自己的「行为回合」。你不聊天、不回复消息，只从下面的动作清单里挑一个动作，输出严格 JSON。）',
        persona ? `【你的人格设定】\n${String(persona).slice(0, 800)}` : '',
        '【你是一只待在主人电脑桌面角落的小桌宠（大肥鱼）】',
        mem.length ? `【你记得的事】\n${mem.map((t) => '- ' + t).join('\n')}` : '',
        `【现在】\n${busy}\n时段：${part}。心情：${moodNow()}。反应层：${reactLine}`,
        `【上一次动作的回执】${lastReceipt}`,
        icons.length ? `【主人桌面上的图标（图标动作只能从这些名字里原样照抄一个；不填 icon 就自己随机叼一个）】\n${icons.join('、')}` : '',
        winLines.length
          ? `【主人现在开着的窗口（★=正在用的那个，约 ${winAgeMin} 分钟前读的；窗口动作的 title 只能从这里抄片段）】\n${winLines.join('\n')}`
          : '',
        `【可用动作表（只能从这里选）】\n${table}`,
        `【窗口动作说明】nudge_window / close_window 只作用于主人**正在用的那个窗口**：params.title 可以填上面窗口清单里某条标题的**片段**（照抄几个字，别自己编），不填就是前台窗口${winLines.length ? '' : '（这次没读到窗口清单，所以别填 title）'}。close_window 是闹脾气才用的重动作：只在心情很低时才可选，关掉的是别人真在用的窗口，事后会被记一笔、也可能被要求道歉——绝大多数时候别选它。`,
        '【落点】drag_icon 会把图标搬到另一个位置、steal_cursor 会把鼠标丢到别处：落点由你决定——在 params 里给 "x"/"y"（屏幕坐标，左上角是 0,0）就按你给的，不给就每次随机一个位置。想「扔到屏幕角落」「扔到右下角」这种，就自己给坐标。',
        banned.length ? `【暂未开放或已被主人禁用，禁止选择】${banned.join('、')}` : '',
        [
          '【输出格式】只输出一个严格 JSON 对象，不要任何解释、不要代码块标记：',
          '{"action":"wander","params":{},"say":"（溜达到屏幕那头）","moodDelta":1}',
          'say 可为空串；moodDelta 是这轮动作对你心情的影响（-10~10 的整数）。绝大多数时候就选安分的 wander/idle_anim；宿主在忙时也只选不碰鼠标的动作。',
        ].join('\n'),
      ].filter(Boolean).join('\n')
    }
    /** 让她自己挑一个动作：走后台系统回合（仿 askWhisper，noTools，超时 120s）。
     *  key='behavior'（2026-10-30）：碎碎念和行为大脑都用 api.think，而 api.think 的会话名是
     *  `ext-<模块id>`——不区分用途的话两件事会挤进**同一条会话**：工作区里看不到「行为大脑」这条，
     *  而且一边在想时另一边直接撞「上一轮还没结束」。带上 key 后各自一条会话，互不排队。 */
    async function askBehavior(b, st) {
      const prompt = behaviorPrompt(b, st)
      try {
        if (typeof api.think === 'function') return await api.think(prompt, { title: BEHAVIOR_TURN_TITLE, timeoutMs: 120_000, noTools: true, key: 'behavior' })
        if (typeof api.ask === 'function') return await api.ask({ text: prompt, maxTokens: 200, temperature: 0.7 })
        return ''
      } catch (error) {
        api.log.debug?.('行为大脑生成失败，回退本地默认：', String(error?.message || error))
        return ''
      }
    }
    /** 宽松解析动作单：提取第一个 JSON 对象；动作必须在开放清单里、未被禁用、参数必须是对象，否则返回 null。 */
    function parseBehaviorAction(raw, disabledSet) {
      const m = String(raw || '').match(/\{[\s\S]*\}/)
      if (!m) return null
      let obj
      try { obj = JSON.parse(m[0]) } catch { return null }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
      const action = String(obj.action || '').trim()
      if (!OPEN_ACTIONS.has(action)) return null // 不在开放清单（含「暂未开放」的）→ 丢弃
      const banned = disabledSet instanceof Set ? disabledSet : behaviorSettings().disabledSet
      if (banned.has(action)) return null // 每动作 AI 开关禁用的动作 → AI 路径拒绝（手动通道不受此限）
      let params = obj.params
      if (params == null) params = {}
      if (typeof params !== 'object' || Array.isArray(params)) return null
      // 图标动作：icon 可以不填（2026-10-30 用户指定：不给名字就随机挑一个）；
      // 填了就必须是合法文件名（只认文件名，不带路径）——非法参数按铁律 1 丢弃
      if (ICON_ACTIONS.has(action)) {
        const icon = params.icon
        if (icon != null && (typeof icon !== 'string' || !icon.trim() || icon.length > 260 || /[/\\]/.test(icon))) return null
      }
      // 落点坐标：给了就用（屏幕 DIP 坐标），省了就让客户端随机。非法坐标直接丢弃这一轮。
      if (DROP_ACTIONS.has(action)) {
        for (const k of ['x', 'y']) {
          const v = params[k]
          if (v == null || v === '') { delete params[k]; continue }
          const n = Number(v)
          if (!Number.isFinite(n) || Math.abs(n) > 20000) return null
          params[k] = Math.round(n)
        }
      }
      // 窗口动作（第三批）：title 只是「标题片段」，不是句柄；可以不填（不填就由客户端挑前台窗口）
      if (WINDOW_ACTIONS.has(action)) {
        const t = params.title
        if (t != null && (typeof t !== 'string' || !t.trim() || t.length > 60 || /[\u0000-\u001f]/.test(t))) return null
        const txt = params.text
        if (txt != null && (typeof txt !== 'string' || txt.length > 60)) return null
      }
      const say = String(obj.say || '').slice(0, 60)
      let moodDelta = Number(obj.moodDelta)
      if (!Number.isFinite(moodDelta)) moodDelta = 0
      moodDelta = Math.max(-10, Math.min(10, Math.round(moodDelta))) // 钳制 ±10
      return { action, params, say, moodDelta }
    }
    /** 回退本地默认：说一句池子文案（播什么动画客户端自己按 say/idle 兜底），绝不把失败抛给用户。 */
    async function behaviorFallback(st, why) {
      const pool = BEHAVIOR_FALLBACK_POOL.filter((x) => !st.recent.includes(x))
      const list = pool.length ? pool : BEHAVIOR_FALLBACK_POOL
      const line = list[Math.floor(Math.random() * list.length)] || ''
      const r = line ? await dispatch({ text: line, purpose: 'behavior', via: 'pet', noFallback: true }) : { ok: false, reason: 'empty' }
      api.log.debug?.(`行为大脑解析失败回退（${why}）：${line}`)
      return { ok: Boolean(r && r.ok), action: 'fallback', text: line, reason: r && r.ok ? 'fallback' : (r && r.reason) || 'dispatch-failed' }
    }
    /** 下发层唯一入口：emit('behavior', …)。台词（say）随事件一起下发、由客户端顶气泡——
     *  这里是**唯一**发声通道：AI 给的 say 优先，没给就用动作默认台词，保证每个动作都有气泡。 */
    async function emitBehavior({ action, params = {}, say = '', force = true, reason = 'manual' } = {}) {
      try {
        const act = String(action || '').trim()
        if (!ALL_ACTIONS.has(act)) return { ok: false, reason: 'unknown-action' }
        const b = behaviorSettings()
        // 🔴 关窗物理闸（force 也不绕，第三批）：这里是唯一收窄点——AI 一路（behaviorOnce 已先拦一次）
        // 与手动一路（/behavior → 面板「试一下」）都从这里下发。少了这一条，开关关着时点「试一下-关窗口」
        // 会真把主人的窗口关掉（与设置项 hint「手动也要先开」自相矛盾）。
        if (act === 'close_window' && !b.closeWindowEnabled) {
          return { ok: false, reason: 'close-window-disabled', message: '先在设置里打开「允许 AI 关闭窗口」' }
        }
        const playbackId = randomBytes(4).toString('hex')
        const safeParams = params && typeof params === 'object' && !Array.isArray(params) ? { ...params } : {}
        // 气泡台词：动作必须有台词，否则主人只看见她在动、不知道她要干什么
        // （面板「试一下」这条手动路 AI 根本不给 say，全靠这里的默认台词兜底）
        const speech = act === 'say'
          ? String(safeParams.text || safeParams.say || '').trim()
          : String(say || BEHAVIOR_SAY[act] || '').trim()
        // say 动作没给内容 = 什么都不用做（与其让客户端 refused，不如这里就说清楚）
        if (act === 'say' && !speech) return { ok: false, reason: 'empty-text', message: '「说话」动作要给一句台词' }
        const line = speech.slice(0, 60)
        // 窗口动作把白名单一起下发：只有客户端能枚举窗口，白名单/排除名单必须在执行层判
        if (WINDOW_ACTIONS.has(act)) {
          safeParams.whitelist = b.windowWhitelist
          // 双保险：客户端模板若是旧副本、或事件在队列里排队期间开关被关掉，执行层再判一次
          if (act === 'close_window') safeParams.windowEnabled = true
        }
        emit('behavior', {
          action: act.slice(0, 40),
          params: safeParams,
          say: line,
          playbackId,
          force: force === true,
          reason: String(reason || '').slice(0, 24),
        })
        // 台词只挂在 behavior 事件上。**不再走 dispatch（proactive）**：
        // 那会让同一句话在客户端弹两次（proactive 一次 + behavior 一次），
        // 且全局 modality=voice 时会把「（扑过去追你的鼠标！）」拿去 TTS 合成。
        return { ok: true, playbackId, action: act, say: line }
      } catch (error) {
        api.log.warn('行为下发失败：', String(error?.message || error))
        return { ok: false, reason: 'emit-failed' }
      }
    }
    /**
     * 行为大脑一轮。force=true（面板「试一下」手动）跳过开关/排程/每日上限/专注/安静时段，
     * 但绕不过「桌宠离线」（没人执行）与 closeWindowEnabled 物理闸（AI 路径里另外拦）。
     * @returns {Promise<{ok:boolean, reason?:string, action?:string, text?:string, nextAt?:number}>}
     */
    async function behaviorOnce({ force = false, reason = 'timed' } = {}) {
      const b = behaviorSettings()
      if (!force && !b.enabled) return { ok: false, reason: 'disabled' }
      if (api.config().enabled === false) return { ok: false, reason: 'plugin-off' }
      if (!online().online) return { ok: false, reason: 'pet-offline' } // force 也拦：桌宠不在线没人执行
      if (!force && focusOn()) return { ok: false, reason: 'focus' }
      if (behaviorBusy) return { ok: false, reason: 'thinking' }
      const st = loadBehavior()
      const deferMs = Math.max(MIN_MS, b.minMinutes * MIN_MS)
      if (!force) {
        if (inQuietHours()) { st.nextAt = quietEndAfter(); saveBehavior(st); return { ok: false, reason: 'quiet', nextAt: st.nextAt } }
        if (st.count >= b.maxPerDay) { st.nextAt = quietEndAfter(Date.now() + 12 * 60 * MIN_MS); saveBehavior(st); return { ok: false, reason: 'daily-max', nextAt: st.nextAt } }
        if (!st.nextAt) { planBehavior(st, b); saveBehavior(st); return { ok: false, reason: 'scheduled', nextAt: st.nextAt } } // 首次/跨天：先排下一次
        if (Date.now() < st.nextAt) return { ok: false, reason: 'not-due', nextAt: st.nextAt }
        if (workSnap.state) { st.nextAt = Date.now() + deferMs; saveBehavior(st); return { ok: false, reason: 'busy', nextAt: st.nextAt } } // 主人在忙：别动鼠标
      }
      let plan = null
      behaviorBusy = true
      try { plan = parseBehaviorAction(await askBehavior(b, st), b.disabledSet) } finally { behaviorBusy = false }
      // 想的这几秒里状态可能被 /behavior 路由动过：拿最新的落盘
      const st2 = loadBehavior()
      // 安全闸（AI 路径）：closeWindowEnabled 是物理闸（force 也不绕）；
      // iconMischiefEnabled 默认 true 且动作可回滚，**只拦 AI 路径**——
      // force=true 的手动「试一下」不在这里拦（真到落盘时 act 入口也会放行，见 iconAct 的 isForce）。
      // close_window 四重闸：① closeWindowEnabled（物理闸，force 也不绕）② 心情闸（只拦 AI，
      // 心情 < moodCloseWindowBelow 才干；拿不到心情值按不满足）③ 白名单 ④ 排除名单（后两条在客户端，
      // 只有它能枚举窗口）。
      const mv = moodValue()
      const moodLowEnough = mv != null && mv < b.moodCloseWindowBelow
      const closeBlocked = plan && plan.action === 'close_window' && (!b.closeWindowEnabled || (!force && !moodLowEnough))
      const gated = closeBlocked
        || (!force && plan && ICON_ACTIONS.has(plan.action) && !b.iconMischiefEnabled)
      if (!plan || gated) {
        // 铁律 1：解析失败 / 选了非法或被物理闸拦的动作 → 回退本地默认
        if (!force) { planBehavior(st2, b); saveBehavior(st2) }
        const why = !plan ? 'parse' : closeBlocked ? 'close-window-gate' : 'gate'
        return behaviorFallback(st2, why)
      }
      if (plan.moodDelta) {
        try {
          const m = api.use('mood')
          if (m && typeof m.nudge === 'function') m.nudge(plan.moodDelta, '行为大脑')
        } catch (error) { api.log.debug?.('行为大脑修心情失败（忽略）：', String(error?.message || error)) }
      }
      const r = await emitBehavior({ ...plan, force, reason })
      if (!r || !r.ok) {
        if (!force) { planBehavior(st2, b); saveBehavior(st2) }
        return { ok: false, reason: (r && r.reason) || 'dispatch-failed' }
      }
      st2.count += 1
      st2.lastAt = Date.now()
      st2.recent = [...st2.recent, `${plan.action} → 下发（等回执）`].slice(-8)
      planBehavior(st2, b)
      saveBehavior(st2)
      api.log.info(`行为大脑（${reason}）：${plan.action}`)
      return { ok: true, action: plan.action, playbackId: r.playbackId, nextAt: st2.nextAt, today: st2.count }
    }
    async function behaviorTick() {
      try { await behaviorOnce() } catch (error) { api.log.warn('行为大脑出错：', String(error?.message || error)) }
    }
    function behaviorStatus() {
      const b = behaviorSettings()
      const st = loadBehavior()
      let quarantined = 0
      try { quarantined = loadManifest().length } catch {}
      const today0 = new Date(); today0.setHours(0, 0, 0, 0)
      const closeLog = st.closeLog || []
      return {
        enabled: b.enabled, minMinutes: b.minMinutes, maxMinutes: b.maxMinutes, maxPerDay: b.maxPerDay,
        idleCursorMinutes: b.idleCursorMinutes, closeWindowEnabled: b.closeWindowEnabled,
        moodCloseWindowBelow: b.moodCloseWindowBelow, iconMischiefEnabled: b.iconMischiefEnabled,
        iconQuarantineDays: b.iconQuarantineDays,   // 面板显示「超 N 天自动放回」
        quarantined,                                // 隔离区里还有几个图标（面板小红点）
        disabledActions: b.disabledActions, // 面板渲染每动作开关状态（手动按钮不受这些限制）
        today: st.count, lastAt: st.lastAt, nextAt: st.nextAt, lastReaction: st.lastReaction, recent: st.recent,
        online: online().online, busy: workSnap.state || '', thinking: behaviorBusy, turnTitle: BEHAVIOR_TURN_TITLE,
        // 桌面环境（给面板/调试看「AI 这一轮到底拿到了什么」）：
        //   icons = 桌面图标条数（直接从桌面目录读），windows = 客户端上报的窗口条数 + 读到的时刻
        envIcons: listDesktopIcons(30),
        envWindows: envWindows().list, envWindowsAt: envWindows().at,
        openActions: BEHAVIOR_ACTIONS.map((a) => a.action), deferredActions: [...BEHAVIOR_DEFERRED],
        // 第三批（窗口动作）：心情闸的实时值 + 白名单 + 关窗记录（面板渲染「今日关了几次 / 要不要道歉」）
        mood: moodValue(), windowWhitelist: b.windowWhitelist,
        closeLog: closeLog.slice(-10).reverse(), // 新的在前
        closeToday: closeLog.filter((x) => Number(x.at) >= today0.getTime() && x.status === 'played').length,
        apologyDue: closeLog.some((x) => x.status === 'played' && !Number(x.apologizedAt || 0)),
      }
    }
    /** 关窗记录 + 一键补偿道歉：道歉把心情往上抬一点，并把最近一条未道歉的记录标记掉（不删记录）。 */
    function windowApologize() {
      const st = loadBehavior()
      const list = Array.isArray(st.closeLog) ? st.closeLog : []
      const idx = list.map((x, i) => ({ x, i })).filter(({ x }) => x.status === 'played' && !Number(x.apologizedAt || 0)).pop()
      if (!idx) return { ok: false, reason: 'nothing-to-apologize' }
      const now = Date.now()
      list[idx.i] = { ...idx.x, apologizedAt: now }
      st.closeLog = list.slice(-20)
      // 道歉是「她自己也觉得过了」：心情 +8，写一条记忆（下一轮简报能看到）
      try {
        const m = api.use('mood')
        if (m && typeof m.nudge === 'function') m.nudge(8, '桌宠道歉')
      } catch {}
      try {
        api.use('memory')?.add?.({ text: `桌宠为关掉窗口「${idx.x.window || '未知窗口'}」道了歉，心情回了一点`, importance: 0.4, source: 'pet' })
      } catch {}
      saveBehavior(st)
      return { ok: true, window: idx.x.window || '', at: idx.x.at, apologizedAt: now }
    }

    // ================= 桌面图标隔离区（第二批：drag_icon / hide_icon 的服务端执行层） =================
    // 铁律 2：「删除桌面图标」永远不是真删除——只有 rename 剪切到隔离区 + manifest 记录 + 可一键归还 + 超期自动归还。
    // 铁律 5：文件夹 / 隐藏文件 / 桌面系统图标（回收站、此电脑等 CLSID 命名的 .lnk）绝对不碰，只碰 .lnk/.url/普通文件。
    const quarantineDir = () => api.dataDir('desktop-quarantine')
    const manifestFile = () => join(quarantineDir(), 'manifest.json')
    const DAY_MS = 24 * 60 * 60_000
    // 可执行/脚本类扩展名一律拒绝（「只碰 .lnk/.url/普通文件」；这里用拒绝清单而不是白名单，
    // 因为「普通文件」本身无边——但最坏情况也只是被 rename 到隔离区，随时能放回，永不删除）。
    const ICON_EXT_DENY = new Set(['.exe', '.bat', '.cmd', '.com', '.scr', '.msi', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.pif', '.jar', '.msc', '.cpl', '.dll', '.sys'])
    // 桌面系统/壳层文件（不以 . 开头但碰了会坏事；Node 读不到 Windows「隐藏」属性，只能按名字拦）
    const ICON_NAME_DENY = new Set(['desktop.ini', 'thumbs.db', 'iconcache.db'])
    // 桌面系统图标（回收站/此电脑…）以 CLSID GUID 命名，永远不碰
    const CLSID_RE = /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}(\.|$)/
    /** 主人的桌面目录清单（2026-10-30 用户实测「收图标容易 not-found」）：
     *  资源管理器桌面是**合并视图**——用户桌面 + 公共桌面（PUBLIC\Desktop）一起显示，
     *  客户端 ListView 读到的图标清单就是合并视图（微信/QQ/Chrome 这类快捷方式全在公共桌面）。
     *  服务端以前只认用户桌面，客户端挑了公共桌面图标一发回来就 not-found。
     *  顺序即优先级：用户桌面在前（同名时以用户桌面为准）；测试注入 hooks.desktopDir 时只认注入目录。 */
    function desktopDirs() {
      const hooks = api.__petTestHooks || {}
      if (typeof hooks.desktopDir === 'function') { try { const d = hooks.desktopDir(); return d ? [d] : [] } catch {} }
      const up = String(process.env.USERPROFILE || '').trim()
      const pub = String(process.env.PUBLIC || '').trim()
      const cand = up
        ? [join(up, 'Desktop'), join(up, 'OneDrive', 'Desktop'), join(up, 'OneDrive', '桌面')]
        : []
      if (pub) cand.push(join(pub, 'Desktop'))
      return cand.filter((d) => { try { return d && existsSync(d) && statSync(d).isDirectory() } catch { return false } })
    }
    /** 兼容旧调用（只关心「有没有桌面」的地方）：返回第一个可用桌面。 */
    function detectDesktopDir() {
      return desktopDirs()[0] || null
    }
    /**
     * 列出桌面上「真能碰」的图标文件名（给 AI 挑目标 / 面板调试用）。
     * 与 validateDesktopIcon 同一套拒绝规则；跨目录合并去重（用户桌面优先）；
     * 读不到任何桌面就返回空数组，绝不抛。
     */
    function listDesktopIcons(limit = 30) {
      const dirs = desktopDirs()
      const seen = new Set()
      const out = []
      for (const desktop of dirs) {
        let names = []
        try { names = readdirSync(desktop) } catch { continue }
        for (const raw of names) {
          if (out.length >= limit) return out
          const n = String(raw)
          const key = n.toLowerCase()
          if (!n || seen.has(key)) continue
          seen.add(key)
          if (n.startsWith('.') || n.startsWith('~$')) continue
          if (ICON_NAME_DENY.has(key) || CLSID_RE.test(n)) continue
          if (ICON_EXT_DENY.has(extname(n).toLowerCase())) continue
          try { if (!statSync(join(desktop, n)).isFile()) continue } catch { continue }
          // 进 prompt 前把控制字符换成空格（防止文件名把简报结构搞乱）
          out.push(n.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 60))
        }
      }
      return out
    }
    /** 把一个待碰的图标名解析成真实文件：多桌面目录 × （原名 → 补常见后缀）逐个 stat。
     *  补后缀治「客户端只能拿到显示名」：ListView 给「微信」，磁盘上是「微信.lnk」。
     *  @returns {{dir:string, name:string, path:string}|{notFile:boolean}|null} name 一定是**磁盘真名**；
     *          notFile = 名字真实存在但不是普通文件（文件夹/特殊项），调用方要单独报 not-file。 */
    function resolveDesktopFile(icon) {
      const raw = String(icon || '').trim()
      if (!raw || /[/\\]/.test(raw) || raw.includes('..')) return null
      const dirs = desktopDirs()
      for (const dir of dirs) {
        const p = join(dir, raw)
        try {
          const st = statSync(p)
          if (st.isFile()) return { dir, name: raw, path: p }
          return { notFile: true }
        } catch {}
      }
      for (const dir of dirs) {
        for (const ext of ['.lnk', '.url', '.exe']) {
          const name = raw + ext
          const p = join(dir, name)
          try { const st = statSync(p); if (st.isFile()) return { dir, name, path: p } } catch {}
        }
      }
      return null
    }
    /** 校验一个待碰的桌面图标名：必须直接躺在桌面（无路径分隔）、真实存在、是普通文件、不在拒绝名单。 */
    function validateDesktopIcon(icon) {
      const name = String(icon || '').trim()
      if (!name || name !== String(icon || '') || /[/\\]/.test(name) || name.includes('..')) return { ok: false, reason: 'bad-name', name }
      if (name.startsWith('.') || name.startsWith('~$')) return { ok: false, reason: 'hidden', name } // 隐藏文件/Office 临时锁不碰
      if (ICON_NAME_DENY.has(name.toLowerCase())) return { ok: false, reason: 'system-file', name } // desktop.ini 等壳层文件
      if (CLSID_RE.test(name)) return { ok: false, reason: 'system-icon', name } // 回收站/此电脑等系统图标
      const ext = extname(name).toLowerCase()
      if (ICON_EXT_DENY.has(ext)) return { ok: false, reason: 'bad-ext', name } // 可执行/脚本类拒绝
      if (!desktopDirs().length) return { ok: false, reason: 'desktop-not-found', name }
      const hit = resolveDesktopFile(name)
      if (!hit) return { ok: false, reason: 'not-found', name }
      if (hit.notFile) return { ok: false, reason: 'not-file', name } // 文件夹 / 特殊项一律拒绝
      // 补后缀命中的真实文件名要再过一遍拒绝规则（显示名「无限试用Navicat」→ 磁盘「无限试用Navicat.bat」必须拒）
      if (hit.name !== name) {
        if (hit.name.startsWith('.') || hit.name.startsWith('~$')) return { ok: false, reason: 'hidden', name }
        if (ICON_NAME_DENY.has(hit.name.toLowerCase())) return { ok: false, reason: 'system-file', name }
        if (ICON_EXT_DENY.has(extname(hit.name).toLowerCase())) return { ok: false, reason: 'bad-ext', name }
      }
      return { ok: true, path: hit.path, name: hit.name }
    }
    /** 读 manifest（数组：[{id,name,originalPath,quarantinePath,at,reason,playbackId}]）；脏数据一律丢弃，宁可少一条也不让面板炸。 */
    function loadManifest() {
      const m = readJson(manifestFile(), null)
      if (!Array.isArray(m)) return []
      return m.filter((x) => x && typeof x === 'object'
        && typeof x.id === 'string' && x.id
        && typeof x.name === 'string' && x.name
        && typeof x.originalPath === 'string' && x.originalPath
        && typeof x.quarantinePath === 'string' && x.quarantinePath)
        .map((x) => ({
          id: x.id, name: x.name, originalPath: x.originalPath, quarantinePath: x.quarantinePath,
          at: Number(x.at) || 0, reason: String(x.reason || ''), playbackId: String(x.playbackId || ''),
        }))
    }
    function saveManifest(list) { try { mkdirSync(quarantineDir(), { recursive: true }); writeJsonAtomic(manifestFile(), list) } catch {} }
    /**
     * 「挪文件」的唯一实现（隔离与归还共用）：先试 rename（真正的剪切，原子）；
     * 跨卷时（桌面在 OneDrive/另一块盘，插件数据目录在别的盘）rename 会抛 EXDEV，退化为
     * 拷贝 → 校验大小一致 → 删源。注意这不是「删除」：拷贝已落地且大小对得上才动源文件，
     * 任何一步对不上就放弃并保留原文件（铁律 2：删除不存在，只有挪来挪去）。
     */
    function moveFile(src, dest) {
      // 单测注入点（api.__petTestHooks.rename）：模拟跨卷 EXDEV，验证拷贝退化分支
      const rename = typeof api.__petTestHooks?.rename === 'function' ? api.__petTestHooks.rename : renameSync
      try { rename(src, dest); return { ok: true, mode: 'rename' } } catch (error) {
        if (error?.code !== 'EXDEV') throw error // 别的错（占用/权限/已存在）原样抛给调用方记 failed
      }
      copyFileSync(src, dest)
      const srcSize = statSync(src).size
      const destSize = statSync(dest).size
      if (srcSize !== destSize) {
        try { unlinkSync(dest) } catch {} // 只清掉我们自己那份不完整的拷贝，真正的主人文件没动
        throw new Error('跨卷拷贝大小不一致，已放弃（源文件未动）')
      }
      unlinkSync(src) // 到这里目标已有一份完整拷贝，源文件才算「挪走」
      return { ok: true, mode: 'copy' }
    }
    /** 隔离区里重名时加序号：「某.lnk」→「某(1).lnk」。 */
    function dedupePath(dir, name) {
      let p = join(dir, name)
      if (!existsSync(p)) return p
      const ext = extname(name); const base = basename(name, ext)
      for (let i = 1; i < 999; i++) { p = join(dir, `${base}(${i})${ext}`); if (!existsSync(p)) return p }
      return join(dir, `${base}(${randomBytes(2).toString('hex')})${ext}`)
    }
    /** 行为回执（复用第一批 /playback 的模式：写 recent 供下轮简报 + 尽量写一条短记忆），失败只 log 不炸。 */
    function iconReceipt(line, memText) {
      try {
        const st = loadBehavior()
        st.recent = [...st.recent, line].slice(-8)
        saveBehavior(st)
        if (memText) api.use('memory')?.add?.({ text: memText, importance: 0.5, source: 'pet' })
      } catch (error) { api.log.warn('图标动作回执落盘失败：', String(error?.message || error)) }
    }
    /**
     * 执行入口（面板按钮 / 客户端动画落点共用）：
     *   POST /behavior/icon/act  body {mode:'hide'|'drag', icon:'文件名', playbackId?, force?, reason?}
     *   → hide：renameSync 剪切到隔离区 + manifest 追加；drag：只校验存在不挪文件。
     * iconMischiefEnabled 只拦 AI 路径（force=false）；手动 force=true 的测试按钮不拦。
     * @returns {{ok:boolean, id?:string, name:string, acted?:boolean, originalPath?:string, reason?:string}}
     */
    function iconAct({ mode, icon, playbackId, force, reason } = {}) {
      const b = behaviorSettings()
      const isForce = force === true
      // 失败一律回 acted:false，客户端据此不播「得逞」动画，只播「没得手」
      if (!b.iconMischiefEnabled && !isForce) return { ok: false, acted: false, reason: 'icon-mischief-disabled', name: String(icon || '') }
      const v = validateDesktopIcon(icon)
      if (!v.ok) return { ok: false, acted: false, reason: v.reason, name: v.name }
      const kind = mode === 'drag' ? 'drag' : mode === 'hide' ? 'hide' : ''
      if (!kind) return { ok: false, acted: false, reason: 'bad-mode', name: v.name }
      if (kind === 'drag') {
        // drag_icon：图标由客户端在 ListView 层挪着玩（跟着桌宠走），结束时自己放回原位；
        // 服务端依旧不碰文件系统（只记一条回执）。
        iconReceipt(`drag_icon → ${v.name}（图标被拖了一圈又放回去）`, '')
        return { ok: true, acted: false, name: v.name }
      }
      try {
        const id = randomBytes(4).toString('hex')
        mkdirSync(quarantineDir(), { recursive: true })
        const dest = dedupePath(quarantineDir(), v.name)
        moveFile(v.path, dest) // 唯一的「挪」动作：rename 剪切（跨卷退化为拷贝+校验），绝不删除
        const list = loadManifest()
        list.push({ id, name: v.name, originalPath: v.path, quarantinePath: dest, at: Date.now(), reason: String(reason || 'hide_icon').slice(0, 60), playbackId: String(playbackId || '').slice(0, 32) })
        saveManifest(list)
        iconReceipt(`hide_icon → ${v.name} 已收进隔离区（可放回）`, `桌宠把桌面图标「${v.name}」收进了隔离区，随时可以在面板放回去`)
        return { ok: true, acted: true, id, name: v.name, originalPath: v.path }
      } catch (error) {
        api.log.warn('图标收进隔离区失败：', String(error?.message || error))
        return { ok: false, acted: false, reason: 'hide-failed', name: v.name }
      }
    }
    /** 归还核心：rename 回原路径；原路径已有同名文件则改名「名字(归还)」再放。绝不删除。 */
    function restoreOne(item) {
      let target = item.originalPath
      try {
        if (!existsSync(item.quarantinePath)) return { ok: false, reason: 'quarantine-file-gone' }
        if (existsSync(target)) {
          const ext = extname(item.name); const base = basename(item.name, ext)
          target = join(dirname(item.originalPath), `${base}(归还)${ext}`)
          if (existsSync(target)) target = dedupePath(dirname(item.originalPath), `${base}(归还)${ext}`)
        }
        mkdirSync(dirname(target), { recursive: true })
        moveFile(item.quarantinePath, target) // 归还同样只挪不删（跨卷退化见 moveFile）
        return { ok: true, target }
      } catch (error) {
        api.log.warn('图标归还失败：', String(error?.message || error))
        return { ok: false, reason: 'restore-failed' }
      }
    }
    /** 面板「放回去」：POST /behavior/icon/restore {id}。 */
    async function iconRestore(id) {
      const list = loadManifest()
      const idx = list.findIndex((x) => x && x.id === id)
      if (idx < 0) return { ok: false, reason: 'not-found' }
      const item = list[idx]
      const r = restoreOne(item)
      if (!r.ok) {
        // 隔离区里的文件已经不在了（主人自己挪走/删了）：把这条死记录清掉，别让面板挂着点不动的按钮
        if (r.reason === 'quarantine-file-gone') { list.splice(idx, 1); saveManifest(list) }
        return { ok: false, reason: r.reason, name: item.name }
      }
      list.splice(idx, 1)
      saveManifest(list)
      iconReceipt(`hide_icon → ${item.name} 已放回原位`, `桌宠把桌面图标「${item.name}」放回原位了`)
      // 气泡汇报：只走桌宠气泡，失败静默（归还本身已经完成，别让汇报失败坏事）
      try { await dispatch({ text: `把「${item.name}」放回去啦`, purpose: 'behavior', via: 'pet', noFallback: true }) } catch {}
      return { ok: true, name: item.name, restoredTo: r.target }
    }
    /** 超期自动归还：每 10 分钟扫一次 manifest，超 iconQuarantineDays（默认 7 天）全部放回并气泡汇报一次。 */
    async function iconSweep(now = Date.now()) {
      const b = behaviorSettings()
      const cutoff = now - b.iconQuarantineDays * DAY_MS
      const list = loadManifest()
      // 隔离区文件已不在的死记录（主人自己挪走/清理过）：顺手摘掉，不碰任何文件
      const dead = new Set(list.filter((x) => !existsSync(x.quarantinePath)).map((x) => x.id))
      const expired = list.filter((x) => Number(x.at || 0) < cutoff && !dead.has(x.id))
      const flush = (keep) => { try { saveManifest(keep) } catch {} }
      if (!expired.length) {
        if (dead.size) flush(list.filter((x) => !dead.has(x.id)))
        return { ok: true, restored: 0 }
      }
      const names = []
      const done = new Set()
      for (const item of expired) {
        if (done.has(item.id)) continue
        done.add(item.id)
        const r = restoreOne(item)
        if (r.ok) { names.push(item.name); iconReceipt(`hide_icon → ${item.name} 超期自动放回`, '') }
      }
      flush(list.filter((x) => !done.has(x.id) && !dead.has(x.id)))
      if (names.length) {
        try { await dispatch({ text: `把收走的图标都放回去啦：${names.join('、')}`, purpose: 'behavior', via: 'pet', noFallback: true }) } catch {}
      }
      return { ok: true, restored: names.length, names }
    }

    // ---------- 路由 ----------
    api.route('/events', (req, res) => pollEvents(req, res))
    api.route('/status', (req, res) => {
      if (!guard(req, res).ok) return
      learnHost(req)
      const s = api.settings()
      api.core.http.send(res, 200, {
        ok: true, name: 'aurabot-pet', version: api.version,
        online: online(), focus: focusOn(), scale: petScale(), bootId, seq,
        carrier: s.carrier, modality: s.modality, fallbackToQQ: s.petFallbackToQQ !== false,
        pack: activePack(), playbackCount: playbacks.length,
        work: { ...workSnapshot(), label: WORK_STATE_LABEL[workSnap.state] || '' }, // 当前她在干什么（思考中/干活中/完成…）
        whisper: { ...whisperStatus() },
        portReady: portReady(), port: knownPort ? Number(knownPort) : null,
        electronInstalled: existsSync(electronExe()), pid: recordedPid()?.pid || null,
        client: clientStatus(), // 生成物对账：缺 behavior.js 这类「旧壳」在这里现形
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
        // 人物大小倍率（0.5~2.0）：客户端按它整窗等比缩放（setZoomFactor + setSize），物理/拖拽共用窗口宽反推
        scale: petScale(),
        work: { ...workSnapshot(), label: WORK_STATE_LABEL[workSnap.state] || '' },
        whisper: (({ enabled, source }) => ({ enabled, source }))(whisperStatus()),
        // 行为层：客户端的**反应层**（点击/勾引/摸摸/鼠标闲置）是本地直接演的，不看这一份的话
        // 面板关掉「行为总开关」根本拦不住它、鼠标闲置分钟数也永远是默认值（2026-10-30 补）。
        behavior: (() => { const b = behaviorSettings(); return { enabled: b.enabled, idleCursorMinutes: b.idleCursorMinutes } })(),
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
    // ---------- 默认素材包（手动重下）：POST /packs/fetch-default，body 留空 {} 即可 ----------
    // force=true：包已在也重新下载（换镜像地址后点这个）。自动落位走启动后 5 秒 + every 兜底轮询。
    api.route('/packs/fetch-default', async (req, res) => {
      if (!guard(req, res).ok) return
      const r = await ensureDefaultPack(true)
      ensureAssetRoutes()
      api.core.http.send(res, r.ok ? 200 : 502, r)
    })
    // ---------- 动画播放回执（P2）：客户端播完点播动画后 POST {playbackId,status} ----------
    // 行为动作扩展：status 允许 played / failed / refused（被安全闸拦），可带 reason/action 字段。
    api.route('/playback', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      const playbackId = String(body.playbackId || '').slice(0, 32)
      if (!playbackId) return api.core.http.send(res, 400, { ok: false, message: '缺 playbackId' })
      const status = ['played', 'failed', 'refused'].includes(body.status) ? body.status : (body.status === 'error' ? 'failed' : 'played')
      const entry = {
        playbackId, status,
        anim: String(body.anim || '').slice(0, 40),
        action: String(body.action || '').slice(0, 40),
        reason: String(body.reason || '').slice(0, 120),
        // 窗口动作的补充信息（close_window 记「关掉的是哪个窗口」；客户端填窗口标题/进程名）
        detail: String(body.detail || '').slice(0, 160),
      }
      recordPlayback(entry)
      // 行为动作的回执写进 behavior.json 的 recent（供下轮简报），并写一条短记忆；失败只 log 不炸
      try {
        if (entry.action) {
          const st = loadBehavior()
          const line = `${entry.action} → ${entry.status}${entry.reason ? '（' + entry.reason + '）' : ''}`
          st.recent = [...st.recent, line].slice(-8)
          // 第三批：关窗记录（面板「关窗记录」+ 一键补偿道歉的数据源）。只留最近 20 条。
          if (entry.action === 'close_window') {
            const prev = Array.isArray(st.closeLog) ? st.closeLog.filter((x) => x && typeof x === 'object') : []
            st.closeLog = [...prev, {
              at: Date.now(), status: entry.status, reason: entry.reason,
              window: entry.detail, playbackId, apologizedAt: 0,
            }].slice(-20)
          }
          saveBehavior(st)
          const mem = api.use('memory')
          const text = entry.action === 'close_window' && entry.status === 'played'
            ? `桌宠关掉了窗口「${entry.detail || '未知窗口'}」（她自己闹脾气干的，面板里可以让她道歉）`
            : `桌宠执行了 ${entry.action} 动作，结果 ${entry.status}${entry.reason ? '：' + entry.reason : ''}`
          mem?.add?.({ text, importance: entry.action === 'close_window' ? 0.6 : 0.4, source: 'pet' })
        }
      } catch (error) { api.log.warn('行为回执落盘失败：', String(error?.message || error)) }
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
    // ---------- 行为大脑：手动触发（面板「试一下」，2026-10-30 起唯一调试入口；右键菜单已移除该级联）+ 状态 + 反应层上报 ----------
    api.route('/behavior', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      // 手动触发默认 force=true：绕过专注/安静时段/每日上限；动作认全表（暂未开放的由客户端拒绝并回执）
      const r = await emitBehavior({ action: body.action, params: body.params, say: body.say, force: body.force !== false, reason: 'manual' })
      api.core.http.send(res, r.ok ? 200 : 400, r)
    })
    api.route('/behavior/status', (req, res) => {
      if (!guard(req, res).ok) return
      api.core.http.send(res, 200, { ok: true, behavior: behaviorStatus() })
    })
    api.route('/behavior/reaction', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      const kind = String(body.kind || '').trim().slice(0, 32)
      if (!kind) return api.core.http.send(res, 400, { ok: false, message: '缺 kind（click/tease/pat/idle-cursor…）' })
      // 反应层优先级最高：客户端已本地直接执行（如 chase_cursor）并自行回执，这里只把事件摘要
      // 喂给 AI 下一轮简报（lastReaction），**不重复 emit**，避免双发。
      const st = loadBehavior()
      st.lastReaction = { kind, at: Date.now(), detail: String(body.detail || '').slice(0, 120) }
      saveBehavior(st)
      api.core.http.send(res, 200, { ok: true, lastReaction: st.lastReaction })
    })
    // ---------- 桌面环境上报（2026-10-30）：窗口清单只有客户端能枚举（它已有 PowerShell 桥），
    // 定时 POST 上来缓存；下一轮简报里 AI 就能「看见主人开着什么窗口」，窗口动作也能指名。
    api.route('/behavior/env', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      envWin = { at: Date.now(), list: cleanWindowReport(body && body.windows) }
      api.core.http.send(res, 200, { ok: true, windows: envWin.list.length })
    })
    // ---------- 图标隔离区（第二批）：执行 / 清单 / 归还 ----------
    // 契约见返回值注释：面板「被收走的图标」卡片 = GET quarantine 渲染 + 每行 POST restore。
    api.route('/behavior/icon/act', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      const r = iconAct(body)
      api.core.http.send(res, r.ok ? 200 : 400, r)
    })
    api.route('/behavior/icon/quarantine', (req, res) => {
      if (!guard(req, res).ok) return
      const b = behaviorSettings()
      // enabled/days 是给面板画灰态与「超 N 天自动放回」文案的，不影响 items 契约
      api.core.http.send(res, 200, { ok: true, items: loadManifest(), enabled: b.iconMischiefEnabled, days: b.iconQuarantineDays })
    })
    api.route('/behavior/icon/restore', async (req, res) => {
      if (!guard(req, res).ok) return
      const body = await api.core.http.body(req)
      const r = await iconRestore(String(body.id || '').slice(0, 64))
      api.core.http.send(res, r.ok ? 200 : 404, r)
    })
    // 第三批：关窗记录 + 补偿道歉（面板「关窗记录」卡直接调这两条）
    api.route('/behavior/window/log', (req, res) => {
      if (!guard(req, res).ok) return
      const s = behaviorStatus()
      api.core.http.send(res, 200, {
        ok: true, items: s.closeLog, closeToday: s.closeToday, apologyDue: s.apologyDue,
        mood: s.mood, moodCloseWindowBelow: s.moodCloseWindowBelow,
        enabled: s.closeWindowEnabled, whitelist: s.windowWhitelist,
      })
    })
    api.route('/behavior/window/apologize', (req, res) => {
      if (!guard(req, res).ok) return
      const r = windowApologize()
      api.core.http.send(res, r.ok ? 200 : 404, r.ok
        ? { ok: true, window: r.window, message: r.window ? `她为「${r.window}」道了歉` : '她道了歉' }
        : { ok: false, reason: r.reason, message: '没有需要道歉的记录' })
    })
    api.route('/work', (req, res) => {
      if (!guard(req, res).ok) return
      api.core.http.send(res, 200, { ok: true, work: { ...workSnapshot(), label: WORK_STATE_LABEL[workSnap.state] || '', text: workEndText(workSnap) } })
    })
    api.route('/client/install', async (req, res) => {
      if (!guard(req, res).ok) return
      const r = installClient()
      api.core.http.send(res, 200, { ...r, client: clientStatus() })
    })
    // 生成物核对：真机排查「行为层怎么没反应」的第一步（curl 这个就知道 app/ 缺没缺文件）
    api.route('/client/status', (req, res) => {
      if (!guard(req, res).ok) return
      api.core.http.send(res, 200, { ok: true, client: clientStatus() })
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
    // 行为大脑排程同样先落一次盘（独立配额，与碎碎念互不知晓）
    try { const b0 = loadBehavior(); if (!b0.nextAt) { planBehavior(b0, behaviorSettings()); saveBehavior(b0) } } catch {}
    const offHostTimer = api.every(120_000, () => { writeHostFile(true); ensureAssetRoutes() }, '刷新 host.json 与素材路由')
    // 碎碎念：60s 心跳里只做「读一次状态文件 + 纯逻辑判断」，重活都别放进 tick
    const offWhisper = api.every(60_000, () => whisperTick(), '碎碎念')
    const offBehavior = api.every(60_000, () => behaviorTick(), '行为大脑')
    // 图标隔离区超期自动归还：10 分钟一扫（读 manifest 纯逻辑，重活不在 tick 里）
    const offIconSweep = api.every(600_000, () => { iconSweep().catch((e) => api.log.warn('图标超期归还出错：', String(e?.message || e))) }, '图标隔离区超期归还')
    api.onDispose(() => { offHostTimer(); offWhisper(); offBehavior(); offIconSweep(); waiters.clear(); presence.clear(); workMap.clear() })
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
      ensureDefaultPack,                     // 素材包下载落位（force=false 只在缺包时下；测试/面板手动用）
      // 碎碎念（桌宠自己的气泡流）与干活状态
      whisper: whisperOnce,                  // 手动/测试：立即碎碎念一句（force）
      whisperNow: whisperOnce,
      whisperStatus,
      whisperTick,
      // AI 行为大脑（决策层）：AI 只挑动作，本地执行器按单办事
      behavior: behaviorOnce,
      behaviorStatus,
      behaviorTick,
      behaviorEmit: emitBehavior,            // 手动下发（面板「试一下」/客户端右键菜单同通道）
      behaviorParse: parseBehaviorAction,    // 测试钩子：宽松解析动作单（非法动作返回 null）
      iconAct,                               // 测试钩子：隔离区执行入口（POST /behavior/icon/act 同函数）
      iconRestore,                           // 测试钩子：归还（POST /behavior/icon/restore 同函数）
      iconQuarantine: loadManifest,          // 测试钩子：隔离区清单
      iconList: listDesktopIcons,            // 测试钩子：桌面上「可碰」的图标清单（同简报里喂给 AI 的那份）
      iconSweep,                             // 测试钩子：超期归还（定时器同函数，可注入 now）
      clientStatus,                          // 测试钩子：客户端生成物对账（/status 里的 client 同函数）
      windowApologize,                        // 测试钩子：补偿道歉（POST /behavior/window/apologize 同函数）
      behaviorActionsForTest: () => BEHAVIOR_ACTIONS, // 测试钩子：动作表（含默认台词，锁「每个动作都有气泡」）
      behaviorSayForTest: (act) => BEHAVIOR_SAY[act] || '', // 测试钩子：动作默认台词
      onSessionEvent,                        // host.js 把 ctx.on('session/event') 转发进来
      workStatus: () => ({ ...workSnapshot(), label: WORK_STATE_LABEL[workSnap.state] || '', text: workEndText(workSnap) }),
      status: () => {
        const s = api.settings()
        const w = workSettings()
        return {
          ...online(), focus: focusOn(), scale: petScale(), carrier: s.carrier, modality: s.modality, bootId, seq,
          pack: activePack(), playbackCount: playbacks.length,
          work: { ...workSnapshot(), label: WORK_STATE_LABEL[workSnap.state] || '' },
          workEnabled: w.enabled, workBubble: w.bubble, workNotify: w.notify,
          workAnimMap: (packView() || {}).workStatus || null, // 面板展示「六档动画能不能对上」
          whisper: whisperStatus(),
          portReady: portReady(), port: knownPort ? Number(knownPort) : null,
          electronInstalled: existsSync(electronExe()), pid: recordedPid()?.pid || null,
          client: clientStatus(), // 面板「桌宠」卡据此提示重新生成（缺文件 = 行为层静默失效）
        }
      },
      state: () => ({ count: delivered.length }),
    }
  },
}
