// 自驱引擎 · 接线层（P1/P2，docs/AUTOTELIC-PLAN.md §3）。
// 心跳 tick（每分钟判定「该不该立项」）+ 零副作用 preview + 便宜模型自评（可关）
// + P2：推进一步（L1 分级执行器）、每日一页、做梦、tune（带上限钳制）。
//
// 防重入（§4.5）：purpose 靠 hub 被动防抖，这里必须自己实现——模块级 running 标记，
// finally 里复位；running 时 tick 直接跳过（记 skipped-busy）。别学 purpose 的被动方式。
//
// 安静时段（§4.6）：只禁「打扰主人」（P4 的发言前判定用），不禁「她自己做事」——
// 所以立项 / 做事在安静时段照常跑，夜里消耗照常记账（每日一页单列一行）。

import { gatherMaterials, proposeTasks, mergeModelScores } from './engine.js'
import { createBook } from './book.js'
import { inQuietHours } from '../purpose/engine.js'
import {
  reviewDue, buildDailyPage, dreamDue, distillDream, writeReflection, createJournal, dayKey as dayKeyOf,
} from './reflect.js'

/** 解析 'provider/model' 形式的便宜模型配置（留空 = 关闭自评）。 */
export function parseEvalModel(v) {
  const s = String(v || '').trim()
  if (!s || !s.includes('/')) return null
  const [provider, ...rest] = s.split('/')
  const model = rest.join('/')
  return provider && model ? { provider, model } : null
}

/** 安静时段判定（§4.6：必须自己判，不能指望 outbound 治理——两者窗口不同）。留空 = 不启用安静时段。 */
export function quietConfig(settings) {
  const s = settings || {}
  return { quietStart: String(s.quietFrom || '').trim(), quietEnd: String(s.quietTo || '').trim() }
}
export function isQuietNow(settings, at = Date.now()) {
  const c = quietConfig(settings)
  if (!c.quietStart || !c.quietEnd) return false // 留空 = 关闭（不借 purpose 的 23:30/08:30 兜底）
  return inQuietHours(new Date(at), c)
}

/**
 * 造运行时。
 * @param {object} o
 * @param {()=>object} o.settings 模块设置（ext.autotelic + defaults 合并）
 * @param {object} o.hub 插件 hub（chatLogDays / chatLogOf / runSystemTurn）
 * @param {object} o.cfg 插件配置（ownerQQ 等）
 * @param {()=>object[]} [o.memoryOf] 记忆列表（memory 模块的 list('')）
 * @param {string} [o.personaName] 人格名（素材采集的 roleName）
 * @param {string} [o.ledgerFile] ledger.json 路径
 * @param {object} [o.log]
 * @param {(prompt:string, opts:object)=>Promise<string>} [o.evalTurn] 便宜模型自评回合（测试注入 fake）
 */
export function createRuntime({ settings, cfg = {}, hub = {}, memoryOf = null, personaName = '', ledgerFile = '', log, evalTurn = null, now = () => Date.now(), act = null, journal = null, auditNote = null, auditStat = null } = {}) {
  let running = false
  let book = null
  let bookLimits = ''

  /** 记忆列表（memory 模块没开 / 抛错都按空处理，采集继续）。 */
  function memoryRecordsOf(mem) {
    try { return mem?.list?.('') || [] } catch (error) { log?.debug?.('素材采集（记忆）失败：', error?.message); return [] }
  }

  /** 账本（主人改了上限配置就重建，账不丢——同一文件接着读）。 */
  function bookFor() {
    const s = settings()
    const key = `${s.maxTasksActive}|${s.maxSteps}|${s.budgetActionsPerHour}`
    if (!book || key !== bookLimits) {
      bookLimits = key
      book = createBook({
        file: ledgerFile,
        maxActive: s.maxTasksActive,
        maxSteps: s.maxSteps,
        actionsPerHour: s.budgetActionsPerHour,
        log,
        now,
      })
    }
    return book
  }

  /** 素材采集（§3 P1.1：自己写——purpose 的 conversations()/memoryRecords() 没导出）。 */
  function collect() {
    const per = new Map()
    try {
      const days = hub.chatLogDays?.() || []
      const ownerKey = cfg.ownerQQ ? `private:${String(cfg.ownerQQ).replace(/[^\d]/g, '')}` : ''
      for (const day of (days || []).slice(-2)) {
        for (const e of hub.chatLogOf?.(day) || []) {
          if (!e?.chatId || e.forgottenAt) continue
          // 只看主人私聊和群聊（她的独立会话不进素材，自言自语不该自我强化）
          if (!ownerKey || (e.chatId !== ownerKey && !String(e.chatId).startsWith('group:'))) continue
          let c = per.get(e.chatId)
          if (!c) { c = { key: e.chatId, recentMessages: [], activeTopics: [], pendingThoughts: [] }; per.set(e.chatId, c) }
          c.recentMessages.push({
            text: String(e.text || ''),
            time: Number(e.t) || 0,
            isSelf: e.who === 'bot',
            isOwner: e.chatId === ownerKey && e.who !== 'bot',
            sender: e.who === 'bot' ? '你' : String(e.uid || '群友'),
          })
        }
      }
    } catch (error) { log?.debug?.('素材采集（聊天）失败：', error?.message) }
    const memories = memoryRecordsOf(memoryOf)
    const name = typeof personaName === 'function' ? String(personaName() || '') : String(personaName || '')
    const memoryRecords = memories
      .filter((m) => m && !m.invalidAt && m.text && !['hearsay', 'guess'].includes(m.status))
      .map((m) => ({ id: m.id, title: '', text: String(m.text), importance: Math.round((Number(m.importance) || 0) * 100), emotional: 0, lastSeenAt: m.lastHit || m.at, createdAt: m.at, pinned: false, anchor: false, isInitial: false }))
    return gatherMaterials({ conversations: [...per.values()], memoryRecords, roleName: name, ownerQQ: cfg.ownerQQ, now: now() })
  }

  /**
   * 好奇判分（不打分不落盘的部分，preview 和 tick 共用）。
   * @returns {{materials, candidates, rejected}}
   */
  function appraise() {
    const s = settings()
    const bk = bookFor()
    const materials = collect()
    const tasks = bk.list()
    const recentTitles = tasks.slice(-12).map((t) => t.title)
    const r = proposeTasks({
      materials,
      activeTasks: tasks.filter((t) => t.status === 'active'),
      recentTitles,
      minCuriosity: s.minCuriosity,
      maxCandidates: Number(s.maxCandidates) || 3,
      now: now(),
    })
    return { materials, ...r, book: bk }
  }

  /** 零副作用预览（P1.5，验收 2/3）：今天会立什么项、为什么、分数多少。不调模型、不落盘。 */
  function preview() {
    const { materials, candidates, rejected, lastOutcome } = appraise()
    return {
      ok: true,
      enabled: !!settings().enabled,
      outcome: lastOutcome,
      materialCount: materials.length,
      candidates,
      rejected: rejected.slice(0, 12),
      thresholds: { minCuriosity: Number(settings().minCuriosity) },
    }
  }

  /** 心跳（§4.5）：每分钟判定该不该立项；立项落账。返回 tick 结局（面板心跳节奏用）。 */
  async function tick({ manual = false } = {}) {
    const s = settings()
    if (!s.enabled) return { outcome: 'disabled' } // 场景 1：关着不做任何 IO
    if (running) { log?.info?.('自驱：上一轮还没结束，这轮跳过'); return { outcome: 'skipped-busy' } }
    running = true
    const bk = bookFor()
    let outcome = 'idle'
    let detail = {}
    try {
      const { materials, candidates, rejected, lastOutcome } = appraise()
      if (!materials.length) outcome = 'skipped-no-material' // 场景 2
      else if (!candidates.length) outcome = lastOutcome // 场景 3：低于阈值，素材留池
      else {
        // 便宜模型自评（可关）：一次后台回合微调分数；失败静默回退公式分
        const model = parseEvalModel(s.evalModel)
        if (model && typeof evalTurn === 'function') {
          try {
            const lines = candidates.map((c, i) => `${i + 1}. ${c.title}（${c.reason}）`).join('\n')
            const prompt = [
              '下面是自驱引擎想立项的方向。给每个方向评一个好奇心（0~1，一位小数）：越值得花她自己的时间去弄清楚越高。',
              '只输出 JSON 数组，不要解释：[{"i":1,"curiosity":0.7}, …]', '',
              lines,
            ].join('\n')
            const raw = await evalTurn(prompt, { model, timeoutMs: 60000 })
            const m = String(raw || '').match(/\[[\s\S]*\]/)
            if (m) mergeModelScores(JSON.parse(m[0]), candidates).forEach((c, i) => { if (c && candidates[i]) candidates[i] = c })
          } catch (error) { log?.debug?.('自驱：模型自评失败，用公式分：', error?.message) }
        }
        const added = []
        for (const c of candidates) {
          const r = bk.addTask(c)
          if (r.ok) added.push({ id: r.task.id, title: r.task.title, score: r.task.score, reason: r.task.reason })
          else log?.debug?.(`自驱：候选「${c.title}」没立项：${r.why}`)
        }
        outcome = added.length ? 'proposed' : 'skipped-budget' // 场景 7：预算超限不开新坑
        detail = { added, rejected: rejected.length }
      }
      bk.heartbeat(outcome)
      if (outcome === 'proposed') log?.info?.(`自驱：立项 ${detail.added.length} 个（${detail.added.map((a) => a.title).join('、')}）`)
      else if (manual) log?.info?.(`自驱（手动）：${outcome}`)
      // P2：心跳的下半场——推进一步、复盘、做梦（都在防重入保护里，慢也不叠轮）
      const acted = s.allowAct ? await stepOnce() : { outcome: 'act-disabled' }
      const journalR = await review()
      return { outcome, ...detail, acted, journal: journalR }
    } catch (error) {
      outcome = 'error'
      bk.heartbeat(outcome)
      log?.warn?.('自驱：这轮出错：', error?.message)
      return { outcome, error: error?.message }
    } finally {
      running = false
    }
  }

  /**
   * 推进一步（P2.1，L1）：最老的活跃任务的开头一步，一轮做事回合。
   * 失败 2 次自动 blocked（账本管）；同指纹 2 次熔断（guardLoop）；结束写反思进记忆。
   */
  async function stepOnce({ manual = false } = {}) {
    const s = settings()
    if (!s.enabled || !s.allowAct) return { outcome: 'act-disabled' }
    if (typeof act?.runStep !== 'function') return { outcome: 'act-unavailable' }
    const bk = bookFor()
    const task = bk.list().find((t) => t.status === 'active' && (t.steps || []).some((x) => x.status === 'pending' || (x.status === 'failed' && x.attempts < 2)))
    if (!task) return { outcome: 'no-step' }
    const begin = bk.beginStep(task.id)
    if (!begin.ok) return { outcome: 'no-step', why: begin.why }
    const stepDesc = (task.steps || []).find((x) => ['running'].includes(x.status)) || begin.step || { desc: '', level: 'L0' }
    const r = await act.runStep(task, stepDesc)
    if (r.hadTools) bk.recordAction() // L1 记账：带工具的做事回合才占动作预算（L0 只想不算）
    // 死循环熔断（场景 6）：同任务同「步骤+观察」第 2 次 → abandoned
    const loop = bk.guardLoop(task.id, `${stepDesc.desc}|${r.observation}`)
    if (loop.abandoned) { log?.info?.(`自驱：「${task.title}」死循环熔断`); return { outcome: 'loop-broken', taskId: task.id } }
    const end = bk.endStep(task.id, { ok: r.ok, why: r.ok ? '' : String(r.observation || '').slice(0, 120), observation: r.observation })
    // 反思（P2.4）：任务到终态就写「假设/证据/教训」进记忆
    const nowTask = bk.list().find((t) => t.id === task.id)
    let reflected = false
    if (nowTask && ['done', 'failed', 'blocked', 'abandoned'].includes(nowTask.status)) {
      const w = writeReflection(memoryOf(), nowTask, r.memo || r, log)
      reflected = w.ok
    }
    if (manual || !r.ok) log?.info?.(`自驱：「${task.title}」这步${r.ok ? '办完了' : '没办成'}${r.hadTools ? '（带工具）' : '（只想）'}`)
    return { outcome: r.ok ? 'step-done' : 'step-failed', taskId: task.id, hadTools: r.hadTools, reflected, taskStatus: end.taskStatus }
  }

  /**
   * 复盘：每日一页（P2.5）+ 做梦（P2.7）。各自一天一次的判定，都不额外打断。
   * @returns {{daily?:string, dream?:boolean}}
   */
  async function review() {
    const s = settings()
    if (!journal) return {}
    const bk = bookFor()
    const out = {}
    // —— 每日一页 ——
    const day = dayKeyOf(now())
    const tasks = bk.list()
    const closedToday = tasks.filter((t) => ['done', 'failed', 'blocked', 'abandoned'].includes(t.status) && dayKeyOf(t.updatedAt || now()) === day).length
    const due = reviewDue({ settings: s, tasks, closedToday, at: now(), writtenToday: journal.exists('daily', day) })
    if (due.due) {
      const hush = await cheapSay(
        '写「今天没敢说的」：一段话，可以含糊、可以主观、可以敷衍——这段必须在，但内容不约束。真的没有就写「今天没什么没敢说的」。',
        '（今天没什么没敢说的。）',
      )
      const page = buildDailyPage({ date: day, tasks, actionsToday: auditTodayCount(), hushText: hush })
      journal.write('daily', day, page)
      auditNote?.({ kind: 'autotelic/daily', args: { day, tasks: tasks.length }, outcome: due.why })
      out.daily = day
    }
    // —— 做梦 ——
    if (dreamDue({ settings: s, at: now(), doneToday: journal.exists('dreams', day) })) {
      const todayTasks = tasks.filter((t) => dayKeyOf(t.updatedAt || now()) === day)
      const lines = await cheapSay(
        [
          '把今天办的事、卡住的事、写过的反思，蒸馏成 3~5 条长期记忆。一行一条，',
          '每条以「- 」开头，别超过 40 字。要的是「下次用得上的判断」，不是流水账。', '',
          ...todayTasks.slice(-12).map((t) => `- ${t.title} → ${t.status}${t.why ? `（${t.why}）` : ''}`),
        ].join('\n'),
        '',
      )
      const drops = distillDream({ tasks: todayTasks, auditToday: auditTodayCount(), modelText: lines })
      let saved = 0
      for (const line of drops.slice(0, 5)) {
        try {
          memoryOf()?.addEvent?.({ text: `【自驱·梦】${line}`, tags: ['自驱', '梦'], importance: 0.5, kind: 'seen' })
          saved++
        } catch (error) { log?.debug?.('自驱：梦没写进记忆：', error?.message) }
      }
      journal.write('dreams', day, drops.map((l) => `- ${l}`).join('\n'))
      auditNote?.({ kind: 'autotelic/dream', args: { day, distilled: drops.length, saved }, outcome: '做梦本身也进审计（§10.1）' })
      out.dream = saved > 0
      log?.info?.(`自驱：做梦完成，蒸馏 ${saved} 条进记忆`)
    }
    return out
  }

  /** 便宜模型说一段话（evalModel 配了才真调；没配或失败回退 fallback 文本）。 */
  async function cheapSay(prompt, fallback) {
    const model = parseEvalModel(settings().evalModel)
    if (!model || typeof evalTurn !== 'function') return fallback
    try {
      const raw = await evalTurn(prompt, { model, timeoutMs: 60000, noTools: true, key: 'say' })
      return String(raw || '').trim() || fallback
    } catch (error) { log?.debug?.('自驱：便宜模型没答上来，用兜底：', error?.message); return fallback }
  }

  /** 今日审计条数（做梦 / 每日一页的「消耗单列一行」用；读不到就 0）。 */
  function auditTodayCount() {
    try { return Number(auditStat?.().today) || 0 } catch { return 0 }
  }

  /**
   * 她自己调参数（P2.6，C5）：白名单键 + 上限钳制。调用方负责写配置与审计。
   * @returns {{ok:boolean, applied:object, rejected:object, why?:string}}
   */
  function tune(patch = {}, { by = 'she' } = {}) {
    const s = settings()
    const applied = {}
    const rejected = {}
    const num = (v, min, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : null }
    const clock = (v) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(v).trim()); if (!m) return null; const hh = Number(m[1]); const mm = Number(m[2]); return hh <= 23 && mm <= 59 ? `${m[1]}:${m[2]}` : null }
    const rules = {
      // 可调子集（§2.2）：节奏随便调（有合法域）；上限类只能向下
      quietFrom: (v) => clock(v),
      quietTo: (v) => clock(v),
      dailyReviewHour: (v) => num(v, 0, 23),
      minBatchForReview: (v) => num(v, 1, 20),
      maxCandidates: (v) => num(v, 1, s.maxCandidates), // 只能向下（默认值就是上限）
      maxSteps: (v) => num(v, 1, s.maxSteps), // 向下钳制：上限值她调不动
      budgetActionsPerHour: (v) => num(v, 1, s.budgetActionsPerHour), // 同上
    }
    for (const [k, v] of Object.entries(patch || {})) {
      if (!rules[k]) { rejected[k] = '不在她可调的白名单里'; continue }
      const clamped = rules[k](v)
      if (clamped == null) { rejected[k] = '格式或范围不对'; continue }
      applied[k] = clamped
    }
    if (!Object.keys(applied).length) return { ok: false, applied, rejected, why: '没有可应用的改动' }
    return { ok: true, applied, rejected, by }
  }

  return {
    tick,
    step: stepOnce,
    review,
    tune,
    preview,
    book: bookFor,
    get running() { return running },
    isQuietNow: (at = now()) => isQuietNow(settings(), at),
  }
}
