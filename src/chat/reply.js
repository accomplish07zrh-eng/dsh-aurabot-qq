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

// 模型偶尔把自己那边的内部语法漏进正文，这些都不能发到 QQ，得在解析入口洗掉：
//   - 工具调用的收尾标记，比如 </｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>（全角竖线包着关键字）
//   - 上下文插件给历史消息挂的编号（m00896 / m00896b），提示词里说了不许抄，但它会抄
// 编号是 5 位起（补零写法 m00xxx）；4 位的 m1005、m1136 是打印机型号，不能误伤。
const SPECIAL_TOKEN = /<\/?[｜|]{1,2}\s*[A-Za-z_]+\s*[｜|]{1,2}[^<>]*>/g
const CONTEXT_REF = '(?:m0\\d{3,5}|m[1-9]\\d{4,6})[a-z]{0,2}'
const REF_AT_HEAD = new RegExp(`^[ \\t]*(?:${CONTEXT_REF})[ \\t]*[，,：:、]?[ \\t]*`)
const REF_INLINE = new RegExp(`(?<![A-Za-z0-9])(?:${CONTEXT_REF})(?![A-Za-z0-9])`, 'g')
const REF_IN_BAD_TAG = new RegExp(`<reply\\s*[:：]\\s*(?:${CONTEXT_REF})\\s*>`, 'gi')

/** 洗掉模型漏出来的内部标记与消息编号：行首连标点一起清，行中行尾留个空格；洗完是空的就当「这次不说话」。 */
export function stripModelArtifacts(text) {
  return String(text || '')
    .replace(SPECIAL_TOKEN, '')
    .replace(REF_IN_BAD_TAG, '')
    .split('\n')
    .map((line) => line.replace(REF_AT_HEAD, '').replace(REF_INLINE, ''))
    .join('\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 是不是「这次不说话」。 */
export function isSilence(text) {
  const t = String(text || '').trim()
  return t === '' || t === SILENCE || t === '［沉默］' || t === '(沉默)' || t === '（沉默）'
}

/**
 * 解析一轮回复。
 * @param {string} text 模型这一轮的最终正文
 * @returns {{silent: boolean, items: Array<{kind:'text'|'voice'|'sticker'|'image', value:string, replyTo?:string}>}}
 */
export function parseReply(text) {
  const raw = stripModelArtifacts(String(text || '')).trim()
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
