// Aurabot · 宿主半边（DSH 插件入口）
//
// 让 DSH 里的 AI 以独立 QQ 号「大肥鱼」住在 QQ 里：
//   SnowLuma（OneBot v11）⇄ 本插件 ⇄ DSH 会话（Aurabot 自带的 preset + 人格）
// 面板在侧栏「自动化任务」下面（网页半边见 client/client.js），这里提供它要的 /aurabot/api/* 接口。
//
// 这个文件只管「核心」：配置、QQ 网关、聊天中枢、人格、面板接口、模块内核和联动。
// 表情、语音、记忆、空间、B 站、翻唱、生图……都是模块（src/modules/），能单独关掉，也能用自己写的替换。
//
// ⚠ 安全默认：总开关关、试运行开。不手动打开，一句都不会真的发到 QQ。

import { readFileSync, existsSync, writeFileSync, unlinkSync, statSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { loadConfig, saveConfig, publicConfig, mergeFromPanel } from './core/config.js'
import { createLogger } from './core/logger.js'
import { registerSecret, redact } from './core/redact.js'
import { createOneBotClient } from './onebot/client.js'
import { createSnowLumaManager, DOWNLOAD_PAGE } from './snowluma/manager.js'
import { createHub, workspaceDirOf } from './chat/hub.js'
import { createLocal, fileOf, toImageBuffer } from './local/local.js'
import { createGroupRoles } from './chat/group-roles.js'
import { defaultModel, askModel, modelReasoning, modelVision, clearReasoningCache, clearVisionCache } from './core/llm.js'
import { mimeOf } from './chat/inbound.js'
import { dataDir, ensureDir } from './core/store.js'
import { createUpdateChecker, changelogSection } from './core/update.js'
import { parseCommand, runCommand, createMutes, commandList } from './chat/commands.js'
import { listPersonas, readPersona, savePersona, deletePersona, currentPersonaText, rulesText, seedPersonas } from './persona/personas.js'
import { createModules, API_VERSION } from './core/modules.js'
import { createCommunity } from './core/community.js'
import { applyPendingRestore, cancelRestore, createBackup, listBackups, pendingModules, pendingRestore, saveUpload, setPendingModules, stageRestore } from './core/backup.js'
import { cleanText } from './core/text.js'
import { createBridge } from './core/bridge.js'
import { createDangerGuard } from './security/danger.js'
import { setSsrpMode } from './core/net.js'
import { BUILTINS } from './modules/index.js'

export const name = 'aurabot'
export const inject = ['agents', 'sessions', 'webServer', 'timer', 'workspaceRegistry', 'attachments', 'systemPrompt', 'llm']

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = (() => {
  try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) } catch (error) { return { version: '?' } }
})()
const VERSION = PKG.version
const PREFIX = '/aurabot/api'

export function apply(ctx) {
  const logger = createLogger({ dsh: ctx })
  const log = logger.child('core')
  // 恢复备份必须在读配置之前：读完配置后内存里的旧状态会写回去
  try {
    const restored = applyPendingRestore()
    if (restored) log.info(`已恢复备份：${restored} 个文件，原来的文件在 backups/ 里留了底`)
  } catch (error) { log.error('恢复备份失败：', error.message) }
  let cfg = loadConfig()
  let mods = null
  let bridge = null
  const getConfig = () => cfg
  setSsrpMode(() => (getConfig().security && getConfig().security.ssrfMode === 'loose' ? 'loose' : 'strict'))
  const secrets = () => { for (const k of ['webuiPassword', 'httpToken', 'wsToken']) registerSecret(cfg.snowluma[k]); registerSecret(cfg.imageGen.apiKey); registerSecret(cfg.bridge.token) }
  const setConfig = (next) => {
    const before = cfg
    cfg = saveConfig(next)
    // 改机器人号后旧连接的核对结果立刻失效，必须重新核对才能处理消息或完成向导。
    if (before.botQQ !== cfg.botQQ) {
      wrongAccount = ''
      if (onebotState === 'connected') onebot.restart()
    }
    secrets()
    if (bridge && before.bridge.dshTools !== cfg.bridge.dshTools) bridge.refresh()
    if (mods && (JSON.stringify(before.modules) !== JSON.stringify(cfg.modules) || before.safeMode !== cfg.safeMode)) mods.sync().catch(() => {})
    mods?.emit('config', cfg, before)
    return cfg
  }
  secrets()
  seedPersonas()

  // ---------- 人格与规则：通过提示词变量注入到 Aurabot 的两个 preset ----------
  const variable = (n, fn) => ctx.effect(() => ctx.systemPrompt.variable(n, (...args) => cleanText(fn(...args))), `aurabot: 变量 ${n}`)
  const rulesOpts = (kind) => (mods ? { off: mods.builtinOff(), extra: mods.rules(kind) } : {})
  // 扩展模块能整段改写人格和规则（同步：提示词变量不能等）
  const rewrite = (event, text, ...args) => { const r = mods ? mods.filterSync(event, text, ...args) : text; return typeof r === 'string' ? r : r === null ? '' : text }
  variable('aurabot_persona', () => rewrite('persona', currentPersonaText(cfg.persona.current)))
  variable('aurabot_rules_private', () => {
    const base = rewrite('rules', rulesText('private', cfg, rulesOpts('private')), 'private')
    // 危险命令确认开着时补一句：被拦下要如实告诉主人，别绕着写
    return base + (cfg.security && cfg.security.dangerConfirm
      ? '\n【危险命令】终端命令如果被安全策略拦下（删根目录/格式化/关机/下载后直接执行等），把命令原文和原因如实告诉主人，等主人回复「确认」后再重试；不要换一种写法绕过。'
      : '')
  })
  variable('aurabot_rules_social', () => rewrite('rules', rulesText('social', cfg, rulesOpts('social')), 'social'))

  // ---------- QQ 网关 ----------
  const snowluma = createSnowLumaManager({
    getConfig,
    log: logger.child('snowluma'),
    // 控制台密码由插件自动生成并保存，用户不用管
    savePassword: (pw, auto = true) => setConfig({ ...cfg, snowluma: { ...cfg.snowluma, webuiPassword: pw, passwordAuto: auto } }),
  })
  const endpoint = () => {
    const s = cfg.snowluma
    // 接自己的 OneBot 时只认填的地址；用 SnowLuma 时没填的从它的配置里读
    const auto = cfg.gateway === 'onebot' || (s.httpUrl && s.wsUrl) ? null : snowluma.endpoint()
    return {
      httpUrl: s.httpUrl || auto?.httpUrl || '',
      wsUrl: s.wsUrl || auto?.wsUrl || '',
      httpToken: s.httpToken || auto?.httpToken || '',
      wsToken: s.wsToken || auto?.wsToken || '',
    }
  }
  let onebotState = 'stopped'
  // 连上后先核对登录的是不是机器人号，核对通过前不处理任何消息；不是就断开，不再自动重连
  let loginOk = false
  let wrongAccount = ''
  // 核对期间收到的事件先攒着：核对通过就补处理，核对失败就丢掉。
  // 直接丢弃的话，刚连上那几百毫秒里主人发的消息就没了（登录核对要等一次 get_login_info 往返）。
  let verifying = false
  let pendingEvents = []
  let hub = null
  let dangerGuard = null // 危险命令确认（security.dangerConfirm 开着才生效）
  async function checkLogin() {
    verifying = true
    pendingEvents = []
    try {
      let uin = ''
      try {
        const info = await onebot.call('get_login_info', {}, { timeoutMs: 10000 })
        uin = String(info?.user_id ?? '')
      } catch (error) {
        logger.child('onebot').warn('核对登录的 QQ 号失败：', error.message)
      }
      if (onebotState !== 'connected') return
      if (!uin) {
        // 核对不了就别用，断开后由看门狗重试
        onebot.stop()
        return
      }
      if (await snowluma.confirmLogin(uin)) {
        loginOk = true
        wrongAccount = ''
        // 把核对期间攒下的补上（按到达顺序）
        const queued = pendingEvents
        pendingEvents = []
        for (const ev of queued) handleEvent(ev)
      } else {
        wrongAccount = uin
        pendingEvents = []
        onebot.stop()
      }
    } finally {
      verifying = false
    }
  }
  /** 核对通过后的事件都在这里处理（onEvent 直接调，核对期间攒下的也会补到这里）。 */
  function handleEvent(ev) {
    if (!hub) return
    // 模块能看到所有原始事件（加群、撤回、好友申请……），只看不拦
    mods?.emit('onebot', ev)
    if (ev.post_type === 'message' || ev.post_type === 'message_sent') {
      if (ev.post_type === 'message') {
        // 危险命令确认：主人的「确认 / 取消」回复先在这里截住，不交给聊天中枢
        if (dangerGuard && ev.message_type === 'private') {
          const text = Array.isArray(ev.message)
            ? ev.message.filter((seg) => seg && seg.type === 'text').map((seg) => String(seg.data?.text || '')).join('')
            : ''
          if (dangerGuard.handleReply(`private:${ev.user_id}`, ev.user_id, text)) return
        }
        hub.onMessage(ev).catch((error) => log.error('处理消息出错：', error.message))
      }
    } else if (ev.post_type === 'notice' && ev.notice_type === 'notify' && ev.sub_type === 'poke') {
      hub.onPoke(ev).catch((error) => log.error('处理戳一戳出错：', error.message))
    } else if (ev.post_type === 'notice' && ev.notice_type === 'group_upload') {
      hub.onGroupFile(ev).catch((error) => log.error('处理群文件出错：', error.message))
    }
  }
  const onebot = createOneBotClient({
    endpoint,
    log: logger.child('onebot'),
    onState: (s, d) => {
      onebotState = s
      if (s !== 'connected') { loginOk = false; pendingEvents = [] }
      else checkLogin().catch((error) => log.warn('核对登录号出错：', error.message))
      logger.child('onebot').info(`QQ 网关：${s}${d ? '（' + d + '）' : ''}`)
      mods?.emit('onebot/state', s)
    },
    onEvent: (ev) => {
      // 还没核对是机器人号：核对期间先攒着，核对通过后补处理
      if (!loginOk) {
        if (verifying) {
          pendingEvents.push(ev)
          if (pendingEvents.length > 200) pendingEvents.shift()
        }
        return
      }
      handleEvent(ev)
    },
  })
  const groupRoles = createGroupRoles({ onebot, getConfig, log: logger.child('chat') })
  const local = createLocal({ getConfig, log: logger })
  const mutes = createMutes()

  /**
   * DSH 里能用的所有模型：[{provider, model, name, reasoning}]。
   * reasoning 是 {efforts:[...], default} 或 null（null = 这个模型不支持思考强度，
   * 面板据此把「思考强度」置灰，免得选了之后整轮报错）。
   */
  async function listModels() {
    const llm = ctx.llm || ctx.get('llm')
    const out = []
    for (const p of llm.listProviders() || []) {
      const provider = typeof p === 'string' ? p : p.provider || p.id || p.name
      try {
        for (const m of (await llm.listModels(provider)) || []) {
          const model = m.id || m.model
          out.push({ provider, model, name: m.name || model, reasoning: await modelReasoning(ctx, provider, model), vision: await modelVision(ctx, provider, model) })
        }
      } catch (error) {}
    }
    if (out.length) modelCache = out
    return out
  }
  // 最近一次查到的模型列表：按聊天选的模型已经不在 DSH 里了，就退回下一级（同步取，hub 每条消息都要用）
  let modelCache = null
  setTimeout(() => { listModels().catch(() => {}) }, 3000).unref?.()

  // 聊天中枢找表情库、语音时，找的是当时在跑的那个模块；模块关着就当没有
  const use = (id) => mods?.use(id) || null
  const stickers = {
    match: (q) => use('stickers')?.match?.(q) ?? null,
    segmentFor: (it) => use('stickers')?.segmentFor?.(it) ?? null,
    markUsed: (md5) => use('stickers')?.markUsed?.(md5),
    pickForReply: (t) => use('stickers')?.pickForReply?.(t) ?? null,
    collect: async (s, chatId) => (use('stickers')?.collect ? use('stickers').collect(s, chatId) : { ok: false, reason: '表情包模块关着' }),
    library: () => use('stickers')?.library?.() ?? { items: [] },
  }
  const tts = {
    speak: async (text) => {
      const v = use('voice')
      if (!v?.speak) throw new Error('语音模块关着')
      return v.speak(text)
    },
  }

  hub = createHub({
    localApi: local,
    dsh: ctx,
    getConfig,
    log: logger.child('chat'),
    onebot,
    stickers,
    tts,
    buildTools: (where) => mods.buildTools(where),
    contextProviders: [(args) => mods.contextFor(args)],
    onActivity: (a) => mods.emit('activity', a),
    // 群聊话题和她的记忆有多相关（插话判断用）
    memoryScore: (text) => use('memory')?.topicScore?.(text) ?? 0,
    // QQ 里的主人命令（模块加的命令优先）
    onCommand: async (msg) => {
      const cmd = parseCommand(msg.text, mods.commands())
      if (!cmd) return null
      if (cmd.ext) return String((await cmd.ext.run(cmd.arg, msg)) ?? '')
      return runCommand(cmd, msg, { getConfig, setConfig, mutes, hub, mood: use('mood'), memory: use('memory'), qzone: use('diary'), song: use('song'), listModels, defaultModel: () => defaultModel(ctx, { model: {} }), extraCommands: mods.commands() })
    },
    isMuted: (chatId) => mutes.muted(chatId),
    moodEffects: () => use('mood')?.effects?.() ?? null,
    availableModels: () => modelCache,
    // 模块（重）启动代际：模块热重载后工具名没变、但实例换了，hub 要据此重挂工具（issue #73）
    toolsGeneration: () => (mods ? mods.generation?.() || 0 : 0),
    hooks: {
      message: (msg) => mods.claim('message', msg),
      reply: (text, info) => mods.filter('reply', text, info),
      deniedTools: () => bridge?.deniedTools() || [],
      groupDecide: (decision, info) => mods.filter('group/decide', decision, info),
      prompt: (content, info) => mods.filter('prompt', content, info),
      items: (items, info) => mods.filter('reply/items', items, info),
      send: (message, info) => mods.filter('send', message, info),
      model: (sel, chat) => mods.filterSync('model', sel, chat),
      poke: (ev) => mods.claim('poke', ev),
    },
  })

  // ---------- 面板接口的小工具 ----------
  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    try {
      res.statusCode = code
      res.setHeader?.('content-type', type)
      res.setHeader?.('cache-control', 'no-store')
      res.end?.(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
    } catch (error) {}
  }
  const readBody = async (req) => {
    let s = ''
    try { for await (const c of req) s += c } catch (error) {}
    try { return JSON.parse(s || '{}') } catch (error) { return {} }
  }
  /** 原样读请求体（上传大文件用），超过 max 字节就报错。 */
  const readRaw = async (req, max) => {
    const parts = []
    let n = 0
    for await (const c of req) {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c)
      n += b.length
      if (n > max) throw new Error(`文件太大了（最多 ${Math.round(max / 1024 / 1024)}MB）`)
      parts.push(b)
    }
    return Buffer.concat(parts)
  }
  const query = (req) => {
    try { return Object.fromEntries(new URL(req.url, 'http://x').searchParams) } catch (error) { return {} }
  }
  // 核心自己的接口登记成精确路径；模块的接口都走一个前缀路由，请求进来再查表
  // （模块随时开关、重新加载；关着的模块的接口回「模块没开」，面板不会白屏）
  const answer = async (res, fn) => {
    try {
      const r = await fn()
      if (r !== undefined) send(res, 200, r)
    } catch (error) {
      send(res, 200, { ok: false, message: redact(String(error && error.message ? error.message : error)) })
    }
  }
  const route = (path, handler) => ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: PREFIX + path, handler: (req, res) => answer(res, () => handler(req, res)) }), `aurabot: 路由 ${path}`)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX, // DSH 按「路径 = 前缀 或 以 前缀/ 开头」匹配，前缀本身不带结尾的 /
    handler: (req, res) => answer(res, () => {
      let path = ''
      try { path = new URL(req.url, 'http://x').pathname } catch (error) {}
      return mods.handle(path, req, res)
    }),
  }), 'aurabot: 模块接口')

  // ---------- 模块 ----------
  const core = {
    hub, onebot, snowluma, local, groupRoles, mutes, logger, bridge: null,
    root: ROOT,
    ask: (opts) => askModel(ctx, { cfg: getConfig(), ...opts }),
    listModels,
    defaultModel: () => defaultModel(ctx, { model: {} }),
    http: { body: readBody, raw: readRaw, query, send },
    personas: { list: listPersonas, read: readPersona, current: () => currentPersonaText(cfg.persona.current) },
    getConfig, setConfig,
  }
  mods = createModules({ ctx, core, getConfig, setConfig, logger, version: VERSION, builtins: BUILTINS })
  bridge = createBridge({ ctx, getConfig, setConfig, hub, mods, log: logger.child('bridge'), version: VERSION, apiVersion: API_VERSION, overview: () => overview() })
  core.bridge = bridge
  core.modules = mods
  // 危险命令确认（可选保护）：DSH 在真正执行终端工具前会走 tools/pre-execute；
  // 这里只拦 bash / pwsh 的危险命令，其它工具和普通命令原样放行。
  dangerGuard = createDangerGuard({
    getConfig,
    log: logger.child('危险命令'),
    deliver: (chatId, text) => hub.sendText(chatId, text),
    chatOfSession: (sessionId) => { try { return hub.chatOfSession?.(sessionId) || '' } catch (error) { return '' } },
    ownerQQ: () => cfg.ownerQQ,
  })
  core.dangerGuard = dangerGuard
  ctx.effect(() => {
    let off = null
    try { off = ctx.on('tools/pre-execute', (exec, next) => dangerGuard.preExecute(exec, next)) } catch (error) { log.debug('挂危险命令确认失败：', error.message) }
    return () => { try { if (typeof off === 'function') off() } catch (error) {} }
  }, 'aurabot: 危险命令确认')

  // ---------- 桌宠端口注入（破「端口自举死锁」） ----------
  // pet 模块写 host.json 的 baseUrl 需要真实 Web 端口，而它自己监听不到（端口未知时只能写 null，
  // 客户端连不上 → 学不到 Host 头 → 死锁）。DSH 的 webServer 服务知道端口（ctx.webServer.port，
  // 取不到再退 DSH_WEB_URL）。注入时机：pet 每次启动/重载（module/start）+ boot 完成兜底各试一次；
  // Host 头学习仍保留，作端口漂移纠正。
  function webPortOf() {
    let port = Number(ctx?.webServer?.port)
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
      try { port = Number(new URL(String(process.env.DSH_WEB_URL || '')).port) } catch { port = 0 }
    }
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0
  }
  function injectPetPort() {
    const port = webPortOf()
    if (!port) return false
    try { return Boolean(use('pet')?.setWebPort?.(port)) } catch { return false }
  }
  mods.listen('module/start', (id) => { if (id === 'pet') injectPetPort() })

  let unloaded = false
  const community = createCommunity({ mods, getConfig, setConfig, log, version: VERSION, alive: () => !unloaded })
  const booted = mods.boot()
  booted.then(() => injectPetPort()).catch(() => {})
  booted.then(() => (unloaded ? [] : community.migrate())).catch((error) => log.warn('搬到社区库的模块处理失败：', error.message))
    .then(async () => {
      // 恢复备份后把市场模块装回来；没装上的留着，下次启动再试
      const left = []
      for (const id of pendingModules()) {
        if (unloaded) return
        const r = await community.install(id)
        if (!r.ok && !/自己的文件夹/.test(r.message)) { left.push(id); log.warn(`恢复模块「${id}」没装上，下次启动再试：`, r.message) }
      }
      if (!unloaded) setPendingModules(left)
    }).catch((error) => log.warn('恢复模块失败：', error.message))
  booted.then(() => { if (!unloaded) bridge.refresh() })

  // ---------- 审批请求：DSH 要授权时把请求发到 QQ ----------
  // 说明：DSH 的批准动作只能由界面回答（host 拿不到应答通道），所以这里只做通知。
  const approvalSeen = new Map()
  async function notifyApproval(session, event) {
    try {
      if (!cfg.enabled || cfg.dryRun || cfg.approvalNotify === false) return
      const d = event.data || {}
      const id = String(d.id || '')
      if (!id || approvalSeen.has(id)) return
      approvalSeen.set(id, Date.now())
      if (approvalSeen.size > 200) { for (const [k, t] of approvalSeen) if (Date.now() - t > 6 * 3600_000) approvalSeen.delete(k) }
      let title = ''
      try { title = String(session?.title || session?.id || '') } catch (error) {}
      const lines = ['【要授权】' + (d.toolName || '未知工具')]
      if (d.reason) lines.push('原因：' + String(d.reason).slice(0, 300))
      if (title) lines.push('会话：' + title.slice(0, 60))
      lines.push('这个得在 DSH 界面里点「批准」，QQ 这边没法代答。')
      await hub.sendText(`private:${cfg.ownerQQ}`, lines.join('\n'))
    } catch (error) {
      log.debug?.('审批通知失败：', error.message)
    }
  }

  // ---------- 盯会话：一轮结束就发回 QQ ----------
  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      try {
        hub.onSessionEvent(session, event)
      } catch (error) {
        log.warn('会话事件处理出错：', error.message)
      }
      // 桌宠的「干活状态」动画 / 结束提醒：把同一条事件顺手转给 pet 模块（模块没开就是 null，纯旁路）
      try { use('pet')?.onSessionEvent?.(session, event) } catch (error) { log.debug?.('桌宠状态联动出错：', error.message) }
      // 审批请求顺手通知到主人私聊（只通知，不代答）
      if (event && event.type === 'approval/asked') notifyApproval(session, event)
    })
    return () => { try { if (typeof off === 'function') off() } catch (error) {} }
  }, 'aurabot: 盯会话')

  // ---------- 启动 / 看门狗 ----------
  async function watchdog() {
    if (!cfg.enabled) {
      if (onebot.state !== 'stopped') onebot.stop()
      return
    }
    const own = cfg.gateway === 'snowluma' // 接别人的 OneBot 时不启动、不注入 SnowLuma
    const inst = snowluma.detect()
    if (own && inst.installed && cfg.snowluma.autoStart && !(await snowluma.running())) {
      const r = await snowluma.start()
      log.info('SnowLuma：', r.message)
    }
    // 上次连上的不是机器人号：等主人手动点「接入机器人号」或改设置再连
    if (wrongAccount) return
    if (onebot.state === 'stopped') onebot.start()
    if (own && cfg.snowluma.autoAttach && cfg.snowluma.webuiPassword && onebotState !== 'connected' && (await snowluma.running())) {
      const last = snowluma.lastAttach
      if (Date.now() - last.at > 60_000) {
        const r = await snowluma.attachBot()
        log.info('接入机器人号：', r.message)
      }
    }
  }
  const safe = (fn, label) => () => { Promise.resolve().then(fn).catch((error) => log.warn(`${label}出错：`, error.message)) }
  ctx.effect(() => ctx.interval(safe(watchdog, '看门狗'), 30_000), 'aurabot: 看门狗')
  const firstWatch = setTimeout(safe(watchdog, '看门狗'), 3000)
  firstWatch.unref?.()
  ctx.effect(() => () => {
    unloaded = true
    clearTimeout(firstWatch)
    dangerGuard?.dispose()
    hub.dispose()
    bridge.dispose()
    mods.dispose()
    onebot.stop()
    snowluma.dispose()
  }, 'aurabot: 收尾')

  // ---------- 面板接口 ----------
  let consentCache = { at: 0, value: null }
  async function consented(running) {
    if (!running) return null
    if (Date.now() - consentCache.at < 30_000) return consentCache.value
    let value = null
    try { value = !(await snowluma.agreements()).consentRequired } catch (error) {}
    consentCache = { at: Date.now(), value }
    return value
  }

  async function overview() {
    const inst = snowluma.detect()
    const running = inst.installed ? await snowluma.running() : false
    let login = null
    if (onebotState === 'connected') {
      try {
        const info = await onebot.call('get_login_info', {}, { timeoutMs: 5000 })
        login = { uin: String(info?.user_id ?? ''), nickname: info?.nickname || '' }
      } catch (error) {}
    }
    const diary = use('diary')
    const memory = use('memory')
    return {
      ok: true,
      version: VERSION,
      apiVersion: API_VERSION,
      config: publicConfig(cfg),
      onebot: { state: onebotState, login, endpoint: { httpUrl: endpoint().httpUrl, wsUrl: endpoint().wsUrl }, problem: onebotState === 'connected' && loginOk ? '' : await connectionProblem() },
      snowluma: { ...inst, running, consented: await consented(running), owns: snowluma.ownsProcess, lastAttach: snowluma.lastAttach, downloadPage: DOWNLOAD_PAGE, webui: snowluma.webuiUrl() },
      stats: hub.stats(),
      // 模块关着时给个空壳，面板照常显示
      mood: use('mood')?.state?.() ?? { value: 0, label: '心情模块关着', reason: '', history: [] },
      stickers: { count: stickers.library().items.length },
      diary: diary ? { next: diary.nextTime(), last: diary.history()[0] || null } : { next: 0, last: null },
      qzoneSocial: use('qzone-social')?.state?.() ?? null,
      speakUp: use('speakup')?.state?.() ?? { count: 0 },
      purpose: purposeOverview(),
      pet: petStatus(),
      memory: { lastConsolidate: memory?.lastConsolidate?.() ?? 0 },
      avatar: avatarInfo(),
      voice: { edgeInstalled: use('voice')?.edgeInstalled?.() ?? false },
      song: use('song')?.status?.() ?? null,
      sessions: hub.sessions(),
      workspaceDir: workspaceDirOf(cfg),
      personas: listPersonas(),
      modules: mods.status(),
      bridge: { dshTools: cfg.bridge.dshTools, http: cfg.bridge.http, hasToken: Boolean(cfg.bridge.token), tools: bridge.deniedTools(), toolsService: Boolean(ctx.get?.('tools')) },
    }
  }

  // ---------- 面板：目的机制 / 桌宠 聚合 ----------
  // 面板令牌脱敏：任何 32 位以上的十六进制串（pet host-token、bridge token 等）只留尾 4 位。
  const HEX_RE = /[0-9a-f]{32,}/gi
  function redactTokens(value) {
    const walk = (v) => typeof v === 'string' ? v.replace(HEX_RE, (m) => '（已脱敏…' + m.slice(-4) + '）')
      : Array.isArray(v) ? v.map(walk)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => /token|secret/i.test(k) && typeof x === 'string' && x ? [k, '（已脱敏…' + String(x).slice(-4) + '）'] : [k, walk(x)]))
      : v
    return walk(value)
  }
  // 「目的引擎」聚合：purpose 是默认关的独立内置模块，没开时 available=false，面板显示引导文案，不报错。
  // 安静时段真相 = speakUp 醒着窗口（与 purpose/module.js 的 purposeConfig 派生保持一致）。
  function purposeOverview() {
    const pu = use('purpose')
    const ext = (cfg.ext && cfg.ext.purpose) || {}
    const sp = cfg.speakUp || {}
    const pad2 = (n) => String(n % 24).padStart(2, '0')
    const awakeFrom = Number.isFinite(sp.awakeFrom) ? sp.awakeFrom : 8
    const awakeTo = Number.isFinite(sp.awakeTo) ? sp.awakeTo : 23
    const quiet = awakeTo >= 24 || awakeFrom >= awakeTo ? { quietStart: '00:00', quietEnd: '00:00' } : { quietStart: pad2(awakeTo) + ':00', quietEnd: pad2(awakeFrom) + ':00' }
    return {
      available: typeof pu?.status === 'function',
      enabled: ext.enabled === true,
      status: pu?.status?.() ?? null,
      count: pu?.state?.().count ?? 0,
      carrier: ext.carrier === 'pet' ? 'pet' : 'qq',
      petFallbackToQQ: ext.petFallbackToQQ !== false,
      pacing: ['conservative', 'default', 'active'].includes(ext.pacing) ? ext.pacing : 'default',
      quietStart: quiet.quietStart,
      quietEnd: quiet.quietEnd,
      dailyMax: Number.isFinite(sp.maxPerDay) ? sp.maxPerDay : null,
      awakeFrom,
      awakeTo,
    }
  }
  const petStatus = () => redactTokens(use('pet')?.status?.() ?? null)

  route('/state', async () => overview())

  route('/save', async (req) => {
    const body = await readBody(req)
    const before = cfg
    // 控制台密码不能只改配置（SnowLuma 那边还是旧的）：拿出来单独去 SnowLuma 改
    const newPw = typeof body?.snowluma?.webuiPassword === 'string' ? body.snowluma.webuiPassword : ''
    if (body?.snowluma) delete body.snowluma.webuiPassword
    setConfig(mergeFromPanel(cfg, body))
    let pw = null
    if (newPw && newPw !== before.snowluma.webuiPassword) pw = await snowluma.setPassword(newPw)
    const changedConn = before.gateway !== cfg.gateway || ['httpUrl', 'wsUrl', 'httpToken', 'wsToken', 'dir'].some((k) => before.snowluma[k] !== cfg.snowluma[k])
    // 换了模型：思考强度和「能不能看图」的探测结果都得重来，不然要等 10 分钟缓存过期
    const changedModel = before.model.provider !== cfg.model.provider || before.model.model !== cfg.model.model
    if (changedModel) { clearReasoningCache(); clearVisionCache() }
    if (changedConn || before.botQQ !== cfg.botQQ) wrongAccount = ''
    if (changedConn && onebot.state !== 'stopped') onebot.restart()
    if (!before.enabled && cfg.enabled) setTimeout(safe(watchdog, '看门狗'), 100)
    if (before.enabled && !cfg.enabled) onebot.stop()
    log.info(`设置已保存｜总开关 ${cfg.enabled ? '开' : '关'}｜试运行 ${cfg.dryRun ? '开' : '关'}`)
    await mods.sync().catch(() => {})
    if (pw && !pw.ok) return { ...(await overview()), ok: false, message: '其他设置保存了，但控制台密码没改：' + pw.message }
    return { ...(await overview()), message: '保存好了' + (pw ? '，' + pw.message : '') }
  })

  // ---------- 面板代理：目的引擎 / 桌宠 ----------
  // 统一走 /panel/* 前缀，避免和模块自注册的 /purpose/*、/pet/* 路由撞名；模块缺新接口时降级返回 available:false。
  route('/panel/purpose/status', async () => ({ ok: true, purpose: purposeOverview(), pet: petStatus() }))
  route('/panel/purpose/preview', async () => {
    const pu = use('purpose')
    if (typeof pu?.preview !== 'function') return { ok: false, available: false, message: '目的引擎模块没在跑，没法预览' }
    return { ok: true, result: redactTokens(await pu.preview()) }
  })
  route('/panel/purpose/run', async () => {
    const pu = use('purpose')
    if (typeof pu?.run !== 'function') return { ok: false, available: false, message: '目的引擎模块没在跑' }
    const r = await pu.run('面板')
    const msg = r && { sent: '已经去找你了', silent: '她这轮想了想，决定不说（不硬发）', muted: '主人在私聊里让她闭嘴了', disabled: '目的引擎开关是关的' }[r.outcome]
    return { ok: !r || r.outcome !== 'disabled', message: msg || (r ? `这轮结束：${r.outcome}` : '没有结果'), result: redactTokens(r) }
  })
  route('/panel/purpose/config', async (req) => {
    const b = await readBody(req)
    const patch = {}
    const extPatch = {}
    if (typeof b.enabled === 'boolean') extPatch.enabled = b.enabled
    if (b.carrier === 'qq' || b.carrier === 'pet') extPatch.carrier = b.carrier
    if (typeof b.petFallbackToQQ === 'boolean') extPatch.petFallbackToQQ = b.petFallbackToQQ
    if (['conservative', 'default', 'active'].includes(b.pacing)) extPatch.pacing = b.pacing
    if (Object.keys(extPatch).length) patch.ext = { purpose: extPatch }
    const spPatch = {}
    for (const k of ['awakeFrom', 'awakeTo', 'maxPerDay']) if (Number.isFinite(b[k])) spPatch[k] = Math.max(0, Math.floor(b[k]))
    if (Object.keys(spPatch).length) patch.speakUp = spPatch
    if (!Object.keys(patch).length) return { ok: false, message: '没有可保存的字段' }
    setConfig(mergeFromPanel(cfg, patch))
    log.info(`面板已保存目的引擎设置｜${Object.keys(extPatch).map((k) => k + '=' + extPatch[k]).concat(Object.keys(spPatch).map((k) => k + '=' + spPatch[k])).join(' ')}`)
    return { ok: true, purpose: purposeOverview() }
  })
  route('/panel/pet/status', async () => ({ ok: true, pet: petStatus() }))
  // 桌宠页下方的设置项：碎碎念（桌宠自己的气泡流）+ 干活状态动画/结束提醒
  route('/panel/pet/config', async (req) => {
    const b = await readBody(req)
    const patch = {}
    for (const k of ['whisperEnabled', 'whisperPauseOnPetCarrier', 'workStatusEnabled', 'workBubble', 'workNotify']) {
      if (typeof b[k] === 'boolean') patch[k] = b[k]
    }
    if (b.whisperSource === 'model' || b.whisperSource === 'pool') patch.whisperSource = b.whisperSource
    for (const k of ['whisperMinMinutes', 'whisperMaxMinutes', 'whisperMaxPerDay']) {
      // 面板口径：间隔 1~9999 分钟、每日上限 0~9999 次（0 = 不发）
      if (Number.isFinite(b[k])) patch[k] = k === 'whisperMaxPerDay' ? Math.min(9999, Math.max(0, Math.floor(b[k]))) : Math.min(9999, Math.max(1, Math.floor(b[k])))
    }
    // 人物大小倍率：0.5~2.0，步进 0.05；坏值忽略（别把桌宠缩没了）
    if (Number.isFinite(b.petScale)) patch.petScale = Math.min(2, Math.max(0.5, Math.round(b.petScale * 20) / 20))
    // 松手后落地：布尔透传（模块侧缺省当开，别让老面板把抛掷关没）
    if (typeof b.petReleaseLand === 'boolean') patch.petReleaseLand = b.petReleaseLand
    if (typeof b.whisperLines === 'string') patch.whisperLines = b.whisperLines.slice(0, 4000)
    // 素材包下载地址：内建模块的 settings 字段不渲染成表单（同上），这里是它唯一的写入通道。
    // 只收 http/https（或空 = 回到内置默认），别把 file:// 之类塞进来当下载源
    if (typeof b.petPackUrl === 'string') {
      const u = b.petPackUrl.trim().slice(0, 1000)
      if (!u || /^https?:\/\//i.test(u)) patch.petPackUrl = u
    }
    // Electron 下载镜像：同上（内建模块不渲染 settings）；留空 = 回落内置默认 npmmirror
    if (typeof b.electronMirror === 'string') {
      const u = b.electronMirror.trim().slice(0, 500)
      if (!u || /^https?:\/\//i.test(u)) patch.electronMirror = u
    }
    // 行为大脑的模块级设置（AI 自己改不了，只有主人能改）。pet 是**内置模块**，
    // 它的 settings schema 不会渲染成表单（面板只给「用户自己复制出来的模块」生成），
    // 所以这里是这些开关唯一的写入通道——不补，关窗物理闸就永远打不开。
    for (const k of ['behaviorEnabled', 'behaviorIconMischiefEnabled', 'behaviorCloseWindowEnabled']) {
      if (typeof b[k] === 'boolean') patch[k] = b[k]
    }
    for (const [k, lo, hi] of [
      ['behaviorMinMinutes', 1, 9999],        // 铁律：最短 1 分钟
      ['behaviorMaxMinutes', 1, 9999],
      ['behaviorMaxPerDay', 0, 999999],
      ['behaviorIdleCursorMinutes', 1, 240],
      ['behaviorMoodCloseWindowBelow', 0, 100],
      ['behaviorIconQuarantineDays', 1, 365],
      ['chatBehaviorCooldownMinutes', 1, 1440], // 聊天联动冷却：1 分钟起，最长一天
      ['chatBehaviorMaxPerDay', 0, 9999],       // 聊天联动每日上限：0 = 聊天时她也不动
    ]) {
      if (Number.isFinite(b[k])) patch[k] = Math.min(hi, Math.max(lo, Math.round(b[k])))
    }
    if (typeof b.behaviorWindowWhitelist === 'string') patch.behaviorWindowWhitelist = b.behaviorWindowWhitelist.slice(0, 2000)
    if (typeof b.behaviorDisabledActions === 'string') patch.behaviorDisabledActions = b.behaviorDisabledActions.slice(0, 500)
    // 聊天联动动作（1.2.0 起 pet 模块代码在 mods 仓；核心侧 /panel/pet/config 仍是这些键的面板写入通道）
    if (typeof b.chatBehaviorEnabled === 'boolean') patch.chatBehaviorEnabled = b.chatBehaviorEnabled
    if (typeof b.chatBehaviorWhitelist === 'string') patch.chatBehaviorWhitelist = b.chatBehaviorWhitelist.slice(0, 2000)
    if (!Object.keys(patch).length) return { ok: false, message: '没有可保存的字段' }
    setConfig(mergeFromPanel(cfg, { ext: { pet: patch } }))
    log.info(`面板已保存桌宠设置｜${Object.keys(patch).map((k) => k + '=' + String(patch[k]).slice(0, 20)).join(' ')}`)
    return { ok: true, pet: petStatus() }
  })
  // 「现在碎碎念一句」：绕过排程与开关，但仍尊重专注模式（force 只跳排程类闸门）
  route('/panel/pet/whisper', async (req) => {
    const pet = use('pet')
    if (typeof pet?.whisperNow !== 'function') return { ok: false, available: false, message: '桌宠模块还没就绪，碎碎念不了' }
    const r = await pet.whisperNow({ force: true, reason: '面板' })
    const msg = r && r.ok ? `她嘟囔了一句：${r.text}` : ({ focus: '专注模式开着，先关掉再来', 'pet-offline': '桌宠没在跑，气泡发不出去', 'plugin-off': '插件总开关是关的', thinking: '上一句她还在想（工作区那条会话还没结束），等几秒再来' }[r && r.reason] || '这轮没说出来')
    return { ok: Boolean(r && r.ok), message: msg, result: redactTokens(r) }
  })
  route('/panel/pet/download', async () => {
    const pet = use('pet')
    if (typeof pet?.download !== 'function') return { ok: false, available: false, message: '桌宠模块还没就绪，装不了客户端' }
    return { ok: true, result: redactTokens(await pet.download()) }
  })
  // 素材包：手动重下默认形象包（换镜像地址后用；force=true 表示已有也重下）
  route('/panel/pet/fetch-pack', async () => {
    const pet = use('pet')
    if (typeof pet?.ensureDefaultPack !== 'function') return { ok: false, available: false, message: '桌宠模块还没就绪，下不了素材包' }
    return { ok: true, result: await pet.ensureDefaultPack(true), pet: petStatus() }
  })
  route('/panel/pet/focus', async (req) => {
    const enabled = Boolean((await readBody(req)).enabled)
    const pet = use('pet')
    if (typeof pet?.setFocus !== 'function') return { ok: false, available: false, message: '桌宠模块还没就绪，改不了专注模式' }
    return { ok: true, result: redactTokens(await pet.setFocus(enabled)) }
  })
  // Electron 三键：安装（npmmirror 镜像）→ 启动（清 ELECTRON_RUN_AS_NODE 分离进程）→ 停止（杀 pid）
  route('/panel/pet/electron-install', async () => {
    const pet = use('pet')
    if (typeof pet?.electronInstall !== 'function') return { ok: false, available: false, message: '桌宠模块还没就绪，装不了 Electron' }
    return { ok: true, result: redactTokens(await pet.electronInstall()) }
  })
  route('/panel/pet/launch', async () => {
    const pet = use('pet')
    if (typeof pet?.launch !== 'function') return { ok: false, available: false, message: '桌宠模块还没就绪，启动不了桌宠' }
    return { ok: true, result: redactTokens(await Promise.resolve(pet.launch())) }
  })
  route('/panel/pet/stop', async () => {
    const pet = use('pet')
    if (typeof pet?.stop !== 'function') return { ok: false, available: false, message: '桌宠模块还没就绪，停不了桌宠' }
    return { ok: true, result: redactTokens(await Promise.resolve(pet.stop())) }
  })
  // ---------- 行为动作（设计稿 §8 测试通道）：面板「试一下」+ 每动作 AI 开关 + 图标隔离区 ----------
  // 全部代理到 pet 模块已暴露的函数（behaviorEmit / behaviorStatus / iconQuarantine / iconRestore）；
  // 模块没就绪或旧版本缺接口时降级 available:false，面板显示兜底文案不炸。
  route('/panel/pet/behavior/status', async () => {
    const pet = use('pet')
    if (typeof pet?.behaviorStatus !== 'function') return { ok: false, available: false, message: '桌宠模块还没就绪' }
    return { ok: true, behavior: redactTokens(pet.behaviorStatus()) }
  })
  // 「试一下」：手动触发默认 force=true（绕排程/专注/安静时段；桌宠离线时回执会显示 refused/failed）
  route('/panel/pet/behavior', async (req) => {
    const b = await readBody(req)
    const pet = use('pet')
    if (typeof pet?.behaviorEmit !== 'function') return { ok: false, available: false, message: '桌宠模块还没就绪，试不了' }
    const r = await pet.behaviorEmit({ action: b.action, params: b.params, say: b.say, force: b.force !== false, reason: 'panel' })
    const why = {
      'unknown-action': '没有这个动作',
      'emit-failed': '下发失败（看日志）',
      // 关窗物理闸：说清去哪里开，否则面板上只看到「这轮没演成」
      'close-window-disabled': '先在「行为与安全」卡里打开「允许 AI 关闭窗口」（物理闸，手动「试一下」也绕不过）',
      'empty-text': '「说话」动作要给一句台词再试',
    }
    return {
      ok: Boolean(r && r.ok),
      reason: (r && r.reason) || '',
      message: r && r.ok
        ? `已下发「${r.action}」${r.say ? `：${r.say}` : ''}，桌宠在跑就会演`
        : (why[r?.reason] || '这轮没演成'),
      result: redactTokens(r),
    }
  })
  // 每动作「进不进 AI 动作表」：写 ext.pet.behaviorDisabledActions（逗号分隔），与模块 settings 单一真相
  route('/panel/pet/behavior/actions', async (req) => {
    const b = await readBody(req)
    const action = String(b.action || '').trim().slice(0, 40)
    if (!action) return { ok: false, message: '缺动作名' }
    // 动作名白名单（来自模块的全表）：防止手滑/旧面板把垃圾动作名写进配置
    try {
      const st = use('pet')?.behaviorStatus?.()
      const known = new Set([...(st?.openActions || []), ...(st?.deferredActions || [])])
      if (known.size && !known.has(action)) return { ok: false, message: '没有这个动作：' + action }
    } catch (error) { /* 模块没就绪就不校验，别把开关卡死 */ }
    const cur = new Set(String(getConfig().ext?.pet?.behaviorDisabledActions || '').split(',').map((x) => x.trim()).filter(Boolean))
    if (b.on === false) cur.add(action); else cur.delete(action)
    setConfig(mergeFromPanel(cfg, { ext: { pet: { behaviorDisabledActions: [...cur].join(',') } } }))
    log.info(`面板已改 AI 动作表｜${action} → ${b.on === false ? '禁用' : '启用'}`)
    return { ok: true, disabledActions: [...cur] }
  })
  // 图标隔离区清单：{items:[{id,name,originalPath,at,reason}]}
  route('/panel/pet/behavior/quarantine', async () => {
    const pet = use('pet')
    if (typeof pet?.iconQuarantine !== 'function') return { ok: false, available: false, message: '图标隔离区接口还没就绪' }
    try { return { ok: true, items: pet.iconQuarantine() || [] } } catch (error) { return { ok: false, available: false, message: '隔离区清单读不了：' + String(error?.message || error) } }
  })
  // 「放回去」：rename 回原路径（原位置被占则改名），失败按原因给人话，别让面板只挂一句「没放回去」
  route('/panel/pet/behavior/restore', async (req) => {
    const b = await readBody(req)
    const pet = use('pet')
    if (typeof pet?.iconRestore !== 'function') return { ok: false, available: false, message: '归还接口还没就绪' }
    const r = await pet.iconRestore(String(b.id || '').slice(0, 64))
    const why = { 'not-found': '隔离区里没有这条记录（可能已经放回去了）', 'quarantine-file-gone': '隔离区里的文件已经不在了，这条记录已清掉', 'restore-failed': '放回去失败（看日志）' }
    return { ok: Boolean(r && r.ok), message: r && r.ok ? `「${r.name}」放回去了` : (why[r?.reason] || '没放回去：原位置可能没了，或图标已经被移走'), result: redactTokens(r) }
  })

  // 第三批：补偿道歉（心情 +8，并标记最近一条未道歉的关窗记录；不删记录）
  route('/panel/pet/behavior/apologize', async () => {
    const pet = use('pet')
    if (typeof pet?.windowApologize !== 'function') return { ok: false, available: false, message: '道歉接口还没就绪' }
    try {
      const r = pet.windowApologize()
      return {
        ok: Boolean(r && r.ok),
        message: r && r.ok ? (r.window ? `她为「${r.window}」道了歉` : '她道了歉') : '没有需要道歉的记录',
        result: redactTokens(r),
      }
    } catch (error) { return { ok: false, message: '道歉没成功：' + String(error?.message || error) } }
  })

  route('/logs', async (req) => {
    const q = query(req)
    return { ok: true, entries: logger.recent(Number(q.limit) || 300, { level: q.level || '', area: q.area || '' }) }
  })

  // SnowLuma
  route('/snowluma/start', async () => snowluma.start())
  route('/snowluma/stop', async () => snowluma.stop())
  route('/snowluma/attach', async () => {
    wrongAccount = ''
    snowluma.clearRejected()
    const r = await snowluma.attachBot()
    if (cfg.enabled && onebot.state === 'stopped') onebot.start()
    return r
  })
  route('/commands', async () => ({ ok: true, list: commandList(mods.commands()) }))
  // 更新：检查 GitHub 上有没有新版本；这次更新了什么
  const checkUpdate = createUpdateChecker({ pkg: PKG, log, unstable: () => getConfig().update.unstable })
  route('/update/check', async (req) => checkUpdate({ force: query(req).force === '1' }))
  route('/changelog', async () => {
    let text = ''
    try { text = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8') } catch (error) {}
    return { ok: true, version: VERSION, notes: changelogSection(text, VERSION) }
  })
  route('/snowluma/login-check', async () => ({ ...(await snowluma.canLogin()), passwordAuto: cfg.snowluma.passwordAuto, running: await snowluma.running() }))
  route('/snowluma/agreements', async () => {
    try { return { ok: true, ...(await snowluma.agreements()) } } catch (error) { return { ok: false, message: error.message } }
  })
  route('/snowluma/consent', async (req) => {
    const b = await readBody(req)
    if (b.agree !== true) return { ok: false, message: '要先勾选「我已阅读并同意」' }
    consentCache = { at: 0, value: null }
    return snowluma.consent(b.version)
  })
  route('/snowluma/reset-password', async () => snowluma.resetPassword())
  // 控制台密码：看一眼（打开 SnowLuma 自己的控制台要用）、自己设一个
  route('/snowluma/password', async () => ({ ok: true, password: snowluma.password(), auto: cfg.snowluma.passwordAuto }))
  route('/snowluma/set-password', async (req) => snowluma.setPassword(String((await readBody(req)).password || '')))
  route('/setup/done', async (req) => {
    const body = await readBody(req)
    if (!cfg.botQQ || !cfg.ownerQQ || cfg.botQQ === cfg.ownerQQ) return { ok: false, message: '先填好不同的机器人 QQ 和你的 QQ' }
    if (body.existingConnection && !(cfg.enabled && onebotState === 'connected' && loginOk)) return { ok: false, message: 'QQ 网关还没通过机器人号核对，请先连接并核对后再进入面板' }
    setConfig({ ...cfg, setupDone: true })
    log.info('首次使用向导完成')
    return { ...(await overview()), message: '设置完成，大肥鱼可以上线啦' }
  })
  route('/snowluma/processes', async () => {
    try { return { ok: true, list: await snowluma.processes() } } catch (error) { return { ok: false, message: error.message, list: [] } }
  })
  /** 连不上 QQ 网关时，按顺序找卡在哪一步，给一句人话。 */
  async function connectionProblem() {
    if (!cfg.enabled) return '总开关关着（右上角），打开后才会连'
    if (!cfg.botQQ) return '还没填机器人 QQ 号'
    if (cfg.gateway === 'onebot') {
      const ep = endpoint()
      if (!ep.wsUrl) return '还没填 OneBot 的 WebSocket 地址：在「连接」页填你的 OneBot v11 正向 WebSocket 地址（收消息要靠它；HTTP 可以不填）'
      if (wrongAccount) return `连上的是 ${wrongAccount}，不是机器人号 ${cfg.botQQ}，已经断开：让你的 OneBot 服务登录机器人号，再点「重新连接」`
      return `连 ${ep.wsUrl || ep.httpUrl} 没连上：确认你的 OneBot 服务开着、地址和 token 填对了（Docker 里的话，地址要用 DSH 能访问到的主机名 / 端口）`
    }
    const inst = snowluma.detect()
    if (!inst.installed && !(cfg.snowluma.wsUrl || cfg.snowluma.httpUrl)) return 'SnowLuma 没装好：' + inst.reason
    if (inst.installed && !(await snowluma.running())) return 'SnowLuma 没在运行：点上面的「启动」'
    if (snowluma.lowIntegrity) return 'SnowLuma 以「低完整性」运行，看不到 QQ 进程（多半是解压在了下载目录这类带安全标签的地方）：把它重新解压到一个普通目录（比如 D:\SnowLuma），在「连接」页改好目录再启动'
    const ep = endpoint()
    if (!ep.wsUrl && !ep.httpUrl) return 'SnowLuma 还没给机器人号开 OneBot 端口，也就是机器人号还没接入：确认机器人号的 QQ 已经登录，再点「接入机器人号」'
    if (wrongAccount) return `连上的是 ${wrongAccount}，不是机器人号 ${cfg.botQQ}，已经断开：只登着机器人号那个 QQ，再点「接入机器人号」`
    const la = snowluma.lastAttach
    if (la && la.at && !la.ok && la.message) return '接入机器人号没成功：' + la.message
    return `连 ${ep.wsUrl || ep.httpUrl} 没连上：确认机器人号的 QQ 开着、已经登录，并且 SnowLuma 控制台里这个号显示已接入`
  }
  route('/onebot/reconnect', async () => {
    if (!cfg.enabled) return { ok: false, message: await connectionProblem() }
    wrongAccount = ''
    onebot.restart()
    // 等几秒看结果，别只回一句「正在重连」
    for (let i = 0; i < 16 && !(onebotState === 'connected' && loginOk); i++) await new Promise((r) => setTimeout(r, 500))
    if (onebotState === 'connected' && loginOk) return { ok: true, message: '连上了' }
    return { ok: false, message: '没连上：' + (await connectionProblem()) }
  })
  route('/onebot/test', async () => {
    try {
      const info = await onebot.call('get_login_info', {}, { timeoutMs: 8000 })
      const uin = String(info?.user_id ?? '')
      return { ok: uin === cfg.botQQ, message: uin === cfg.botQQ ? `连上了：${info.nickname}（${uin}）` : `连上的是 ${uin}，不是机器人号 ${cfg.botQQ}！`, info }
    } catch (error) {
      return { ok: false, message: error.message }
    }
  })
  route('/test-send', async () => {
    if (!cfg.enabled) return { ok: false, message: '先打开总开关' }
    if (cfg.dryRun) return { ok: false, message: '现在是试运行，先关掉试运行再测' }
    const r = await hub.sendText(`private:${cfg.ownerQQ}`, '【Aurabot 自测】大肥鱼到此一游～')
    return r ? { ok: true, message: '发给主人了，去 QQ 看看' } : { ok: false, message: '没发出去（看日志）' }
  })

  route('/sessions/reset', async () => {
    const n = hub.resetSessions()
    return { ok: true, message: n ? `归档了 ${n} 个会话，下一条消息起她会重新开始` : '本来就没有会话' }
  })

  // 人格
  route('/personas', async () => ({ ok: true, list: listPersonas(), current: cfg.persona.current }))
  route('/persona/get', async (req) => {
    const p = readPersona(query(req).id)
    return p ? { ok: true, persona: p } : { ok: false, message: '没有这个人格' }
  })
  route('/persona/save', async (req) => {
    const b = await readBody(req)
    const p = savePersona(b.id, b)
    return { ok: true, persona: p, message: '人格已保存，下一轮起生效' }
  })
  route('/persona/delete', async (req) => {
    const b = await readBody(req)
    if (b.id === cfg.persona.current) return { ok: false, message: '正在用的人格不能删' }
    deletePersona(b.id)
    return { ok: true, list: listPersonas() }
  })
  route('/persona/use', async (req) => {
    const b = await readBody(req)
    if (!readPersona(b.id)) return { ok: false, message: '没有这个人格' }
    setConfig({ ...cfg, persona: { current: b.id } })
    log.info(`切换人格 → ${b.id}`)
    return { ok: true, current: b.id, message: '切换好了，下一轮回复起生效' }
  })
  // 人格页「AI 润色」：只改面板上这一节的文字，不保存；用不用由主人在面板里选
  route('/persona/polish', async (req) => {
    const b = await readBody(req)
    const title = String(b.title || '').slice(0, 30) || '开场（她是谁）'
    const text = String(b.text || '').slice(0, 4000)
    const others = (Array.isArray(b.others) ? b.others : []).map((x) => String(x).slice(0, 30)).slice(0, 20)
    const system = '你在帮人改一个 QQ 聊天角色的人设。人设按【标题】分节，你一次只改其中一节。' +
      '只输出这一节改好后的正文：不要写标题，不要加粗、不要 Markdown 标题，不要任何解释。原来是「- 」开头的条目就继续用条目，一条一行、短句。'
    const ask = [
      `角色：${String(b.name || '她').slice(0, 30)}`,
      `要改的这一节：${title}`,
      `人设里另外几节：${others.join('、') || '无'}（只是让你知道还有哪些，别把它们的内容写进这一节）`,
      text.trim()
        ? '要求：保留原来的设定和事实，不编新的身份信息；说得更具体、更像真人；删掉重复和空话；长度别超过原来的 1.5 倍。'
        : '要求：这一节还是空的，按这个角色和这一节的标题写 4 到 8 条。',
      text.trim() ? `原文：\n${text}` : '',
    ].filter(Boolean).join('\n')
    try {
      const out = String(await askModel(ctx, { cfg: getConfig(), system, text: ask, maxTokens: 1500, temperature: 0.6 }) || '')
        .replace(/^```[a-z]*\n?|\n?```$/g, '').replace(new RegExp('^【' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '】\\s*'), '').trim()
      return out ? { ok: true, text: out } : { ok: false, message: '模型没给出内容，再试一次' }
    } catch (error) {
      return { ok: false, message: '润色没成功：' + error.message }
    }
  })

  // 按群头衔不理：白名单里的群（带群名）+ 这些群里现有的头衔，面板里点一个就设成要过滤的那类
  route('/groups/titles', async () => {
    const gids = (cfg.allow.groups || []).map(String)
    const groups = await Promise.all(gids.map(async (gid) => ({ groupId: gid, name: await hub.groupName(gid) })))
    if (!gids.length) return { ok: true, groups, titles: [], failed: [] }
    const { titles, failed } = await hub.titleFilter.titlesIn(gids)
    hub.titleFilter.clear()
    return { ok: true, groups, titles, failed, message: failed.length ? `有 ${failed.length} 个群的成员没拉到（她在群里吗？）` : '' }
  })

  // 本地接口
  const openFolder = (dir) => {
    mkdirSync(dir, { recursive: true })
    const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    // 子进程起不来是以 error 事件抛的，没人听就是未捕获异常，会把 DSH 整个带走（#135）
    return new Promise((resolve) => {
      const child = spawn(opener, [dir], { detached: true, stdio: 'ignore' })
      child.once('error', (error) => resolve({ ok: false, message: `打不开文件夹：${dir}（${error.message}）` }))
      child.once('spawn', () => { child.unref(); resolve({ ok: true, message: '打开了' }) })
    })
  }
  // 备份：文件里有账号凭证，只存在本机文件夹，不提供网页下载
  let backupJob = null // { running, done, total, error, result }
  const backupAction = (run) => async (req) => {
    if (req.method !== 'POST' || req.headers?.['x-aurabot-backup'] !== '1') return { ok: false, message: '请从面板发起操作' }
    return run(req)
  }
  route('/backup/state', async () => ({ ok: true, job: backupJob, list: listBackups(), pending: pendingRestore(), modules: pendingModules(), dir: dataDir('backups') }))
  route('/backup/create', backupAction(async () => {
    if (backupJob?.running) return { ok: false, message: '上一个备份还在打包' }
    backupJob = { running: true, done: 0, total: 0 }
    createBackup({ version: VERSION, workspaceDir: workspaceDirOf(getConfig()), onProgress: (p) => { backupJob = { ...backupJob, ...p } } })
      .then((result) => { backupJob = { running: false, result }; log.info(`备份完成：${result.name}，${result.files} 个文件`) })
      .catch((error) => { backupJob = { running: false, error: error.message }; log.error('备份失败：', error.message) })
    return { ok: true, message: '开始打包了' }
  }))
  route('/backup/open', backupAction(async () => openFolder(dataDir('backups'))))
  route('/backup/upload', backupAction(async (req) => {
    const buf = await readRaw(req, 2 * 1024 * 1024 * 1024 - 1)
    if (!buf.length) return { ok: false, message: '文件是空的' }
    try { return await stageRestore(await saveUpload(buf)) } catch (error) { return { ok: false, message: error.message } }
  }))
  route('/backup/restore-path', backupAction(async (req) => {
    const path = String((await readBody(req)).path || '').trim().replace(/^"|"$/g, '')
    if (!path) return { ok: false, message: '填备份文件的完整路径' }
    try { return await stageRestore(path) } catch (error) { return { ok: false, message: error.message } }
  }))
  route('/backup/cancel', backupAction(async () => { cancelRestore(); return { ok: true, message: '取消了' } }))
  route('/local/status', async () => ({ ok: true, dir: local.dir(), list: local.status() }))
  route('/local/template', async (req) => {
    const slot = String((await readBody(req)).slot || '')
    if (!local.pathOf || !['tts', 'image', 'song', 'asr'].includes(slot)) return { ok: false, message: '没有这一项' }
    return local.template(slot)
  })
  route('/local/open', async () => openFolder(local.dir()))
  route('/local/test', async (req) => {
    const slot = String((await readBody(req)).slot || '')
    try {
      if (slot === 'tts') {
        const file = fileOf(await local.call('tts', { text: '你好呀，我是大肥鱼，这是本地语音测试。' }))
        if (!file || !existsSync(file)) return { ok: false, message: '脚本没返回音频文件' }
        return { ok: true, message: `念好了：${file}` }
      }
      if (slot === 'image') {
        const buf = await toImageBuffer(await local.call('image', { prompt: '一条胖乎乎的蓝色小鱼，可爱，插画', size: cfg.imageGen.size || '1024x1024' }))
        return { ok: true, message: `画好了（${Math.round(buf.length / 1024)} KB）`, image: buf.toString('base64') }
      }
      return { ok: false, message: '这一项没法单独试：翻唱换声去 QQ 里点首歌，语音识别发条语音条试试' }
    } catch (error) {
      return { ok: false, message: '出错了：' + error.message }
    }
  })

  // 模块（面板「扩展」页）
  route('/modules', async () => ({ ok: true, dir: mods.dir(), safeMode: cfg.safeMode, apiVersion: API_VERSION, list: mods.status(), prompt: mods.promptFor('') }))
  route('/modules/community', async (req) => {
    try { return { ok: true, ...(await community.list({ force: query(req).force === '1' })) } } catch (error) { return { ok: false, message: error.message, list: [] } }
  })
  route('/modules/tutorial', async () => {
    try { return { ok: true, text: readFileSync(join(ROOT, 'docs', 'MODULE-TUTORIAL.md'), 'utf8') } } catch (error) { return { ok: false, message: '教程文件不见了' } }
  })
  route('/modules/community/progress', async () => ({ ok: true, progress: community.progress() }))
  route('/modules/community/install', async (req) => {
    const b = await readBody(req)
    return { ...(await community.install(String(b.id || ''), { confirmReplace: b.confirmReplace === true })), modules: mods.status() }
  })
  route('/modules/community/remove', async (req) => {
    const b = await readBody(req)
    return { ...(await community.remove(String(b.id || ''), { purge: b.purge === true })), modules: mods.status() }
  })
  route('/modules/reload', async (req) => {
    const id = String((await readBody(req)).id || '')
    if (!id) { await mods.sync(); return { ok: true, message: '检查过了', list: mods.status() } }
    const m = await mods.reload(id)
    return { ok: Boolean(m && !m.error), message: m?.error ? '加载失败：' + m.error : '重新加载好了', list: mods.status() }
  })
  route('/modules/create', async (req) => {
    const b = await readBody(req)
    const r = mods.create(String(b.id || '').trim(), String(b.name || '').trim())
    if (r.ok) await mods.sync()
    return { ...r, list: mods.status(), prompt: r.ok ? mods.promptFor(String(b.id).trim()) : '' }
  })
  route('/modules/fork', async (req) => {
    const id = String((await readBody(req)).id || '')
    const r = mods.fork(id)
    if (r.ok) await mods.sync()
    return { ...r, list: mods.status(), prompt: r.ok ? mods.promptFor(id) : '' }
  })
  route('/modules/prompt', async (req) => ({ ok: true, prompt: mods.promptFor(String(query(req).id || '')) }))
  route('/modules/open', async (req) => {
    const id = String(query(req).id || '')
    return openFolder(id ? join(mods.dir(), id) : mods.dir())
  })
  // 模拟测试：不用上 QQ 就能试模块。发出去的消息只截下来给面板看，不真发
  // （模块直接调 api.onebot(...) 的操作不在此列，是真的会执行的）
  const simChat = (b) => {
    const owner = b.as !== 'other'
    const userId = owner ? cfg.ownerQQ : '10001'
    const group = b.kind === 'group'
    const groupId = String(b.groupId || cfg.allow.groups[0] || '10002')
    return { owner, userId, chat: group ? { chatId: `group:${groupId}`, kind: 'group', groupId, userId } : { chatId: `private:${userId}`, kind: 'private', userId } }
  }
  // 没有文字的（语音条、表情、图片）显示发送备注，比如「[语音·edge] 早呀」
  const sentLines = (sent) => sent.map((s) => ({ chatId: s.chatId, note: s.note, text: s.message.some((seg) => seg.type === 'text') ? s.message.map((seg) => (seg.type === 'text' ? seg.data.text : seg.type === 'reply' ? '' : `[${seg.type}]`)).join('') : s.note }))
  route('/modules/simulate', async (req) => {
    const b = await readBody(req)
    const { owner, userId, chat } = simChat(b)
    const text = String(b.text || '')
    const steps = []
    const msg = { ...chat, nickname: owner ? cfg.ownerName || '主人' : '路人', role: '', messageId: 'sim', text, mentioned: Boolean(b.mentioned), replyId: '', images: [], stickers: [], records: [], forwards: [], raw: { simulated: true } }
    const { sent } = await hub.capture(async () => {
      if (text) {
        const cmd = owner && /^\s*[/／]/.test(text) ? parseCommand(text, mods.commands()) : null
        if (cmd && cmd.ext) {
          const reply = String((await cmd.ext.run(cmd.arg, msg)) ?? '')
          steps.push(`命令 /${cmd.name}（模块「${cmd.ext.module}」）回：${reply || '（空）'}`)
          if (reply) await hub.sendText(chat.chatId, reply)
        } else if (cmd) {
          steps.push(`这是内置命令 /${cmd.name}，模拟里不执行（会真的改设置）`)
        } else if (await mods.claim('message', msg)) {
          steps.push('有模块接管了这条消息，她不会再回')
        } else {
          steps.push('没有模块接管，这条会交给她（模拟里不会真的让她想）')
        }
      }
      if (b.reply) {
        const items = await hub.deliver(chat.chatId, String(b.reply), { simulate: true })
        steps.push(items ? `她的回复经过模块改写后拆成 ${items.length} 条` : '她的回复被模块拦下了，不发')
      }
    })
    return { ok: true, steps, sent: sentLines(sent) }
  })
  route('/modules/tools', async (req) => {
    const q = query(req)
    const { owner, chat } = simChat(q)
    const level = owner && chat.kind === 'private' ? 'full' : 'social'
    return { ok: true, level, list: mods.buildTools({ chat, level, sessionId: 'sim' }).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }
  })
  route('/modules/tool', async (req) => {
    const b = await readBody(req)
    const { owner, userId, chat } = simChat(b)
    const level = owner && chat.kind === 'private' ? 'full' : 'social'
    const tool = mods.buildTools({ chat, level, sessionId: 'sim' }).find((t) => t.name === b.name)
    if (!tool) return { ok: false, message: `这个场合没有 ${b.name} 这个工具` }
    hub.simulateTurn('sim', [userId])
    const { result, sent } = await hub.capture(() => tool.execute(b.args && typeof b.args === 'object' ? b.args : {}, {}))
    return { ok: true, result, sent: sentLines(sent) }
  })
  route('/modules/panel', async (req, res) => {
    const src = mods.panelSource(String(query(req).id || ''))
    if (src === null) return send(res, 404, '')
    send(res, 200, src, 'text/javascript; charset=utf-8')
  })

  // 联动
  route('/bridge/token', async () => ({ ok: true, token: cfg.bridge.http ? bridge.ensureToken() : '' }))
  route('/bridge/token/reset', async () => ({ ok: true, token: bridge.resetToken(), message: '换了新密钥，旧的立刻失效' }))
  route('/bridge/examples', async (req) => ({ ok: true, ...bridge.examples(String(query(req).base || 'http://127.0.0.1:端口')) }))
  // 开放接口：都要带密钥
  const open = (path, fn) => route('/open' + path, async (req) => {
    if (!bridge.authorized(req)) return { ok: false, code: 401, message: cfg.bridge.http ? '密钥不对（请求头 Authorization: Bearer 密钥）' : '开放接口没打开（面板「扩展」→ 联动）' }
    return fn(req)
  })
  open('/info', async () => bridge.ops.info())
  open('/send', async (req) => bridge.ops.send(await readBody(req)))
  open('/think', async (req) => bridge.ops.think(await readBody(req)))
  open('/call', async (req) => bridge.ops.call(await readBody(req)))
  open('/events', async (req) => bridge.ops.events(query(req)))

  // 模型：列出 DSH 里可用的模型，测一下哪个回得快
  route('/models', async (req) => {
    try {
      if (new URL(req.url, 'http://x').searchParams.get('refresh') === '1') { clearReasoningCache(); clearVisionCache() }
      return { ok: true, list: await listModels() }
    } catch (error) {
      return { ok: false, message: error.message, list: [] }
    }
  })
  route('/model/ping', async (req) => {
    const b = await readBody(req)
    const t = Date.now()
    try {
      const text = await askModel(ctx, { cfg: { model: { provider: b.provider, model: b.model } }, system: '只回复两个字：在呢', text: '在吗', maxTokens: 800 })
      return { ok: true, ms: Date.now() - t, text: text.slice(0, 40) }
    } catch (error) {
      return { ok: false, ms: Date.now() - t, message: error.message }
    }
  })

  // 形象图
  // 头像：自定义的放在数据目录（重装插件不丢），没有就用插件自带的大肥鱼
  const AVATAR = () => dataDir('avatar.img')
  const avatarInfo = () => {
    try { return { custom: true, at: statSync(AVATAR()).mtimeMs } } catch (error) { return { custom: false, at: 0 } }
  }
  route('/avatar', async (req, res) => {
    if (existsSync(AVATAR())) {
      const buf = readFileSync(AVATAR())
      return send(res, 200, buf, mimeOf(buf))
    }
    const p = join(ROOT, 'assets', 'dafeiyu.jpg')
    if (!existsSync(p)) return send(res, 404, '')
    send(res, 200, readFileSync(p), 'image/jpeg')
  })
  route('/avatar/upload', async (req) => {
    const b = await readBody(req)
    const buf = Buffer.from(String(b.data || '').replace(/^data:[^,]+,/, ''), 'base64')
    if (!buf.length || buf.length > 5 * 1024 * 1024) return { ok: false, message: '图片太大（最多 5MB）或是空的' }
    if (!mimeOf(buf).startsWith('image/')) return { ok: false, message: '只支持 PNG、JPG、GIF、WebP 图片' }
    ensureDir(dataDir())
    writeFileSync(AVATAR(), buf)
    log.info('换了面板头像')
    return { ok: true, message: '头像换好了', avatar: avatarInfo() }
  })
  route('/avatar/reset', async () => {
    try { unlinkSync(AVATAR()) } catch (error) {}
    return { ok: true, message: '恢复成默认头像了', avatar: avatarInfo() }
  })
  route('/avatar/sync-qq', async () => {
    const buf = existsSync(AVATAR()) ? readFileSync(AVATAR()) : readFileSync(join(ROOT, 'assets', 'dafeiyu.jpg'))
    try {
      await onebot.call('set_qq_avatar', { file: 'base64://' + buf.toString('base64') })
      return { ok: true, message: '已经设成机器人号的 QQ 头像' }
    } catch (error) {
      return { ok: false, message: 'QQ 头像没换成：' + error.message }
    }
  })

  log.info(`Aurabot v${VERSION} 已加载｜总开关 ${cfg.enabled ? '开' : '关'}｜试运行 ${cfg.dryRun ? '开' : '关'}｜工作区 ${workspaceDirOf(cfg)}`)

  return {
    hub, onebot, snowluma, getConfig, setConfig, logger, modules: mods, bridge, ready: booted,
    get stickers() { return use('stickers') },
    get qzone() { return use('diary') },
    get mood() { return use('mood') },
    get memory() { return use('memory') },
  }
}
