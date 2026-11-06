// 自驱引擎 · 任务账本（P1.3，docs/AUTOTELIC-PLAN.md §3 P1）。
// 「事办成没有」的结算口径（讨论笔记 §1）：主人不参与也成立。
// 状态机：active → done / failed / blocked / abandoned；步数与预算有硬上限；重启恢复把在途改判 failed。
// 落盘 ledger.json（writeJson 原子写）；纯数据 + 注入式依赖，可单测。

import { randomUUID } from 'node:crypto'
import { readJson, writeJson } from '../core/store.js'

export const TASK_STATUSES = Object.freeze(['active', 'done', 'failed', 'blocked', 'abandoned'])
export const MAX_ACTIVE = 8 // 活跃 ≤8（§1.3）
export const MAX_TOTAL = 40 // 总量 ≤40（pruneLedger）

const nowOf = (o) => (typeof o.now === 'function' ? o.now() : Date.now())

/** 预审否决的记忆保留量（只用来挡住「同一句闲聊每轮反复送审」，不参与任何账）。 */
const MAX_SCREEN_VETO = 60

function normalize(raw) {
  const t = raw && typeof raw === 'object' ? raw : {}
  return {
    tasks: Array.isArray(t.tasks) ? t.tasks.filter((x) => x && TASK_STATUSES.includes(x.status)) : [],
    actions: Array.isArray(t.actions) ? t.actions.filter((n) => Number(n) > 0) : [], // 动作时间戳（预算用）
    ticks: Array.isArray(t.ticks) ? t.ticks.slice(-6) : [], // 最近 6 次心跳（§10.2 面板看节奏）
    lastTick: t.lastTick || null,
    // 立项前预审否决过的素材（2026-11-05 少爷定）：sourceId + 时间 + 理由
    screenVetoes: Array.isArray(t.screenVetoes) ? t.screenVetoes.filter((x) => x && x.id).slice(-MAX_SCREEN_VETO) : [],
  }
}

/**
 * 造一个账本。file 缺省就不落盘（纯内存，测试用）。
 * @param {object} o
 * @param {string} [o.file] ledger.json 路径
 * @param {()=>number} [o.now]
 * @param {number} [o.maxActive] 同时进行的任务上限（ext.autotelic.maxTasksActive）
 * @param {number} [o.maxSteps] 单任务步数上限（ext.autotelic.maxSteps）
 * @param {number} [o.actionsPerHour] 动作/小时预算（ext.autotelic.budgetActionsPerHour）
 * @param {object} [o.log]
 */
export function createBook({ file = '', now = () => Date.now(), maxActive = MAX_ACTIVE, maxSteps = 8, actionsPerHour = 12, log } = {}) {
  let state = normalize(file ? readJson(file, null) : null)

  const save = () => { if (file) { try { writeJson(file, state) } catch (error) { log?.warn?.('账本落盘失败：', error?.message) } } }
  const active = () => state.tasks.filter((t) => t.status === 'active')

  function pruneLedger() {
    // 活跃上限漂移的兜底（正常路径 addTask 会在超限时拒绝，见场景 7）
    const act = active()
    if (act.length > maxActive) {
      for (const t of act.slice(0, act.length - maxActive)) {
        t.status = 'abandoned'
        t.why = `活跃任务超过 ${maxActive} 个，最老的让位`
        t.updatedAt = nowOf({ now })
        dirty = true
      }
    }
    // 总量上限：从最老的已完结任务开始丢
    let terminal = state.tasks.filter((t) => t.status !== 'active')
    if (state.tasks.length > MAX_TOTAL) {
      terminal.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
      const drop = new Set(terminal.slice(0, state.tasks.length - MAX_TOTAL).map((t) => t.id))
      state.tasks = state.tasks.filter((t) => !drop.has(t.id))
    }
  }

  function restartRecovery() {
    // 重启恢复（验收场景 10）：running 的 step 改判 failed 按 attempts 重试；done 的不重跑
    for (const t of state.tasks) {
      for (const s of t.steps || []) {
        if (s.status === 'running') { s.status = 'failed'; s.why = '重启时还在途，改判失败等重试'; dirty = true }
      }
      if ((t.steps || []).some((s) => s.status === 'failed') && t.status === 'active') t.note = '有失败步待重试'
    }
  }
  let dirty = false
  restartRecovery()
  pruneLedger()
  if (dirty) save() // 只在真的改过状态才落盘：预览构造账本时不能产生 IO（P1.5 零副作用）

  return {
    /** 全量（面板用）。 */
    list() { return state.tasks.map((t) => ({ ...t, steps: (t.steps || []).map((s) => ({ ...s })) })) },
    activeCount: () => active().length,
    meta: () => ({ ticks: [...state.ticks], lastTick: state.lastTick, actions: state.actions.length, screenVetoes: state.screenVetoes.length }),

    /** 记一次心跳（面板「最近 6 次心跳间隔」用）。 */
    heartbeat(outcome = '', at = nowOf({ now })) {
      state.ticks = [...state.ticks, { at, outcome }].slice(-6)
      state.lastTick = { at, outcome }
      save()
    },

    /** 预算（§3 P1 验收 7）：最近一小时内动作数。 */
    actionsInLastHour(at = nowOf({ now })) {
      return state.actions.filter((n) => at - n < 3600_000).length
    },
    canStartTask(at = nowOf({ now })) {
      if (active().length >= maxActive) return { ok: false, why: `活跃任务已满 ${maxActive} 个` }
      if (this.actionsInLastHour(at) >= actionsPerHour) return { ok: false, why: `动作预算到顶（${actionsPerHour}/小时）` }
      return { ok: true }
    },
    /** 记一笔动作（预算口径：L1 及以上的「做了事」才算；L0 只想不算）。 */
    recordAction(at = nowOf({ now })) {
      state.actions = [...state.actions.filter((n) => at - n < 3600_000), at]
      save()
    },

    /** 立项（验收 4）：reason 必填，至少 1 条 todo；预算不够就拒。 */
    addTask({ title, reason, score = 0, todos = [], sourceId = '' }) {
      if (!title || !reason) return { ok: false, why: 'title 和 reason 都必填（防拍脑袋）' }
      const gate = this.canStartTask()
      if (!gate.ok) return { ok: false, why: gate.why }
      const at = nowOf({ now })
      const task = {
        id: randomUUID().slice(0, 8),
        title: String(title).slice(0, 80),
        reason: String(reason).slice(0, 300),
        score: Number(score) || 0,
        sourceId: String(sourceId || ''),
        status: 'active',
        steps: (todos.length ? todos : [{ desc: '只读了解', level: 'L0' }]).map((x) => ({
          desc: String(x.desc || x).slice(0, 200),
          level: x.level || 'L0',
          status: 'pending',
          attempts: 0,
          fingerprint: '',
          why: '',
        })),
        createdAt: at,
        updatedAt: at,
      }
      state.tasks.push(task)
      pruneLedger()
      save()
      return { ok: true, task: { ...task, steps: task.steps.map((s) => ({ ...s })) } }
    },

    /** 开一步：pending → running。步数超上限拒绝（C5 上限钳制）。 */
    beginStep(taskId) {
      const t = state.tasks.find((x) => x.id === taskId && x.status === 'active')
      if (!t) return { ok: false, why: '任务不在进行中' }
      const s = (t.steps || []).find((x) => x.status === 'pending' || (x.status === 'failed' && x.attempts < 2))
      if (!s) return { ok: false, why: '没有可开下一步' }
      if ((t.steps || []).filter((x) => x.status !== 'pending').length >= maxSteps) return { ok: false, why: `步数到上限 ${maxSteps}` }
      s.status = 'running'
      s.attempts = (s.attempts || 0) + 1
      s.startedAt = nowOf({ now })
      t.updatedAt = s.startedAt
      save()
      return { ok: true, step: { ...s } }
    },

    /** 步结束：done / failed（失败 2 次任务 blocked，验收 5）。 */
    endStep(taskId, { ok = true, why = '', observation = '' } = {}) {
      const t = state.tasks.find((x) => x.id === taskId)
      if (!t) return { ok: false, why: '没有这个任务' }
      const s = (t.steps || []).find((x) => x.status === 'running')
      if (!s) return { ok: false, why: '没有在途的步' }
      s.status = ok ? 'done' : 'failed'
      s.why = String(why || '').slice(0, 200)
      s.observation = String(observation || '').slice(0, 300)
      t.updatedAt = nowOf({ now })
      if (!ok && s.attempts >= 2) {
        t.status = 'blocked'
        t.why = `同一步失败 ${s.attempts} 次：${s.why}`
      }
      if (ok && (t.steps || []).every((x) => x.status === 'done')) t.status = 'done'
      save()
      return { ok: true, taskStatus: t.status }
    },

    /** 瞬态退避（2026-11-05 修「冷却中冤死」）：后台会话冷却/超时这类瞬态失败，
     *  把 running 的步退回 pending、退一次失败计数——不占熔断指纹，也不该把任务憋成 blocked。
     *  （真机账本：4 个 blocked 里 3 个是「后台会话冷却中/等太久了」这种瞬态，属冤死。） */
    releaseStep(taskId, why = '') {
      const t = state.tasks.find((x) => x.id === taskId)
      if (!t) return { ok: false, why: '没有这个任务' }
      const s = (t.steps || []).find((x) => x.status === 'running')
      if (!s) return { ok: false, why: '没有在途的步' }
      s.status = 'pending'
      s.attempts = Math.max(0, (s.attempts || 1) - 1)
      s.startedAt = 0
      s.why = String(why || '').slice(0, 200)
      t.updatedAt = nowOf({ now })
      save()
      return { ok: true }
    },

    /**
     * 死循环熔断（P1.4，验收 6）：对 (tool,args,observation) 算指纹，同任务内同指纹第 2 次 → abandoned。
     * @returns {{looped:boolean, abandoned:boolean}}
     */
    guardLoop(taskId, fingerprint) {
      const t = state.tasks.find((x) => x.id === taskId && x.status === 'active')
      if (!t) return { looped: false, abandoned: false }
      const fp = String(fingerprint || '')
      t.fingerprints = [...(t.fingerprints || []), fp]
      const hits = t.fingerprints.filter((x) => x === fp).length
      if (hits >= 2) {
        t.status = 'abandoned'
        t.why = `死循环熔断：同指纹出现 ${hits} 次`
        t.updatedAt = nowOf({ now })
        save()
        return { looped: true, abandoned: true }
      }
      save()
      return { looped: hits >= 2, abandoned: false }
    },

    /** 手动关闭一个任务（面板 / 提案用）。 */
    close(taskId, status = 'abandoned', why = '') {
      const t = state.tasks.find((x) => x.id === taskId)
      if (!t) return { ok: false, why: '没有这个任务' }
      t.status = TASK_STATUSES.includes(status) ? status : 'abandoned'
      t.why = String(why || '').slice(0, 200)
      t.updatedAt = nowOf({ now })
      pruneLedger()
      save()
      return { ok: true }
    },

    /**
     * 记一笔「立项前预审否决」（2026-11-05 少爷定）：只用来让同一句废话别每轮反复送审，不参与账。
     * 2026-11-06 加 fp（归一化文本指纹）：同一句话从流水里再采出来 sourceId 会变（带时间戳），
     * 冷却按 id 记挡不住「群友复读/闲聊刷屏」，指纹才挡得住。
     * @param {{id:string, why?:string, title?:string, fp?:string}} o
     */
    screenVeto({ id, why = '', title = '', fp = '' } = {}) {
      const sid = String(id || '')
      if (!sid && !String(fp || '')) return { ok: false }
      const at = nowOf({ now })
      const fresh = { id: sid, fp: String(fp || '').slice(0, 32), why: String(why).slice(0, 160), title: String(title).slice(0, 80), at }
      state.screenVetoes = [...state.screenVetoes.filter((x) => x.id !== sid || (!sid && x.fp === fresh.fp)), fresh].slice(-MAX_SCREEN_VETO)
      save()
      return { ok: true }
    },

    /** 预审否决过的素材 id 列表（冷却由调用方按时间判，这里只给数据）。 */
    screenVetoes() { return state.screenVetoes.map((x) => ({ ...x })) },

    /** 否决指纹是否还在冷却期内（2026-11-06：同文本 48 小时内直接本地否，不调模型）。 */
    screenFingerprintHot(fp, coolMs) {
      const f = String(fp || '')
      if (!f) return false
      const at = nowOf({ now })
      return state.screenVetoes.some((x) => x.fp === f && at - (x.at || 0) < coolMs)
    },

    /** 面板状态汇总。 */
    summary() {
      const by = { active: 0, done: 0, failed: 0, blocked: 0, abandoned: 0 }
      for (const t of state.tasks) by[t.status] = (by[t.status] || 0) + 1
      return { ...by, total: state.tasks.length, actionsLastHour: this.actionsInLastHour(), maxActive, maxSteps, actionsPerHour, ...this.meta() }
    },

    /** 测试用：强制落盘。 */
    save,
  }
}
