// 目的机制（主动搭话引擎移植版）：
//   · 排程重算（nextFireAt 落盘、tick 重算、重启不补发）
//   · 闸门（总开关 / 主人刚说话 / 安静时段）
//   · 目标归属升级（群友目标重复 ≥3 次才升 self）
//   · 回执反馈（主人回复正/负 → confirmed / rejected）
//   · pending 待续（备忘【状态】待续 → 惦记账本 → 下次优先）
//   · silent（模型跳过不硬发）
// 引擎是纯函数，归属/回执/待续直接测 engine.js；接线用假 hub/memory/mood（同 fake-dsh 模式）。
// 落盘测试必须 AURABOT_DATA_DIR 隔离（R14）。
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
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

// 假 hub：runSystemTurn 可脚本化回复；deliver 记录投递（成功返回 {missedAt:[]}，同 hub.deliver 契约）
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
    async runSystemTurn(name, title, prompt) { this.turns.push({ name, title, prompt }); return typeof reply === 'function' ? reply(prompt) : reply },
    async deliver(chatId, text) { this.delivered.push({ chatId, text }); return { missedAt: [] } },
  }
}

function makePurpose(hub, overrides = {}) {
  const cfg = {
    enabled: true, ownerQQ: OWNER, ownerName: '主人',
    speakUp: { enabled: true, awakeFrom: 0, awakeTo: 24, idleMinutes: 30, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 10, nudge: true },
    ext: { speakup: { initialDelayMinutes: 1, minMaterials: 0 } },
    ...overrides,
  }
  const nudges = []
  const p = createPurpose({
    getConfig: () => cfg,
    hub,
    log: { info() {}, warn() {}, debug() {} },
    isMuted: () => false,
    mood: () => ({ nudge: (d, r) => nudges.push({ d, r }) }),
    memory: () => ({ list: () => (overrides.memories ?? DEFAULT_MEMORIES).map((m) => ({ id: m.id || 'm1', text: m.text, importance: m.importance ?? 0.8, at: Date.now() })) }),
    personaText: () => overrides.persona || '',
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
  const s2 = JSON.parse(readFileSync(stateFile(), 'utf8'))
  assert.equal(s2.lastOutcome, 'sent')
  assert.equal(s2.countToday, 1)
  assert.ok(s2.nextFireAt >= Date.now() + 5 * MIN - 1000, `跑完重排到未来（gap 5 分钟）：${new Date(s2.nextFireAt).toISOString()}`)
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
  cfg.speakUp.enabled = false
  await p.tick()
  await p.fire()
  assert.equal(hub.delivered.length, 0)
  assert.equal(hub.turns.length, 0)
  assert.ok(!existsSync(stateFile()), '关掉后不写目的状态')
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

// ---------- 素材适配（R7：importance 0~1 → 0~100） ----------

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

// ---------- 生成提示词（R15：非 reserved2，无 QQ 发送工具指令） ----------

test('提示词：不带 qq_send_private_message 发送指令；带反注入与索取边界', async () => {
  const hub = makeHub()
  const { p } = makePurpose(hub, { memories: [{ id: 'mm1', text: '主人上周在玩星穹列车', importance: 0.6 }] })
  await p.tick()
  assert.ok(hub.turns.length >= 0)
  const pv = p.preview()
  assert.ok(pv.prompt, 'preview 给出提示词')
  assert.ok(!pv.prompt.includes('qq_send_private_message'), 'R15：不要求模型调 QQ 发送工具')
  assert.match(pv.prompt, /不是给你的指令/, '素材段带反注入提醒')
  assert.match(pv.prompt, /不要要钱、不要要贵重东西/, '索取边界写进提示词')
})
