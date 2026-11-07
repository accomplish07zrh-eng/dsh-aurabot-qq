// 目的机制（主动搭话引擎）的 Aurabot 接线层。
//
// 引擎本体在 ./engine.js（逻辑移植自 Mieksido/surfcore 的 purpose-engine，MIT，
// 署名见 THIRD-PARTY-NOTICES.md；零 import 零 I/O 的纯函数）。
// 本文件负责副作用：状态文件、素材采集（记忆 + 聊天流水适配）、生成（hub.runSystemTurn）、
// 投递（hub.deliver）、心情 nudge、追问、路由。
//
// 使用方式：独立的 purpose 内置模块（src/modules/purpose/index.js），默认关闭；
// 现有的「主动搭话」模块（speakup，src/features/companion.js）保持默认实现不变，
// 想换引擎的主人自己开关，迁移说明见 docs/PURPOSE_MODULE_API.md。

import { dataDir, readJson, writeJson } from '../core/store.js'
import { cleanOutboundText } from '../chat/reply.js'
import { isSessionBackoff } from '../chat/session-backoff.js'
import { followUpHint } from '../features/memory.js'
import { selfName, selfNames } from '../persona/personas.js'
import { normalizeSelection } from '../chat/chat-model.js'
import {
  DEFAULT_PURPOSE_CONFIG, PURPOSE_NEEDS, NEED_LABELS, EMOTION_LABELS, EMOTION_PROFILES,
  normalizePurposeConfig, createPurposeState, normalizePurposeState,
  ensurePurposeDay, ensurePurposeSchedule, planNextFire, evaluatePurposeTick,
  markPurposeDelivered, markPurposeSkip, applyPurposeOutcome,
  collectMaterials, analyzePersona, deriveDrives, formGoalHypotheses, applyPersonaOverrides,
  minePurposeSeeds, selectPurpose, buildPurposePrompt, parsePurposeMemo, emotionProfile,
  summarizePurposeState, recordOwnerReplyHours, formatMaterialLine,
} from './engine.js'

const MINUTE = 60_000
// mood 模块靠 userText 的「【系统提醒」前缀把主动回合判成 origin='speak-up'（mood/index.js 的判定），
// deliver 路径本身没有 userText，这里补一个同款前缀，保住心情判定链路。
const MOOD_PREFIX = '【系统提醒，不是主人说的话】（她主动找你）'
const SILENCE = '[沉默]'

const pad2 = (n) => String(n).padStart(2, '0')
// 文本截断：模块内随手用（引擎侧有同名工具，这里不跨文件依赖）。
const clip = (text, max = 120) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}
const clampInt = (v, d, lo, hi) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d
}

/**
 * 把 Aurabot 配置映射成引擎配置。
 * 醒着窗口（speakUp.awakeFrom/awakeTo）是唯一真相，引擎的安静时段由它派生；
 * 调参走本模块自己的设置面 cfg.ext.purpose.*（模块默认关：ext.purpose.enabled）。
 */
export function purposeConfig(cfg = {}) {
  const su = cfg.speakUp || {}
  const ext = (cfg.ext && cfg.ext.purpose) || {}
  const awakeFrom = clampInt(ext.awakeFrom ?? su.awakeFrom, 8, 0, 24)
  const awakeTo = clampInt(ext.awakeTo ?? su.awakeTo, 23, 0, 24)
  // awake 窗口为全天（awakeTo>=24 或区间非法）时，安静时段关闭（start===end 视为不启用）
  const quiet = awakeTo >= 24 || awakeFrom >= awakeTo
    ? { quietStart: '00:00', quietEnd: '00:00' }
    : { quietStart: `${pad2(awakeTo % 24)}:00`, quietEnd: `${pad2(awakeFrom)}:00` }
  // normalizePurposeConfig 只认引擎字段，打分模型在归一化后补挂（面板下拉同款结构校验）
  return {
    ...normalizePurposeConfig({
      // 总开关只看本模块自己的设置（ext.purpose.enabled，默认 false）；
      // 与旧的「主动搭话」互不影响——两套同时开会重复打扰，迁移说明里提醒主人别同时开。
      enabled: cfg.enabled !== false && ext.enabled === true,
      ownerUin: cfg.ownerQQ,
      gapMinMs: clampInt(ext.minIntervalMinutes ?? su.minIntervalMinutes, 90, 5, 2880) * MINUTE,
      gapMaxMs: clampInt(ext.maxIntervalMinutes ?? su.maxIntervalMinutes, 240, 5, 2880) * MINUTE,
      initialDelayMinMs: clampInt(ext.initialDelayMinutes, 15, 1, 720) * MINUTE,
      dailyMax: clampInt(ext.maxPerDay ?? su.maxPerDay, 3, 0, 20),
      idleThresholdMs: clampInt(ext.idleMinutes ?? su.idleMinutes, 40, 0, 1440) * MINUTE,
      minMaterials: clampInt(ext.minMaterials, DEFAULT_PURPOSE_CONFIG.minMaterials, 0, 20),
      maxMaterials: clampInt(ext.maxMaterials, DEFAULT_PURPOSE_CONFIG.maxMaterials, 6, 80),
      maxCandidates: clampInt(ext.maxCandidates, DEFAULT_PURPOSE_CONFIG.maxCandidates, 3, 10),
      promptMaxChars: clampInt(ext.promptMaxChars, DEFAULT_PURPOSE_CONFIG.promptMaxChars, 4000, 30000),
      ...quiet,
    }),
    // 素材打分模型（面板「目的引擎」卡下拉选；不配 = 用关键词法，零额外成本）。
    scoringModel: normalizeSelection(ext.scoringModel),
  }
}

/** 模型回包清洗：去掉备忘段、引号、自称前缀；空/沉默返回 ''。 */
export function cleanReply(raw, options, cfg) {
  let s = String(raw ?? '')
  const cut = /(^|\n)\s*(?:[【\[]\s*(?:目的|需求|情绪|类型|状态|待续)\s*[】\]]|[【\[]?\s*内部备忘)/.exec(s)
  if (cut) s = s.slice(0, cut.index) // 内部备忘不发到 QQ
  s = s.replace(/^[「“"'']+/, '').replace(/[」”"'']+$/, '')
  for (const name of selfNames(cfg)) {
    if (s.slice(0, name.length).toLowerCase() !== name.toLowerCase()) continue
    const tail = s.slice(name.length)
    if (/^\s*[:：]/.test(tail)) { s = tail.replace(/^\s*[:：]\s*/, ''); break }
  }
  s = cleanOutboundText(s, options).trim()
  if (!s || s.replace(/\s/g, '').startsWith(SILENCE)) return ''
  return s
}

export function createPurpose({ getConfig, setConfig, hub, log, isMuted, mood, memory, personaText, pet: petOf, use }) {
  const moodOf = () => { try { return mood?.() || null } catch { return null } }
  const memoryOf = () => { try { return memory?.() || null } catch { return null } }
  // 下面的 friend 是主动搭话白名单里的 QQ 号，不传就是主人。朋友各有各的状态，素材只看和这个人的私聊、关于这个人的记忆。
  const chatIdOf = (cfg, friend) => `private:${friend || cfg.ownerQQ}`
  const lastPrivateAt = (cfg, friend) => friend ? (hub?.lastPrivateAt?.(friend) || 0) : Math.max(hub?.lastOwnerChatAt || 0, hub?.lastBotToOwner?.at || 0)
  const stateFile = (friend) => dataDir('purpose', ...(friend ? ['friends', `${friend}.json`] : ['purpose-state.json']))
  const nudgeFile = () => dataDir('purpose', 'nudge.json')

  // ---------- 状态 ----------
  function loadState(config, now = Date.now(), friend = '') {
    const raw = readJson(stateFile(friend), null)
    const state = normalizePurposeState(raw, now)
    if (!raw && !friend) {
      // 旧 speakup.json 只读迁移当日次数，之后弃用
      const legacy = readJson(dataDir('speakup.json'), null)
      const legacyCount = Number(legacy?.count) || 0
      if (legacy?.day === new Date(now).toDateString() && legacyCount > 0) state.countToday = legacyCount
    }
    if (state.lastOutcome === 'pending') { // 重启不补发：上次在途改判 interrupted，归零重排
      state.lastOutcome = 'interrupted'
      state.nextFireAt = 0
    }
    ensurePurposeDay(state, now)
    ensurePurposeSchedule(state, { now, config })
    return state
  }
  const saveState = (state, friend = '') => writeJson(stateFile(friend), state)

  // ---------- 素材（记忆 importance 0~1 → 引擎 0~100） ----------
  function memoryRecords(friend = '') {
    try {
      const items = memoryOf()?.list?.('') || []
      return items
        .filter((m) => m && !m.invalidAt && !m.followUp && m.text && !['hearsay', 'guess'].includes(m.status) && (!friend || (m.scope !== 'group' && String(m.about) === friend)))
        .map((m) => ({
          id: m.id,
          title: '',
          text: String(m.text),
          importance: Math.round((Number(m.importance) || 0) * 100),
          emotional: 0, // aurabot 记忆没有情绪分字段，留 0
          lastSeenAt: m.lastHit || m.at,
          createdAt: m.at,
          pinned: false, anchor: false, isInitial: false,
        }))
    } catch {
      return []
    }
  }

  // 聊天流水（hub.chatLogOf）→ 引擎的 conversations 结构：只看主人私聊 + 最近群；朋友只看 TA 自己的私聊
  function conversations(cfg, now = Date.now(), friend = '') {
    const ownerKey = chatIdOf(cfg, friend)
    const per = new Map()
    const pick = (chatId) => {
      let c = per.get(chatId)
      if (!c) { c = { key: chatId, recentMessages: [], activeTopics: [], pendingThoughts: [] }; per.set(chatId, c) }
      return c
    }
    try {
      const days = hub.chatLogDays?.() || []
      for (const day of days.slice(-2)) {
        for (const e of hub.chatLogOf?.(day) || []) {
          if (!e?.chatId || e.forgottenAt) continue
          if (e.chatId !== ownerKey && (friend || !String(e.chatId).startsWith('group:'))) continue
          pick(e.chatId).recentMessages.push({
            text: String(e.text || ''),
            time: Number(e.t) || 0,
            isSelf: e.who === 'bot',
            isOwner: e.chatId === ownerKey && e.who !== 'bot',
            sender: e.who === 'bot' ? selfName(cfg) : String(e.uid || '群友'),
          })
        }
      }
    } catch {}
    // 只保留窗口内有内容的会话
    const windowStart = now - 72 * 60 * MINUTE
    return [...per.values()].filter((c) => c.recentMessages.some((m) => m.time >= windowStart))
  }

  const personaOf = (cfg) => {
    try { return analyzePersona(personaText?.() || '') } catch { return analyzePersona('') }
  }

  // ---------- 素材打分（可选：面板下拉配了「打分模型」才启用） ----------
  // 一次后台回合把整批素材交给模型定 need 与情绪，替换关键词法的粗判。
  // 没配模型、回合出错或回包解析不出，都静默回退关键词亲和（enrichMaterial 已算好），零额外成本。
  async function scoreMaterials(config, materials, now = Date.now()) {
    const sel = config.scoringModel
    if (!sel || !Array.isArray(materials) || !materials.length) return materials
    const list = materials.slice(0, 28)
    const lines = list.map((m, i) => `${i + 1}. ${formatMaterialLine(m, now)}`)
    const prompt = [
      '下面是 AI 伙伴「大肥鱼」最近看到/经历的事情列表（已脱敏）。给每一条判断：',
      `① 它最指向哪种内心需要（只能是：${PURPOSE_NEEDS.join('/')}）；`,
      `② 它让大肥鱼产生什么情绪（只能是：${Object.keys(EMOTION_LABELS).join('/')}）。`,
      '只输出一个 JSON 数组，不要解释：[{"i":1,"need":"play","emotion":"curious"}, …]，i 对应条目序号。',
      '',
      ...lines,
    ].join('\n')
    try {
      const raw = await hub.runSystemTurn('purpose-score', 'QQ · 素材打分', prompt, {
        timeoutMs: 90000, noTools: true, key: 'score', model: sel,
      })
      const arr = parseScoreReply(raw)
      let hit = 0
      for (const item of Array.isArray(arr) ? arr : []) {
        const m = list[(Number(item?.i) || 1) - 1]
        if (!m || !PURPOSE_NEEDS.includes(item?.need)) continue
        hit += 1
        m.needAffinity = Object.fromEntries(PURPOSE_NEEDS.map((n) => [n, n === item.need ? 1 : 0]))
        const emotion = EMOTION_LABELS[item?.emotion] ? item.emotion : ''
        if (emotion) {
          m.scoredEmotion = emotion
          // 情绪画像回写 cues：后续 appraiseMaterial 直接吃模型判的情绪强弱。
          const p = EMOTION_PROFILES[emotion]
          m.cues = { positive: p.valence > 0.1, negative: p.valence < -0.1, arousal: p.arousal }
        }
      }
      log.info?.(`目的：素材打分完成（模型 ${sel.provider}/${sel.model}，命中 ${hit}/${list.length}）`)
    } catch (error) {
      log.warn?.('目的：素材打分失败，回退关键词法：', error?.message)
    }
    return materials
  }

  // 回包清洗：剥掉代码围栏与前后杂文，取第一个 JSON 数组；解析不出返回 null。
  function parseScoreReply(raw) {
    const s = String(raw ?? '').replace(/```(?:json)?/gi, '')
    const start = s.indexOf('[')
    const end = s.lastIndexOf(']')
    if (start < 0 || end <= start) return null
    try { return JSON.parse(s.slice(start, end + 1)) } catch { return null }
  }

  // 「自主上网」等浏览型模块的素材口（可选）：模块没装/没开就返回空，行为与从前一致。
  // 取 use('rss-reader').materials() —— 那些是模块已经筛过、交给决策层的条目（纯文本、已截断）。
  function rssEntries(friend = '') {
    if (friend) return [] // 朋友的线不喂全站浏览素材：那是主人自己的阅读兴趣
    try {
      const mod = typeof use === 'function' ? use('rss-reader') : null
      const list = typeof mod?.materials === 'function' ? mod.materials() : null
      if (!Array.isArray(list)) return []
      return list.slice(0, 10).map((m) => ({
        id: String(m?.id || ''),
        // 引擎素材分类里「外部看到的东西」走 video 这一支（权重低于主人私聊、高于群聊）
        type: 'video',
        title: clip(String(m?.title || ''), 90),
        text: clip(String(m?.text || ''), 200),
        url: String(m?.url || ''),
        at: Number(m?.at) || Date.now(),
      }))
    } catch {
      return []
    }
  }

  // ①~④ 收素材 → 驱动 → 目标假设 → 候选（不落盘；打分配了模型才有一次额外回合）
  async function prepare(cfg, config, state, now = Date.now(), friend = '') {
    const followUp = memoryOf()?.dueFollowUp?.(friend || cfg.ownerQQ, now) || null
    const materials = collectMaterials({
      now, config,
      ownerUin: friend || cfg.ownerQQ,
      roleName: selfName(cfg),
      roleAliases: selfNames(cfg),
      conversations: conversations(cfg, now, friend),
      biliEntries: rssEntries(friend), // 浏览型模块的素材口（rss-reader「自主上网」等）；空数组=与从前一致
      memoryRecords: memoryRecords(friend),
      followUpRecords: followUp ? [followUp] : [],
    })
    await scoreMaterials(config, materials.items, now)
    // 人格卡只作用于主人这条线：朋友的排程不吃主人人格卡里的黏人/话痨等覆写，
    // 否则对朋友的主动搭话频率与方向会被主人的人格先验带偏（review 意见）。
    const persona = friend ? null : personaOf(cfg)
    const lastMasterAt = lastPrivateAt(cfg, friend)
    const { drives } = deriveDrives({
      drives: state.drives, drivesAt: state.drivesAt,
      materials: materials.items, now, lastMasterAt, personaBias: persona?.bias,
      needFeedback: state.needFeedback, halfLifeHours: config.driveHalfLifeHours,
      connectFloor: persona?.overrides?.connectFloor,
    })
    const { goals, observations, needFeedback } = formGoalHypotheses({
      // 跟进的排程和次数只属于事实，不再生成另一份目标或观察账本。
      materials: materials.items.filter((m) => m.kind !== 'memory-follow-up'), goals: state.goals, observations: state.observations,
      drives, now, lastMasterAt, config, roleName: selfName(cfg), persona,
    })
    const seeds = minePurposeSeeds({
      materials: materials.items, now, roleName: selfName(cfg), config,
      drives, history: state.history, lastMasterAt,
    })
    return { materials, persona, lastMasterAt, drives, goals, observations, seeds, needFeedback, followUp }
  }

  const friendName = (friend) => {
    try { return memoryOf()?.profiles?.().find((p) => p.qq === friend)?.name || '这位朋友' } catch { return '这位朋友' }
  }

  function promptFor(cfg, config, selected, ctx, state, now = Date.now(), friend = '') {
    const name = friend ? friendName(friend) : cfg.ownerName || '主人'
    const prompt = buildPurposePrompt({
      now, config, mode: 'auto', // 模型直接输出那句话（Aurabot 没有 QQ 发送工具）
      ownerUin: friend || cfg.ownerQQ,
      ownerName: name,
      contextBlocks: [],
      materials: ctx.materials.items,
      candidates: ctx.candidates,
      selected,
      pending: state.pending,
      history: state.history,
      stats: ctx.materials.stats,
      drives: ctx.drives,
    }) + `\n6) 这一轮不能用任何工具：直接输出你要发的那句话即可（会自动转发给${name}）。不想说就整段只输出 ${SILENCE}。`
    const body = friend ? prompt.replaceAll('主人', name) : prompt // 朋友不是她的主人
    return [`你是「${selfName(cfg)}」。`, body, selected?.kind === 'memory-follow-up' ? followUpHint(ctx.followUp) : ''].filter(Boolean).join('\n')
  }

  // ---------- 载体分发（互斥铁律：一轮只发一处，永不双发） ----------
  // 配置真相：cfg.ext.purpose.carrier / petFallbackToQQ（host.js /panel/purpose/config 聚合写入）。
  // carrier=pet 只有在装了并开启「桌宠」模块后才会真正走气泡；桌宠模块是独立的 PR/模块，
  // 没装时 petOf() 为 null，一律按离线回落处理（默认回 QQ，行为与从前一致）。
  function carrierSettings() {
    const ext = (getConfig().ext && getConfig().ext.purpose) || {}
    return { carrier: ext.carrier === 'pet' ? 'pet' : 'qq', petFallbackToQQ: ext.petFallbackToQQ !== false }
  }
  function syncPetCarrierMirror(su) {
    if (su.carrier !== 'pet' || typeof setConfig !== 'function') return
    try {
      const cfg = getConfig()
      const cur = (cfg.ext && cfg.ext.pet) || {}
      if (cur.carrier === su.carrier && (cur.petFallbackToQQ !== false) === su.petFallbackToQQ) return
      setConfig({ ...cfg, ext: { ...(cfg.ext || {}), pet: { ...cur, carrier: su.carrier, petFallbackToQQ: su.petFallbackToQQ } } })
    } catch {}
  }
  /**
   * carrier=pet 时的投递决策。返回 'sent'（已投递）| 'qq'（调用方投递）| 'silent'（不发）| 'failed'（结果不确定，不重发）。
   * 在线才调 pet.dispatch（避免它内部回落路径绕过 own/userText 心情链路）；离线由 purpose 自己决定回落或静默；
   * dispatch 返回非 ok（如专注模式 focus：不发也不回落）按契约映射，绝不在一个回合里两头都发。
   */
  async function deliverByCarrier(text, purposeLabel, emotion = '', emotionProfile = null) {
    const su = carrierSettings()
    if (su.carrier !== 'pet') return 'qq' // carrier=qq（默认）：行为与从前完全一致
    const pet = typeof petOf === 'function' ? petOf() : null
    let online = false
    try { online = Boolean(pet?.online?.()?.online) } catch {}
    if (online && typeof pet.dispatch === 'function') {
      syncPetCarrierMirror(su)
      let r = null
      try {
        // emotion/emotionProfile：桌宠气泡按情绪画像上辉光（冷暖随 valence、强弱随 arousal）
        r = await pet.dispatch({ text, purpose: String(purposeLabel || '').slice(0, 40), emotion, emotionProfile })
      } catch (error) {
        // dispatch 可能已经发出后才抛错；结果不确定时不能再发一次。
        log.warn?.('目的：桌宠气泡投递出错，结果不确定，不再重发：', error?.message)
        return 'failed'
      }
      if (r && r.ok && r.via !== 'qq') hub.noteSaid?.(chatIdOf(getConfig()), text) // 气泡没法回，主人在 QQ 接话时她得知道说过什么
      if (r && r.ok) return 'sent' // dispatch 内部竞态回落 QQ 时也已发出，调用方不能再发
      if (r && r.reason === 'focus') return 'silent' // 专注模式开着：不发也不回落
      if (r && r.reason === 'pet-offline') return su.petFallbackToQQ ? 'qq' : 'silent' // 已确认尚未投递
      log.warn?.('目的：桌宠投递未确认成功，不再重发')
      return 'failed'
    }
    // pet 离线 / 模块没在跑：按回落开关决定 purpose 自己走 QQ（带 own/userText，保住心情与流水链路）或静默
    return su.petFallbackToQQ ? 'qq' : 'silent'
  }

  // ---------- 生成 + 投递 + 回执（hub.deliver 内部吞错，成功判定看返回值） ----------
  async function runOnce({ reason = '定时', config, state, force = false, friend = '' } = {}) {
    const cooldown = hub.systemSessionCooldown?.('purpose', { key: friend })
    if (cooldown) return { outcome: 'skipped-cooldown', retryAt: cooldown.retryAt }
    const cfg = getConfig()
    const now = Date.now()
    ensurePurposeDay(state, now)
    const ctx = await prepare(cfg, config, state, now, friend)
    state.drives = ctx.drives
    state.drivesAt = now
    state.goals = ctx.goals
    state.observations = ctx.observations
    // 行为学习账本：回复时段直方图 + 需要维度正反馈率（都在真回合里落盘；preview 不走这里）。
    recordOwnerReplyHours(state, ctx.materials.items, now)
    mergeNeedFeedback(state, ctx.needFeedback)

    // 朋友没聊过就别凭人设硬找：没有素材时她只能瞎编由头
    const hasEnough = Boolean(ctx.followUp) || (friend
      ? ctx.materials.items.length >= Math.max(1, config.minMaterials)
      : ctx.materials.items.length >= config.minMaterials || state.pending.length > 0 || ctx.persona.hasText)
    if (!hasEnough) {
      markPurposeSkip(state, { now, reason: 'materials', nextFireAt: planNextFire({ now, config, lastRunAt: state.lastRunAt, countToday: state.countToday, replyHours: state.replyHours, replyWeekday: state.replyWeekday }) })
      saveState(state, friend)
      log.info?.(`目的（${reason}）：素材太少，改约下一次`)
      return { outcome: 'skipped-materials' }
    }

    const picked = selectPurpose({
      seeds: ctx.seeds, goals: ctx.goals, pending: state.pending, history: state.history,
      config, drives: ctx.drives, now, lastMasterAt: ctx.lastMasterAt,
    })
    state.lastMaterialCount = ctx.materials.items.length
    state.lastCandidateCount = picked.candidates.length
    if (!picked.purpose) {
      markPurposeSkip(state, { now, reason: 'no-candidate', nextFireAt: planNextFire({ now, config, lastRunAt: state.lastRunAt, countToday: state.countToday, replyHours: state.replyHours, replyWeekday: state.replyWeekday }) })
      saveState(state, friend)
      log.info?.(`目的（${reason}）：这轮没选出目的，改约下一次`)
      return { outcome: 'skipped-no-candidate' }
    }

    const prompt = promptFor(cfg, config, picked.purpose, { ...ctx, candidates: picked.candidates }, state, now, friend)
    // 投递即占今日次数（模型回合已经花钱了）；引擎随后按真结局结算
    const beforeAttempt = { ...state }
    markPurposeDelivered(state, { now, planned: picked.purpose })
    saveState(state, friend)

    let raw = ''
    let genError = null
    try {
      log.info?.(`目的（${reason}）：${picked.purpose.text}`)
      raw = await hub.runSystemTurn('purpose', 'QQ · 主动搭话（目的回合）', prompt, { timeoutMs: 180000, noTools: true, key: friend })
    } catch (error) {
      if (isSessionBackoff(error)) {
        // 查询与真正调用之间也可能进入冷却；这一轮没启动，不占次数或失败账。
        Object.assign(state, beforeAttempt)
        saveState(state, friend)
        return { outcome: 'skipped-cooldown', retryAt: error.retryAt }
      }
      genError = error
      log.warn?.('目的：生成出错：', error?.message)
    }
    const memo = parsePurposeMemo(raw)
    const text = cleanReply(raw, { warn: (message) => log.warn?.(`目的：${message}`) }, getConfig())
    let outcome
    if (!text) {
      outcome = genError ? 'failed' : 'silent' // 模型有权跳过（【状态】跳过 / [沉默]），silent 不硬发
    } else {
      const where = friend ? 'qq' : await deliverByCarrier(text, picked.purpose.text, picked.purpose.emotion || '', emotionProfile(picked.purpose.emotion)) // 桌宠气泡只给主人看
      if (where === 'sent') {
        outcome = 'sent' // dispatch 已推气泡或回落 QQ：正常结算次数与心情
      } else if (where === 'silent') {
        outcome = 'silent' // carrier=pet 且关闭回落（或专注模式）：静默，不硬补
      } else if (where === 'failed') {
        outcome = 'delivery-failed' // dispatch 结果不确定：不补发，避免重复
      } else {
        try {
          // 不带 own:true：这条是别处（目的回合）发的，hub 只把「实际成功发出」的文本记进 saidElsewhere，
          // 主人在 QQ 私聊回复时补进她的上下文，她才知道自己刚发过什么（#133 同款桥接；#211 review 后改为按真发出结果记）。
          const r = await hub.deliver(chatIdOf(cfg, friend), text, { userText: MOOD_PREFIX })
          // 真发出去过才算 sent：deliver 返回 {sent, failed}，sent 空 = 一条都没发出去（吞错/拦截/dry-run）
          outcome = r && typeof r === 'object' && String(r.sent || '').trim() ? 'sent' : 'silent'
        } catch (error) {
          outcome = 'delivery-failed'
          log.warn?.('目的：投递失败：', error?.message)
        }
      }
    }
    const following = picked.purpose.kind === 'memory-follow-up'
    if (following && outcome === 'sent') memoryOf()?.markFollowUpAsked?.(ctx.followUp.id)
    // 模型的「待续」不能把事实跟进再复制进 purpose.pending。
    applyPurposeOutcome(state, { now: Date.now(), config, outcome, text, memo: following ? null : memo, planned: picked.purpose })
    if (!friend) nudgeMood(picked.purpose, outcome, memo)
    saveState(state, friend)
    log.info?.(`目的：回合结束 ${outcome}（今天第 ${state.countToday} 次）`)
    return { outcome, text, memo }
  }

  // 把 formGoalHypotheses 刚结算的反馈计数并进长期账本（状态文件按 normalize 洗字段）。
  function mergeNeedFeedback(state, stats) {
    if (!stats || typeof stats !== 'object') return
    const cur = state.needFeedback && typeof state.needFeedback === 'object' ? state.needFeedback : {}
    for (const need of PURPOSE_NEEDS) {
      const s = stats[need]
      if (!s || typeof s !== 'object') continue
      const slot = cur[need] || (cur[need] = { positive: 0, negative: 0, neutral: 0 })
      slot.positive = clampInt((Number(slot.positive) || 0) + (Number(s.positive) || 0), 0, 0, 9999)
      slot.negative = clampInt((Number(slot.negative) || 0) + (Number(s.negative) || 0), 0, 0, 9999)
      slot.neutral = clampInt((Number(slot.neutral) || 0) + (Number(s.neutral) || 0), 0, 0, 9999)
    }
    state.needFeedback = cur
  }

  // 9 维驱动 → mood 单标量。mood 关闭时 nudge 自静默。
  // memo 里的【感受】喜/−喜（feelings.moodDelta ±10）会叠加在情绪表之上。
  function nudgeMood(purpose, outcome, memo = null) {
    if (outcome !== 'sent') return
    const m = moodOf()
    if (!m?.nudge) return
    const table = { affectionate: 5, excited: 5, proud: 4, amused: 4, lonely: -3, bored: -2, worried: -2, envious: -2, content: 0 }
    const delta = table[purpose?.emotion] || 0
    const feel = Math.max(-10, Math.min(10, Number(memo?.feelings?.moodDelta) || 0))
    const total = delta + feel
    if (!total) return
    try { m.nudge(total, `主动搭话：${String(purpose?.text || '').slice(0, 20)}`) } catch {}
  }

  // ---------- 追问（沿用旧 speakup 的「轻轻追一句」，不占今日次数） ----------
  async function maybeNudge(cfg, state, now = Date.now()) {
    const su = cfg.speakUp || {}
    if (!su.nudge) return false
    const lb = hub.lastBotToOwner || { at: 0, text: '' }
    const quietMs = now - (lb.at || 0)
    const flag = readJson(nudgeFile(), {})
    if (!lb.at || lb.at <= (hub.lastOwnerChatAt || 0)) return false
    if (flag.nudgedFor === lb.at) return false
    if (!/[？?]|吗|呢|嘛|没$/.test(String(lb.text || '').trim())) return false
    if (!(quietMs > 15 * MINUTE && quietMs < 40 * MINUTE)) return false
    if (hub.systemSessionCooldown?.('purpose-nudge')) return false
    writeJson(nudgeFile(), { nudgedFor: lb.at }) // 引擎状态文件会被 normalize 洗字段，追问标记单独存
    if (Math.random() >= 0.5) return true
    const idle = Math.round(quietMs / MINUTE)
    const owner = cfg.ownerName || '主人'
    const prompt = `【系统提醒，不是${owner}说的话】你刚才跟${owner}说「${String(lb.text || '').slice(-60)}」，${owner}已经 ${idle} 分钟没回了。可以轻轻追一句（比如「人呢」「睡着啦？」，或者换个话题），别催、别抱怨；觉得${owner}在忙就只回 ${SILENCE}。这一轮不能用工具，直接输出那句话。`
    try {
      const raw = await hub.runSystemTurn('purpose-nudge', 'QQ · 主动搭话（追问）', prompt, { timeoutMs: 120000, noTools: true })
      const text = cleanReply(raw, { warn: (message) => log.warn?.(`目的：${message}`) }, getConfig())
      if (text) await hub.deliver(chatIdOf(cfg), text, { userText: MOOD_PREFIX }) // 不带 own:true，同上：hub 桥接进下次对话
    } catch (error) {
      if (isSessionBackoff(error)) {
        writeJson(nudgeFile(), flag)
        return false
      }
      log.warn?.('目的：追问出错：', error?.message)
    }
    return true
  }

  // ---------- 对外 ----------
  /** 到点就跑一轮，跑了返回 true。 */
  async function tickOne(cfg, config, friend = '') {
    const now = Date.now()
    const state = loadState(config, now, friend)
    if (!friend && await maybeNudge(cfg, state, now)) return true
    if (hub.systemSessionCooldown?.('purpose', { key: friend })) return false
    const env = {
      enabled: true, modeOk: true, dshReady: true, paused: false, ownerAllowed: true,
      busy: false, friendOk: true, budgetBlocked: false, // Aurabot 无 token 预算/好友探测服务，恒可用（留 env 位）
      ownerIdleMs: now - lastPrivateAt(cfg, friend),
    }
    const verdict = evaluatePurposeTick({ now, config, state, env })
    if (verdict.action !== 'run') {
      if (verdict.reason !== 'waiting') markPurposeSkip(state, { now, reason: verdict.reason, nextFireAt: verdict.nextFireAt || state.nextFireAt })
      saveState(state, friend)
      return false
    }
    await runOnce({ reason: friend ? '定时（白名单）' : '定时', config, state, friend })
    return true
  }

  /** 主人和白名单的朋友各算各的，一次最多找一个人，不一口气群发。
   *  人格卡的性格覆写（胆量/话多/黏人地板）只作用于主人这条线；朋友的排程沿用基础配置。 */
  async function tick() {
    const cfg = getConfig()
    const config = purposeConfig(cfg)
    if (!config.enabled || !cfg.ownerQQ) return
    const ownerConfig = applyPersonaOverrides(config, personaOf(cfg))
    if (!isMuted?.(chatIdOf(cfg)) && !memoryOf()?.dislikes?.(cfg.ownerQQ) && await tickOne(cfg, ownerConfig)) return
    for (const qq of cfg.speakUp?.allow || []) {
      if (String(qq) === String(cfg.ownerQQ) || isMuted?.(chatIdOf(cfg, qq)) || memoryOf()?.dislikes?.(qq)) continue
      if (await tickOne(cfg, config, String(qq))) return
    }
  }

  /** 手动触发（面板「现在就让她来找我」）：跳过排程类闸门，不跳过总开关/禁言。 */
  async function fire(reason = '手动') {
    const cfg = getConfig()
    const config = applyPersonaOverrides(purposeConfig(cfg), personaOf(cfg))
    if (!config.enabled) return { outcome: 'disabled' }
    if (isMuted?.(chatIdOf(cfg))) return { outcome: 'muted' }
    if (memoryOf()?.dislikes?.(cfg.ownerQQ)) return { outcome: 'disliked' }
    if (!cfg.ownerQQ) return { outcome: 'no-owner' }
    const state = loadState(config)
    return runOnce({ reason, config, state, force: true })
  }

  /** 同步返回（host.js:401 / 概览页依赖），至少含 count。 */
  function state() {
    const s = readJson(stateFile(), null)
    const normalized = normalizePurposeState(s)
    return {
      count: normalized.countToday,
      countToday: normalized.countToday,
      day: normalized.day,
      nextFireAt: normalized.nextFireAt,
      lastOutcome: normalized.lastOutcome,
      lastPurpose: normalized.lastPurpose,
    }
  }

  /** 面板摘要（不含提示词全文）。 */
  function status() {
    const config = purposeConfig(getConfig())
    return summarizePurposeState(loadState(config), { config })
  }

  /** 零副作用预览：真收素材、真拼提示词，但不写状态、不生成、不投递。 */
  async function preview() {
    const cfg = getConfig()
    const config = purposeConfig(cfg)
    const now = Date.now()
    const state = structuredClone(loadState(config, now))
    const ctx = await prepare(cfg, config, state, now)
    const lastMasterAt = ctx.lastMasterAt
    const picked = selectPurpose({
      seeds: ctx.seeds, goals: ctx.goals, pending: state.pending, history: state.history,
      config, drives: ctx.drives, now, lastMasterAt,
    })
    const prompt = picked.purpose ? promptFor(cfg, config, picked.purpose, { ...ctx, candidates: picked.candidates }, state, now) : ''
    return {
      stats: ctx.materials.stats,
      materials: ctx.materials.items.map((m) => ({ kind: m.kind, source: m.source, who: m.who, text: m.text, scoredEmotion: m.scoredEmotion || '' })),
      drives: ctx.drives,
      goals: ctx.goals.slice(0, 5).map((g) => ({ owner: g.owner, domain: g.domain, intent: g.intent, confidence: g.confidence, risk: g.risk, status: g.status })),
      candidates: picked.candidates.map((c) => ({ owner: c.goalOwner, need: c.need, action: c.action, text: c.text, confidence: c.confidence, risk: c.risk })),
      selected: picked.purpose && { text: picked.purpose.text, need: picked.purpose.need, action: pAction(picked.purpose), owner: picked.purpose.goalOwner, confidence: picked.purpose.confidence },
      prompt,
    }
  }
  const pAction = (p) => p.action || ''

  /** 每轮系统提示词里的驱动提示（零风险的提示层对接：只影响语气倾向，不改变工具与权限）。 */
  function drivesRule() {
    const cfg = getConfig()
    if (cfg.enabled === false) return ''
    if (!((cfg.ext && cfg.ext.purpose) || {}).enabled) return '' // 引擎没开就不往提示词里掺驱动
    const s = readJson(stateFile(), null)
    if (!s) return ''
    const drives = s.drives || {}
    const top = PURPOSE_NEEDS
      .map((need) => ({ need, label: NEED_LABELS[need] || need, score: Number(drives[need]) || 0 }))
      .filter((x) => x.score >= 0.35)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
    if (!top.length) return ''
    return `（你最近心里比较想要：${top.map((t) => t.label).join('、')}。它会自然影响你想聊什么，不用说出来。）`
  }

  return { tick, fire, state, status, preview, run: fire, drivesRule }
}
