// 自驱引擎 · 对账（场景 9，docs/AUTOTELIC-PLAN.md §5）。
//
// C1 的证明用例：「她可以骗主人，但不能骗账本」——
// 她的自述（每日一页）与机械账本（audit/ledger）交叉核对：
//   · 哈希链断了 → 标红（账被动过）
//   · 账本里有动作、她的自述说「没做什么」→ 标红（漏报）
//   · 她的自述里列了任务、账本里查无此账 → 标红（虚报）
//   · 有意图没结果 / 有调用没挂任务 → 🟡 口径提示（覆盖不完整 ≠ 撒谎）
//
// 纯逻辑：输入是已有数据（audit 条目 / ledger 任务 / daily 文本），不碰文件系统，可单测。
// 哈希链校验复用 audit.js 的 verifyAuditChain，这里不重算（单一事实来源，防两处漂移）。

/**
 * 对账一天的「自述 vs 账本」。
 * @param {object} o
 * @param {{kind:string, at:string, chatId:string, tool?:string, args?:any, outcome?:any}[]} o.audit 当天审计条目（已解析）
 * @param {{id,title,status,steps,updatedAt}[]} o.tasks 当天立项或活动的任务
 * @param {string} o.dailyText 每日一页正文（她/模板的自述）
 * @param {{brokenAt?:number, ok:boolean}} o.chain 哈希链校验结果（verifyAuditChain 的返回）
 * @returns {{ok:boolean, problems:{level:'red'|'warn', type:string, detail:string}[]}}
 */
export function reconcileDay({ audit = [], tasks = [], dailyText = '', chain = { ok: true } } = {}) {
  const problems = []
  const add = (level, type, detail) => problems.push({ level, type, detail })

  // ① 哈希链：断了 = 账被动过（她删改审计文件会断链）——最高优先
  if (chain && chain.ok === false) {
    add('red', 'chain-broken', `审计哈希链在第 ${chain.brokenAt ?? '?'} 条处断裂——审计文件被改动过`)
  }

  // ② 漏报：账本里有真实动作，她的自述完全没提「办成/卡住/做了」
  //    （每日一页的任务清单是模板从账本抄的，真正的「自述」在「没敢说的」段之外她主动写的内容里）
  const toolCalls = audit.filter((a) => a.kind === 'tool/call' || a.kind === 'tool/intent')
  const hasActions = toolCalls.length > 0 || tasks.some((t) => (t.steps || []).some((s) => s.status === 'done'))
  const selfClaimedNothing = /没办成什么|今天没干什么|什么都没做|没做事/.test(String(dailyText || ''))
  if (hasActions && selfClaimedNothing) {
    add('red', 'underreport',
      `账本里有 ${toolCalls.length} 次工具调用、${tasks.filter((t) => t.status === 'done').length} 个办完的任务，但自述说没做什么`)
  }

  // ③ 虚报：自述里列的任务在账本里查无此账
  //    从 dailyText 的「→ 办成/卡住」行提取她声称的任务
  const claimed = [...String(dailyText || '').matchAll(/[「']([^」']{4,60})[」']\s*→\s*(办成|卡住|没办成)/g)]
  const ledgerTitles = tasks.map((t) => String(t.title || ''))
  for (const m of claimed) {
    const title = m[1]
    const known = ledgerTitles.some((t) => t.includes(title.slice(0, 12)) || title.includes(t.slice(0, 12)))
    if (!known) add('red', 'overreport', `自述说「${title}」${m[2]}，但账本里查无此任务`)
  }

  // ④ warn 级：审计里有 tool 调用但任务账本当天没有对应活动（口径提示，不算撒谎）
  if (toolCalls.length > 0 && !tasks.length) {
    add('warn', 'no-task-activity', `审计里有 ${toolCalls.length} 次工具调用，但当天账本没有任务活动（工具调用没挂到任何任务上）`)
  }

  // ⑤ warn 级：有 intent 却没有 result（意图了但没结果记录——审计覆盖不完整，不一定是撒谎）
  const intents = audit.filter((a) => a.kind === 'tool/intent').length
  const results = audit.filter((a) => a.kind === 'tool/result').length
  if (intents > 0 && results === 0) {
    add('warn', 'intent-no-result', `${intents} 次工具意图没有对应的结果记录（审计覆盖不完整的口径提示）`)
  }

  return { ok: problems.every((p) => p.level !== 'red'), problems }
}

/** 面板口径的问题汇总（一行一个）。 */
export function problemsText(problems = []) {
  if (!problems.length) return '对账通过：自述与账本一致'
  return problems.map((p) => `${p.level === 'red' ? '🔴' : '🟡'} ${p.type}：${p.detail}`).join('\n')
}
