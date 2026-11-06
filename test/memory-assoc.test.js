// 记忆联想（向量建边 + 限量召回）与记忆加深（行为驱动的档位升档）。
// 全部用假向量和假存储，不调模型、不联网、不碰真实数据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createMemoryStore, buildIndex, search, cleanAssocMap, assocSignature, retention, ASSOC_LIMIT } from '../src/features/memory.js'
import { readMemoryState, writeMemoryState } from './helpers/memory-state.js'

const OWNER = '10000001'
const GUEST = '30000001'
const STRANGER = '30000002'
const DAY = 86400_000
const log = { info() {}, warn() {}, debug() {} }

/**
 * 假向量：按关键词打三个正交方向，好让「同义不同字」和「不相干」都能确定地测出来。
 * 睡/熬夜/焦虑 → [1,0,0]；吃/饭/辣 → [0,1,0]；其余 → [0,0,1]。
 */
const vectorOf = (text) => {
  const t = String(text || '')
  if (/睡|熬夜|失眠|焦虑|考试|累/.test(t)) return [1, 0, 0]
  if (/吃|饭|辣|火锅|食欲/.test(t)) return [0, 1, 0]
  return [0, 0, 1]
}

function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-assoc-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({
    ownerQQ: OWNER,
    ownerName: '主人',
    model: { provider: 'p', model: 'm' },
    memory: { dailyConsolidate: false, keepChatlogDays: -1, vector: { enabled: true, mode: 'local' }, ...options.memory },
  })
  const hub = { chatLogDays: () => [], chatLogOf: () => [], speakersOf: () => [] }
  // 本地向量实现需要 onnx 模型，测试里没有；这里直接给 store 一个忠实的假实现，
  // 接口和 memory-vector-local.js 完全对齐（embed / all / search / validIds / count / sync）。
  const make = () => {
    const mem = createMemoryStore({ dsh: {}, getConfig: () => cfg, hub, log })
    return mem
  }
  const state = () => readMemoryState(dir)
  const seed = (items, extra = {}) => writeMemoryState(dir, { items, ...extra })
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, cfg, hub, make, state, seed }
}

/** 从 hint 里数出实际交付给模型的记忆条数（hint 里是「；」分隔的一串）。 */
function countInHint(hint) {
  const i = hint.indexOf('：')
  if (i < 0) return 0
  const body = hint.slice(i + 1, hint.lastIndexOf('）'))
  return body ? body.split('；').length : 0
}

// ---------- 交付：直接 N 条 + 联想 M 条 ----------

test('直接想起和联想各自限量，最后合起来交给模型（不再是写死的 4 条）', (t) => {
  const s = setup(t, { memory: { assoc: { hops: 1, recall: 3 }, recallCount: 6, recallTotal: 0 } })
  const now = Date.now()
  const mk = (id, text, extra = {}) => ({ id, text, about: OWNER, chatId: `private:${OWNER}`, at: now, saidAt: now, importance: 0.6, ...extra })
  // 4 条直接命中 + 3 条联想
  s.seed([
    mk('d1', '周末计划想看剧'), mk('d2', '周末计划想做饭'), mk('d3', '周末计划想睡觉'), mk('d4', '周末计划想去玩'),
    mk('a1', '最近追了一部剧'), mk('a2', '今天做了红烧肉'), mk('a3', '睡得特别沉'),
  ], { assoc: {
    d1: [['a1', 0.8, 0]], a1: [['d1', 0.8, 0]],
    d2: [['a2', 0.8, 0]], a2: [['d2', 0.8, 0]],
    d3: [['a3', 0.8, 0]], a3: [['d3', 0.8, 0]],
  } })
  const mem = s.make()
  const chat = { kind: 'private', userId: OWNER, chatId: `private:${OWNER}` }
  const hint = mem.recallHint(chat, '周末计划')
  const n = countInHint(hint)
  // 以前写死 slice(0,4)，4 条直接命中就把联想全砍了；现在联想能进来
  assert.ok(n > 4, `应该超过原来的 4 条，实际 ${n} 条`)
  assert.ok(hint.includes('最近追了一部剧') || hint.includes('今天做了红烧肉') || hint.includes('睡得特别沉'), '联想内容真的进去了')
})

test('联想条数 = 0 时，交付只剩直接命中的', (t) => {
  const s = setup(t, { memory: { assoc: { hops: 1, recall: 0 }, recallCount: 6 } })
  const now = Date.now()
  const mk = (id, text, extra = {}) => ({ id, text, about: OWNER, chatId: `private:${OWNER}`, at: now, saidAt: now, importance: 0.6, ...extra })
  s.seed([
    mk('d1', '周末计划想看剧'), mk('d2', '周末计划想做饭'),
    mk('a1', '最近追了一部剧'),
  ], { assoc: { d1: [['a1', 0.8, 0]], a1: [['d1', 0.8, 0]] } })
  const mem = s.make()
  const chat = { kind: 'private', userId: OWNER, chatId: `private:${OWNER}` }
  const hint = mem.recallHint(chat, '周末计划')
  assert.ok(!hint.includes('最近追了一部剧'), 'assoc.recall=0 时联想一条都不该进来')
})

test('直接想起 = 0 时，联想也没有起点，交付为空', (t) => {
  const s = setup(t, { memory: { assoc: { hops: 2, recall: 4 }, recallCount: 0 } })
  const now = Date.now()
  s.seed([
    { id: 'd1', text: '周末计划想看剧', about: OWNER, chatId: `private:${OWNER}`, at: now, saidAt: now, importance: 0.6 },
    { id: 'a1', text: '最近追了一部剧', about: OWNER, chatId: `private:${OWNER}`, at: now, saidAt: now, importance: 0.6 },
  ], { assoc: { d1: [['a1', 0.8, 0]], a1: [['d1', 0.8, 0]] } })
  const mem = s.make()
  const chat = { kind: 'private', userId: OWNER, chatId: `private:${OWNER}` }
  assert.equal(countInHint(mem.recallHint(chat, '周末计划')), 0, '没有直接命中就没有联想起点')
})

test('想起总数上限生效：设成 3 就只交 3 条', (t) => {
  const s = setup(t, { memory: { assoc: { hops: 1, recall: 3 }, recallCount: 6, recallTotal: 3 } })
  const now = Date.now()
  const mk = (id, text) => ({ id, text, about: OWNER, chatId: `private:${OWNER}`, at: now, saidAt: now, importance: 0.6 })
  s.seed([
    mk('d1', '周末计划想看剧'), mk('d2', '周末计划想做饭'), mk('d3', '周末计划想睡觉'), mk('d4', '周末计划想去玩'),
    mk('a1', '最近追了一部剧'),
  ], { assoc: { d1: [['a1', 0.8, 0]], a1: [['d1', 0.8, 0]] } })
  const mem = s.make()
  const chat = { kind: 'private', userId: OWNER, chatId: `private:${OWNER}` }
  const n = countInHint(mem.recallHint(chat, '周末计划'))
  assert.ok(n <= 3, `总数上限 3，实际 ${n} 条`)
})

// ---------- 纯函数：建边规则 ----------

test('cleanAssocMap：双向不一致、失效、自环、重复的边都要清掉', () => {
  const now = Date.now()
  const item = (id, extra = {}) => ({ id, text: id, at: now, saidAt: now, ...extra })
  const items = [
    item('a'), item('b'), item('gone', { invalidAt: now }), item('one-way'),
  ]
  const map = {
    a: [['b', 0.8], ['gone', 0.7], ['a', 0.5], ['b', 0.6]],
    b: [['a', 0.8]],
    gone: [['a', 0.7]],
    'one-way': [['a', 0.9]],
  }
  const out = cleanAssocMap(map, items)
  // a 只留对端也承认的 b；重复项去重后保留权重高的那条；自环 a→a 和失效的 gone 都清掉。
  // 第三条是走边计数（这里没有走过，所以是 0）。
  assert.deepEqual(out.a, [['b', 0.8, 0]])
  assert.deepEqual(out.b, [['a', 0.8, 0]])
  assert.equal(out.gone, undefined, '失效条目整条丢掉')
  assert.equal(out['one-way'], undefined, '单向边必须丢掉')
})

test('cleanAssocMap：按权重排序并截到度上限', () => {
  const now = Date.now()
  const many = Array.from({ length: ASSOC_LIMIT + 3 }, (_, i) => ({ id: `n${i}`, text: `n${i}`, at: now, saidAt: now }))
  const map = { h: many.map((m, i) => [m.id, 0.5 + i * 0.01]) }
  for (const m of many) map[m.id] = [['h', 0.5]]
  const out = cleanAssocMap(map, [{ id: 'h', text: 'h', at: now, saidAt: now }, ...many], ASSOC_LIMIT)
  assert.equal(out.h.length, ASSOC_LIMIT)
  // 截断要留最像的（权重最高的那些）
  const kept = out.h.map((e) => e[0]).sort()
  const expected = many.slice(-ASSOC_LIMIT).map((m) => m.id).sort()
  assert.deepEqual(kept, expected)
})

// ---------- 召回：限量带联想 ----------

test('联想召回受总条数上限约束，且分数不超过起点', () => {
  const now = Date.now() - 1000
  const item = (id, text, extra = {}) => ({ id, text, chatId: `private:${GUEST}`, about: GUEST, at: now, saidAt: now, importance: 0.6, ...extra })
  const items = [
    item('seed', '现在睡不好', { importance: 0.9 }),
    ...['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => item(id, `联想条目${i}`)),
  ]
  // seed 直连 a~f，就是一张 1 跳的星形图
  const assocMap = { seed: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => [id, 0.8]), ...Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => [id, [['seed', 0.8]]])) }
  const idx = buildIndex(items)
  // 只配 1 跳时，第 1 跳就是最后一跳，应该拿走全部余额 3 条
  const hits = search(idx, '现在睡不好', { limit: 3, ownerScope: true, now, assocMap, assocHops: 1 })
  const assoc = hits.filter((h) => h.why.some((w) => w.startsWith('（联想')))
  assert.equal(assoc.length, 3, '只配 1 跳时全部余额都给第 1 跳')
  const seedHit = hits.find((h) => h.it.id === 'seed')
  for (const h of assoc) assert.ok(h.score < seedHit.score, '联想分不能超过起点')
  // 自己配小一点也生效
  const two = search(idx, '现在睡不好', { limit: 3, ownerScope: true, now, assocMap, assocHops: 1, assocLimit: 2 })
  assert.equal(two.filter((h) => h.why.some((w) => w.startsWith('（联想'))).length, 2, 'assocLimit 生效')
  // 关掉时一条都不带
  const none = search(idx, '现在睡不好', { limit: 3, ownerScope: true, now, assoc: false, assocMap })
  assert.equal(none.filter((h) => h.why.some((w) => w.startsWith('（联想'))).length, 0)
  // recall 配成 0 时也不带
  const zero = search(idx, '现在睡不好', { limit: 3, ownerScope: true, now, assocLimit: 0, assocMap })
  assert.equal(zero.filter((h) => h.why.some((w) => w.startsWith('（联想'))).length, 0)
})

test('多跳：A→B→C 能走通，但跳数、总量、成环三重封顶', () => {
  const now = Date.now() - 1000
  const mk = (id, text) => ({ id, text, chatId: `private:${GUEST}`, about: GUEST, at: now, saidAt: now, importance: 0.6 })
  // A→B→C→D→E 一条链
  const items = [mk('A', '甲的睡不好'), mk('B', '乙的熬夜'), mk('C', '丙的考试'), mk('D', '丁的加班'), mk('E', '戊的咖啡')]
  const assocMap = { A: [['B', 0.9]], B: [['A', 0.9], ['C', 0.9]], C: [['B', 0.9], ['D', 0.9]], D: [['C', 0.9], ['E', 0.9]], E: [['D', 0.9]] }
  const idx = buildIndex(items)
  const ids = (o) => search(idx, '甲的睡不好', { limit: 3, ownerScope: true, now, assocMap, assocLimit: 5, ...o }).map((h) => h.it.id)
  // 0 跳 = 只建边不联想
  assert.deepEqual(ids({ assocHops: 0 }), ['A'])
  // 1 跳 = 只有 B
  assert.deepEqual(ids({ assocHops: 1 }), ['A', 'B'])
  // 2 跳 = B 和 C（默认）
  assert.deepEqual(ids({ assocHops: 2 }), ['A', 'B', 'C'])
  // 3 跳也只能到 D，不能一路走到底
  const three = ids({ assocHops: 3 })
  assert.ok(three.includes('D'))
  assert.ok(!three.includes('E'), '跳数封顶后不能再往外走')
  // 跳数再大也被夹在 ASSOC_HOPS 以内
  assert.deepEqual(ids({ assocHops: 99 }), three, '跳数上限不能被配置突破')
  // 绝不成环：任何情况下起点只出现一次
  for (const h of [0, 1, 2, 3, 99]) {
    const got = ids({ assocHops: h })
    assert.equal(new Set(got).size, got.length, `hop=${h} 不能有重复条目`)
  }
})

test('多跳分数按跳数打折，越远越低', () => {
  const now = Date.now() - 1000
  const mk = (id, text) => ({ id, text, chatId: `private:${GUEST}`, about: GUEST, at: now, saidAt: now, importance: 0.6 })
  const items = [mk('A', '甲的睡不好'), mk('B', '乙的熬夜'), mk('C', '丙的考试')]
  const assocMap = { A: [['B', 0.9]], B: [['A', 0.9], ['C', 0.9]], C: [['B', 0.9]] }
  const idx = buildIndex(items)
  const hits = search(idx, '甲的睡不好', { limit: 1, ownerScope: true, now, assocMap, assocHops: 2, assocLimit: 5 })
  const scoreOf = (id) => hits.find((h) => h.it.id === id)?.score
  assert.ok(scoreOf('B') > scoreOf('C'), '第 2 跳必须比第 1 跳低')
  assert.ok(scoreOf('C') < scoreOf('A'), '联想分永远低于起点')
  // 标签能区分第几跳
  assert.ok(hits.find((h) => h.it.id === 'B').why.some((w) => w.includes('联想')))
  assert.ok(hits.find((h) => h.it.id === 'C').why.some((w) => w.includes('2 跳')))
})

test('稠密图 + 最大跳数也不会失控（总量严格受上限约束）', () => {
  const now = Date.now() - 1000
  // 40 条全互连，每对都有边
  const items = Array.from({ length: 40 }, (_, i) => ({ id: `d${i}`, text: `第 ${i} 条跟别的都像`, chatId: `private:${GUEST}`, about: GUEST, at: now, saidAt: now, importance: 0.6 }))
  const assocMap = {}
  for (let i = 0; i < 40; i++) {
    assocMap[`d${i}`] = []
    for (let j = 0; j < 40; j++) if (i !== j) assocMap[`d${i}`].push([`d${j}`, 0.8, 0])
  }
  const idx = buildIndex(items)
  const hits = search(idx, '第 0 条跟别的都像', { limit: 3, ownerScope: true, now, assocMap, assocHops: 3, assocLimit: 5 })
  // limit 3 + 联想 5 = 上限 8，绝不能因为图稠密就多带
  assert.ok(hits.length <= 8, `总量必须封顶，实际 ${hits.length}`)
  assert.equal(new Set(hits.map((h) => h.it.id)).size, hits.length, '不能有重复条目')
})

test('联想不能绕过可见性：群友私事不会被带进别人的私聊', () => {
  const now = Date.now() - 1000
  const item = (id, text, extra = {}) => ({ id, text, at: now, saidAt: now, importance: 0.6, ...extra })
  const items = [
    item('seed', '现在睡不好', { chatId: `private:${GUEST}`, about: GUEST }),
    item('leak', '另一个人的私事', { chatId: `private:${STRANGER}`, about: STRANGER }),
    item('fine', '同一段聊天里聊的', { chatId: `private:${GUEST}`, about: GUEST }),
  ]
  const assocMap = {
    seed: [['leak', 0.9], ['fine', 0.9]],
    leak: [['seed', 0.9]],
    fine: [['seed', 0.9]],
  }
  const idx = buildIndex(items)
  const hits = search(idx, '现在睡不好', {
    limit: 3, where: `private:${GUEST}`, about: GUEST, onlyAbout: [GUEST],
    requireAbout: true, ownerScope: false, scopeChatId: `private:${GUEST}`, now, assocMap,
  })
  const ids = hits.map((h) => h.it.id)
  assert.ok(ids.includes('fine'), '同聊天的联想可以带出来')
  assert.ok(!ids.includes('leak'), '跨聊天的联想不能带出来')
})

test('删除或忘掉后，联想边跟着清干净', (t) => {
  const s = setup(t)
  const now = Date.now()
  s.seed([
    { id: 'a', text: '最近老是睡不好', about: GUEST, chatId: `private:${GUEST}`, at: now, saidAt: now },
    { id: 'b', text: '总在熬夜刷手机', about: GUEST, chatId: `private:${GUEST}`, at: now, saidAt: now },
  ], { assoc: { a: [['b', 0.8, 0]], b: [['a', 0.8, 0]] } })
  const mem = s.make()
  assert.equal(mem.list('').find((m) => m.id === 'a').assocItems.length, 1)
  mem.remove('b')
  const final = s.make().list('').find((m) => m.id === 'a')
  assert.deepEqual(final.assocItems, [], '对端删掉后，这边也要清掉')
  assert.equal(s.state().assoc.b, undefined, '被删条目的边整条清掉')
})

// ---------- 升档：行为驱动 ----------

test('升档参数：默认值可归一化，关掉之后 importance 不动', (t) => {
  const m = normalize({}).memory.tierGrow
  assert.equal(m.enabled, true)
  assert.equal(m.perDay, 0.02)
  assert.equal(m.minHitDays, 3)
  assert.equal(m.cap, 0.85)
  assert.deepEqual([m.tier2.hitDays, m.tier2.imp], [5, 0.6])
  assert.deepEqual([m.tier3.hitDays, m.tier3.imp], [10, 0.75])
  const bad = normalize({ memory: { tierGrow: { perDay: 99, cap: 5, minHitDays: -3 } } }).memory.tierGrow
  assert.equal(bad.perDay, 0.2, 'perDay 上限 0.2')
  assert.equal(bad.cap, 1)
  assert.equal(bad.minHitDays, 0)
})

test('被反复想起：importance 按天涨、封顶 0.85，够门槛升档；tier 0 永不升', (t) => {
  const s = setup(t)
  const mem = s.make()
  const now = Date.now()
  // 一条 12 天前记下、已经被想起 12 天的琐碎事实：0.6 + 0.02*12 = 0.84，够 0.75 的「重要」门槛
  s.seed([{
    id: 'p', text: '主人很在意考试的事', about: OWNER, chatId: `private:${OWNER}`,
    tier: 1, importance: 0.6, hitDays: 12, hits: 20, at: now - 12 * DAY, saidAt: now - 12 * DAY, tierSince: now - 12 * DAY,
  }, {
    id: 'p0', text: '永久档的事实', about: OWNER, chatId: `private:${OWNER}`,
    tier: 0, importance: 0.5, hitDays: 30, at: now - 30 * DAY, saidAt: now - 30 * DAY, tierSince: now - 30 * DAY,
  }])
  // touch 只在 recall 里发生；这里用 recall 把它真正想起来
  assert.ok(mem.recall('考试', { where: `private:${OWNER}`, about: OWNER, limit: 5, shown: true }).length > 0)
  const p = s.state().items.find((x) => x.id === 'p')
  assert.ok(p.importance > 0.6, 'importance 要涨')
  assert.ok(p.importance <= 0.85, '不能超过 cap')
  assert.ok(Math.abs(p.importance - 0.84) < 1e-6, '按 0.02/天 × 12 天涨')
  assert.ok(p.tierSince > now - 12 * DAY, 'tierSince 要往前推，不能每次重算')
  assert.equal(p.tier, 3, '12 天 >= 10 且 >= 0.75 应该升到重要档')
  const p0 = s.state().items.find((x) => x.id === 'p0')
  assert.equal(p0.tier, 0, '永久档不升')
})

test('没凑够想起天数时不涨 importance：偶然想起一次不该变重要', (t) => {
  const s = setup(t)
  const mem = s.make()
  const now = Date.now()
  s.seed([{ id: 'q', text: '偶尔提过一次的琐事', about: OWNER, chatId: `private:${OWNER}`, tier: 1, importance: 0.4, hitDays: 1, at: now - 30 * DAY, saidAt: now - 30 * DAY }])
  mem.recall('琐事', { where: `private:${OWNER}`, about: OWNER, limit: 5, shown: true })
  const q = s.state().items.find((x) => x.id === 'q')
  assert.equal(q.importance, 0.4, 'hitDays 不够，importance 不该涨')
  assert.equal(q.tier, 1, '档位也不该升')
})

test('老记忆第一次进入可增长状态时不能一次涨到顶（不能拿 at 当起点）', (t) => {
  const s = setup(t)
  const mem = s.make()
  const now = Date.now()
  // 3 个月前记下、已经被想起 10 天的老记忆，没有 tierSince
  s.seed([{ id: 'ancient', text: '很久以前记下的琐碎事', about: OWNER, chatId: `private:${OWNER}`, tier: 1, importance: 0.3, hitDays: 10, at: now - 90 * DAY, saidAt: now - 90 * DAY }])
  mem.recall('琐碎事', { where: `private:${OWNER}`, about: OWNER, limit: 5, shown: true })
  const m = s.state().items.find((x) => x.id === 'ancient')
  assert.equal(m.importance, 0.3, '第一次只记下起点，不能按 90 天一次涨满')
  assert.ok(m.tierSince > now - 60_000, 'tierSince 必须钉在现在，不能是 at')
})

test('surfaced 的联想条目只算命中、不单独升档，但边权要按次数慢慢涨', (t) => {
  const s = setup(t)
  const now = Date.now()
  s.seed([
    { id: 'base', text: '最近老是睡不好', about: OWNER, chatId: `private:${OWNER}`, tier: 1, importance: 0.5, at: now, saidAt: now },
    { id: 'link', text: '连着熬夜好几天了', about: OWNER, chatId: `private:${OWNER}`, tier: 1, importance: 0.5, at: now, saidAt: now },
  ], { assoc: { base: [['link', 0.6, 4]], link: [['base', 0.6, 4]] } })
  const mem = s.make()
  mem.recall('睡不好', { where: `private:${OWNER}`, about: OWNER, limit: 5, shown: true })
  const st = s.state()
  assert.equal(st.items.find((x) => x.id === 'link').tier, 1, '联想带出来的那条不升档')
  // 走过第 5 次边，权重 +0.01；两边都要涨，不然会被当成单向引用清掉
  for (const side of ['base', 'link']) {
    const edge = st.assoc[side].find((e) => e[0] === (side === 'base' ? 'link' : 'base'))
    assert.equal(edge[2], 5, '走边计数 +1')
    assert.ok(Math.abs(edge[1] - 0.61) < 1e-6, '每次只涨 0.01')
  }
})

test('联想边不会让 importance 全体普涨（限量的意义）', (t) => {
  const s = setup(t)
  // 10 条互相相似、都连到 seed 的记忆，一次召回只许带 2 条联想
  const now = Date.now()
  const items = [{ id: 'seed', text: '最近老是睡不好', about: OWNER, chatId: `private:${OWNER}`, tier: 1, importance: 0.5, hitDays: 10, at: now, saidAt: now }]
  const assoc = { seed: [] }
  for (let i = 0; i < 10; i++) {
    items.push({ id: `m${i}`, text: `相似的琐事${i}`, about: OWNER, chatId: `private:${OWNER}`, tier: 1, importance: 0.5, hitDays: 0, at: now, saidAt: now })
    assoc.seed.push([`m${i}`, 0.7])
    assoc[`m${i}`] = [['seed', 0.7]]
  }
  s.seed(items, { assoc })
  const mem = s.make()
  mem.recall('睡不好', { where: `private:${OWNER}`, about: OWNER, limit: 20, shown: true })
  const st = s.state()
  const bumped = st.items.filter((x) => x.id !== 'seed' && x.importance !== 0.5)
  assert.equal(bumped.length, 0, '联想带出来的条目 importance 不许普涨')
})

test('建边签名必须带上「哪些条目已有向量」，否则分批同步时新条目永远建不了边', () => {
  const items = [{ id: 'a', text: '甲的文本' }, { id: 'b', text: '乙的文本' }, { id: 'c', text: '丙的文本' }]
  // 向量分批补：先只有 a、b 有向量，后来 c 也算好了。文字没变，但签名**必须**变，
  // 否则 buildAssoc 看到签名相同就直接 skipped，c 永远连不上边。
  const partial = assocSignature(items, ['a', 'b'])
  const full = assocSignature(items, ['a', 'b', 'c'])
  assert.notEqual(partial, full, '向量覆盖度变了，签名就要变')
  // 顺序不影响签名（Set/Map 的迭代顺序不该改变结论）
  assert.equal(assocSignature(items, ['b', 'a']), assocSignature(items, ['a', 'b']))
  // 文字改了（哪怕长度不变）签名也要变
  const edited = [{ id: 'a', text: '乙的文本' }, { id: 'b', text: '乙的文本' }, { id: 'c', text: '丙的文本' }]
  assert.notEqual(assocSignature(items, ['a', 'b', 'c']), assocSignature(edited, ['a', 'b', 'c']), '改字必须重建边')
})

test('touch 走 storage.save 也必须清理联想边（不能把指向失效记忆的脏边写回）', (t) => {
  const s = setup(t)
  const now = Date.now()
  s.seed([
    { id: 'a', text: '甲的文本内容', about: OWNER, chatId: `private:${OWNER}`, at: now, saidAt: now, importance: 0.5, hitDays: 4, tier: 1 },
    { id: 'b', text: '乙的文本内容', about: OWNER, chatId: `private:${OWNER}`, at: now, saidAt: now, importance: 0.5, invalidAt: now },
  ], { assoc: { a: [['b', 0.8, 3]], b: [['a', 0.8, 3]] } })
  const mem = s.make()
  // 命中 a 会走 touch() —— 它为了省事直接 storage.save，跳过 save() 里的 cleanAssocMap。
  // 不在这里再清一遍，指向已失效 b 的边就会一直存着。
  assert.ok(mem.recall('甲的文本内容', { where: `private:${OWNER}`, about: OWNER, limit: 5, shown: true }).length > 0)
  const st = s.state()
  assert.equal(st.items.find((m) => m.id === 'a').hitDays, 5, 'touch 确实跑了')
  assert.deepEqual(st.assoc, {}, '指向失效条目的边必须被清掉')
})

test('无档位的普通记忆也能升档（新用户默认就是无档位，否则加深功能等于没有）', (t) => {
  const s = setup(t)
  const now = Date.now()
  // add() 默认不设 tier，新用户的记忆全是 undefined —— 这是合法状态，必须能升档
  s.seed([{ id: 'plain', text: '主人最近老是睡不好', about: OWNER, chatId: `private:${OWNER}`, at: now - 6 * DAY, saidAt: now - 6 * DAY, importance: 0.62, hitDays: 5, tierSince: now - 2 * DAY }])
  const mem = s.make()
  mem.recall('最近老是睡不好', { where: `private:${OWNER}`, about: OWNER, limit: 5, shown: true })
  const m = s.state().items[0]
  assert.equal(m.tier, 2, '无档位记忆够门槛就该升到 2（以前被 return 掉，新用户永远升不了）')
})

test('档位只有 0~3 才参与升档：core 长期印象、无档位旧记忆都不许被凭空改档', (t) => {
  const s = setup(t)
  const now = Date.now()
  const common = { about: OWNER, chatId: `private:${OWNER}`, at: now, saidAt: now, hitDays: 20 }
  s.seed([
    { ...common, id: 'core1', text: '长期印象：主人很顾家', importance: 0.85, tier: 'core', source: 'abstract' },
    { ...common, id: 't0', text: '永久档事实', importance: 0.9, tier: 0 },
    { ...common, id: 'none', text: '没有档位的旧记忆', importance: 0.8 },
  ])
  const mem = s.make()
  mem.recall('顾家 永久 旧记忆', { where: `private:${OWNER}`, about: OWNER, limit: 8, shown: true })
  const st = s.state()
  const byId = (id) => st.items.find((x) => x.id === id)
  // 'core' 是压缩产物。以前 Number.isInteger('core') === false 会被当成 -1，
  // 于是被升成 tier:3，compressionClusters 里 `m.tier === 'core'` 的排除就失效了。
  assert.equal(byId('core1').tier, 'core', '长期印象不能被升档改掉')
  assert.equal(byId('t0').tier, 0, '永久档不升不降')
  // 无档位是合法的「未分档」状态，够门槛会正常升档（见上一个测试）。
  // hitDays=20 且 imp=0.8 同时满足 tier3 门槛（10天/0.75），所以直接升到 3。
  assert.equal(byId('none').tier, 3, '无档位记忆够门槛就升到最高档，不是被乱改')
})

test('cap 配成 0 时真的不许自动涨（0 不能被 || 当成没配）', (t) => {
  const s = setup(t, { memory: { tierGrow: { cap: 0 } } })
  const now = Date.now()
  s.seed([{ id: 'z', text: '会涨的记忆', about: OWNER, chatId: `private:${OWNER}`, at: now, saidAt: now, importance: 0.7, hitDays: 10, tier: 1, tierSince: now - 20 * DAY }])
  const mem = s.make()
  mem.recall('记忆', { where: `private:${OWNER}`, about: OWNER, limit: 5, shown: true })
  assert.equal(s.state().items[0].importance, 0, 'cap=0 就该停在 0，不能被默认值 0.85 顶替')
})

test('建边开关和阈值都能从配置读到', (t) => {
  const s = setup(t)
  const m = normalize({ memory: { assoc: { enabled: false, minSim: 0.9, limit: 2, recall: 0 } } }).memory.assoc
  assert.equal(m.enabled, false)
  assert.equal(m.minSim, 0.9)
  assert.equal(m.limit, 2)
  assert.equal(m.recall, 0)
  const clamp = normalize({ memory: { assoc: { minSim: 0.1, limit: 99, recall: 9, hops: 99, hopDecay: 0 } } }).memory.assoc
  assert.equal(clamp.minSim, 0.3)
  assert.equal(clamp.limit, 8)
  assert.equal(clamp.recall, 5)
  assert.equal(clamp.hops, 3, '跳数封顶 3，再多就是套娃')
  assert.equal(clamp.hopDecay, 0.1)
})

test('联想也算加深：被联想带出的记忆会涨 hitDays，但一天最多折算一天', (t) => {
  const s = setup(t, { memory: { assoc: { hops: 1, recall: 3 } } })
  const now = Date.now()
  s.seed([
    { id: 'base', text: '最近老是睡不好', about: OWNER, chatId: `private:${OWNER}`, at: now, saidAt: now, tier: 1, importance: 0.55, hitDays: 6 },
    { id: 'link', text: '连着熬夜好几天', about: OWNER, chatId: `private:${OWNER}`, at: now, saidAt: now, tier: 1, importance: 0.55, hitDays: 4 },
  ], { assoc: { base: [['link', 0.8, 0]], link: [['base', 0.8, 0]] } })
  const mem = s.make()
  // assocPerHitDay 默认 2：联想两次才折算「想起来一天」
  mem.recall('最近老是睡不好', { where: `private:${OWNER}`, about: OWNER, limit: 3, shown: true })
  assert.equal(s.state().items.find((m) => m.id === 'link').hitDays, 4, '联想 1 次还不够折算一天')
  mem.recall('最近老是睡不好', { where: `private:${OWNER}`, about: OWNER, limit: 3, shown: true })
  assert.equal(s.state().items.find((m) => m.id === 'link').hitDays, 5, '联想 2 次折算 1 天')
  // 同一天再联想 100 次也只能折算这一次
  for (let i = 0; i < 100; i++) mem.recall('最近老是睡不好', { where: `private:${OWNER}`, about: OWNER, limit: 3, shown: true })
  const st = s.state()
  const link = st.items.find((m) => m.id === 'link')
  assert.equal(link.hitDays, 5, '同一天最多折算一天，不能暴涨')
  assert.ok(link.assocSeen <= 2, 'assocSeen 必须封顶，不能无限累积')
})

test('旧模块残留的 assocHits 不能被当成「已攒次数」，否则白捡一天', (t) => {
  const s = setup(t, { memory: { assoc: { hops: 1, recall: 3 } } })
  const now = Date.now()
  // 旧模块 memory-constellation 留下的形状：assocHits=1 + assocDay + assocLast
  s.seed([
    { id: 'base', text: '最近老是睡不好', about: OWNER, chatId: `private:${OWNER}`, at: now, saidAt: now, tier: 1, importance: 0.6, hitDays: 6 },
    { id: 'link', text: '连着熬夜好几天', about: OWNER, chatId: `private:${OWNER}`, at: now, saidAt: now, tier: 1, importance: 0.6, hitDays: 4,
      assocHits: 1, assocDay: new Date(now - 3 * DAY).toDateString(), assocLast: now - 3 * DAY },
  ], { assoc: { base: [['link', 0.8, 0]], link: [['base', 0.8, 0]] } })
  const mem = s.make()
  // 读新字段 assocSeen（从 0 起算），不该拿旧的 assocHits=1 当「已攒 1 次」
  mem.recall('最近老是睡不好', { where: `private:${OWNER}`, about: OWNER, limit: 3, shown: true })
  const link = s.state().items.find((m) => m.id === 'link')
  assert.equal(link.hitDays, 4, '联想 1 次不该直接折算一天（旧 assocHits 必须忽略）')
  assert.equal(link.assocSeen, 1, '用新字段从 1 开始累计')
  assert.equal(link.assocHits, 1, '旧字段原样保留，不覆盖不参与计算')
})

test('联想加深能真的升档：被联想够多够久，档位会往上走', (t) => {
  const s = setup(t, { memory: { assoc: { hops: 1, recall: 3 }, tierGrow: { assocPerHitDay: 1 } } })
  const now = Date.now()
  s.seed([
    { id: 'base', text: '最近老是睡不好', about: OWNER, chatId: `private:${OWNER}`, at: now, saidAt: now, tier: 1, importance: 0.6, hitDays: 12 },
    // 已经攒了 4 天、importance 0.62：再被联想折算一天就够 5 天 → 升 tier2
    { id: 'link', text: '连着熬夜好几天', about: OWNER, chatId: `private:${OWNER}`, at: now, saidAt: now, tier: 1, importance: 0.62, hitDays: 4, tierSince: now - 30 * DAY },
  ], { assoc: { base: [['link', 0.8, 0]], link: [['base', 0.8, 0]] } })
  const mem = s.make()
  mem.recall('最近老是睡不好', { where: `private:${OWNER}`, about: OWNER, limit: 3, shown: true })
  const link = s.state().items.find((m) => m.id === 'link')
  assert.equal(link.hitDays, 5, '联想折算了一天')
  assert.equal(link.tier, 2, '联想带出来的记忆也能升档')
})
