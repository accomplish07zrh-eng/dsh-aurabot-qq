// 自驱引擎三病修复的回归测试（2026-11-05，真机账本实证后修的）：
//   病一「只会写判断笔记」 → 任务书多步化（engine.buildTodos）
//   病二「重复立项饿死引擎」→ 同源冷却 + sourceId 精确去重（engine.proposeTasks）
//   病三「冷却中冤死成 blocked」→ 瞬态退避（book.releaseStep + runtime 瞬态口径）
//   附带：人格提案工具的落盘口径（proposals/persona-*.md，提案权不直写人格卡）
// 真机证据：ledger.json 16 个任务全是单步模板；同 sourceId 立项 3 次；4 个 blocked 里 3 个瞬态。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { proposeTasks, buildTodos, buildScreenPrompt, parseScreenVerdicts, trivialWhy, screenFingerprint } from '../src/autotelic/engine.js'
import { createBook } from '../src/autotelic/book.js'
import { createRuntime } from '../src/autotelic/runtime.js'
import { buildActPrompt, parseActMemo } from '../src/autotelic/exec.js'

// —— 造素材：collectMaterials 的 items 带 needAffinity（keyword 命中才有分），测试里直接给 ——

function mat(id, text, { need = 'identity', affinity = 0.9, kind = 'self', who = '' } = {}) {
  return { id, text, kind, who, source: kind, importance: 0, needAffinity: { [need]: affinity } }
}

const BASE = { minCuriosity: 0.5 }

// —— 病二：同源冷却 + sourceId 精确去重 ——

test('同源冷却：做完的 sourceId 7 天内不再立项（修重复立项饿死引擎）', () => {
  const m = mat('qq:1:2:3:self', '拆解大肥鱼AI自主刷B站原理', { need: 'identity' })
  const r = proposeTasks({ materials: [m], coolSourceIds: ['qq:1:2:3:self'], ...BASE })
  assert.equal(r.candidates.length, 0, '冷却中的同源素材不许再立项')
  assert.ok(r.rejected.some((x) => /冷却/.test(x.why)), `落选原因要写冷却：${JSON.stringify(r.rejected)}`)
})

test('冷却外的同源素材照常立项', () => {
  const m = mat('m-new', '学一下算命的流派划分', { need: 'learn' })
  const r = proposeTasks({ materials: [m], coolSourceIds: ['m-old'], ...BASE })
  assert.equal(r.candidates.length, 1)
})

test('进行中的同源素材也不重复立项（sourceId 精确挡，标题截断绕不过）', () => {
  const m = mat('m1', '拆解刷B站原理', { need: 'identity' })
  const r = proposeTasks({
    materials: [m],
    activeTasks: [{ title: '完全不同的另一个标题', sourceId: 'm1' }],
    ...BASE,
  })
  assert.equal(r.candidates.length, 0)
  assert.ok(r.rejected.some((x) => /进行中/.test(x.why)))
})

// —— 病一修复的形态（2026-11-05 三修：回归单步）——
// 少爷真机反馈「一个兴趣处理三四次没必要」：做事回合已带工具，一轮能办完，
// 多步拆解反而让一个兴趣花三四次模型调用 → buildTodos 回归单步清单式任务书。

test('任务书回归单步：一轮清单式，不再拆多步（修「一个兴趣处理三四次」）', () => {
  for (const need of ['learn', 'create', 'identity', 'install', 'play', 'connect', 'care']) {
    const steps = buildTodos('随便什么方向', need)
    assert.equal(steps.length, 1, `${need} 类任务书 = 1 步（一轮内办完判断/发言/写记忆），实得 ${steps.length}`)
    assert.match(steps[0].desc, /autotelic_propose_say/, '清单里要有「值不值得说」的收尾')
    assert.match(steps[0].desc, /autotelic_note/, '清单里要有「写进记忆」的收尾')
  }
})

test('任务书：查资料要克制——不许再「翻全部历史笔记」（少爷真机反馈）', () => {
  const s = buildTodos('学算命的流派', 'learn')[0].desc
  assert.match(s, /最多读 2~3 个/, '明确限制读取数量')
  assert.match(s, /别翻全部历史笔记/, '明确禁止全量翻阅')
  assert.ok(s.length <= 200, `任务书 200 字内（addTask 会截），实得 ${s.length}`)
})

// —— 最小实义门槛（「汪汪」不许立项，少爷真机反馈）——

test('最小实义门槛：纯语气词/超短素材不立项（修「汪汪也立项」）', () => {
  const r = proposeTasks({ materials: [mat('m1', '汪汪', { need: 'play', affinity: 1 })], ...BASE })
  assert.equal(r.candidates.length, 0, '「汪汪」两个字不许立项')
  assert.ok(r.rejected.some((x) => /没有实义内容/.test(x.why)), `落选原因要写明：${JSON.stringify(r.rejected)}`)
})

test('最小实义门槛：正常长度的素材不受影响', () => {
  const r = proposeTasks({ materials: [mat('m2', '爸爸说想看看大肥鱼自主刷B站的实现原理', { need: 'identity', affinity: 0.9 })], ...BASE })
  assert.equal(r.candidates.length, 1, '正常素材照常立项')
})

// —— 病三：瞬态退避 ——

function tmpLedger(t, tasks) {
  const dir = mkdtempSync(join(tmpdir(), 'autotelic-fix-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'ledger.json')
  const at = Date.now()
  writeFileSync(file, JSON.stringify({
    tasks: tasks.map((x) => ({ score: 0.6, sourceId: 's', reason: 'r', why: '', fingerprints: [], ...x, createdAt: x.createdAt || at, updatedAt: x.updatedAt || at })),
    actions: [], ticks: [], lastTick: null,
  }), 'utf8')
  return file
}

const BASE_SETTINGS = {
  enabled: true, allowAct: true, presetIdOverride: false,
  maxTasksActive: 8, maxSteps: 8, budgetActionsPerHour: 12, minCuriosity: 0.55,
}

const mkTask = (id, title = 'T') => ({
  id, title, reason: 'r', sourceId: 's1', status: 'active',
  steps: [{ desc: 'd', level: 'L0', status: 'pending', attempts: 0, fingerprint: '', why: '' }],
})

test('瞬态退避：后台冷却不算步失败，退回 pending 不计次数（修 blocked 冤死）', async (t) => {
  const file = tmpLedger(t, [mkTask('t1')])
  const rt = createRuntime({
    settings: () => ({ ...BASE_SETTINGS }),
    hub: {},
    ledgerFile: file,
    act: { runStep: async () => ({ ok: false, observation: '回合失败：后台会话冷却中，1 分钟后再试', hadTools: false }) },
  })
  const r = await rt.step()
  assert.equal(r.outcome, 'act-backoff', `瞬态要走 backoff，实得 ${r.outcome}`)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  const t1 = saved.tasks.find((x) => x.id === 't1')
  assert.equal(t1.status, 'active', '任务不许被憋成 blocked')
  assert.equal(t1.steps[0].status, 'pending', '步退回待办')
  assert.equal(t1.steps[0].attempts, 0, '失败计数退回，不占熔断额度')
})

test('真失败照样计数：非瞬态且观察不同的失败 2 次仍会 blocked（别把退避做成免死金牌）', async (t) => {
  const file = tmpLedger(t, [mkTask('t2')])
  let n = 0
  const rt = createRuntime({
    settings: () => ({ ...BASE_SETTINGS }),
    hub: {},
    ledgerFile: file,
    // 观察每次不同——同观察两次会走熔断（abandoned），那是另一条设计好的路
    act: { runStep: async () => { n += 1; return { ok: false, observation: `第 ${n} 次查证：这条素材的原文还是没找到（查证角度 ${n}）`, hadTools: false } } },
  })
  await rt.step()
  await rt.step()
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.tasks.find((x) => x.id === 't2').status, 'blocked', '真失败两次还是要 blocked')
})

// —— 进工作间自审（2026-11-05 少爷定：立项后由模型判断值不值得做）——

test('工作间提示词：开头就要求自审，不值得输出 abandon', () => {
  const prompt = buildActPrompt({ title: '名字', reason: '主人说了「名字」' }, { desc: '弄明白', level: 'L0' })
  assert.match(prompt, /值不值得做/, '开头就要自审')
  assert.match(prompt, /abandon/, '不值得要输出 abandon')
  assert.match(prompt, /关掉/, '说明会被关掉')
})

test('abandon 回包解析：模型说放弃 → abandon=true + why', () => {
  const m = parseActMemo('{"abandon": true, "why": "这只是主人随口叫了我一声，没有可办的事"}')
  assert.equal(m.abandon, true)
  assert.match(m.why, /随口/)
})

test('正常回包不误判 abandon：没有 abandon 字段 = 继续做', () => {
  const m = parseActMemo('{"done": true, "observation": "查到了", "lesson": "下次先查笔记"}')
  assert.equal(m.abandon, false, '没有 abandon 字段不许误判')
  assert.equal(m.ok, true)
})

test('进工作间自审不通过 → 任务直接 abandoned（不算失败、不写反思）', async (t) => {
  const file = tmpLedger(t, [mkTask('t3', '名字')])
  const closed = []
  const rt = createRuntime({
    settings: () => ({ ...BASE_SETTINGS }),
    hub: {},
    ledgerFile: file,
    auditNote: (e) => closed.push(e),
    act: { runStep: async () => ({ ok: false, abandon: true, why: '这只是个称呼，没内容可挖', observation: '', hadTools: false }) },
  })
  const r = await rt.step()
  assert.equal(r.outcome, 'act-abandoned', `自审否决要走 act-abandoned，实得 ${r.outcome}`)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  const t3 = saved.tasks.find((x) => x.id === 't3')
  assert.equal(t3.status, 'abandoned', '任务被关掉')
  assert.match(t3.why, /自审不通过/, '关掉原因写清楚')
  assert.ok(closed.some((e) => e.kind === 'autotelic/abandon'), '自审否决要进审计')
  assert.equal(saved.actions.length, 1, '这一轮确实起了回合，占一次动作预算')
})

// —— 立项前预审（2026-11-05 少爷定）：值不值得办，进待办之前就判掉 ——
// 真机证据：只靠工作间自审不灵——「我刚安装dsh那天就有」被自审判成
// 「完整整句（主语/过去动作/dsh/时间锚），非寒暄，值得做」放行了，任务跑完记 done。
// 根因：说这话的是提议者自己，不是审查员；且闸在立项之后（已经占了坑、烧了预算）。

test('预审提示词：审查员视角 + 明确「拿不准当不值得」+ 要 JSON 裁决', () => {
  const prompt = buildScreenPrompt([
    { title: '我刚安装dsh那天就有', reason: '群友说，戳中 install 需要' },
    { title: '学一下算命的流派划分', reason: '好奇' },
  ])
  assert.match(prompt, /审查员，不是提议者/, '必须是第三方视角，不能让她自己审自己')
  assert.match(prompt, /值得她花时间亲手办/, '判的就是值不值得办')
  assert.match(prompt, /拿不准就当不值得/, '默认偏严')
  assert.match(prompt, /worth/, '要结构化裁决，别只要一段话')
  assert.match(prompt, /我刚安装dsh那天就有/, '候选要带进去')
  assert.match(prompt, /学一下算命的流派/, '第二个候选也要带')
})

test('预审回包解析：认 i/worth/why；没数组或垃圾返回 null（不默认放行）', () => {
  const ok = parseScreenVerdicts('[{"i":1,"worth":true},{"i":2,"worth":false,"why":"只是闲聊应答"}]')
  assert.equal(ok.length, 2)
  assert.equal(ok[0].worth, true)
  assert.equal(ok[1].worth, false)
  assert.match(ok[1].why, /闲聊/)
  assert.equal(parseScreenVerdicts('我觉得都不错'), null, '没有 JSON 数组 = 没裁决')
  assert.equal(parseScreenVerdicts('[bad json'), null)
  assert.equal(parseScreenVerdicts('[{"worth":true}]').length, 0, '没有 i 定位不了，丢掉')
})

test('本地兜底：纯应答/寒暄/超短碎片判不值得；有实义内容的放行', () => {
  for (const t of ['嗯嗯好的', '早上好', '晚安', '在吗', '哈哈', '嘻嘻', '']) {
    assert.ok(trivialWhy(t).length > 0, `「${t}」该判不值得，实得空（放行了）`)
  }
  assert.equal(trivialWhy('学一下算命的流派划分'), '', '有内容的方向不该被本地误拦')
  assert.equal(trivialWhy('我刚安装dsh那天就有'), '', '本地启发式判不出语义，交给模型（这是设计口径）')
})

/** 造一个只关心「预审」的运行时（allowAct=false，tick 不推进任务）。
 *  预审走独立注入的 screenTurn（真机上没配 evalModel 时也用主模型，不能用 evalTurn 分流糊弄）。 */
function mkScreenRuntime(t, { screenReply, prefix = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'autotelic-screen-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const ledgerFile = join(root, 'ledger.json')
  const notes = []
  let calls = 0
  // 素材时间戳必须固定：素材 id = `qq:<chatId>:<时间戳>`，每轮重新算 Date.now() 会让
  // 同一句话每轮的 sourceId 都变，预审冷却就永远命不中（真机上是固定聊天流水，不会这样）
  const msgAt = Date.now() - 60_000
  const rt = createRuntime({
    settings: () => ({ ...BASE_SETTINGS, allowAct: false, ...prefix }),
    hub: {
      chatLogDays: () => ['2026-11-05'],
      chatLogOf: () => [{ chatId: 'group:1130575035', who: 'member', uid: '1215734464', text: '我刚安装dsh那天就有', t: msgAt }],
    },
    cfg: { ownerQQ: '749830684' },
    memoryOf: () => ({ list: () => [] }),
    ledgerFile,
    auditNote: (e) => notes.push(e),
    screenTurn: async (prompt, opts) => {
      calls += 1
      return typeof screenReply === 'function' ? screenReply(prompt, opts) : screenReply
    },
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  })
  return { rt, ledgerFile, notes, calls: () => calls }
}

test('预审判不值得 → 不立项（一个都不进待办），记冷却 + 进审计（修「这句也立项」）', async (t) => {
  const { rt, ledgerFile, notes } = mkScreenRuntime(t, { screenReply: '[{"i":1,"worth":false,"why":"群友随口一句，没有可办的内容"}]', prefix: { minCuriosity: 0.1 } })
  const r = await rt.tick()
  assert.equal(r.outcome, 'screened-out', `全被拦住要标 screened-out，实得 ${r.outcome}`)
  const saved = JSON.parse(readFileSync(ledgerFile, 'utf8'))
  assert.equal(saved.tasks.length, 0, '预审否决的东西一个都不许进待办')
  assert.equal(saved.screenVetoes.length, 1, '否决要记下来（挡重复送审）')
  assert.match(saved.screenVetoes[0].why, /随口/, '理由要存')
  assert.ok(notes.some((e) => e.kind === 'autotelic/screen'), '预审否决要进审计')
  assert.equal(r.vetoed.length, 1, 'tick 回包要带否决明细（面板看得见）')
})

test('预审说值得 → 照常立项（别把闸做成一律拦）', async (t) => {
  const { rt } = mkScreenRuntime(t, { screenReply: '[{"i":1,"worth":true}]', prefix: { minCuriosity: 0.1 } })
  const r = await rt.tick()
  assert.equal(r.outcome, 'proposed')
  assert.equal(rt.book().list().length, 1)
})

test('预审冷却：同一条素材否决后不再每轮反复送审（省模型调用）', async (t) => {
  const { rt, calls } = mkScreenRuntime(t, { screenReply: '[{"i":1,"worth":false,"why":"没有可办的内容"}]', prefix: { minCuriosity: 0.1 } })
  await rt.tick() // 第一次：真送审 + 否决
  assert.equal(calls(), 1, '第一轮要真调一次模型')
  const r2 = await rt.tick() // 第二轮：同源素材被冷却挡住，连候选都不生成
  assert.notEqual(r2.outcome, 'screened-out', `冷却后不该再走预审，实得 ${r2.outcome}`)
  assert.equal(calls(), 1, '第二轮不许再调模型（否决已记冷却）')
})

test('预审回合失败 → 不偷偷放行：本地判不出的押到下一拍，绝不进待办', async (t) => {
  const { rt, ledgerFile } = mkScreenRuntime(t, { screenReply: () => { throw new Error('模型炸了') }, prefix: { minCuriosity: 0.1 } })
  const r = await rt.tick()
  // 「我刚安装dsh那天就有」本地启发式判不出语义（不是明显废话）→ 押后，这一轮不立项
  assert.equal(r.outcome, 'screen-deferred', `没裁决就要押后，实得 ${r.outcome}`)
  const saved = JSON.parse(readFileSync(ledgerFile, 'utf8'))
  assert.equal(saved.tasks.length, 0, '没审过的绝不许偷偷进待办（闸失效=没装闸）')
  assert.equal(r.deferred.length, 1, 'tick 回包要带押后明细')
})

test('预审回合失败但本地能判（纯应答）→ 直接否掉，不必押后', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'autotelic-screen3-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const rt = createRuntime({
    settings: () => ({ ...BASE_SETTINGS, allowAct: false, minCuriosity: 0.1 }),
    hub: { chatLogDays: () => ['2026-11-05'], chatLogOf: () => [{ chatId: 'private:749830684', who: 'owner', uid: '749830684', text: '早安呀，今天天气真好呢', t: Date.now() - 60_000 }] },
    cfg: { ownerQQ: '749830684' },
    memoryOf: () => ({ list: () => [] }),
    ledgerFile: join(root, 'ledger.json'),
    screenTurn: async () => { throw new Error('模型炸了') },
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  })
  const r = await rt.tick()
  assert.equal(r.outcome, 'screened-out', `纯应答本地就能否，实得 ${r.outcome}`)
  assert.equal(rt.book().list().length, 0)
})

test('没配 evalModel（真机现状）也照样走预审：闸不能因为「没配便宜模型」就失效', async (t) => {
  const seen = []
  const root = mkdtempSync(join(tmpdir(), 'autotelic-screen2-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const rt = createRuntime({
    settings: () => ({ ...BASE_SETTINGS, allowAct: false, minCuriosity: 0.1 }), // evalModel 留空＝真机口径
    hub: { chatLogDays: () => ['2026-11-05'], chatLogOf: () => [{ chatId: 'group:1130575035', who: 'member', uid: '1215734464', text: '我刚安装dsh那天就有', t: Date.now() - 60_000 }] },
    cfg: { ownerQQ: '749830684' },
    memoryOf: () => ({ list: () => [] }),
    ledgerFile: join(root, 'ledger.json'),
    screenTurn: async (prompt, opts) => { seen.push(opts); return '[{"i":1,"worth":false,"why":"群友随口一句"}]' },
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  })
  const r = await rt.tick()
  assert.equal(seen.length, 1, 'evalModel 空着，预审也必须真跑一次')
  assert.equal(seen[0].model, undefined, '没配便宜模型时用主模型（不指定 model）')
  assert.equal(r.outcome, 'screened-out')
  assert.equal(rt.book().list().length, 0, '这句不进待办')
})

// —— 指纹冷却（2026-11-06 修「同一句闲聊每 6 小时重烧一个模型回合」，reviewer 真机反馈）——
// 真机证据：「market上下的插件」前后被送审 3 次，模型每次都答「此前已判过」——
// 冷却按 sourceId 记挡不住复读：同句话从聊天流水再采出来 id 带时间戳、每条都不同。

test('screenFingerprint：归一化文本指纹——标点/表情/大小写/空白不影响', () => {
  assert.equal(screenFingerprint('market上下的插件'), screenFingerprint('Market 上下的插件！'), '大小写与标点不影响')
  assert.equal(screenFingerprint('得看破的是谁的甲呀<face:偷笑>'), screenFingerprint('得看破的是谁的甲呀'), '内联表情标记剥掉')
  assert.notEqual(screenFingerprint('一句闲聊'), screenFingerprint('另一句闲聊'), '不同文本不同指纹')
  assert.equal(screenFingerprint('。。。'), '', '纯标点没有指纹（不算重复素材）')
})

test('指纹冷却：同一句话复读 → 本地直否，一次模型回合都不花（修「40 次全这么烧掉」）', async (t) => {
  const seen = []
  const { rt, ledgerFile } = mkScreenRuntime(t, { screenReply: () => { seen.push(1); return '[{"i":1,"worth":false,"why":"闲聊"}]' }, prefix: { minCuriosity: 0.1 } })
  await rt.tick() // 第一次：真送审
  assert.equal(seen.length, 1)
  const r2 = await rt.tick() // 第二轮：id 冷却先挡（同源素材），指纹冷却兜底（id 变了的情况）
  assert.equal(seen.length, 1, '第二轮不许再调模型（id 冷却 + 文本指纹双保险）')
  assert.equal(['screened-out', 'below-threshold'].includes(r2.outcome), true, `复读被拦在待办之外，实得 ${r2.outcome}`)
  const saved = JSON.parse(readFileSync(ledgerFile, 'utf8'))
  const entry = saved.screenVetoes.find((x) => x.fp)
  assert.ok(entry, '否决记录要带指纹')
  assert.match(entry.why, /刷新/, '复读那笔要把冷却时间刷新（同一个 id 覆盖更新，不新增行）')
})

// —— 附带：buildTodos 的产物能被 addTask 原样落账 ——

test('单步任务书经 addTask 落账后形状不变', () => {
  const bk = createBook({}) // 不落盘
  const todos = buildTodos('学算命的流派', 'learn')
  const r = bk.addTask({ title: '学算命的流派', reason: '好奇', todos, sourceId: 's9' })
  assert.equal(r.ok, true)
  assert.equal(r.task.steps.length, 1, '单步任务书不被账本改形')
  assert.match(r.task.steps[0].desc, /autotelic_note/)
})
