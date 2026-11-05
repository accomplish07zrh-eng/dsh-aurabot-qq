// 自驱引擎 · 接线层（P1/P2，docs/AUTOTELIC-PLAN.md §3）。
// 心跳 tick（每分钟判定「该不该立项」）+ 零副作用 preview + 便宜模型自评（可关）
// + P2：推进一步（L1 分级执行器）、每日一页、做梦、tune（带上限钳制）。
//
// 防重入（§4.5）：purpose 靠 hub 被动防抖，这里必须自己实现——模块级 running 标记，
// finally 里复位；running 时 tick 直接跳过（记 skipped-busy）。别学 purpose 的被动方式。
//
// 安静时段（§4.6）：只禁「打扰主人」（P4 的发言前判定用），不禁「她自己做事」——
// 所以立项 / 做事在安静时段照常跑，夜里消耗照常记账（每日一页单列一行）。
//
// 瞬态退避（2026-11-05）：hub 的后台会话冷却/「等太久了」/「上一轮还没结束」都属瞬态——
// 她的做事回合、purpose、diary 共享同一批后台会话窗，撞车是常态，不算她把事办砸了。

/** 瞬态失败特征（hub 的后台会话冷却 / 等太久 / 上一轮没结束）。 */
const TRANSIENT_RE = /冷却|等太久|还没结束/

import { gatherMaterials, proposeTasks, mergeModelScores, buildScreenPrompt, parseScreenVerdicts, trivialWhy } from './engine.js'
import { createBook } from './book.js'
import { inQuietHours } from '../purpose/engine.js'
import {
  reviewDue, buildDailyPage, dreamDue, distillDream, writeReflection, createJournal, dayKey as dayKeyOf,
} from './reflect.js'

/** 预审否决的记忆冷却（2026-11-05 少爷定）：同一句废话别每分钟反复送审。默认 6 小时。 */
const SCREEN_VETO_COOL_MS = 6 * 3600_000

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
 * @param {(prompt:string, opts:object)=>Promise<string>} [o.screenTurn] 立项前预审回合；
 *   没配 evalModel 时用**主模型**跑（默认复用 evalTurn 的接线；测试注入 fake）
 */
export function createRuntime({ settings, cfg = {}, hub = {}, memoryOf = null, personaName = '', ledgerFile = '', log, evalTurn = null, screenTurn = null, now = () => Date.now(), act = null, journal = null, auditNote = null, auditStat = null } = {}) {
  let running = false
  let book = null
  let bookLimits = ''
  let currentTaskId = '' // 正在办的任务（做事回合期间非空；工具落盘文件用它打前缀，弹窗按前缀归账）

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
    // 同源冷却（2026-11-05 修「重复立项饿死引擎」）：做完/放弃的同源素材 7 天内不再立项，
    // blocked/failed 的 24 小时——「拆解刷B站原理」立 3 次、活跃坑被占满就是这么来的
    const at = now()
    const coolSourceIds = tasks
      .filter((t) => t.sourceId && t.status !== 'active')
      .filter((t) => {
        const age = at - (t.updatedAt || 0)
        return age < ((t.status === 'blocked' || t.status === 'failed') ? 24 : 168) * 3600_000
      })
      .map((t) => t.sourceId)
    const r = proposeTasks({
      materials,
      activeTasks: tasks.filter((t) => t.status === 'active'),
      recentTitles,
      coolSourceIds,
      // 预审否决过的素材在冷却期内不再送审（少爷定：同一句废话不许每分钟反复烧模型）
      screenCoolIds: bk.screenVetoes().filter((x) => at - (x.at || 0) < SCREEN_VETO_COOL_MS).map((x) => x.id),
      minCuriosity: s.minCuriosity,
      maxCandidates: Number(s.maxCandidates) || 3,
      now: at,
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

  /**
   * 【立项前预审】（2026-11-05 少爷定）：进待办之前先判值不值得办。
   * 工作间里她自己的自审靠不住——立项后她看的是自己立的题，天然会给自己找理由
   * （真机账本：把「我刚安装dsh那天就有」判成「完整整句，非寒暄，值得做」放行了）。
   * 所以再往前挪一道：**审查员视角、进账本之前**，不值得的直接不立项，记冷却 + 审计。
   *
   * 模型不可用（回合失败 / 回包解析不出来）时**不默认放行**：本地启发式能判定的直接否掉，
   * 判不出来的**押到下一拍**（deferred），宁可晚一轮，也别偷偷放一句废话进待办。
   * @param {object[]} candidates proposeTasks 的候选
   * @returns {Promise<{kept:object[], vetoed:object[], deferred:object[]}>}
   */
  async function screenCandidates(candidates = []) {
    if (!candidates.length) return { kept: [], vetoed: [], deferred: [] }
    const bk = bookFor()
    const veto = (c, why) => {
      bk.screenVeto({ id: c.sourceId || c.title, title: c.title, why })
      auditNote?.({ kind: 'autotelic/screen', tool: 'pre-review', args: { task: c.title }, outcome: why })
    }
    const model = parseEvalModel(settings().evalModel)
    let verdicts = null
    // 预审这条不能依赖「主人配了便宜模型」——真机上 evalModel 是空的（少爷没配），
    // 那样预审就永远走本地启发式、等于没装闸。所以没配便宜模型时用**主模型**审：
    // 代价是每个候选多一次主模型后台回合，但它是「进待办前」的唯一一道语义闸。
    const turn = typeof screenTurn === 'function' ? screenTurn : (model && typeof evalTurn === 'function' ? evalTurn : null)
    if (!turn) log?.warn?.('自驱：立项前预审没接线（没有 screenTurn / evalTurn），这轮候选全部押后——检查模块接线')
    if (turn) {
      try {
        const opts = model ? { model, timeoutMs: 60000 } : { timeoutMs: 60000, noTools: true, key: 'screen' }
        verdicts = parseScreenVerdicts(await turn(buildScreenPrompt(candidates), opts))
      } catch (error) { log?.debug?.('自驱：立项前预审回合失败，押后或本地判：', error?.message) }
    }
    const kept = []
    const vetoed = []
    const deferred = []
    candidates.forEach((c, idx) => {
      // 模型给了裁决就按裁决；没给（或这条没评到）→ 本地兜底；本地再判不出来就**押后**，
      // 绝不当成「值得」放行——闸失效等于没装闸（2026-11-05 少爷口径）。
      let worth = null
      let why = ''
      if (verdicts) {
        const v = verdicts.find((x) => x.i === idx + 1)
        if (v) { worth = v.worth; why = v.why }
      }
      if (worth === null) {
        const local = trivialWhy(c.title)
        if (local) { worth = false; why = local }
      }
      if (worth === null) { deferred.push({ ...c, why: '预审这轮没给出裁决（模型不可用或没评到），押到下一拍再审' }); return }
      if (worth) { kept.push(c); return }
      const reason = why || '预审判这件事不值得办'
      vetoed.push({ ...c, why: `立项前预审否决：${reason}` })
      veto(c, reason)
    })
    if (vetoed.length) log?.info?.(`自驱：立项前预审否决 ${vetoed.length} 条（${vetoed.map((v) => v.title).join('、')}）`)
    if (deferred.length) log?.debug?.(`自驱：预审没裁决 ${deferred.length} 条，押到下一拍`)
    return { kept, vetoed, deferred }
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
      let noWhy = ''
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
        // 【立项前预审】（2026-11-05 少爷定）：值不值得办，进账本之前就判掉——
        // 别等立项了再让她在工作间里自审（自己审自己靠不住，真机已证）。
        const screened = await screenCandidates(candidates)
        const kept = screened.kept
        const added = []
        if (screened.vetoed.length) detail.vetoed = screened.vetoed.map((v) => ({ title: v.title, why: v.why }))
        if (screened.deferred.length) detail.deferred = screened.deferred.map((v) => ({ title: v.title, why: v.why }))
        for (const c of kept) {
          const r = bk.addTask(c)
          if (r.ok) added.push({ id: r.task.id, title: r.task.title, score: r.task.score, reason: r.task.reason })
          else { log?.debug?.(`自驱：候选「${c.title}」没立项：${r.why}`); noWhy = noWhy || r.why }
        }
        // 场景 7 与「活跃已满」分开标注：预算见底 ≠ 手头满了；
        // 「全被预审否决」与「预审没裁决押后」也各自单独标注，面板能看出卡在哪一道。
        outcome = added.length
          ? 'proposed'
          : (kept.length === 0 && screened.vetoed.length ? 'screened-out'
            : (kept.length === 0 && screened.deferred.length ? 'screen-deferred'
              : (/活跃任务已满/.test(noWhy || '') ? 'active-full' : 'skipped-budget')))
        detail = { ...detail, added, rejected: rejected.length }
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
    currentTaskId = task.id // 这期间她的工具调用能对上「现在是在给哪条任务做事」（notes 前缀等）
    try {
    const r = await act.runStep(task, stepDesc)
    // 【进工作间自审】2026-11-05 少爷定：进工作间第一件事由模型判断「这事值不值得做」，
    // 不值得就由她回报 abandon → 任务直接关掉（不算失败、不写反思、不重复烧预算）。
    // 提示词在 exec.buildActPrompt 里；这条接住她的否决。
    if (r.abandon) {
      bk.recordAction() // 这一轮确实起了回合，仍占一次动作预算
      const why = String(r.why || r.observation || '她判断这事不值得做').slice(0, 200)
      bk.close(task.id, 'abandoned', `进工作间自审不通过：${why}`)
      auditNote?.({ kind: 'autotelic/abandon', tool: 'self-review', args: { task: task.title }, outcome: why })
      log?.info?.(`自驱：「${task.title}」进工作间后自审不通过，关掉 —— ${why}`)
      return { outcome: 'act-abandoned', taskId: task.id, why }
    }
    // 瞬态退避（2026-11-05 修「冷却中冤死」）：后台会话冷却/超时这类瞬态失败不算步失败——
    // 不计 attempts、不进熔断指纹，退回 pending 下个心跳自然重试。
    // （真机账本：4 个 blocked 里 3 个是「后台会话冷却中/等太久了」，全属冤死。）
    if (!r.ok && TRANSIENT_RE.test(String(r.observation || '') + String(r.error || ''))) {
      bk.releaseStep(task.id, `瞬态退避：${String(r.observation || '').slice(0, 80)}`)
      log?.info?.(`自驱：「${task.title}」撞上后台瞬态，这步退回待办，下轮再试`)
      return { outcome: 'act-backoff', taskId: task.id, hadTools: r.hadTools }
    }
    // 2026-11-05 修「一小时动二十多次」（少爷真机反馈）：做事回合一律记账——
    // 原口径 L0 回合不占预算，等于「想」不要钱，心跳每分钟推一步就免费无限跑。
    // 现在每个做事回合都占预算，预算到顶自然停，等下一小时。
    bk.recordAction() // 做事回合（含 L0）都占动作预算：预算是「她这一小时动了几次」，不是「她花了多少工具调用」
    // 死循环熔断（场景 6）：同任务同「步骤+观察」第 2 次 → abandoned
    const loop = bk.guardLoop(task.id, `${stepDesc.desc}|${r.observation}`)
    if (loop.abandoned) { log?.info?.(`自驱：「${task.title}」死循环熔断`); return { outcome: 'loop-broken', taskId: task.id } }
    const end = bk.endStep(task.id, { ok: r.ok, why: r.ok ? '' : String(r.observation || '').slice(0, 120), observation: r.observation })
    // 反思（P2.4）：任务到终态就写「假设/证据/教训」进记忆
    const nowTask = bk.list().find((t) => t.id === task.id)
    let reflected = false
    if (nowTask && ['done', 'failed', 'blocked', 'abandoned'].includes(nowTask.status)) {
      const w = writeReflection(memoryOf?.(), nowTask, r.memo || r, log)
      reflected = w.ok
    }
    if (manual || !r.ok) log?.info?.(`自驱：「${task.title}」这步${r.ok ? '办完了' : '没办成'}${r.hadTools ? '（带工具）' : '（只想）'}`)
    return { outcome: r.ok ? 'step-done' : 'step-failed', taskId: task.id, hadTools: r.hadTools, reflected, taskStatus: end.taskStatus }
    } finally {
      currentTaskId = '' // 做事回合结束就摘掉当前任务标记，别让下一轮的工具误挂到这条上
    }
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
    get currentTaskId() { return currentTaskId },
    isQuietNow: (at = now()) => isQuietNow(settings(), at),
  }
}
