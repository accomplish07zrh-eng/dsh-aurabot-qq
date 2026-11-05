// 自驱引擎 · 机械审计（docs/AUTOTELIC-PLAN.md §4.1，C1「她可以骗主人，但不能骗账本」）。
//
// 职责：把她（system:autotelic* 会话）的工具调用全量落盘成 jsonl，每行带 prevHash 形成哈希链。
// 她能删文件，但删了必然断链——审计的可靠性不来自「她改不了」，而来自「改了会露」。
//
// 三条硬规矩（§4.1 ①②⑤）：
// 1. 只记录，不放行/不放行结果——preExecute 永远 return next()；
// 2. pre-execute 只拿得到「意图」，「结果」从 session/event 的 tool/* 事件补记；
// 3. 钩子绝不同步写盘：preExecute 里只进内存队列，落盘由独立定时器批量 flush，失败静默。
//
// 过滤口径（§4.1 ④）：isOwnedSession() 且 chatOfSession() 以 'system:autotelic' 开头，
// 两个条件都要——主人 GUI 会话、QQ 私聊、群聊里的调用一律不进她的账本。

import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

/** 她的会话前缀：runSystemTurn('autotelic', ...) 开出来的 chatId 都长这样。 */
export const AUTOTELIC_CHAT_PREFIX = 'system:autotelic'

/** 是不是她的聊天。host 侧与模块侧共用同一个口径。 */
export function isAutotelicChat(chatId) {
  return String(chatId || '').startsWith(AUTOTELIC_CHAT_PREFIX)
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const clip = (v, n) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)
  return s.length > n ? s.slice(0, n) + '…' : s
}

/** 路径是不是在给定根目录下（Windows 大小写不敏感；用 resolve 归一化，防 `..` 绕过）。 */
function isInsideRoot(p, root) {
  if (!p || !root) return false
  try {
    const norm = (x) => resolve(String(x)).replace(/[\\/]+$/, '').toLowerCase()
    const target = norm(p)
    const base = norm(root)
    return target === base || target.startsWith(base + sep) || target.startsWith(base + '/')
  } catch { return false }
}

/** 本地日期 → 文件名（一天一条链，重启后从当天文件尾恢复链头）。 */
function dayFile(dir, d) {
  const p = (n) => String(n).padStart(2, '0')
  return join(dir, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`)
}

/** 读某一天的审计流水（面板「这一天的记录」弹窗用）。date = 'YYYY-MM-DD'；返回按序解析后的行。 */
export async function readAuditDay(dir, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return []
  try {
    const text = await readFile(join(dir, `${date}.jsonl`), 'utf8')
    const out = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { const { hash, prevHash, ...rec } = JSON.parse(line); out.push(rec) } catch { /* 坏行跳过（校验器会报） */ }
    }
    return out
  } catch { return [] }
}

/**
 * 从目录里把链读回来并校验。返回 { ok, total, brokenAt }：
 * brokenAt = null 表示整条链连续；否则是第一条对不上的记录（文件名 + 行号 + 原因）。
 */
export async function verifyAuditChain(dir) {
  const out = { ok: true, total: 0, brokenAt: null }
  let files = []
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort()
  } catch {
    return out // 目录不存在 = 还没记过账，链是完好的（空链）
  }
  let prev = ''
  for (const f of files) {
    let text = ''
    try { text = await readFile(join(dir, f), 'utf8') } catch (error) {
      out.ok = false
      out.brokenAt = { file: f, line: 0, reason: `读不了：${error.message}` }
      return out
    }
    const lines = text.split('\n').filter((l) => l.trim())
    for (let i = 0; i < lines.length; i++) {
      let rec
      try { rec = JSON.parse(lines[i]) } catch (error) {
        out.ok = false
        out.brokenAt = { file: f, line: i + 1, reason: `不是合法 JSON：${error.message}` }
        return out
      }
      out.total++
      const { hash, prevHash, ...body } = rec
      const want = sha256((rec.prevHash || '') + JSON.stringify(body))
      if (rec.prevHash !== prev) {
        out.ok = false
        out.brokenAt = { file: f, line: i + 1, reason: `断链：prevHash 接不上（这里前面少了记录）` }
        return out
      }
      if (hash !== want) {
        out.ok = false
        out.brokenAt = { file: f, line: i + 1, reason: '哈希对不上：这条记录被改过' }
        return out
      }
      prev = hash
    }
  }
  return out
}

/**
 * 造一个审计器。
 * @param {object} o
 * @param {string} o.dir 落盘目录（host 侧传 dataDir('modules-data','autotelic','audit')；模块内是 api.dataDir('audit')）
 * @param {(sessionId:string)=>string} o.chatOfSession DSH 会话 → chatId
 * @param {(sessionId:string)=>boolean} o.isOwnedSession 是不是 aurabot 自己开的会话（防记到主人 GUI 头上）
 * @param {object} [o.log]
 * @param {()=>Date} [o.now]
 * @param {number} [o.maxChars] 参数截断长度
 * @param {number} [o.flushMs] 批量落盘间隔
 * @param {string} [o.ownRoot] 她自己的数据根目录（写工具只许落在这下面；留空 = 不校验路径）
 */
export function createAuditor({ dir, chatOfSession, isOwnedSession, log, now = () => new Date(), maxChars = 240, flushMs = 2000, ownRoot = '' } = {}) {
  const queue = []
  let timer = null
  let writing = false
  let prevHash = null // 惰性恢复：第一次落盘前从今天文件尾读链头
  /** 未结算的意图（sessionId+tool → 入队时的引用）：结果事件到达时回填 outcome，避免同一动作落 3 行。 */
  const pending = new Map()

  async function recoverChainHead(file) {
    try {
      const text = await readFile(file, 'utf8')
      const lines = text.split('\n').filter((l) => l.trim())
      const last = lines.at(-1)
      if (last) prevHash = JSON.parse(last).hash || ''
    } catch { prevHash = prevHash || '' }
  }

  function schedule() {
    if (timer) return
    timer = setTimeout(() => { timer = null; flush().catch(() => {}) }, flushMs)
    if (timer.unref) timer.unref()
  }

  /** args 摘要：对象不整包落盘——记「键名 + 每个值的短摘要」，代码/长文本截到 120 字。
   *  （2026-11-05 修「审计超长」：原实现 clip(JSON 全文, 600)，整段 Python 代码都进账本，
   *   一天 227KB，翻账时信息密度极低——「翻一翻没计全、都超长」的根源。） */
  function argsSummary(args) {
    if (args == null) return ''
    if (typeof args === 'string') return clip(args, maxChars)
    if (typeof args !== 'object') return clip(String(args), maxChars)
    try {
      const parts = Object.entries(args).map(([k, v]) => {
        const s = typeof v === 'string' ? v : JSON.stringify(v)
        return `${k}=${clip(s ?? '', 120)}`
      })
      return clip(parts.join(' '), maxChars)
    } catch { return clip(String(args), maxChars) }
  }

  /** 入队一条（key：kind / sessionId / tool / args 等）。过滤不通过的静默丢弃。 */
  function record(entry) {
    try {
      const sessionId = String(entry.sessionId || '')
      if (typeof isOwnedSession === 'function' && !isOwnedSession(sessionId)) return
      const chatId = String((typeof chatOfSession === 'function' && chatOfSession(sessionId)) || '')
      if (!isAutotelicChat(chatId)) return // 关键过滤：只记她自己的会话（§4.1 ④）
      queue.push({ ...entry, chatId })
      schedule()
    } catch (error) {
      log?.debug?.('审计入队失败：', error.message) // 失败静默：审计不能拖住工具执行
    }
  }

  async function flush() {
    if (writing || !queue.length) return
    writing = true
    try {
      const batch = queue.splice(0, queue.length)
      const byDay = new Map()
      for (const e of batch) {
        const d = now()
        const file = dayFile(dir, d)
        const body = {
          kind: e.kind || 'tool/intent',
          at: d.toISOString(),
          sessionId: clip(e.sessionId, 64),
          chatId: e.chatId,
          tool: e.tool || '',
          args: argsSummary(e.args),
          outcome: e.outcome == null ? '' : clip(e.outcome, maxChars),
        }
        if (prevHash == null) await recoverChainHead(file)
        const rec = { ...body, prevHash: prevHash || '' }
        const line = JSON.stringify({ ...rec, hash: sha256((rec.prevHash || '') + JSON.stringify(body)) })
        prevHash = JSON.parse(line).hash
        byDay.set(file, (byDay.get(file) || []).join ? byDay.get(file) : [])
        byDay.set(file, [...(byDay.get(file) || []), line])
      }
      for (const [file, lines] of byDay) {
        await mkdir(dir, { recursive: true })
        await appendFile(file, lines.join('\n') + '\n', 'utf8')
      }
    } catch (error) {
      log?.debug?.('审计落盘失败（不影响工具执行）：', error.message)
    } finally {
      writing = false
      if (queue.length) flush().catch(() => {})
    }
  }

  /** 她的会话里直接拒掉的工具（第二道门，P2.3）：shell / 进程级动作不在她的动作菜单里。
   *  第一道门在 preset 工具清单（aurabot-autotelic 不带 shell），这里是万一拿到时的兜底。 */
  const DENY_TOOLS = new Set([
    'bash', 'pwsh', 'sh', 'cmd', 'zsh', 'spawn_teammate', 'send_message', 'task_board_run',
    // 2026-11-05 真机审计实证补拦：她在自己的会话里实际调到了这些「不该有」的手
    // （76 条：browser_navigate / browser_snapshot / browser_find / team_task_list / task_board_list /
    //  list_agents）。根因是 MCP 工具是**进程级全局注入**，preset 插件清单管不住它；
    //  她只需要「读文件 + 写自己的 notes」，这些一律不给她。
    'mcp__browser__browser_navigate', 'mcp__browser__browser_snapshot', 'mcp__browser__browser_find',
    'mcp__browser__browser_click', 'mcp__browser__browser_type', 'mcp__browser__browser_evaluate',
    'mcp__browser__browser_run_code_unsafe', 'mcp__grabit__media_download', 'mcp__grabit__media_batch',
    'team_task_list', 'team_task_get', 'team_task_create', 'team_task_update',
    'task_board_list', 'task_board_get', 'task_board_create', 'task_board_run', 'task_board_manage',
    'list_agents', 'interrupt_agent', 'workflow', 'schedule_create', 'schedule_update', 'schedule_delete',
  ])

  /** 她是「只能读 + 写自己目录」的：`edit`/`write` 只许落在她的数据目录里。
   *  （2026-11-05 真机审计实证：她确实用 edit/write 改过自己的 notes/*.md，这属于预期用法，
   *   所以不封工具，只封路径；路径判不出来时按「不许」处理——宁可拒错一次。） */
  const WRITE_TOOLS = new Set(['edit', 'write'])
  function writablePathOf(exec) {
    const a = exec?.arguments
    const p = typeof a === 'string' ? '' : (a?.file_path || a?.path || a?.filePath || '')
    return String(p || '')
  }

  return {
    /** 挂在 tools/pre-execute 上：记「想干」，永远放行——除非是她的会话碰白名单外危险工具。 */
    async preExecute(exec, next) {
      let chatId = ''
      try {
        const sessionId = exec?.agent?.session?.id || ''
        chatId = isOwnedSession?.(sessionId) === false ? '' : String((typeof chatOfSession === 'function' && chatOfSession(sessionId)) || '')
        const tool = String(exec?.name || '')
        if (isAutotelicChat(chatId) && DENY_TOOLS.has(tool)) {
          record({ kind: 'tool/denied', sessionId, tool, args: exec?.arguments, outcome: '第二道门：这个工具不在她的动作菜单里' })
          return { kind: 'deny', reason: '这个动作不在你的动作菜单里（只读 + 写自己目录为止）。要更多能力走提案（proposals/），别绕。' }
        }
        // 写工具只许写她自己的数据目录（2026-11-05 真机审计实证补的边界）
        if (isAutotelicChat(chatId) && WRITE_TOOLS.has(tool)) {
          const p = writablePathOf(exec)
          if (ownRoot && !isInsideRoot(p, ownRoot)) {
            record({ kind: 'tool/denied', sessionId, tool, args: exec?.arguments, outcome: `写到了自己目录外（${clip(p, 120)}）` })
            return { kind: 'deny', reason: '只能写你自己数据目录里的文件（notes/ 之类）。别的地方不要动。' }
          }
        }
        // 2026-11-05 修「同一动作落 3 行」（一天 537 条，翻账翻不全）：
        // 意图只入一条，登记到 pending；结果事件到达时回填 outcome 再落盘。
        // 若 flush 先走（结果没来），行内 outcome 为空 = 「意图了但结果未记录」，对账会提示。
        // 关联键用 callId（ToolExecutionInput.callId 在**调用时**就有，结果事件 message.toolCallId 能对上）；
        // 同一工具并发调用时按工具名会串台，callId 才唯一。
        const entry = { kind: 'tool/call', sessionId, tool, args: exec?.arguments }
        record(entry)
        const last = queue.at(-1)
        if (last) {
          const callId = String(exec?.callId || '')
          if (callId) pending.set(`${sessionId}|#${callId}`, last)
          pending.set(`${sessionId}|${tool}`, last) // 兜底：结果里没有 callId 的老形状
        }
      } catch { /* 失败静默 */ }
      return next()
    },
    /** 挂在 session/event 上：把「结果」回填到她这次动作的那一行（不再另开一行）。
     *
     * 2026-11-05 真机修：原来按 `d.toolName || d.tool || d.name` 取工具名，但 DSH 的
     * `tool/result` 载荷是 `{ turn, step, message, error?, meta? }`——**工具名压根不在顶层**，
     * 于是 pending 永远匹配不上，171 条结果全成了空 tool / 空 outcome（对账据此判「结果未记录」，
     * 真丢了就看不出来）。现在按事件形状取：
     *   - `tool/call`：`{ turn, step, callId, name, arguments }` → 工具名在 name
     *   - `tool/result`：`{ turn, step, message }`，message.toolCallId / source.callId 关联回调用，
     *     结果正文在 message.content[].text
     * 关联键优先 callId（同一工具并发调用时按工具名会串），取不到才退回工具名。 */
    onSessionEvent(session, event) {
      try {
        const type = String(event?.type || '')
        if (!type.startsWith('tool/')) return
        const d = event?.data || {}
        const sessionId = session?.id || ''
        // 结果正文：message.content 里各块的 text 拼起来；老形状（result 字段）兼容保留
        const msg = d.message || {}
        const blocks = Array.isArray(msg.content) ? msg.content : []
        const body = blocks.map((b) => (typeof b?.text === 'string' ? b.text : '')).filter(Boolean).join('\n')
        const outcomeText = d.error
          ? `error: ${clip(typeof d.error === 'string' ? d.error : (d.error.name || d.error.reason || JSON.stringify(d.error)), maxChars)}`
          : (body || (d.result != null ? clip(String(d.result), maxChars) : ''))
        // 关联键：callId 优先（同一工具并发时按名字会串到别人那行）
        const callId = String(d.callId || msg.toolCallId || msg.source?.callId || '')
        const tool = String(d.name || d.toolName || d.tool || '')
        let target = null
        if (callId && pending.has(`${sessionId}|#${callId}`)) target = pending.get(`${sessionId}|#${callId}`)
        if (!target && tool && pending.has(`${sessionId}|${tool}`)) target = pending.get(`${sessionId}|${tool}`)
        if (!target) return // 不是她会话的（record 已过滤，进不了 pending），或结果晚于落盘——按原样丢
        if (outcomeText) target.outcome = outcomeText
        if (callId && pending.has(`${sessionId}|#${callId}`)) pending.delete(`${sessionId}|#${callId}`)
        if (tool && pending.has(`${sessionId}|${tool}`)) pending.delete(`${sessionId}|${tool}`)
      } catch { /* 失败静默 */ }
    },
    /** 模块侧显式记账（§4.1 ③ 非工具路径）：tune / 做梦 / L1 做事回合等，由可信模块代码调用。
     *  固定记在她的 chat 名下（不经过会话过滤——调用方就是 autotelic 自己）。 */
    note(entry) {
      try {
        const kind = String(entry?.kind || 'autotelic/note')
        queue.push({ ...entry, kind: kind.startsWith('autotelic/') ? kind : 'autotelic/note', chatId: AUTOTELIC_CHAT_PREFIX })
        schedule()
      } catch (error) { log?.debug?.('审计入队失败：', error.message) }
    },
    /** 状态面板用：目录里今天的条数 + 整条链的校验结果。 */
    async status() {
      let today = 0
      try {
        const text = await readFile(dayFile(dir, now()), 'utf8')
        today = text.split('\n').filter((l) => l.trim()).length
      } catch { today = 0 }
      const chain = await verifyAuditChain(dir)
      return { dir, today, chain }
    },
    /** 测试 / 卸载用：立刻把队列写完（flushMs 的定时器不可靠时走这条）。 */
    flush,
    /** 卸载时把队列里剩的写完。 */
    async dispose() {
      if (timer) { clearTimeout(timer); timer = null }
      await flush()
    },
  }
}
