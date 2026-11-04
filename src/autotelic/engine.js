// 自驱引擎 · 决策纯函数（P1，docs/AUTOTELIC-PLAN.md §3 P1）。
// 零 IO、可单测：素材打分 → 好奇判分 → 立项候选（reason 必填，防拍脑袋）。
//
// 「能复用的是判分与驱动，不是采集」（§3 P1.1）：这里复用 purpose/engine.js 的纯函数
// （collectMaterials / needAffinity / textSimilarity / isDuplicateText / extractTopic），
// 素材采集在 runtime.js 里自己写（purpose 的 conversations()/memoryRecords() 没导出）。

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
  return { score, parts: { affinity, novelty, relevance, importance }, reason, topic }
}

/**
 * 好奇判分 → 立项候选（§3 P1.2）。零副作用：不改任何状态，也不落盘。
 * @param {object} o
 * @param {object[]} o.materials collectMaterials 的 items
 * @param {object[]} o.activeTasks 账本里进行中的任务（查重用）
 * @param {string[]} o.recentTitles 最近任务方向（含已完结，判新鲜度）
 * @param {number} o.minCuriosity 阈值（ext.autotelic.minCuriosity）
 * @param {number} o.maxCandidates 最多返回几个候选
 * @returns {{candidates:object[], rejected:object[], lastOutcome:string}}
 *   candidate = { title, reason, score, parts, todos:[{desc, level:'L0'}], sourceId }
 *   rejected  = { title, score, why }（面板要能看到分数与落选原因，验收场景 3）
 */
export function proposeTasks({ materials = [], activeTasks = [], recentTitles = [], minCuriosity = 0.55, maxCandidates = 3, now = Date.now() } = {}) {
  if (!Array.isArray(materials) || !materials.length) return { candidates: [], rejected: [], lastOutcome: 'skipped-no-material' }
  const scored = materials
    .map((m) => ({ m, c: curiosityOf(m, { recentTitles }) }))
    .sort((a, b) => b.c.score - a.c.score)
  const candidates = []
  const rejected = []
  const activeTitles = activeTasks.map((t) => String(t.title || ''))
  for (const { m, c } of scored) {
    const title = c.topic || String(m.text || '').slice(0, 40)
    if (!title || title.length < 2) { rejected.push({ title, score: c.score, why: '素材太短，立不出方向' }); continue }
    // 和进行中的任务撞了 = 已经在办，不再立项（同一个方向只开一个坑）
    if (activeTitles.some((t) => textSimilarity(t, title) > 0.6)) { rejected.push({ title, score: c.score, why: '已有进行中的任务在同方向' }); continue }
    if (candidates.some((x) => textSimilarity(x.title, title) > 0.6)) { rejected.push({ title, score: c.score, why: '和本轮别的候选重复' }); continue }
    if (c.score < minCuriosity) { rejected.push({ title, score: c.score, why: `好奇分 ${c.score.toFixed(2)} < 阈值 ${Number(minCuriosity).toFixed(2)}` }); continue }
    candidates.push({
      title,
      reason: c.reason, // reason 必填（§3 P1.6，防拍脑袋）
      score: Number(c.score.toFixed(3)),
      parts: c.parts,
      todos: [{ desc: `只读了解「${title}」：查已有记忆与素材，写下一段判断`, level: 'L0' }],
      sourceId: m.id || '',
    })
    if (candidates.length >= Math.max(1, maxCandidates)) break
  }
  return { candidates, rejected, lastOutcome: candidates.length ? 'proposed' : 'below-threshold' }
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
