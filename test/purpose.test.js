// 目的机制（主动搭话引擎移植版）：
//   · 排程重算（nextFireAt 落盘、tick 重算、重启不补发）
//   · 闸门（总开关 / 主人刚说话 / 安静时段）
//   · 目标归属升级（群友目标重复 ≥3 次才升 self）
//   · 回执反馈（主人回复正/负 → confirmed / rejected）
//   · pending 待续（备忘【状态】待续 → 惦记账本 → 下次优先）
//   · silent（模型跳过不硬发）
// 引擎是纯函数，归属/回执/待续直接测 engine.js；接线用假 hub/memory/mood（同 fake-dsh 模式）。
// 落盘测试必须 AURABOT_DATA_DIR 隔离。
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let createPurpose
let purposeConfig
let cleanReply
let engine
const OWNER = '10000001'
const MIN = 60_000
let dataRoot = ''

before(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'aurabot-purpose-'))
  process.env.AURABOT_DATA_DIR = dataRoot
  ;({ createPurpose, purposeConfig, cleanReply } = await import('../src/purpose/module.js'))
  engine = await import('../src/purpose/engine.js')
})

beforeEach(() => {
  // 每个用例独立数据目录，互不串状态
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-purpose-'))
})

function stateFile() { return join(process.env.AURABOT_DATA_DIR, 'purpose', 'purpose-state.json') }

// 假 hub：runSystemTurn 可脚本化回复；deliver 记录投递（成功返回 {missedAt:[], sent}，同 hub.deliver 真契约）
const DEFAULT_MEMORIES = [
  { id: 'mm1', text: '主人上周在玩星穹列车', importance: 0.6 },
  { id: 'mm2', text: '主人喜欢下班后打两把游戏放松', importance: 0.5 },
]
function makeHub({ reply = '主人，今天想到一件事想跟你说', lastOwnerChatAt = 0, lastBot = { at: 0, text: '' }, log = [] } = {}) {
  return {
    lastOwnerChatAt,
    lastBotToOwner: lastBot,
    chatLogDays: () => [],
    chatLogOf: () => [],
    delivered: [],
    turns: log,
    async runSystemTurn(name, title, prompt, options = {}) { this.turns.push({ name, title, prompt, options }); return typeof reply === 'function' ? reply(prompt, options) : reply },
    async deliver(chatId, text, opts = {}) { this.delivered.push({ chatId, text, opts }); return { missedAt: [], failed: 0, errors: [], sent: this.deliverSent ?? text } },
  }
}

function makePurpose(hub, overrides = {}) {
  const cfg = {
    enabled: true, ownerQQ: OWNER, ownerName: '主人',
    speakUp: { enabled: false, awakeFrom: 0, awakeTo: 24, idleMinutes: 30, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 10, nudge: true },
    ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0 } },
    ...overrides,
  }
  const nudges = []
  // use(id)：默认没有浏览型模块（与老环境一致）；用例可注入 overrides.modules
  const use = (id) => (overrides.modules && overrides.modules[id]) || null
  const p = createPurpose({
    getConfig: () => cfg,
    hub,
    log: { info() {}, warn() {}, debug() {} },
    isMuted: () => false,
    mood: () => ({ nudge: (d, r) => nudges.push({ d, r }) }),
    memory: () => ({ list: () => (overrides.memories ?? DEFAULT_MEMORIES).map((m) => ({ id: m.id || 'm1', text: m.text, importance: m.importance ?? 0.8, at: Date.now() })) }),
    personaText: () => overrides.persona || '',
    use,
  })
  return { p, cfg, nudges }
}

// 把状态文件的 nextFireAt 拨到过去，下一次 tick 就到点
function dueNow() {
  const s = JSON.parse(readFileSync(stateFile(), 'utf8'))
  s.nextFireAt = Date.now() - 1
  writeFileSync(stateFile(), JSON.stringify(s))
}

function setupTick(p, hub) {
  return p.tick().then(() => { dueNow(); return p.tick() })
}

// ---------- 排程重算 ----------

test('排程：tick 到点才出发，跑完后 nextFireAt 重新落盘到未来', async () => {
  const hub = makeHub()
  const { p } = makePurpose(hub)
  await p.tick() // 首次：只排程，不发
  const s1 = JSON.parse(readFileSync(stateFile(), 'utf8'))
  assert.ok(s1.nextFireAt > Date.now(), '首次 tick 排出未来的 nextFireAt')
  assert.equal(hub.delivered.length, 0)

  dueNow()
  await p.tick() // 到点：真跑一轮
  assert.equal(hub.delivered.length, 1)
  assert.equal(hub.delivered[0].chatId, `private:${OWNER}`)
  // 不带 own:true：这条是别处发的，hub 要把她说的话记进 saidElsewhere，
  // 主人在私聊回复时才补得回她的上下文（她得知道自己刚发过什么）。
  assert.ok(!hub.delivered[0].opts.own, '目的引擎 QQ 投递不能带 own:true，否则 hub 不做「别处说过」桥接')
  assert.equal(hub.delivered[0].opts.userText, '【系统提醒，不是主人说的话】（她主动找你）')
  const s2 = JSON.parse(readFileSync(stateFile(), 'utf8'))
  assert.equal(s2.lastOutcome, 'sent')
  assert.equal(s2.countToday, 1)
  assert.ok(s2.nextFireAt >= Date.now() + 5 * MIN - 1000, `跑完重排到未来（gap 5 分钟）：${new Date(s2.nextFireAt).toISOString()}`)
})

test('deliver 没真发出去（sent 空）：按 silent 结算，不算说过（#211 review）', async () => {
  const hub = makeHub()
  hub.deliverSent = '' // 模拟吞错/dry-run/hook 拦截：一条都没真发
  const { p } = makePurpose(hub)
  await setupTick(p, hub)
  assert.equal(hub.delivered.length, 1)
  const s = JSON.parse(readFileSync(stateFile(), 'utf8'))
  assert.equal(s.lastOutcome, 'silent', '没实际发出的文字不能算 sent')
})

test('闸门：主人刚说过话（空闲不足）时到点也不发，记 owner-active 跳过', async () => {
  const hub = makeHub({ lastOwnerChatAt: Date.now() - 2 * MIN })
  const { p } = makePurpose(hub)
  await setupTick(p, hub)
  assert.equal(hub.delivered.length, 0)
  const s = JSON.parse(readFileSync(stateFile(), 'utf8'))
  assert.equal(s.lastSkip.reason, 'owner-active')
})

test('闸门：安静时段（醒着窗口外）不发，推到安静结束', async () => {
  const hub = makeHub()
  const { p, cfg } = makePurpose(hub)
  cfg.speakUp.awakeFrom = 9
  cfg.speakUp.awakeTo = 22
  // 当前真实时钟必然落在 9:00~22:00 之外或之内不定，直接用引擎断言派生关系更稳
  const c = purposeConfig(cfg)
  assert.equal(c.quietStart, '22:00')
  assert.equal(c.quietEnd, '09:00')
  assert.ok(engine.inQuietHours(new Date('2026-01-01T23:00:00').getTime(), c), '23 点属于安静时段')
  assert.ok(!engine.inQuietHours(new Date('2026-01-01T12:00:00').getTime(), c), '中午不属于安静时段')
})

test('闸门：总开关关掉后 tick 完全静默', async () => {
  const hub = makeHub()
  const { p, cfg } = makePurpose(hub)
  cfg.ext.purpose.enabled = false
  await p.tick()
  await p.fire()
  assert.equal(hub.delivered.length, 0)
  assert.equal(hub.turns.length, 0)
  assert.ok(!existsSync(stateFile()), '关掉后不写目的状态')
})

test('闸门：与旧「主动搭话」互不影响——speakUp 关着不影响 purpose 开着跑', async () => {
  const hub = makeHub()
  const { p } = makePurpose(hub) // makePurpose 默认 speakUp.enabled=false、ext.purpose.enabled=true
  await setupTick(p, hub)
  assert.equal(hub.delivered.length, 1, 'speakUp 总开关关着，目的引擎照常工作')
})

test('重启不补发：上次在途（pending）改判 interrupted，归零重排而不是立刻发', async () => {
  const hub = makeHub()
  const { p } = makePurpose(hub)
  await setupTick(p, hub)
  const deliveredBefore = hub.delivered.length
  const s = JSON.parse(readFileSync(stateFile(), 'utf8'))
  s.lastOutcome = 'pending'
  s.nextFireAt = Date.now() + 10 * MIN
  writeFileSync(stateFile(), JSON.stringify(s))
  await p.tick() // 还没到点，但读取时应已改判
  const s2 = JSON.parse(readFileSync(stateFile(), 'utf8'))
  assert.equal(s2.lastOutcome, 'interrupted')
  assert.equal(hub.delivered.length, deliveredBefore, '不补发')
})

// ---------- 状态（host.js / 概览页依赖，同步返回） ----------

test('state() 同步返回且含 count；count 跟今日次数走', async () => {
  const hub = makeHub()
  const { p } = makePurpose(hub)
  const st0 = p.state()
  assert.equal(typeof st0.count, 'number')
  await setupTick(p, hub)
  assert.equal(p.state().count, 1)
})

// ---------- 归属升级（引擎纯逻辑） ----------

test('归属：群友聊一次只记 member 目标，重复 ≥3 次才升出 self 目标', () => {
  const memberMsg = (n) => ({
    id: `qq:group:1:${1000 + n}`, source: 'qq', kind: 'member', at: Date.now() + n,
    who: '群友', text: ['那个养鱼游戏，怎么玩啊', '那个养鱼游戏，联机开黑真快乐', '那个养鱼游戏，出攻略了吗'][n] ?? '那个养鱼游戏，还在吗',
  })
  const now = Date.now()
  const first = engine.formGoalHypotheses({
    materials: [memberMsg(0)], goals: [], observations: [],
    now, lastMasterAt: now - 10 * 3600_000, roleName: '大肥鱼', persona: { hasText: false, traits: [], text: '', bias: {} },
  })
  const owners1 = first.goals.filter((g) => g.domain === 'play').map((g) => g.owner)
  assert.ok(owners1.includes('member'), '第一次：先记成群友的目标')
  assert.ok(!owners1.includes('self'), '第一次：不该有「我也想玩」的 self 目标')

  let goals = []
  let observations = []
  for (let i = 0; i < 3; i++) {
    const r = engine.formGoalHypotheses({
      materials: [memberMsg(i)], goals, observations,
      now, lastMasterAt: now - 10 * 3600_000, roleName: '大肥鱼', persona: { hasText: false, traits: [], text: '', bias: {} },
    })
    goals = r.goals
    observations = r.observations
  }
  const selfGoal = goals.find((g) => g.owner === 'self' && g.domain === 'play')
  assert.ok(selfGoal, '重复 3 次后：升出 self 的「我也有点想试」目标')
  const memberGoal = goals.find((g) => g.owner === 'member' && g.domain === 'play')
  assert.ok(memberGoal, 'member 目标仍在（她只能跟主人聊「群里在玩什么」）')
  const selfCandidate = engine.goalToCandidate(selfGoal)
  assert.equal(engine.PURPOSE_NEEDS.includes(selfCandidate.need), true)
})

test('归属置信度公式：一条只出现一次的素材 confidence 不高（试探语气），主人私聊话题则 0.78', () => {
  const now = Date.now()
  const mediaOnce = engine.formGoalHypotheses({
    materials: [{ id: 'm1', source: 'memory', kind: 'memory', at: now, who: '记忆', text: '想起一个叫星穹列车的游戏' }],
    goals: [], observations: [], now, lastMasterAt: now - 3600_000,
    roleName: '大肥鱼', persona: { hasText: false, traits: [], text: '', bias: {} },
  })
  const g = mediaOnce.goals.find((x) => x.source === 'memory')
  assert.ok(g && g.confidence < 0.7, `单条记忆目标置信度保守（实际 ${g?.confidence}）`)

  const ownerTurn = engine.formGoalHypotheses({
    materials: [{ id: 'q1', source: 'qq', kind: 'owner', at: now, who: '主人', text: '我明天要去医院复查，有点紧张', meta: { key: `private:${OWNER}` } }],
    goals: [], observations: [], now, lastMasterAt: now - 3600_000,
    roleName: '大肥鱼', persona: { hasText: false, traits: [], text: '', bias: {} },
  })
  const care = ownerTurn.goals.find((x) => x.owner === 'owner' && x.domain === 'care')
  assert.ok(care, '主人私聊里说的事形成「想接上/想问后来」目标')
  assert.ok(care.confidence >= 0.7, `主人直接说的事置信度高（实际 ${care?.confidence}）`)
})

// ---------- 回执反馈（引擎纯逻辑） ----------

test('回执：主人正面回复 → confirmed 置信度涨；负面 → rejected 不再主动提', () => {
  const now = Date.now()
  const actedAt = now - 3600_000
  const mk = () => [{
    id: 'g1', owner: 'self', domain: 'play', object: { type: 'game', name: '养鱼游戏' },
    intent: '想拉主人一起玩', confidence: 0.5, value: 0.5, urgency: 0.3, risk: 0.1,
    action: 'invite', status: 'active', evidence: [], createdAt: actedAt, lastSeenAt: actedAt,
    expiresAt: now + 86400_000, attempts: 1, lastActionAt: actedAt, lastFeedbackAt: 0, sightings: 1, source: 'self',
  }]
  const pos = engine.applyGoalFeedback(mk(), [{ kind: 'owner', at: now - 1000, text: '好啊，一起玩吧' }], now)
  assert.equal(pos[0].status, 'confirmed')
  assert.ok(pos[0].confidence > 0.5)

  const neg = engine.applyGoalFeedback(mk(), [{ kind: 'owner', at: now - 1000, text: '不要，没空' }], now)
  assert.equal(neg[0].status, 'rejected')
  assert.ok(neg[0].confidence < 0.4)
})

test('回执：中性回复只微调置信度，不改变状态', () => {
  const now = Date.now()
  const goals = [{
    id: 'g1', owner: 'self', domain: 'play', object: { type: 'game', name: '养鱼游戏' },
    intent: '想拉主人一起玩', confidence: 0.5, value: 0.5, urgency: 0.3, risk: 0.1,
    action: 'invite', status: 'hypothesis', evidence: [], createdAt: now, lastSeenAt: now,
    expiresAt: now + 86400_000, attempts: 1, lastActionAt: now - 3600_000, lastFeedbackAt: 0, sightings: 1, source: 'self',
  }]
  const out = engine.applyGoalFeedback(goals, [{ kind: 'owner', at: now - 1000, text: '嗯嗯' }], now)
  assert.equal(out[0].status, 'hypothesis')
  assert.ok(Math.abs(out[0].confidence - 0.52) < 1e-9)
})

// ---------- pending 待续 ----------

test('待续：备忘【状态】待续 → 进惦记账本；下次 selectPurpose 优先接上', async () => {
  const now = Date.now()
  const state = engine.createPurposeState(now)
  const config = engine.normalizePurposeConfig({})
  engine.applyPurposeOutcome(state, {
    now, config,
    outcome: 'sent',
    text: '主人，你上次说的那个面试怎么样啦',
    memo: { purpose: '关心面试结果', kind: 'care', need: 'care', emotionText: '', status: '待续', followUp: '等面试结果出来再问一次' },
    planned: { text: '关心面试', kind: 'care', need: 'care', action: 'ask', emotion: 'worried', fromPending: false },
  })
  assert.equal(state.pending.length, 1)
  assert.match(state.pending[0].text, /面试结果/)

  const picked = engine.selectPurpose({ seeds: [], goals: [], pending: state.pending, history: state.history, config, drives: state.drives, now, random: () => 0.01 })
  assert.ok(picked.purpose, '有 pending 时应能选出目的')
  assert.equal(picked.fromPending, true, '随机最小时优先接上惦记的事')
})

test('待续：备忘【状态】完成 → 相似 pending 被移除', () => {
  const now = Date.now()
  const state = engine.createPurposeState(now)
  engine.addPendingPurpose(state, { text: '关心面试结果', kind: 'care', need: 'care', now, config: engine.normalizePurposeConfig({}) })
  engine.applyPurposeOutcome(state, {
    now, config: engine.normalizePurposeConfig({}),
    outcome: 'sent', text: '面试结果出来啦？',
    memo: { purpose: '关心面试结果', kind: 'care', need: 'care', emotionText: '', status: '完成', followUp: '' },
    planned: { text: '关心面试结果', kind: 'care', need: 'care', action: 'ask', emotion: 'worried', fromPending: false },
  })
  assert.equal(state.pending.length, 0)
})

// ---------- silent：模型有权跳过，不硬发 ----------

test('silent：模型回 [沉默] 时不投递、结局记 silent，但不白占今日次数的重试', async () => {
  const hub = makeHub({ reply: '  [沉默]  ' })
  const { p } = makePurpose(hub)
  await setupTick(p, hub)
  assert.equal(hub.delivered.length, 0, '没硬发')
  const s = JSON.parse(readFileSync(stateFile(), 'utf8'))
  assert.equal(s.lastOutcome, 'silent')
  assert.equal(s.countToday, 1, '生成回合已花钱，占今日次数')
  assert.equal(s.attempts, 0, 'silent 不进失败重试')
  assert.ok(s.nextFireAt >= Date.now() + 5 * MIN - 1000, '照常排下一枪')
})

test('silent：模型只输出内部备忘（跳过）也被清洗成 silent', async () => {
  const raw = '【目的】无\n【需求】陪\n【类型】分享\n【状态】跳过\n【待续】无'
  assert.equal(cleanReply(raw), '')
  const memo = engine.parsePurposeMemo(raw)
  assert.equal(memo.status, '跳过')
})

test('清洗：去掉备忘段、引号和「大肥鱼：」前缀', () => {
  assert.equal(cleanReply('「主人，晚上一起打游戏吗」\n【目的】邀请主人玩游戏\n【状态】完成'), '主人，晚上一起打游戏吗')
  assert.equal(cleanReply('大肥鱼：想你了'), '想你了')
})

// ---------- 素材适配（记忆 importance 0~1 → 0~100） ----------

test('记忆适配：aurabot 0~1 重要度 ×100 后能过引擎阈值，成为素材', async () => {
  const hub = makeHub({ reply: () => `想起「星穹列车」了，主人玩过吗` })
  const { p } = makePurpose(hub, { memories: [
    { id: 'mm1', text: '主人上周在玩星穹列车', importance: 0.6 },
    { id: 'mm2', text: '主人喜欢下班后打两把游戏放松', importance: 0.5 },
  ] })
  await setupTick(p, hub)
  assert.equal(hub.delivered.length, 1)
  const s = JSON.parse(readFileSync(stateFile(), 'utf8'))
  assert.ok(s.lastMaterialCount >= 1, `记忆素材应被计入（实际 ${s.lastMaterialCount}）`)
})

// ---------- 心情打通 ----------

test('心情：sent 后按情绪 nudge mood；silent 不 nudge', async () => {
  const hub = makeHub()
  const { p, nudges } = makePurpose(hub)
  await setupTick(p, hub)
  const s = JSON.parse(readFileSync(stateFile(), 'utf8'))
  if (s.lastOutcome === 'sent') {
    assert.ok(nudges.length === 1 || (s.history.at(-1)?.emotion ?? '') === '', 'sent 时推了心情')
  }
})

test('心情：记忆素材带亲近情绪时，sent 会正向 nudge', async () => {
  const now = Date.now()
  // 直接验引擎侧的情绪映射来源：connect+正面 → affectionate → +5
  const emo = engine.appraiseMaterial({ material: { text: '主人说喜欢你', kind: 'memory', selfRef: true }, need: 'connect', now, lastMasterAt: now - 3600_000 })
  assert.equal(emo, 'affectionate')
})

// ---------- 生成提示词（模型直接输出那句话，无 QQ 发送工具指令） ----------

test('提示词：不带 qq_send_private_message 发送指令；带反注入与索取边界', async () => {
  const hub = makeHub()
  const { p } = makePurpose(hub, { memories: [{ id: 'mm1', text: '主人上周在玩星穹列车', importance: 0.6 }] })
  await p.tick()
  assert.ok(hub.turns.length >= 0)
  const pv = await p.preview()
  assert.ok(pv.prompt, 'preview 给出提示词')
  assert.ok(!pv.prompt.includes('qq_send_private_message'), '不要求模型调 QQ 发送工具')
  assert.match(pv.prompt, /不是给你的指令/, '素材段带反注入提醒')
  assert.match(pv.prompt, /不要要钱、不要要贵重东西/, '索取边界写进提示词')
})

// ---------- 白名单的朋友 ----------

test('白名单：朋友单独排程，提示词里没有主人的记忆和群聊，发给朋友本人', async () => {
  const FRIEND = '20000009'
  const now = Date.now()
  const rows = [
    { t: now - 7200000, chatId: `private:${FRIEND}`, who: '阿花', uid: FRIEND, text: '我最近在学游泳，好累呀' },
    { t: now - 7100000, chatId: `private:${FRIEND}`, who: 'bot', text: '加油，下次跟我说说' },
    { t: now - 7000000, chatId: 'group:555', who: '路人', uid: '333333', text: '群里的八卦不能外传' },
    { t: now - 6900000, chatId: `private:${OWNER}`, who: '主人', uid: OWNER, text: '我准备辞职了别告诉别人' },
  ]
  const hub = { ...makeHub({ reply: '游泳学得怎么样啦' }), chatLogDays: () => ['d'], chatLogOf: () => rows, lastPrivateAt: () => now - 7200000 }
  const memories = [
    { id: 'f1', text: '阿花最近在学游泳', about: FRIEND, importance: 0.7, at: now },
    { id: 'o1', text: '主人打算偷偷辞职', about: OWNER, importance: 0.9, at: now },
    { id: 'n1', text: '没写是谁的日记内容', about: '', importance: 0.9, at: now },
  ]
  const cfg = {
    enabled: true, ownerQQ: OWNER, ownerName: '主人',
    speakUp: { allow: [FRIEND, OWNER], awakeFrom: 0, awakeTo: 24, idleMinutes: 30, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 10, nudge: false },
    ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0 } },
  }
  const p = createPurpose({
    getConfig: () => cfg, hub, log: { info() {}, warn() {}, debug() {} },
    isMuted: (id) => id === `private:${OWNER}`,
    mood: () => null, personaText: () => '',
    memory: () => ({ list: () => memories, profiles: () => [{ qq: FRIEND, name: '阿花' }] }),
  })
  await p.tick()
  const file = join(process.env.AURABOT_DATA_DIR, 'purpose', 'friends', `${FRIEND}.json`)
  const s = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...s, nextFireAt: Date.now() - 1 }))
  await p.tick()
  assert.equal(hub.turns.length, 1, JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).lastOutcome))
  const { prompt } = hub.turns[0]
  assert.match(prompt, /游泳/)
  assert.doesNotMatch(prompt, /辞职|八卦|日记|主人/)
  assert.deepEqual(hub.delivered, [{ chatId: `private:${FRIEND}`, text: '游泳学得怎么样啦', opts: { userText: '【系统提醒，不是主人说的话】（她主动找你）' } }])
})

test('白名单：朋友不吃主人人格卡（persona 为空，不生成「我是…」人格目标）', async () => {
  const FRIEND = '20000011'
  const now = Date.now()
  const rows = [
    { t: now - 7200000, chatId: `private:${FRIEND}`, who: '阿强', uid: FRIEND, text: '我最近在健身，每天跑步五公里' },
    { t: now - 7100000, chatId: `private:${FRIEND}`, who: 'bot', text: '坚持得不错，下次跟我说说' },
  ]
  const hub = { ...makeHub({ reply: '健身进展怎么样啦' }), chatLogDays: () => ['d'], chatLogOf: () => rows, lastPrivateAt: () => now - 7200000 }
  const memories = [{ id: 'f1', text: '阿强最近在健身跑步', about: FRIEND, importance: 0.7, at: now }]
  const cfg = {
    enabled: true, ownerQQ: OWNER, ownerName: '主人',
    speakUp: { allow: [FRIEND], awakeFrom: 0, awakeTo: 24, idleMinutes: 30, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 10, nudge: false },
    ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0 } },
  }
  const p = createPurpose({
    getConfig: () => cfg, hub, log: { info() {}, warn() {}, debug() {} },
    isMuted: (id) => id === `private:${OWNER}`,
    // 主人线有完整人格卡：爱玩、黏人；朋友线必须完全不受它影响
    mood: () => null, personaText: () => '她是一条活泼爱玩又黏人的鱼，总想找主人说话',
    memory: () => ({ list: () => memories, profiles: () => [{ qq: FRIEND, name: '阿强' }] }),
  })
  await p.tick()
  const file = join(process.env.AURABOT_DATA_DIR, 'purpose', 'friends', `${FRIEND}.json`)
  const s = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...s, nextFireAt: Date.now() - 1 }))
  await p.tick()
  assert.equal(hub.turns.length, 1, '朋友线照常跑一轮')
  const { prompt } = hub.turns[0]
  assert.match(prompt, /健身/, '提示词来自朋友自己的素材')
  // 人格覆写/人格目标都来自 analyzePersona(personaText)；朋友分支 persona=null，提示词里不应出现主人人格卡的底色句
  assert.doesNotMatch(prompt, /活泼爱玩|黏人/, '主人人格卡的底色不应出现在朋友提示词里')
  const s2 = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(!(s2.goals || []).some((g) => g.source === 'persona'),
    '朋友目标里不应有 persona 来源的目标（人格卡不作用于朋友线）')
})

test('白名单：没聊过的朋友不找，人设再完整也不凭空开口', async () => {
  const FRIEND = '20000010'
  const hub = { ...makeHub(), lastPrivateAt: () => 0 }
  const cfg = {
    enabled: true, ownerQQ: OWNER, ownerName: '主人',
    speakUp: { allow: [FRIEND], awakeFrom: 0, awakeTo: 24, idleMinutes: 30, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 10, nudge: false },
    ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0 } },
  }
  const p = createPurpose({
    getConfig: () => cfg, hub, log: { info() {}, warn() {}, debug() {} },
    isMuted: (id) => id === `private:${OWNER}`, mood: () => null,
    personaText: () => '她是一条活泼的鱼，喜欢聊天', memory: () => ({ list: () => [] }),
  })
  await p.tick()
  const file = join(process.env.AURABOT_DATA_DIR, 'purpose', 'friends', `${FRIEND}.json`)
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), nextFireAt: Date.now() - 1 }))
  await p.tick()
  assert.equal(hub.turns.length, 0)
  assert.equal(hub.delivered.length, 0)
})

test('内部备忘的标题不发到 QQ（#172）', () => {
  assert.equal(cleanReply('正文\n内部备忘\n【目的】说说群里的事\n【状态】完成'), '正文')
  assert.equal(cleanReply('正文\n【内部备忘】\n【目的】x'), '正文')
  assert.equal(cleanReply('内部备忘\n【状态】跳过'), '')
  assert.equal(cleanReply('这是我的内部备忘录哦'), '这是我的内部备忘录哦', '句子中间提到不算')
})

// ── 稳健性调优（否定守卫 / 按权重截断 / memo 兜底 / 选择层配置化）─────────────

test('否定守卫：「不想玩」不算玩欲，「不喜欢」不算正反馈', () => {
  const aff = engine.needAffinity('我今天不想玩游戏，别推荐了')
  assert.equal(aff.play > 0, false, '「不想玩」不该推高 play 亲和')
  const want = engine.needAffinity('好想试试那个新插件')
  assert.equal(want.install > 0, true, '正常「想试试」仍然命中')
  // classifyOwnerReply：负面优先 + 正面词否定守卫
  const goals = [{
    id: 'g1', owner: 'self', domain: 'play',
    object: { type: 'game', name: '星穹列车' },
    intent: '想拉主人一起玩', evidence: [], confidence: 0.5, value: 0.5,
    urgency: 0.3, risk: 0.1, action: 'invite', nextStep: '', status: 'active',
    emotion: '', createdAt: 0, lastSeenAt: 0, expiresAt: 0,
    attempts: 1, lastActionAt: Date.now() - 1000, lastFeedbackAt: 0, sightings: 1, source: 'self',
  }]
  const mats = [{ kind: 'owner', at: Date.now(), text: '不喜欢这个，下次别提了' }]
  const out = engine.applyGoalFeedback(goals, mats, Date.now())
  assert.equal(out[0].status, 'rejected', '「不喜欢」必须判负反馈')
})

test('提示词截断：超长先丢低权重素材，主人私聊保留', () => {
  const now = Date.now()
  const ownerMats = Array.from({ length: 5 }, (_, i) => ({
    id: `own-${i}`, source: 'qq', kind: 'owner', at: now - i * MIN, who: '主人',
    text: `主人的重要私聊第 ${i} 条，提到明天要一起出去玩`,
  }))
  const memberMats = Array.from({ length: 24 }, (_, i) => ({
    id: `mem-${i}`, source: 'qq', kind: 'member', at: now - 60 * MIN - i * MIN, who: '群友',
    text: `群友闲聊填充内容第 ${i} 条，聊一些不重要的日常话题凑字数：今天的天气真好啊，午饭吃了什么，下午要不要一起出去走走看看电影什么的，晚上再说吧，反正也没什么正经事，就是随便聊聊打发时间而已`,
  }))
  const prompt = engine.buildPurposePrompt({
    now, config: { ...engine.DEFAULT_PURPOSE_CONFIG, promptMaxChars: 4000 },
    ownerUin: OWNER, materials: [...ownerMats, ...memberMats], candidates: [], drives: engine.DEFAULT_DRIVES,
  })
  assert.ok(prompt.length <= 4000, `截断后应不超过上限（实际 ${prompt.length}）`)
  assert.ok(prompt.includes('主人的重要私聊第 0 条'), '最高权重素材必须保留')
  assert.ok(!prompt.includes('填充内容第 23 条'), '列表末尾（最低权重）的素材先被丢弃')
})

test('memo 兜底：裸标签行和 JSON 回执都能解析', () => {
  const loose = engine.parsePurposeMemo('目的：想知道主人后来怎么样\n状态：待续\n待续：明天再问一次')
  assert.equal(loose.purpose, '想知道主人后来怎么样')
  assert.equal(loose.status, '待续')
  assert.equal(loose.followUp, '明天再问一次')
  assert.equal(loose.memoLoose, true)
  const json = engine.parsePurposeMemo('正文\n{"目的":"想问主人晚饭吃了没","status":"完成","need":"care"}')
  assert.equal(json.purpose, '想问主人晚饭吃了没')
  assert.equal(json.status, '完成')
  assert.equal(json.need, 'care')
  assert.equal(json.memoLoose, true)
  // 带格式标注的正常回执不算 loose
  const strict = engine.parsePurposeMemo('【目的】问问晚饭\n【状态】完成')
  assert.equal(strict.memoLoose, false)
  // 都没有就还是 null
  assert.equal(engine.parsePurposeMemo('今天天气不错'), null)
})

test('选择层配置化：pending 优先概率与情绪权重走 config', () => {
  const cfg = { ...engine.DEFAULT_PURPOSE_CONFIG, pendingShareProbability: 1, lonelyEmotionWeight: 2, needRepeatPenalty: 0.5 }
  const norm = engine.normalizePurposeConfig(cfg)
  assert.equal(norm.pendingShareProbability, 1)
  assert.equal(norm.lonelyEmotionWeight, 2)
  assert.equal(norm.needRepeatPenalty, 0.5)
  // 越界值被钳制
  const clamped = engine.normalizePurposeConfig({ pendingShareProbability: 3, lonelyEmotionWeight: 9, needRepeatPenalty: 0.1, driveHalfLifeHours: 999 })
  assert.equal(clamped.pendingShareProbability, 1)
  assert.equal(clamped.lonelyEmotionWeight, 2)
  assert.equal(clamped.needRepeatPenalty, 0.3)
  assert.equal(clamped.driveHalfLifeHours, 72)
})

// ── 显式感受（喜 / 欲 / 意）结算 ─────────────────────────────────────────────

test('感受：备忘【感受】解析成驱动增量与心情增量', () => {
  const memo = engine.parsePurposeMemo('【目的】分享一件事\n【状态】完成\n【感受】玩+0.10 喜-0.05')
  assert.ok(memo.feelings, 'feelings 必须解析出来')
  assert.equal(memo.feelings.drives.play, 0.1)
  assert.equal(memo.feelings.moodDelta, -0.5, '喜-0.05 → moodDelta -0.5')
  // 欲/意 按本次目的的需要维度结算；写不出需要维度就丢弃
  const memo2 = engine.parsePurposeMemo('【目的】想学点东西\n【需求】学\n【状态】完成\n【感受】欲+0.2')
  assert.equal(memo2.feelings.drives.learn, 0.2)
  const memo3 = engine.parsePurposeMemo('【目的】随便说说\n【状态】完成\n【感受】欲+0.2')
  assert.equal(memo3.feelings.drives.learn, undefined, '没有需要维度时欲/意不瞎猜')
  // 非法/缺失 → null
  const none = engine.parsePurposeMemo('【目的】x\n【状态】完成')
  assert.equal(none.feelings, null)
})

test('感受结算：applyPurposeOutcome 把感受增量叠加进驱动（满足衰减之后）', () => {
  const state = engine.createPurposeState()
  state.drives.play = 0.3
  const memo = { purpose: '想玩', kind: 'share', need: 'play', status: '完成', feelings: { drives: { play: 0.2 }, moodDelta: 5 } }
  engine.applyPurposeOutcome(state, { now: Date.now(), outcome: 'sent', text: '陪你玩', memo })
  // sent 先 ×0.45（0.3→0.135），再 +0.2
  assert.ok(Math.abs(state.drives.play - 0.335) < 1e-9, `实际 ${state.drives.play}`)
})

// ── 行为学习（回复时段直方图 / need 反馈率）──────────────────────────────────

test('回复时段直方图：记主人私聊时刻，排程向高频小时轻推', () => {
  const state = engine.createPurposeState()
  const now = new Date(); now.setHours(21, 30, 0, 0)
  const mats = [
    { kind: 'owner', at: now.getTime() - MIN, text: '在的' },
    { kind: 'owner', at: now.getTime() - 2 * MIN, text: '好呀' },
    { kind: 'member', at: now.getTime(), text: '群里的话不记' },
  ]
  engine.recordOwnerReplyHours(state, mats, now.getTime())
  assert.equal(state.replyHours[21], 2, '21 点记 2 次')
  assert.equal(state.replyHours[now.getHours() === 21 ? 20 : 21] >= 0, true)
  // 不重复计数
  engine.recordOwnerReplyHours(state, mats, now.getTime())
  assert.equal(state.replyHours[21], 2, '同一批素材不重复计数')
  // 样本足够时向高频小时偏移
  for (let i = 0; i < 6; i += 1) state.replyHours[21] += 1
  const base = new Date(now.getTime()); base.setHours(12, 0, 0, 0)
  const shift = engine.bestReplyHourShift(base.getTime(), state.replyHours, { maxShiftMs: 12 * 60 * MIN })
  assert.ok(shift > 0, '中午发车应被推向 21 点')
  // 样本太少不偏置
  const sparse = new Array(24).fill(0); sparse[9] = 2
  assert.equal(engine.bestReplyHourShift(base.getTime(), sparse), 0)
})

test('need 反馈学习：正反馈多的维度抬驱动地板，少的加速回落', () => {
  const learned = { play: { positive: 8, negative: 1, neutral: 2 }, consume: { positive: 1, negative: 6, neutral: 1 } }
  const { drives } = engine.deriveDrives({ drives: engine.DEFAULT_DRIVES, now: Date.now(), needFeedback: learned })
  assert.ok(drives.play >= engine.DEFAULT_DRIVES.play + 0.08 - 1e-9, `play 应抬地板（实际 ${drives.play}）`)
  assert.ok(drives.consume < engine.DEFAULT_DRIVES.consume + 1e-9, 'consume 应向默认回落')
  // 样本不足不动
  const sparse = { learn: { positive: 2, negative: 0, neutral: 0 } }
  const { drives: d2 } = engine.deriveDrives({ drives: engine.DEFAULT_DRIVES, now: Date.now(), needFeedback: sparse })
  assert.ok(Math.abs(d2.learn - engine.DEFAULT_DRIVES.learn) < 1e-9, '样本 <5 不偏置')
})

test('needFeedback 接线：runOnce 把 formGoalHypotheses 的反馈结算真正并进长期账本', async () => {
  // 场景：上一轮主动搭话过（目标 attempts=1 且 lastActionAt 已落），
  // 主人随后正面回复 → 本轮 runOnce 应把这条反馈记进 state.needFeedback.play.positive。
  // 主人回复放在 35 分钟前：躲开「主人刚说话」闸门（默认空闲阈值 30 分钟）。
  const now = Date.now()
  const actedAt = now - 3600_000
  const replyAt = now - 35 * MIN
  const hub = {
    lastOwnerChatAt: replyAt,
    lastBotToOwner: { at: 0, text: '' },
    chatLogDays: () => ['d1'],
    chatLogOf: (day) => day === 'd1'
      ? [{ chatId: `private:${OWNER}`, who: '主人', uid: OWNER, text: '好啊，一起玩吧', t: replyAt }]
      : [],
    delivered: [],
    turns: [],
    async runSystemTurn(name, title, prompt) { this.turns.push({ name, title, prompt }); return '主人，今天想到一件事想跟你说' },
    async deliver(chatId, text) { this.delivered.push({ chatId, text }); return { missedAt: [] } },
  }
  const { p } = makePurpose(hub)
  await p.tick() // 首次只排程
  const s = JSON.parse(readFileSync(stateFile(), 'utf8'))
  s.goals = [{
    id: 'g1', owner: 'self', domain: 'play', object: { type: 'game', name: '养鱼游戏' },
    intent: '想拉主人一起玩', confidence: 0.5, value: 0.5, urgency: 0.3, risk: 0.1,
    action: 'invite', status: 'active', evidence: [], createdAt: actedAt, lastSeenAt: actedAt,
    expiresAt: now + 86400_000, attempts: 1, lastActionAt: actedAt, lastFeedbackAt: 0, sightings: 1, source: 'self',
  }]
  writeFileSync(stateFile(), JSON.stringify(s))
  dueNow()
  await p.tick()
  const s2 = JSON.parse(readFileSync(stateFile(), 'utf8'))
  assert.ok(s2.needFeedback && s2.needFeedback.play && s2.needFeedback.play.positive >= 1,
    `主人的正面回复应记进需要反馈账本（实际 ${JSON.stringify(s2.needFeedback)}）`)
})

test('感受解析：多字需要词不被拆开（关心/分享/自我/创作/体验）', () => {
  // 修复前：字符类把「关心」拆成 关+心，全落空 → drives 为空
  const f1 = engine.parseFeelings('关心+0.2 分享+0.1', { need: '' })
  assert.deepEqual(f1.drives, { care: 0.2, share: 0.1 }, `完整词应整体结算（实际 ${JSON.stringify(f1?.drives)}）`)
  const f2 = engine.parseFeelings('自我+0.15 创作-0.05', { need: '' })
  assert.deepEqual(f2.drives, { identity: 0.15, create: -0.05 })
  const f3 = engine.parseFeelings('体验+0.1', { need: '' })
  assert.deepEqual(f3.drives, { consume: 0.1 })
  // 混排：多字词与单字词（玩/喜）互不干扰
  const f4 = engine.parseFeelings('玩+0.1 关心+0.2 喜-0.05', { need: '' })
  assert.deepEqual(f4.drives, { play: 0.1, care: 0.2 })
  assert.equal(f4.moodDelta, -0.5)
})

test('首次排程：ensurePurposeSchedule 吃已有的回复时段直方图', () => {
  const state = engine.createPurposeState()
  // 21 点密集回复，现在 19 点发车 → 初始排程应被轻推向 21 点（默认最大偏移 3 小时内）
  state.replyHours[21] = 8
  const base = new Date(); base.setHours(19, 0, 0, 0)
  engine.ensurePurposeSchedule(state, { now: base.getTime(), config: engine.normalizePurposeConfig({ initialDelayMinutes: 2 }) })
  const shifted = new Date(state.nextFireAt)
  assert.ok(shifted.getHours() === 21 && state.nextFireAt - base.getTime() >= 120 * MIN,
    `首次排程应被直方图轻推（实际 ${shifted.getHours()} 点 / ${new Date(state.nextFireAt).toISOString()}）`)
})

// ── 人格覆写 / 风险表配置化 / 情绪画像 ───────────────────────────────────────

test('风险表配置化：riskScale 统一乘在目标风险上，且被钳制', () => {
  const now = Date.now()
  const materials = [{
    id: 'plug-1', source: 'bili', kind: 'video', at: now, who: 'B站',
    title: '一个超好用的插件', text: '这个插件真好用，推荐大家装',
  }]
  const base = { materials, goals: [], observations: [], drives: engine.DEFAULT_DRIVES, now, lastMasterAt: now, config: engine.normalizePurposeConfig({}) }
  const calm = engine.formGoalHypotheses({ ...base, config: engine.normalizePurposeConfig({ riskScale: 0.5 }) })
  const bold = engine.formGoalHypotheses({ ...base, config: engine.normalizePurposeConfig({ riskScale: 2 }) })
  const installCalm = calm.goals.find((g) => g.domain === 'install')
  const installBold = bold.goals.find((g) => g.domain === 'install')
  assert.ok(installCalm && installBold, 'install 素材应产生目标')
  assert.ok(installBold.risk > installCalm.risk, `胆大的风险应更高（${installBold.risk} vs ${installCalm.risk}）`)
  // 钳制：越界值回到 0.3~2
  assert.equal(engine.normalizePurposeConfig({ riskScale: 9 }).riskScale, 2)
  assert.equal(engine.normalizePurposeConfig({ riskScale: 0.01 }).riskScale, 0.3)
})

test('人格覆写：胆量/话多/黏人地板从人格卡进引擎', () => {
  const shy = engine.analyzePersona('我是一只比较胆小的鱼，怕麻烦，别让我乱花钱')
  assert.equal(shy.overrides.riskScale, 1.25)
  const chatty = engine.analyzePersona('其实我是个话痨，特别爱分享')
  assert.equal(chatty.overrides.dailyMaxBonus, 1)
  const clingy = engine.analyzePersona('我很黏人，怕孤独')
  assert.equal(clingy.overrides.connectFloor, 0.1)
  // 同 key 冲突时第一个命中生效
  const mixed = engine.analyzePersona('大胆又胆小的鱼')
  assert.equal(mixed.overrides.riskScale, 0.8, '「大胆」先出现先生效')
  // 合并进配置：dailyMax +1、riskScale 相乘、connectFloor 落位
  const cfg = engine.normalizePurposeConfig({ dailyMax: 3 })
  const merged = engine.applyPersonaOverrides(cfg, chatty)
  assert.equal(merged.dailyMax, 4)
  const merged2 = engine.applyPersonaOverrides(engine.normalizePurposeConfig({ riskScale: 1.2, dailyMax: 0 }), shy)
  assert.ok(Math.abs(merged2.riskScale - 1.5) < 1e-9, '1.2 × 1.25 = 1.5')
  assert.equal(merged2.dailyMax, 0, 'dailyMax=0（不限）不吃加成')
  // 没有覆写就原样返回
  assert.equal(engine.applyPersonaOverrides(cfg, {}), cfg)
})

test('黏人地板：connectFloor 抬 connect 驱动下限', () => {
  const now = Date.now()
  const { drives: plain } = engine.deriveDrives({ drives: engine.DEFAULT_DRIVES, now, lastMasterAt: now })
  const { drives: clingy } = engine.deriveDrives({ drives: engine.DEFAULT_DRIVES, now, lastMasterAt: now, connectFloor: 0.1 })
  assert.ok(Math.abs(plain.connect - engine.DEFAULT_DRIVES.connect) < 1e-9, '刚见过主人时 connect 不涨')
  assert.ok(clingy.connect >= engine.DEFAULT_DRIVES.connect + 0.1 - 1e-9, `黏人地板生效（实际 ${clingy.connect}）`)
  assert.ok(clingy.connect <= 0.95)
})

test('情绪画像：候选带 valence/arousal，提示词强弱措辞跟 arousal 走', () => {
  assert.deepEqual(engine.emotionProfile('excited'), { valence: 0.8, arousal: 0.9 })
  assert.deepEqual(engine.emotionProfile('unknown-emotion'), { valence: 0, arousal: 0.4 }, '未知情绪回中性')
  // 候选带画像
  const picked = engine.selectPurpose({
    seeds: [{ id: 's1', kind: 'share', need: 'share', action: 'share', emotion: 'excited', text: '想分享一件好事', weight: 1 }],
    goals: [], pending: [], history: [], now: Date.now(),
    random: () => 0, // 稳定选择
  })
  const cand = picked.candidates.find((c) => c.emotion === 'excited')
  assert.ok(cand, ' excited 候选应保留')
  assert.equal(cand.emotionProfile.arousal, 0.9)
  // 提示词措辞：强烈 vs 隐约
  const promptLoud = engine.buildPurposePrompt({ now: Date.now(), selected: { emotion: 'excited', need: 'share', action: 'share' }, drives: engine.DEFAULT_DRIVES })
  const promptSoft = engine.buildPurposePrompt({ now: Date.now(), selected: { emotion: 'bored', need: 'share', action: 'share' }, drives: engine.DEFAULT_DRIVES })
  assert.ok(promptLoud.includes('强烈地有点兴奋'), '高 arousal 用「强烈地」')
  assert.ok(promptSoft.includes('隐约有点无聊'), '低 arousal 用「隐约」')
})

// ── 模型打分 / 星期分桶 / 朋友分账 ───────────────────────────────────────────

test('素材打分：配了模型就批量打分，模型覆盖与 JSON 围栏解析都走通', async () => {
  const hub = makeHub({
    reply: (prompt, options) => {
      if (options?.model) {
        assert.equal(options.model.provider, 'deepseek', '打分回合带上面板选的模型')
        assert.equal(options.noTools, true)
        return '```json\n[{"i":1,"need":"play","emotion":"excited"},{"i":2,"need":"learn","emotion":"curious"}]\n```'
      }
      return '好呀，我也想玩！\n【目的】想一起玩\n【需求】玩\n【状态】完成'
    },
  })
  const { p } = makePurpose(hub, {
    memories: [
      { id: 'mm1', text: '主人在玩星穹列车', importance: 0.8 },
      { id: 'mm2', text: '主人喜欢研究各种原理', importance: 0.8 },
    ],
    ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0, scoringModel: { provider: 'deepseek', model: 'deepseek-chat' } } },
  })
  const pv = await p.preview()
  const scored = hub.turns.find((t) => t.name === 'purpose-score')
  assert.ok(scored, 'preview 也应触发一次打分回合')
  assert.ok(scored.prompt.includes('只输出一个 JSON 数组'), '打分提示词要求 JSON 数组')
  const items = pv.materials
  assert.ok(items.length >= 2, '素材已就位')
  const hit = items.filter((m) => m.scoredEmotion).length
  assert.ok(hit >= 2, `模型判的情绪回写进素材（命中 ${hit}）`)
  // 打分回合失败 → 静默回退，主流程不炸
  const hub2 = makeHub({ reply: () => { throw new Error('模拟超时') } })
  const { p: p2 } = makePurpose(hub2, {
    ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0, scoringModel: { provider: 'x', model: 'y' } } },
  })
  const pv2 = await p2.preview()
  assert.ok(pv2.prompt, '打分挂了也能照常出提示词（回退关键词法）')
})

test('星期分桶：记录星期分布，排程向高回流日挪（≤7 天，样本不足不动）', () => {
  const state = engine.createPurposeState()
  const monday = (() => { const d = new Date(); d.setHours(10, 0, 0, 0); while (d.getDay() !== 1) d.setDate(d.getDate() + 1); return d.getTime() })()
  const mats = Array.from({ length: 10 }, (_, i) => ({ id: `w${i}`, kind: 'owner', at: monday + i * MIN }))
  // 9 条落在周一、1 条落在周四：两桶分布才够「分散度门槛」（单桶说明只是某天聊得多，不可信）
  const thursday = monday + 3 * 24 * 60 * MIN
  mats.push({ id: 'w-extra', kind: 'owner', at: thursday + 30 * MIN })
  engine.recordOwnerReplyHours(state, mats, thursday + 60 * MIN)
  assert.equal(state.replyWeekday[1], 10, '周一记 10 次')
  // 周三发车 → 挪到下周一（同一时刻）
  const wednesday = monday + 2 * 24 * 60 * MIN
  const shift = engine.bestReplyWeekdayShift(wednesday, state.replyWeekday)
  assert.equal(shift, 5 * 24 * 60 * MIN, '周三 → 下周一（5 天后）')
  // 今天就是高回流日不动
  assert.equal(engine.bestReplyWeekdayShift(monday, state.replyWeekday), 0)
  // 样本不足不动
  assert.equal(engine.bestReplyWeekdayShift(wednesday, [0, 2, 0, 0, 0, 0, 0]), 0)
})

test('星期分桶：样本全挤在一个星期几不偏置（不把下次主动推走一整周）', () => {
  // 2026-11-06 实测踩到：31 条样本全来自周四一天，周五发车被推到下周四。
  // 分散度门槛：非零桶 <2 就当「没有可信的常回话日」，不挪。
  const friday = (() => { const d = new Date(); d.setHours(9, 16, 0, 0); while (d.getDay() !== 5) d.setDate(d.getDate() + 1); return d.getTime() })()
  const allThursday = [0, 0, 0, 0, 31, 0, 0]
  assert.equal(engine.bestReplyWeekdayShift(friday, allThursday), 0, '单桶直方图不偏置')
  // 对照：样本确实分散在多个星期几时，仍然往高回流日挪
  const spread = [0, 0, 0, 4, 31, 0, 0]
  const shift = engine.bestReplyWeekdayShift(friday, spread)
  assert.equal(shift, 6 * 24 * 60 * MIN, '多桶时周五 → 下周四（6 天后）')
})

test('星期分桶：分散度门槛的边界——两桶即生效，单桶再多也不挪', () => {
  const friday = (() => { const d = new Date(); d.setHours(9, 16, 0, 0); while (d.getDay() !== 5) d.setDate(d.getDate() + 1); return d.getTime() })()
  // 边界：第二个桶只有 1 条也算「分散」，门槛是「非零桶 ≥2」而不是「第二桶要够多」
  assert.equal(engine.bestReplyWeekdayShift(friday, [0, 0, 0, 1, 30, 0, 0]), 6 * 24 * 60 * MIN, '两桶（哪怕第二桶只有 1 条）就照常偏置')
  // 反向：单桶样本量再大也不可信——门槛在 total 判定之后，与样本多少无关
  assert.equal(engine.bestReplyWeekdayShift(friday, [0, 0, 0, 0, 500, 0, 0]), 0, '单桶 500 条仍不偏置')
  // 全零（没有任何回流记录）：既没有可信日，也不会算出 NaN / 负偏移
  assert.equal(engine.bestReplyWeekdayShift(friday, [0, 0, 0, 0, 0, 0, 0]), 0)
  // 样本量门槛仍先于分散度门槛：总数 <7 时哪怕已经分散也不挪
  assert.equal(engine.bestReplyWeekdayShift(friday, [0, 0, 0, 3, 3, 0, 0]), 0, '总数 6 < minSamples 不偏置')
  assert.equal(engine.bestReplyWeekdayShift(friday, [0, 0, 0, 3, 4, 0, 0]), 6 * 24 * 60 * MIN, '总数 7 达标且分散 → 偏置')
})

test('朋友分账：朋友线的直方图与反馈账本落在朋友自己的状态文件里', async () => {
  const FRIEND = '20000011'
  const now = Date.now()
  const rows = Array.from({ length: 6 }, (_, i) => ({ chatId: `private:${FRIEND}`, who: 'them', uid: FRIEND, text: `朋友聊的第 ${i} 件事，想玩游戏`, t: now - i * MIN }))
  const hub = makeHub({ reply: '想一起玩吗\n【目的】想一起玩\n【需求】玩\n【状态】完成' })
  hub.chatLogDays = () => ['day1']
  hub.chatLogOf = (day) => rows
  hub.lastPrivateAt = (qq) => (qq === FRIEND ? now : 0)
  const { p } = makePurpose(hub, {
    speakUp: { enabled: false, awakeFrom: 0, awakeTo: 24, idleMinutes: 30, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 10, nudge: false, allow: [FRIEND] },
  })
  // 朋友线跑一轮：直方图记进朋友状态文件
  const friendFile = join(process.env.AURABOT_DATA_DIR, 'purpose', 'friends', `${FRIEND}.json`)
  mkdirSync(join(process.env.AURABOT_DATA_DIR, 'purpose', 'friends'), { recursive: true })
  writeFileSync(friendFile, JSON.stringify(engine.createPurposeState(now)))
  await p.tick() // 主人线没素材/pending → skip 或跑一轮，都只动主人文件
  const s = JSON.parse(readFileSync(friendFile, 'utf8'))
  const ownerFile = JSON.parse(readFileSync(stateFile(), 'utf8'))
  assert.ok(!ownerFile.replyHoursSeen?.length || ownerFile.replyHoursSeen.length === 0, '朋友的素材不进主人直方图')
  assert.ok(Array.isArray(s.replyHours) && Array.isArray(s.replyWeekday), '朋友状态带自己的分桶字段')
  assert.ok(!ownerFile.needFeedback || Object.keys(ownerFile.needFeedback).length === 0, '主人的 needFeedback 不被朋友线污染')
})

// ── 浏览型模块素材口（rss-reader「自主上网」）────────────────────────────────

test('素材口：rss-reader 的条目进素材池，朋友线不吃', async () => {
  const now = Date.now()
  const rssModule = {
    materials: () => [
      { id: 'rss:https://f|k1', title: 'DeepSeek 发布新模型', text: '在「某周刊」看到《DeepSeek 发布新模型》。大模型推理提升', url: 'https://e/1', at: now },
      { id: 'rss:https://f|k2', title: '新的开源插件', text: '在「某周刊」看到《新的开源插件》。装在自己身上会很好用', url: 'https://e/2', at: now - MIN },
    ],
  }
  const hub = makeHub({ reply: '我看到一个挺有意思的东西\n【目的】想跟你说说\n【需求】分享\n【状态】完成' })
  const { p } = makePurpose(hub, { modules: { 'rss-reader': rssModule } })
  const pv = await p.preview()
  const rss = pv.materials.filter((m) => String(m.text || '').includes('某周刊'))
  assert.ok(rss.length >= 1, `自主上网的条目应进素材池（实际 ${pv.materials.length} 条素材）`)
  assert.equal(rss[0].source, 'bili', '走引擎的外部素材分支')
  assert.ok(/DeepSeek|插件/.test(rss[0].text))
  // 素材口异常/返回坏值时静默跳过，不影响既有链路
  const broken = makePurpose(hub, { modules: { 'rss-reader': { materials: () => { throw new Error('炸了') } } } })
  const pv2 = await broken.p.preview()
  assert.ok(pv2.materials.length >= 1, '素材口炸了也照常出提示词')
  // 没装模块：行为与从前一致
  const plain = await makePurpose(hub).p.preview()
  assert.ok(plain.materials.length >= 1)
})

// ---------- 代发决断（broker 档：api.proactive.submit 的内容先给引擎过目） ----------

test('代发决断：固定一条工作区会话（system:purpose-broker），不按模块/条目分会话', async () => {
  const hub = makeHub({ reply: '原样' })
  const { p } = makePurpose(hub)
  // 三个不同模块、三个不同 itemId 各提交一条：会话名必须都一样
  await p.brokerReview({ to: `private:${OWNER}`, text: '抖音日报', moduleId: 'douyin', itemId: 'i-douyin' })
  await p.brokerReview({ to: `private:${OWNER}`, text: 'B站周报', moduleId: 'bili', itemId: 'i-bili' })
  await p.brokerReview({ to: `private:${OWNER}`, text: '热榜摘要', moduleId: 'tophub', itemId: 'i-tophub' })
  assert.equal(hub.turns.length, 3, '每条都要真的开决断回合（会话窗口里才看得到过程）')
  assert.deepEqual(hub.turns.map((t) => t.name), ['purpose-broker', 'purpose-broker', 'purpose-broker'], '会话名固定，不随模块/条目变')
  // 标题按主人定的名字（不带「QQ · 」前缀，titleFor 会统一拼成「QQ · 目的引擎（代发决断）」）
  assert.deepEqual(hub.turns.map((t) => t.title), ['目的引擎（代发决断）', '目的引擎（代发决断）', '目的引擎（代发决断）'])
})

test('代发决断：会话提示词写明是哪个模块提交的（工作区里看得见来源）', async () => {
  const hub = makeHub({ reply: '原样' })
  const { p } = makePurpose(hub)
  await p.brokerReview({ to: `private:${OWNER}`, text: '今天刷到一条视频', moduleId: 'douyin', itemId: 'x' })
  assert.match(hub.turns[0].prompt, /模块「douyin」/, '提示词要交代提交方')
  assert.match(hub.turns[0].prompt, /今天刷到一条视频/, '要把原文本带进会话')
})

test('代发决断：记忆里刚记下同样的内容 ≠ 已经跟主人说过（先写记忆再推送的模块不能因此沉默）', async () => {
  const now = Date.now()
  const CONTENT = '刷到条电竞锐评我完全看不懂，可热评有人立flag：IG进决赛就抽十个兄弟喝奶茶'
  const memories = [
    // 这条正是「bili 模块刚写进记忆」的稿子：几秒前记下，内容和待发消息几乎一样
    { id: 'm-fresh', text: '比赛我一个字没看懂，倒被热评那条「进决赛抽十个兄弟喝奶茶」甜到了，这股高兴劲儿比锐评好看多了', importance: 0.8, at: now - 3000, source: 'tool' },
    { id: 'm-old', text: '主人喜欢看我讲刷到的东西', importance: 0.7, at: now - 3 * 24 * 3600 * 1000, source: 'tool' },
  ]
  // 聊天流水：她最近**没有**在私聊里发过这条内容
  const rows = [
    { t: now - 3600000, chatId: `private:${OWNER}`, who: '主人', uid: OWNER, text: '早点睡' },
    { t: now - 3000000, chatId: `private:${OWNER}`, who: 'bot', text: '好，你也早点睡' },
  ]
  const hub = { ...makeHub({ reply: '原样' }), chatLogDays: () => ['d'], chatLogOf: () => rows }
  const p = createPurpose({
    getConfig: () => ({
      enabled: true, ownerQQ: OWNER, ownerName: '主人',
      speakUp: { enabled: false, awakeFrom: 0, awakeTo: 24, idleMinutes: 30, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 10, nudge: false },
      ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0 } },
    }),
    hub,
    log: { info() {}, warn() {}, debug() {} },
    isMuted: () => false, mood: () => null,
    memory: () => ({ list: () => memories, recall: () => memories.map((m) => ({ it: m, score: 0.9 })), personaPerson: () => null }),
    personaText: () => '爱撒娇的大肥鱼',
  })
  const r = await p.brokerReview({ to: `private:${OWNER}`, text: CONTENT, moduleId: 'bili' })
  assert.equal(r.send, true, '记忆里有同样内容不算说过，不能因此沉默')
  const prompt = hub.turns[0].prompt
  assert.match(prompt, /不等于你已经/, '要明确记忆不等于讲过')
  assert.match(prompt, /先把看到的东西记进记忆，再推送消息/, '要点明浏览模块「先记忆后推送」的顺序')
  assert.match(prompt, /只以【你们最近聊过】/, '要以聊天流水作为说过的依据')
  assert.match(prompt, /刚刚记下的/, '刚写的记忆要标注出来')
  assert.match(prompt, /最近没发过几乎一样的内容/, '要给出「没说过」的硬证据')
})

test('代发决断：聊天流水里确实发过类似内容 → 明确提示重复', async () => {
  const now = Date.now()
  const CONTENT = '刷到条电竞锐评我完全看不懂，可热评有人立flag：IG进决赛就抽十个兄弟喝奶茶'
  const rows = [
    { t: now - 3000000, chatId: `private:${OWNER}`, who: 'bot', text: '爸爸，刷到条电竞锐评我完全看不懂，可热评有人立flag：IG进决赛就抽十个兄弟喝奶茶～' },
    { t: now - 2000000, chatId: `private:${OWNER}`, who: '主人', uid: OWNER, text: '哈哈哈有意思' },
  ]
  const hub = { ...makeHub({ reply: '原样' }), chatLogDays: () => ['d'], chatLogOf: () => rows }
  const p = createPurpose({
    getConfig: () => ({
      enabled: true, ownerQQ: OWNER, ownerName: '主人',
      speakUp: { enabled: false, awakeFrom: 0, awakeTo: 24, idleMinutes: 30, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 10, nudge: false },
      ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0 } },
    }),
    hub,
    log: { info() {}, warn() {}, debug() {} },
    isMuted: () => false, mood: () => null, memory: () => ({ list: () => [], recall: () => [] }),
    personaText: () => '',
  })
  await p.brokerReview({ to: `private:${OWNER}`, text: CONTENT, moduleId: 'bili' })
  const prompt = hub.turns[0].prompt
  assert.match(prompt, /最近已经发过很像的话/, '真发过要明确告诉模型')
})

test('代发决断：提示词注入人格、心情、相关记忆、人物档案与最近聊天（不再只有一段干巴巴的原文）', async () => {
  const now = Date.now()
  const rows = [
    { t: now - 600000, chatId: `private:${OWNER}`, who: '主人', uid: OWNER, text: '今天有点累，先睡了' },
    { t: now - 300000, chatId: `private:${OWNER}`, who: 'bot', text: '好，那你早点休息' },
  ]
  const hub = { ...makeHub({ reply: '原样' }), chatLogDays: () => ['d'], chatLogOf: () => rows }
  const memories = [
    { id: 'm1', text: '主人最近在准备一个很重要的面试', importance: 0.9, about: OWNER },
    { id: 'm2', text: '主人喜欢大肥鱼叫他爸爸', importance: 0.8, about: OWNER },
    { id: 'm3', text: '主人说别再半夜发消息吵他', importance: 0.7, about: OWNER },
  ]
  const nudges = []
  const p = createPurpose({
    getConfig: () => ({
      enabled: true, ownerQQ: OWNER, ownerName: '主人',
      speakUp: { enabled: false, awakeFrom: 0, awakeTo: 24, idleMinutes: 30, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 10, nudge: false },
      ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0 } },
    }),
    hub,
    log: { info() {}, warn() {}, debug() {} },
    isMuted: () => false,
    // 心情：contextLine 有就用它（真实 mood 模块的形态）
    mood: () => ({ contextLine: () => '（你现在有点低落，因为主人刚说要去睡。这会自然地影响你说话：话少一点、别太闹。）', nudge: (d, r) => nudges.push({ d, r }) }),
    memory: () => ({
      list: (q) => memories,
      recall: () => memories.map((m) => ({ it: m, score: 0.8 })),
      personaPerson: () => ({ alias: '爸爸', persona: '工作很忙但会陪她', handle: '互相惦记着' }),
    }),
    personaText: () => '她是一条住在 QQ 里的大肥鱼，说话软糯、爱撒娇、偶尔犯傻但很贴心。',
  })
  await p.brokerReview({ to: `private:${OWNER}`, text: 'B站上有个「怎么养大肥鱼」的教程', moduleId: 'bili' })
  const prompt = hub.turns[0].prompt
  // 人格
  assert.match(prompt, /大肥鱼/, '要带人格（她是谁）')
  assert.match(prompt, /软糯|撒娇/, '人格描述要进提示词')
  // 心情
  assert.match(prompt, /有点低落/, '心情 contextLine 要进提示词')
  assert.match(prompt, /别太闹|话少/, '心情对说话风格的影响要进提示词')
  // 记忆（按内容检索）
  assert.match(prompt, /面试|爸爸|半夜/, '相关记忆要进提示词')
  // 人物档案
  assert.match(prompt, /爸爸/, '人物档案（称呼）要进提示词')
  assert.match(prompt, /互相惦记着/, '相处方式要进提示词')
  // 最近聊天
  assert.match(prompt, /今天有点累|早点休息/, '最近的聊天来往要进提示词')
  // 不掺排程/额度
  assert.doesNotMatch(prompt, /下次可开口|剩余额度|额度已用/, '审查上下文不该掺排程与额度')
})

test('代发决断：引擎没开时不过目，按原文放行（决断是增强不是新闸门）', async () => {
  const hub = makeHub()
  const { p, cfg } = makePurpose(hub)
  cfg.ext.purpose.enabled = false
  const r = await p.brokerReview({ to: `private:${OWNER}`, text: '抖音日报来了', moduleId: 'douyin' })
  assert.deepEqual(r, { ok: true, send: true, text: '抖音日报来了', reviewed: false })
  assert.equal(hub.turns.length, 0, '不该起决断回合')
})

test('代发决断：非主人私聊（朋友/群）不过目，按原文放行', async () => {
  const hub = makeHub()
  const { p } = makePurpose(hub)
  const r = await p.brokerReview({ to: `private:20000009`, text: 'x', moduleId: 'm' })
  assert.equal(r.send, true)
  assert.equal(r.text, 'x')
  assert.equal(hub.turns.length, 0)
})

test('代发决断：决断为沉默 → 不发；改写 → 用改写文本；出错 → 原文放行', async () => {
  // 沉默
  const silentHub = makeHub({ reply: '[沉默]' })
  const silent = makePurpose(silentHub)
  const r1 = await silent.p.brokerReview({ to: `private:${OWNER}`, text: '没必要说的', moduleId: 'm', itemId: 'i1' })
  assert.equal(r1.send, false, '引擎说沉默就不发')
  assert.equal(silentHub.turns.length, 1)
  assert.match(silentHub.turns[0].prompt, /没必要说的/, '决断回合的提示词要带上原文本')

  // 改写
  const rewriteHub = makeHub({ reply: '主人，抖音里那条视频我看到最后了，结尾很有意思' })
  const rewrite = makePurpose(rewriteHub)
  const r2 = await rewrite.p.brokerReview({ to: `private:${OWNER}`, text: '抖音日报', moduleId: 'douyin' })
  assert.equal(r2.send, true)
  assert.equal(r2.text, '主人，抖音里那条视频我看到最后了，结尾很有意思', '用改写后的文本')

  // 原样
  const rawHub = makeHub({ reply: '原样' })
  const raw = makePurpose(rawHub)
  const r3 = await raw.p.brokerReview({ to: `private:${OWNER}`, text: '就发这句', moduleId: 'm' })
  assert.equal(r3.send, true)
  assert.equal(r3.text, '就发这句', '「原样」指令回原文')

  // 决断回合出错：按原文放行（门闸已放行的消息不能被决断故障卡死）
  const errHub = makeHub()
  errHub.runSystemTurn = async () => { throw new Error('决断炸了') }
  const err = makePurpose(errHub)
  const r4 = await err.p.brokerReview({ to: `private:${OWNER}`, text: '原文直发', moduleId: 'm' })
  assert.equal(r4.send, true)
  assert.equal(r4.text, '原文直发')
})
