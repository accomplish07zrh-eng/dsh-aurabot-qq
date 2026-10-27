// 插件配置：默认值 + 归一化 + 读写。配置文件 ~/.dsh/plugins-data/aurabot/config.json

import { dataDir, readJson, writeJson } from './store.js'
import { DEFAULT_GROUP_POLICY } from '../chat/group-policy.js'
import { LEVELS, PROFILE_PERM_KEYS, PROFILE_PERM_LEVELS } from '../chat/access.js'
import { normalizeChatModels } from '../chat/chat-model.js'

export const DEFAULTS = {
  enabled: false, // 总开关：关着一句都不发
  dryRun: true, // 试运行：只记日志不真发
  setupDone: false, // 首次使用向导走完了没有
  botQQ: '', // 机器人 QQ 号（向导里填）
  ownerQQ: '', // 主人 QQ 号（向导里填）
  ownerName: '主人',
  ownerLevel: 'full', // full | social | chat
  profilePerms: { qqNickname: 'owner', qqSignature: 'owner', qqAvatar: 'owner', biliSign: 'owner', biliAvatar: 'owner', qqFriendRequest: 'owner', whitelist: 'owner' }, // 改资料类操作的权限：off 关 / owner 仅主人私聊 / all 所有人
  longTasks: false, // 长任务模式：主人私聊（完整权限）额外挂 dsh-tool-jobs + dsh-tool-schedule，会多一点工具定义、稍慢
  allow: { private: [], groups: [] }, // 主人永远能私聊，不用写进白名单
  snowluma: {
    dir: 'C:\\Aurabot\\snowluma', // 主人自己下载解压到这里（EULA 不允许自动部署）
    autoStart: true, // 随 DSH 启动它（只启动主人已安装并同意过协议的副本）
    webuiPort: 5099,
    webuiPassword: '', // 插件自动生成并保存（第一次启动 SnowLuma 时）；用来调 /api/processes 只给机器人号注入
    passwordAuto: false,
    autoAttach: true, // 自动给机器人号所在的 QQ 进程注入（绝不碰别的号）
    httpUrl: '', // 留空 = 从 SnowLuma 配置里自动读
    wsUrl: '',
    httpToken: '',
    wsToken: '',
  },
  model: { provider: '', model: '', reasoningEffort: 'low' }, // 留空 = 跟随 DSH 默认
  // 按聊天选模型（主人在面板「模型」页设）：私聊 QQ 号 > 群号 > 所有私聊 / 所有群默认 > 上面的全局模型；没写的一级退到下一级
  chatModels: { privateDefault: { provider: '', model: '', reasoningEffort: '' }, groupDefault: { provider: '', model: '', reasoningEffort: '' }, privates: {}, groups: {} },
  merge: { enabled: true, waitSec: 2.5, maxSec: 8, groupWaitSec: 5, groupMaxSec: 15 }, // 连发合并：对方停顿 waitSec 秒再一起回，最多等 maxSec 秒；群里等得久一点，把一段话攒齐
  imageGen: {
    enabled: false,
    provider: 'openai', // openai = 兼容 OpenAI /v1/images/generations 的服务（硅基流动、通义、本地 ComfyUI 代理……）
    baseUrl: '',
    apiKey: '',
    model: '',
    size: '1024x1024',
    stylePrompt: '', // 每次生图自动加在前面的风格描述
    ownerOnly: true, // 只有主人能让她画
  },
  persona: { current: 'dafeiyu' },
  group: { ...DEFAULT_GROUP_POLICY, overrides: {} },
  voice: {
    enabled: true,
    // auto = 先 edge-tts，不行用 Windows 语音；edge / windows / cosyvoice / gptsovits / http = 指定引擎（失败都会退回 Windows 语音）
    engine: 'auto',
    cosyvoice: { url: 'http://127.0.0.1:50000', mode: 'sft', spkId: '中文女', instruct: '', sampleRate: 22050 },
    gptsovits: { url: 'http://127.0.0.1:9880', refAudio: '', promptText: '', promptLang: 'zh', textLang: 'zh' },
    http: { urlTemplate: '' }, // 通用：GET 这个地址（{text} 会替换成要念的话），返回音频
    voice: 'zh-CN-XiaoyiNeural',
    rate: '+0%',
    pitch: '+0Hz',
    autoChance: 0.15, // 短回复自动变语音的概率
    autoMaxChars: 80,
    asr: true, // 听语音
  },
  stickers: {
    enabled: true,
    autoChance: 0.35, // 文字回复自动配一张表情的概率
    collect: true, // 偷表情
    fromGroups: true,
    fromPrivate: true,
    maxPerHour: 20,
    maxLibrary: 300, // 表情库最多存多少张（QQ 收藏表情有上限），超了就清掉最少用的
    caption: true, // 用视觉模型起备注
  },
  diary: {
    enabled: true,
    timesPerDay: 2,
    windowStart: '10:00',
    windowEnd: '23:30',
    minGapMinutes: 180,
    minChars: 60,
    maxChars: 140,
    visibility: 'all', // all | self（仅自己可见）
  },
  // 本地接口：数据目录 local/ 里的脚本接管这几项（文件要在、开关要开）
  local: { tts: false, image: false, song: false, asr: false },
  bili: {
    enabled: false,
    sessdata: '', // B 站 Cookie 里的 SESSDATA（登录凭证）
    biliJct: '', // B 站 Cookie 里的 bili_jct（发评论要用）。两个都不填也能看视频，只是不能评论
    cookie: '', // 由上面两个拼出来给接口用；老配置的整串会自动拆到上面两个里
    autoBrowse: true, // 定时自己去刷
    intervalHours: 4, // 多久刷一轮
    maxRunsPerDay: 3,
    perRun: 3, // 一轮看几个视频
    keywords: [], // 额外想让她搜的方向（另外还会参考她的兴趣和记忆里你喜欢的东西）
    minViews: 5000, // 播放量门槛
    maxAgeDays: 60, // 只看最近多少天发的
    comment: true, // 自己发评论
    maxCommentsPerDay: 3,
    reply: true, // 回别人回她的评论
    maxRepliesPerDay: 6,
    shareToOwner: true, // 看到好玩的私聊分享给主人
    like: false, // 顺手点赞
  },
  qzoneSocial: {
    enabled: true,
    replyOwn: true, // 回复自己说说下别人的新评论
    commentFriends: true, // 逛好友动态，偶尔评论
    friendChance: 0.3, // 看到一条好友说说时互动（点赞 + 可能评论）的概率
    ownerChance: 0.7, // 主人的说说互动概率
    like: true, // 互动时顺手点赞
    maxPerDay: 8, // 每天最多评论几条（点赞不算）
    intervalMin: 30, // 多久逛一次空间
  },
  speakUp: {
    enabled: true, // 只在和主人的私聊里主动找你，群里不会
    idleMinutes: 40,
    minIntervalMinutes: 60,
    maxIntervalMinutes: 180,
    maxPerDay: 4,
    nudge: true, // 她问了你一句、你一直没回时，偶尔轻轻追一句
    awakeFrom: 8,
    awakeTo: 23,
  },
  mood: { enabled: true, halfLifeHours: 3, judge: false }, // judge：每轮聊完用模型判一次心情（更准，每轮多一次很短的调用）；关着用关键词
  memory: { enabled: true, recallCount: 6, dailyConsolidate: true, consolidateTimes: ['04:00', '16:00'] }, // 每天这几个时间把临时记忆（聊天流水）整理进长期记忆、相处经验和说话方式；过了一天的流水整理完清空
  song: {
    enabled: false,
    root: '', // 翻唱环境目录，留空 = 自动（老安装 C:\Aurabot\rvc，新安装在用户目录下）
    voice: '', // 用哪个音色（models 目录里的 .pth 文件名），留空 = 第一个
    pitch: 0, // 默认变调（半音）；她点歌时会按原唱是男声还是女声自己定
    neteaseCookie: '', // 网易云 Cookie（MUSIC_U），下会员歌用
    separatorModel: 'model_bs_roformer_ep_317_sdr_12.9755.ckpt', // 人声分离模型
    maxVoiceSec: 120, // 语音条最长多少秒，歌更长就截一段
    clipStart: 'auto', // auto = 从副歌附近截；head = 从头截
    vocalVolume: 1,
    instVolume: 0.8,
    ownerOnly: true, // 只有主人能点歌
    keepWork: false, // 留着中间文件（调试用）
    pypiMirror: 'auto', // 安装时用的下载源：auto = 先测一下，官方源慢就用国内镜像；cn = 一直用国内镜像；off = 只用官方源
  },
  tabs: {}, // 面板记住的小偏好
  // 模块：内置的和数据目录 modules/ 里自己写的。{ 模块id: { enabled, useBuiltin } }，没写的算开着
  // useBuiltin：自己写了同名模块，但想先用回内置的
  modules: {},
  safeMode: false, // 安全模式：自己写的模块一个都不加载（排查问题用）
  ext: {}, // 自己写的模块的设置：{ 模块id: {...} }
  // 联动：让别的程序、DSH 里别的会话和插件也能用她
  bridge: {
    dshTools: false, // DSH 里别的会话（比如你平时写代码的会话）能用工具让她发 QQ、查记忆
    http: false, // 开放 HTTP 接口（要带密钥）
    token: '', // 第一次打开时自动生成
    allowTargets: 'whitelist', // 外部能发给谁：whitelist = 白名单里的人和群；owner = 只能发给主人
  },
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

function deepMerge(base, over) {
  if (!isObj(over)) return structuredClone(base)
  const out = structuredClone(base)
  for (const [k, v] of Object.entries(over)) {
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v)
    else if (v !== undefined) out[k] = v
  }
  return out
}

const num = (v, d, lo, hi) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
}
const bool = (v, d) => (typeof v === 'boolean' ? v : d)
const qq = (v) => String(v ?? '').replace(/\D/g, '')
const qqList = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\s,，;；]+/)).map(qq).filter(Boolean))]
const hhmm = (v, d) => (/^\d{1,2}:\d{2}$/.test(String(v)) ? String(v) : d)

export function normalize(raw) {
  const c = deepMerge(DEFAULTS, raw)
  c.enabled = bool(c.enabled, false)
  c.dryRun = bool(c.dryRun, true)
  c.botQQ = qq(c.botQQ)
  c.ownerQQ = qq(c.ownerQQ)
  c.setupDone = bool(c.setupDone, false)
  c.ownerLevel = LEVELS.includes(c.ownerLevel) ? c.ownerLevel : 'full'
  c.longTasks = bool(c.longTasks, false)
  c.chatModels = normalizeChatModels(c.chatModels)
  c.profilePerms = Object.fromEntries(PROFILE_PERM_KEYS.map((k) => [k, PROFILE_PERM_LEVELS.includes(c.profilePerms?.[k]) ? c.profilePerms[k] : 'owner']))
  c.allow = { private: qqList(c.allow.private), groups: qqList(c.allow.groups) }
  const g = c.group
  g.wakeWords = (Array.isArray(g.wakeWords) ? g.wakeWords : String(g.wakeWords || '').split(/[\s,，]+/)).map((s) => String(s).trim()).filter(Boolean)
  g.interjectChance = num(g.interjectChance, 0.15, 0, 1)
  g.cooldownSec = num(g.cooldownSec, 90, 0, 86400)
  g.maxPerHour = num(g.maxPerHour, 6, 0, 120)
  g.minRecentMessages = num(g.minRecentMessages, 3, 0, 100)
  g.activeWindowSec = num(g.activeWindowSec, 300, 30, 86400)
  if (!Array.isArray(g.quietHours) || g.quietHours.length !== 2) g.quietHours = DEFAULT_GROUP_POLICY.quietHours
  g.quietHours = g.quietHours.map((h) => num(h, 0, 0, 23))
  if (!isObj(g.overrides)) g.overrides = {}
  c.voice.autoChance = num(c.voice.autoChance, 0.15, 0, 1)
  c.voice.autoMaxChars = num(c.voice.autoMaxChars, 80, 1, 500)
  c.stickers.autoChance = num(c.stickers.autoChance, 0.35, 0, 1)
  c.stickers.maxPerHour = num(c.stickers.maxPerHour, 20, 0, 200)
  c.stickers.maxLibrary = num(c.stickers.maxLibrary, 300, 20, 2000)
  c.diary.timesPerDay = num(c.diary.timesPerDay, 2, 0, 6)
  c.diary.windowStart = hhmm(c.diary.windowStart, '10:00')
  c.diary.windowEnd = hhmm(c.diary.windowEnd, '23:30')
  c.diary.minGapMinutes = num(c.diary.minGapMinutes, 180, 0, 1440)
  c.diary.minChars = num(c.diary.minChars, 60, 10, 500)
  c.diary.maxChars = num(c.diary.maxChars, 140, 20, 1000)
  c.diary.visibility = c.diary.visibility === 'self' ? 'self' : 'all'
  c.speakUp.idleMinutes = num(c.speakUp.idleMinutes, 40, 5, 1440)
  c.speakUp.nudge = bool(c.speakUp.nudge, true)
  c.speakUp.minIntervalMinutes = num(c.speakUp.minIntervalMinutes, 90, 5, 1440)
  c.speakUp.maxIntervalMinutes = Math.max(c.speakUp.minIntervalMinutes, num(c.speakUp.maxIntervalMinutes, 240, 5, 2880))
  c.speakUp.maxPerDay = num(c.speakUp.maxPerDay, 3, 0, 20)
  const q = c.qzoneSocial
  q.enabled = bool(q.enabled, true)
  q.replyOwn = bool(q.replyOwn, true)
  q.commentFriends = bool(q.commentFriends, true)
  q.like = bool(q.like, true)
  q.friendChance = num(q.friendChance, 0.3, 0, 1)
  q.ownerChance = num(q.ownerChance, 0.7, 0, 1)
  q.maxPerDay = num(q.maxPerDay, 8, 0, 50)
  q.intervalMin = num(q.intervalMin, 30, 5, 1440)
  c.mood.halfLifeHours = num(c.mood.halfLifeHours, 3, 0.25, 72)
  c.mood.judge = bool(c.mood.judge, false)
  for (const k of ['tts', 'image', 'song', 'asr']) c.local[k] = bool(c.local[k], false)
  const b = c.bili
  Object.assign(b, splitBiliCookie(b))
  for (const k of ['enabled', 'autoBrowse', 'comment', 'reply', 'shareToOwner', 'like']) b[k] = bool(b[k], DEFAULTS.bili[k])
  b.intervalHours = num(b.intervalHours, 4, 1, 48)
  b.maxRunsPerDay = num(b.maxRunsPerDay, 3, 0, 24)
  b.perRun = num(b.perRun, 3, 1, 8)
  b.minViews = num(b.minViews, 5000, 0, 1e8)
  b.maxAgeDays = num(b.maxAgeDays, 60, 0, 3650)
  b.maxCommentsPerDay = num(b.maxCommentsPerDay, 3, 0, 50)
  b.maxRepliesPerDay = num(b.maxRepliesPerDay, 6, 0, 100)
  b.keywords = (Array.isArray(b.keywords) ? b.keywords : String(b.keywords || '').split(/[\n,，]+/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 30)
  delete c.mood.maxInjectPerDay // 旧版的「每天最多提醒几次」，现在心情明显时每轮都会带上
  c.snowluma.webuiPort = num(c.snowluma.webuiPort, 5099, 1, 65535)
  // 老配置只有一个 consolidateAt：换成两个时间点（它 + 12 小时后）
  if (!Array.isArray(raw?.memory?.consolidateTimes) && raw?.memory?.consolidateAt) {
    const [hh, mm] = hhmm(raw.memory.consolidateAt, '04:00').split(':').map(Number)
    c.memory.consolidateTimes = [`${hh}:${String(mm).padStart(2, '0')}`, `${(hh + 12) % 24}:${String(mm).padStart(2, '0')}`]
  }
  delete c.memory.consolidateAt
  c.memory.consolidateTimes = [...new Set((Array.isArray(c.memory.consolidateTimes) ? c.memory.consolidateTimes : String(c.memory.consolidateTimes || '').split(/[\s,，]+/)).map((t) => hhmm(t, '')).filter(Boolean).map((t) => t.padStart(5, '0')))].sort().slice(0, 4)
  if (!c.memory.consolidateTimes.length) c.memory.consolidateTimes = ['04:00', '16:00']
  c.memory.recallCount = num(c.memory.recallCount, 6, 0, 20)
  g.interests = (Array.isArray(g.interests) ? g.interests : String(g.interests || '').split(/[\s,，]+/)).map((s) => String(s).trim()).filter(Boolean)
  g.minRelevance = num(g.minRelevance, 0.25, 0, 1)
  c.merge.enabled = bool(c.merge.enabled, true)
  c.merge.waitSec = num(c.merge.waitSec, 2.5, 0, 30)
  c.merge.maxSec = Math.max(c.merge.waitSec, num(c.merge.maxSec, 8, 0, 60))
  c.merge.groupWaitSec = num(c.merge.groupWaitSec, 5, 0, 60)
  c.merge.groupMaxSec = Math.max(c.merge.groupWaitSec, num(c.merge.groupMaxSec, 15, 0, 120))
  g.burstMax = num(g.burstMax, 8, 1, 50)
  g.burstWindowSec = num(g.burstWindowSec, 120, 10, 3600)
  if (!['auto', 'edge', 'windows', 'cosyvoice', 'gptsovits', 'http'].includes(c.voice.engine)) c.voice.engine = 'auto'
  c.voice.cosyvoice.sampleRate = num(c.voice.cosyvoice.sampleRate, 22050, 8000, 48000)
  if (!['sft', 'instruct'].includes(c.voice.cosyvoice.mode)) c.voice.cosyvoice.mode = 'sft'
  c.imageGen.enabled = bool(c.imageGen.enabled, false)
  c.imageGen.ownerOnly = bool(c.imageGen.ownerOnly, true)
  if (!/^\d{3,4}x\d{3,4}$/.test(String(c.imageGen.size))) c.imageGen.size = '1024x1024'
  c.song.enabled = bool(c.song.enabled, false)
  c.song.ownerOnly = bool(c.song.ownerOnly, true)
  c.song.pitch = num(c.song.pitch, 0, -24, 24)
  c.song.maxVoiceSec = num(c.song.maxVoiceSec, 120, 15, 600)
  c.song.vocalVolume = num(c.song.vocalVolume, 1, 0.2, 2)
  c.song.instVolume = num(c.song.instVolume, 0.8, 0.1, 2)
  if (!['auto', 'head'].includes(c.song.clipStart)) c.song.clipStart = 'auto'
  // 老配置：'' 是以前的默认（没开），改成自动；tuna 是以前的「用镜像」
  c.song.pypiMirror = { '': 'auto', tuna: 'cn' }[c.song.pypiMirror] ?? c.song.pypiMirror
  if (!['auto', 'cn', 'off'].includes(c.song.pypiMirror)) c.song.pypiMirror = 'auto'
  c.song.root = String(c.song.root || '').trim()
  if (!isObj(c.modules)) c.modules = {}
  for (const [id, m] of Object.entries(c.modules)) {
    if (!isObj(m)) { delete c.modules[id]; continue }
    m.enabled = bool(m.enabled, true)
    m.useBuiltin = bool(m.useBuiltin, false)
  }
  if (!isObj(c.ext)) c.ext = {}
  for (const k of Object.keys(c.ext)) if (!isObj(c.ext[k])) delete c.ext[k] // 传 null = 删掉这个模块的设置
  c.safeMode = bool(c.safeMode, false)
  c.bridge.dshTools = bool(c.bridge.dshTools, false)
  c.bridge.http = bool(c.bridge.http, false)
  c.bridge.token = String(c.bridge.token || '')
  if (!['whitelist', 'owner'].includes(c.bridge.allowTargets)) c.bridge.allowTargets = 'whitelist'
  return c
}

// 面板里不回传原文的字段：路径（几层都行）
const SECRETS = [['snowluma', 'webuiPassword'], ['snowluma', 'httpToken'], ['snowluma', 'wsToken'], ['imageGen', 'apiKey'], ['song', 'neteaseCookie'], ['bili', 'cookie'], ['bili', 'sessdata'], ['bili', 'biliJct'], ['bridge', 'token']]
// 扩展模块设置里的密码类字段（模块加载时登记）：['ext', 模块id, 字段]
const extraSecrets = new Map()
export function registerSecretField(path) { extraSecrets.set(path.join('\u0000'), path) }
const allSecrets = () => [...SECRETS, ...extraSecrets.values()]
const parentOf = (obj, path, create) => {
  let cur = obj
  for (const k of path.slice(0, -1)) {
    if (!isObj(cur[k])) { if (!create) return null; cur[k] = {} }
    cur = cur[k]
  }
  return cur
}
const getAt = (obj, path) => { const p = parentOf(obj, path, false); return p ? p[path.at(-1)] : undefined }
// 这些密钥在面板里显示结尾几位（「已保存（结尾 …a1b2）」），方便认出存的是哪一份；完整值不回传
const HINTED = [['bili', 'sessdata'], ['bili', 'biliJct']]

/** 从一串 Cookie 里取某个值（「SESSDATA=xxx; bili_jct=yyy」）。 */
export function cookieValue(raw, key) {
  for (const part of String(raw || '').split(/;\s*/)) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === key) return part.slice(i + 1).trim()
  }
  return ''
}

/**
 * B 站 Cookie 整理成两个值：粘了整串 / 带了「SESSDATA=」前缀的都认得；老配置只有整串的拆开。
 * 返回 {sessdata, biliJct, cookie}，cookie 是拼好给接口用的。
 */
export function splitBiliCookie({ sessdata = '', biliJct = '', cookie = '' } = {}) {
  const a = String(sessdata || '').trim()
  const b = String(biliJct || '').trim()
  // 框里粘的是「xxx=…」这种整串或带前缀的：从里面取；纯值原样用
  const isRaw = (v) => /(^|;\s*)(SESSDATA|bili_jct)=/.test(v)
  let s = isRaw(a) ? '' : a
  let j = isRaw(b) ? '' : b
  for (const v of [a, b]) {
    if (!isRaw(v)) continue
    s = cookieValue(v, 'SESSDATA') || s
    j = cookieValue(v, 'bili_jct') || j
  }
  if (!s && !j && cookie) {
    s = cookieValue(cookie, 'SESSDATA')
    j = cookieValue(cookie, 'bili_jct')
  }
  return { sessdata: s, biliJct: j, cookie: [s && `SESSDATA=${s}`, j && `bili_jct=${j}`].filter(Boolean).join('; ') }
}

const FILE = () => dataDir('config.json')

/** 在某次更新里新增、会替她公开发东西的功能。以后再加这类功能，把配置键名加到这里。 */
export const OPT_IN_ON_UPDATE = ['qzoneSocial', 'bili']

export function loadConfig() {
  const raw = readJson(FILE(), {})
  // 老配置（向导上线前就填好了两个号）直接算向导已完成
  if (raw && raw.setupDone === undefined && raw.botQQ && raw.ownerQQ) raw.setupDone = true
  // 更新插件后新增的、会公开发东西的功能：老用户先关着，等他们自己在面板里打开（新安装照常默认开）
  if (raw && raw.setupDone) for (const k of OPT_IN_ON_UPDATE) if (raw[k] === undefined) raw[k] = { enabled: false }
  return normalize(raw)
}

export function saveConfig(cfg) {
  const c = normalize(cfg)
  writeJson(FILE(), c)
  return c
}

/** 给面板看的版本：密码 / token 不回传原文，只告诉有没有填。 */
export function publicConfig(cfg) {
  const c = structuredClone(cfg)
  for (const [g, k] of HINTED) c[g][`${k}Hint`] = c[g][k] ? '…' + String(c[g][k]).slice(-4) : ''
  for (const path of allSecrets()) {
    const p = parentOf(c, path, false)
    if (!p) continue
    const k = path.at(-1)
    p[`${k}Set`] = Boolean(p[k])
    p[k] = ''
  }
  return c
}

/** 面板保存时：没改的密码字段（空串）保留原值。 */
export function mergeFromPanel(current, incoming) {
  const next = deepMerge(current, incoming || {})
  for (const path of allSecrets()) {
    const v = getAt(incoming || {}, path)
    const p = parentOf(next, path, v !== undefined)
    if (!p) continue
    const k = path.at(-1)
    if (v === null) p[k] = '' // 明确传 null = 清空
    else if (v === undefined || v === '') p[k] = getAt(current, path) ?? ''
    delete p[`${k}Set`]
    delete p[`${k}Hint`]
  }
  // 联动密钥只由插件生成，面板不能改
  next.bridge.token = current.bridge?.token || ''
  // B 站：只改了其中一个值时，另一个保留；整串粘进来的会在 normalize 里拆开
  if (incoming?.bili && (incoming.bili.sessdata || incoming.bili.biliJct)) next.bili.cookie = ''
  if (incoming?.group?.overrides) next.group.overrides = incoming.group.overrides
  // 按聊天选模型：两张表整张替换（deepMerge 会让删掉的条目又回来）
  if (incoming?.chatModels?.privates) next.chatModels.privates = incoming.chatModels.privates
  if (incoming?.chatModels?.groups) next.chatModels.groups = incoming.chatModels.groups
  if (incoming?.allow) next.allow = { ...current.allow, ...incoming.allow }
  return normalize(next)
}
