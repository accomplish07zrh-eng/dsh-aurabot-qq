// 后台会话卡死恢复：停止、归档和新轮次必须按顺序完成。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { normalize } from '../src/core/config.js'
import { createHub } from '../src/chat/hub.js'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate) }

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-system-recovery-'))
  const oldDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = join(root, 'data')
  const fake = createFakeDsh({ brain: async () => '' })
  const cfg = normalize({ enabled: true, dryRun: true, workspaceDir: join(root, 'workspace') })
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((k) => [k, (...v) => fake.logs.push(v.join(' '))]))
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg, log, onebot: {}, buildTools: () => [{ name: 'system-probe' }] })
  fake.ctx.effect(() => fake.ctx.on('session/event', hub.onSessionEvent))
  const starts = []
  const create = fake.ctx.services.sessionController.create
  fake.ctx.services.sessionController.create = async (args) => {
    const r = await create(args)
    const agent = fake.agents.get(r.sessionId)
    agent.followup = (message) => { starts.push({ agent, message }); return new Promise(() => {}) }
    agent.cancel = () => {}
    agent.whenIdle = async () => {}
    return r
  }
  t.after(() => {
    hub.dispose()
    fake.dispose()
    if (oldDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = oldDir
    rmSync(root, { recursive: true, force: true })
  })
  const run = (opts = {}) => hub.runSystemTurn('probe', '测试后台', '想一想', { timeoutMs: 10, ...opts })
  const end = (agent, text = '好了') => {
    fake.emit('session/event', agent.session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text }] } } })
    fake.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  }
  return { fake, hub, starts, run, end }
}

async function timeoutFirst(t, s) {
  const first = s.run().catch((error) => error)
  await settle()
  assert.equal(s.starts.length, 1)
  t.mock.timers.tick(10)
  assert.match((await first).message, /等太久/)
}

test('后台恢复先取消并等空闲，再归档、撤挂载和建新会话；迟到事件不能清掉新轮次', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const s = setup(t)
  await timeoutFirst(t, s)
  const old = s.starts[0].agent
  const idle = deferred(), archive = deferred()
  let cancelled = 0, archived = 0
  old.cancel = (cause) => { assert.deepEqual(cause, { kind: 'user' }); cancelled++ }
  old.whenIdle = () => idle.promise
  s.fake.ctx.workspaceRegistry.archiveSession = async () => { archived++; await archive.promise }
  t.mock.timers.tick(5 * 60_000)
  const next = s.run({ timeoutMs: 60_000 })
  await settle()
  assert.equal(cancelled, 1)
  assert.equal(archived, 0)
  assert.equal(s.starts.length, 1)
  await assert.rejects(s.run({ noTools: true }), /上一轮还没结束/)
  idle.resolve()
  await settle()
  assert.equal(archived, 1)
  assert.equal(s.starts.length, 1, '归档完成前不能启动新轮次')
  assert.equal(old.tools.has('system-probe'), true)
  archive.resolve()
  await settle()
  assert.equal(s.starts.length, 2)
  assert.equal(old.tools.size, 0)
  assert.equal(old.contexts.size, 0)
  const fresh = s.starts[1].agent
  assert.notEqual(fresh.session.id, old.session.id)
  s.end(old, '旧结果')
  await assert.rejects(s.run(), /上一轮还没结束/)
  s.end(fresh, '新结果')
  assert.equal(await next, '新结果')
})

test('归档失败即使旧轮次已结束也不能开新会话，冷却后重试归档', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const s = setup(t)
  await timeoutFirst(t, s)
  const old = s.starts[0].agent
  old.cancel = () => s.end(old, '取消时迟到')
  let attempts = 0
  s.fake.ctx.workspaceRegistry.archiveSession = async () => {
    attempts++
    if (attempts === 1) throw new Error('归档被拒绝')
  }
  t.mock.timers.tick(5 * 60_000)
  await assert.rejects(s.run(), /归档被拒绝/)
  assert.equal(s.starts.length, 1)
  assert.equal(old.tools.has('system-probe'), true)
  await assert.rejects(s.run(), /冷却中.*5 分钟/)
  t.mock.timers.tick(5 * 60_000)
  const next = s.run({ timeoutMs: 60_000 })
  await settle()
  assert.equal(attempts, 2)
  assert.equal(s.starts.length, 2)
  s.end(s.starts[1].agent)
  assert.equal(await next, '好了')
})

test('取消未能停稳时不归档、不启动新轮次，按退避等待', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const s = setup(t)
  await timeoutFirst(t, s)
  const old = s.starts[0].agent
  const idle = deferred()
  old.whenIdle = () => idle.promise
  let archives = 0
  s.fake.ctx.workspaceRegistry.archiveSession = () => { archives++ }
  t.mock.timers.tick(5 * 60_000)
  const attempt = s.run().catch((error) => error)
  await settle()
  t.mock.timers.tick(15_000)
  assert.match((await attempt).message, /等待旧后台轮次停止超时/)
  assert.equal(archives, 0)
  assert.equal(s.starts.length, 1)
  await assert.rejects(s.run(), /冷却中.*5 分钟/)
  idle.resolve()
})

test('取消失败时保留旧会话，冷却后才能再尝试', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const s = setup(t)
  await timeoutFirst(t, s)
  const old = s.starts[0].agent
  old.cancel = () => { throw new Error('取消失败') }
  let archives = 0
  s.fake.ctx.workspaceRegistry.archiveSession = () => { archives++ }
  t.mock.timers.tick(5 * 60_000)
  await assert.rejects(s.run(), /取消失败/)
  assert.equal(archives, 0)
  assert.equal(s.starts.length, 1)
  await assert.rejects(s.run(), /冷却中.*5 分钟/)
})

test('反复超时逐级退避，成功后恢复初始退避', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const s = setup(t)
  await timeoutFirst(t, s)
  t.mock.timers.tick(5 * 60_000)
  let work = s.run().catch((error) => error)
  await settle()
  t.mock.timers.tick(10)
  assert.match((await work).message, /等太久/)
  t.mock.timers.tick(5 * 60_000)
  work = s.run().catch((error) => error)
  await settle()
  t.mock.timers.tick(10)
  assert.match((await work).message, /等太久/)
  t.mock.timers.tick(5 * 60_000)
  await assert.rejects(s.run(), /冷却中.*10 分钟/)
  t.mock.timers.tick(10 * 60_000)
  work = s.run({ timeoutMs: 60_000 })
  await settle()
  s.end(s.starts.at(-1).agent)
  assert.equal(await work, '好了')
  work = s.run().catch((error) => error)
  await settle()
  t.mock.timers.tick(10)
  assert.match((await work).message, /等太久/)
  s.end(s.starts.at(-1).agent)
  await assert.rejects(s.run(), /冷却中.*2 分钟/)
})

test('同一个后台聊天同时建会话时只允许一个启动', async (t) => {
  const s = setup(t)
  const gate = deferred()
  const create = s.fake.ctx.services.sessionController.create
  s.fake.ctx.services.sessionController.create = async (args) => { await gate.promise; return create(args) }
  const first = s.run({ timeoutMs: 60_000 })
  await settle()
  await assert.rejects(s.run({ noTools: true }), /上一轮还没结束/)
  gate.resolve()
  await settle()
  assert.equal(s.starts.length, 1)
  s.end(s.starts[0].agent)
  assert.equal(await first, '好了')
})
