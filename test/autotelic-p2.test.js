// 自驱引擎 P2：分级执行器（exec）+ 反思/每日一页/做梦（reflect）+ 审计 note 通道 + tune 钳制。
// 场景对照 docs/AUTOTELIC-PLAN.md §5：11（不直发）、13（工具清单没有 shell）、21（做梦进审计）、
// 8（调自己参数被钳制且进审计）、14（模块不存在时优雅降级）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuditor, verifyAuditChain } from '../src/autotelic/audit.js'
import { buildActPrompt, parseActMemo, createExec } from '../src/autotelic/exec.js'
import {
  reflectionText, writeReflection, reviewDue, buildDailyPage, dreamDue, distillDream, createJournal, dayKey,
} from '../src/autotelic/reflect.js'
import { createRuntime } from '../src/autotelic/runtime.js'

const task = { id: 't1', title: '查竖屏转法', reason: '主人提到想批量转竖屏', status: 'active' }
const step = { desc: '只读了解「查竖屏转法」', level: 'L0' }

// ---------- exec ----------

test('做事提示词：边界写死（不发消息、不碰 onebot、不跑 shell）', () => {
  const p = buildActPrompt(task, step, { quiet: true })
  assert.match(p, /不许发 QQ 消息/)
  assert.match(p, /不许碰 onebot/)
  assert.match(p, /不许跑 shell/)
  assert.match(p, /只读为主/)
  assert.ok(p.includes(task.title), '提示词带上任务')
  assert.ok(p.includes(step.desc), '提示词带上步骤')
})

test('memo 解析：合法 JSON 吃五段；纯文本回包不炸、当观察', () => {
  const good = parseActMemo('{"done":true,"observation":"看了三篇教程","hypothesis":"h","evidence":"e","lesson":"l"}')
  assert.equal(good.ok, true)
  assert.equal(good.observation, '看了三篇教程')
  assert.equal(good.lesson, 'l')
  const plain = parseActMemo('我看了一圈，横屏转竖屏主要靠裁切。')
  assert.equal(plain.ok, true)
  assert.match(plain.observation, /裁切/)
  const empty = parseActMemo('')
  assert.equal(empty.ok, false)
})

test('执行器：presetIdOverride 关着 → noTools 纯想；开着 → 带 aurabot-autotelic preset（场景 13/14 口径）', async () => {
  const calls = []
  const fakeHub = { runSystemTurn: async (name, title, prompt, opts) => { calls.push(opts); return '{"done":true,"observation":"ok","hypothesis":"a","evidence":"b","lesson":"c"}' } }
  const notes = []
  let override = false
  const ex = createExec({
    settings: () => ({ presetIdOverride: override, actTimeoutMs: 60000 }),
    hub: fakeHub,
    auditNote: (e) => notes.push(e),
    log: { warn: () => {} },
  })
  await ex.runStep(task, step)
  assert.equal(calls[0].noTools, true, '没开覆盖开关就不给工具')
  assert.equal(calls[0].presetId, undefined)
  assert.equal(notes.length, 0, 'L0 只想不记账')
  override = true
  const r = await ex.runStep(task, step)
  assert.equal(calls[1].noTools, false)
  assert.equal(calls[1].presetId, 'aurabot-autotelic')
  assert.equal(r.hadTools, true)
  assert.equal(notes.length, 1, 'L1 做事回合进审计（非工具路径显式记账 §4.1③）')
  assert.match(notes[0].kind, /autotelic\/act/)
})

test('执行器：回合炸了不抛出，返回失败观察（步骤按 failed 记）', async () => {
  const ex = createExec({
    settings: () => ({ presetIdOverride: true, actTimeoutMs: 60000 }),
    hub: { runSystemTurn: async () => { throw new Error('等太久了') } },
    log: { warn: () => {} },
  })
  const r = await ex.runStep(task, step)
  assert.equal(r.ok, false)
  assert.match(r.observation, /回合失败/)
})

// ---------- reflect ----------

test('反思文本：结论先行、200 字内装得下全文（修「记忆被截断」）', () => {
  // 教训优先当结论；依据跟着；总长必须在 200 字内（memory.addEvent 硬截 200）
  const full = reflectionText(task, { hypothesis: 'h-假设内容', evidence: 'e-证据内容', lesson: 'l-教训内容' })
  assert.match(full, /【自驱】/)
  assert.match(full, /l-教训内容/, '结论（教训）在最前面')
  assert.match(full, /e-证据内容/, '依据要带证据')
  assert.ok(full.length <= 200, `全文 200 字内（memory 硬截 200），实得 ${full.length}`)
  const bare = reflectionText(task, {})
  assert.match(bare, /（没写）/)
})

test('反思进记忆：memory 没开时静默降级', () => {
  const saved = []
  const ok = writeReflection({ addEvent: (e) => { saved.push(e); return { id: 'm1' } } }, task, { hypothesis: 'h' })
  assert.equal(ok.ok, true)
  assert.equal(saved[0].tags.includes('自驱'), true)
  const degraded = writeReflection(null, task, {})
  assert.equal(degraded.ok, false)
  assert.ok(degraded.text)
})

test('每日一页触发（P2.5）：攒够件数或到点先到为准；写过今天不再写', () => {
  const s = { dailyReviewHour: 23, minBatchForReview: 3 }
  assert.equal(reviewDue({ settings: s, closedToday: 2, at: new Date().setHours(12) }).due, false)
  const r1 = reviewDue({ settings: s, closedToday: 3, at: new Date().setHours(12) })
  assert.equal(r1.due, true)
  assert.match(r1.why, /攒够/)
  const r2 = reviewDue({ settings: s, closedToday: 0, at: new Date().setHours(23) })
  assert.equal(r2.due, true)
  assert.match(r2.why, /点/)
  assert.equal(reviewDue({ settings: s, closedToday: 3, writtenToday: true }).due, false, '写过就不再写')
})

test('每日一页正文：「今天没敢说的」段必须在（场景 9/11 的对账口径）', () => {
  const page = buildDailyPage({ tasks: [{ title: 't', status: 'done' }, { title: 'u', status: 'blocked', why: '没资料' }], actionsToday: 7, hushText: '' })
  assert.match(page, /# 自驱日志/)
  assert.match(page, /## 今天干了什么/)
  assert.match(page, /「u」→ 卡住（没资料）/)
  assert.match(page, /全天动作 7 次/)
  assert.match(page, /## 今天没敢说的/)
  assert.match(page, /今天没什么没敢说的/, '内容不约束，但段落必须在')
})

test('做梦判定（P2.7/§10.1）：留空关闭；窗口内触发；一天一次', () => {
  const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime() }
  assert.equal(dreamDue({ settings: { dreamFrom: '', dreamTo: '' }, at: at(3, 30) }), false, '留空=关闭')
  assert.equal(dreamDue({ settings: { dreamFrom: '03:00', dreamTo: '05:00' }, at: at(3, 30) }), true)
  assert.equal(dreamDue({ settings: { dreamFrom: '03:00', dreamTo: '05:00' }, at: at(12, 0) }), false)
  assert.equal(dreamDue({ settings: { dreamFrom: '03:00', dreamTo: '05:00' }, at: at(3, 30), doneToday: true }), false, '一天一次')
})

test('做梦蒸馏：模型行够 3 条用模型的；不够回退模板（3~5 条）', () => {
  const tasks = [
    { title: 'a', status: 'done' }, { title: 'b', status: 'blocked', why: '没资料' }, { title: 'c', status: 'abandoned', why: '死循环' },
  ]
  const model = distillDream({ tasks, modelText: '- 裁切比缩放省事，认准官方文档\n- 失败的任务先想清楚缺什么\n- 转竖屏先问画幅再动手\n- 教程质量参差，少看二手总结' })
  assert.equal(model.length, 4)
  const fallback = distillDream({ tasks, auditToday: 12, modelText: '太短' })
  assert.ok(fallback.length >= 3 && fallback.length <= 5)
  assert.ok(fallback.some((l) => /死循环/.test(l)))
  assert.ok(fallback.some((l) => /12 条/.test(l)))
})

test('journal 存取：写读列一致', () => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-journal-'))
  const j = createJournal(root)
  j.write('daily', '2026-11-04', '今日一页')
  j.write('dreams', '2026-11-04', '- 梦一条')
  assert.equal(j.exists('daily', '2026-11-04'), true)
  assert.match(j.read('daily', '2026-11-04'), /今日一页/)
  assert.deepEqual(j.list('daily').map((x) => x.day), ['2026-11-04'])
  rmSync(root, { recursive: true, force: true })
})

// ---------- 审计 note 通道（§4.1③） ----------

test('审计 note：模块侧显式记账固定记在她名下，哈希链不断', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-note-'))
  const dir = join(root, 'audit')
  const a = createAuditor({ dir, chatOfSession: () => '', isOwnedSession: () => true, flushMs: 1, log: { debug: () => {} } })
  a.note({ kind: 'autotelic/tune', args: { quietFrom: '23:00' }, outcome: '调参进审计' })
  a.note({ kind: 'autotelic/dream', args: { day: dayKey(), saved: 4 }, outcome: '做梦本身也进审计' })
  await a.flush()
  const chain = await verifyAuditChain(dir)
  assert.equal(chain.ok, true)
  assert.equal(chain.total, 2)
  const text = readFileSync(join(dir, chainFile(dir)), 'utf8')
  assert.match(text, /autotelic\/tune/)
  assert.match(text, /system:autotelic/)
  rmSync(root, { recursive: true, force: true })
})
function chainFile(dir) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`
}

// ---------- runtime P2 集成 ----------

const chatAt = Date.now()
const fakeHub = {
  chatLogDays: () => ['2026-11-04'],
  chatLogOf: () => [{ chatId: 'private:123', who: 'owner', uid: '123', text: '想学一下用 ffmpeg 把横屏视频批量转竖屏，有什么省事的办法', t: chatAt }],
}
const fakeCfg = { ownerQQ: '123' }
const fakeSettings = (over = {}) => ({
  enabled: true, minCuriosity: 0.1, maxCandidates: 3, maxTasksActive: 8, maxSteps: 8, budgetActionsPerHour: 99,
  evalModel: '', allowAct: true, presetIdOverride: true, actTimeoutMs: 60000,
  minBatchForReview: 1, dailyReviewHour: 23, dreamFrom: '', dreamTo: '', quietFrom: '', quietTo: '',
  ...over,
})

function mkRuntime(t, { settings = {}, act, memory, auditNote, auditStat, evalTurn, screenTurn } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-p2-'))
  const ledgerFile = join(root, 'ledger.json')
  const logs = []
  const memStore = memory || { list: () => [], addEvent: () => ({ id: 'm' }) }
  const rt = createRuntime({
    settings: () => fakeSettings(settings),
    cfg: fakeCfg,
    hub: fakeHub,
    memoryOf: () => memStore,
    ledgerFile,
    evalTurn: evalTurn || null,
    // 立项前预审（2026-11-05 少爷定）：生产口径是模块壳必接线，测试默认给「一律值得」，
    // 只关心其它行为的用例不必每处自己造；要测预审本身请显式传 screenTurn。
    screenTurn: screenTurn === undefined ? async () => '[{"i":1,"worth":true}]' : screenTurn,
    act,
    journal: createJournal(root),
    auditNote,
    auditStat,
    log: { info: (...v) => logs.push(v.join(' ')), warn: (...v) => logs.push(v.join(' ')), debug: () => {} },
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, ledgerFile, rt, logs, memStore }
}

const goodAct = { runStep: async () => ({ ok: true, observation: '看了几篇教程，结论是裁切最省事', memo: { hypothesis: 'h', evidence: 'e', lesson: 'l' }, hadTools: true }) }

test('tick 全链：立项 → 单步办完写反思 → 每日一页落盘', async (t) => {
  const saved = []
  const notes = []
  const { rt, root } = mkRuntime(t, {
    act: goodAct,
    memory: { list: () => [], addEvent: (e) => { saved.push(e); return { id: 'm' + saved.length } } },
    auditNote: (e) => notes.push(e),
    auditStat: () => ({ today: 5 }),
  })
  const r = await rt.tick()
  assert.equal(r.outcome, 'proposed')
  assert.equal(r.acted.outcome, 'step-done', '立项后立刻推进一步')
  // 2026-11-05 三修：任务书回归单步（少爷反馈「一个兴趣处理三四次没必要」）——
  // 一轮内办完判断/发言/写记忆，办完任务即 done
  assert.equal(rt.book().list()[0].status, 'done', '单步任务书：一轮办完任务即 done')
  await rt.tick() // 任务完结后走一拍，让挂在 tick 尾部的复盘看见它
  assert.equal(saved.length >= 1, true, '任务到终态写了反思进记忆')
  assert.match(saved[0].text, /【自驱】/)
  assert.equal(notes.some((n) => n.kind === 'autotelic/daily'), true, '每日一页触发也进审计')
  assert.ok(rt.book().meta().actions >= 1, '带工具的做事回合记了动作预算（L1 记账）')
  const dailyPath = join(root, 'daily', `${dayKey()}.md`)
  assert.equal(existsSync(dailyPath), true, '每日一页落盘')
  assert.match(readFileSync(dailyPath, 'utf8'), /## 今天没敢说的/)
  assert.match(readFileSync(dailyPath, 'utf8'), /全天动作 5 次/)
})

test('死循环熔断集成（场景 6）：失败步重试时同样的观察再现 → abandoned', async (t) => {
  const loopAct = { runStep: async () => ({ ok: false, observation: '一模一样的观察', memo: {}, hadTools: false }) }
  const { rt } = mkRuntime(t, { act: loopAct, settings: { presetIdOverride: false } })
  await rt.tick() // 第一次失败（attempts=1，任务还在办）
  assert.equal(rt.book().list()[0].status, 'active')
  await rt.tick() // 重试同一步：同指纹第 2 次 → 熔断
  const tasks = rt.book().list()
  assert.equal(tasks[0].status, 'abandoned')
  assert.match(tasks[0].why, /死循环熔断/)
})

test('allowAct=false：只立项不做事（场景 11 的口径：不惊动主人）', async (t) => {
  let called = 0
  const { rt } = mkRuntime(t, { settings: { allowAct: false }, act: { runStep: async () => { called++; return { ok: true, observation: 'x', memo: {}, hadTools: false } } } })
  const r = await rt.tick()
  assert.equal(r.acted.outcome, 'act-disabled')
  assert.equal(called, 0)
  assert.equal(rt.book().list().length >= 1, true, '但立项照常')
})

test('做梦集成（场景 21）：窗口内触发 → 蒸馏进记忆 + 落盘 + 审计有一条；一天一次', async (t) => {
  const saved = []
  const notes = []
  const { rt } = mkRuntime(t, {
    settings: { dreamFrom: '00:00', dreamTo: '23:59', evalModel: '' },
    memory: { list: () => [], addEvent: (e) => { saved.push(e); return { id: 'm' + saved.length } } },
    auditNote: (e) => notes.push(e),
    auditStat: () => ({ today: 3 }),
    act: goodAct,
  })
  const r = await rt.tick()
  assert.equal(r.journal.dream, true)
  assert.ok(saved.some((e) => /【自驱·梦】/.test(e.text)), '蒸馏进长期记忆')
  assert.equal(saved.filter((e) => /【自驱·梦】/.test(e.text)).length >= 3, true, '3~5 条')
  assert.equal(notes.some((n) => n.kind === 'autotelic/dream'), true, '做梦本身进审计')
  await rt.tick()
  assert.equal(rt.book().meta().ticks.length, 2, '第二轮照常心跳')
  const dreams = rt.review && null
})

test('tune（场景 8）：白名单外拒绝；上限只能向下钳制；合法改动返回 applied', (t) => {
  const { rt } = mkRuntime(t, { settings: { maxSteps: 8, budgetActionsPerHour: 12, maxCandidates: 3 } })
  const r = rt.tune({ quietFrom: '23:00', dailyReviewHour: 22, maxSteps: 3, budgetActionsPerHour: 6 }, { by: 'she' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.applied, { quietFrom: '23:00', dailyReviewHour: 22, maxSteps: 3, budgetActionsPerHour: 6 })
  // 上限往上调 → 钳到当前上限（不能超过主人配置值）
  const up = rt.tune({ maxSteps: 32, budgetActionsPerHour: 999, maxCandidates: 5 }, { by: 'she' })
  assert.equal(up.applied.maxSteps, 8, '步数上限调不动（8 是主人定的）')
  assert.equal(up.applied.budgetActionsPerHour, 12)
  assert.equal(up.applied.maxCandidates, 3)
  // 白名单外
  const evil = rt.tune({ enabled: true, allowPython: false, presetIdOverride: true })
  assert.equal(evil.ok, false)
  assert.ok(Object.keys(evil.rejected).length >= 3, 'enabled / allowPython / presetIdOverride 她调不动')
  // 垃圾格式
  assert.equal(rt.tune({ quietFrom: '25:99' }).ok, false)
})
