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
          // 引擎自发发言走 §5.3 私有凭据（enginePolicy）：tickOne 已经用 evaluatePurposeTick
          // 做过全部排程/额度判定，投递时不再过模块包装层门闸——否则策略源账本与引擎账本
          // 双轨漂移（2026-11-04 实测：引擎到点开口反被策略账本旧排程以 cooldown 拦死）。
          // hub 的 enginePolicy 路径自己向策略源 reserve/commit（sent/failed/uncertain），
          // 同时仍照旧走总开关 / 试运行 / 禁言。
          const cred = friend ? null : engineCredential() // 朋友各有各的账本，仍走引擎自己直投
          // 不带 own:true：这条是别处（目的回合）发的，hub 只把「实际成功发出」的文本记进 saidElsewhere，
          // 主人在 QQ 私聊回复时补进她的上下文（#133 同款桥接；#211 review 后改为按真发出结果记）。
          const deliverOpts = { userText: MOOD_PREFIX }
          if (cred) { deliverOpts.enginePolicy = cred; deliverOpts.enginePolicyName = 'purpose' }
          const r = await hub.deliver(chatIdOf(cfg, friend), text, deliverOpts)
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

  // ---------- 代发决断（broker 档：模块经 api.proactive.submit 提交的内容先给引擎过目） ----------
  // 设计稿 §7「提交后由引擎全权决定」（feed 语义）：宿主投递器在发送前调用这里，
  // 引擎开一轮轻量「目的回合」：按当前目的/素材改写这句话，或选 [沉默] 不发。
  // 决断通过（有文本）→ 宿主走 hub.deliver 投递（自动落聊天流水 + saidElsewhere 桥接 + 心情链路）；
  // 决断沉默 / 引擎没开 / 生成出错 → 返回 false，宿主把条目按 dropped/failed 结算。
  // 注意这里不做额度预占：额度已经由 submit 过门闸时占掉了，决断只是内容把关。
  /**
   * 代发决断：返回 true = 按（可能改写后的）文本投递；false = 这条不发。
   * @param {{ to: string, text: string, moduleId?: string, itemId?: string }} input
   */
  async function brokerReview({ to, text, moduleId = '', itemId = '' } = {}) {
    const cfg = getConfig()
    const config = purposeConfig(cfg)
    // 引擎没开就不过目：保持「门闸已放行即直发」的兜底语义（决断是增强，不是新闸门）
    if (!config.enabled) return { ok: true, send: true, text, reviewed: false }
    const target = String(to || '')
    const ownerKey = chatIdOf(cfg)
    // 只对发往主人私聊的内容过目；别的接收人（白名单朋友等）各有各的额度，宿主直发
    if (target !== ownerKey) return { ok: true, send: true, text, reviewed: false }
    const srcModule = String(moduleId || '模块')
    const ownerName = cfg.ownerName || '主人'
    // ---- 审查上下文：人格 + 心情 + 相关记忆 + 人物档案 + 最近来往 ----
    // 刻意不给引擎排程/额度：代发审查不参考她自己的说话剩余时间。
    // 决断要「像不像她会说的话」，就必须让她看见自己是谁、现在什么心情、记着主人什么。
    const persona = (() => {
      try {
        const t = typeof personaText === 'function' ? String(personaText() || '').trim() : ''
        return t.slice(0, 1500)
      } catch { return '' }
    })()
    const moodLine = (() => {
      try {
        const m = moodOf()
        if (!m) return ''
        // contextLine 自带「你现在 X，因为 Y。这会影响你说话：Z」，比裸数字有用得多
        if (typeof m.contextLine === 'function') {
          const line = String(m.contextLine() || '').trim()
          if (line) return line
        }
        if (typeof m.state === 'function') {
          const st = m.state()
          if (st) return `（你现在心情 ${Number(st.value ?? 60)}/100（${st.label || ''}）${st.reason ? `，因为${st.reason}` : ''}。）`
        }
      } catch {}
      return ''
    })()
    // 相关记忆：按提交内容检索（不是随便抓最近五条），再由重要性补几条。
    //
    // 重要的顺序陷阱（2026-11-04 主人实测踩到）：
    // 浏览型模块（bili / douyin / tophub）的工作流是「先写记忆，再推送消息」，
    // 而代发决断发生在推送环节——此时读到的记忆，往往正是这条消息自己刚记下的草稿。
    // 如果把它当成「她之前已经跟主人讲过」，就会误判成「重复打扰」而沉默。
    // 所以这里必须区分「记下」与「说过」：记忆只说明她知道这件事，
    // 「有没有跟主人说过」一律以聊天流水为准（见下面的「你们最近聊过」与提示词规则）。
    const memLine = (() => {
      try {
        const mem = memoryOf()
        if (!mem) return ''
        const probe = String(text || '').slice(0, 200)
        const nowMs = Date.now()
        // 多路检索：原文 + 主人名字，命中合并去重（比单次检索更全）
        const queries = [probe]
        if (ownerName) queries.push(ownerName)
        const seen = new Set()
        const rows = []
        const push = (t, at, source) => {
          const s = String(t || '').trim()
          if (!s || seen.has(s)) return
          seen.add(s)
          rows.push({ text: s, at: Number(at) || 0, source: String(source || '') })
        }
        for (const q of queries) {
          try {
            if (typeof mem.recall !== 'function') break
            const hits = mem.recall(q, { limit: 8, about: '', where: '代发决断', shown: false, excludeAbout: '' }) || []
            for (const h of hits) {
              const it = h?.it || h || {}
              push(it.text, it.at, it.source)
            }
          } catch {}
        }
        if (rows.length < 6) {
          // 补：记忆库里重要性高的事（约定、关系、核心喜好）
          const more = (mem.list?.('') || [])
            .filter((x) => x && x.text && !x.invalidAt && !['hearsay', 'guess'].includes(x.status))
            .sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0))
          for (const x of more) {
            if (rows.length >= 8) break
            push(x.text, x.at, x.source)
          }
        }
        const lines = rows.slice(0, 8).map((r) => {
          // 10 分钟内记下的标注「刚刚」：极可能是本条消息自己写进去的，不能当作「已经说过」
          const fresh = r.at > 0 && nowMs - r.at < 10 * 60 * 1000
          const when = fresh ? '（刚刚记下的，可能正是这条消息自己写的）' : ''
          return `· ${r.text.slice(0, 90)}${when}`
        })
        return lines.length ? `【她记得的事】\n${lines.join('\n')}` : ''
      } catch { return '' }
    })()
    // 人物档案 + 最近的私聊来往（判断「这条是不是已经说过了」「口吻对不对」）
    const profileLine = (() => {
      try {
        const mem = memoryOf()
        const p = mem?.personaPerson?.(ownerKey.slice('private:'.length))
        if (!p) return ''
        const parts = []
        if (p.alias) parts.push(`你平时叫 TA「${p.alias}」`)
        if (p.persona) parts.push(`TA 是${String(p.persona).slice(0, 60)}`)
        if (p.handle) parts.push(`你们的相处：${String(p.handle).slice(0, 60)}`)
        return parts.length ? `关于${ownerName}：${parts.join('；')}` : ''
      } catch { return '' }
    })()
    const recentLine = (() => {
      try {
        const days = hub.chatLogDays?.() || []
        const rows = []
        for (const day of days.slice(-1)) {
          for (const e of hub.chatLogOf?.(day) || []) {
            if (!e || e.forgottenAt) continue
            if (String(e.chatId) !== ownerKey) continue
            rows.push(e)
          }
        }
        const tail = rows.slice(-8)
        if (!tail.length) return ''
        // 顺便判断：主人私聊流水里，她最近有没有真的发过几乎一样的内容（这才是「说过了」的硬证据）
        const norm = (s) => String(s || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').slice(0, 120)
        const probe = norm(text)
        let repeated = null
        if (probe && probe.length >= 8) {
          const recentBot = rows.filter((e) => e.who === 'bot').slice(-30)
          for (const e of recentBot) {
            const t = norm(e.text)
            if (!t) continue
            // 用「前 12 字相同」或「重合字占比高」粗略判重，够用且不误伤
            const head = probe.slice(0, 12)
            if ((head.length >= 8 && t.includes(head)) || t.slice(0, 12) === probe.slice(0, 12)) { repeated = e; break }
          }
        }
        const lines = tail.map((e) => `${e.who === 'bot' ? '你' : ownerName}：${String(e.text || '').replace(/\n/g, ' ').slice(0, 50)}`)
        const dupNote = repeated
          ? `\n（注意：你最近已经发过很像的话：「${String(repeated.text || '').replace(/\n/g, ' ').slice(0, 60)}」——这条如果再发就是重复打扰。）`
          : '\n（你在私聊里最近没发过几乎一样的内容。）'
        return `你们最近聊过（越靠后越新）：\n${lines.join('\n')}${dupNote}`
      } catch { return '' }
    })()
    const prompt = [
      `【系统提醒，不是${ownerName}说的话】模块「${srcModule}」想以你的名义私聊${ownerName}一条消息，原文如下：`,
      '━━━━━━━━━━━━',
      String(text || '').slice(0, 800),
      '━━━━━━━━━━━━',
      persona ? `【你是谁】\n${persona}\n` : '',
      moodLine ? `【你现在的心情】\n${moodLine}\n` : '',
      profileLine ? `【${ownerName}在你眼里】\n${profileLine}\n` : '',
      memLine ? `${memLine}\n` : '',
      recentLine ? `【${recentLine}】\n` : '',
      `你要决定的是：这条消息要不要以你的名义发给${ownerName}，发的话用什么口吻。`,
      '- 判断依据：像不像你说话、值不值得说、会不会让 TA 觉得烦或者误会（结合上面的人格、心情、记忆与最近聊天）。',
      '- 如果原文太生硬/太长/太书面/太像通知，就用你平时的口气改写；如果已经是你会说的话，就原样发。',
      '- 觉得没必要、时机不对、口吻不像你、容易引起误会，就不发。',
      '',
      '【重要：关于「是不是已经说过了」】',
      '- 「她记得的事」只说明你**知道**这件事，不等于你已经**讲过**给TA听。',
      '- 浏览模块（bili / 抖音 / 热榜等）的习惯是**先把看到的东西记进记忆，再推送消息**。',
      '  所以你看到「刚刚记下的」那条，很可能就是本条消息自己刚写进去的草稿，不是旧话重提。',
      '- 判断「这条已经讲过了」，只以【你们最近聊过】里**实际发出去的消息**为准：',
      '  那段里如果已经有几乎一样的话发给了TA，才算重复，才不发；记在记忆里但没出现在聊天里的，照发。',
      '',
      `（另：这与你自己的主动搭话计划无关，不影响你下次什么时候找${ownerName}，也不占你的说话次数。）`,
      '输出规则（只输出下面三种之一，不要解释）：',
      '· 原样发：只输出 原样',
      `· 改写后发：直接输出改写后的那句话（会原文转发给${ownerName}，不要加引号或前缀）`,
      `· 不发：只输出 ${SILENCE}`,
    ].filter(Boolean).join('\n')
    try {
      log.info?.(`目的（代发决断）：模块「${srcModule}」提交了「${String(text || '').slice(0, 30)}」`)
      // 工作区固定一条会话窗口（不带 key → chatId 恒为 system:purpose-broker）：
      // 每次代发决断都在这里留下一轮「提交内容 → 她怎么决断」的记录，供主人在 DSH 里翻看。
      // 不按 moduleId/itemId 分会话，否则每来一个模块就灌一条碎会话进工作区。
      // 标题按主人定的名字：目的引擎（代发决断）。不带「QQ · 」前缀，titleFor 统一拼。
      // 仍 noTools：memory 模块的工具对 system 会话本就返回空（memory/index.js L35），
      // 开了也查不到记忆，反而会挂上别的 QQ 工具；上下文已在上面注入足够的人格/心情/记忆。
      const raw = await hub.runSystemTurn('purpose-broker', '目的引擎（代发决断）', prompt, { timeoutMs: 120000, noTools: true })
      const verdict = String(raw ?? '').trim()
      const cleaned = cleanReply(verdict, { warn: (message) => log.warn?.(`目的：${message}`) })
      // 原样代发 / 沉默 / 改写后的文本
      if (!cleaned || cleaned.replace(/\s/g, '').startsWith(SILENCE)) {
        log.info?.(`目的（代发决断）：模块「${srcModule}」这条决定不发`)
        return { ok: true, send: false, reviewed: true }
      }
      const finalText = /^原样$/.test(cleaned.trim()) ? String(text || '') : cleaned
      log.info?.(`目的（代发决断）：模块「${srcModule}」这条${finalText === String(text || '') ? '原样代发' : '改写后发'}`)
      return { ok: true, send: true, text: finalText, reviewed: true }
    } catch (error) {
      // 决断回合出错不能把门闸已放行的消息卡死：按原文放行（与门闸故障放行同一口径）
      log.warn?.('目的（代发决断）出错，按原文放行：', error?.message)
      return { ok: true, send: true, text: String(text || ''), reviewed: false }
    }
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
  /**
   * 引擎自发发言的 §5.3 私有凭据：deliver 的 enginePolicy 路径会直接向这个策略源对象
   * reserve（走策略源账本：安静时段/额度/在途串行，不再有第二本排程），结算由 hub 按
   * 真实发送结果 commit。宿主装配策略源后经 setEnginePolicySource 注入；没注入时
   * enginePolicy=null → deliver 走旧路径直投（与改造前行为一致）。
   */
  let enginePolicySource = null
  function setEnginePolicySource(p) { enginePolicySource = p || null }
  function engineCredential() { return enginePolicySource }

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

  return { tick, fire, state, status, preview, run: fire, drivesRule, brokerReview, setEnginePolicySource }
}
