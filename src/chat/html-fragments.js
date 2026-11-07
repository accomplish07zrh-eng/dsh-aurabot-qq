/**
 * 模型偶尔会在正文前后吐出一段 HTML 收尾片段（`</p>`、`</div>`、`</section>`）。
 * QQ 不渲染 HTML，这些标签会原样出现在群里。
 *
 * 2026-11-06 实况（群 644343678，会话 seq 4451，turn 422）：模型 reasoning 之后
 * 直接输出 `</p>\n\n\n\n\n\nB站那个是全本 3214集 中间不插广告`，`</p>` 原样发进群。
 *
 * 规则按行做**标签配对**，不做白名单：
 *   - 同一行里开标签和闭标签能配对 → 两个都留（模型真会聊 `<div>内容</div>`）；
 *   - **落单**的开/闭标签（`</p>`、`你好</p>世界`、只写一半的 `<div>`）→ 剥；
 *   - `<br>` 是合法出站标记（`parseReply` 会转成换行），永远不剥；`</br>` 照剥；
 *   - ``` / ~~~ 围栏内一律不动（模型可能在教人写 HTML）；
 *   - 剥完某行只剩块级标签（`<div><br></div>`、`</p></p>`）→ 整行删掉；
 *     行内标签（`<span>`、`<b>`）不算噪音，不陪葬。
 *
 * 白名单方案试过，会把「正文里的 `<div>内容</div>`」当非法标签剥掉，
 * 与 `test/dsml-leak.test.js` 的既有约定冲突，已放弃。
 */

/**
 * 块级标签名；行内标签（b/i/strong/em/a/span 等）不在内，一律不碰。
 * HTML5 语义标签也要覆盖：模型吐的收尾片段不只有 `</p>`。
 */
const BLOCK_NAMES = new Set([
  'p', 'div', 'br', 'li', 'ul', 'ol', 'dl', 'dt', 'dd',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'section', 'article', 'main', 'nav', 'header', 'footer', 'aside',
  'figure', 'figcaption', 'blockquote', 'pre', 'hr',
  'form', 'fieldset', 'legend', 'address', 'details', 'summary',
])

/**
 * 任意 `<名字 …>` / `</名字>` / `<名字 …/>`；名字首字母必须是 ASCII 字母。
 * 属性段允许引号里的 `>`（`<div title="1 > 0">`）：不加这层，标签会被切成两半，
 * 剩下 `0">正文`，比原来的残片更脏。
 */
const TAG_RE = /<(\/?)([A-Za-z][A-Za-z0-9]*)\b((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?)>/g

/** 代码围栏开符：``` 或 ~~~（3 个以上，允许缩进）。 */
const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})/

/**
 * 收集围栏区间（字符偏移）。未闭合的围栏一直算到结尾。
 * 收尾必须同时满足：
 *   - 同一种符号：``` 开的只能 ``` 收，`~~~` 不算；
 *   - 长度不短于开符：```` 开的不会被 ``` 提前关掉；
 *   - 后面只剩空白：```y 是代码行不是收尾。
 * 少任何一条，后半段代码就会漏进正文清洗。
 */
export function fenceRanges (text) {
  const ranges = []
  let open = -1
  let openMarker = ''
  let openLen = 0
  let pos = 0
  for (const line of String(text || '').split('\n')) {
    const m = FENCE_LINE.exec(line)
    if (m) {
      const marker = m[1][0]
      const len = m[1].length
      const rest = line.slice(m[0].length)
      if (open < 0) {
        open = pos
        openMarker = marker
        openLen = len
      } else if (marker === openMarker && len >= openLen && /^[ \t]*$/.test(rest)) {
        ranges.push({ start: open, end: pos + line.length })
        open = -1
        openMarker = ''
        openLen = 0
      }
    }
    pos += line.length + 1
  }
  if (open >= 0) ranges.push({ start: open, end: String(text).length })
  return ranges
}

/**
 * 处理一行：剥掉落单的块级标签。
 * 返回 `{ out, dropped }`，`dropped` 是相对行首的删除区间（供整条消息坐标映射用），
 * `out === ''` 且原行非空表示整行只剩标签、应当删掉。
 */
export function stripLineTags (line) {
  const tags = []
  for (const m of line.matchAll(TAG_RE)) {
    const name = m[2].toLowerCase()
    if (!BLOCK_NAMES.has(name)) continue
    tags.push({ name, close: m[1] === '/', selfClose: m[4] === '/', start: m.index, end: m.index + m[0].length })
  }
  if (!tags.length) return { out: line, dropped: [] }

  // 配对：`<br>` / `<br/>` 是合法出站标记，直接放行；`</br>` 这种落单闭标签照剥。
  const keep = new Set()
  const stack = []
  for (const t of tags) {
    if (t.name === 'br') {
      if (!t.close) keep.add(t)
      continue
    }
    if (t.selfClose) continue // 其它自闭合标签落单，进 drop
    if (!t.close) {
      stack.push(t)
      continue
    }
    let i = stack.length - 1
    while (i >= 0 && stack[i].name !== t.name) i--
    if (i < 0) continue // 落单的闭标签
    keep.add(stack[i])
    keep.add(t)
    stack.length = i
  }

  // 落单的开标签（栈里剩下的）、落单的闭标签、自闭合标签，一起剥。
  const dropped = tags.filter((t) => !keep.has(t))
    .sort((a, b) => a.start - b.start)
    .map((t) => ({ start: t.start, end: t.end }))
  let out = ''
  let last = 0
  for (const t of dropped) {
    out += line.slice(last, t.start)
    last = t.end
  }
  out += line.slice(last)

  // 剥完只剩块级标签和空白 → 整行是噪音。
  // 两个例外：整行只有一个 `<br>`（`前\n<br>\n后` 中间那行）是真换行，留着；
  // 行内标签不算噪音，不能陪葬。
  const onlyBr = tags.length === 1 && tags[0].name === 'br'
  const visible = onlyBr
    ? out
    : out.replace(TAG_RE, (m0, _slash, name) =>
        BLOCK_NAMES.has(String(name).toLowerCase()) ? '' : m0,
      )
  if (!visible.trim()) return { out: '', dropped, whole: true }
  return { out, dropped }
}

/**
 * 清洗整段文本，返回 `{ value, cuts }`：
 *   - `value`：清洗后的文本；
 *   - `cuts`：原文坐标下的删除区间（含被整行删掉的换行），
 *     供 `cleanOutboundSegments()` 把结果映射回原消息的分段。
 */
export function stripHtmlFragments (text) {
  const raw = String(text || '')
  if (!raw) return { value: raw, cuts: [] }
  const fences = fenceRanges(raw)
  const cuts = []
  const pieces = []
  let last = 0
  const flush = (end) => {
    if (end <= last) return
    const piece = cleanChunk(raw.slice(last, end), last, raw.length, cuts)
    pieces.push(piece)
  }
  for (const f of fences) {
    flush(f.start)
    pieces.push(raw.slice(f.start, f.end))
    last = f.end
  }
  flush(raw.length)
  return { value: pieces.join(''), cuts }
}

/** 处理围栏外的一段文本：逐行剥标签，整行删时连换行和相邻空行一起剪。 */
function cleanChunk (chunk, base, total, cuts) {
  const from = cuts.length
  const lines = chunk.split('\n')
  const spans = []
  let pos = base
  for (const line of lines) {
    spans.push({ start: pos, end: pos + line.length, line, ...stripLineTags(line) })
    pos += line.length + 1
  }
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]
    if (!s.whole || s.line === '') {
      for (const d of s.dropped) cuts.push({ start: s.start + d.start, end: s.start + d.end })
      continue
    }
    // 整行只剩标签：吃掉这行的换行，并吸附前后相邻的空行，
    // 免得残片后面那串空行变成一屏空气泡（2026-11-06 实况就是「</p> + 六个空行 + 正文」）。
    let start = s.start
    let end = Math.min(total, s.end + 1)
    for (let k = i - 1; k >= 0 && spans[k].line.trim() === ''; k--) start = spans[k].start
    for (let j = i + 1; j < spans.length && spans[j].line.trim() === ''; j++) end = Math.min(total, spans[j].end + 1)
    cuts.push({ start, end })
  }
  // value 必须和 cuts 用同一份区间算出来，否则两边对不上（分段映射会错位）。
  let out = ''
  let last = 0
  const local = cuts.slice(from)
    .map((c) => ({ start: Math.max(0, c.start - base), end: Math.min(chunk.length, c.end - base) }))
    .sort((a, b) => a.start - b.start)
  for (const c of local) {
    if (c.end <= last) continue
    if (c.start > last) out += chunk.slice(last, c.start)
    last = c.end
  }
  return out + chunk.slice(last)
}
