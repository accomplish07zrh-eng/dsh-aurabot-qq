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
import { join } from 'node:path'

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

/** 本地日期 → 文件名（一天一条链，重启后从当天文件尾恢复链头）。 */
function dayFile(dir, d) {
  const p = (n) => String(n).padStart(2, '0')
  return join(dir, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`)
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
 */
export function createAuditor({ dir, chatOfSession, isOwnedSession, log, now = () => new Date(), maxChars = 600, flushMs = 2000 } = {}) {
  const queue = []
  let timer = null
  let writing = false
  let prevHash = null // 惰性恢复：第一次落盘前从今天文件尾读链头

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
          args: e.args == null ? '' : clip(e.args, maxChars),
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

  return {
    /** 挂在 tools/pre-execute 上：记「想干」，永远放行。 */
    async preExecute(exec, next) {
      try {
        record({
          kind: 'tool/intent',
          sessionId: exec?.agent?.session?.id || '',
          tool: String(exec?.name || ''),
          args: exec?.arguments,
        })
      } catch { /* 失败静默 */ }
      return next()
    },
    /** 挂在 session/event 上：补记「结果」。tool/* 事件来了就记一条 outcome。 */
    onSessionEvent(session, event) {
      try {
        const type = String(event?.type || '')
        if (!type.startsWith('tool/')) return
        const d = event?.data || {}
        record({
          kind: type,
          sessionId: session?.id || '',
          tool: String(d.toolName || d.tool || d.name || ''),
          outcome: d.error ? `error: ${d.error}` : (d.result != null ? d.result : ''),
        })
      } catch { /* 失败静默 */ }
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
