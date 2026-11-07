// 工作区挂载失败发生在后台轮次启动前：退避、清理和各入口必须共用 hub 状态。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createHub } from '../src/chat/hub.js'
import { isSessionBackoff } from '../src/chat/session-backoff.js'
import { createBili } from '../src/bili/duty.js'
import { createPurpose } from '../src/purpose/module.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const MINUTE = 60_000
const OWNER = '10000001'
const BOT = '20000002'
const ownerChat = { kind: 'private', chatId: `private:${OWNER}`, userId: OWNER, nickname: '主人' }
const content = [{ type: 'text', text: '你好' }]
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate) }

function setup(t) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 5, 10, 12).getTime() })
  const root = mkdtempSync(join(tmpdir(), 'aurabot-session-backoff-'))
  const oldDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = join(root, 'data')
  const fake = createFakeDsh({ brain: async () => '' })
  const cfg = normalize({ enabled: true, dryRun: true, setupDone: true, ownerQQ: OWNER, botQQ: BOT,
    workspaceDir: join(root, 'workspace'), merge: { enabled: false }, voice: { enabled: false },
    stickers: { autoChance: 0, reactChance: 0 }, allow: { groups: ['777'] },
    bili: { enabled: true, autoBrowse: true, keywords: ['猫'], maxRunsPerDay: 10, intervalHours: 1, reply: true },
    speakUp: { awakeFrom: 0, awakeTo: 24, nudge: false },
    ext: { purpose: { enabled: true, minMaterials: 0 } },
  })
  const logs = { info: [], warn: [], error: [], debug: [] }
  const log = Object.fromEntries(Object.keys(logs).map((level) => [level, (...args) => logs[level].push(args.join(' '))]))
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg, log,
    onebot: { async call() { return { message_id: 1 } } },
  })
  fake.ctx.effect(() => fake.ctx.on('session/event', hub.onSessionEvent))
  const c = fake.ctx.services.sessionController
  const create = c.create.bind(c)
  const calls = []
  const orphans = []
  let mode = 'attach'
  let errorFactory = null
  c.create = async (args) => {
    calls.push(args)
    if (mode === 'success') return create(args)
    const sid = `orphan-${calls.length}`
    orphans.push(sid)
    if (errorFactory) throw errorFactory(args, sid)
    throw new Error(`session "${sid}" was created but could not attach to workspace "${args.workspaceId}": cwd mismatch`)
  }
  t.after(() => {
    hub.dispose()
    fake.dispose()
    if (oldDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = oldDir
    rmSync(root, { recursive: true, force: true })
  })
  return { hub, fake, cfg, log, logs, c, calls, orphans, root,
    mode: (value) => { mode = value },
    error: (factory) => { errorFactory = factory },
    run: (options = {}) => hub.runSystemTurn('probe', '测试后台', '想一想', options),
  }
}

async function failed(promise, minutes) {
  const error = await promise.then(() => assert.fail('应该失败'), (error) => error)
  assert.equal(isSessionBackoff(error), true)
  assert.equal(error.retryAt - Date.now(), minutes * MINUTE)
  assert.match(error.message, /会话冷却中/)
  return error
}

const event = (text, id) => ({ post_type: 'message', message_type: 'private', sub_type: 'friend',
  self_id: Number(BOT), user_id: Number(OWNER), message_id: id,
  sender: { user_id: Number(OWNER), nickname: '主人' }, message: [{ type: 'text', data: { text } }],
})

test('同一个后台 key 按 1、5、15、30、60 分钟退避；冷却中不调用宿主，warn 只记首次和升级', async (t) => {
  const s = setup(t)
  for (const [index, minutes] of [1, 5, 15, 30, 60, 60].entries()) {
    await failed(s.run({ key: 'browse' }), minutes)
    assert.equal(s.calls.length, index + 1)
    assert.equal(s.logs.warn.length, Math.min(index + 1, 5))
    assert.equal(s.hub.systemSessionCooldown('probe', { key: 'browse' }).count, index + 1)
    for (let n = 0; n < 3; n++) await failed(s.run({ key: 'browse', noTools: n === 1 }), minutes)
    assert.equal(s.calls.length, index + 1, '切换 noTools 也不能绕过同 key 退避')
    t.mock.timers.tick(minutes * MINUTE - 1)
    await failed(s.run({ key: 'browse' }), 1 / MINUTE)
    assert.equal(s.calls.length, index + 1)
    t.mock.timers.tick(1)
  }
  assert.equal(s.hub.systemSessionCooldown('probe', { key: 'browse' }), null)
  assert.match(s.logs.warn[0], /DSH 无法把新会话挂到工作区/)
  assert.ok(s.logs.warn[0].includes(s.cfg.workspaceDir))
  assert.match(s.logs.warn[0], /可在 DSH 里检查该工作区或删掉重建/)
  assert.equal(s.hub.sessionHealth()[0].count, 6)
})

test('后台 key 分别退避，不会连带挡住别的任务', async (t) => {
  const s = setup(t)
  await failed(s.run({ key: 'a' }), 1)
  await failed(s.run({ key: 'b' }), 1)
  assert.equal(s.calls.length, 2)
  assert.equal(s.hub.systemSessionCooldown('probe'), null)
})

test('建会话成功一次清零，之后再失败从一分钟开始', async (t) => {
  const s = setup(t)
  await failed(s.run(), 1)
  t.mock.timers.tick(MINUTE)
  await failed(s.run(), 5)
  t.mock.timers.tick(5 * MINUTE)
  s.mode('success')
  assert.equal(await s.run(), '')
  assert.deepEqual(s.hub.sessionHealth(), [])
  assert.equal(s.hub.systemSessionCooldown('probe'), null)
  // 改权限要求新会话，用真实入口验证清零，而非直接改内部 Map。
  s.mode('attach')
  await failed(s.run({ noTools: true }), 1)
  assert.equal(s.logs.warn.length, 3)
})

for (const method of ['delete', 'close']) test(`只清理明确新建的孤儿：调用 sessionController.${method} 并保留 this`, async (t) => {
  const s = setup(t)
  const removed = []
  s.c[method] = async function (request) { assert.equal(this, s.c); removed.push(request); return { ok: true } }
  await failed(s.run(), 1)
  assert.deepEqual(removed, [{ sessionId: 'orphan-1' }])
  assert.deepEqual(s.hub.sessions(), {})
  await failed(s.run(), 1)
  assert.equal(removed.length, 1, '冷却不应再调用清理')
})

test('宿主结构化挂载错误也会退避和清理', async (t) => {
  const s = setup(t)
  const removed = []
  s.c.delete = async (request) => { removed.push(request) }
  s.error((args, sessionId) => Object.assign(new Error('workspace attach failed'), {
    code: 'session/workspace-attach-failed', data: { sessionId, workspaceId: args.workspaceId },
  }))
  await failed(s.run(), 1)
  assert.deepEqual(removed, [{ sessionId: 'orphan-1' }])
})

test('没有清理入口、清理失败都只记 debug，原始挂载故障和退避保留', async (t) => {
  const s = setup(t)
  const first = await failed(s.run(), 1)
  assert.match(first.cause.message, /cwd mismatch/)
  assert.ok(s.logs.debug.some((line) => /没有删除或关闭接口/.test(line)))
  t.mock.timers.tick(MINUTE)
  s.c.delete = async () => { throw new Error('删除被拒绝') }
  await failed(s.run(), 5)
  assert.ok(s.logs.debug.some((line) => /清理失败.*删除被拒绝/.test(line)))
  assert.equal(s.logs.warn.length, 2)
})

test('不清理已映射的正常会话或其他工作区的会话', async (t) => {
  const s = setup(t)
  s.mode('success')
  await s.hub.pushToSession(ownerChat, content, OWNER)
  const normal = s.hub.sessions()[ownerChat.chatId].sessionId
  const removed = []
  s.c.delete = async (request) => { removed.push(request) }
  s.mode('attach')
  s.error((args) => new Error(`session "${normal}" was created but could not attach to workspace "${args.workspaceId}"`))
  await failed(s.run(), 1)
  assert.deepEqual(removed, [])
  assert.equal(s.hub.sessions()[ownerChat.chatId].sessionId, normal)
  s.error(() => new Error('session "unrelated" was created but could not attach to workspace "another-workspace"'))
  await failed(s.run({ key: 'other' }), 1)
  assert.deepEqual(removed, [])
})

test('宿主工作区里已有的会话也不当成孤儿删除', async (t) => {
  const s = setup(t)
  const workspace = await s.hub.ensureWorkspace()
  workspace.sessionIds.push('orphan-1')
  const removed = []
  s.c.delete = async (request) => { removed.push(request) }
  await failed(s.run(), 1)
  assert.deepEqual(removed, [])
})

test('主人私聊和群聊被 @ 的建会话退避最多五分钟', async (t) => {
  const s = setup(t)
  const group = { kind: 'group', chatId: 'group:777', groupId: '777', mentioned: true }
  for (const minutes of [1, 5, 5, 5, 5]) {
    await failed(s.hub.pushToSession(ownerChat, content, OWNER), minutes)
    await failed(s.hub.pushToSession(group, content, OWNER), minutes)
    const attempts = s.calls.length
    await failed(s.hub.pushToSession(ownerChat, content, OWNER), minutes)
    assert.equal(s.calls.length, attempts)
    t.mock.timers.tick(minutes * MINUTE)
  }
  assert.equal(s.logs.warn.length, 4, '每个 QQ key 只记一分钟和五分钟两档')
})

test('QQ 新建失败后保留消息，冷却中不刷错误；下次消息触发重试并带上先前内容', async (t) => {
  const s = setup(t)
  await s.hub.onMessage(event('第一条不能丢', 1))
  await settle()
  assert.equal(s.calls.length, 1)
  assert.match(s.logs.warn[0], /QQ 消息已保留/)
  await s.hub.onMessage(event('冷却时来的第二条', 2))
  await settle()
  assert.equal(s.calls.length, 1)
  assert.equal(s.logs.warn.length, 1)
  assert.deepEqual(s.logs.error, [])
  t.mock.timers.tick(MINUTE)
  s.mode('success')
  await s.hub.onMessage(event('第三条触发重试', 3))
  await settle()
  assert.equal(s.calls.length, 2)
  assert.equal(s.fake.turns.length, 1)
  const text = s.fake.turns[0].userText
  assert.match(text, /第一条不能丢/)
  assert.match(text, /冷却时来的第二条/)
  assert.match(text, /第三条触发重试/)
  assert.deepEqual(s.hub.sessionHealth(), [])
})

test('群聊被 @ 后挂载失败，后续重试仍保留已被 groupPrompt 标记为 fed 的原消息', async (t) => {
  const s = setup(t)
  const groupEvent = (text, id) => ({ ...event(text, id), message_type: 'group', group_id: 777,
    message: [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text } }],
  })
  await s.hub.onMessage(groupEvent('群里第一条不能丢', 11))
  await settle()
  assert.equal(s.calls.length, 1)
  t.mock.timers.tick(MINUTE)
  await s.hub.onMessage(groupEvent('第二条仍然失败', 12))
  await settle()
  assert.equal(s.calls.length, 2)
  t.mock.timers.tick(6 * MINUTE)
  s.mode('success')
  await s.hub.onMessage(groupEvent('第三条重试成功', 13))
  await settle()
  assert.equal(s.fake.turns.length, 1)
  assert.match(s.fake.turns[0].userText, /群里第一条不能丢/)
  assert.match(s.fake.turns[0].userText, /第二条仍然失败/)
  assert.match(s.fake.turns[0].userText, /第三条重试成功/)
  assert.match(s.fake.turns[0].userText, /\[1\].*群里第一条不能丢/)
  assert.match(s.fake.turns[0].userText, /\[2\].*第二条仍然失败/)
  assert.match(s.fake.turns[0].userText, /\[3\].*第三条重试成功/)
})

test('QQ 并发创建也只调一次宿主', async (t) => {
  const s = setup(t)
  const results = await Promise.allSettled([
    s.hub.pushToSession(ownerChat, content, OWNER), s.hub.pushToSession(ownerChat, content, OWNER),
  ])
  assert.ok(results.every((r) => r.status === 'rejected' && isSessionBackoff(r.reason)))
  assert.equal(s.calls.length, 1)
  assert.equal(s.logs.warn.length, 1)
})

test('B站挑关键词遇到挂载失败直接跳过；冷却期间 tick/run/checkReplies 不再请求宿主或 B站', async (t) => {
  const s = setup(t)
  let apiCalls = 0
  const api = Object.fromEntries(['search', 'popular', 'replyFeed', 'nav'].map((name) => [name, async () => { apiCalls++; return [] }]))
  const bili = createBili({ getConfig: () => s.cfg, hub: s.hub, log: s.log, dsh: s.fake.ctx, api })
  t.after(() => bili.dispose())
  const first = await bili.run()
  assert.equal(first.skipped, true)
  assert.equal(s.calls.length, 1)
  assert.equal(apiCalls, 0, '不应退回随机关键词后继续搜索')
  const before = structuredClone(s.logs)
  for (let i = 0; i < 3; i++) {
    await bili.tick()
    assert.equal((await bili.run()).skipped, true)
    assert.equal((await bili.checkReplies()).skipped, true)
  }
  assert.equal(s.calls.length, 1)
  assert.equal(apiCalls, 0)
  assert.equal(bili.state().runs, 0)
  assert.equal(bili.state().lastRun, 0)
  assert.deepEqual(s.logs, before)
})

test('目的引擎首次挂载失败撤销预占次数，冷却跳过且不记自己的失败或日志', async (t) => {
  const s = setup(t)
  const purpose = createPurpose({ getConfig: () => s.cfg, hub: s.hub, log: s.log,
    personaText: () => '喜欢游戏，想和主人分享有趣的见闻。',
    memory: () => ({ list: () => [{ id: 'm1', text: '主人喜欢玩游戏', importance: 0.8, at: Date.now() }] }),
  })
  assert.equal((await purpose.fire()).outcome, 'skipped-cooldown')
  assert.equal(s.calls.length, 1)
  assert.equal(purpose.state().countToday, 0)
  assert.notEqual(purpose.state().lastOutcome, 'failed')
  const stateFile = join(s.root, 'data', 'purpose', 'purpose-state.json')
  const beforeState = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(beforeState.attempts, 0)
  assert.equal(beforeState.history.length, 0)
  const before = structuredClone(s.logs)
  for (let i = 0; i < 3; i++) {
    await purpose.tick()
    assert.equal((await purpose.fire()).outcome, 'skipped-cooldown')
  }
  assert.equal(s.calls.length, 1)
  assert.equal(purpose.state().countToday, 0)
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), beforeState)
  assert.deepEqual(s.logs, before)
})

test('更换工作区不沿用旧路径冷却', async (t) => {
  const s = setup(t)
  await failed(s.run(), 1)
  s.cfg.workspaceDir = join(s.root, 'new-workspace')
  s.mode('success')
  assert.equal(await s.run(), '')
  assert.equal(s.calls.length, 2)
  assert.deepEqual(s.hub.sessionHealth(), [])
})

test('其他创建错误保持原样，不退避、不清理；已有正常 QQ 会话继续复用', async (t) => {
  const s = setup(t)
  s.mode('success')
  await s.hub.pushToSession(ownerChat, content, OWNER)
  const normal = s.hub.sessions()[ownerChat.chatId].sessionId
  const unrelated = Object.assign(new Error('模型配置不存在'), { code: 'session/preset-not-found' })
  const removed = []
  s.c.delete = async (request) => { removed.push(request) }
  s.mode('attach')
  s.error(() => unrelated)
  for (let i = 0; i < 2; i++) await assert.rejects(s.run(), (error) => error === unrelated)
  assert.equal(s.calls.length, 3)
  assert.equal(s.hub.systemSessionCooldown('probe'), null)
  assert.deepEqual(s.hub.sessionHealth(), [])
  assert.deepEqual(removed, [])
  await s.hub.pushToSession(ownerChat, content, OWNER)
  assert.equal(s.calls.length, 3)
  assert.equal(s.hub.sessions()[ownerChat.chatId].sessionId, normal)
})
