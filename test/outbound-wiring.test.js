// 来源：本仓库自研（2026-11-03 主动发言出站策略接线回归）
// 许可：随插件本体（MIT 口径见 THIRD-PARTY-NOTICES.md）
// 作用：验证 docs/OUTBOUND-POLICY-DESIGN.md 的接线层——
//   hub 门闸注入/撤销、模块来源标记生效、被拦返回 null（旧调用口真值语义不变）、
//   未注入门闸时完全惰性、门闸自身出错按放行（治理故障不得阻断正常回复）、
//   模块包装层（api 快捷发送 / scopedHub）的治理、api.proactive 降级、面板读写路由。
// 契约：见 docs/OUTBOUND-POLICY-DESIGN.md §4~§8。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHub } from '../src/chat/hub.js'
import { createOutboundPolicy } from '../src/chat/outbound-policy.js'
import { scopeCoreForModule } from '../src/core/modules.js'

/**
 * 造一个最小可用的 hub：onebot 的 call 记录被真正发出去的消息，
 * 其余依赖给能满足 createHub 的最小桩。
 */
function makeHub(t, overrides = {}) {
  const sent = []
  const cfg = {
    enabled: true,
    dryRun: false,
    ownerQQ: '10001',
    stickers: { faces: false, enabled: false },
    voice: { enabled: false, emojiSeparate: true, autoMaxChars: 0, autoChance: 0 },
    files: {},
    cleaning: {},
    ...(overrides.config || {}),
  }
  const hub = createHub({
    dsh: {},
    getConfig: () => cfg,
    log: { info() {}, debug() {}, warn() {}, error() {}, child() { return this } },
    onebot: {
      call: async (action, params) => {
        sent.push({ action, params })
        return { message_id: 'm' + sent.length }
      },
      state: 'connected',
    },
    stickers: { library: () => ({ items: [] }), idOf: () => null, random: () => null, sendable: () => null },
    tts: { speak: async () => ({ engine: 'x', file: '' }) },
    buildTools: () => [],
    contextProviders: [],
    onActivity: () => {},
    memoryScore: () => 0,
    isMuted: () => false,
    dislikes: { list: () => [] },
    localApi: {},
    hooks: {},
    availableModels: [],
    capabilitiesOf: () => ({}),
    ...overrides.hub,
  })
  return { hub, sent, cfg }
}

test('没有注入门闸时：模块来源标记也不影响发送（完全惰性）', async (t) => {
  const { hub, sent } = makeHub(t)
  const r = await hub.sendText('private:10001', '你好', undefined, undefined, undefined, { sourceModule: 'tophub' })
  assert.equal(r.message_id, 'm1')
  assert.equal(sent.length, 1)
})

test('注入门闸后：deny 时 sendText 返回 null（旧调用口语义不变）', async (t) => {
  const { hub, sent } = makeHub(t)
  let asked = null
  hub.setOutboundGuard((ask) => { asked = ask; return null })
  const r = await hub.sendText('private:10001', '主动闲聊', undefined, undefined, undefined, { sourceModule: 'tophub' })
  assert.equal(r, null)
  assert.equal(sent.length, 0, '被拦的消息不能真的发出去')
  assert.equal(asked.sourceModule, 'tophub')
  assert.equal(asked.chatId, 'private:10001')
})

test('不带 sourceModule 的内部发送不受门闸影响', async (t) => {
  const { hub, sent } = makeHub(t)
  hub.setOutboundGuard(() => null) // 一律拒绝
  const r = await hub.sendText('private:10001', '命令回执')
  assert.equal(r.message_id, 'm1', '内部发送不该被主动发言策略拦')
  assert.equal(sent.length, 1)
})

test('门闸放行时正常发送，且同一条消息只判一次（不重复扣额度）', async (t) => {
  const { hub, sent } = makeHub(t)
  let calls = 0
  hub.setOutboundGuard(() => { calls++; return { action: 'allow' } })
  const r = await hub.sendText('private:10001', '放行吧', undefined, undefined, undefined, { sourceModule: 'tophub' })
  assert.equal(r.message_id, 'm1')
  assert.equal(sent.length, 1)
  assert.equal(calls, 1, 'sendText 判过之后不能再让 sendSegments 出口层重复判一次')
})

test('门闸自己抛错时按放行处理（治理故障不得阻断正常回复）', async (t) => {
  const { hub, sent } = makeHub(t)
  hub.setOutboundGuard(() => { throw new Error('策略源炸了') })
  const r = await hub.sendText('private:10001', '照发', undefined, undefined, undefined, { sourceModule: 'tophub' })
  assert.equal(r.message_id, 'm1')
  assert.equal(sent.length, 1)
})

test('sendSegments 出口层：模块直接调也过门闸', async (t) => {
  const { hub, sent } = makeHub(t)
  hub.setOutboundGuard(() => null)
  const r = await hub.sendSegments('private:10001', [{ type: 'text', data: { text: '图' } }], '[图片]', { sourceModule: 'phone' })
  assert.equal(r, null)
  assert.equal(sent.length, 0)
})

test('setOutboundGuard(null) 可撤销门闸', async (t) => {
  const { hub, sent } = makeHub(t)
  hub.setOutboundGuard(() => null)
  assert.equal(await hub.sendText('private:10001', 'a', undefined, undefined, undefined, { sourceModule: 'x' }), null)
  hub.setOutboundGuard(null)
  const r = await hub.sendText('private:10001', 'b', undefined, undefined, undefined, { sourceModule: 'x' })
  assert.equal(r.message_id, 'm1')
})

test('端到端：gate 档 + 策略源拒绝预算 → 模块发不出去', async (t) => {
  const { hub } = makeHub(t)
  const svc = createOutboundPolicy({
    getConfig: () => ({ ownerQQ: '10001', outboundPolicy: { tier: 'gate' } }),
    dataDir: null, // 纯内存
    hooks: { fsSync: false },
  })
  svc.registerPolicySource({
    name: 'speakup',
    state: () => 'ready',
    ready: () => true,
    reserve: () => ({ ok: false, reason: 'budget' }),
    commit: () => ({ ok: true }),
    release: () => ({ ok: true }),
  })
  hub.setOutboundGuard((ask) => svc.admit({
    to: ask.chatId, moduleId: ask.sourceModule, origin: 'module', at: Date.now(),
  }))
  const r = await hub.sendText('private:10001', '主动私聊', undefined, undefined, undefined, { sourceModule: 'tophub' })
  assert.equal(r, null)
})

test('端到端：gate 档 + 策略源放行 → 正常发出', async (t) => {
  const { hub, sent } = makeHub(t)
  const svc = createOutboundPolicy({
    getConfig: () => ({ ownerQQ: '10001', outboundPolicy: { tier: 'gate' } }),
    dataDir: null,
    hooks: { fsSync: false },
  })
  svc.registerPolicySource({
    name: 'speakup',
    state: () => 'ready',
    ready: () => true,
    reserve: () => ({ ok: true, reserveId: 'r1' }),
    commit: () => ({ ok: true }),
    release: () => ({ ok: true }),
  })
  hub.setOutboundGuard((ask) => svc.admit({
    to: ask.chatId, moduleId: ask.sourceModule, origin: 'module', at: Date.now(),
  }))
  const r = await hub.sendText('private:10001', '主动私聊', undefined, undefined, undefined, { sourceModule: 'tophub' })
  assert.equal(r.message_id, 'm1')
  assert.equal(sent.length, 1)
})

test('端到端：pass 档（默认）时模块发送照旧、不被治理', async (t) => {
  const { hub, sent } = makeHub(t)
  const svc = createOutboundPolicy({ getConfig: () => ({ ownerQQ: '10001' }), dataDir: null, hooks: { fsSync: false } })
  hub.setOutboundGuard((ask) => svc.admit({ to: ask.chatId, moduleId: ask.sourceModule, origin: 'module' }))
  const r = await hub.sendText('private:10001', '主动私聊', undefined, undefined, undefined, { sourceModule: 'tophub' })
  assert.equal(r.message_id, 'm1')
  assert.equal(sent.length, 1)
  assert.equal(svc.status().managed, false, '默认档必须显示尚未纳管')
})

// ---------- 档位兜底：非法 / 缺失 tier 一律按 pass（安全兜底） ----------

test('tier 非法或缺失值：一律按 pass 处理（安全兜底，不拦任何消息）', async (t) => {
  // 注：'GATE' 之类的大小写变体按实现（readTier 会 toLowerCase）算合法档位，不在这里测；
  // 这里只测真正认不出来的值（拼错、类型不对、空串）。
  for (const tier of [undefined, null, '', 'braker', 'off', 'gate ', 0, {}, []]) {
    if (tier === 'gate ') continue // 带空格的会被 trim 成合法档位，单独在下面断言
    const { hub, sent } = makeHub(t)
    const svc = createOutboundPolicy({
      getConfig: () => ({ ownerQQ: '10001', ext: { outboundPolicy: { tier } } }),
      dataDir: null,
      hooks: { fsSync: false },
    })
    // 故意注册一个 ready 策略源：若档位被误判成 gate/broker，它就会 reserve 并可能拦下
    let reserved = 0
    svc.registerPolicySource({
      name: 'purpose',
      state: () => 'ready',
      ready: () => true,
      reserve: () => { reserved++; return { ok: true, reserveId: 'r1' } },
      commit: () => ({ ok: true }),
      release: () => ({ ok: true }),
    })
    hub.setOutboundGuard((ask) => svc.admit({ to: ask.chatId, moduleId: ask.sourceModule, origin: 'module' }))
    const r = await hub.sendText('private:10001', 'x', undefined, undefined, undefined, { sourceModule: 'm' })
    assert.equal(r?.message_id, 'm1', `tier=${JSON.stringify(tier)} 应放行`)
    assert.equal(sent.length, 1)
    assert.equal(svc.status().tier, 'pass', `tier=${JSON.stringify(tier)} 应回落 pass`)
    assert.equal(reserved, 0, 'pass 档不该碰策略源')
  }
})

// ---------- scopedHub：模块身份绑定 + 门闸放行/拦下 ----------

/** 造一个最小 core（scopeCoreForModule 要求 hub.subagentFor 存在才算合格宿主）。 */
function makeScopedCore(hub, outbound) {
  const core = { hub: { ...hub, subagentFor: () => () => 'ok' } }
  if (outbound !== undefined) core.outbound = outbound
  return core
}

test('scopedHub：模块经 sendText 发送时身份是宿主绑定的 moduleId', async (t) => {
  const { hub, sent } = makeHub(t)
  const seen = []
  hub.setOutboundGuard((ask) => { seen.push(ask); return { action: 'allow' } })
  const core = makeScopedCore(hub)
  const scoped = scopeCoreForModule(core, 'phone')
  const r = await scoped.hub.sendText('private:10001', '手机逛逛')
  assert.equal(r.message_id, 'm1')
  assert.equal(sent.length, 1)
  assert.equal(seen.length, 1, '只有 hub 门闸判了一次（包装层未注入服务时不额外判）')
  assert.equal(seen[0].sourceModule, 'phone', 'moduleId 由宿主包装层绑定')
})

test('scopedHub：注入服务后 gate 档被策略拒绝 → 返回 null 且不发', async (t) => {
  const { hub, sent } = makeHub(t)
  const svc = createOutboundPolicy({
    getConfig: () => ({ ownerQQ: '10001', ext: { outboundPolicy: { tier: 'gate' } } }),
    dataDir: null,
    hooks: { fsSync: false },
  })
  const reserveCalls = []
  svc.registerPolicySource({
    name: 'purpose',
    state: () => 'ready',
    ready: () => true,
    reserve: ({ sourceModule }) => {
      reserveCalls.push(sourceModule)
      return { ok: false, reason: 'budget' }
    },
    commit: () => ({ ok: true }),
    release: () => ({ ok: true }),
  })
  // hub 第二道保险也接上（与宿主装配一致）
  hub.setOutboundGuard((ask) => {
    const v = svc.admit({ to: ask.chatId, moduleId: ask.sourceModule, origin: 'module' })
    return v.action === 'deny' ? v : { ...v, settle: (o) => v.reserveId && svc.commit(v.reserveId, { outcome: o }) }
  })
  const core = makeScopedCore(hub, svc)
  const scoped = scopeCoreForModule(core, 'douyin')
  const r = await scoped.hub.sendText('private:10001', '抖音日报')
  assert.equal(r, null, '被拦必须返回 null（旧真值语义）')
  assert.equal(sent.length, 0, '被拦的消息不能发出去')
  assert.deepEqual(reserveCalls, ['douyin'], '策略源看到的是宿主绑定的 moduleId')
})

test('scopedHub：模块在参数里伪造 moduleId/sourceModule 无效（身份不可伪造）', async (t) => {
  const { hub } = makeHub(t)
  const svc = createOutboundPolicy({
    getConfig: () => ({ ownerQQ: '10001', ext: { outboundPolicy: { tier: 'gate' } } }),
    dataDir: null,
    hooks: { fsSync: false },
  })
  const reserveCalls = []
  svc.registerPolicySource({
    name: 'purpose',
    state: () => 'ready',
    ready: () => true,
    reserve: ({ sourceModule }) => { reserveCalls.push(sourceModule); return { ok: true, reserveId: 'r' } },
    commit: () => ({ ok: true }),
    release: () => ({ ok: true }),
  })
  const core = makeScopedCore(hub, svc)
  const scoped = scopeCoreForModule(core, 'real-module')
  await scoped.hub.sendText('private:10001', 'hi', undefined, undefined, undefined, { sourceModule: 'fake', moduleId: 'fake' })
  assert.deepEqual(reserveCalls, ['real-module'], '参里的 sourceModule 覆盖不了宿主绑定的身份')
})

test('scopedHub：pass 档（默认未配置）时模块发送照旧', async (t) => {
  const { hub, sent } = makeHub(t)
  const svc = createOutboundPolicy({ getConfig: () => ({ ownerQQ: '10001' }), dataDir: null, hooks: { fsSync: false } })
  hub.setOutboundGuard((ask) => {
    const v = svc.admit({ to: ask.chatId, moduleId: ask.sourceModule, origin: 'module' })
    return v.action === 'deny' ? v : { ...v, settle: () => {} }
  })
  const scoped = scopeCoreForModule(makeScopedCore(hub, svc), 'm')
  const r = await scoped.hub.sendText('private:10001', '旧行为')
  assert.equal(r.message_id, 'm1')
  assert.equal(sent.length, 1)
})

test('scopedHub：未注入 core.outbound 时完全不额外判定（惰性）', async (t) => {
  const { hub, sent } = makeHub(t)
  let guardCalls = 0
  hub.setOutboundGuard(() => { guardCalls++; return { action: 'allow' } })
  const scoped = scopeCoreForModule(makeScopedCore(hub), 'm')
  const r = await scoped.hub.sendText('private:10001', 'x')
  assert.equal(r.message_id, 'm1')
  assert.equal(sent.length, 1)
  assert.equal(guardCalls, 1, '只有 hub 的第二道保险判一次，包装层不加判定')
})

// ---------- deliver 的 enginePolicy ----------

test('deliver 默认（不传 enginePolicy）：行为与改造前一致', async (t) => {
  const { hub, sent } = makeHub(t)
  const r = await hub.deliver('private:10001', '普通回复')
  assert.equal(sent.length, 1)
  assert.equal(r?.failed ?? 0, 0)
})

test('deliver 传 enginePolicy：策略源拒绝时不发；放行时发出并 commit(sent)', async (t) => {
  const { hub, sent } = makeHub(t)
  const commits = []
  const deny = { reserve: () => ({ ok: false, reason: 'budget' }), commit: () => ({ ok: true }), release: () => ({ ok: true }) }
  const allow = { reserve: () => ({ ok: true, reserveId: 'r1' }), commit: (id, p) => { commits.push({ id, ...p }); return { ok: true } } }

  const denied = await hub.deliver('private:10001', '被拒的引擎消息', { enginePolicy: deny })
  assert.equal(denied, undefined, '被拒时与 silent 同口径（undefined）')
  assert.equal(sent.length, 0)

  const ok = await hub.deliver('private:10001', '放行的引擎消息', { enginePolicy: allow })
  assert.equal(sent.length, 1, '放行后真的发出去')
  assert.ok(ok, 'deliver 返回值保持原样')
  assert.deepEqual(commits, [{ id: 'r1', outcome: 'sent' }])
})

test('deliver 的 enginePolicy 走『不指定』以外的分支时仍受总开关约束', async (t) => {
  const { hub, sent } = makeHub(t, { config: { enabled: false } })
  let committed = null
  const policy = {
    reserve: () => ({ ok: true, reserveId: 'r1' }),
    commit: (id, p) => { committed = p.outcome; return { ok: true } },
  }
  await hub.deliver('private:10001', '总开关关着', { enginePolicy: policy })
  assert.equal(sent.length, 0, '总开关关着不能发')
  assert.equal(committed, 'failed', '没发出去要按 failed 结算（策略源据此退款）')
})

// ---------- api.proactive（经 makeApi 的身份绑定面） ----------

test('api.proactive：宿主未注入服务时 available=false，submit 返回 unsupported 且不抛', async (t) => {
  // makeApi 在 createModules 内部；这里用最小 fixture 起一个真模块读它的 api 面
  const { api } = await startProbeModule(t, {})
  assert.equal(api.proactive.available, false)
  let out
  assert.doesNotThrow(() => { out = api.proactive.submit({ itemId: 'i1', to: 'private:10001', text: 'x' }) })
  assert.deepEqual(out, { deliveryId: null, state: 'unsupported' })
  assert.equal(api.proactive.statusOf('dlv_x'), null)
})

test('api.proactive：注入服务后 submit 带上宿主绑定的 moduleId，非 broker 档即 unsupported', async (t) => {
  const svc = createOutboundPolicy({
    getConfig: () => ({ ownerQQ: '10001', ext: { outboundPolicy: { tier: 'gate' } } }),
    dataDir: null,
    hooks: { fsSync: false },
  })
  const submitted = []
  const spy = {
    submit: (input) => { submitted.push(input); return svc.submit(input) },
    statusOf: (id) => svc.statusOf(id),
  }
  const { api } = await startProbeModule(t, { outbound: spy })
  assert.equal(api.proactive.available, true)
  const r = await api.proactive.submit({ itemId: 'i1', to: 'private:10001', text: 'x', moduleId: 'fake' })
  assert.deepEqual(r, { deliveryId: null, state: 'unsupported' }, 'gate 档不开放 api.proactive')
  assert.equal(submitted[0].moduleId, 'probe-mod', 'moduleId 由宿主绑定，模块伪造无效')

  // broker 档才真的落账
  const broker = createOutboundPolicy({
    getConfig: () => ({ ownerQQ: '10001', ext: { outboundPolicy: { tier: 'broker' } } }),
    dataDir: null,
    hooks: { fsSync: false },
  })
  const brokerSpy = { submit: (i) => broker.submit(i), statusOf: (i) => broker.statusOf(i) }
  const second = await startProbeModule(t, { outbound: brokerSpy }, 'probe2')
  const sub = await second.api.proactive.submit({ itemId: 'i1', to: 'private:10001', text: 'active' })
  assert.equal(sub.state, 'pending')
  assert.ok(sub.deliveryId)
  assert.equal(second.api.proactive.statusOf(sub.deliveryId).state, 'pending')
})

// ---------- api 快捷发送（makeApi）：模块最常用的那条路 ----------

test('api.sendText：gate 档策略拒绝时返回 null，放行时发出并按结果结算', async (t) => {
  // 拒绝
  const denied = createOutboundPolicy({
    getConfig: () => ({ ownerQQ: '10001', ext: { outboundPolicy: { tier: 'gate' } } }),
    dataDir: null,
    hooks: { fsSync: false },
  })
  const denials = []
  denied.registerPolicySource({
    name: 'purpose',
    state: () => 'ready',
    ready: () => true,
    reserve: ({ sourceModule }) => { denials.push(sourceModule); return { ok: false, reason: 'budget' } },
    commit: () => ({ ok: true }),
    release: () => ({ ok: true }),
  })
  const first = await startProbeModule(t, { outbound: denied }, 'probe-deny')
  assert.equal(first.api.sendText('private:10001', '被拦的私聊'), null)
  assert.deepEqual(denials, ['probe-deny'], '身份由宿主绑定')

  // 放行：发出 + commit(sent)
  const allowed = createOutboundPolicy({
    getConfig: () => ({ ownerQQ: '10001', ext: { outboundPolicy: { tier: 'gate' } } }),
    dataDir: null,
    hooks: { fsSync: false },
  })
  const outcomes = []
  allowed.registerPolicySource({
    name: 'purpose',
    state: () => 'ready',
    ready: () => true,
    reserve: () => ({ ok: true, reserveId: 'r1' }),
    commit: (id, p) => { outcomes.push(p.outcome); return { ok: true } },
    release: () => ({ ok: true }),
  })
  const second = await startProbeModule(t, { outbound: allowed }, 'probe-ok')
  assert.deepEqual(second.api.sendText('private:10001', '放行的私聊'), { message_id: 1 })
  assert.equal(second.sends.length, 1, '真的调到 hub')
  assert.deepEqual(outcomes, ['sent'], '发出去要按 sent 结算（不退额度）')
})

test('api.sendText：默认未配置（pass 档）时行为完全不变', async (t) => {
  const svc = createOutboundPolicy({ getConfig: () => ({ ownerQQ: '10001' }), dataDir: null, hooks: { fsSync: false } })
  const { api, sends } = await startProbeModule(t, { outbound: svc }, 'probe-pass')
  assert.deepEqual(api.sendText('private:10001', '旧行为'), { message_id: 1 })
  assert.equal(sends.length, 1)
})

// ---------- broker 档：模块快捷发送改走宿主代发（进「目的引擎（代发决断）」会话） ----------

test('broker 档：模块发主人纯文本改走宿主代发（scopedHub 路径，引擎决断入口）', async (t) => {
  const svc = createOutboundPolicy({
    getConfig: () => ({ ownerQQ: '10001', ext: { outboundPolicy: { tier: 'broker' } } }),
    dataDir: null,
    hooks: { fsSync: false },
  })
  let seq = 0
  svc.registerPolicySource({
    name: 'purpose', state: () => 'ready', ready: () => true,
    reserve: () => ({ ok: true, reserveId: 'r' + (++seq) }), commit: () => ({ ok: true }), release: () => ({ ok: true }),
  })
  const submitted = []
  svc.setDeliverer(async (to, text) => { submitted.push({ to, text }); return true })
  const { hub, sent } = makeHub(t)
  const scoped = scopeCoreForModule({ hub: { ...hub, subagentFor: () => () => 'ok' }, outbound: svc }, 'probe-broker')
  // broker 代发是异步的（引擎决断要走一轮模型）：await 后拿到 { message_id }；决断不发/失败为 null
  const r = await scoped.hub.sendText('private:10001', '抖音日报来了')
  assert.ok(r, '代发成功要返回真值，旧调用方语义不变')
  assert.deepEqual(submitted, [{ to: 'private:10001', text: '抖音日报来了' }], '内容交给宿主代发器（引擎决断入口）')
  assert.equal(sent.length, 0, 'broker 代发路径不应再直接调 hub')
})

test('broker 档：决断不发 + 日志口各种坏形态都不炸链路（2026-11-06 生产 TypeError 回归）', async (t) => {
  const svc = createOutboundPolicy({
    getConfig: () => ({ ownerQQ: '10001', ext: { outboundPolicy: { tier: 'broker' } } }),
    dataDir: null, hooks: { fsSync: false },
  })
  svc.registerPolicySource({
    name: 'purpose', state: () => 'ready', ready: () => true,
    reserve: () => ({ ok: true, reserveId: 'r1' }), commit: () => ({ ok: true }), release: () => ({ ok: true }),
  })
  svc.setDeliverer(async () => false, '决断不发：deliverer 返回 false')
  const { hub } = makeHub(t)
  // log 的各种坏形态：对象缺 warn / warn 不是函数 / 抛错 / 干脆没有——出站日志是锦上添花，
  // 哪种都不能把发送链路炸成 TypeError（2026-11-06 生产：代发决断「不发」被记成代发出错）
  const badLogs = [undefined, {}, { warn: 42 }, { warn: () => { throw new Error('日志器炸了') } }]
  for (const log of badLogs) {
    const core = { hub, outbound: svc, logger: log }
    const scoped = scopeCoreForModule(core, 'probe-badlog')
    const r = await scoped.hub.sendText('private:10001', '决断不发的一条')
    assert.equal(r, null, `决断不发返回 null（log 形态：${log === undefined ? 'undefined' : JSON.stringify(Object.keys(log))}）`)
  }
})

test('broker 档：群聊 / 朋友私聊不走代发（保持原路径）', async (t) => {  const svc = createOutboundPolicy({
    getConfig: () => ({ ownerQQ: '10001', ext: { outboundPolicy: { tier: 'broker' } } }),
    dataDir: null, hooks: { fsSync: false },
  })
  svc.registerPolicySource({
    name: 'purpose', state: () => 'ready', ready: () => true,
    reserve: () => ({ ok: true, reserveId: 'r1' }), commit: () => ({ ok: true }), release: () => ({ ok: true }),
  })
  const submitted = []
  svc.setDeliverer(async (to, text) => { submitted.push({ to, text }); return true })
  const { api } = await startProbeModule(t, { outbound: svc }, 'probe-scope')
  await api.sendText('group:555', '群里说话')
  assert.equal(submitted.length, 0, '群消息不代发')
  await api.sendText('private:20000', '给朋友')
  assert.equal(submitted.length, 0, '朋友私聊不代发')
})

test('gate 档：模块快捷发送保持原样（只判定放行，不改走代发）', async (t) => {
  const svc = createOutboundPolicy({
    getConfig: () => ({ ownerQQ: '10001', ext: { outboundPolicy: { tier: 'gate' } } }),
    dataDir: null, hooks: { fsSync: false },
  })
  svc.registerPolicySource({
    name: 'purpose', state: () => 'ready', ready: () => true,
    reserve: () => ({ ok: true, reserveId: 'r1' }), commit: () => ({ ok: true }), release: () => ({ ok: true }),
  })
  const submitted = []
  svc.setDeliverer(async (to, text) => { submitted.push({ to, text }); return true })
  const { api, sends } = await startProbeModule(t, { outbound: svc }, 'probe-gate')
  const r = await api.sendText('private:10001', 'gate 档直发')
  assert.deepEqual(r, { message_id: 1 }, 'gate 档照旧直接调 hub')
  assert.equal(sends.length, 1, 'gate 档不代发')
  assert.equal(submitted.length, 0)
})

// ---------- broker 档：无可审文本（图片/文件等）「识别不了就直发」（2026-11-05 少爷定） ----------
// 背景：代发的纯文本不占额度、不看安静时段；图片/文件却还在走普通门闸的
// quiet/budget/busy 判定，出现「文字发得出、图片老被拦」。无可审文本的发送与代发同口径。

test('broker 档：图片（无可审文本）被策略源拒绝也照发（识别不了就直发）', async (t) => {
  const svc = createOutboundPolicy({
    getConfig: () => ({ ownerQQ: '10001', ext: { outboundPolicy: { tier: 'broker' } } }),
    dataDir: null, hooks: { fsSync: false },
  })
  let reserves = 0
  svc.registerPolicySource({
    name: 'purpose', state: () => 'ready', ready: () => true,
    reserve: () => { reserves++; return { ok: false, reason: 'quiet' } },
    commit: () => ({ ok: true }), release: () => ({ ok: true }),
  })
  const { api } = await startProbeModule(t, { outbound: svc }, 'probe-img-quiet')
  const r = await api.sendImage('private:10001', 'base64://abc')
  assert.deepEqual(r, { message_id: 3 }, '策略源说不发，图片也直发出去（识别不了就直发）')
  assert.equal(reserves, 0, '直发口径不进门闸、不碰策略源')
})

test('broker 档：放行的图片发送不占策略源额度（与代发同口径，不 reserve 不结算）', async (t) => {
  const svc = createOutboundPolicy({
    getConfig: () => ({ ownerQQ: '10001', ext: { outboundPolicy: { tier: 'broker' } } }),
    dataDir: null, hooks: { fsSync: false },
  })
  const reserves = []
  const commits = []
  const releases = []
  svc.registerPolicySource({
    name: 'purpose', state: () => 'ready', ready: () => true,
    reserve: () => { reserves.push(1); return { ok: true, reserveId: 'r1' } },
    commit: (id, p) => { commits.push([id, p]); return { ok: true } },
    release: (id, p) => { releases.push([id, p]); return { ok: true } },
  })
  const { api } = await startProbeModule(t, { outbound: svc }, 'probe-img-release')
  const r = await api.sendFile('private:10001', 'C:/a.zip')
  assert.deepEqual(r, { message_id: 4 }, '图片照常发出')
  assert.equal(reserves.length, 0, '直发口径不 reserve（不占额度）')
  assert.equal(commits.length, 0)
  assert.equal(releases.length, 0)
})

test('broker 档：纯文本被策略源拒绝仍拦下（文本走门闸 + 代发决断，口径不变）', async (t) => {
  const svc = createOutboundPolicy({
    getConfig: () => ({ ownerQQ: '10001', ext: { outboundPolicy: { tier: 'broker' } } }),
    dataDir: null, hooks: { fsSync: false },
  })
  svc.registerPolicySource({
    name: 'purpose', state: () => 'ready', ready: () => true,
    reserve: () => ({ ok: false, reason: 'budget' }), commit: () => ({ ok: true }), release: () => ({ ok: true }),
  })
  const { api, sends } = await startProbeModule(t, { outbound: svc }, 'probe-text-deny')
  const r = await api.sendText('private:10001', '主动私聊主人')
  assert.equal(r, null, '纯文本被拒仍返回 null（旧真值语义）')
  assert.equal(sends.length, 0, '纯文本不能绕过门闸直发')
})

test('gate 档：图片被策略源拒绝仍拦下（直发口径只对 broker 生效）', async (t) => {
  const svc = createOutboundPolicy({
    getConfig: () => ({ ownerQQ: '10001', ext: { outboundPolicy: { tier: 'gate' } } }),
    dataDir: null, hooks: { fsSync: false },
  })
  svc.registerPolicySource({
    name: 'purpose', state: () => 'ready', ready: () => true,
    reserve: () => ({ ok: false, reason: 'quiet' }), commit: () => ({ ok: true }), release: () => ({ ok: true }),
  })
  const { api } = await startProbeModule(t, { outbound: svc }, 'probe-img-gate')
  const r = await api.sendImage('private:10001', 'base64://abc')
  assert.equal(r, null, 'gate 档的判定语义不变：拒绝就是不发')
})

test('broker 档：图片发朋友（治理范围外）不触直发口径，照旧过门闸放行', async (t) => {
  const svc = createOutboundPolicy({
    getConfig: () => ({ ownerQQ: '10001', ext: { outboundPolicy: { tier: 'broker' } } }),
    dataDir: null, hooks: { fsSync: false },
  })
  let reserves = 0
  svc.registerPolicySource({
    name: 'purpose', state: () => 'ready', ready: () => true,
    reserve: () => { reserves++; return { ok: false, reason: 'quiet' } }, commit: () => ({ ok: true }), release: () => ({ ok: true }),
  })
  const { api } = await startProbeModule(t, { outbound: svc }, 'probe-img-friend')
  const r = await api.sendImage('private:20000', 'base64://abc')
  assert.deepEqual(r, { message_id: 3 }, '治理范围外（非主人私聊）admit 本就放行，照旧直发')
  assert.equal(reserves, 0, '范围外不 reserve（admit 的 out-of-scope 短路，行为不变）')
})


/**
 * 起一个真模块，把 setup 收到的 api 暴露出来（验证 api.proactive 的实际形状）。
 * core 里给了 hub 的发送函数桩，避免模块误用时报错。
 */
async function startProbeModule(t, coreExtra = {}, id = 'probe-mod') {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-probe-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const { createModules } = await import('../src/core/modules.js')
  let captured = null
  const sends = []
  const hubStub = {
    sendText: (...a) => { sends.push(['sendText', ...a]); return { message_id: 1 } },
    sendSegments: () => ({ message_id: 2 }),
    sendImage: () => ({ message_id: 3 }),
    sendFile: () => ({ message_id: 4 }),
    sendVoiceFile: () => ({ message_id: 5 }),
    deliver: () => ({ missedAt: [] }),
    runSystemTurn: async () => '',
  }
  const core = { hub: { ...hubStub, subagentFor: () => () => 'ok' }, onebot: { call: () => null }, ask: async () => '', ...coreExtra }
  const modules = createModules({
    ctx: {},
    core,
    getConfig: () => ({ modules: {}, ext: {}, safeMode: false }),
    setConfig: () => {},
    logger: { child: () => ({ info() {}, warn() {}, debug() {}, error() {} }) },
    version: 'test',
    builtins: [{ id, name: id, setup(api) { captured = api; return {} } }],
  })
  t.after(() => {
    modules.dispose()
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
  })
  await modules.boot()
  assert.ok(captured, '模块必须真的启动过')
  return { api: captured, modules, sends, dir }
}
// ---------- 面板路由：GET /panel/outbound-policy 与 POST 同路径（精确匹配） ----------
test('面板路由：/panel/outbound-policy 能读能写，且只认合法档位', async (t) => {
  // 用 fake DSH 起真宿主，验证 route 真的注册成精确路径且读写都能用
  const { createFakeDsh } = await import('./helpers/fake-dsh.js')
  const { mkdtempSync: mkdtemp, writeFileSync: writeF } = await import('node:fs')
  const { join: pjoin } = await import('node:path')
  const dir = mkdtemp(join(tmpdir(), 'aurabot-panel-outbound-'))
  const oldDir = process.env.AURABOT_DATA_DIR
  const oldWs = process.env.AURABOT_WORKSPACE
  process.env.AURABOT_DATA_DIR = dir
  process.env.AURABOT_WORKSPACE = pjoin(dir, 'ws')
  writeF(pjoin(dir, 'config.json'), JSON.stringify({
    enabled: true, dryRun: true, setupDone: true, ownerQQ: '10001',
    allow: { private: ['10001'], groups: [] },
    snowluma: { autoStart: false, autoAttach: false, dir: pjoin(dir, 'no-snowluma') },
    voice: { enabled: false }, stickers: { enabled: false, autoChance: 0 },
  }))
  const fake = createFakeDsh({ brain: async () => '嗯' })
  t.after(() => {
    fake.dispose()
    if (oldDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = oldDir
    if (oldWs === undefined) delete process.env.AURABOT_WORKSPACE
    else process.env.AURABOT_WORKSPACE = oldWs
  })
  const host = await import('../src/host.js')
  const api = host.apply(fake.ctx)
  await api.ready.catch(() => {})

  const call = async (path, body) => (await fake.call(path, body)).json()

  // 读：精确路径存在，返回 status 形状
  const st = await call('/panel/outbound-policy')
  assert.equal(st.ok, true)
  assert.ok(st.outbound, 'GET 应返回 status()')
  assert.equal(st.outbound.tier, 'pass', '默认档位是 pass')
  assert.equal(st.outbound.managed, false, '默认未纳管')
  assert.ok(st.outbound.ledger && typeof st.outbound.ledger.pending === 'number')
  assert.ok(st.outbound.sources && typeof st.outbound.sources === 'object')

  // 写：改档位，回读生效
  const gate = await call('/panel/outbound-policy', { tier: 'gate' })
  assert.equal(gate.ok, true)
  assert.equal(gate.outbound.tier, 'gate')
  assert.equal((await call('/panel/outbound-policy')).outbound.tier, 'gate', '写入要真的落到配置里')

  // 写：非法档位被拒，档位保持原样
  const bad = await call('/panel/outbound-policy', { tier: 'wechat' })
  assert.equal(bad.ok, false)
  assert.equal((await call('/panel/outbound-policy')).outbound.tier, 'gate', '非法值不能改配置')

  // 写：切回 pass，别污染别的用例
  const back = await call('/panel/outbound-policy', { tier: 'pass' })
  assert.equal(back.ok, true)
  assert.equal(back.outbound.tier, 'pass')
})
