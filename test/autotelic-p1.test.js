// 自驱引擎 P1：好奇判分（engine）+ 任务账本状态机（book）+ 心跳运行时（runtime）。
// 验收场景对照 docs/AUTOTELIC-PLAN.md §5：2 素材不足、3 低于阈值、4 立项、5 失败两次 blocked、
// 6 死循环熔断、7 预算超限、10 重启恢复、22 心跳节奏。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { curiosityOf, proposeTasks, mergeModelScores } from '../src/autotelic/engine.js'
import { createBook, MAX_TOTAL } from '../src/autotelic/book.js'
import { createRuntime, isQuietNow, parseEvalModel } from '../src/autotelic/runtime.js'
import { readJson } from '../src/core/store.js'

const mat = (over = {}) => ({
  id: 'qq:test:1', source: 'qq', kind: 'owner', at: Date.now(), who: '主人',
  text: '想学一下用 ffmpeg 把横屏视频批量转成竖屏，有什么省事的办法吗',
  needAffinity: { autonomy: 0.8, play: 0.4 }, importance: 0,
  ...over,
})

test('好奇分：纯函数可复算，主人素材比群友素材的相关性分高', () => {
  const a = curiosityOf(mat())
  const b = curiosityOf(mat({ kind: 'member', who: '群友' }))
  assert.equal(a.score, curiosityOf(mat()).score, '同输入同输出（可复算）')
  assert.ok(a.score > 0 && a.score <= 1)
  assert.ok(a.parts.relevance > b.parts.relevance)
  assert.ok(a.reason.length > 0, 'reason 必填的原料在这里生成')
  assert.ok(curiosityOf(mat()).topic.length > 0, '能提出主题')
})

test('立项（场景 2/3/4）：没素材不立；低于阈值落选带原因；够分就立项且 reason 非空', () => {
  // 场景 2
  const empty = proposeTasks({ materials: [], minCuriosity: 0.55 })
  assert.equal(empty.lastOutcome, 'skipped-no-material')
  // 场景 3：阈值抬高 → 全部落选，落选原因可读
  const low = proposeTasks({ materials: [mat()], minCuriosity: 0.99 })
  assert.equal(low.candidates.length, 0)
  assert.equal(low.lastOutcome, 'below-threshold')
  assert.match(low.rejected[0].why, /阈值/)
  // 场景 4
  const ok = proposeTasks({ materials: [mat()], minCuriosity: 0.1 })
  assert.equal(ok.candidates.length, 1)
  assert.ok(ok.candidates[0].reason, 'reason 必填')
  assert.ok(ok.candidates[0].todos.length >= 1)
  assert.equal(ok.candidates[0].todos[0].level, 'L0', 'P1 全程只读')
})

test('查重：同方向已有进行中的任务就不再立项', () => {
  const m = mat()
  const base = proposeTasks({ materials: [m], minCuriosity: 0.1 })
  const title = base.candidates[0].title
  const dup = proposeTasks({
    materials: [m],
    activeTasks: [{ title }],
    minCuriosity: 0.1,
  })
  assert.equal(dup.candidates.length, 0)
  assert.match(dup.rejected[0].why, /同方向/)
})

test('模型自评并分：0.6*公式 + 0.4*模型；没评到的保持原分；回包是垃圾时原样返回', () => {
  const base = [{ title: 'a', score: 0.5 }, { title: 'b', score: 0.5 }]
  const merged = mergeModelScores([{ i: 1, curiosity: 1 }], base)
  assert.equal(merged[0].score, 0.7)
  assert.equal(merged[1].score, 0.5)
  assert.equal(mergeModelScores('垃圾', base)[0].score, 0.5)
})

test('parseEvalModel：provider/model 才认；空 / 斜杠不全都不启用', () => {
  assert.deepEqual(parseEvalModel('workbuddy/hy4free'), { provider: 'workbuddy', model: 'hy4free' })
  assert.deepEqual(parseEvalModel('a/b/c'), { provider: 'a', model: 'b/c' })
  assert.equal(parseEvalModel(''), null)
  assert.equal(parseEvalModel('noslash'), null)
})

test('安静时段：留空 = 不启用；跨午夜按环判（§4.6 自己判）', () => {
  const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime() }
  assert.equal(isQuietNow({ quietFrom: '', quietTo: '' }, at(0, 0)), false, '留空关闭，不借 purpose 兜底')
  assert.equal(isQuietNow({ quietFrom: '23:30', quietTo: '07:30' }, at(3, 0)), true, '夜里在安静时段')
  assert.equal(isQuietNow({ quietFrom: '23:30', quietTo: '07:30' }, at(12, 0)), false)
  assert.equal(isQuietNow({ quietFrom: '01:00', quietTo: '03:00' }, at(2, 0)), true)
})

// ---------- book：账本状态机 ----------

test('立项落账（场景 4）+ reason 必填 + 上限拒绝（对齐场景 7：预算超限不开新坑）', () => {
  const bk = createBook({ maxActive: 2, maxSteps: 3, actionsPerHour: 99 })
  assert.match(bk.addTask({ title: 'x', reason: '' }).why, /reason/)
  const r = bk.addTask({ title: '查 ffmpeg 竖屏方案', reason: '主人昨天提到想批量转竖屏', score: 0.7, todos: [{ desc: '只读了解', level: 'L0' }] })
  assert.equal(r.ok, true)
  assert.equal(bk.activeCount(), 1)
  bk.addTask({ title: '任务二', reason: 'r2' })
  // 第 3 个被拒：活跃到顶不开新坑，不悄悄挤掉在办的
  const third = bk.addTask({ title: '任务三', reason: 'r3' })
  assert.equal(third.ok, false)
  assert.match(third.why, /活跃/)
  assert.equal(bk.activeCount(), 2)
})

test('预算（场景 7）：动作/小时到顶不开新坑；进行中的不受影响', () => {
  const bk = createBook({ actionsPerHour: 2 })
  bk.recordAction(); bk.recordAction()
  assert.equal(bk.actionsInLastHour(), 2)
  assert.match(bk.canStartTask().why, /预算/)
  const r = bk.addTask({ title: '不给立', reason: '预算满了' })
  assert.equal(r.ok, false)
})

test('步状态机（场景 5）：失败 2 次 → blocked，不无限重试', () => {
  const bk = createBook({})
  const { task } = bk.addTask({ title: 't', reason: 'r', todos: [{ desc: '步一' }] })
  assert.equal(bk.beginStep(task.id).ok, true)
  bk.endStep(task.id, { ok: false, why: '没找到资料' })
  assert.equal(bk.list()[0].status, 'active', '第一次失败还在试')
  assert.equal(bk.beginStep(task.id).ok, true, 'attempts<2 可重试')
  const r = bk.endStep(task.id, { ok: false, why: '还是没找到' })
  assert.equal(r.taskStatus, 'blocked')
  assert.match(bk.list()[0].why, /失败 2 次/)
  assert.equal(bk.beginStep(task.id).ok, false)
})

test('死循环熔断（场景 6）：同指纹第 2 次 → abandoned，面板能看到原因', () => {
  const bk = createBook({})
  const { task } = bk.addTask({ title: 't', reason: 'r' })
  const fp = 'fs|{"q":"竖屏"}|观察一样'
  assert.deepEqual(bk.guardLoop(task.id, fp), { looped: false, abandoned: false })
  const r = bk.guardLoop(task.id, fp)
  assert.equal(r.abandoned, true)
  assert.match(bk.list()[0].why, /死循环熔断/)
})

test('步数上限（C5）：maxSteps 到顶拒绝再开', () => {
  const bk = createBook({ maxSteps: 2 })
  const { task } = bk.addTask({ title: 't', reason: 'r', todos: [{ desc: '一' }, { desc: '二' }, { desc: '三' }] })
  bk.beginStep(task.id); bk.endStep(task.id, { ok: true })
  bk.beginStep(task.id); bk.endStep(task.id, { ok: true })
  const r = bk.beginStep(task.id)
  assert.equal(r.ok, false)
  assert.match(r.why, /上限/)
})

test('重启恢复（场景 10）：running 改判 failed；done 不动；落盘续读', () => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-book-'))
  const file = join(root, 'ledger.json')
  const t = () => Date.now()
  const a = createBook({ file, now: t })
  const { task } = a.addTask({ title: '在途', reason: 'r', todos: [{ desc: '会挂' }, { desc: '还没到' }] })
  a.beginStep(task.id)
  a.endStep(task.id, { ok: true })
  a.beginStep(task.id) // 留一个 running 在途
  // 「重启」：新实例读同一文件
  const b = createBook({ file, now: t })
  const loaded = b.list().find((x) => x.id === task.id)
  const running = loaded.steps.find((s) => s.status === 'running')
  const failed = loaded.steps.filter((s) => s.status === 'failed')
  assert.equal(running, undefined, '在途步已被改判')
  assert.equal(failed.length, 1)
  assert.match(failed[0].why, /重启/)
  assert.equal(loaded.steps.filter((s) => s.status === 'done').length, 1, 'done 的不重跑')
  rmSync(root, { recursive: true, force: true })
})

test('总量 ≤40（pruneLedger）：最老的已完结先丢', () => {
  const bk = createBook({ maxActive: 2 })
  for (let i = 0; i < MAX_TOTAL + 5; i++) {
    const r = bk.addTask({ title: `t${i}`, reason: 'r' })
    if (r.ok) bk.close(r.task.id, 'done')
  }
  assert.ok(bk.list().length <= MAX_TOTAL)
})

test('心跳节奏（场景 22）：只留最近 6 次', () => {
  const bk = createBook({})
  for (let i = 0; i < 8; i++) bk.heartbeat('idle')
  assert.equal(bk.meta().ticks.length, 6)
  assert.equal(bk.summary().total >= 0, true)
})

// ---------- runtime：心跳运行时 ----------

const chatAt = Date.now()
const fakeHub = {
  chatLogDays: () => ['2026-11-04'],
  chatLogOf: () => [
    { chatId: 'private:123', who: 'owner', uid: '123', text: '想学一下用 ffmpeg 把横屏视频批量转竖屏，有什么省事的办法', t: chatAt },
  ],
}
const fakeCfg = { ownerQQ: '123' }
const fakeSettings = (over = {}) => ({ enabled: true, minCuriosity: 0.1, maxTasksActive: 8, maxSteps: 8, budgetActionsPerHour: 12, evalModel: '', ...over })

function mkRuntime(t, { settings = {}, evalTurn = null, screenTurn } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-runtime-'))
  const ledgerFile = join(root, 'ledger.json')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const logs = []
  const rt = createRuntime({
    settings: () => fakeSettings(settings),
    cfg: fakeCfg,
    hub: fakeHub,
    memoryOf: () => ({ list: () => [] }),
    ledgerFile,
    evalTurn,
    // 立项前预审（2026-11-05 少爷定）：生产口径模块壳必接线，这里默认「一律值得」；
    // 专门测预审的用例请显式传 screenTurn。
    screenTurn: screenTurn === undefined ? async () => '[{"i":1,"worth":true}]' : screenTurn,
    log: { info: (...v) => logs.push(v.join(' ')), warn: (...v) => logs.push(v.join(' ')), debug: () => {} },
  })
  return { root, ledgerFile, rt, logs }
}

test('场景 1：enabled=false 时 tick 直接返回，零 IO（不写账本文件）', async (t) => {
  const { ledgerFile, rt } = mkRuntime(t, { settings: { enabled: false } })
  const r = await rt.tick()
  assert.equal(r.outcome, 'disabled')
  assert.equal(existsSync(ledgerFile), false, '关着时不落任何盘')
})

test('预览零副作用（P1.5）：不落盘、给出分数与落选原因', async (t) => {
  const { ledgerFile, rt } = mkRuntime(t)
  const p = rt.preview()
  assert.equal(p.ok, true)
  assert.ok(p.materialCount >= 1)
  assert.equal(existsSync(ledgerFile), false, '预览不落盘')
  // 阈值抬高再预览：能看到落选原因（场景 3 的面板口）
  const root2 = mkdtempSync(join(tmpdir(), 'aurabot-runtime-'))
  const rt2 = createRuntime({
    settings: () => fakeSettings({ minCuriosity: 0.99 }),
    cfg: fakeCfg, hub: fakeHub, memoryOf: () => ({ list: () => [] }),
    ledgerFile: join(root2, 'ledger.json'), log: { debug: () => {} },
  })
  const p2 = rt2.preview()
  assert.equal(p2.candidates.length, 0)
  assert.ok(p2.rejected.some((x) => /阈值/.test(x.why)))
})

test('立项闭环（场景 4）：tick 后账本有任务（reason 非空），账本落盘', async (t) => {
  const { ledgerFile, rt } = mkRuntime(t)
  const r = await rt.tick()
  assert.equal(r.outcome, 'proposed')
  const tasks = rt.book().list()
  assert.ok(tasks.length >= 1)
  assert.ok(tasks[0].reason, '落账的任务带理由')
  const saved = readJson(ledgerFile, null)
  assert.ok(saved?.tasks?.length >= 1, '账本已落盘')
})

test('防重入（§4.5）：上一轮没结束，这轮 skipped-busy', async (t) => {
  let release
  const gate = new Promise((r) => { release = r })
  const { rt } = mkRuntime(t, { settings: { evalModel: 'fake/cheap' }, evalTurn: () => gate.then(() => '[]') })
  const first = rt.tick()
  await new Promise((r) => setTimeout(r, 10)) // 让第一轮走到 evalTurn 里挂着
  const second = await rt.tick()
  assert.equal(second.outcome, 'skipped-busy')
  release('[]')
  const r = await first
  assert.equal(['proposed', 'below-threshold'].includes(r.outcome), true)
})

test('模型自评失败静默回退公式分，不炸 tick', async (t) => {
  const { rt } = mkRuntime(t, { settings: { evalModel: 'fake/cheap' }, evalTurn: async () => { throw new Error('模型炸了') } })
  const r = await rt.tick()
  assert.equal(r.outcome, 'proposed')
})

test('书签：settings 上限改了账本重建但不丢账（同一文件续读）', async (t) => {
  const { rt, ledgerFile } = mkRuntime(t)
  await rt.tick()
  const before = rt.book().list().length
  writeFileSync(ledgerFile, JSON.stringify(readJson(ledgerFile)), 'utf8')
  const rt2 = createRuntime({
    settings: () => fakeSettings({ maxTasksActive: 4 }), // 上限变了
    cfg: fakeCfg, hub: fakeHub, memoryOf: () => ({ list: () => [] }),
    ledgerFile, log: { debug: () => {} },
  })
  assert.equal(rt2.book().list().length, before, '换了上限账还在')
})
