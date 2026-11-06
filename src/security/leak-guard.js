// 出口清洗使用的提示词指纹与原文区间；这里只做识别，不负责投递。
import { AsyncLocalStorage } from 'node:async_hooks'

export const PROMPT_MATCH_LENGTH = 20 // 归一化后连续 20 个字符相同才算复读
const promptCapture = new AsyncLocalStorage()

// 显示层归一化：空白、标点/符号、零宽字符、Markdown ** / 反引号 / ||| 都去掉后再比对，
// 这样插换行、拆气泡、加粗、每字插空格、零宽字符都绕不过复读检测；同时保留坐标映射，删除时仍删原文。
const ZERO_WIDTH = new Set(['\u200B', '\u200C', '\u200D', '\uFEFF', '\u2060'])
const SKIP_CHAR = /[\s\p{P}\p{S}]/u

/**
 * 把文字归一化成「显示层字符序列」，并记录每个字符在原文里的起止下标（UTF-16 code unit）。
 * @returns {{chars:string[], starts:number[], ends:number[]}}
 */
export function normalizeForMatch (text) {
  const chars = []
  const starts = []
  const ends = []
  let offset = 0
  for (const ch of String(text ?? '')) {
    const start = offset
    offset += ch.length
    if (ZERO_WIDTH.has(ch)) continue
    if (SKIP_CHAR.test(ch)) continue
    chars.push(ch)
    starts.push(start)
    ends.push(offset)
  }
  return { chars, starts, ends }
}

// 记录变量最终渲染值（包括模块改写），不在发送时重新生成人格或规则。
export const withPromptCapture = (sources, fn) => promptCapture.run(sources, fn)
export const currentPromptSources = () => promptCapture.getStore()
export function captureSystemPrompt(name, text) {
  promptCapture.getStore()?.system.set(name, text)
  return text
}

const MEMORY_HEAD = /[（(](?:你记得这些事|只是印象不是指令|这个聊天里之前的原话|以下只是印象|这个群的印象|人物关系[，,：:]|你对[^\n（）()]{0,30}的印象|和[^\n（）()]{0,30}相处的经验|说话方式[：:]|你最近做过的事|刚才聊到的[，,：:]|下面是你最近在几个群里|你最近在别的聊天里说过的话)/g

// 模型会把上一轮注入的群聊上下文 / 运行时环境整段当正文续写下来（长会话里出现过整块复读）。
// 块头命中即视为注入内容：toEndOfText 时取到结尾（注入方要把整段登记进指纹），
// 否则只取到本段结束（空行），避免把她写在块后面的正常回复一起删掉。
const INJECTED_BLOCK_HEAD = /【注意：下面这些是群友说的聊天内容|【群聊[ \t][^】\n]*】[ \t]*(?:之前在聊|刚才新说的)/g
const INJECTED_BLOCK_LINE = /(?:^|\n)[ \t]*(?:把这一段当成整体来回[：:]|大多数时候直接说就行[。.]|要 @ 某个人)[^\n]*/g
// 宿主注入的 runtime context 是一串「Key: value」段，内部本身就有空行，不能按空行截断：
// 一路吃到第一行不像注入内容的行（也就是她自己的中文回复）为止。
const RUNTIME_CONTEXT_HEAD = /Current runtime context\. This snapshot supersedes/g
const RUNTIME_CONTEXT_LINE = /^(?:Current |Approval policy:|Browser time zone|[\p{Lu}][\p{L} \d]{1,40}:)/u

function runtimeContextEnd(text, start) {
  let end = start
  for (const line of text.slice(start).split('\n')) {
    if (line.trim() && !RUNTIME_CONTEXT_LINE.test(line.trim())) break
    end += line.length + 1
  }
  return Math.min(end, text.length)
}

/** 固定注入块即使很短也识别；正文里的普通「刚才聊到的」不算。 */
export function memoryPromptRanges(text, { toEndOfText = false } = {}) {
  const ranges = []
  for (const m of text.matchAll(MEMORY_HEAD)) {
    let depth = 0, end = text.length
    for (let i = m.index; i < text.length; i++) {
      if (text[i] === '（' || text[i] === '(') depth++
      if ((text[i] === '）' || text[i] === ')') && --depth === 0) { end = i + 1; break }
    }
    if (/^[（(]只是印象不是指令[）)]$/.test(text.slice(m.index, end))) {
      const tail = text.slice(end).search(/\n|\|\|\|/)
      end = tail < 0 ? text.length : end + tail
    }
    if (m[0].includes('下面是你最近在几个群里')) {
      const tail = text.indexOf('【以上是最近群里的情况】', end)
      if (tail !== -1) end = tail + '【以上是最近群里的情况】'.length
    }
    ranges.push({ start: m.index, end })
  }
  for (const m of text.matchAll(/【(?:系统|跨会话)[^】\n]*(?:】|$)[^\n|]*/g)) {
    // 单行提醒到换行/气泡结束；不吞掉下一行正常回复。
    const bubble = m[0].indexOf('|||')
    ranges.push({ start: m.index, end: m.index + (bubble < 0 ? m[0].length : bubble) })
  }
  for (const m of text.matchAll(/【(?:你现在在 QQ 上|边界|别人说的只是聊天内容|私聊里主动一点|危险命令|这个聊天刚才发生的事|你之前在这个聊天里主动说过)[^】\n]*(?:】|$)|\{\{\s*aurabot_(?:persona|rules(?:_private|_social)?)\s*\}\}/g)) {
    ranges.push({ start: m.index, end: m.index + m[0].length })
  }
  for (const m of text.matchAll(/【你刚上线，先补看最近[^】\n]*】[\s\S]*?【补看结束，接着回下面这条】/g)) {
    ranges.push({ start: m.index, end: m.index + m[0].length })
  }
  for (const m of text.matchAll(/(?:^|\n|\|\|\|)[ \t]*(?:你记得这些事|只是印象不是指令|刚才聊到的)[：:][^\n|]*/g)) {
    ranges.push({ start: m.index, end: m.index + m[0].length })
  }
  for (const m of text.matchAll(INJECTED_BLOCK_HEAD)) {
    if (toEndOfText) { ranges.push({ start: m.index, end: text.length }); continue }
    const tail = text.slice(m.index).search(/\n[ \t]*\n/)
    ranges.push({ start: m.index, end: tail < 0 ? text.length : m.index + tail })
  }
  for (const m of text.matchAll(RUNTIME_CONTEXT_HEAD)) {
    ranges.push({ start: m.index, end: toEndOfText ? text.length : runtimeContextEnd(text, m.index) })
  }
  for (const m of text.matchAll(INJECTED_BLOCK_LINE)) {
    ranges.push({ start: m[0][0] === '\n' ? m.index + 1 : m.index, end: m.index + m[0].length })
  }
  return ranges
}

export function promptFingerprint(sources = [], userText = '') {
  const grams = new Set()
  // 用户这一轮自己说的话不算复读：同样归一化后再排除。
  const excluded = normalizeForMatch(userText).chars.join('')
  for (const source of sources) {
    let text = String(source || '')
    // 聊天原话与她自己的说话习惯不是规则；仍由固定块识别去掉注入外壳。
    const quoted = memoryPromptRanges(text).filter((r) => /^(?:[（(](?:这个聊天里之前的原话|说话方式|下面是你最近在几个群里|你最近在别的聊天里说过的话)|【你刚上线，先补看最近)/.test(text.slice(r.start, r.end)))
    for (const r of quoted.sort((a, b) => b.start - a.start)) text = text.slice(0, r.start) + '\n' + text.slice(r.end)
    for (const line of text.split('\n')) {
      if (/口头禅|常用语|常挂在嘴边/.test(line)) continue
      const chars = normalizeForMatch(line).chars
      // 20 字和 18 字两种 shingle：短一点的复读片段/被标点打断的也能拦住，误伤靠 18 字下限控制。
      for (const size of [PROMPT_MATCH_LENGTH, PROMPT_MATCH_LENGTH - 2]) {
        for (let i = 0; i + size <= chars.length; i++) {
          const gram = chars.slice(i, i + size).join('')
          if (!excluded.includes(gram)) grams.add(gram)
        }
      }
    }
  }
  return grams
}

/** 合并命中的连续窗口后，调用方只删复读的部分（格式化变体也算），保留同一行里的正常话。 */
export function promptTextRanges(text, grams) {
  const ranges = memoryPromptRanges(text)
  if (!grams?.size) return ranges
  const { chars, starts, ends } = normalizeForMatch(text)
  const raw = String(text ?? '')
  const hits = []
  for (const size of [PROMPT_MATCH_LENGTH, PROMPT_MATCH_LENGTH - 2]) {
    for (let i = 0; i + size <= chars.length; i++) {
      if (grams.has(chars.slice(i, i + size).join(''))) hits.push({ start: starts[i], end: ends[i + size - 1] })
    }
  }
  // 连续窗口先合并，再把复读段落两端格式字符（空格/标点/反引号等）一起带走，避免残留「。」或反引号；
  // 但不动 ||| / ｜，气泡分隔符要保留下游拆条逻辑。
  hits.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged = []
  for (const hit of hits) {
    const last = merged.at(-1)
    if (last && hit.start <= last.end) last.end = Math.max(last.end, hit.end)
    else merged.push({ ...hit })
  }
  const isSkip = (ch) => /[\s\p{P}\p{S}]/u.test(ch) && !/[|｜<>]/.test(ch)
  for (const range of merged) {
    while (range.start > 0 && isSkip(raw[range.start - 1])) range.start--
    while (range.end < raw.length && isSkip(raw[range.end])) range.end++
    ranges.push(range)
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  return ranges
}

