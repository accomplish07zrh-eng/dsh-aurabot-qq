// 直接问一次宿主模型（不进会话）：给表情起备注、心情判断、记忆提炼等后台小任务用。

import { randomUUID } from 'node:crypto'
import { cleanText } from './text.js'

export function defaultModel(dsh, cfg) {
  if (cfg?.model?.provider && cfg?.model?.model) return { provider: cfg.model.provider, model: cfg.model.model }
  try {
    const svc = dsh.get('agentDefaultModel')
    const sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : null
    if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
  } catch (error) {}
  return null
}

// ---------- 视觉能力 ----------
//
// 模型能不能看图写在 DSH 的模型元数据里（inputModalities，DSH 自己的图片入口也靠它判断）。
// 三态：true = 明确声明支持；false = 明确声明不支持；null = 宿主没说清楚（按现状照发，别乱降级）。
// 明确不支持时还硬塞图片块，整轮请求会被模型拒掉 —— 她就一个字都回不了。

const VISION_TTL = 10 * 60_000
const visionCache = new Map() // `provider::model` → { at, value }

export function clearVisionCache () {
  visionCache.clear()
}

/** 这个模型能看图吗。null = 不知道。 */
export async function modelVision (dsh, provider, model) {
  const key = `${provider}::${model}`
  const hit = visionCache.get(key)
  if (hit && Date.now() - hit.at < VISION_TTL) return hit.value
  let value = null
  try {
    const llm = dsh.llm || dsh.get('llm')
    if (llm && typeof llm.resolveModelInfo === 'function') {
      const info = await llm.resolveModelInfo(provider, model)
      const mods = info && info.inputModalities
      if (Array.isArray(mods)) value = mods.includes('image')
    }
  } catch (error) {}
  visionCache.set(key, { at: Date.now(), value })
  return value
}

/**
 * 当前设置里的模型能看图吗。面板上「视觉能力」可以手动声明，覆盖元数据。null = 不知道。
 * target 传了就只看这个模型（表情起名可以单独挑模型，主人对聊天模型的手动声明不该管到它）。
 */
export async function canSeeImages (dsh, cfg, target) {
  if (!(target && target.provider && target.model)) {
    const v = cfg && cfg.model && cfg.model.vision
    if (v === 'on') return true
    if (v === 'off') return false
  }
  const t = target && target.provider && target.model ? target : defaultModel(dsh, cfg)
  if (!t) return null
  return modelVision(dsh, t.provider, t.model)
}

/**
 * 面板上单独选的「识图模型」：{ provider, model } 两个都填了才算；null = 跟着聊天模型。
 * 配了它以后，所有「把图片交给模型看」的地方都改交给它，聊天模型只拿文字描述。
 */
export function visionModelOf (cfg) {
  const v = cfg && cfg.model && cfg.model.visionModel
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const provider = typeof v.provider === 'string' ? v.provider.trim() : ''
  const model = typeof v.model === 'string' ? v.model.trim() : ''
  return provider && model ? { provider, model } : null
}

/** 这次「看图」到底有没有模型可用：配了识图模型就一定算能看，否则看聊天模型自己行不行。 */
export async function canUnderstandImages (dsh, cfg) {
  if (visionModelOf(cfg)) return true
  return canSeeImages(dsh, cfg)
}

// ---------- 思考强度 ----------
//
// 不是所有模型都支持「思考强度」：DSH 里没有推理元数据的模型（本地 Ollama 的那几个、一些手写的
// provider）只要收到 reasoningEffort 就整轮报错 UNSUPPORTED_REASONING_EFFORT。所以传之前先问
// DSH 这个模型支持哪几档，不支持就干脆不传这个参数。

const REASONING_TTL = 10 * 60_000
const reasoningCache = new Map() // `provider::model` → { at, value }

// 部分 OpenAI 兼容模型不接受 temperature（例如推理模型直接报 Unsupported parameter）。
// 只记录「明确被拒过」的模型；没被拒过的模型仍照常带默认温度，不改变原行为。
const temperatureCache = new Map() // `provider::model` → { at }

export function clearReasoningCache () {
  reasoningCache.clear()
  temperatureCache.clear()
}

function cacheReasoning (provider, model, value) {
  reasoningCache.set(`${provider}::${model}`, { at: Date.now(), value })
}

function temperatureUnsupported (provider, model) {
  const hit = temperatureCache.get(`${provider}::${model}`)
  if (!hit) return false
  if (Date.now() - hit.at > REASONING_TTL) {
    temperatureCache.delete(`${provider}::${model}`)
    return false
  }
  return true
}

/**
 * 这个模型支持哪些思考强度。
 * @returns {Promise<{efforts:string[], default?:string}|null>} 不支持（没有推理元数据）返回 null
 */
export async function modelReasoning (dsh, provider, model) {
  const key = `${provider}::${model}`
  const hit = reasoningCache.get(key)
  if (hit && Date.now() - hit.at < REASONING_TTL) return hit.value
  let value = null
  try {
    const llm = dsh.llm || dsh.get('llm')
    if (llm && typeof llm.resolveModelInfo === 'function') {
      const info = await llm.resolveModelInfo(provider, model)
      const r = info && info.reasoning
      if (r && Array.isArray(r.efforts) && r.efforts.length) {
        value = {
          efforts: r.efforts.map((e) => String(e && e.id ? e.id : e)).filter(Boolean),
          ...(r.defaultEffort ? { default: String(r.defaultEffort) } : {}),
        }
        if (!value.efforts.length) value = null
      }
    }
  } catch (error) {
    value = null // 查不到就当不支持：少传一个参数，总比整轮报错强
  }
  cacheReasoning(provider, model, value)
  return value
}

/** 把想要的档位收敛成这个模型真正支持的；给 '' / 不支持时返回 undefined（= 不传）。 */
export async function pickReasoningEffort (dsh, provider, model, want) {
  const llm = dsh.llm || dsh.get('llm')
  const canProbe = Boolean(llm && typeof llm.resolveModelInfo === 'function')
  const r = await modelReasoning(dsh, provider, model)
  if (!r) {
    // 宿主根本没有查询接口时（老版本 DSH）维持老行为：照传，由下方的「被拒就重试」兜底。
    // 有接口且查到「不支持」，才真的不传。
    if (!canProbe) return String(want || '') || undefined
    return undefined
  }
  const w = String(want || '')
  if (w && r.efforts.includes(w)) return w
  return r.default && r.efforts.includes(r.default) ? r.default : undefined
}

const isUnsupportedEffort = (error) => {
  const msg = String((error && (error.message || error.code)) || '')
  return /UNSUPPORTED_REASONING_EFFORT|does not support reasoning effort|reasoning effort/i.test(msg)
}

const isUnsupportedTemperature = (error) => {
  const msg = String((error && (error.message || error.code)) || '')
  return /unsupported parameter[^\n]*temperature|temperature[^\n]*(?:not supported|unsupported|does not support)/i.test(msg)
}

/** 最近一次模型一个字没写时流里有什么：排查「模型没返回内容」用。 */
let lastEmpty = ''
export const lastEmptyInfo = () => lastEmpty

async function runStream (llm, params) {
  let out = ''
  const types = {}
  let finish = ''
  for await (const chunk of llm.stream(params)) {
    if (!chunk) continue
    types[chunk.type] = (types[chunk.type] || 0) + 1
    if (chunk.type === 'finish') finish = JSON.stringify(chunk.reason || {}).slice(0, 120)
    if (chunk.type === 'text-delta') out += chunk.text
    if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
      const f = chunk.reason.failure || {}
      const error = new Error('模型报错：' + (f.message || f.code || '未知'))
      if (f.code) error.code = f.code
      throw error
    }
  }
  if (!out.trim()) lastEmpty = `结束原因 ${finish || '无'}，数据块 ${JSON.stringify(types)}`
  return out.trim()
}

/**
 * @param {object} dsh 宿主 ctx
 * @param {{system:string, text:string, images?:Array<{data:string, mediaType:string}>, maxTokens?:number, temperature?:number, reasoningEffort?:string, cfg?:object, model?:{provider:string, model:string}}} o
 * @returns {Promise<string>}
 */
export async function askModel (dsh, o) {
  const llm = dsh.llm || dsh.get('llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有 llm 服务')
  // o.model 指定了就用它（后台小任务可以单独挑便宜 / 能看图的模型），否则：
  // 带图的后台任务（表情起名、头像、B 站抽帧……）优先交给面板上选的识图模型 ——
  // 聊天模型可能是个便宜的纯文本模型，硬塞图片会让整轮请求被拒。
  const vision = o.images && o.images.length ? visionModelOf(o.cfg) : null
  const t = o.model && o.model.provider && o.model.model
    ? { provider: o.model.provider, model: o.model.model }
    : (vision || defaultModel(dsh, o.cfg))
  if (!t) throw new Error('拿不到默认模型')
  let content = [{ type: 'text', text: cleanText(o.text) }]
  for (const img of o.images || []) content.push({ type: 'image', data: img.data, mediaType: img.mediaType, name: 'aurabot-image' })
  // 图片要先交给 DSH 的附件服务登记成附件块，模型适配层只认附件
  if (content.length > 1) {
    const att = dsh.attachments || dsh.get('attachments')
    if (!att || typeof att.admitPromptContent !== 'function') throw new Error('宿主没有附件服务，看不了图')
    content = await att.admitPromptContent(content)
  }
  const messages = [{ role: 'user', id: randomUUID(), content, source: { kind: 'plugin', plugin: 'aurabot' } }]
  const base = {
    provider: t.provider,
    model: t.model,
    system: cleanText(o.system || ''),
    messages,
    maxTokens: o.maxTokens || 600,
  }
  // 温度参数的落点按上游 #249：默认温度放进每轮的 params，模型明确拒绝时再去掉重试。
  let temperature = o.temperature ?? 0.3
  // 识图模型跟随面板「思考强度」：和聊天模型用同一档；模型不支持时 pickReasoningEffort 会收敛或省略。
  const usingVision = Boolean(vision && (!o.model || (o.model.provider === vision.provider && o.model.model === vision.model)))
  const wantEffort = o.reasoningEffort !== undefined
    ? o.reasoningEffort
    : (usingVision ? (o.cfg?.model?.reasoningEffort || 'low') : 'low')
  let effort = await pickReasoningEffort(dsh, t.provider, t.model, wantEffort)
  let widened = false
  let temperatureTried = false
  for (let attempt = 0; ; attempt++) {
    const params = { ...base }
    if (temperature !== undefined && !temperatureUnsupported(t.provider, t.model)) params.temperature = temperature
    if (effort) params.reasoningEffort = effort
    try {
      const out = await runStream(llm, params)
      // 推理模型可能把输出预算全花在思考上，一个字没写：放宽预算再试一次
      if (out || widened) return out
      widened = true
      base.maxTokens = Math.max(base.maxTokens, Math.min(4000, base.maxTokens * 3))
    } catch (error) {
      // 能力探测没查到 / 模型临时不认：去掉思考强度再来一次
      if (!temperatureTried && temperature !== undefined && isUnsupportedTemperature(error)) {
        temperatureTried = true
        temperatureCache.set(`${t.provider}::${t.model}`, { at: Date.now() })
        temperature = undefined
        continue
      }
      if (attempt === 0 && effort && isUnsupportedEffort(error)) {
        cacheReasoning(t.provider, t.model, null)
        effort = undefined
        continue
      }
      throw error
    }
  }
}
