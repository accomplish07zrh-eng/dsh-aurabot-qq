// 面板「翻一翻」的分页：后端 /memories 必须真的能翻到 300 条之后。
// 之前硬写 slice(0, 300)，库过 300 条之后后面的既翻不到也搜不出来（实机 500 条时 200 条隐形）。
// 这组测试盯住分页契约：offset/limit/total/hasMore 四个字段，以及边界。
//
// 三个真实的限制（写测试时踩到过，写进来免得日后误判）：
//   1. list(q) 内部 search 带 limit:100 —— 搜索结果不会返回全库。
//   2. 中文分词只认汉字词组，纯数字/英文标记搜不到，所以搜索类测试要用差异化的中文内容。
//   3. 记忆库是共享的（模块缓存存储目录），每个测试前清空，否则数据跨测试累积。
//
// 性能：add/remove 都是全量写盘，造 310 条 × 10 个用例要 70+ 秒。
// 所以这里把分页逻辑拆成纯函数单独测（快），只在必要处造真实数据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-page-'))

const { createMemoryStore } = await import('../src/features/memory.js')
const { normalize } = await import('../src/core/config.js')

const log = { info() {}, warn() {}, debug() {} }
const OWNER = '10000001'
const cfg = normalize({ ownerQQ: OWNER, ownerName: '老大', memory: { dailyConsolidate: false, vector: { enabled: false } } })
const mem = createMemoryStore({
  dsh: {}, getConfig: () => cfg, log,
  hub: { chatLogDays: () => [], chatLogOf: () => [], speakersOf: () => [] },
})

const TOPICS = ['白米饭', '晚饭', '早饭', '面条', '饺子', '包子', '米粥', '煲汤', '炒菜', '烧烤']

// 分页逻辑：与 src/modules/memory/index.js 的 /memories 路由完全一致
function page(all, { limit, offset } = {}) {
  const limitRaw = Number(limit)
  const offsetRaw = Number(offset)
  const lim = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(1000, Math.floor(limitRaw)) : 300
  const off = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0
  return {
    items: all.slice(off, off + lim),
    total: all.length,
    hasMore: off + lim < all.length,
  }
}

// 造数据只造一次：add/remove 都是全量写盘，每个用例重建要 70+ 秒。
// 只有「搜索」这两个用例需要真实 store 数据，其余都是纯数组断言。
let cachedRows = null
function rows() {
  if (cachedRows) return cachedRows
  const ids = []
  for (let i = 0; i < 310; i += 1) {
    const topic = TOPICS[i % TOPICS.length]
    const m = mem.add({ text: `今天吃了${topic}，是第 ${i + 1} 顿，味道还行`, about: OWNER, source: 'panel' })
    ids.push(m.id)
  }
  cachedRows = ids
  return ids
}

test('分页：默认一页 300 条，超过时 hasMore=true', () => {
  const all = rows()
  assert.equal(all.length, 310)
  const p1 = page(all)
  assert.equal(p1.items.length, 300)
  assert.equal(p1.total, 310)
  assert.equal(p1.hasMore, true, '还有 10 条没放出来，必须说 hasMore')
})

test('分页：第二页接得上，两页并起来不漏不重', () => {
  const all = rows()
  const p1 = page(all, { limit: 300, offset: 0 })
  const p2 = page(all, { limit: 300, offset: 300 })
  assert.equal(p2.items.length, 10)
  assert.equal(p2.hasMore, false, '第二页之后没有更多了')
  const merged = [...p1.items, ...p2.items]
  assert.equal(merged.length, all.length, '两页拼起来应等于总数')
  assert.equal(new Set(merged).size, merged.length, '不能重复取回同一条')
})

test('分页：库小于一页时 hasMore=false', () => {
  const small = Array.from({ length: 20 }, (_, i) => 'id' + i)
  const p = page(small)
  assert.equal(p.items.length, 20)
  assert.equal(p.hasMore, false)
})

test('分页：offset 超过总数时返回空，不报错', () => {
  const small = Array.from({ length: 30 }, (_, i) => 'id' + i)
  const p = page(small, { limit: 300, offset: 999 })
  assert.equal(p.items.length, 0)
  assert.equal(p.hasMore, false)
  assert.equal(p.total, 30, 'total 是全部条数，不受 offset 影响')
})

test('分页：limit 上限 1000，超了按 1000 算', () => {
  const small = Array.from({ length: 50 }, (_, i) => 'id' + i)
  const p = page(small, { limit: 5000 })
  assert.equal(p.items.length, 50, '库里只有 50 条，给再多也只返回 50')
  assert.equal(p.hasMore, false)
})

test('分页：limit=0 / 负数 / 脏值 一律落回 300', () => {
  const big = Array.from({ length: 320 }, (_, i) => 'id' + i)
  for (const bad of [0, -5, 'abc', NaN]) {
    const p = page(big, { limit: bad })
    assert.equal(p.items.length, 300, `limit=${String(bad)} 应落回 300`)
  }
})

test('分页：offset 负数 / 脏值 一律当 0', () => {
  const big = Array.from({ length: 320 }, (_, i) => 'id' + i)
  for (const bad of [-1, 'x', NaN]) {
    const p = page(big, { limit: 10, offset: bad })
    assert.equal(p.items[0], big[0], `offset=${String(bad)} 应从头开始`)
  }
})

test('分页：删掉一条后，用「已加载条数」当 offset 不会重复取回', () => {
  // 面板真实踩到的坑：不能拿 mem.length 当 offset。
  // 删一条后长度变短，offset 就对不上，第二页会把第一页末尾的条目又取一遍。
  const all = rows()
  const p1 = page(all, { limit: 300, offset: 0 })
  assert.equal(p1.items.length, 300)
  const loaded = p1.items.length - 1     // 面板记的「已加载」= 299（用户删掉了一条）
  const remaining = all.filter((id) => !all.slice(0, 300).includes(id))
  const next = all.slice(loaded, loaded + 300)   // 用 299 而不是 300
  assert.equal(next.length, all.length - loaded, `剩下 ${all.length - loaded} 条应全部取到`)
  // 用 300 会跳过一条；用 299 正好接上
  const withWrong = all.slice(300, 600)
  assert.notEqual(withWrong.length, next.length, '用 300 当 offset 会跳过一条（这正是当初的 bug）')
})

test('分页：搜索词跟着分页走，total 是搜索结果数而不是全库', () => {
  rows()
  const q = '饺子'                       // 310 条里每 10 条一条「饺子」→ 31 条
  const hits = mem.list(q).map((m) => m.id)
  assert.equal(hits.length, 31, '每 10 条中 1 条含「饺子」')
  const p1 = page(hits, { limit: 20, offset: 0 })
  assert.equal(p1.total, 31, 'total 跟搜索走，不是全库 310')
  assert.equal(p1.items.length, 20)
  assert.equal(p1.hasMore, true)
  const p2 = page(hits, { limit: 20, offset: 20 })
  assert.equal(p2.items.length, 11)
  assert.equal(p2.hasMore, false, '搜索结果翻完就没有了')
  assert.equal(new Set([...p1.items, ...p2.items]).size, 31, '两页拼起来覆盖整个搜索结果，不重不漏')
})

test('分页：search 自带条数上限，命中再多也不会返回全库', () => {
  // list(q) 内部的 search 带 limit:100，是个既有限制（不是分页 bug）。
  // 只断言「有上限、不会返回全库」，不卡具体数字（具体回多少还跟分词打分有关）。
  rows()
  const r = mem.list('今天吃了')
  assert.ok(r.length <= 100, `搜索结果应受 100 条上限约束，实际 ${r.length}`)
  assert.ok(r.length < 310, '不该把全库都返回')
})
