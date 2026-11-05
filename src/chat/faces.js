// QQ 系统表情（小黄脸）：名字 ↔ 编号。她在回复里写 <face:捂脸>，发的时候换成 QQ 自带的表情，和文字在同一条消息里。
// 目录从网关现取（SnowLuma 的 fetch_sys_faces，缓存一天）；接的是别的 OneBot、取不到时用下面这份常用的兜底。

import { FACE_TABLE } from './face-table.js'

/**
 * 系统表情（名字 → 编号），取不到网关目录时用。
 * 以前这里只兜底 65 个常用表情，别人贴了个表里没有的，回应就只剩一个数字编号；
 * 现在直接用 QQ 的整张表（329 条），同名的取第一个，优先客户端还显示的那些。
 */
export const COMMON_FACES = (() => {
  const out = {}
  for (const f of FACE_TABLE) if (!f.hide && out[f.name] === undefined) out[f.name] = Number(f.id)
  for (const f of FACE_TABLE) if (out[f.name] === undefined) out[f.name] = Number(f.id)
  return out
})()

/** 给她看的几个例子（提示词里用，别太长）。 */
export const FACE_EXAMPLES = ['微笑', '呲牙', '偷笑', '捂脸', '斜眼笑', '笑哭', '吃瓜', '白眼', '委屈', '裂开', '摸鱼', '抱拳', '赞', 'OK']

const FACE_TAG = /<face:\s*([^>]{1,12}?)\s*>(?:\s*<\/face>)?/g

/**
 * 网关目录（{ packs: [{ pack_name, emojis: [{ q_sid, q_des, emoji_name_alias, is_super }] }] }）→ 名字 / 编号对照。
 * 只要数字编号的（emoji 分组的编号是字符，不是系统表情）；同名的优先普通表情，没有再用超级表情。
 */
export function buildFaceIndex(catalog) {
  const byName = new Map()
  const byId = new Map()
  const entries = []
  for (const p of catalog?.packs || []) for (const e of p.emojis || []) entries.push(e)
  entries.sort((a, c) => Number(Boolean(a.is_super)) - Number(Boolean(c.is_super)))
  for (const e of entries) {
    const id = String(e.q_sid ?? '')
    if (!/^\d+$/.test(id)) continue
    const name = String(e.q_des || '').replace(/^\//, '').trim()
    if (!name) continue
    if (!byId.has(id)) byId.set(id, name)
    for (const n of [name, ...(e.emoji_name_alias || [])].map((x) => String(x).replace(/^\//, '').trim()).filter(Boolean)) {
      if (!byName.has(n)) byName.set(n, Number(id))
    }
  }
  return { byName, byId }
}

const COMMON_INDEX = (() => {
  const byName = new Map(Object.entries(COMMON_FACES))
  // 编号 → 名字用整张表（含客户端已不显示的老表情），被贴了冷门表情也能翻出名字
  const byId = new Map(FACE_TABLE.map((f) => [String(f.id), f.name]))
  for (const [n, id] of Object.entries(COMMON_FACES)) if (!byId.has(String(id))) byId.set(String(id), n)
  return { byName, byId }
})()

/**
 * 把文字里的 <face:名字> 换成 QQ 消息段（文字段和表情段交替）；认不出的名字直接去掉，不把标签原样发出去。
 * idOf(name) → 编号或 undefined。
 */
export function textToSegments(text, idOf) {
  const out = []
  const s = String(text ?? '')
  let last = 0
  for (const m of s.matchAll(FACE_TAG)) {
    if (m.index > last) out.push({ type: 'text', data: { text: s.slice(last, m.index) } })
    const id = idOf(m[1])
    if (id !== undefined && id !== null) out.push({ type: 'face', data: { id: String(id) } })
    last = m.index + m[0].length
  }
  if (last < s.length) out.push({ type: 'text', data: { text: s.slice(last) } })
  // 相邻的文字段合并；整条只剩空白的文字段去掉
  const merged = []
  for (const seg of out) {
    const prev = merged[merged.length - 1]
    if (seg.type === 'text' && prev?.type === 'text') prev.data.text += seg.data.text
    else merged.push(seg)
  }
  return merged.filter((seg) => seg.type !== 'text' || seg.data.text.trim())
}

/** 去掉文字里的 <face:…> 标签（系统表情关着时用）。 */
export const stripFaceTags = (text) => String(text ?? '').replace(FACE_TAG, '').replace(/[ \t]{2,}/g, ' ').trim()

/** 语音文本收尾：去掉 <voice> 标签、连续空格、首尾空白。 */
const tidySpeech = (s) => String(s).replace(/<\/?voice>/g, '').replace(/[ \t]{2,}/g, ' ').trim()

/**
 * 语音条要念的文字：去掉 QQ 小黄脸标签、表情包/戳一戳等格式标签、以及 emoji 图形符号，
 * 不然 TTS 会把「呲牙」这类表情名字甚至 emoji 直接念出来（用户反馈：发语音时表情被读出来）。
 * 去掉后没字可念时返回空串，由调用方决定改发文字。
 */
export function speakableText (text) {
  return splitSpeakable(text).spoken
}

/**
 * 把一条语音拆成「要念的」和「只剩表情/符号的」两半：表情不念出来，但单独补一条文字发出去
 * （用户反馈：发语音时表情直接消失，希望表情和语音分开发）。
 * extras 里保留 <face:名字> 原文，交给 sendText 换成真的 QQ 表情；表情包 / 戳一戳没有「单独发一条」的说法，只从语音里去掉。
 * 例：'<face:呲牙>晚安😁' → { spoken: '晚安', extras: '<face:呲牙>😁' }
 */
export function splitSpeakable (text) {
  const raw = String(text ?? '')
  // emoji 的那一段：图形符号之外还要算上区域指示符（🇨🇳 这类国旗不在 Extended_Pictographic 里，单列会漏掉、被 TTS 念出来）、
  // 键帽（1️⃣ 要连前面的数字一起拆走）、连接符 / 变体选择符、肤色修饰符（👋🏽）、标签字符（🏴󠁧󠁢󠁳󠁣󠁴󠁿 的尾巴）。
  const re = /<face:[^>]{1,12}?>(?:\s*<\/face>)?|<sticker:[^>]*>(?:\s*<\/sticker>)?|<poke\s*\/?>|[#*0-9]\uFE0F?\u20E3|[\p{Extended_Pictographic}\p{Regional_Indicator}\u200D\uFE0F\u20E3\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/gu
  let spoken = ''
  let extras = ''
  let last = 0
  let m
  while ((m = re.exec(raw)) !== null) {
    spoken += raw.slice(last, m.index)
    if (!m[0].startsWith('<')) extras += m[0] // 不是标签：emoji / 国旗 / 键帽，要补发
    else if (m[0].startsWith('<face:')) extras += m[0].replace(/\s*<\/face>\s*$/i, '') // 只留开头标签，</face> 不补发
    last = m.index + m[0].length
  }
  spoken += raw.slice(last)
  return { spoken: tidySpeech(spoken), extras: tidySpeech(extras) }
}

/** 系统表情对照：先用常用的，第一次用到时再去网关拉完整目录（一天刷新一次）。 */
export function createFaces({ onebot, log } = {}) {
  let index = COMMON_INDEX
  let at = 0
  let loading = null
  function refresh() {
    if (loading || (at && Date.now() - at < 24 * 3600_000)) return loading
    loading = Promise.resolve(onebot?.call?.('fetch_sys_faces', {}, { timeoutMs: 15000 }))
      .then((r) => {
        const built = buildFaceIndex(r?.packs ? r : r?.data)
        if (built.byName.size) index = { byName: new Map([...COMMON_INDEX.byName, ...built.byName]), byId: new Map([...COMMON_INDEX.byId, ...built.byId]) }
      })
      .catch((error) => log?.debug?.('取 QQ 系统表情目录失败，用内置的常用表情：', error.message))
      .finally(() => { at = Date.now(); loading = null })
    return loading
  }
  return {
    refresh,
    idOf: (name) => { refresh(); return index.byName.get(String(name || '').replace(/^\//, '').trim()) },
    nameOf: (id) => { refresh(); return index.byId.get(String(id)) },
  }
}
