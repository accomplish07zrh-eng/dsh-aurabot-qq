// 内置模块：基础 QQ 工具。翻聊天记录；主人私聊里还能让她主动给别人发消息、发文件。

import { defineTool, str, int } from '../../tools/tools.js'
import { parseMessageEvent } from '../../chat/inbound.js'

export default {
  id: 'qq-tools',
  name: '基础 QQ 工具',
  version: '1.0.0',
  description: '翻当前聊天的记录（qq_chat_history）；主人私聊里让她主动给白名单里的人和群发消息（qq_send_message）、把本机文件当文件发出去（qq_send_file）',
  setup(api) {
    const { hub, onebot } = api.core
    api.tool(({ chat, level }) => {
      if (chat.kind === 'system') return []
      const tools = [defineTool({
        name: 'qq_chat_history',
        description: '翻翻当前这个聊天之前的聊天记录（只读，最多 50 条）。想不起前面聊过什么、别人问「刚才谁说的」、要回顾一段对话时用。',
        properties: { count: int('要翻多少条，默认 20，最多 50') },
        execute: async ({ count }) => {
          const n = Math.max(1, Math.min(50, Number(count) || 20))
          const r = chat.kind === 'group'
            ? await onebot.call('get_group_msg_history', { group_id: Number(chat.groupId), count: n }, { timeoutMs: 15000 })
            : await onebot.call('get_friend_msg_history', { user_id: Number(chat.userId), count: n }, { timeoutMs: 15000 })
          const msgs = (r?.messages || []).slice(-n)
          if (!msgs.length) return { ok: true, message: '没翻到聊天记录' }
          const self = String(api.config().botQQ)
          const lines = msgs.map((m) => {
            const p = parseMessageEvent({ ...m, message_type: m.message_type || (chat.kind === 'group' ? 'group' : 'private') }, self)
            const who = String(m.user_id ?? m.sender?.user_id) === self ? '你' : (m.sender?.card || m.sender?.nickname || String(m.user_id ?? ''))
            const t = m.time ? new Date(m.time * 1000).toTimeString().slice(0, 5) : ''
            return `${t} ${who}：${(p.text || '（图片/表情）').slice(0, 150)}`
          })
          return { ok: true, message: lines.join('\n') }
        },
      })]
      // 跨天搜聊天流水：只读。qq_chat_history 只能翻当前聊天最近 50 条，
      // 想找几天前说过的一句话没有入口，这里按关键词翻本地流水（按天存的那份）。
      tools.push(defineTool({
        name: 'qq_search_chatlog',
        description: '在本地聊天流水里按关键词跨天搜旧对话（只读）。记不清以前说过什么、对方提过的人名约定梗，先搜这个再答；想找「几天前那句话」时比 qq_chat_history 管用。',
        properties: {
          query: str('要搜的关键词，空格分隔表示每个词都要出现'),
          days: int('往回搜多少天，默认 30；0 表示全部'),
          chat: str('只看某个聊天，填 private:QQ号 或 group:群号；不填就是全部'),
        },
        required: ['query'],
        execute: async ({ query, days, chat: only }) => {
          const words = String(query || '').trim().split(/\s+/).filter(Boolean)
          if (!words.length) return { ok: false, message: '关键词是空的' }
          const all = hub.chatLogDays?.() || []
          const n = Number(days)
          const from = Number.isFinite(n) && n > 0 ? all.slice(-n) : all
          const hits = []
          for (const day of from) {
            for (const l of hub.chatLogOf?.(day) || []) {
              if (only && l.chatId !== only) continue
              const t = String(l.text || '')
              if (!words.every((w) => t.includes(w))) continue
              const hhmm = new Date(l.t).toTimeString().slice(0, 5)
              hits.push(`${day.slice(5)} ${hhmm} [${l.chatId}] ${l.who}：${t.slice(0, 120)}`)
            }
          }
          if (!hits.length) return { ok: true, message: `搜了 ${from.length} 天的流水，没找到「${words.join(' ')}」。` }
          const tail = hits.slice(-40)
          return { ok: true, message: `找到 ${hits.length} 条，最近 ${tail.length} 条：\n${tail.join('\n')}` }
        },
      }))
      // 发文件：只给主人私聊（full）挂，群里/别人没有本机文件能力；面板「聊天」页可以关掉
      if (level === 'full' && api.config().files?.enabled) tools.push(defineTool({
        name: 'qq_send_file',
        description: '把本机上的一个文件（文档、压缩包、音频、视频、安装包……）当文件发到 QQ。默认发到当前聊天；主人让你发给别的私聊或群时，target 写 private:QQ号 或 group:群号（只能发白名单里的人和群）。file 要写这台电脑上的绝对路径，而且必须在允许发送的目录里（QQ 工作区，或主人在面板里加的目录）；name 可选，是对方看到的文件名。',
        properties: {
          file: str('本机文件的绝对路径（必须在允许发送的目录里）'),
          name: str('对方看到的文件名，可不填'),
          target: str('可选。private:QQ号 或 group:群号；省略 = 当前聊天'),
        },
        required: ['file'],
        execute: async ({ file, name, target }) => {
          const cfg = api.config()
          let chatId = chat.chatId
          const t = String(target || '').trim()
          if (t) {
            const [kind, id] = t.split(':')
            const okList = kind === 'group' ? cfg.allow.groups : kind === 'private' ? [cfg.ownerQQ, ...cfg.allow.private] : []
            if (!okList.includes(String(id))) return { ok: false, message: '不在白名单里，不能发' }
            chatId = `${kind}:${id}`
          }
          const r = await hub.sendFile(chatId, String(file || ''), name ? String(name) : '')
          if (!r) return { ok: false, message: !cfg.enabled ? '总开关关着，没发' : cfg.dryRun ? '试运行，只记了日志，没真发' : '没发出去' }
          const label = String(name || '').trim() || String(file || '').split(/[\\/]/).pop()
          return { ok: true, message: `文件发出去了：${label}` }
        },
      }))

      if (level === 'full') tools.push(defineTool({
        name: 'qq_send_message',
        description: '主动给某个 QQ 好友或群发一条消息（不是回复当前聊天时用）。target 写 private:QQ号 或 group:群号；只能发给白名单里的人和群。',
        properties: { target: str('private:QQ号 或 group:群号'), text: str('要发的话，可以用 ||| 分多条、<voice>…</voice> 发语音、<sticker:名字> 发表情') },
        required: ['target', 'text'],
        execute: async ({ target, text }) => {
          const cfg = api.config()
          const [kind, id] = String(target || '').split(':')
          const okList = kind === 'group' ? cfg.allow.groups : kind === 'private' ? [cfg.ownerQQ, ...cfg.allow.private] : []
          if (!okList.includes(String(id))) return { ok: false, message: '不在白名单里，不能发' }
          const r = await hub.deliver(`${kind}:${id}`, String(text || ''))
          return r?.missedAt?.length ? { ok: true, message: `发出去了，但 ${r.missedAt.map((n) => '@' + n).join('、')} 没对上群里的人（群名片和昵称里没有），只是文字、对方收不到提醒。要真 @ 得写 <at:QQ号>，不知道就问主人要他的群名片或 QQ 号` } : { ok: true, message: '发出去了' }
        },
      }))
      return tools
    })
    return {}
  },
}
