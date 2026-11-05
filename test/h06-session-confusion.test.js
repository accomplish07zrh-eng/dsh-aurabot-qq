// H06 隔离夹具：历史/压缩/模式混淆的会话侧断言（真实 hub + 假 DSH + 假 QQ 网关）。
// 覆盖三件事：
//   1. resetChat 归档旧会话后，还在跑的旧一轮结束时「旧队列不能向新会话/聊天投递」；
//   2. 不同聊天（主人私聊 full / 白名单私聊 social）会话映射互不串，turnHasOwner / turnSendersAllOwner
//      按会话隔离——主人在别的聊天活跃不能给这个会话升权；
//   3. directOwner（主人在 DSH 面板直接打字）只在当轮生效，轮次结束必须清掉，不能残留到下一轮。
// 说明：长对话压缩/steer 的真实宿主行为（DSH 内部压缩）在本夹具覆盖不到，仍是方案里的 blocked 部分；
//       这里补的是插件侧能确定性验证的会话映射、档位与轮次状态边界。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWNER = '10000001'
const GUEST = '10000002'
const BOT = '20000002'
const G555 = '555'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000) {
  const t = Date.now()
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(40) }
  throw new Error('等不到条件成立')
}

let mock, fake, api, dataDir

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-h06-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  const { startMockOneBot } = await import('./helpers/mock-onebot.js')
  const { createFakeDsh } = await import('./helpers/fake-dsh.js')
  mock = await startMockOneBot({ selfId: BOT })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true, dryRun: false, setupDone: true, botQQ: BOT, ownerQQ: OWNER,
    allow: { private: [OWNER, GUEST], groups: [G555] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'none') },
    voice: { engine: 'windows', autoChance: 0, enabled: false },
    stickers: { autoChance: 0, enabled: false },
    memory: { enabled: false },
    group: { interjectChance: 0, burstMax: 50 },
    merge: { waitSec: 0.05, maxSec: 0.5, groupWaitSec: 0.05, groupMaxSec: 0.5 },
    chat: { seedHistory: false },
    model: { provider: 'fake', model: 'fake-1' },
  }))
  // 模型脚本：H06 场景一用「闩」把一轮挂住（模拟还在跑/还没被压缩完的旧一轮），其余照常回
  const hang = { started: 0, resolve: null }
  fake = createFakeDsh({ brain: async ({ text }) => {
    if (String(text).includes('H06-HANG')) { hang.started++; await new Promise((r) => { hang.resolve = r }); return 'H06-旧回复（不该发出）' }
    return 'H06-新回复'
  } })
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await fake.call('/onebot/reconnect')
  await until(() => mock.connected() > 0)
  globalThis.__h06 = { hangRelease: () => hang.resolve && hang.resolve(), hangWaitStarted: (n) => until(() => hang.started >= n, 5000) }
})

after(async () => {
  try { fake?.dispose() } catch {}
  try { await mock?.close() } catch {}
})

const priv = (uid, t) => ({ message_type: 'private', sub_type: 'friend', user_id: Number(uid), message_id: Math.floor(Math.random() * 1e6), sender: { user_id: Number(uid), nickname: uid === OWNER ? 'xiaoming' : '小七' }, message: [{ type: 'text', data: { text: t } }] })
const sidOf = (chatId) => api.hub.sessions()[chatId]?.sessionId || ''
const sentTexts = () => mock.sent('send_private_msg').map((c) => JSON.stringify(c.params))

test('H06-a：resetChat 归档旧会话后，旧一轮的回复不得投递到 QQ，也不得占用新会话', async () => {
  const sentBefore = mock.sent('send_private_msg').length
  // 旧一轮：挂着不结束
  mock.push(priv(GUEST, 'H06-HANG 旧一轮'))
  await globalThis.__h06.hangWaitStarted(1) // 等 brain 真正跑起来（senders/turnState 已记录）
  const oldSid = sidOf(`private:${GUEST}`)
  assert.ok(oldSid, '旧会话应已创建')
  // 归档旧会话：映射删除、turnState 删除
  assert.equal(api.hub.resetChat(`private:${GUEST}`), true, 'resetChat 应成功')
  // 放开旧一轮：它结束时 chatId 反查不到，必须静默丢弃
  globalThis.__h06.hangRelease()
  await until(() => fake.turns.some((t) => t.sessionId === oldSid), 5000)
  await sleep(600)
  const sends = sentTexts().slice(sentBefore)
  assert.ok(!sends.some((s) => s.includes('H06-旧回复')), '旧一轮的回复不能在归档后发到 QQ')
  // 旧会话已被归档，映射里不该再有它
  assert.notEqual(sidOf(`private:${GUEST}`), oldSid, '旧会话映射已删，新消息要开新会话')
  // 新消息开新会话并正常回复（旧一轮残留的 running/busy 不得吞掉新消息）
  mock.push(priv(GUEST, 'H06 新一轮你好'))
  await until(() => fake.turns.some((t) => t.sessionId !== oldSid && String(t.userText).includes('新一轮你好')), 8000)
  const newSid = sidOf(`private:${GUEST}`)
  assert.notEqual(newSid, oldSid, '新消息必须用新会话')
  await until(() => sentTexts().some((s) => s.includes('H06-新回复')), 8000)
})

test('H06-b：主人私聊与白名单私聊会话互不串，跨聊天活跃不能给这个会话升权', async () => {
  // 白名单私聊挂一轮
  mock.push(priv(GUEST, 'H06-HANG guest hang'))
  await globalThis.__h06.hangWaitStarted(2) // 第二次挂起真正开跑
  const guestSid = sidOf(`private:${GUEST}`)
  assert.ok(guestSid, '白名单会话应已创建')
  assert.equal(api.hub.turnHasOwner(guestSid), false, '白名单私聊挂起期间不因主人身份升权')
  assert.equal(api.hub.turnSendersAllOwner(guestSid), false, 'turnSendersAllOwner 对白名单私聊必须是 false')
  // 主人在自己的私聊同时活跃
  const sentBeforeOwner = mock.sent('send_private_msg').length
  mock.push(priv(OWNER, 'H06 主人在自己私聊说话'))
  await until(() => mock.sent('send_private_msg').length > sentBeforeOwner, 8000)
  const ownerSid = sidOf(`private:${OWNER}`)
  assert.ok(ownerSid && ownerSid !== guestSid, '主人私聊和白名单私聊必须是两个会话')
  assert.equal(api.hub.chatOfSession(ownerSid), `private:${OWNER}`, '主人会话映射正确')
  assert.equal(api.hub.chatOfSession(guestSid), `private:${GUEST}`, '白名单会话映射正确')
  assert.equal(api.hub.turnSendersAllOwner(guestSid), false, '主人在别的聊天活跃，白名单会话仍不得升权')
  // 各回各的：回复发给各自的私聊，不串
  const texts = sentTexts()
  assert.ok(texts.some((s) => s.includes('H06-新回复')), '两轮都该有回复')
  globalThis.__h06.hangRelease()
  await until(() => fake.turns.filter((t) => t.sessionId === guestSid).length >= 1, 5000)
  await sleep(400)
})

test('H06-c：directOwner（面板直接打字）当轮有效，轮次结束必须清零', async () => {
  // 先正常来一轮，拿到会话
  const sentBeforeC = mock.sent('send_private_msg').length
  mock.push(priv(GUEST, 'H06 第一轮'))
  await until(() => mock.sent('send_private_msg').length > sentBeforeC, 8000)
  const sid = sidOf(`private:${GUEST}`)
  // 模拟主人在 DSH 面板往这个会话里直接打字（DSH 会发 user/message + source.kind=user）
  const agent = fake.agents.get(sid)
  assert.ok(agent, '会话 agent 应存在')
  fake.emit('session/event', agent.session, { type: 'user/message', data: { source: { kind: 'user' } } })
  assert.equal(api.hub.turnSendersAllOwner(sid), true, '面板直接打字当轮按主人算（#58 设计语义）')
  // 这一轮结束（下一轮 turn/end）后必须清零，不能残留给纯 QQ 来的轮次
  const turnsBefore = fake.turns.filter((t) => t.sessionId === sid).length
  const sentBeforeC2 = mock.sent('send_private_msg').length
  mock.push(priv(GUEST, 'H06 第二轮'))
  await until(() => fake.turns.filter((t) => t.sessionId === sid).length > turnsBefore, 8000)
  await until(() => mock.sent('send_private_msg').length > sentBeforeC2, 8000)
  await sleep(700) // 等 turn/end 之后的 deliver/release 落定
  assert.equal(api.hub.turnSendersAllOwner(sid), false, 'directOwner 不能跨轮残留')
  assert.equal(api.hub.turnHasOwner(sid), false, 'turnHasOwner 同样不能跨轮残留')
})
