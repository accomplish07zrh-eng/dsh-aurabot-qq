// 内置模块：QQ 接口。SnowLuma 能做的事太多，不一个个写工具：一张权限表（actions.js）加两个工具，
// 工具定义短，不占提示词；她要用时先查再调。

import { defineTool, str } from '../../tools/tools.js'
import { QQ_API, paramsOf } from './actions.js'
import { clipText } from '../../core/text.js'
import { cleanOutboundText } from '../../chat/reply.js'

const RESULT_CHARS = 3000

// 会把内容/动作发到「目标」的接口：主人开口也不许发给白名单外的人/群，
// 否则模型被诱导就能把消息/转发/拍一拍/点赞发到任意 QQ（qq_send_message 的白名单在这里也得有）。
const OUT_USER_TARGET = new Set(['forward_friend_single_msg', 'send_private_forward_msg', 'send_forward_msg', 'send_custom_face', 'friend_poke', 'send_like', 'send_tuwen_ark', 'set_friend_remark', 'set_qzone_ban'])
const OUT_GROUP_TARGET = new Set(['forward_group_single_msg', 'send_group_forward_msg', 'send_forward_msg', 'send_custom_face', 'group_poke', 'send_tuwen_ark', 'set_group_remark', 'set_group_card', 'set_group_admin', 'set_group_kick_members', 'set_group_name', 'set_group_whole_ban'])

/** 目标是白名单外的人/群就返回原因。 */
export function outboundRefusal({ action, params, cfg }) {
  const allowP = (cfg.allow?.private || []).map(String)
  const allowG = (cfg.allow?.groups || []).map(String)
  const uid = params.user_id ?? params.target_id
  if (OUT_USER_TARGET.has(action) && uid !== undefined && uid !== null && uid !== '' && !allowP.includes(String(uid))) return '只能发给白名单里的好友'
  const gid = params.group_id
  if (OUT_GROUP_TARGET.has(action) && gid !== undefined && gid !== null && gid !== '' && !allowG.includes(String(gid))) return '只能发给白名单里的群'
  return ''
}

/** 这一轮能不能调这个接口，不能就返回原因。 */
export function refusal({ action, params, cfg, owner, chat }) {
  const entry = QQ_API[action]
  if (!entry) return '这个接口不开放'
  for (const p of paramsOf(action)) if (p.required && (params[p.name] === undefined || params[p.name] === '')) return `缺参数 ${p.name}`
  if (owner) {
    if (entry[0] === 'owner' && (cfg.dryRun || !cfg.enabled)) return '现在是试运行，不真的执行'
    const out = outboundRefusal({ action, params, cfg })
    if (out) return out
    return ''
  }
  if (entry[0] !== 'open') return '这个只有主人开口才能用'
  if (action !== 'translate_en2zh' && (chat.kind !== 'group' || String(params.group_id) !== String(chat.groupId))) return '只能查当前这个群'
  return ''
}

/**
 * 会显示到对方界面上的文本参数：原始 OneBot 动作（转发、AI 语音、Ark 卡片、群名片等）也要过出站清洗。
 * 否则模型被诱导时可以把工具标记/提示词复读原样塞进转发内容或卡片标题，绕过 QQ 投递路径的清洗。
 */
export const TEXT_PARAM_FIELDS = {
  send_forward_msg: ['messages', 'message', 'source', 'summary', 'prompt', 'news'],
  send_group_forward_msg: ['messages', 'message', 'source', 'summary', 'prompt', 'news'],
  send_private_forward_msg: ['messages', 'message', 'source', 'summary', 'prompt', 'news'],
  send_group_ai_record: ['text'],
  get_ai_record: ['text'],
  send_tuwen_ark: ['title', 'desc', 'summary', 'preview_url', 'jump_url'],
  set_group_name: ['group_name'],
  set_friend_remark: ['remark'],
  set_group_card: ['card'],
  set_group_remark: ['remark'],
}

/** 递归清洗：字符串里是 JSON（转发消息常见）就先解析、清完再序列化；消息段只改内容和数据，不动 type。 */
function cleanParamValue (value, clean) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed)
        return JSON.stringify(cleanParamValue(parsed, clean))
      } catch (error) {}
    }
    return clean(value)
  }
  if (Array.isArray(value)) return value.map((item) => cleanParamValue(item, clean))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = key === 'type' ? item : cleanParamValue(item, clean)
    return out
  }
  return value
}

/**
 * 对会外显的文本参数做出站清洗。清洗后必填文本变空（整段都是工具调用/提示词复读）就拒绝这次调用。
 * @param {(text:string)=>string} cleanText 与 QQ 投递一致的清洗函数（hub.cleanOutbound）
 */
export function cleanOutboundParams (action, params, cleanText) {
  const fields = TEXT_PARAM_FIELDS[action]
  if (!fields || typeof cleanText !== 'function') return { ok: true, params, changed: false }
  const out = { ...params }
  let changed = false
  let emptied = false
  for (const field of fields) {
    if (!Object.hasOwn(params, field)) continue
    const before = params[field]
    const after = cleanParamValue(before, (text) => String(cleanText(String(text ?? '')) ?? ''))
    if (JSON.stringify(after) !== JSON.stringify(before)) changed = true
    if (typeof after === 'string' && !after.trim() && String(before ?? '').trim()) emptied = true
    out[field] = after
  }
  if (emptied) return { ok: false, message: '内容里有工具调用文字或提示词复读，已拦下' }
  return { ok: true, params: out, changed }
}

/** 只留表里写的参数，模型多写的不传给网关。 */
export function pickParams(action, params) {
  const out = {}
  for (const p of paramsOf(action)) if (params[p.name] !== undefined) out[p.name] = params[p.name]
  return out
}

export default {
  id: 'qq-api',
  name: 'QQ 接口',
  version: '1.0.0',
  description: '把 SnowLuma 的 QQ 能力交给她：查群公告、精华、荣誉、群文件，主人开口时还能撤回、设精华、改群名片等（qq_api_find / qq_api_call）',
  api: 1,
  setup(api) {
    const { hub, onebot } = api.core
    api.tool(({ chat, level, sessionId }) => {
      if (chat.kind === 'system' || api.config().qqApi?.enabled === false) return []
      const isOwner = () => level === 'full' || Boolean(hub.turnSendersAllOwner?.(sessionId))
      return [
        defineTool({
          name: 'qq_api_find',
          description: '查 QQ 能做的事。用关键词找接口（比如 精华、公告、撤回、荣誉、群文件），返回接口名、参数和说明。',
          properties: { keyword: str('关键词，中文或接口名的一部分') },
          required: ['keyword'],
          execute: async ({ keyword }) => {
            const key = String(keyword || '').trim()
            const hits = Object.entries(QQ_API).filter(([name, e]) => (isOwner() || e[0] === 'open') && (name.includes(key) || e[2].includes(key))).slice(0, 12)
            if (!hits.length) return { ok: true, message: '没找到，换个说法' }
            return { ok: true, message: hits.map(([name, e]) => `${name}(${e[1]})：${e[2]}`).join('\n') }
          },
          render: (_args, value) => [{ type: 'text', text: value?.message || '' }],
        }),
        defineTool({
          name: 'qq_api_call',
          description: '调用 QQ 接口。先用 qq_api_find 查到接口名和参数。param 是 JSON 对象文字，比如 {"group_id":123456}。',
          properties: { action: str('接口名'), param: str('参数，JSON 对象文字') },
          required: ['action'],
          execute: async ({ action, param }) => {
            let params = {}
            try { params = JSON.parse(param || '{}') } catch (error) { return { ok: false, message: 'param 不是合法的 JSON' } }
            if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, message: 'param 要是 JSON 对象' }
            const name = String(action || '')
            const no = refusal({ action: name, params, cfg: api.config(), owner: isOwner(), chat })
            if (no) return { ok: false, message: no }
            // 原始动作里的文本/转发/卡片参数也过出站清洗（和 QQ 投递同一套），别让工具文字走旁路露出。
            const clean = typeof hub.cleanOutbound === 'function'
              ? (text) => hub.cleanOutbound(chat.chatId, text)
              : (text) => cleanOutboundText(text, { ownerPrivate: chat.chatId === `private:${api.config().ownerQQ}` })
            const cleaned = cleanOutboundParams(name, pickParams(name, params), clean)
            if (!cleaned.ok) return { ok: false, message: cleaned.message }
            if (cleaned.changed) api.log.info(`qq_api：${chat.chatId} 调用 ${name} 前清洗了外显文本`)
            api.log.info(`qq_api：${chat.chatId} 调用 ${name}`)
            const data = await onebot.call(name, cleaned.params, { timeoutMs: 15000, retries: 0 })
            return { ok: true, message: clipText(JSON.stringify(data ?? null), RESULT_CHARS) }
          },
          render: (_args, value) => [{ type: 'text', text: value?.message || '' }],
        }),
      ]
    })
    api.rule((kind, cfg) => (cfg.qqApi?.enabled === false ? [] : [kind === 'social'
      ? '- 群公告、精华、荣誉、群文件这些，用 qq_api_find 查接口再用 qq_api_call 调；别人只能查当前这个群。'
      : '- QQ 上想做的事（撤回、设精华、改群名片、点赞、表情回应、查群公告等）没有专门工具时，用 qq_api_find 查接口再用 qq_api_call 调。'].filter(Boolean)))
  },
}
