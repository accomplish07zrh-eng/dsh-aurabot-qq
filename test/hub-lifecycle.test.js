// 插件卸载后会话仍可保留；再次加载时必须绑定新中枢，不能继续调用旧工具。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { normalize } from '../src/core/config.js'
import { OneBotError } from '../src/onebot/client.js'

const root = mkdtempSync(join(tmpdir(), 'aurabot-lifecycle-'))
process.env.AURABOT_WORKSPACE = join(root, 'workspace')
const { createHub } = await import('../src/chat/hub.js')
const { apply } = await import('../src/host.js')
const OWNER = '10000001'
const OTHER = '10000002'
const BOT = '20000002'
const CHAT = `private:${OWNER}`
const ownerChat = { kind: 'private', chatId: CHAT, userId: OWNER, groupId: '', nickname: '主人' }
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate) }
const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
const withDeadline = async (promise) => {
  let timer
  const timeout = Symbol('timeout')
  try {
    const result = await Promise.race([promise, new Promise((r) => { timer = setTimeout(() => r(timeout), 300) })])
    assert.notEqual(result, timeout, '卸载应立即结束等待，不必等待模型或超时')
    return result
  } finally { clearTimeout(timer) }
}
const png = (salt) => {
  const b = Buffer.alloc(96)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  b.writeUInt32BE(200, 16)
  b.writeUInt32BE(200, 20)
  b[40] = salt
  return b
}
const image = (salt) => ({ type: 'image', data: { sub_type: 1, file: `base64://${png(salt).toString('base64')}` } })
const event = (text = '你好', extra = []) => ({
  post_type: 'message', message_type: 'private', sub_type: 'friend',
  self_id: Number(BOT), user_id: Number(OWNER), message_id: 1,
  sender: { user_id: Number(OWNER), nickname: '主人' },
  message: [{ type: 'text', data: { text } }, ...extra],
})

for (const stop of ['dispose', 'turn/end']) test(`慢工具在 ${stop} 后不再发送迟到进度提示`, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const work = deferred()
  t.after(() => work.resolve({ ok: true }))
  let started = false
  const sent = []
  const s = setup(t, {
    brain: async ({ callTool }) => { await callTool('slow-probe', {}); return '' },
    hooks: { send: async (segments, info) => { sent.push(info.note); return segments } },
    buildTools: () => [{ name: 'slow-probe', slow: '进度探针', execute: async () => { started = true; return work.promise } }],
  })
  await s.hub.onMessage(event())
  await settle()
  assert.equal(started, true)
  if (stop === 'dispose') s.hub.dispose()
  else {
    const agent = [...s.fake.agents.values()][0]
    s.hub.onSessionEvent(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  }
  t.mock.timers.tick(2000)
  await settle()
  assert.equal(sent.some((x) => x.includes('进度探针')), false)
})

test('慢工具提示等待发送挂钩时轮次结束，不再投递到 QQ', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const work = deferred(), sending = deferred()
  t.after(() => { work.resolve({ ok: true }); sending.resolve() })
  let entered = false
  const s = setup(t, {
    cfg: config({ dryRun: false }),
    brain: async ({ callTool }) => { await callTool('slow-probe', {}); return '' },
    hooks: { send: async (segments, info) => {
      if (info.note.includes('进度探针')) { entered = true; await sending.promise }
      return segments
    } },
    buildTools: () => [{ name: 'slow-probe', slow: '进度探针', execute: () => work.promise }],
  })
  await s.hub.onMessage(event())
  await settle()
  t.mock.timers.tick(1501)
  await settle()
  assert.equal(entered, true)
  const agent = [...s.fake.agents.values()][0]
  s.hub.onSessionEvent(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  sending.resolve()
  await settle()
  assert.equal(s.calls.some((x) => x.action === 'send_private_msg'), false)
})

function config(patch = {}) {
  return normalize({ enabled: true, dryRun: true, setupDone: true, ownerQQ: OWNER, botQQ: BOT,
    allow: { private: [OTHER], groups: [] }, voice: { enabled: false }, merge: { enabled: false },
    stickers: { collect: true, caption: false, autoChance: 0 },
    snowluma: { autoStart: false, autoAttach: false, dir: join(root, 'no-snowluma') }, ...patch })
}

function setup(t, { cfg = config(), brain = async () => '', hooks, buildTools, onebot, onCommand, onActivity } = {}) {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(root, 'data-'))
  const fake = createFakeDsh({ brain })
  const calls = []
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg,
    log: Object.fromEntries(['info', 'warn', 'error', 'debug'].map((k) => [k, (...v) => fake.logs.push(v.join(' '))])),
    onebot: onebot || { connected: true, async call(action, params) { calls.push({ action, params }); return { message_id: calls.length } } },
    hooks, buildTools, onCommand, onActivity })
  fake.ctx.effect(() => fake.ctx.on('session/event', hub.onSessionEvent))
  t.after(() => { try { hub.dispose?.() } finally { fake.dispose() } })
  return { hub, fake, calls }
}

test('同一会话连续重载两轮：旧工具、上下文、限制全部清理，重新挂新工具', { timeout: 5000 }, async (t) => {
  const data = mkdtempSync(join(root, 'host-'))
  process.env.AURABOT_DATA_DIR = data
  writeFileSync(join(data, 'config.json'), JSON.stringify(config({ bridge: { dshTools: true } })))
  const fake = createFakeDsh({ brain: async ({ callTool }) => {
    await callTool('qq_set_nickname', { name: '大肥鱼' })
    return ''
  } })
  t.after(() => fake.dispose())
  let originalAgent
  let previousTool
  for (let round = 0; round < 3; round++) {
    const api = apply(fake.ctx)
    await api.ready
    await api.hub.pushToSession(ownerChat, [{ type: 'text', text: '修改资料' }], OWNER)
    const agent = fake.agents.get(api.hub.sessions()[CHAT].sessionId)
    if (round === 0) {
      originalAgent = agent
      agent.ctx.tools.register({ name: 'external-tool' })
      agent.ctx.systemPrompt.context({ name: 'external-context', text: () => '' })
      agent.ctx.tools.restrict({ deny: ['external-restriction'] })
    }
    assert.equal(agent, originalAgent, '重载应复用原来的 agent')
    assert.ok(agent.contexts.has('aurabot-context'))
    assert.ok(agent.denied.has('aurabot_qq_send'), '联动全局工具应在 QQ 会话中被屏蔽')
    assert.notEqual(agent.tools.get('qq_set_nickname'), previousTool, '每次加载应绑定新工具')
    previousTool = agent.tools.get('qq_set_nickname')
    for (const call of fake.turns.at(-1).toolCalls) assert.equal(call.result.ok, true, `${call.name}: ${call.result.message || ''}`)
    fake.dispose()
    assert.deepEqual([...agent.tools.keys()], ['external-tool'], '卸载后仅保留外部工具')
    assert.deepEqual([...agent.contexts.keys()], ['external-context'])
    assert.deepEqual([...agent.denied], ['external-restriction'])
    assert.equal(fake.ctx.globalTools.size, 0, '插件的全局联动工具也应撤销')
    assert.doesNotThrow(() => api.hub.dispose(), '重复卸载应安全')
  }
  assert.equal(fake.logs.filter((line) => /already registered|dup aurabot_/.test(line)).length, 0)
})
test('会话恢复等待中卸载，恢复结果不能重新挂载工具或启动轮次', { timeout: 5000 }, async (t) => {
  const { hub, fake } = setup(t, { buildTools: () => [{ name: 'test-tool' }] })
  await hub.pushToSession(ownerChat, [{ type: 'text', text: '先建会话' }], OWNER)
  const agent = [...fake.agents.values()][0]
  const entered = deferred()
  const gate = deferred()
  t.after(() => gate.resolve())
  fake.ctx.agents.get = () => null
  fake.ctx.services.sessionController.resolveAgent = async () => { entered.resolve(); await gate.promise; return { agent } }
  const work = hub.pushToSession(ownerChat, [{ type: 'text', text: '等待恢复' }], OWNER).catch((error) => error)
  await entered.promise
  hub.dispose()
  gate.resolve()
  assert.equal((await work).code, 'AURABOT_DISPOSED')
  assert.equal(agent.tools.size, 0)
  assert.equal(agent.contexts.size, 0)
  assert.equal(fake.turns.length, 1)
})

test('旧实例建会话或改名期间卸载，不能覆盖新实例的会话映射', { timeout: 5000 }, async (t) => {
  for (const phase of ['create', 'rename']) await t.test(phase, async (t) => {
    const { hub: oldHub, fake } = setup(t)
    const controller = fake.ctx.services.sessionController
    const original = controller[phase]
    const entered = deferred(), gate = deferred()
    t.after(() => gate.resolve())
    let first = true
    controller[phase] = async (...args) => {
      const result = await original(...args)
      if (first) { first = false; entered.resolve(); await gate.promise }
      return result
    }
    const oldWork = oldHub.pushToSession(ownerChat, [{ type: 'text', text: '旧会话' }], OWNER).catch((error) => error)
    await entered.promise
    oldHub.dispose()
    const newHub = createHub({ dsh: fake.ctx, getConfig: () => config(), log: { info() {}, warn() {}, debug() {}, error() {} },
      onebot: { async call() { return {} } } })
    t.after(() => newHub.dispose())
    await newHub.pushToSession(ownerChat, [{ type: 'text', text: '新会话' }], OWNER)
    const file = join(process.env.AURABOT_DATA_DIR, 'sessions.json')
    const before = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(before.chats[CHAT]?.sessionId)
    gate.resolve()
    assert.equal((await oldWork).code, 'AURABOT_DISPOSED')
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), before)
    assert.equal(fake.turns.length, 1)
    assert.match(fake.turns[0].userText, /新会话/)
  })
})

test('后台轮次取得 agent 后卸载，不登记超时或启动 followup', { timeout: 5000 }, async (t) => {
  const timers = t.mock.method(globalThis, 'setTimeout')
  let hub
  const s = setup(t, { buildTools: () => { queueMicrotask(() => hub.dispose()); return [] } })
  hub = s.hub
  const result = await hub.runSystemTurn('between', '后台', '不应执行', { timeoutMs: 123456 }).catch((error) => error)
  assert.equal(result.code, 'AURABOT_DISPOSED')
  await settle()
  assert.equal(timers.mock.calls.some((call) => call.arguments[1] === 123456), false)
  assert.equal(s.fake.turns.length, 0)
})

test('图片准入等待中卸载，随后完成的准入不能提交旧消息', { timeout: 5000 }, async (t) => {
  const { hub, fake } = setup(t)
  const entered = deferred()
  const gate = deferred()
  t.after(() => gate.resolve())
  fake.ctx.attachments.admitPromptContent = async (content) => { entered.resolve(); await gate.promise; return content }
  const work = hub.pushToSession(ownerChat, [{ type: 'text', text: '图片' }, { type: 'image', data: png(1) }], OWNER).catch((error) => error)
  await entered.promise
  hub.dispose()
  gate.resolve()
  assert.equal((await work).code, 'AURABOT_DISPOSED')
  assert.equal(fake.turns.length, 0)
})

test('消息合并等待中卸载，计时结束和新消息均不能再启动旧轮次', { timeout: 5000 }, async (t) => {
  const { hub, fake } = setup(t, { cfg: config({ merge: { enabled: true, waitSec: 0.05, maxSec: 0.05 } }) })
  await hub.onMessage(event('先攒着'))
  hub.dispose()
  await new Promise((r) => setTimeout(r, 90))
  await hub.onMessage(event('卸载后才到达'))
  await settle()
  assert.equal(fake.agents.size, 0)
  assert.equal(fake.turns.length, 0)
})

test('卸载后消息不再调用命令、记录流水或登记合并计时器', async (t) => {
  const timers = t.mock.method(globalThis, 'setTimeout')
  let commands = 0, activity = 0
  const s = setup(t, { cfg: config({ merge: { enabled: true, waitSec: 5, maxSec: 5 } }),
    onCommand: async () => { commands++; return '已执行' }, onActivity: () => { activity++ } })
  s.hub.dispose()
  await s.hub.onMessage(event('/test'))
  await s.hub.onMessage(event('卸载后才到达'))
  assert.equal(commands, 0)
  assert.equal(activity, 0)
  assert.equal(s.hub.stats().received, 0)
  assert.deepEqual(s.hub.chatLogDays(), [])
  assert.equal(timers.mock.calls.length, 0)
})

test('消息挂钩等待中卸载，挂钩结束后不记录或安排轮次', async (t) => {
  const entered = deferred(), gate = deferred()
  t.after(() => gate.resolve())
  let activity = 0
  const s = setup(t, { hooks: { message: async () => { entered.resolve(); await gate.promise; return false } },
    onActivity: () => { activity++ } })
  const work = s.hub.onMessage(event())
  await entered.promise
  s.hub.dispose()
  gate.resolve()
  await work
  assert.equal(activity, 0)
  assert.deepEqual(s.hub.chatLogDays(), [])
  assert.equal(s.fake.turns.length, 0)
})

test('卸载后不发文件，在途请求失败后也不进行 base64 回退', async (t) => {
  const entered = deferred(), gate = deferred()
  t.after(() => gate.resolve())
  const calls = []
  const file = join(root, 'lifecycle-file.txt')
  writeFileSync(file, '测试')
  const s = setup(t, { cfg: config({ dryRun: false, files: { enabled: true, dirs: [root] } }),
    onebot: { async call(action, params) {
      calls.push({ action, params })
      entered.resolve()
      await gate.promise
      throw new OneBotError(action, { message: '网关拒绝', status: 'failed' })
    } } })
  const work = s.hub.sendFile(CHAT, file)
  await entered.promise
  s.hub.dispose()
  gate.resolve()
  assert.equal(await work, null)
  assert.equal(await s.hub.sendFile(CHAT, file), null)
  assert.equal(calls.length, 1)
  assert.equal(s.hub.stats().sent, 0)
  assert.equal(s.hub.stats().errors, 0)
})

test('发送挂钩等待中卸载，挂钩完成后不再向网关发送', { timeout: 5000 }, async (t) => {
  const entered = deferred()
  const gate = deferred()
  t.after(() => gate.resolve())
  const { hub, calls } = setup(t, { cfg: config({ dryRun: false }), hooks: { send: async (message) => {
    entered.resolve(); await gate.promise; return message
  } } })
  const work = hub.sendText(CHAT, '不应发出去')
  await entered.promise
  hub.dispose()
  gate.resolve()
  await work
  assert.equal(calls.length, 0)
})

test('回复拆条发送中卸载，已开始的请求结束后不再发送下一条', { timeout: 5000 }, async (t) => {
  const entered = deferred()
  const gate = deferred()
  t.after(() => gate.resolve())
  const sends = []
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(root, 'deliver-'))
  const fake = createFakeDsh({ brain: async () => '' })
  const hub = createHub({ dsh: fake.ctx, getConfig: () => config({ dryRun: false }),
    log: { info() {}, debug() {}, warn() {}, error() {} },
    onebot: { async call(action, params) { sends.push({ action, params }); entered.resolve(); await gate.promise; return { message_id: 1 } } } })
  t.after(() => { try { hub.dispose?.() } finally { fake.dispose() } })
  const work = hub.deliver(CHAT, '第一条|||第二条')
  await entered.promise
  hub.dispose()
  gate.resolve()
  await work
  assert.equal(sends.length, 1)
})

test('卸载会停止私聊输入状态的定时更新', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const entered = deferred()
  const gate = deferred()
  t.after(() => gate.resolve(''))
  const { hub, calls } = setup(t, { cfg: config({ dryRun: false }), brain: async () => {
    entered.resolve()
    return gate.promise
  } })
  const work = hub.pushToSession(ownerChat, [{ type: 'text', text: '输入状态' }], OWNER).catch((error) => error)
  await entered.promise
  const typingCount = () => calls.filter((c) => c.action === 'set_input_status').length
  assert.equal(typingCount(), 1)
  hub.dispose()
  t.mock.timers.tick(45_000)
  assert.equal(typingCount(), 1, '卸载后不应继续发送正在输入状态')
  gate.resolve('')
  await work
})

test('卸载会结束后台回复等待，而不用等模型或超时', { timeout: 5000 }, async (t) => {
  const { hub, fake } = setup(t)
  const followup = deferred()
  const entered = deferred()
  t.after(() => followup.resolve())
  const create = fake.ctx.services.sessionController.create
  fake.ctx.services.sessionController.create = async (args) => {
    const result = await create(args)
    fake.agents.get(result.sessionId).followup = () => { entered.resolve(); return followup.promise }
    return result
  }
  const work = hub.runSystemTurn('waiting', '后台等待', '等待回复', { timeoutMs: 5000 }).catch((error) => error)
  await entered.promise
  hub.dispose()
  const result = await withDeadline(work)
  assert.equal(result.code, 'AURABOT_DISPOSED')
})

