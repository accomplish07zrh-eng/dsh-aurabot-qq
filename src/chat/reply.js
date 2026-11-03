// 把模型的一轮回复拆成要发到 QQ 的「一条条消息」。
//
// 模型输出约定（写在人格卡里）：
//   - `|||` 分隔多条气泡
//   - `<voice>…</voice>` 包住的内容发成语音
//   - `<sticker:标签>` 发一张表情（可写 `<sticker:标签></sticker>`）
//   - `<poke>` = 戳一戳对方
//   - `<reply:编号>` 写在某句前面 = 这句以「引用回复」发出（群聊里引用提示词中带编号的那条消息）
//   - 整轮只输出 `[沉默]`（或空）= 这次不说话（群聊插话用）
// 另外顺手把模型偶尔漏出来的 Markdown 洗掉——QQ 不渲染 Markdown。

import { currentPromptSources, promptFingerprint, promptTextRanges } from '../security/leak-guard.js'

export const SILENCE = '[沉默]'

/** 去掉 Markdown 痕迹，保留文字本身。 */
export function stripMarkdown(text) {
  return String(text || '')
    .replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 $2')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 是不是「这次不说话」。 */
export function isSilence(text) {
  const t = String(text || '').trim()
  return t === '' || t === SILENCE || t === '［沉默］' || t === '(沉默)' || t === '（沉默）'
}

/** 只识别工具协议标签；普通的 <、|、HTML 和聊天控制标签不在这里处理。 */
function toolTag(token) {
  let body = token.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).slice(1).replace(/>$/, '').trim()
  const closing = /^\//.test(body)
  body = body.replace(/^\/\s*/, '')
  const dsml = /^(?:[|｜]\s*)+d\s*s\s*m\s*l(?=\s|[|｜]|$)\s*(?:[|｜]\s*)*/i.exec(body)
  const antml = /^antml\s*:\s*/i.exec(body)
  if (dsml || antml) body = body.slice((dsml || antml)[0].length)
  const boundary = /^[|｜]+(tool(?:[▁_]*(?:calls?|outputs?|section))*)[▁_]*(begin|end)[|｜]+$/i.exec(body.replace(/\s/g, ''))
  if (boundary) return { key: boundary[1].toLowerCase().replace(/[▁_]/g, ''), closing: boundary[2].toLowerCase() === 'end' }
  if (/^[|]+tool[▁_]*sep[|]+$/i.test(body.replace(/\s/g, ''))) return { key: 'toolsep', closing: true }
  const name = /^(function[\s_:-]*calls?|tool[\s_:-]*(?:calls?|use)|invoke|calls?|parameters?|prompt)(?=\s|\/|$)/i.exec(body)
  if (!name && !dsml && !antml) return null
  return { key: name ? name[1].toLowerCase().replace(/[\s_:-]/g, '') : 'protocol:' + body.toLowerCase(), closing }
}

/** 成对调用连同参数一起去掉；孤立开/闭标签、缺少 > 的尾片只去标记，保留旁边的正常话。 */
function toolTextRanges(raw) {
  const ranges = [], stack = []
  for (const match of raw.matchAll(/[<＜][^<>＜＞]*(?:[>＞]|(?=[<＜])|$)/g)) {
    const tag = toolTag(match[0])
    if (!tag) continue
    const range = { start: match.index, end: match.index + match[0].length }
    ranges.push(range)
    if (tag.closing) {
      const i = stack.findLastIndex((open) => open.key === tag.key)
      if (i !== -1) {
        ranges.push({ start: stack[i].start, end: range.end })
        stack.splice(i)
      }
    } else if (/[>＞]$/.test(match[0]) && !/[\/／]\s*[>＞]$/.test(match[0])) {
      stack.push({ key: tag.key, start: range.start })
    }
  }
  // 按 JSON 的括号和字符串边界取完整对象，嵌套参数、字符串参数和转义引号都能处理。
  const toolName = (name) => typeof name === 'string' && /^[a-z][a-z0-9_.:-]*$/i.test(name)
  const isCall = (v) => v && typeof v === 'object' && !Array.isArray(v) && (
    (toolName(v.name) && Object.hasOwn(v, 'arguments') && Object.keys(v).every((k) => ['name', 'arguments', 'id', 'type'].includes(k))) ||
    (v.type === 'tool_use' && toolName(v.name) && Object.hasOwn(v, 'input')) ||
    (v.type === 'function' && isCall(v.function)) || isCall(v.function_call) ||
    (v.functionCall && toolName(v.functionCall.name) && Object.hasOwn(v.functionCall, 'args')) ||
    (Array.isArray(v.tool_calls) && v.tool_calls.length && v.tool_calls.every(isCall)))
  for (let start = 0; start < raw.length; start++) {
    if (!['{', '['].includes(raw[start])) continue
    const stack = [], begin = start
    let quoted = false, escaped = false
    for (let i = start; i < raw.length; i++) {
      const c = raw[i]
      if (quoted) {
        if (escaped) escaped = false
        else if (c === '\\') escaped = true
        else if (c === '"') quoted = false
        continue
      }
      if (c === '"') quoted = true
      else if (c === '{' || c === '[') stack.push(c)
      else if (c === '}' || c === ']') {
        if (stack.pop() !== (c === '}' ? '{' : '[')) break
        if (!stack.length) {
          try {
            const v = JSON.parse(raw.slice(begin, i + 1))
            if (isCall(v) || (Array.isArray(v) && v.length && v.every(isCall))) {
              ranges.push({ start: begin, end: i + 1 })
              start = i
            }
          } catch (error) {}
          break
        }
      }
    }
  }
  // 只拦整段都是「调用工具 xxx(参数)」的输出，讨论工具的正常句子保留。
  const invocation = stripMarkdown(raw)
    .replace(/<\/?(?:voice|reply|at)\b[^>]*>/gi, '').replace(/\|\|\|/g, '').trim()
    .replace(/^[「“"']+|[」”"']+$/g, '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  const call = /^调用工具\s*[a-z][a-z0-9_.:-]*\s*\(/i.exec(invocation)
  if (call) {
    let depth = 1, quote = '', escaped = false
    for (let i = call[0].length; i < invocation.length; i++) {
      const c = invocation[i]
      if (quote) {
        if (escaped) escaped = false
        else if (c === '\\') escaped = true
        else if (c === quote) quote = ''
      } else if (c === '"' || c === "'") quote = c
      else if (c === '(') depth++
      else if (c === ')' && --depth === 0) {
        if (/^[。.!！]?$/.test(invocation.slice(i + 1).trim())) ranges.push({ start: 0, end: raw.length })
        break
      }
    }
  }
  for (const pattern of [
    /[<＜]\s*[\/／]?\s*[a-z][a-z0-9]*_[a-z0-9_]+["＂]?\s*[>＞]/gi,
  ]) {
    for (const match of raw.matchAll(pattern)) ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  // 删除只包着调用的代码围栏，避免 JSON 被删后留下 ```json 发出去。
  for (const m of raw.matchAll(/```[a-z0-9_-]*\s*\n?([\s\S]*?)```/gi)) {
    const start = m.index + m[0].indexOf(m[1])
    if (ranges.some((r) => r.start >= start && r.end <= start + m[1].length) && !withoutToolRanges(raw, ranges.sort((a, b) => a.start - b.start || b.end - a.end), start, start + m[1].length).trim()) ranges.push({ start: m.index, end: m.index + m[0].length })
  }
  return ranges.sort((a, b) => a.start - b.start || b.end - a.end)
}

function withoutToolRanges(raw, ranges, start = 0, end = raw.length) {
  let clean = '', last = start
  for (const range of ranges) {
    if (range.end <= last) continue
    if (range.start >= end) break
    if (range.start > last) clean += raw.slice(last, range.start)
    last = Math.min(end, range.end)
  }
  return clean + raw.slice(last, end)
}

export function stripToolText(text) {
  const raw = String(text || '')
  return withoutToolRanges(raw, toolTextRanges(raw))
}

function visibleContent(text) {
  const content = stripMarkdown(text)
    .replace(/<\/?(?:voice|reply|at|poke|sticker|face)\b[^>]*>/gi, '')
    .replace(/[@＠][^\s@＠<>|｜]+/g, '')
    .replace(/\|\|\|/g, '')
    .trim()
  return isSilence(content) ? '' : content.replace(/^[\s\p{P}]*|[\s\p{P}]*$/gu, '').trim()
}

/** 所有投递路径共用这一份清洗，区间也交给消息段出口使用。 */
export function cleanOutboundText(text, { warn, promptSources, fingerprint, userText, ownerPrivate = false, allowPromptEcho = false, onPromptDecision, onRanges } = {}) {
  const active = currentPromptSources()
  const sources = promptSources ?? [...(active?.system.values() || []), active?.context || '', ...(active?.memory || [])]
  const raw = String(text || '')
  const tools = toolTextRanges(raw)
  const toolClean = withoutToolRanges(raw, tools)
  const prompts = (allowPromptEcho ? [] : promptTextRanges(toolClean, fingerprint || promptFingerprint(sources, userText ?? active?.userText ?? '')))
    .sort((a, b) => a.start - b.start || b.end - a.end)
  const promptClean = withoutToolRanges(toolClean, prompts)
  // 主人问设定时保留带解释的完整回答，仅整条复读才拦。
  const removePrompts = prompts.length && (!ownerPrivate || isSilence(visibleContent(promptClean)))
  onPromptDecision?.(Boolean(ownerPrivate && prompts.length && !removePrompts))
  let ranges = tools
  if (removePrompts) {
    // 将工具清洗后的坐标映射回原消息，防止跨文字段或工具与复读混排时错删。
    const offsets = []
    let r = 0
    for (let i = 0; i < raw.length; i++) {
      while (r < tools.length && tools[r].end <= i) r++
      if (r < tools.length && tools[r].start <= i) continue
      offsets.push(i)
    }
    ranges = [...tools, ...prompts.map((p) => ({ start: offsets[p.start], end: offsets[p.end - 1] + 1 }))]
      .sort((a, b) => a.start - b.start || b.end - a.end)
  }
  let clean = withoutToolRanges(raw, ranges)
  if (ranges.length && isSilence(visibleContent(clean))) {
    warn?.(removePrompts ? '模型输出整段都是提示词复读，已拦下并按沉默处理' : '模型输出整段都是工具调用文字，已拦下并按沉默处理')
    clean = ''
  }
  onRanges?.(ranges)
  return clean
}

/** 最终平台出口：合并检查整条消息的文字段，避免调用被拆段绕过；引用、@ 和媒体段原样保留。 */
export function cleanOutboundSegments(message, options) {
  const texts = message.filter((seg) => seg.type === 'text')
  if (!texts.length) return message
  const raw = texts.map((seg) => String(seg.data?.text || '')).join('')
  let ranges
  const clean = cleanOutboundText(raw, { ...options, onRanges: (value) => { ranges = value } })
  if (clean === raw) return message
  let offset = 0
  const result = message.flatMap((seg) => {
    if (seg.type !== 'text') return [seg]
    const start = offset
    offset += String(seg.data?.text || '').length
    const value = clean ? withoutToolRanges(raw, ranges, start, offset) : ''
    return value ? [{ ...seg, data: { ...seg.data, text: value } }] : []
  })
  // 只剩引用和 @ 不能单独发，尤其是自动 @ 后面只跟着一个结束标记时。
  return result.some((seg) => seg.type === 'text' ? seg.data.text.trim() : !['reply', 'at'].includes(seg.type)) ? result : []
}

/** 解析一轮回复；在拆气泡/语音前清洗，避免协议里的竖线被误作气泡分隔符。 */
export function parseReply(text, options) {
  const raw = cleanOutboundText(text, options).trim()
  if (isSilence(raw)) return { silent: true, items: [] }
  const items = []
  let replyTo = '' // 等着挂到下一条气泡上的「引用回复」编号
  const attach = (from) => {
    if (replyTo && items.length > from) {
      items[from].replyTo = replyTo
      replyTo = ''
    }
  }
  for (const bubble of raw.split('|||')) {
    const part = bubble.trim()
    if (!part) continue
    // 依次切出 reply / voice / sticker / markdown 图片，其余是文字
    const re = /<poke\s*\/?>|<reply:\s*(\d+)\s*>|<voice>([\s\S]*?)<\/voice>|<sticker:([^>]+?)>(?:\s*<\/sticker>)?|!\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g
    let last = 0
    let m
    while ((m = re.exec(part)) !== null) {
      let from = items.length
      pushText(items, part.slice(last, m.index))
      attach(from)
      from = items.length
      if (m[0].startsWith('<poke')) {
        if (!items.some((i) => i.kind === 'poke')) items.push({ kind: 'poke', value: '' })
      } else if (m[1] !== undefined) {
        replyTo = m[1]
      } else if (m[2] !== undefined) {
        const v = stripMarkdown(m[2])
        if (v) items.push({ kind: 'voice', value: v })
      } else if (m[3] !== undefined) {
        const v = m[3].trim()
        if (v) items.push({ kind: 'sticker', value: v })
      } else if (m[4] !== undefined) {
        items.push({ kind: 'image', value: m[4] })
      }
      attach(from)
      last = re.lastIndex
    }
    const from = items.length
    pushText(items, part.slice(last))
    attach(from)
  }
  // 一轮最多引用一次，多的去掉（大多数时候正常发就好）
  let quoted = false
  for (const it of items) {
    if (!it.replyTo) continue
    if (quoted) delete it.replyTo
    quoted = true
  }
  if (items.length === 0) return { silent: true, items: [] }
  return { silent: false, items: capBubbles(items) }
}

const MAX_BUBBLES = 5

/** 文字气泡最多 5 条，多出来的并进最后一条（防止刷屏）。 */
function capBubbles(items) {
  const texts = items.filter((i) => i.kind === 'text')
  if (texts.length <= MAX_BUBBLES) return items
  const keep = new Set(texts.slice(0, MAX_BUBBLES - 1))
  const tail = texts.slice(MAX_BUBBLES - 1)
  const merged = { kind: 'text', value: tail.map((t) => t.value).join('\n') }
  const out = []
  let placed = false
  for (const it of items) {
    if (it.kind !== 'text' || keep.has(it)) out.push(it)
    else if (!placed) { out.push(merged); placed = true }
  }
  return out
}

/**
 * 一段文字拆成几条气泡：真人打字是一行一条发出去的。
 * 有代码块、或者是长篇内容（比如帮主人查东西的结果）就整段发，不拆。
 */
export function splitLines(text) {
  const t = String(text || '').trim()
  if (!t) return []
  if (t.includes('```') || t.length > 240) return [t]
  const lines = t.split(/\n+/).map((s) => s.trim()).filter(Boolean)
  if (lines.length <= 1) return lines
  // 像列表 / 步骤的多行内容（一大半以数字或符号开头）也整段发
  const listy = lines.filter((l) => /^(\d+[.、)]|[-*•·])/.test(l)).length
  if (listy >= Math.ceil(lines.length / 2)) return [t]
  return lines
}

function pushText(items, s) {
  const t = stripMarkdown(String(s || '').replace(/<\/?reply[^>]*>/g, '')) // 写坏的引用标签直接去掉
  if (!t || isSilence(t)) return
  for (const line of splitLines(t)) if (!isSilence(line)) items.push({ kind: 'text', value: line })
}

/** 对方是不是明确要她发语音（「用语音说」「发个语音」「语音回我」……）。 */
export function wantsVoice(text) {
  const t = String(text || '')
  if (t.includes('不要语音') || t.includes('别发语音')) return false
  return /(用|发|来|给我|录)[^，。？！\n]{0,4}语音|语音[^，。？！\n]{0,4}(说|发|讲|回|念|唱)/.test(t)
}

/**
 * 发下一条之前停多久（毫秒）：按「打字速度」算——下一条越长停越久，再加一点随机抖动。
 * @param {string} [next] 下一条要发的内容
 */
export function bubbleDelay(next = '', rand = Math.random) {
  if (typeof next === 'function') { rand = next; next = '' }
  const len = String(next || '').length
  const typing = 350 + len * 110 // 大约每秒 9 个字
  return Math.round(Math.min(4500, Math.max(700, typing)) * (0.8 + rand() * 0.5))
}
