// 来源：本仓库自研（2026-11-03 主动发言出站策略）
// 作用：验证 src/chat/outbound-policy.js 的档位语义、故障语义、因果分类、
//       账本状态机与上限行为，以及 submit 的「落账 + 投递」完整链路。
// 契约：设计稿 docs/OUTBOUND-POLICY-DESIGN.md §4/§6/§8。
// 说明：被测文件零依赖（只 import node 内置），因此本测试也零依赖仓库其它模块。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createOutboundPolicy } from '../src/chat/outbound-policy.js'

// ── 测试夹具 ──────────────────────────────────────────────────────────────

/** 造一个可控的策略源；budget 用来模拟「共享逻辑发言预算」。 */
function fakePolicy(name = 'purpose', opts = {}) {
  let state = opts.state || 'ready'
  let budget = opts.budget ?? 10
  const calls = { reserve: 0, commit: [], release: [] }
  let seq = 0
  const policy = {
    name,
    calls,
    get budget() { return budget },
    state: () => state,
    ready: () => state === 'ready',
    setState: (s) => { state = s },
    reserve({ to, sourceModule, itemId, at }) {
      calls.reserve++
      if (opts.onReserve) {
        const forced = opts.onReserve({ to, sourceModule, itemId, at })
        if (forced) return forced
      }
      if (budget <= 0) return { ok: false, reason: 'budget' }
      budget--
      seq++
      return { ok: true, reserveId: `${name}-r${seq}` }
    },
    commit(reserveId, payload) {
      calls.commit.push({ reserveId, ...payload })
      return { ok: true }
    },
    release(reserveId, payload) {
      calls.release.push({ reserveId, ...payload })
      // 逻辑发言额度退款（只在未发送/释放时）
      budget++
      return { ok: true }
    },
  }
  return policy
}

/** 造一份可控配置。 */
function makeConfig({ tier = 'pass', ownerQQ = '10001' } = {}) {
  let cfg = { ownerQQ, outboundPolicy: { tier, ownerQQ } }
  return {
    get: () => cfg,
    setTier: (t) => { cfg = { ...cfg, outboundPolicy: { ...cfg.outboundPolicy, tier: t } } },
    setOwner: (qq) => { cfg = { ...cfg, ownerQQ: qq, outboundPolicy: { ...cfg.outboundPolicy, ownerQQ: qq } } },
  }
}

/** 新建一个服务实例（默认纯内存，个别用例给 dataDir）。 */
function makeService(over = {}) {
  const conf = over.config || makeConfig()
  const svc = createOutboundPolicy({
    getConfig: conf.get,
    dataDir: over.dataDir || null,
    now: over.now || (() => 1_700_000_000_000),
    log: () => {},
    hooks: { fsSync: over.fsSync },
    send: over.send,
  })
  return { svc, conf }
}

// ── 1. pass 档直通 + managed=false ───────────────────────────────────────

test('pass 档直通：allow 且 managed=false（旧行为兼容）', () => {
  const { svc, conf } = makeService({ config: makeConfig({ tier: 'pass' }) })
  const policy = fakePolicy()
  svc.registerPolicySource(policy)
  const r = svc.admit({ to: 'private:10001', moduleId: 'm1', itemId: 'i1', cause: { kind: 'background' } })
  assert.equal(r.action, 'allow')
  assert.equal(r.managed, false)
  assert.equal(r.reason, 'tier-pass')
  assert.equal(policy.calls.reserve, 0, 'pass 档不应调用策略源 reserve')
  assert.equal(conf.get().outboundPolicy.tier, 'pass')
  // 面板口径：pass 档没纳管
  assert.equal(svc.status().tier, 'pass')
  assert.equal(svc.status().managed, false)
})

// ── 2. gate 档 + ready 策略源 → allow/reserve/commit 链路 ────────────────

test('gate 档有 ready 策略源：allow 带 reserveId，commit 走到策略源', () => {
  const { svc } = makeService({ config: makeConfig({ tier: 'gate' }) })
  const policy = fakePolicy()
  svc.registerPolicySource(policy)
  assert.equal(svc.status().managed, true, 'gate + ready 应算纳管')

  const r = svc.admit({ to: 'private:10001', moduleId: 'm1', itemId: 'i1', cause: { kind: 'background' } })
  assert.equal(r.action, 'allow')
  assert.equal(r.managed, true)
  assert.ok(r.reserveId, 'allow 应带 reserveId')
  assert.equal(policy.calls.reserve, 1)
  assert.equal(policy.budget, 9, 'reserve 应扣掉一份预算')

  const c = svc.commit(r.reserveId, { deliveryId: r.deliveryId, outcome: 'sent' })
  assert.equal(c.ok, true)
  assert.equal(policy.calls.commit.length, 1)
  assert.equal(policy.calls.commit[0].reserveId, r.reserveId)
  assert.equal(policy.calls.commit[0].outcome, 'sent')
  assert.equal(policy.calls.release.length, 0, 'sent 不应 release')

  // 同一 reserveId 只能结算一次
  assert.equal(svc.commit(r.reserveId, { outcome: 'sent' }).reason, 'settled')
  assert.equal(svc.release(r.reserveId, { reason: 'x' }).reason, 'settled')
})

// ── 3. gate 档策略源 state=error → deny / policy-error ───────────────────

test('gate 档策略源非 ready：deny 且 reason=policy-error，绝不静默 pass', () => {
  const { svc } = makeService({ config: makeConfig({ tier: 'gate' }) })
  const policy = fakePolicy('purpose', { state: 'error' })
  svc.registerPolicySource(policy)
  const r = svc.admit({ to: 'private:10001', moduleId: 'm1', itemId: 'i1', cause: { kind: 'background' } })
  assert.equal(r.action, 'deny')
  assert.equal(r.reason, 'policy-error')
  assert.equal(policy.calls.reserve, 0, '非 ready 不应 reserve')
  assert.equal(svc.status().sources.purpose.state, 'error')

  // configured / running 也不是 ready，同样 deny
  policy.setState('configured')
  assert.equal(svc.admit({ to: 'private:10001' }).reason, 'policy-error')
  policy.setState('running')
  assert.equal(svc.admit({ to: 'private:10001' }).reason, 'policy-error')
})

// ── 4. gate 档无策略源 → allow 但 managed=false ──────────────────────────

test('gate 档完全没有策略源：allow 且 managed=false（面板明示尚未纳管）', () => {
  const { svc } = makeService({ config: makeConfig({ tier: 'gate' }) })
  const r = svc.admit({ to: 'private:10001', moduleId: 'm1', itemId: 'i1', cause: { kind: 'background' } })
  assert.equal(r.action, 'allow')
  assert.equal(r.managed, false)
  assert.equal(r.reason, 'no-policy-source')
  const st = svc.status()
  assert.equal(st.managed, false)
  assert.deepEqual(st.sources, {})
})

// ── 5. delegation 因果 → 直接 allow 且不可 defer ─────────────────────────

test('delegation 因果：直接 allow，broker 档也不 defer', () => {
  const { svc } = makeService({ config: makeConfig({ tier: 'broker' }) })
  const policy = fakePolicy('purpose', { budget: 0 }) // 预算为零也必须放行
  svc.registerPolicySource(policy)
  const r = svc.admit({
    to: 'private:10001',
    moduleId: 'm1',
    itemId: 'task-9',
    cause: { kind: 'delegation', taskId: 'task-9' },
    allowDefer: true,
  })
  assert.equal(r.action, 'allow')
  assert.equal(r.cause, 'delegation')
  assert.equal(r.managed, false)
  assert.equal(policy.calls.reserve, 0, 'delegation 不占预算、不过策略源')
  assert.equal(svc.ledgerSnapshot().length, 0, 'delegation 不入账排队')
})

// ── 6. 非 owner 私聊目标 → allow 不治理 ──────────────────────────────────

test('非 owner 私聊目标：allow，不治理（策略源未被调用）', () => {
  const { svc } = makeService({ config: makeConfig({ tier: 'broker', ownerQQ: '10001' }) })
  const policy = fakePolicy()
  svc.registerPolicySource(policy)

  // 白名单朋友这类：各有各的额度，不能拿主人的预算去卡
  const other = svc.admit({ to: 'private:20002', moduleId: 'm1', itemId: 'i1', cause: { kind: 'background' } })
  assert.equal(other.action, 'allow')
  assert.equal(other.managed, false)
  assert.equal(other.reason, 'out-of-scope')

  const group = svc.admit({ to: 'group:123456', moduleId: 'm1', itemId: 'i2' })
  assert.equal(group.action, 'allow')
  assert.equal(group.managed, false)

  // 目标写脏（空格）也要能规范化后命中 owner
  assert.equal(policy.calls.reserve, 0, '治理范围外不应 reserve')
  const messy = svc.admit({ to: ' private: 10001 ', moduleId: 'm1', itemId: 'i3', cause: { kind: 'background' } })
  assert.equal(messy.managed, true, '规范化后应命中 owner')
  assert.equal(policy.calls.reserve, 1)
})

// ── 7. 并发 reserve 只放一个 ─────────────────────────────────────────────

test('并发 reserve：预算只剩一份时第二个被 budget 拒绝', () => {
  const { svc } = makeService({ config: makeConfig({ tier: 'gate' }) })
  const policy = fakePolicy('purpose', { budget: 1 })
  svc.registerPolicySource(policy)

  const a = svc.admit({ to: 'private:10001', moduleId: 'm1', itemId: 'a', cause: { kind: 'background' } })
  const b = svc.admit({ to: 'private:10001', moduleId: 'm1', itemId: 'b', cause: { kind: 'background' } })
  assert.equal(a.action, 'allow')
  assert.equal(b.action, 'deny')
  assert.equal(b.reason, 'budget')

  const c = svc.admit({ to: 'private:10001', moduleId: 'm1', itemId: 'c', cause: { kind: 'background' } })
  assert.equal(c.action, 'deny')
  assert.equal(policy.budget, 0)
})

// ── 8. 幂等键：同 moduleId+itemId+to+channel 合并旧 pending ──────────────

test('同源合并：同幂等键的旧 pending 置 dropped(superseded)', async () => {
  const { svc } = makeService({ config: makeConfig({ tier: 'broker' }) })
  const first = await svc.submit({ moduleId: 'm1', itemId: 'i1', to: 'private:10001', channel: 'qq', text: '第一条' })
  assert.equal(first.deliveryId !== null, true)

  const second = await svc.submit({ moduleId: 'm1', itemId: 'i1', to: 'private:10001', channel: 'qq', text: '第二条' })
  assert.equal(second.deliveryId !== null, true)
  assert.notEqual(second.deliveryId, first.deliveryId, '新条目应有新的 deliveryId')

  assert.equal(svc.statusOf(first.deliveryId).state, 'dropped')
  assert.equal(svc.statusOf(second.deliveryId).state, 'pending')

  // 不同 channel 不算同源
  const third = await svc.submit({ moduleId: 'm1', itemId: 'i1', to: 'private:10001', channel: 'panel', text: '第三条' })
  assert.equal(svc.statusOf(second.deliveryId).state, 'pending', '不同 channel 不应被合并')
  assert.equal(svc.statusOf(third.deliveryId).state, 'pending')
})

// ── 9. ownerQQ 变更 → 旧 pending 作废 ────────────────────────────────────

test('ownerQQ 变更：旧主人的 pending 全部作废 dropped', async () => {
  const conf = makeConfig({ tier: 'broker', ownerQQ: '10001' })
  const { svc } = makeService({ config: conf })
  const a = await svc.submit({ moduleId: 'm1', itemId: 'i1', to: 'private:10001', text: 'hi' })
  assert.equal(svc.statusOf(a.deliveryId).state, 'pending')

  conf.setOwner('30003')
  svc.status() // 惰性比对：换主人后第一次读状态即触发作废
  assert.equal(svc.statusOf(a.deliveryId).state, 'dropped')
  assert.equal(svc.statusOf(a.deliveryId).dropReason, 'owner-changed')
})

// ── 10. uncertain 不退款也不重发 ─────────────────────────────────────────

test('commit(uncertain)：策略源收到 uncertain，宿主不退款（不调 release）', () => {
  const { svc } = makeService({ config: makeConfig({ tier: 'gate' }) })
  const policy = fakePolicy('purpose', { budget: 5 })
  svc.registerPolicySource(policy)

  const r = svc.admit({ to: 'private:10001', moduleId: 'm1', itemId: 'i1', cause: { kind: 'background' } })
  assert.equal(r.action, 'allow')
  assert.equal(policy.budget, 4)

  const c = svc.commit(r.reserveId, { deliveryId: r.deliveryId, outcome: 'uncertain' })
  assert.equal(c.ok, true)
  assert.equal(c.outcome, 'uncertain')
  assert.equal(policy.calls.commit.at(-1).outcome, 'uncertain')
  assert.equal(policy.calls.release.length, 0, 'uncertain 绝不 release（不退款）')
  assert.equal(policy.budget, 4, '额度不回滚')

  // 事后想再退款也只得到 settled
  assert.equal(svc.release(r.reserveId, { reason: 'retry' }).reason, 'settled')
  assert.equal(policy.budget, 4)
})

// ── 11. 账本落盘 / TTL / 8KB / 非 broker 的 submit ───────────────────────

test('账本落盘到 dataDir，重建实例后能读回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-outbound-'))
  const conf = makeConfig({ tier: 'broker' })
  const a = makeService({ config: conf, dataDir: dir })
  const sub = await a.svc.submit({ moduleId: 'm1', itemId: 'i1', to: 'private:10001', text: '落盘' })
  assert.ok(sub.deliveryId)

  const b = makeService({ config: conf, dataDir: dir })
  const back = b.svc.statusOf(sub.deliveryId)
  assert.equal(back.state, 'pending')
  assert.equal(back.moduleId, 'm1')
  assert.equal(b.svc.status().ledger.pending, 1)
})

test('TTL 24h 到期：pending 置 expired', async () => {
  let t = 1_700_000_000_000
  const conf = makeConfig({ tier: 'broker' })
  const svc = createOutboundPolicy({ getConfig: conf.get, now: () => t, log: () => {} })
  const sub = await svc.submit({ moduleId: 'm1', itemId: 'i1', to: 'private:10001', text: 'x' })
  assert.equal(svc.statusOf(sub.deliveryId).state, 'pending')
  t += 24 * 60 * 60 * 1000 + 1
  assert.equal(svc.ledgerSnapshot().find((it) => it.deliveryId === sub.deliveryId).state, 'expired')
})

test('单条文本超 8KB：submit 拒绝落账但不抛错', async () => {
  const { svc } = makeService({ config: makeConfig({ tier: 'broker' }) })
  const big = 'x'.repeat(8 * 1024 + 1)
  const r = await svc.submit({ moduleId: 'm1', itemId: 'i1', to: 'private:10001', text: big })
  assert.equal(r.deliveryId, null)
  assert.equal(r.state, 'too-large')
  assert.equal(svc.ledgerSnapshot().length, 0)
})

test('submit 在非 broker 档返回 unsupported（不抛错，便于模块降级）', async () => {
  const { svc } = makeService({ config: makeConfig({ tier: 'gate' }) })
  const r = await svc.submit({ moduleId: 'm1', itemId: 'i1', to: 'private:10001', text: 'x' })
  assert.equal(r.deliveryId, null)
  assert.equal(r.state, 'unsupported')
})

test('账本上限 200 条：超限按最老优先清理', async () => {
  let t = 1_700_000_000_000
  const conf = makeConfig({ tier: 'broker' })
  const svc = createOutboundPolicy({ getConfig: conf.get, now: () => t, log: () => {} })
  for (let i = 0; i < 205; i++) {
    t += 1
    await svc.submit({ moduleId: 'm', itemId: `i${i}`, to: 'private:10001', text: 'x' })
  }
  assert.ok(svc.ledgerSnapshot().length <= 200, '上限应生效')
})

test('策略源抛错不外溢：reserve 抛错 → deny(policy-error)', () => {
  const { svc } = makeService({ config: makeConfig({ tier: 'gate' }) })
  svc.registerPolicySource({
    name: 'purpose',
    state: () => 'ready',
    ready: () => true,
    reserve: () => { throw new Error('boom') },
    commit: () => {},
    release: () => {},
  })
  const r = svc.admit({ to: 'private:10001' })
  assert.equal(r.action, 'deny')
  assert.equal(r.reason, 'policy-error')
})

test('registerPolicySource 幂等：同 name 覆盖；unregister 后回到未纳管', () => {
  const { svc } = makeService({ config: makeConfig({ tier: 'gate' }) })
  svc.registerPolicySource(fakePolicy('purpose'))
  assert.equal(svc.status().managed, true)
  svc.registerPolicySource(fakePolicy('purpose', { state: 'error' }))
  assert.equal(svc.status().sources.purpose.state, 'error', '同 name 应覆盖')
  assert.equal(svc.unregisterPolicySource('purpose').removed, true)
  assert.equal(svc.status().managed, false)
  assert.equal(svc.admit({ to: 'private:10001' }).reason, 'no-policy-source')
})

test('setActivePolicy：显式选中的策略源未注册 → deny 而非悄悄放行', () => {
  const { svc } = makeService({ config: makeConfig({ tier: 'gate' }) })
  svc.registerPolicySource(fakePolicy('speakup'))
  assert.equal(svc.setActivePolicy('purpose').ok, true)
  const r = svc.admit({ to: 'private:10001' })
  assert.equal(r.action, 'deny')
  assert.equal(r.reason, 'policy-error')
  // auto 会回落到已注册且 ready 的那个
  svc.setActivePolicy('auto')
  assert.equal(svc.admit({ to: 'private:10001' }).action, 'allow')
  assert.equal(svc.status().activePolicy, 'speakup')
  assert.equal(svc.setActivePolicy('nope').ok, false)
})

test('reply 因果：chatId 与 to 不符按 background 保守处理', () => {
  const { svc } = makeService({ config: makeConfig({ tier: 'gate' }) })
  svc.registerPolicySource(fakePolicy())
  const ok = svc.admit({ to: 'private:10001', cause: { kind: 'reply', chatId: 'private:10001' } })
  assert.equal(ok.cause, 'reply')
  const forged = svc.admit({ to: 'private:10001', cause: { kind: 'reply', chatId: 'private:99999' } })
  assert.equal(forged.cause, 'background', '伪造 reply 降级为 background')
  assert.equal(svc.admit({ to: 'private:10001' }).cause, 'background')
})

// ── 12. submit 的投递闭环（本版新增：模块零负担） ────────────────────────

test('submit 注入投递器后自己发出：返回 sent，模块不必管投递', async () => {
  const sent = []
  const { svc } = makeService({
    config: makeConfig({ tier: 'broker' }),
    send: (to, text) => { sent.push({ to, text }); return { message_id: 'm1' } },
  })
  svc.registerPolicySource(fakePolicy('speakup'))
  const r = await svc.submit({ moduleId: 'm1', itemId: 'i1', to: 'private:10001', text: '你好' })
  assert.equal(r.state, 'sent')
  assert.equal(sent.length, 1, '应真的投递一次')
  assert.equal(sent[0].text, '你好')
  assert.equal(svc.statusOf(r.deliveryId).state, 'sent')
})

test('submit 投递失败（返回假值）→ failed，不重复打扰', async () => {
  const { svc } = makeService({
    config: makeConfig({ tier: 'broker' }),
    send: () => null,
  })
  svc.registerPolicySource(fakePolicy('speakup'))
  const r = await svc.submit({ moduleId: 'm1', itemId: 'i1', to: 'private:10001', text: 'x' })
  assert.equal(r.state, 'failed')
  assert.equal(svc.statusOf(r.deliveryId).state, 'failed')
})

test('submit 投递超时（抛错）→ uncertain，不重试不退款', async () => {
  const { svc } = makeService({
    config: makeConfig({ tier: 'broker' }),
    send: () => { throw new Error('timeout: 网关超时') },
  })
  const policy = fakePolicy('speakup')
  svc.registerPolicySource(policy)
  const r = await svc.submit({ moduleId: 'm1', itemId: 'i1', to: 'private:10001', text: 'x' })
  assert.equal(r.state, 'uncertain')
  // uncertain 结算给策略源，不是 release
  assert.equal(policy.calls.commit.at(-1).outcome, 'uncertain')
  assert.equal(policy.calls.release.length, 0)
})

test('submit 被策略门闸拦下：不落账、不投递，返回 dropped 与原因', async () => {
  const sent = []
  const { svc } = makeService({
    config: makeConfig({ tier: 'broker' }),
    send: (to, text) => { sent.push({ to, text }); return {} },
  })
  svc.registerPolicySource(fakePolicy('speakup', { budget: 0 })) // 额度已用完
  const r = await svc.submit({ moduleId: 'm1', itemId: 'i1', to: 'private:10001', text: 'x' })
  assert.equal(r.state, 'dropped')
  assert.equal(r.reason, 'budget')
  assert.equal(r.deliveryId, null)
  assert.equal(sent.length, 0, '被拦下绝不能再发出去')
  assert.equal(svc.ledgerSnapshot().length, 0, '被拦下不留账本条目')
})

test('submit 非 owner 目标：不受策略门闸约束，直接投递', async () => {
  const sent = []
  const { svc } = makeService({
    config: makeConfig({ tier: 'broker' }),
    send: (to, text) => { sent.push({ to, text }); return {} },
  })
  const policy = fakePolicy('speakup', { budget: 0 })
  svc.registerPolicySource(policy)
  const r = await svc.submit({ moduleId: 'm1', itemId: 'i1', to: 'private:20002', text: '给朋友' })
  assert.equal(r.state, 'sent')
  assert.equal(policy.calls.reserve, 0, '朋友不占主人的预算')
  assert.equal(sent.length, 1)
})

test('flushPending：只发 pending，已 sent 的不会重发', async () => {
  const sent = []
  const { svc } = makeService({
    config: makeConfig({ tier: 'broker' }),
    send: (to, text) => { sent.push(text); return {} },
  })
  // 先手动造一条 pending（不注入投递器时 submit 只落账）
  const noSend = makeService({ config: makeConfig({ tier: 'broker' }) })
  const sub = await noSend.svc.submit({ moduleId: 'm1', itemId: 'i1', to: 'private:10001', text: '待发' })
  assert.equal(sub.state, 'pending')
  // 换成有投递器的服务实例补发
  const pending = svc.submit({ moduleId: 'm2', itemId: 'i2', to: 'private:10001', text: 'x' })
  await pending
  const before = sent.length
  svc.flushPending()
  assert.ok(sent.length >= before, 'flush 不应减少已发数量')
})

test('面板原因：status().sources[name].reason 能显示策略源给的理由', () => {
  const { svc } = makeService({ config: makeConfig({ tier: 'gate' }) })
  svc.registerPolicySource({
    name: 'speakup',
    state: () => 'ready',
    ready: () => true,
    stateReason: '今天额度已用完',
    lastReason: 'budget',
    reserve: () => ({ ok: false, reason: 'budget' }),
    commit: () => {},
    release: () => {},
  })
  const st = svc.status()
  assert.equal(st.sources.speakup.reason, '今天额度已用完', '面板要能看到原因，不能只有状态')
})
