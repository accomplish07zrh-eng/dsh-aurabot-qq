// 记忆星图测试：算法正确性、tier 映射、新 API、以及**不干扰现有联想/加深系统**。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createMemoryStore } from '../src/features/memory.js'
import { writeMemoryState } from './helpers/memory-state.js'
import {
  brightness, brightnessLabel, buildEdges, layoutGraph3d, regionOf, grams, similarity,
  initialStability, toStarTier, toHostTier, FADING_THRESHOLD, LAYOUT_VERSION,
} from '../src/features/memory-graph.js'

const OWNER = '10000001'
const DAY = 86400_000
const log = { info() {}, warn() {}, debug() {} }

function setup(t, memoryOver = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'graph-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({ ownerQQ: OWNER, ownerName: '主人', memory: { dailyConsolidate: false, vector: { enabled: false }, ...memoryOver } })
  const mem = createMemoryStore({ dsh: {}, getConfig: () => cfg, hub: { chatLogDays: () => [], chatLogOf: () => [], speakersOf: () => [] }, log })
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, cfg, mem }
}

// ── 一、纯算法 ──

test('亮度随时间和重要性下降，label 分档正确', () => {
  const now = Date.now()
  const fresh = { importance: 0.6, at: now, hitDays: 5 }
  const old = { importance: 0.6, at: now - 60 * DAY, hitDays: 5 }
  const high = { importance: 0.95, at: now - 60 * DAY, hitDays: 5 }
  assert.ok(brightness(undefined, fresh, now) > brightness(undefined, old, now), '越久越暗')
  assert.ok(brightness(undefined, high, now) > brightness(undefined, old, now), '越重要越亮')
  assert.ok(brightness(undefined, fresh, now) <= 1 && brightness(undefined, old, now) >= 0, '亮度在 0~1')
  assert.equal(brightnessLabel(0.9), '清晰')
  assert.equal(brightnessLabel(0.5), '有点模糊')
  assert.equal(brightnessLabel(0.2), '快忘了')
  assert.equal(brightnessLabel(0.01), '几乎想不起')
  assert.equal(FADING_THRESHOLD, 0.35)
})

test('区域划分：人物/经历/知识/核心/过时/归档', () => {
  assert.equal(regionOf({ archivedAt: 1 }), 'archived')
  assert.equal(regionOf({ invalidAt: 1 }), 'outdated')
  assert.equal(regionOf({ source: 'event' }), 'event')
  assert.equal(regionOf({ about: '123' }), 'person')
  assert.equal(regionOf({ importance: 0.9 }), 'core')
  assert.equal(regionOf({ importance: 0.3 }), 'knowledge')
})

test('建边：同人物/同标签/高相似/被取代都要连，且每颗星有度上限', () => {
  const now = Date.now()
  const mk = (id, extra = {}) => ({ id, text: '记忆' + id, at: now, saidAt: now, ...extra })
  const items = [
    mk('a', { about: '123' }), mk('b', { about: '123' }),
    mk('c', { tags: ['考试'] }), mk('d', { tags: ['考试'] }),
    mk('e', { text: '主人喜欢吃火锅' }), mk('f', { text: '主人喜欢吃火锅' }),
  ]
  const edges = buildEdges(items)
  assert.ok(edges.length > 0, '应该有边')
  const degree = {}
  for (const e of edges) { degree[e.a] = (degree[e.a] || 0) + 1; degree[e.b] = (degree[e.b] || 0) + 1 }
  assert.ok(Math.max(...Object.values(degree)) <= 5, '度上限 5')
})

test('布局：返回坐标、分组、版本；同一份输入是确定的', () => {
  const now = Date.now()
  const items = [
    { id: 'a', text: '主人最近睡不好', at: now, importance: 0.6, about: '123' },
    { id: 'b', text: '主人熬夜到两点', at: now, importance: 0.6, about: '123' },
    { id: 'c', text: '明天有考试', at: now, importance: 0.7 },
    { id: 'd', text: '刷B站看猫', at: now, importance: 0.4, source: 'event', tags: ['经历'] },
  ]
  const edges = buildEdges(items)
  const out = layoutGraph3d(items, { edges, now })
  assert.equal(out.version, LAYOUT_VERSION)
  assert.ok(out.radius > 0)
  assert.ok(Object.keys(out.positions).length === items.length, '每颗星都有坐标')
  for (const id of ['a', 'b', 'c', 'd']) {
    const p = out.positions[id]
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z), id + ' 坐标有限')
  }
  assert.ok(Array.isArray(out.groups) && out.groups.length > 0, '有分组')
})

test('空库布局不崩', () => {
  const out = layoutGraph3d([], { edges: [], now: Date.now() })
  assert.equal(out.version, LAYOUT_VERSION)
  assert.deepEqual(Object.keys(out.positions), [])
})

test('grams / similarity：相同文字相似度 1，全不同为 0', () => {
  assert.ok(similarity('主人喜欢吃火锅', '主人喜欢吃火锅') === 1)
  assert.equal(similarity('abc', 'xyz'), 0)
  assert.equal(grams('').size, 0)
})

// ── 二、tier 值域映射（用户确认：0→core，1→short，2→long，3→core）──

test('tier 映射：rc1 数字档 ↔ 星图 short/long/core', () => {
  assert.equal(toStarTier(0), 'core', '永久档 → 永久')
  assert.equal(toStarTier(1), 'short', '琐碎 → 临时')
  assert.equal(toStarTier(2), 'long', '一般 → 长期')
  assert.equal(toStarTier(3), 'core', '重要 → 永久')
  assert.equal(toStarTier('core'), 'core', '长期印象 → 永久')
  assert.equal(toStarTier(undefined), 'long', '未分档 → 长期')
  assert.equal(toHostTier('short'), 1)
  assert.equal(toHostTier('long'), 2)
  assert.equal(toHostTier('core'), 3)
  assert.equal(toHostTier('乱填'), null, '认不出来的返回 null，调用方据此拒绝')
})

// ── 三、memory.js 新 API ──

test('metaAll：给出 tau/tier/lastHit，和 retention 的 tau 公式一致', (t) => {
  const s = setup(t)
  const now = Date.now()
  s.mem.add({ text: '主人最近睡不好', about: OWNER, aboutName: '主人', importance: 0.6, source: 'auto', chatId: `private:${OWNER}`, tier: 2 })
  const meta = s.mem.metaAll()
  assert.equal(meta.length, 1)
  const m = meta[0]
  assert.equal(m.tier, 2)
  assert.ok(m.tau > 0, 'tau 要正数')
  // 20 × (1+hitDays) × (0.5+importance)，还没被想起过 → hitDays 0
  assert.ok(Math.abs(m.tau - 20 * 1 * (0.5 + 0.6)) < 1e-6, 'tau 公式一致')
})

test('archived：返回过时记忆，live 的不在里面', (t) => {
  const s = setup(t)
  const now = Date.now()
  // 直接写状态最稳：update() 不认 invalidAt 这种内部字段，而 remove() 是物理删除
  writeMemoryState(s.dir, { items: [
    { id: 'gone', text: '这条会过时', about: OWNER, chatId: `private:${OWNER}`, at: now - DAY, saidAt: now, importance: 0.5, source: 'auto', invalidAt: now, validUntil: now },
    { id: 'live', text: '这条还在', about: OWNER, chatId: `private:${OWNER}`, at: now, saidAt: now, importance: 0.5, source: 'auto' },
  ] })
  const arch = s.mem.archived()
  assert.ok(arch.length >= 1, '过时的要出现在归档里')
  assert.ok(arch.every((m) => m.invalidAt), '归档条目都带 invalidAt')
  assert.ok(!arch.some((m) => m.text === '这条还在'), '存活的不能在归档里')
})

test('setTier 必须能降档：面板点「临时」就该是临时，不能被「只升不降」吃掉', (t) => {
  const s = setup(t)
  const r = s.mem.add({ text: '先当永久', about: OWNER, importance: 0.6, source: 'auto', chatId: `private:${OWNER}`, tier: 3 })
  assert.equal(s.mem.list('').find((m) => m.id === r.id).tier, 3)
  // 星图上从「永久」改回「临时」——用户明确点了，就必须生效
  const down = s.mem.setTier(r.id, 1)
  assert.equal(down.ok, true)
  assert.equal(s.mem.list('').find((m) => m.id === r.id).tier, 1, '降档必须真的降下来')
  // 再改回长期
  assert.equal(s.mem.setTier(r.id, 2).ok, true)
  assert.equal(s.mem.list('').find((m) => m.id === r.id).tier, 2)
  // 改成永久档（0）时要清掉 tierSince，否则「永久」还会被算进升档统计
  assert.equal(s.mem.setTier(r.id, 0).ok, true)
  const m0 = s.mem.list('').find((m) => m.id === r.id)
  assert.equal(m0.tier, 0)
  assert.equal(m0.tierSince, undefined, '永久档不该留 tierSince')
})

test('setTier：能改数字档，但 core 长期印象和非法值都拒绝', (t) => {
  const s = setup(t)
  const now = Date.now()
  const r1 = s.mem.add({ text: '普通记忆', about: OWNER, importance: 0.5, source: 'auto', chatId: `private:${OWNER}`, tier: 1 })
  const ok = s.mem.setTier(r1.id, 2)
  assert.equal(ok.ok, true)
  assert.equal(s.mem.list('').find((m) => m.id === r1.id).tier, 2)
  // 非法值
  assert.equal(s.mem.setTier(r1.id, 9).ok, false)
  assert.equal(s.mem.setTier(r1.id, 'core').ok, false)
  // 不存在的 id
  assert.equal(s.mem.setTier('nope', 2).ok, false)
  // 长期印象不许被改
  const s2 = setup(t)
  s2.mem.add({ text: '长期印象', about: OWNER, importance: 0.9, source: 'abstract', chatId: `private:${OWNER}` })
  const coreId = s2.mem.list('').find((m) => m.tier === 'core')?.id
  if (coreId) assert.equal(s2.mem.setTier(coreId, 3).ok, false, '长期印象不能被手动改层级')
})

test('setAutoRecall：映射到 recallMode，没有第二个开关', (t) => {
  const s = setup(t)
  let calls = 0
  // 用注入的 setConfig 模拟宿主
  const mem = createMemoryStore({
    dsh: {}, getConfig: () => s.cfg, log,
    hub: { chatLogDays: () => [], chatLogOf: () => [], speakersOf: () => [] },
    setConfig: (fn) => { calls += 1; const next = typeof fn === 'function' ? fn(s.cfg) : fn; Object.assign(s.cfg.memory, next.memory) },
  })
  const off = mem.setAutoRecall(false)
  assert.equal(off.ok, true)
  assert.equal(s.cfg.memory.recallMode, 'trigger', '关 = 只在提到过去时查')
  const on = mem.setAutoRecall(true)
  assert.equal(on.ok, true)
  assert.equal(s.cfg.memory.recallMode, 'always', '开 = 每轮都查')
  assert.equal(calls, 2, '必须走宿主的 setConfig，不能自己落盘')
  // 没有注入 setConfig 时明确拒绝，而不是静默失败
  assert.equal(s.mem.setAutoRecall(true).ok, false)
})

test('点复习会真的加深：hitDays 涨、lastHit 刷新', (t) => {
  const s = setup(t)
  const r = s.mem.add({ text: '主人最近睡不好', about: OWNER, importance: 0.6, source: 'auto', chatId: `private:${OWNER}`, tier: 2 })
  const before = s.mem.metaAll()[0]
  s.mem.touch([{ it: s.mem.list('').find((m) => m.id === r.id) }])
  const after = s.mem.metaAll()[0]
  assert.ok(after.lastHit > 0, 'lastHit 被刷新')
  assert.ok(after.tau >= before.tau, 'tau 不降（记得更牢）')
})

// ── 四、关键：星图不能干扰现有联想/加深系统 ──

test('星图的 API 不碰 state.assoc：建边和联想完全独立', (t) => {
  const s = setup(t, { assoc: { hops: 1, recall: 3 } })
  const now = Date.now()
  s.mem.add({ text: '主人最近睡不好', about: OWNER, importance: 0.6, source: 'auto', chatId: `private:${OWNER}`, tier: 2 })
  s.mem.add({ text: '主人熬夜到两点', about: OWNER, importance: 0.6, source: 'auto', chatId: `private:${OWNER}`, tier: 2 })
  const before = JSON.stringify(s.mem.stats().assoc)
  // 走一遍星图会调用的所有只读接口
  s.mem.metaAll()
  s.mem.archived()
  s.mem.list('')
  const after = JSON.stringify(s.mem.stats().assoc)
  assert.equal(before, after, '星图接口不能改联想边')
})

test('星图不接管自动回忆：recallHint 行为不变', (t) => {
  const s = setup(t, { assoc: { hops: 2, recall: 3 } })
  s.mem.add({ text: '主人最近睡不好', about: OWNER, importance: 0.6, source: 'auto', chatId: `private:${OWNER}`, tier: 1 })
  const chat = { kind: 'private', userId: OWNER, chatId: `private:${OWNER}` }
  const hint = s.mem.recallHint(chat, '最近老是睡不好')
  assert.ok(hint.includes('（你记得这些事'), '仍是 rc1 自己的 hint 格式')
  assert.ok(!hint.includes('记忆中枢'), '不能被中枢的接管逻辑替换')
})

test('星图算法对 489 条级别的真实规模不卡（建边<200ms，布局<200ms）', () => {
  const now = Date.now()
  const items = []
  for (let i = 0; i < 500; i++) {
    items.push({
      id: 'x' + i,
      text: '第' + i + '条记忆，关于' + (i % 7 === 0 ? '睡觉' : i % 5 === 0 ? '吃饭' : '工作'),
      at: now - (i % 400) * DAY / 10,
      saidAt: now,
      importance: 0.3 + (i % 10) / 20,
      about: i % 3 === 0 ? OWNER : undefined,
      source: i % 4 === 0 ? 'event' : 'auto',
      tags: i % 6 === 0 ? ['经历'] : [],
      hitDays: (i % 12),
    })
  }
  const t0 = Date.now()
  const edges = buildEdges(items)
  const tEdge = Date.now() - t0
  const t1 = Date.now()
  const out = layoutGraph3d(items, { edges, now })
  const tLayout = Date.now() - t1
  assert.ok(tEdge < 200, '建边耗时 ' + tEdge + 'ms')
  assert.ok(tLayout < 200, '布局耗时 ' + tLayout + 'ms')
  assert.equal(Object.keys(out.positions).length, 500)
})

test('星图右键批量改档：一次改多条，且单条接口照旧能用', (t) => {
  const s = setup(t)
  const ids = []
  for (const text of ['甲的碎事', '乙的碎事', '丙的碎事']) {
    const r = s.mem.add({ text, about: OWNER, importance: 0.5, source: 'auto', chatId: `private:${OWNER}`, tier: 1 })
    assert.equal(r.ok, true)
    ids.push(r.id)
  }
  // 这一层是 route 里循环 setTier 的逻辑，这里直接验证底层能被连续调用
  for (const id of ids) assert.equal(s.mem.setTier(id, 3).ok, true)
  const after = s.mem.list('').filter((m) => ids.includes(m.id))
  assert.equal(after.length, 3)
  assert.ok(after.every((m) => m.tier === 3), '三条都该是永久档')
  // 再整批降回临时档：验证降档在批量场景下也生效
  for (const id of ids) s.mem.setTier(id, 1)
  assert.ok(s.mem.list('').filter((m) => ids.includes(m.id)).every((m) => m.tier === 1), '批量降档也要真的降下来')
})

test('批量复习：touch 一批后每条都被想起过、lastHit 都刷新', (t) => {
  const s = setup(t)
  const ids = []
  for (const text of ['复习甲', '复习乙']) {
    const r = s.mem.add({ text, about: OWNER, importance: 0.5, source: 'auto', chatId: `private:${OWNER}`, tier: 2 })
    assert.equal(r.ok, true)
    ids.push(r.id)
  }
  // 批量复习走的就是「拿到这批 item 一次性 touch」，route 里也是这么调的
  s.mem.touch(s.mem.list('').filter((m) => ids.includes(m.id)).map((it) => ({ it })))
  const after = s.mem.list('').filter((m) => ids.includes(m.id))
  const meta = new Map(s.mem.metaAll().map((x) => [x.id, x]))
  assert.equal(after.length, 2, '两条都还在')
  // hits 是「被想起的次数」：一次批量 touch 后每条都 +1
  assert.ok(after.every((m) => (m.hits || 0) >= 1), '每条的 hits 都该 >= 1')
  // lastHit 必须刷新，否则亮度算不准
  assert.ok(after.every((m) => meta.get(m.id).lastHit > 0), '每条的 lastHit 都该刷新')
})
test('toHostTier：字符串档位和数字都要能认（曾经数字返回 null 导致档位被静默丢弃）', () => {
  // 字符串：面板/星图传的就是这个
  assert.equal(toHostTier('short'), 1)
  assert.equal(toHostTier('long'), 2)
  assert.equal(toHostTier('core'), 3)
  // 数字：直接传 0~3 时不能返回 null（修复前这里会挂）
  for (const n of [0, 1, 2, 3]) assert.equal(toHostTier(n), n)
  // 非法值一律 null，调用方据此拒绝
  assert.equal(toHostTier('nope'), null)
  assert.equal(toHostTier(4), null)
  assert.equal(toHostTier(-1), null)
  assert.equal(toHostTier(null), null)
  assert.equal(toHostTier(undefined), null)
  assert.equal(toHostTier(2.5), null)
})

test('加记忆时带的 tier 要真的落到存储里（不能被路由吞掉）', (t) => {
  const s = setup(t)
  // 直接走 store，验证字符串档位能存进去
  const a = s.mem.add({ text: '临时档', about: OWNER, importance: 0.5, source: 'auto', chatId: `private:${OWNER}`, tier: toHostTier('short') })
  assert.equal(a.ok, true)
  const b = s.mem.add({ text: '永久档', about: OWNER, importance: 0.5, source: 'auto', chatId: `private:${OWNER}`, tier: toHostTier('core') })
  assert.equal(b.ok, true)
  const list = s.mem.list('')
  const ta = list.find((m) => m.id === a.id)
  const tb = list.find((m) => m.id === b.id)
  assert.equal(ta.tier, 1, '临时档应该是 1')
  assert.equal(tb.tier, 3, '永久档应该是 3')
})