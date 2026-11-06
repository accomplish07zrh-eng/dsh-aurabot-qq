// 自驱引擎 · 反思 / 每日一页 / 做梦（P2.4~P2.7，docs/AUTOTELIC-PLAN.md §3 P2、§10.1）。
//
// 反思（P2.4）：任务结束写「假设 / 证据 / 教训」进 memory.addEvent——这是她给自己攒本事的路。
// 每日一页（P2.5）：dailyReviewHour 或攒够 minBatchForReview 件触发；强制含「今天没敢说的」
//   段落——这一段必须在（缺了就是没写完整），但内容不约束（允许含糊、主观、敷衍，§5 第 2 问）。
//   夜里消耗在每日一页单列一行记数，不需要她解释。
// 做梦（P2.7 / §10.1）：安静时段最深处触发一次离线整理，把当日审计摘要 + 失败任务 + 反思
//   蒸馏成 3~5 条长期记忆；做梦本身也进审计（她没法借着做梦悄悄干别的）。
//
// 「攒着评」的投递口是 P4 的事（走 api.proactive.submit）；这里只产出文本与落盘。

import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseClock } from '../purpose/engine.js'

const pad2 = (n) => String(n).padStart(2, '0')
export const dayKey = (at = Date.now()) => { const d = new Date(at); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }

/**
 * 反思文本（2026-11-05 修「记忆被截断」）：memory.addEvent 硬截 200 字（memory.js:600），
 * 旧格式「假设——…；证据——…；教训——…」光标签就吃掉大半，真正的结论被截掉。
 * 新口径：**结论先行**——把最值钱的判断放最前面，假设/证据压成半句，格式标签只留一个。
 * 各段截断收紧（结论 90 / 证据 45 / 教训 45），保证 200 字内全文完整。
 */
export function reflectionText(task, memo = {}) {
  const cut = (s, n) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, n)
  const title = cut(task.title, 30)
  const lesson = cut(memo.lesson, 45)
  const evidence = cut(memo.evidence, 45)
  const hypothesis = cut(memo.hypothesis, 90)
  // 结论 = 教训优先（它是「下次怎么办」），没有教训就用假设顶上（它至少是个判断）
  const head = lesson || hypothesis || '（没写）'
  const rest = [lesson ? `依据：${evidence || hypothesis || '（没写）'}` : `当初想：${hypothesis || '（没写）'}`]
    .filter((x) => !/（没写）$/.test(x) || x.length > 12)
  return `【自驱】${title}（${task.status}）：${head}${rest.length ? '。' + rest.join('。') : ''}`
}

/** 反思进长期记忆（P2.4）。memory 没开就静默跳过（她攒本事的路断了，但不炸主流程）。 */
export function writeReflection(memory, task, memo = {}, log) {
  try {
    const text = reflectionText(task, memo)
    const r = memory?.addEvent?.({ text, tags: ['自驱', '反思'], importance: 0.45 })
    return { ok: Boolean(r?.id), text }
  } catch (error) {
    log?.debug?.('自驱：反思没写进记忆：', error?.message)
    return { ok: false, text: reflectionText(task, memo) }
  }
}

/**
 * 每日一页该不该出（攒够 minBatchForReview 件或到了 dailyReviewHour，先到者为准）。
 * @returns {{due:boolean, why:string}}
 */
export function reviewDue({ settings = {}, tasks = [], closedToday = 0, at = Date.now(), writtenToday = false } = {}) {
  if (writtenToday) return { due: false, why: '今天已经写过' }
  const d = new Date(at)
  const hour = d.getHours()
  const reviewHour = Number(settings.dailyReviewHour)
  if (Number.isInteger(reviewHour) && hour === reviewHour) return { due: true, why: `到了每日一页的点儿（${reviewHour} 点）` }
  if (closedToday >= Math.max(1, Number(settings.minBatchForReview) || 3)) return { due: true, why: `今天攒够了 ${closedToday} 件完结` }
  if (!tasks.length && !closedToday) return { due: false, why: '今天没事可评' }
  return { due: false, why: `攒件中（${closedToday}）` }
}

/** 每日一页正文。强制含「今天没敢说的」段——段落必须在，内容不约束（§2.3 的分界）。 */
export function buildDailyPage({ date = dayKey(), tasks = [], actionsToday = 0, hushText = '' } = {}) {
  const done = tasks.filter((t) => ['done', 'failed', 'blocked', 'abandoned'].includes(t.status))
  const lines = [
    `# 自驱日志 · ${date}`,
    '',
    `## 今天干了什么（机械口径：以账本为准，不是我的自述）`,
    ...(done.length ? done.map((t) => `- 「${t.title}」→ ${TASK_LABEL[t.status] || t.status}${t.why ? `（${t.why}）` : ''}`) : ['- （今天没有完结的任务）']),
    `全天动作 ${actionsToday} 次（机械计数；夜里消耗也在这行里，单列记数，不需要解释）`,
    '',
    '## 今天没敢说的',
    String(hushText || '').trim() || '（今天没什么没敢说的。）',
    '',
  ]
  return lines.join('\n')
}
const TASK_LABEL = { done: '办成', failed: '失败', blocked: '卡住', abandoned: '放弃', active: '还在办' }

/**
 * 做梦到点没有（§10.1：安静时段最深处，dreamFrom~dreamTo；留空 = 关闭；一天最多一次）。
 * @returns {boolean}
 */
export function dreamDue({ settings = {}, at = Date.now(), doneToday = false } = {}) {
  if (doneToday) return false
  const from = String(settings.dreamFrom || '').trim()
  const to = String(settings.dreamTo || '').trim()
  if (!from || !to) return false // 留空 = 关闭做梦（不借 purpose 的兜底）
  const d = new Date(at)
  const m = d.getHours() * 60 + d.getMinutes()
  const s = parseClock(from, '03:00')
  const e = parseClock(to, '05:00')
  const sm = s.hh * 60 + s.mm
  const em = e.hh * 60 + e.mm
  return sm < em ? (m >= sm && m < em) : (m >= sm || m < em)
}

/** 做梦的产出：3~5 条长期记忆文本（模型蒸馏失败时回退模板——失败教训本身值得记）。 */
export function distillDream({ tasks = [], auditToday = 0, modelText = '' } = {}) {
  const fromModel = String(modelText || '').split('\n').map((l) => l.trim().replace(/^[-*\d.、\s]+/, '')).filter((l) => l.length >= 2).slice(0, 5)
  if (fromModel.length >= 3) return fromModel
  const fallback = []
  // 进行中的任务也进梦（2026-11-05 多步化后首跑常有 active 任务——只数完结会漏掉「还在办的事」）
  for (const t of tasks.filter((x) => x.status === 'active').slice(0, 1)) {
    const doneN = (t.steps || []).filter((s) => s.status === 'done').length
    fallback.push(`「${t.title}」还在办（${doneN}/${(t.steps || []).length} 步）——下次接着它的下一步推进`)
  }
  for (const t of tasks.filter((x) => x.status === 'blocked' || x.status === 'abandoned').slice(0, 2)) {
    fallback.push(`「${t.title}」没办成（${t.why || '原因不明'}）——下次遇到同类任务先想清楚这一步缺什么`)
  }
  for (const t of tasks.filter((x) => x.status === 'done').slice(0, 2)) {
    fallback.push(`「${t.title}」办成了——这条路子下次可以复用`)
  }
  fallback.push(`今天账上记了 ${auditToday} 条工具调用——动作不多的话，明天立项可以更挑剔一点`)
  fallback.push(`今天结算了 ${tasks.length} 个任务——明天照旧：攒素材、够好奇才立项、办不动就写清楚为什么`)
  return fallback.slice(0, 5)
}

/** 简易日刊存取（dir/daily、dir/dreams，一文件一天）。 */
export function createJournal(dir) {
  const write = (sub, day, text) => { try { mkdirSync(join(dir, sub), { recursive: true }); writeFileSync(join(dir, sub, `${day}.md`), text, 'utf8'); return true } catch { return false } }
  const read = (sub, day) => { try { return readFileSync(join(dir, sub, `${day}.md`), 'utf8') } catch { return '' } }
  const exists = (sub, day) => existsSync(join(dir, sub, `${day}.md`))
  const list = (sub, n = 7) => {
    try {
      return readdirSync(join(dir, sub)).filter((f) => f.endsWith('.md')).sort().slice(-n).reverse()
        .map((f) => ({ day: f.replace(/\.md$/, ''), text: read(sub, f.replace(/\.md$/, '')) }))
    } catch { return [] }
  }
  return { write, read, exists, list }
}
