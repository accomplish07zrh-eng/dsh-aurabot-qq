// 自驱引擎 · 接线层（P1，docs/AUTOTELIC-PLAN.md §3 P1 / §4.5）。
// 心跳 tick（每分钟判定「该不该立项」）+ 零副作用 preview + 便宜模型自评（可关）。
//
// 防重入（§4.5）：purpose 靠 hub 被动防抖，这里必须自己实现——模块级 running 标记，
// finally 里复位；running 时 tick 直接跳过（记 skipped-busy）。别学 purpose 的被动方式。
//
// 安静时段（§4.6）：只禁「打扰主人」（P4 的发言前判定用），不禁「她自己做事」——
// 所以 P1 的立项在安静时段照常跑，夜里消耗照常记账。

import { gatherMaterials, proposeTasks, mergeModelScores } from './engine.js'
import { createBook } from './book.js'
import { inQuietHours } from '../purpose/engine.js'

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
export function createRuntime({ settings, cfg = {}, hub = {}, memoryOf = null, personaName = '', ledgerFile = '', log, evalTurn = null, now = () => Date.now() } = {}) {
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
      maxCandidates: 3,
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
      return { outcome, ...detail }
    } catch (error) {
      outcome = 'error'
      bk.heartbeat(outcome)
      log?.warn?.('自驱：这轮出错：', error?.message)
      return { outcome, error: error?.message }
    } finally {
      running = false
    }
  }

  return {
    tick,
    preview,
    book: bookFor,
    get running() { return running },
    isQuietNow: (at = now()) => isQuietNow(settings(), at),
  }
}
