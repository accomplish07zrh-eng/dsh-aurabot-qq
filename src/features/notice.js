// DSH 里有两种「要人处理」的事：工具要授权（approval/asked 审计事件）、她弹选择（ask_user_question 的 tool/call）。
// 这里把它们推到主人 QQ：只上报，不代答——DSH 界面照常弹，谁在电脑前谁点。
// 按工作区分别开关（config.notice）。
//
// 两条硬规矩：
//   1. 几秒内到的事合并成一批，不刷屏；
//   2. 文案交给她自己在私聊会话里说（完整人格 + 上下文），这里不拼提示词、不改写。

const KEY = { approval: 'approval', question: 'question' }

/** 工作区路径规范化：大小写、末尾斜杠、正反斜杠都抹平，同一目录只算一个。 */
export function normalizeWorkspace(path) {
  return String(path || '').trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
}

/**
 * @param {object} o
 * @param {() => object} o.getConfig
 * @param {(sessionId: string) => string} [o.workspaceOf] 会话 → 工作区路径
 * @param {(items: Array) => Promise<boolean>} [o.compose] 把攒下的事推进会话里说，返回是否推成功
 * @param {number} [o.windowMs] 合并窗口（默认 8 秒，够几条一起到）
 * @param {number} [o.maxItems] 一次最多合几条（超了立刻处理）
 * @param {object} [o.log]
 */
export function createNoticeRelay({ getConfig, workspaceOf, compose, log, windowMs = 8000, maxItems = 8, retryMax = 2, retryDelayMs = 10000 } = {}) {
  const seen = new Map()
  const buf = new Map()
  let timer = null
  let retry = 0

  /** 这个会话的这一类事要不要上报：先看总开关，再看工作区覆盖。没配主人号就不报（发不出去）。 */
  function enabled(kind, sessionId) {
    const cfg = getConfig?.() || {}
    if (!cfg.enabled || cfg.dryRun || !cfg.ownerQQ) return false
    const n = cfg.notice || {}
    if (n.enabled === false) return false
    if (n[kind] === false) return false
    const ws = normalizeWorkspace(workspaceOf?.(sessionId))
    const override = ws ? n.workspaces?.[ws] : undefined
    if (override && typeof override[kind] === 'boolean') return override[kind]
    return true
  }

  function prune() {
    if (seen.size <= 200) return
    for (const [k, t] of seen) if (Date.now() - t > 6 * 3600_000) seen.delete(k)
  }

  function take() {
    const items = [...buf.values()]
    buf.clear()
    if (timer) { clearTimeout(timer); timer = null }
    return items
  }

  function schedule(ms) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { Promise.resolve().then(flush).catch(() => {}) }, ms)
    timer.unref?.()
  }

  /**
   * 把窗口里攒的事交给 compose（它负责推进会话里说）。
   * compose 返回 false 表示这次推不了（私聊在忙、刚主动说过话），放回缓冲稍后重试；
   * 重试到上限还不成就 warn 一条放弃——至少日志里能看见「这几条没报出去」。
   */
  async function flush() {
    const items = take()
    if (!items.length) return false
    let ok = false
    try {
      ok = (await compose?.(items)) === true
    } catch (error) {
      log?.warn?.('上报推送失败：', error.message)
    }
    if (ok) { retry = 0; log?.info?.(`上报推送成功：${items.length} 条`); return true }
    if (retry >= retryMax) {
      retry = 0
      log?.warn?.(`上报有 ${items.length} 条一直没推出去，放弃：${items.map((it) => it.title || it.tool || it.kind).join('、')}`)
      return false
    }
    retry += 1
    log?.info?.(`上报推送没成功（第 ${retry} 次重试）：${items.length} 条`)
    for (const it of items) buf.set(it.id, it)
    schedule(retryDelayMs)
    return false
  }

  /**
   * 收一条待上报的事，返回是否收下（同一 id 只收一次）。
   * 窗口内攒着，到点一起说；攒满 maxItems 立刻发。
   * @param {'approval'|'question'} kind
   * @param {{id: string, sessionId?: string, title?: string, tool?: string, reason?: string, questions?: Array}} info
   */
  function announce(kind, info) {
    if (!KEY[kind]) return false
    if (!enabled(kind, info?.sessionId)) return false
    const key = String(info?.id || '')
    if (!key || seen.has(key)) return false
    seen.set(key, Date.now())
    prune()
    buf.set(key, { kind, at: Date.now(), ...info })
    if (buf.size >= maxItems) { schedule(0); return true }
    if (!timer) schedule(windowMs)
    return true
  }

  /**
   * 这件事已经处理完了（主人点了批准 / 选了方案）：从缓冲里拿掉。
   * 不然人就在电脑前、手比通知快，八秒后还会收到一条「去点一下」。
   */
  function cancel(id) {
    const key = String(id || '')
    if (!key) return false
    const had = buf.delete(key)
    if (had && buf.size === 0 && timer) { clearTimeout(timer); timer = null }
    return had
  }

  return { announce, enabled, cancel, flush, pending: () => buf.size, seen }
}
