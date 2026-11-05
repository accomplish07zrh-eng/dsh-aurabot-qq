// 记忆回归集：中文场景下该想起什么、该不该合并、时间对不对。改检索或提炼前先看这里掉没掉。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildIndex, conflicting, memoryLine, parseFacts, parseSaidAt, sameFact, search } from '../src/features/memory.js'

const NOW = new Date(2026, 10, 1, 12, 0).getTime()
const DAY = 86400_000
const facts = [
  ['move', '1', '小明搬到上海浦东了'],
  ['job', '1', '小明换了工作，现在做产品经理'],
  ['cat', '1', '小明养了一只橘猫叫年糕'],
  ['spicy', '1', '小明不吃辣'],
  ['nick', '1', '小明让大家叫他鱼鱼'],
  ['birthday', '1', '小明的生日是 3 月 8 日'],
  ['promise', '1', '小明约好周六一起看电影'],
  ['hua-job', '2', '阿花在杭州当护士'],
  ['hua-cat', '2', '阿花对猫毛过敏'],
  ['hua-game', '2', '阿花最近在玩原神'],
  ['qiang', '3', '阿强喜欢钓鱼'],
  ['exam', '3', '阿强十二月考研'],
].map(([id, about, text]) => ({ id, about, text, importance: 0.6, at: NOW - DAY }))
const idx = buildIndex(facts)
const ids = (q, o = {}) => search(idx, q, { now: NOW, limit: 4, ...o }).map((h) => h.it.id)

for (const [q, want] of [
  ['小明现在住哪，搬到哪了', 'move'],
  ['你还记得年糕吗', 'cat'],
  ['橘猫最近怎么样', 'cat'],
  ['他吃辣吗', 'spicy'],
  ['鱼鱼今天来了吗', 'nick'],
  ['他生日是哪天', 'birthday'],
  ['周六看电影别忘了', 'promise'],
  ['产品经理是不是很累', 'job'],
  ['杭州的护士工作忙吗', 'hua-job'],
  ['猫毛好烦', 'hua-cat'],
  ['原神新版本好玩吗', 'hua-game'],
  ['周末去钓鱼吗', 'qiang'],
  ['考研复习得如何', 'exam'],
]) test(`想得起来：${q}`, () => assert.ok(ids(q).includes(want), ids(q).join()))

test('无关的话什么也想不起来，「关于这个人」不能单独入选', () => {
  assert.deepEqual(ids('今天天气不错哦', { about: '1' }), [])
  assert.deepEqual(ids('嗯嗯', { about: '1' }), [])
})
test('群聊张冠李戴：只许想起这段说话的人', () => {
  assert.deepEqual(ids('猫', { onlyAbout: ['1'], requireAbout: true }).filter((id) => id.startsWith('hua')), [])
  assert.ok(ids('猫毛', { onlyAbout: ['2'], requireAbout: true }).includes('hua-cat'))
})
test('过时的记忆想不起来', () => {
  const old = buildIndex([{ id: 'old', text: '小明住在北京', about: '1', at: NOW, invalidAt: NOW }])
  assert.deepEqual(search(old, '小明住在哪里', { now: NOW }), [])
})

// 语义联想（宠物 / 辣 / 医院）见 memory-vector.test.js；这里只保留纯关键词基线。

for (const [a, b] of [
  ['小明喜欢吃辣的东西和火锅', '小明不喜欢吃辣的东西和火锅'],
  ['小明住在北京朝阳区的老小区', '小明住在上海朝阳区的老小区'],
  ['小明每个月工资有 8000 块钱', '小明每个月工资有 12000 块钱'],
  ['小明周六在公司楼下等阿花', '小明周日在公司楼下等阿花'],
]) test(`不是一回事，不能合并：${b}`, () => assert.equal(sameFact(a, b), false))

for (const [a, b] of [
  ['小明喜欢吃辣的东西', '小明喜欢吃辣的东西和火锅'],
  ['小明养了一只橘猫叫年糕', '小明养了一只橘猫叫年糕。'],
]) test(`补充说法还是同一条：${b}`, () => assert.equal(sameFact(a, b), true))

test('判冲突：否定和数字', () => {
  assert.equal(conflicting('他吃辣', '他不吃辣'), true)
  assert.equal(conflicting('3 月 8 日', '4 月 8 日'), true)
  assert.equal(conflicting('他吃辣', '他吃辣的'), false)
})

test('时间：抄模型写的时间，对不上就用这批最后一句', () => {
  const first = new Date(2026, 9, 31, 20, 0).getTime()
  const last = new Date(2026, 9, 31, 22, 0).getTime()
  assert.equal(parseSaidAt('10-31 21:15', first, last), new Date(2026, 9, 31, 21, 15).getTime())
  assert.equal(parseSaidAt('01-02 21:15', first, last), last)
  assert.equal(parseSaidAt('', first, last), last)
  assert.equal(parseSaidAt('10-31 21:15', 0, 0), 0)
})
test('时间：跨年批次算到去年', () => {
  const first = new Date(2026, 11, 31, 23, 0).getTime()
  const last = new Date(2027, 0, 1, 0, 30).getTime()
  assert.equal(parseSaidAt('12-31 23:30', first, last), new Date(2026, 11, 31, 23, 30).getTime())
})
test('时间：显示说话的时间，不是整理的时间', () => {
  const m = { text: '小明搬家了', at: NOW, saidAt: NOW - 3 * DAY }
  assert.match(memoryLine(m, NOW), /^\[3 天前\]/)
  assert.match(memoryLine({ text: '老记忆', at: NOW }, NOW), /^\[今天\]/)
})

test('解析提炼结果：坏 JSON 能修的修，修不了返回 null', () => {
  assert.deepEqual(parseFacts('[]'), [])
  assert.deepEqual(parseFacts('好的：\n```json\n[{"text":"a"}]\n```'), [{ text: 'a' }])
  assert.deepEqual(parseFacts('[{"text":"a"},{"text":"b"},]'), [{ text: 'a' }, { text: 'b' }])
  assert.deepEqual(parseFacts('[{"text":"a"},{"text":"b'), [{ text: 'a' }])
  assert.equal(parseFacts('[{"text": a b}]'), null)
  assert.equal(parseFacts('没有值得记的'), null)
})
