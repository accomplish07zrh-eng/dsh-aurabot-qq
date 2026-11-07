import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createHub } from '../src/chat/hub.js'
import { createMemoryStore, parseFollowUpAt, compressionClusters, shouldForget } from '../src/features/memory.js'
import { createSpeakUp } from '../src/features/companion.js'
import { createPurpose } from '../src/purpose/module.js'
import { collectMaterials, minePurposeSeeds, selectPurpose, FOLLOW_UP_WEIGHT } from '../src/purpose/engine.js'
import { readMemoryState, writeMemoryState } from './helpers/memory-state.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001'
const FRIEND = '10000002'
const STRANGER = '10000003'
const DAY = 86400_000
const log = { info() {}, warn() {}, debug() {}, error() {} }
const chat = (qq) => ({ kind: 'private', chatId: `private:${qq}`, userId: qq })
const dayKey = (at) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const fact = (patch = {}) => ({ text: '主人公司正在裁员，还在等通知', about: '主人', about_qq: OWNER, speaker: OWNER, status: 'fact', tier: 3, follow_up: { question: '公司裁员的事后来怎么样了？' }, ...patch })

function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-follow-up-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: OWNER, ownerName: '主人',
    model: { provider: 'p', model: 'm' }, voice: { enabled: false }, stickers: { enabled: false },
    memory: { compress: false, gistEnabled: false, keepChatlogDays: -1, ...options.memory },
    speakUp: { allow: [FRIEND], awakeFrom: 0, awakeTo: 24, nudge: false, idleMinutes: 1, minIntervalMinutes: 1, maxIntervalMinutes: 1, maxPerDay: 2 },
    ext: { purpose: { enabled: false, minMaterials: 2 } },
  })
  const rows = options.rows || [{ chatId: `private:${OWNER}`, uid: OWNER, who: '主人', text: '公司最近在裁员，我还在等通知，有点担心', t: now - 1000 }]
  const extraction = options.extraction || { facts: [fact()] }
  const calls = [], pushed = [], generated = [], delivered = []
  const dsh = { get: () => null, llm: { async *stream({ system, messages }) {
    calls.push({ system, text: messages?.[0]?.content?.[0]?.text || '' })
    yield { type: 'text-delta', text: system.includes('整理长期记忆') ? JSON.stringify(extraction) : '{"insights":[],"style":[]}' }
    yield { type: 'finish', reason: { kind: 'completed' } }
  } } }
  const muted = new Set()
  const hub = {
    lastOwnerChatAt: 0, lastBotToOwner: { at: 0, text: '' }, lastPrivateAt: () => 0,
    chatLogDays: () => [...new Set(rows.map((r) => dayKey(r.t)))].sort(),
    chatLogOf: (day) => rows.filter((r) => dayKey(r.t) === day),
    forgetChatLog: () => 0, speakersOf: () => [], groupNames: new Map(),
    async pushToSession(target, content, sender, opts) {
      pushed.push({ target, text: content[0].text, opts })
      if (options.sent !== false) opts?.onDelivered?.()
    },
    async runSystemTurn(id, title, prompt) { generated.push(prompt); return options.reply ?? '公司那件事后来怎么样了？' },
    async deliver(target, text) { delivered.push({ target, text }); return { sent: options.sent === false ? '' : text } },
  }
  const mem = createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
  const speak = createSpeakUp({ getConfig: () => cfg, hub, log, memory: () => mem, isMuted: (id) => muted.has(id) })
  const purpose = createPurpose({ getConfig: () => cfg, hub, log, memory: () => mem, isMuted: (id) => muted.has(id), personaText: () => '' })
  const pending = (patch = {}) => {
    const qq = patch.about || OWNER
    return mem.add({ text: '主人公司正在裁员，还在等通知', about: qq, aboutName: qq, speaker: qq, status: 'fact', tier: 3,
      source: 'auto', chatId: `private:${qq}`, saidAt: now - 5 * DAY,
      followUp: { at: now - 1000, question: '裁员的事后来怎么样了？' }, ...patch }).id
  }
  const state = () => readMemoryState(dir)
  const get = (id) => state().items.find((m) => m.id === id)
  const dueTick = (patch = {}) => writeFileSync(join(dir, 'speakup.json'), JSON.stringify({ day: new Date().toDateString(), count: 0, nextAt: Date.now() - 1, ...patch }))
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, cfg, rows, extraction, calls, mem, speak, purpose, hub, muted, pushed, generated, delivered, pending, state, get, dueTick,
    advance: (days) => { now += days * DAY } }
}

test('提炼 follow_up 写进原事实，默认按原话后 3 天；明确日期保留到晚上', async (t) => {
  const s = setup(t)
  assert.equal((await s.mem.consolidate({ includeToday: true })).ok, true)
  const m = s.state().items.find((m) => m.text.includes('裁员'))
  assert.deepEqual(m.followUp, { at: s.rows[0].t + 3 * DAY, tries: 0, question: '公司裁员的事后来怎么样了？' })
  const call = s.calls.find((c) => c.system.includes('整理长期记忆'))
  assert.match(call.system, /本人亲口说的.*尚无结果.*重要/)
  assert.match(call.system, /周三面试就周三晚上/)
  assert.match(call.system, /follow_up:null/)
  const at = new Date(2030, 4, 15, 20).getTime()
  assert.equal(parseFollowUpAt('2030-05-15 20:00'), at)
  assert.equal(parseFollowUpAt('2030-05-15'), at)
  assert.equal(parseFollowUpAt('2030-02-30 25:90', s.rows[0].t), s.rows[0].t + 3 * DAY)
})

for (const [label, patch] of [
  ['琐碎', { tier: 1 }], ['没有档位', { tier: undefined }], ['转述', { status: 'hearsay' }], ['猜测', { status: 'guess' }],
  ['主人说别人的事', { about: '朋友', about_qq: FRIEND }],
]) {
  test(`提炼不跟进${label}`, async (t) => {
    const s = setup(t, { extraction: { facts: [fact(patch)] } })
    await s.mem.consolidate({ includeToday: true })
    assert.ok(s.state().items.length)
    assert.ok(s.state().items.every((m) => !m.followUp))
  })
}

for (const [label, qq, id, allowed] of [
  ['白名单私聊', FRIEND, `private:${FRIEND}`, true],
  ['非白名单私聊', STRANGER, `private:${STRANGER}`, false],
  ['白名单在群里说', FRIEND, 'group:20000001', false],
]) {
  test(`提炼范围：${label}`, async (t) => {
    const s = setup(t, { rows: [{ chatId: id, uid: qq, who: '朋友', text: '我下周要面试，还没结果，很在意', t: Date.now() - 1000 }],
      extraction: { facts: [fact({ about: '朋友', about_qq: qq, speaker: qq, text: '朋友下周要面试，还没结果' })] } })
    await s.mem.consolidate({ includeToday: true })
    assert.equal(s.state().items.some((m) => Boolean(m.followUp)), allowed)
  })
}

test('到期后只在原排程开口时带一件；问后推迟 3 天、7 天，第三次放下', async (t) => {
  const s = setup(t)
  const id = s.pending()
  const second = s.pending({ text: '主人还在等医院复查的结果', followUp: { at: Date.now(), question: '复查的结果出来了吗？' } })
  await s.speak.tick()
  assert.equal(s.pushed.length, 0, '到期事项不绕过正常间隔')
  s.dueTick()
  await s.speak.tick()
  assert.match(s.pushed[0].text, /裁员的事后来怎么样了/)
  assert.doesNotMatch(s.pushed[0].text, /复查的结果出来了吗/)
  assert.deepEqual(s.get(id).followUp, { at: Date.now() + 3 * DAY, tries: 1, question: '裁员的事后来怎么样了？' })
  assert.equal(s.get(second).followUp.tries, 0)
  s.mem.update(second, { followUp: null })
  s.advance(3)
  await s.speak.fire()
  assert.equal(s.get(id).followUp.tries, 2)
  assert.equal(s.get(id).followUp.at, Date.now() + 7 * DAY)
  s.advance(7)
  await s.speak.fire()
  assert.equal(s.get(id).followUp, undefined)
  assert.equal(s.mem.dueFollowUp(OWNER), null)
})

test('不到期不带；已标过时、尚未成立、老数据都不能成为跟进', async (t) => {
  const s = setup(t)
  const id = s.pending({ followUp: { at: Date.now() + DAY, question: '尚未到期的问题' } })
  await s.speak.fire()
  assert.doesNotMatch(s.pushed[0].text, /尚未到期的问题|你还惦记着/)
  assert.equal(s.get(id).followUp.tries, 0)
  s.mem.update(id, { validUntil: Date.now() - 1 })
  assert.equal(s.get(id).followUp, undefined)
  const legacy = { id: 'legacy', text: '旧版喜欢摄影', about: OWNER, at: Date.now() }
  writeMemoryState(s.dir, { items: [legacy, { ...legacy, id: 'future', validFrom: Date.now() + DAY, followUp: { at: Date.now() - 1, tries: 0, question: '未来的事实' } }] })
  assert.equal(s.mem.list('').length, 2)
  assert.equal(s.mem.dueFollowUp(OWNER), null)
  assert.equal(Object.hasOwn(s.get('legacy'), 'followUp'), false)
})

test('未实际发送不增加次数，多段发送回执只算一次', async (t) => {
  const s = setup(t, { sent: false })
  const id = s.pending()
  await s.speak.fire()
  assert.equal(s.get(id).followUp.tries, 0)
  s.pushed[0].opts.onDelivered()
  s.pushed[0].opts.onDelivered()
  assert.equal(s.get(id).followUp.tries, 1)
})

for (const op of ['update', 'outdated']) {
  test(`${op} 有结果后清掉；outdated 的历史条目也不保留跟进`, async (t) => {
    const s = setup(t)
    const id = s.pending()
    s.extraction.facts = [fact({ op, id, text: '主人收到通知，这轮裁员没有被裁，已经安心了', follow_up: null })]
    await s.mem.consolidate({ includeToday: true })
    assert.ok(s.state().items.some((m) => m.text.includes('已经安心了')))
    assert.ok(s.state().items.every((m) => !m.followUp))
    if (op === 'outdated') assert.ok(s.get(id).invalidAt)
  })

  test(`${op} 还没结果维持原跟进次数和时间`, async (t) => {
    const s = setup(t)
    const id = s.pending()
    s.mem.markFollowUpAsked(id)
    const old = s.get(id).followUp
    s.extraction.facts = [fact({ op, id, text: '主人公司还没有发裁员通知，仍在等消息', follow_up: undefined })]
    await s.mem.consolidate({ includeToday: true })
    const current = s.state().items.find((m) => !m.invalidAt && m.text.includes('仍在等消息'))
    assert.deepEqual(current.followUp, old)
    if (op === 'outdated') assert.equal(s.get(id).followUp, undefined)
  })
}

test('复用去重，重复提炼不新建跟进也不重置问过次数', async (t) => {
  const s = setup(t)
  const id = s.pending()
  s.mem.markFollowUpAsked(id)
  const old = s.get(id).followUp
  await s.mem.consolidate({ includeToday: true })
  assert.equal(s.state().items.length, 1)
  assert.deepEqual(s.get(id).followUp, { ...old, question: '公司裁员的事后来怎么样了？' })
})

test('取消、忘掉都清理原字段，迟到的发送回执不能复活跟进', async (t) => {
  const s = setup(t, { sent: false })
  const id = s.pending()
  await s.speak.fire()
  assert.equal(s.mem.update(id, { followUp: null }).ok, true)
  s.pushed[0].opts.onDelivered()
  assert.equal(s.get(id).followUp, undefined)
  const other = s.pending({ text: '主人下周要参加重要面试' })
  const r = s.mem.handleCommand(chat(OWNER), '忘掉主人下周要参加重要面试')
  assert.equal(r.ok, true)
  assert.equal(s.get(other).followUp, undefined)
  assert.ok(s.get(other).invalidAt)
  assert.equal(s.mem.markFollowUpAsked(other), false)
})

test('禁言、讨厌的人跳过，白名单私聊仍能关心本人', async (t) => {
  const s = setup(t)
  const ownerId = s.pending()
  const friendId = s.pending({ about: FRIEND, text: '朋友在等面试结果', followUp: { at: Date.now() - 1, question: '面试结果出来了吗？' } })
  s.muted.add(`private:${OWNER}`)
  s.mem.savePersonaPerson(FRIEND, { tags: ['讨厌'] })
  s.dueTick({ friends: { [FRIEND]: { day: new Date().toDateString(), count: 0, nextAt: Date.now() - 1 } } })
  await s.speak.tick()
  assert.equal(s.pushed.length, 0)
  assert.equal(s.get(ownerId).followUp.tries, 0)
  assert.equal(s.get(friendId).followUp.tries, 0)
  s.mem.savePersonaPerson(FRIEND, { tags: [] })
  await s.speak.tick()
  assert.equal(s.pushed[0].target.chatId, `private:${FRIEND}`)
  assert.match(s.pushed[0].text, /面试结果出来了吗/)
  assert.doesNotMatch(s.pushed[0].text, /裁员/)
  assert.equal(s.get(friendId).followUp.tries, 1)
})

for (const gate of ['awake', 'daily', 'gap', 'active']) {
  test(`到期跟进仍遵守 ${gate} 闸门`, async (t) => {
    const s = setup(t)
    const id = s.pending()
    s.cfg.speakUp.allow = []
    s.dueTick(gate === 'daily' ? { count: 2 } : gate === 'gap' ? { nextAt: Date.now() + DAY } : {})
    if (gate === 'awake') s.cfg.speakUp.awakeTo = 0
    if (gate === 'active') s.hub.lastOwnerChatAt = Date.now()
    await s.speak.tick()
    assert.equal(s.pushed.length, 0)
    assert.equal(s.get(id).followUp.tries, 0)
  })
}

test('默认打开，关闭后不提炼、不注入、不计数；总记忆关闭同样不生效', async (t) => {
  const s = setup(t)
  assert.equal(normalize({}).memory.followUp, true)
  assert.equal(normalize({ memory: { followUp: 'false' } }).memory.followUp, true)
  const id = s.pending()
  s.cfg.memory.followUp = false
  await s.mem.consolidate({ includeToday: true })
  await s.speak.fire()
  assert.equal(s.mem.dueFollowUp(OWNER), null)
  assert.doesNotMatch(s.pushed[0].text, /你还惦记着/)
  assert.equal(s.mem.markFollowUpAsked(id), false)
  assert.equal(s.get(id).followUp.tries, 0)
  const extra = s.pending({ text: '主人等待医院检查结果' })
  assert.equal(s.get(extra).followUp, undefined)
  s.cfg.memory.followUp = true
  s.cfg.memory.enabled = false
  assert.equal(s.mem.dueFollowUp(OWNER), null)
})

test('待跟进事实不被长期印象压缩吞掉；普通旧细节仍可压缩', (t) => {
  const s = setup(t)
  const id = s.pending()
  const base = s.get(id)
  const items = Array.from({ length: 4 }, (_, i) => ({ ...base, id: `old${i}`, saidAt: Date.now() - 50 * DAY, followUp: undefined }))
  assert.equal(compressionClusters(items).length, 1)
  assert.equal(compressionClusters(items.map((m) => ({ ...m, followUp: base.followUp }))).length, 0)
  assert.equal(shouldForget({ ...base, at: Date.now() - 180 * DAY, importance: 0.3 }), false)
})

test('目的引擎到期素材使用常量权重、优先选中，一轮只带一件', (t) => {
  const s = setup(t)
  const id = s.pending()
  const items = [s.get(id), { ...s.get(id), id: 'later', followUp: { at: Date.now() + DAY, tries: 0, question: '以后才问' } }]
  const { items: materials, stats } = collectMaterials({ followUpRecords: items })
  assert.equal(stats.followUp, 1)
  const seeds = minePurposeSeeds({ materials })
  assert.equal(seeds[0].weight, FOLLOW_UP_WEIGHT)
  const picked = selectPurpose({ seeds, random: () => 0.99, history: [{ sourceId: seeds[0].sourceId, text: seeds[0].text }] })
  assert.equal(picked.purpose.kind, 'memory-follow-up', '合法的下一次跟进不被旧历史永久去重')
  assert.match(picked.purpose.text, /裁员的事后来怎么样了/)
})

test('目的引擎只在开启时使用同一事实；发出才延期，不复制到 pending/goals', async (t) => {
  const s = setup(t, { rows: [], reply: '裁员的事后来怎么样了？\n【目的】关心裁员\n【状态】待续\n【待续】再问裁员结果' })
  const id = s.pending()
  assert.equal((await s.purpose.fire()).outcome, 'disabled')
  s.cfg.ext.purpose.enabled = true
  assert.equal((await s.purpose.fire()).outcome, 'sent')
  assert.match(s.generated[0], /裁员的事后来怎么样了/)
  assert.equal(s.get(id).followUp.tries, 1)
  const purposeState = JSON.parse(readFileSync(join(s.dir, 'purpose', 'purpose-state.json'), 'utf8'))
  assert.deepEqual(purposeState.pending, [])
  assert.deepEqual(purposeState.goals, [])
  s.cfg.memory.followUp = false
  assert.equal((await s.purpose.preview()).stats.followUp, 0)
  s.muted.add(`private:${OWNER}`)
  assert.equal((await s.purpose.fire()).outcome, 'muted')
})

for (const [label, opts] of [['沉默', { reply: '[沉默]' }], ['投递失败', { sent: false }]]) {
  test(`目的引擎${label}不消耗跟进次数`, async (t) => {
    const s = setup(t, opts)
    const id = s.pending()
    s.cfg.ext.purpose.enabled = true
    await s.purpose.fire()
    assert.equal(s.get(id).followUp.tries, 0)
  })
}

for (const pauseAdmission of [false, true]) test(pauseAdmission
  ? '主动回合准入期间普通聊天结束，只有自己的成功回复才记跟进次数'
  : '主动回合排在普通聊天后面时，只有自己的成功回复才记跟进次数', { timeout: 5000 }, async (t) => {
  const s = setup(t)
  const id = s.pending()
  s.cfg.workspaceDir = join(s.dir, 'workspace')
  s.cfg.model.provider = 'fake'; s.cfg.model.model = 'fake-1'
  const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
  const firstEntered = deferred(), firstReply = deferred(), nextEntered = deferred(), nextReply = deferred()
  const admissionEntered = deferred(), admissionReady = deferred()
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate) }
  const fake = createFakeDsh({ brain: async ({ text }) => {
    // 当前时间随每轮输入注入；按原始聊天正文区分两轮。
    const body = text.split('\n').filter((line) => !line.startsWith('【当前本机时间】')).join('\n')
    if (body === '普通聊天') { firstEntered.resolve(); await firstReply.promise; return '上一轮聊完啦' }
    nextEntered.resolve(); await nextReply.promise; return '裁员的事后来怎么样了？'
  } })
  const admit = fake.ctx.attachments.admitPromptContent
  fake.ctx.attachments.admitPromptContent = async (content) => {
    if (content.some((c) => c.type === 'text' && c.text.includes('你还惦记着'))) {
      admissionEntered.resolve()
      if (pauseAdmission) await admissionReady.promise
    }
    return admit(content)
  }
  const hub = createHub({ dsh: fake.ctx, getConfig: () => s.cfg, log,
    onebot: { async call() { return { message_id: 42 } } },
  })
  fake.ctx.effect(() => fake.ctx.on('session/event', hub.onSessionEvent))
  t.after(() => { firstReply.resolve(); nextReply.resolve(); admissionReady.resolve(); hub.dispose(); fake.dispose() })
  const speak = createSpeakUp({ getConfig: () => s.cfg, hub, log, memory: () => s.mem })
  const previousTurn = hub.pushToSession(chat(OWNER), [{ type: 'text', text: '普通聊天' }], OWNER)
  await firstEntered.promise
  const followTurn = speak.fire()
  await admissionEntered.promise
  await settle()
  firstReply.resolve()
  await previousTurn
  await settle()
  assert.match(fake.turns[0].userText, /【当前本机时间】/)
  assert.equal(s.get(id).followUp.tries, 0, '上一轮结束或发送时不能消费主动回合的跟进')
  admissionReady.resolve()
  await nextEntered.promise
  await settle()
  assert.equal(s.get(id).followUp.tries, 0, '上一轮普通回复不能消费排队中的跟进')
  nextReply.resolve()
  await Promise.all([previousTurn, followTurn])
  await settle()
  assert.equal(s.get(id).followUp.tries, 1)
})

test('真实发送回执：沉默、试运行、被拦截和网关失败均不把问题算成问过', async (t) => {
  const s = setup(t, { sent: false })
  const id = s.pending()
  let blocked = false, fail = false
  const hub = createHub({ dsh: {}, getConfig: () => s.cfg, log,
    onebot: { async call() { if (fail) throw new Error('网关失败'); return { message_id: 42 } } },
    hooks: { reply: async (text) => blocked ? null : text },
  })
  t.after(() => hub.dispose())
  await s.speak.fire()
  const receipt = s.pushed[0].opts
  await hub.deliver(`private:${OWNER}`, '[沉默]', receipt)
  s.cfg.dryRun = true
  await hub.deliver(`private:${OWNER}`, '裁员的事后来怎么样了？', receipt)
  s.cfg.dryRun = false
  blocked = true
  await hub.deliver(`private:${OWNER}`, '裁员的事后来怎么样了？', receipt)
  blocked = false; fail = true
  await hub.deliver(`private:${OWNER}`, '裁员的事后来怎么样了？', receipt)
  assert.equal(s.get(id).followUp.tries, 0)
  fail = false
  await hub.deliver(`private:${OWNER}`, '裁员的事后来怎么样了？', receipt)
  assert.equal(s.get(id).followUp.tries, 1)
})
