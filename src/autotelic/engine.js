// 自驱引擎 · 决策纯函数（P1，docs/AUTOTELIC-PLAN.md §3 P1）。
// 零 IO、可单测：素材打分 → 好奇判分 → 立项候选（reason 必填，防拍脑袋）。
//
// 「能复用的是判分与驱动，不是采集」（§3 P1.1）：这里复用 purpose/engine.js 的纯函数
// （collectMaterials / needAffinity / textSimilarity / isDuplicateText / extractTopic），
// 素材采集在 runtime.js 里自己写（purpose 的 conversations()/memoryRecords() 没导出）。

import { createHash } from 'node:crypto'
import {
  DEFAULT_PURPOSE_CONFIG,
  collectMaterials,
  isDuplicateText,
  needAffinity,
  textSimilarity,
  extractTopic,
} from '../purpose/engine.js'

/** 好奇分权重（可复算公式的全部参数；分数是给她看的参考，判断仍由任务状态机管）。 */
export const CURIOSITY_WEIGHTS = Object.freeze({
  affinity: 0.45, // 需要亲和：这条素材戳中她哪种内心需要
  novelty: 0.25, // 新鲜度：和最近立项过的方向有多不一样
  relevance: 0.2, // 归属权重：主人 > 自己 > 群友/媒体
  importance: 0.1, // 记忆重要度（聊天素材没有就 0）
})

const RELEVANCE = Object.freeze({ owner: 1, self: 0.8, member: 0.5, media: 0.5, thought: 0.6, memory: 0.7 })

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))

/**
 * 单条素材的好奇分（0~1，纯函数可复算）。
 * @param {object} material collectMaterials 产出的素材（含 needAffinity / importance / kind / text）
 * @param {object} o
 * @param {string[]} o.recentTitles 最近的任务方向（判新鲜度用）
 * @returns {{score:number, parts:{affinity,novelty,relevance,importance}, reason:string, topic:string}}
 */
export function curiosityOf(material, { recentTitles = [] } = {}) {
  const affinity = clamp01(Math.max(0, ...Object.values(material.needAffinity || { a: 0 })))
  // 新鲜度：跟最近的方向比相似度，全像 = 没新鲜劲；没历史 = 满新鲜
  const sims = recentTitles.map((t) => textSimilarity(String(t || ''), material.text))
  const novelty = recentTitles.length ? clamp01(1 - Math.max(0, ...sims)) : 1
  const relevance = clamp01(RELEVANCE[material.kind] ?? 0.5)
  const importance = clamp01((Number(material.importance) || 0) / 100)
  const w = CURIOSITY_WEIGHTS
  const score = clamp01(w.affinity * affinity + w.novelty * novelty + w.relevance * relevance + w.importance * importance)
  const need = Object.entries(material.needAffinity || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || ''
  const topic = extractTopic(material.text, material.title || '')
  const reason = [
    material.who ? `${material.who}说` : material.source === 'memory' ? '记忆里有' : '素材里',
    topic ? `「${topic}」` : '',
    need ? `戳中了「${need}」的需要` : '有点意思',
    `新鲜度 ${Math.round(novelty * 100)}%`,
  ].filter(Boolean).join('，')
  return { score, parts: { affinity, novelty, relevance, importance }, need, reason, topic }
}

/**
 * 好奇判分 → 立项候选（§3 P1.2）。零副作用：不改任何状态，也不落盘。
 * @param {object} o
 * @param {object[]} o.materials collectMaterials 的 items
 * @param {object[]} o.activeTasks 账本里进行中的任务（查重用）
 * @param {string[]} o.recentTitles 最近任务方向（含已完结，判新鲜度）
 * @param {number} o.minCuriosity 阈值（ext.autotelic.minCuriosity）
 * @param {number} o.maxCandidates 最多返回几个候选
 * @param {string[]} [o.screenCoolIds] 立项前预审否决过的素材 id（冷却期内不再反复送审，2026-11-05 少爷定）
 * @returns {{candidates:object[], rejected:object[], lastOutcome:string}}
 *   candidate = { title, reason, score, parts, todos:[{desc, level:'L0'}], sourceId }
 *   rejected  = { title, score, why }（面板要能看到分数与落选原因，验收场景 3）
 */
export function proposeTasks({ materials = [], activeTasks = [], recentTitles = [], coolSourceIds = [], screenCoolIds = [], minCuriosity = 0.55, maxCandidates = 3, now = Date.now() } = {}) {
  if (!Array.isArray(materials) || !materials.length) return { candidates: [], rejected: [], lastOutcome: 'skipped-no-material' }
  const scored = materials
    .map((m) => ({ m, c: curiosityOf(m, { recentTitles }) }))
    .sort((a, b) => b.c.score - a.c.score)
  const candidates = []
  const rejected = []
  const activeTitles = activeTasks.map((t) => String(t.title || ''))
  // 同源硬身份（2026-11-05 修「重复立项饿死引擎」）：标题是截断片段，相似度不稳定，sourceId 才可靠
  const activeSourceIds = new Set(activeTasks.map((t) => String(t.sourceId || '')).filter(Boolean))
  const coolSet = new Set(coolSourceIds.map(String))
  // 预审否决过的素材（2026-11-05 少爷定）：同一条不值得办的话，别每分钟反复送审烧模型。
  const screenSet = new Set(screenCoolIds.map(String))
  for (const { m, c } of scored) {
    const title = c.topic || String(m.text || '').slice(0, 40)
    if (!title || title.length < 2) { rejected.push({ title, score: c.score, why: '素材太短，立不出方向' }); continue }
    // 最小实义门槛（2026-11-05 修「『汪汪』也立项」，少爷真机反馈）：少于 6 字或纯标点/语气词的
    // 素材没有可挖的内容——关键词命中再高也只是「她冲你叫了一声」，不是一件事。
    const plain = String(m.text || '').replace(/[，。！？、~～！？.,!??\s汪汪嗯嗯哦噢诶啊呀哈哈嘻嘻]/g, '')
    if (plain.length < 6) { rejected.push({ title, score: c.score, why: `素材太短没有实义内容（去掉标点语气词只剩 ${plain.length} 字）` }); continue }
    // 和进行中的任务撞了 = 已经在办，不再立项（同方向只开一个坑；同源素材标题截断后会绕过相似度，这里按 sourceId 精确挡）
    if (activeTitles.some((t) => textSimilarity(t, title) > 0.6)) { rejected.push({ title, score: c.score, why: '已有进行中的任务在同方向' }); continue }
    const sid = String(m.id || '')
    if (sid && activeSourceIds.has(sid)) { rejected.push({ title, score: c.score, why: '同源素材已有进行中的任务' }); continue }
    if (sid && coolSet.has(sid)) { rejected.push({ title, score: c.score, why: '同源素材最近做过（冷却中），先换个方向' }); continue }
    if (sid && screenSet.has(sid)) { rejected.push({ title, score: c.score, why: '同源素材立项前预审已否决（不值得办），冷却中', sourceId: sid }); continue }
    if (candidates.some((x) => textSimilarity(x.title, title) > 0.6)) { rejected.push({ title, score: c.score, why: '和本轮别的候选重复' }); continue }
    if (c.score < minCuriosity) { rejected.push({ title, score: c.score, why: `好奇分 ${c.score.toFixed(2)} < 阈值 ${Number(minCuriosity).toFixed(2)}` }); continue }
    candidates.push({
      title,
      reason: c.reason, // reason 必填（§3 P1.6，防拍脑袋）
      score: Number(c.score.toFixed(3)),
      parts: c.parts,
      todos: buildTodos(title, c.need),
      sourceId: m.id || '',
    })
    if (candidates.length >= Math.max(1, maxCandidates)) break
  }
  return { candidates, rejected, lastOutcome: candidates.length ? 'proposed' : 'below-threshold' }
}

/**
 * 任务书（2026-11-05 三修，少爷真机反馈「一个兴趣处理三四次没必要」）：
 * 回归**单步**——她的做事回合已带工具（fs 只读 + autotelic_* 全家桶），一轮就能
 * 「弄明白 → 对照记忆 → 值得说就说 → 写进记忆」全做完。
 * 多步拆解是「她没工具」时代的遗产：现在每步一个完整回合 = 一个兴趣花三四次模型调用。
 */
export function buildTodos(title, need = '') {
  const tail = ['learn', 'create', 'identity', 'install'].includes(need)
    ? '③ 用 autotelic_note 把结论写进记忆（不可用则写 notes/）。'
    : '③ 可顺手用 autotelic_note 记结论。'
  return [{
    desc: [
      `弄明白「${title}」：一轮内办完。`,
      `查资料要克制：只检索**与本话题相关**的记忆，最多读 2~3 个相关文件，别翻全部历史笔记；`,
      `查不齐就按已有判断下结论。① 对照记忆判断站不站得住；② 值得说就调 autotelic_propose_say（别硬凑）；`,
      tail,
      `有工具，一轮办完，别拆多轮。`,
    ].join('\n'),
    level: 'L0',
  }]
}

/**
 * 便宜模型自评的结果怎么并进来（P1.2：可复算公式为主，模型只微调）。
 * @param {{i:number, curiosity:number}[]} arr 模型回包（解析后的数组）
 * @param {object[]} candidates proposeTasks 的候选
 * @returns {object[]} 并分后的候选（score = 0.6*公式 + 0.4*模型；模型没评到的保持原分）
 */
export function mergeModelScores(arr, candidates) {
  if (!Array.isArray(arr)) return candidates
  const byIndex = new Map(arr.map((x) => [Number(x?.i) || 0, clamp01(x?.curiosity)]))
  return candidates.map((c, idx) => {
    const model = byIndex.get(idx + 1)
    if (model == null || !Number.isFinite(model)) return c
    return { ...c, score: Number((0.6 * c.score + 0.4 * model).toFixed(3)), modelScore: model }
  })
}

/**
 * 【立项前预审】（2026-11-05 少爷定）——进待办之前先判「这事到底值不值得办」。
 * 真机实证：只靠工作间里她自己再自审一遍不可靠——立项后她看的是自己立的题，
 * 天然会给自己找理由（账本里「我刚安装dsh那天就有」的自审原话就是
 * 「这句是完整整句（主语/过去动作/dsh/时间锚），非寒暄，值得做」，于是放行了）。
 * 所以闸门挪到**进账本之前**，并且用「审查员」视角（不是提议者）来判。
 */
export function buildScreenPrompt(candidates = []) {
  return [
    '你是审查员，不是提议者。下面几条是自驱引擎想替她立的事——一旦立项，她就要花时间和算力去办。',
    '',
    '逐条判断：这到底值不值得她花时间亲手办？',
    '- 值得：有可查证的内容、能产出一条她自己的判断、跟主人或她自己的行为有关。',
    '- 不值得：寒暄、称呼、闲聊应答、撒娇、别人随口一句没有实义的话、',
    '  只关于「我们怎么说话 / 你叫什么」这类对话本身的评价、超短碎片、重复。',
    '- 拿不准就当不值得。宁可漏一件，也别让她去办一句废话。',
    '',
    '只输出 JSON 数组，不要解释：[{"i":1,"worth":true},{"i":2,"worth":false,"why":"只是一句闲聊应答"}]',
    '',
    ...candidates.map((c, i) => `${i + 1}. 「${c.title}」　立项理由：${c.reason || '（无）'}`),
  ].join('\n')
}

/** 预审回包解析：认 i + worth；解析不出来返回 null（调用方走本地兜底，不默认放行）。 */
export function parseScreenVerdicts(raw) {
  const text = String(raw || '')
  const m = text.match(/\[[\s\S]*\]/)
  if (!m) return null
  try {
    const arr = JSON.parse(m[0])
    if (!Array.isArray(arr)) return null
    return arr
      .map((x) => ({ i: Number(x?.i) || 0, worth: x?.worth === true, why: String(x?.why || '').slice(0, 160) }))
      .filter((x) => x.i > 0)
  } catch { return null }
}

/** 本地兜底（审查回合不可用 / 回包是垃圾时）：「嗯嗯好的」这类纯应答直接判不值得。 */
export function trivialWhy(text) {
  const t = String(text || '').trim()
  if (!t) return '空素材'
  const plain = t.replace(/[，。！？、~～.,!?\s]/g, '')
  if (plain.length < 6) return `去掉标点只剩 ${plain.length} 字，没有可办的内容`
  if (/^(嗯|哦|啊|哈|呵|好|是|对|行|在吗|晚安|早安|早上好|你好|谢谢|收到|拜拜|再见|么么|啾|汪|喵)/.test(t)) return '寒暄/应答，没有可办的内容'
  if (/^[^，。！？]{0,8}(吗|呢|吧)$/.test(t)) return '短问答，没有可办的内容'
  return ''
}

/** 素材文本指纹（2026-11-06 修「同一句闲聊每 6 小时重烧一个模型回合」）：
 *  否决冷却原来按 sourceId 记，但同一句话从聊天流水里再次采出来 id 带时间戳、**每条都不同**，
 *  群友复读 / 闲聊刷屏时每句都重新送审。改按**归一化文本**算指纹：同一句话（去掉标点、
 *  表情、空白后）48 小时内直接本地否掉，不调模型。 */
export function screenFingerprint(text) {
  const t = String(text || '')
    .replace(/<[^>]+>/g, '') // <face:…> 之类内联标记
    .replace(/[\p{P}\p{S}\p{C}\s]+/gu, '') // 标点/符号/空白全去掉
    .toLowerCase()
  if (!t) return ''
  return createHash('sha256').update(t).digest('hex').slice(0, 24)
}

/** 素材采集（§3 P1.1：照 purpose 的写法抄，放在 autotelic 里，不依赖未导出的 purpose 内部函数）。 */
export function gatherMaterials({ conversations = [], memoryRecords = [], now = Date.now(), roleName = '', ownerQQ = '' } = {}) {
  const r = collectMaterials({
    now,
    config: DEFAULT_PURPOSE_CONFIG,
    ownerUin: String(ownerQQ || ''),
    roleName: String(roleName || ''),
    conversations,
    biliEntries: [],
    memoryRecords,
  })
  return r.items || []
}

export { isDuplicateText, needAffinity, textSimilarity }
