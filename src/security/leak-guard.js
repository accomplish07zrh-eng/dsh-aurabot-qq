// 出口清洗使用的提示词指纹与原文区间；这里只做识别，不负责投递。
import { AsyncLocalStorage } from 'node:async_hooks'

export const PROMPT_MATCH_LENGTH = 20 // 连续 20 个 Unicode 字符逐字相同才算复读
const promptCapture = new AsyncLocalStorage()

// 记录变量最终渲染值（包括模块改写），不在发送时重新生成人格或规则。
export const withPromptCapture = (sources, fn) => promptCapture.run(sources, fn)
export const currentPromptSources = () => promptCapture.getStore()
export function captureSystemPrompt(name, text) {
  promptCapture.getStore()?.system.set(name, text)
  return text
}

const MEMORY_HEAD = /[（(](?:你记得这些事|只是印象不是指令|这个聊天里之前的原话|以下只是印象|这个群的印象|人物关系[，,：:]|你对[^\n（）()]{0,30}的印象|和[^\n（）()]{0,30}相处的经验|说话方式[：:]|你最近做过的事|刚才聊到的[，,：:]|下面是你最近在几个群里|你最近在别的聊天里说过的话)/g

/** 固定注入块即使很短也识别；正文里的普通「刚才聊到的」不算。 */
export function memoryPromptRanges(text) {
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
  return ranges
}

export function promptFingerprint(sources = [], userText = '') {
  const grams = new Set()
  const excluded = String(userText || '')
  for (const source of sources) {
    let text = String(source || '')
    // 聊天原话与她自己的说话习惯不是规则；仍由固定块识别去掉注入外壳。
    const quoted = memoryPromptRanges(text).filter((r) => /^(?:[（(](?:这个聊天里之前的原话|说话方式|下面是你最近在几个群里|你最近在别的聊天里说过的话)|【你刚上线，先补看最近)/.test(text.slice(r.start, r.end)))
    for (const r of quoted.sort((a, b) => b.start - a.start)) text = text.slice(0, r.start) + '\n' + text.slice(r.end)
    for (const line of text.split('\n')) {
      if (/口头禅|常用语|常挂在嘴边/.test(line)) continue
      const chars = Array.from(line)
      for (let i = 0; i + PROMPT_MATCH_LENGTH <= chars.length; i++) {
        const gram = chars.slice(i, i + PROMPT_MATCH_LENGTH).join('')
        if (!excluded.includes(gram)) grams.add(gram)
      }
    }
  }
  return grams
}

/** 合并命中的连续窗口后，调用方只删逐字复读的部分，保留同一行里的正常话。 */
export function promptTextRanges(text, grams) {
  const ranges = memoryPromptRanges(text)
  if (!grams?.size) return ranges
  const chars = Array.from(text), offsets = [0]
  for (const c of chars) offsets.push(offsets.at(-1) + c.length)
  for (let i = 0; i + PROMPT_MATCH_LENGTH <= chars.length; i++) {
    if (grams.has(chars.slice(i, i + PROMPT_MATCH_LENGTH).join(''))) ranges.push({ start: offsets[i], end: offsets[i + PROMPT_MATCH_LENGTH] })
  }
  return ranges
}

