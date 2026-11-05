// 记忆隐私端到端回归（M06 F1/F2）：真实 hub + 假 DSH + 假 QQ 网关。
// 断言最终交给模型的 prompt 与 recall_memory 工具结果：主人私聊里的私人记忆不出现在群聊/别人的私聊；
// 主人私聊与“当前聊天产生的记忆”仍能正常工作。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const ROOT = mkdtempSync(join(tmpdir(), 'aurabot-mempriv-e2e-'))
process.env.AURABOT_DATA_DIR = join(ROOT, 'data')
process.env.AURABOT_WORKSPACE = join(ROOT, 'ws')
mkdirSync(process.env.AURABOT_DATA_DIR, { recursive: true })
mkdirSync(process.env.AURABOT_WORKSPACE, { recursive: true })

const OWNER = '10000001'
const GUEST = '10000111'
const OTHER = '20000222'
const BOT = '20000002'
const G555 = '555'
const G556 = '556'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until (fn, ms = 10000) {
  const t = Date.now()
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(50) }
  throw new Error('等不到条件成立')
}

const CANARY = {
  ownerOwn: 'OWNER_OWN_CANARY 主人的银行卡密码 123456',
  ownerAboutGuest: 'OWNER_ABOUT_GUEST_CANARY 主人私下说小七篮球打得差还欠他500块',
  ownerDiary: 'OWNER_DIARY_CANARY 主人今天一个人吃外卖',
  groupOther: 'GROUP_556_CANARY 群556的篮球私事',
  groupSameChat: 'GROUP_555_SAME_CHAT_CANARY 小七在群里约过周六打球',
  groupPublic: 'GROUP_555_PUBLIC_CANARY 群555周六篮球局',
  guestPrivate: 'GUEST_PRIVATE_SAME_CHAT_CANARY 小七私聊说自己喜欢篮球',
}

let mock
let fake
let api

async function brain ({ text, callTool }) {
  if (String(text).includes('翻记忆')) {
    const r = await callTool('recall_memory', { query: '密码 外卖 篮球 周六 欠 500 私事' })
    return r ? String(r.message || '') : '没有记忆工具'
  }
  return '嗯'
}

before(async () => {
  mock = await startMockOneBot({ selfId: BOT })
  writeFileSync(join(process.env.AURABOT_DATA_DIR, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: false,
    setupDone: true,
    botQQ: BOT,
    ownerQQ: OWNER,
    allow: { private: [OWNER, GUEST], groups: [G555, G556] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(ROOT, 'no-snowluma') },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
    group: { interjectChance: 0, burstMax: 50 },
    merge: { waitSec: 0.2, maxSec: 1, groupWaitSec: 0.2, groupMaxSec: 1 },
    memory: { enabled: true, recallCount: 20 },
    model: { provider: 'fake', model: 'fake-1' },
  }))
  fake = createFakeDsh({ brain })
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await fake.call('/onebot/reconnect')
  await until(() => mock.connected() > 0)

  // 种子记忆：模拟提炼/面板写入的真实产物（主人私聊来源、群来源、群公共、别的群、本人私聊）
  api.memory.add({ text: CANARY.ownerOwn, about: OWNER, aboutName: '主人', source: 'tool', chatId: `private:${OWNER}`, importance: 0.9 })
  api.memory.add({ text: CANARY.ownerAboutGuest, about: GUEST, aboutName: '群友小七', source: 'auto', chatId: `private:${OWNER}`, importance: 0.9 })
  api.memory.add({ text: CANARY.ownerDiary, source: 'diary', importance: 0.8 })
  api.memory.add({ text: CANARY.groupOther, about: GUEST, aboutName: '群友小七', source: 'auto', chatId: `group:${G556}`, importance: 0.9 })
  api.memory.add({ text: CANARY.groupSameChat, about: GUEST, aboutName: '群友小七', source: 'auto', chatId: `group:${G555}`, importance: 0.8 })
  api.memory.add({ text: CANARY.groupPublic, scope: 'group', chatId: `group:${G555}`, source: 'auto', importance: 0.8 })
  api.memory.add({ text: CANARY.guestPrivate, about: GUEST, aboutName: '群友小七', source: 'tool', chatId: `private:${GUEST}`, importance: 0.8 })
})

after(async () => {
  try { fake?.dispose() } catch (error) {}
  try { await mock?.close() } catch (error) {}
})

const priv = (uid, t) => ({ message_type: 'private', sub_type: 'friend', user_id: Number(uid), message_id: Math.floor(Math.random() * 1e6), sender: { user_id: Number(uid), nickname: uid === OWNER ? 'xiaoming' : '小七' }, message: [{ type: 'text', data: { text: t } }] })
const grp = (uid, t, group = G555, nick = '小七') => ({ message_type: 'group', sub_type: 'normal', group_id: Number(group), user_id: Number(uid), message_id: Math.floor(Math.random() * 1e6), sender: { user_id: Number(uid), nickname: nick, card: nick, role: 'member' }, message: [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' ' + t } }] })
const promptOf = (turn) => String((turn && turn.ctxText) || '') + '\n' + String((turn && turn.userText) || '')
async function nextTurn (fn) {
  const before = fake.turns.length
  fn()
  return until(() => fake.turns.length > before).then(() => fake.turns.at(-1))
}

test('F1：群聊最终 prompt 不含主人私聊来源的记忆，也不含别的群；本群记忆不丢', async () => {
  const turn = await nextTurn(() => mock.push(grp(GUEST, '篮球 欠钱 500 外卖 密码 私事 周六 你怎么看')))
  const prompt = promptOf(turn)
  assert.doesNotMatch(prompt, /OWNER_OWN_CANARY/, '群聊 prompt 不能出现主人本人私密记忆')
  assert.doesNotMatch(prompt, /OWNER_ABOUT_GUEST_CANARY/, '群聊 prompt 不能出现主人私聊里关于群友的记忆')
  assert.doesNotMatch(prompt, /OWNER_DIARY_CANARY/, '群聊 prompt 不能出现无来源的私人日记')
  assert.doesNotMatch(prompt, /GROUP_556_CANARY/, '群聊 prompt 不能出现别的群产生的记忆')
  assert.match(prompt, /GROUP_555_SAME_CHAT_CANARY/, '本群产生的关于说话人的记忆仍要能想起')
  assert.match(prompt, /GROUP_555_PUBLIC_CANARY/, '本群公共记忆仍要能想起')
})

test('F2：群聊 recall_memory 不返回主人私聊/别的群的记忆，也不返回不在场人物记忆', async () => {
  // 先补一条“不在场人物”的记忆，确认群聊工具不会按 about 翻出来
  api.memory.add({ text: 'ABSENT_PERSON_CANARY 关于不在场的某人2的篮球私事', about: OTHER, aboutName: '某人2', source: 'auto', chatId: `group:${G556}`, importance: 0.9 })
  const turn = await nextTurn(() => mock.push(grp(GUEST, '翻记忆 篮球 欠钱 500 外卖 密码 私事 某人2')))
  const call = (turn.toolCalls || []).find((c) => c.name === 'recall_memory')
  assert.ok(call, '这一轮应该调用 recall_memory')
  const message = String(call.result?.message || '')
  assert.doesNotMatch(message, /OWNER_OWN_CANARY/)
  assert.doesNotMatch(message, /OWNER_ABOUT_GUEST_CANARY/)
  assert.doesNotMatch(message, /OWNER_DIARY_CANARY/)
  assert.doesNotMatch(message, /GROUP_556_CANARY/)
  assert.doesNotMatch(message, /ABSENT_PERSON_CANARY/, '群聊 recall_memory 不能翻不在场人物的记忆')
  assert.match(message, /GROUP_555_SAME_CHAT_CANARY/, '本群关于当前说话人的记忆仍要能翻到')
})

test('F1：非主人私聊 prompt 不含主人私聊内容，本聊天记忆不丢', async () => {
  const turn = await nextTurn(() => mock.push(priv(GUEST, '篮球 欠钱 500 外卖 密码 私事 你怎么看')))
  const prompt = promptOf(turn)
  assert.doesNotMatch(prompt, /OWNER_OWN_CANARY/)
  assert.doesNotMatch(prompt, /OWNER_ABOUT_GUEST_CANARY/)
  assert.doesNotMatch(prompt, /OWNER_DIARY_CANARY/)
  assert.doesNotMatch(prompt, /GROUP_555_SAME_CHAT_CANARY/, '别的聊天（群）的记忆不能进非主人私聊')
  assert.match(prompt, /GUEST_PRIVATE_SAME_CHAT_CANARY/, '当前私聊产生的记忆不能丢')
})

test('F1：主人私聊仍能回忆全部（不受影响）', async () => {
  const turn = await nextTurn(() => mock.push(priv(OWNER, '密码 外卖 篮球 欠钱 周六 私事 500')))
  const prompt = promptOf(turn)
  // prompt 里的相关记忆每轮最多 4 条；这里直接查 store 证明主人视角不受可见性过滤影响
  const hits = api.memory.recall('密码 外卖 篮球 欠钱 周六 私事 500 你怎么看', { where: `private:${OWNER}`, includeGroup: true, limit: 20 })
  const seen = hits.map((h) => h.it.text).join('\n')
  assert.match(seen, /OWNER_OWN_CANARY/)
  assert.match(seen, /OWNER_ABOUT_GUEST_CANARY/)
  assert.match(seen, /OWNER_DIARY_CANARY/)
  assert.match(seen, /GROUP_555_PUBLIC_CANARY/)
  assert.match(prompt, /OWNER_OWN_CANARY/, '主人私聊 prompt 里仍能看到自己的私密记忆')
  assert.match(prompt, /OWNER_DIARY_CANARY/, '主人私聊 prompt 仍带近期经历')
})
