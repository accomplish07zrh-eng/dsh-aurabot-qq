import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createMemoryStore } from '../src/features/memory.js'
import { createHub } from '../src/chat/hub.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { createSpeakUp } from '../src/features/companion.js'
import { createPurpose } from '../src/purpose/module.js'
import { existsSync } from 'node:fs'

const owner = '10000001', a = '10000002', b = '10000003', bot = '20000001'
const log = { info() {}, debug() {}, warn() {}, error() {} }
const day = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }
function fixture(t, output = { facts: [] }) {
  const old = process.env.AURABOT_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'persona-tags-'))
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => { if (old === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = old; rmSync(dir, { recursive: true, force: true }) })
  const cfg = normalize({ ownerQQ: owner, botQQ: bot, model: { provider: 'p', model: 'm' }, memory: { keepChatlogDays: 7 } })
  const rows = []
  const hub = { chatLogDays: () => [day()], chatLogOf: () => rows, speakersOf: () => [a], groupNames: new Map([['777', '测试群']]) }
  const dsh = { get: () => null, llm: { async *stream({ system }) { yield { type: 'text-delta', text: system.includes('整理长期记忆') ? JSON.stringify(output) : '{"insights":[],"style":[]}' }; yield { type: 'finish', reason: { kind: 'completed' } } } } }
  const memory = createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
  return { cfg, memory, rows, dir }
}

test('标签校验、主人保护、旧画像和筛选数据', (t) => {
  const { memory, rows, dir } = fixture(t)
  writeFileSync(join(dir, 'memories.json'), JSON.stringify({ items: [], profiles: { [a]: { text: '旧画像' }, [b]: { text: '另一个人' } }, insights: { ['qq:' + a]: [{ text: '耐心' }] }, relations: [{ subjQq: a, subj: '甲', objQq: b, obj: '乙', pred: '是朋友' }] }))
  assert.deepEqual(memory.personTags(a), [])
  assert.equal(memory.dislikes(a), false)
  assert.equal(memory.savePersonaPerson(a, { tags: ['喜欢', '讨厌'] }).ok, false)
  assert.equal(memory.savePersonaPerson(a, { tags: ['九'.repeat(9)] }).ok, false)
  assert.equal(memory.savePersonaPerson(a, { tags: Array.from({ length: 9 }, (_, i) => String(i)) }).ok, false)
  assert.equal(memory.savePersonaPerson(owner, { tags: ['讨厌'] }).ok, false)
  assert.equal(memory.savePersonaPerson(a, { tags: ['喜欢', '朋友'] }).ok, true)
  rows.push({ chatId: 'group:777', uid: a, who: '甲', text: '你好', t: Date.now() })
  const p = memory.personaOverview().find((x) => x.qq === a)
  assert.deepEqual(p.tags, ['喜欢', '朋友'])
  assert.deepEqual(p.groups, [{ id: '777', name: '测试群' }])
  assert.equal(p.hasRelations, true)
  assert.equal(p.hasInsights, true)
  assert.match(memory.contextFor({ kind: 'private', userId: a, chatId: `private:${a}` }, ''), /你挺喜欢TA.*朋友/)
  assert.match(memory.lookupPerson({ kind: 'private', userId: a, chatId: `private:${a}` }, a).message, /标签：喜欢、朋友/)
  assert.equal(memory.dislikes(owner), false)
})

test('提炼只接受本人或主人来源，手动标签优先', async (t) => {
  const output = { facts: [], people: [{ qq: a, like: { text: '讨厌', speaker: a } }, { qq: b, like: { text: '喜欢', speaker: a } }, { qq: owner, like: { text: '讨厌', speaker: owner } }] }
  const { memory, rows } = fixture(t, output)
  memory.savePersonaPerson(a, { tags: ['朋友'] })
  for (const uid of [a, b, owner]) rows.push({ chatId: 'group:777', uid, who: uid, text: '聊天', t: Date.now() })
  await memory.consolidate({ includeToday: true })
  assert.deepEqual(memory.personTags(a), ['朋友'])
  assert.deepEqual(memory.personTags(b), [])
  assert.equal(memory.dislikes(owner), false)
})

test('模型形成喜恶并替换原来的喜恶，其他标签保留', async (t) => {
  const { memory, rows, dir } = fixture(t, { facts: [], people: [{ qq: a, like: { text: '讨厌', speaker: a } }] })
  writeFileSync(join(dir, 'memories.json'), JSON.stringify({ items: [], profiles: { [a]: { tags: ['喜欢', '朋友'] } } }))
  rows.push({ chatId: 'group:777', uid: a, who: '甲', text: '你好', t: Date.now() })
  await memory.consolidate({ includeToday: true })
  assert.deepEqual(memory.personTags(a), ['朋友', '讨厌'])
  assert.equal(memory.dislikes(a), true)
  assert.match(memory.contextFor({ kind: 'private', userId: a, chatId: `private:${a}` }, ''), /你讨厌TA，不想搭理，要说也很短很冷/)
})

test('讨厌者静默仍记流水；概率为零和主人不拦', async (t) => {
  const { cfg } = fixture(t)
  Object.assign(cfg, { enabled: true, dryRun: true })
  cfg.allow.private = [a]
  cfg.merge.enabled = false
  cfg.memory.dislikeSilence = 1
  const fake = createFakeDsh({ brain: async () => '好' })
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg, log, onebot: { connected: true, call: async () => ({}) }, dislikes: () => true, random: () => 0 })
  t.after(() => { hub.dispose(); fake.dispose() })
  const event = (uid) => ({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: Number(bot), user_id: Number(uid), message_id: 1, sender: { user_id: Number(uid), nickname: uid }, message: [{ type: 'text', data: { text: '你好' } }] })
  await hub.onMessage(event(a))
  for (let i = 0; i < 20; i++) await new Promise(setImmediate)
  assert.equal(fake.turns.length, 0)
  assert.ok(hub.chatLogOf(day()).some((x) => x.uid === a && x.text === '你好'))
  cfg.memory.dislikeSilence = 0
  await hub.onMessage(event(a))
  for (let i = 0; i < 20; i++) await new Promise(setImmediate)
  assert.ok(fake.turns.length > 0)
  cfg.memory.dislikeSilence = 1
  await hub.onMessage(event(owner))
  for (let i = 0; i < 20; i++) await new Promise(setImmediate)
  assert.ok(fake.turns.length > 1)
})

test('群聊合批中混入其他人时不拦', async (t) => {
  const { cfg } = fixture(t)
  cfg.enabled = true
  cfg.dryRun = true
  cfg.allow.groups = ['777']
  cfg.memory.dislikeSilence = 1
  Object.assign(cfg.merge, { enabled: true, groupWaitSec: 0.1, groupMaxSec: 1 })
  const fake = createFakeDsh({ brain: async () => '好' })
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg, log, onebot: { connected: true, call: async () => ({ group_name: '群' }) }, dislikes: (qq) => qq === a, random: () => 0 })
  t.after(() => { hub.dispose(); fake.dispose() })
  const event = (uid) => ({ post_type: 'message', message_type: 'group', group_id: 777, self_id: Number(bot), user_id: Number(uid), message_id: Number(uid), sender: { user_id: Number(uid), nickname: uid }, message: [{ type: 'at', data: { qq: bot } }, { type: 'text', data: { text: '你好' } }] })
  await hub.onMessage(event(a))
  await hub.onMessage(event(b))
  await new Promise((resolve) => setTimeout(resolve, 250))
  for (let i = 0; i < 20; i++) await new Promise(setImmediate)
  assert.ok(fake.turns.length > 0)
  assert.ok(hub.chatLogOf(day()).some((x) => x.uid === a))
  assert.ok(hub.chatLogOf(day()).some((x) => x.uid === b))
})

test('目的引擎跳过讨厌的人', async (t) => {
  const { cfg, dir } = fixture(t)
  cfg.enabled = true
  cfg.speakUp.allow = [a]
  cfg.ext.purpose = { enabled: true, initialDelayMinutes: 1 }
  const p = createPurpose({ getConfig: () => cfg, hub: {}, log, isMuted: (id) => id === `private:${owner}`, memory: () => ({ dislikes: (qq) => qq === a }) })
  await p.tick()
  assert.equal(existsSync(join(dir, 'purpose', 'friends', `${a}.json`)), false)
})

test('主动搭话跳过讨厌的人', async (t) => {
  const { cfg } = fixture(t)
  cfg.enabled = true
  Object.assign(cfg.speakUp, { enabled: true, allow: [a], minIntervalMinutes: 0, maxIntervalMinutes: 0, idleMinutes: 0, maxPerDay: 1, awakeFrom: 0, awakeTo: 24 })
  const sent = []
  const hub = { lastOwnerChatAt: Date.now(), lastBotToOwner: { at: 0, text: '' }, lastPrivateAt: () => 0, pushToSession: async (chat) => sent.push(chat) }
  const speak = createSpeakUp({ getConfig: () => cfg, hub, log, memory: () => ({ dislikes: (qq) => qq === a }) })
  await speak.tick()
  assert.ok(!sent.some((chat) => String(chat.userId) === a), `不该找讨厌的人：${sent.map((c) => c.chatId)}`)
})
