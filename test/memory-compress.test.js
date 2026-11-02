// 记忆压缩回归：细节慢慢淡化，压缩成更概括的长期印象（source='abstract'）。
// 覆盖：候选筛选 / 聚类不跨可见性 / 输出校验 / 幂等 / 面板开关 / 成本上限 / 隐私可见性。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'aurabot-compress-'))
process.env.AURABOT_DATA_DIR = join(ROOT, 'boot')
mkdirSync(process.env.AURABOT_DATA_DIR, { recursive: true })

let normalize
let createMemoryStore
let compressionClusters
let parseAbstract
let checkAbstractText
before(async () => {
  ;({ normalize } = await import('../src/core/config.js'))
  ;({ createMemoryStore, compressionClusters, parseAbstract, checkAbstractText } = await import('../src/features/memory.js'))
})

const OWNER = '10000001'
const GUEST = '10000111'
const G555 = '555'
const G556 = '556'
const DAY = 86400_000
const log = { info () {}, warn () {}, debug () {} }

/** 每个用例独立数据目录 + 假 DSH 模型（按系统提示词给不同输出）。 */
function setup (tag, { memory = {}, reply } = {}) {
  const dir = join(ROOT, tag)
  mkdirSync(dir, { recursive: true })
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({
    ownerQQ: OWNER, ownerName: '主人', model: { provider: 'p', model: 'm' },
    memory: { dailyConsolidate: true, keepChatlogDays: 0, keepChatlogSet: true, ...memory },
  })
  const asked = []
  const answer = reply || (({ system, text }) => {
    if (system.includes('长期印象')) {
      if (text.includes('GROUP_DETAIL')) return '{"text":"小明和群里朋友关系很好，常一起打球"}'
      if (text.includes('OWNER_DETAIL')) return '{"text":"主人很疼她，总惦记她爱吃的白米饭"}'
      return '{"text":"大家相处得不错，彼此都挺照顾"}'
    }
    if (system.includes('人物小档案')) return '小明是熟人，喜欢打球'
    if (system.includes('{"insights"')) return '{"insights":[],"style":[]}'
    if (system.includes('自然会被带上')) return '[]'
    return '[]'
  })
  const dsh = {
    get: () => null,
    llm: {
      async *stream ({ system, messages }) {
        const text = messages?.[0]?.content?.[0]?.text || ''
        asked.push({ system: String(system || ''), text })
        yield { type: 'text-delta', text: answer({ system: String(system || ''), text }) }
        yield { type: 'finish', reason: { kind: 'completed' } }
      },
      listProviders: () => ['p'],
    },
  }
  const hub = { chatLogDays: () => [], chatLogOf: () => [], deleteChatLog: () => {}, speakersOf: () => [], lastTextOf: () => '', prevTextOf: () => '' }
  const mem = createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
  return { dir, cfg, asked, mem }
}

const oldAt = (days = 20) => Date.now() - days * DAY
const addOld = (mem, text, o = {}) => mem.add({
  text, about: o.about ?? GUEST, aboutName: o.aboutName ?? '小明', source: o.source ?? 'auto',
  chatId: o.chatId ?? `group:${G555}`, importance: o.importance ?? 0.5, saidAt: o.saidAt ?? oldAt(), ...(o.scope ? { scope: o.scope } : {}),
})
const abstracts = (mem) => mem.list('').filter((m) => m.source === 'abstract')
const compressCalls = (asked) => asked.filter((x) => x.system.includes('长期印象')).length

// ---------- 纯函数：候选筛选与聚类 ----------
test('候选筛选：只看够旧的 auto/event/diary，且不同 chatId/不同 about 不混', () => {
  const now = Date.now()
  const item = (id, o = {}) => ({
    id, text: `记忆${id}`, about: o.about ?? GUEST, aboutName: '小明', source: o.source ?? 'auto',
    importance: o.importance ?? 0.5, chatId: o.chatId ?? `group:${G555}`, at: o.at ?? (now - 20 * DAY), ...(o.scope ? { scope: o.scope } : {}), ...(o.tier ? { tier: o.tier } : {}), ...(o.compressedAt ? { compressedAt: o.compressedAt } : {}),
  })
  const items = [
    ...['a1', 'a2', 'a3', 'a4'].map((id) => item(id)),
    item('recent', { at: now - 2 * DAY }), // 太新
    item('manual', { source: 'tool' }), // 手动来源不压
    item('imported', { source: 'import' }),
    item('core', { tier: 'core' }), // 核心不压
    item('done', { compressedAt: now }), // 已压缩的不再选
    ...['b1', 'b2'].map((id) => item(id, { chatId: `group:${G556}` })), // 另一个聊天，只有 2 条不够
    ...['g1', 'g2', 'g3', 'g4'].map((id) => item(id, { scope: 'group', about: '', chatId: `group:${G555}` })),
    ...['o1', 'o2', 'o3', 'o4'].map((id) => item(id, { about: '', chatId: `group:${G555}` })), // 空 about 单独一簇
  ]
  const clusters = compressionClusters(items, { now, afterDays: 14 })
  const keys = clusters.map((c) => c.key).sort()
  assert.deepEqual(keys, [
    `group|group:${G555}|`,
    `normal|group:${G555}|`,
    `normal|group:${G555}|${GUEST}`,
  ])
  assert.equal(clusters.find((c) => c.key.includes('group|')).scope, 'group')
  assert.ok(clusters.every((c) => c.ids.length === 4), '每簇 4 条')
})

test('模型输出解析与校验：坏 JSON / 敏感词 / 编造数字 都拦下', () => {
  assert.equal(parseAbstract('不是 JSON'), '')
  assert.equal(parseAbstract('{"text":" 主人很惦记她 "}'), '主人很惦记她')
  assert.equal(parseAbstract('```json\n{"text":"主人很惦记她"}\n```'), '主人很惦记她')
  assert.equal(checkAbstractText('太短').ok, false)
  assert.equal(checkAbstractText('主人很惦记她爱吃的东西').ok, true)
  assert.equal(checkAbstractText('主人的密码是 12345678').ok, false, '敏感词')
  const bad = checkAbstractText('主人每个月给她 3000 块零花钱', ['主人给她买大米饭'])
  assert.equal(bad.ok, false, '编造数字')
  assert.equal(checkAbstractText('主人给她买了 2 袋大米', ['买了 2 袋大米']).ok, true, '源里有的数字可以用')
})

// ---------- 完整整理：生成长期印象 ----------
test('压缩：同聊天同 about 的 4 条旧细节 → 一条长期印象；源条目过时且能追溯', async () => {
  const { mem, asked } = setup('happy')
  for (let i = 0; i < 4; i++) addOld(mem, `GROUP_DETAIL 小明第${i}次一起打球`, { saidAt: oldAt(20 + i) })
  const r = await mem.consolidate({ includeToday: true })
  assert.equal(r.ok, true)
  assert.equal(r.compressed, 1)
  assert.match(r.message, /长期印象/)
  const ab = abstracts(mem)
  assert.equal(ab.length, 1)
  const a = ab[0]
  assert.equal(a.source, 'abstract')
  assert.equal(a.importance, 0.85)
  assert.equal(a.tier, 'core')
  assert.equal(a.about, GUEST)
  assert.equal(a.aboutName, '小明')
  assert.equal(a.chatId, `group:${G555}`)
  assert.equal(a.abstractOf.length, 4)
  assert.match(a.text, /小明和群里朋友关系很好/)
  const srcs = mem.list('').filter((m) => m.text.includes('GROUP_DETAIL'))
  assert.equal(srcs.length, 4)
  for (const m of srcs) {
    assert.ok(m.invalidAt > 0, '源条目要标过时')
    assert.equal(m.compressedInto, a.id, '源条目要能追溯到长期印象')
    assert.equal(m.supersededText, a.text)
  }
  assert.equal(compressCalls(asked), 1)

  // 幂等：再整理一次不再压缩、不再调压缩模型
  const before = compressCalls(asked)
  const r2 = await mem.consolidate({ includeToday: true })
  assert.equal(r2.compressed, 0)
  assert.equal(compressCalls(asked), before)
  assert.equal(abstracts(mem).length, 1)
})

test('模型坏 JSON：跳过该簇，整理不失败、源记忆不被破坏', async () => {
  const { mem, asked } = setup('badjson', { reply: ({ system, text }) => system.includes('长期印象') ? '我概括不出来' : '[]' })
  for (let i = 0; i < 4; i++) addOld(mem, `GROUP_DETAIL 细节${i}`, { saidAt: oldAt(20 + i) })
  const r = await mem.consolidate({ includeToday: true })
  assert.equal(r.ok, true)
  assert.equal(r.compressed, 0)
  assert.equal(compressCalls(asked), 1)
  assert.equal(abstracts(mem).length, 0)
  assert.equal(mem.list('').filter((m) => m.text.includes('GROUP_DETAIL') && !m.invalidAt).length, 4)
})

test('敏感词/编造数字：校验不过就丢弃，不落库', async () => {
  const bad = setup('sensitive', { reply: ({ system }) => system.includes('长期印象') ? '{"text":"主人的密码是 123456 别忘了"}' : '[]' })
  for (let i = 0; i < 4; i++) addOld(bad.mem, `GROUP_DETAIL 细节${i}`, { saidAt: oldAt(20 + i) })
  assert.equal((await bad.mem.consolidate({ includeToday: true })).compressed, 0)
  assert.equal(abstracts(bad.mem).length, 0)

  const nums = setup('numbers', { reply: ({ system }) => system.includes('长期印象') ? '{"text":"主人每个月给她 3000 块零花钱"}' : '[]' })
  for (let i = 0; i < 4; i++) addOld(nums.mem, `GROUP_DETAIL 细节${i}`, { saidAt: oldAt(20 + i) })
  assert.equal((await nums.mem.consolidate({ includeToday: true })).compressed, 0)
  assert.equal(abstracts(nums.mem).length, 0)
})

test('面板开关关闭：不选簇、不调模型', async () => {
  const { mem, asked } = setup('off', { memory: { compress: false } })
  for (let i = 0; i < 4; i++) addOld(mem, `GROUP_DETAIL 细节${i}`, { saidAt: oldAt(20 + i) })
  const r = await mem.consolidate({ includeToday: true })
  assert.equal(r.ok, true)
  assert.equal(r.compressed, 0)
  assert.equal(compressCalls(asked), 0)
  assert.equal(abstracts(mem).length, 0)
})

test('成本上限：一次整理最多调 2 次压缩模型，剩下的下次继续', async () => {
  const { mem, asked } = setup('budget')
  // 3 个簇：群 555 两簇（about=GUEST / about=''）+ 主人私聊一簇
  for (let i = 0; i < 4; i++) addOld(mem, `GROUP_DETAIL 群友细节${i}`, { saidAt: oldAt(20 + i) })
  for (let i = 0; i < 4; i++) addOld(mem, `GROUP_OTHER 群里公共细节${i}`, { about: '', saidAt: oldAt(20 + i) })
  for (let i = 0; i < 4; i++) addOld(mem, `OWNER_DETAIL 主人细节${i}`, { about: OWNER, aboutName: '主人', chatId: `private:${OWNER}`, saidAt: oldAt(20 + i) })
  const r1 = await mem.consolidate({ includeToday: true })
  assert.equal(r1.compressed, 2)
  assert.equal(compressCalls(asked), 2, '一次整理最多 2 次压缩调用')
  assert.equal(abstracts(mem).length, 2)
  // 下一次整理把剩下的那簇补上
  const r2 = await mem.consolidate({ includeToday: true })
  assert.equal(r2.compressed, 1)
  assert.equal(compressCalls(asked), 3)
  assert.equal(abstracts(mem).length, 3)
})

// ---------- 隐私：压缩不跨可见范围 ----------
test('压缩按可见性分簇：群里的印象回群，主人私聊的印象只回主人私聊', async () => {
  const { mem } = setup('privacy')
  for (let i = 0; i < 4; i++) addOld(mem, `GROUP_DETAIL 小明第${i}次一起打球`, { saidAt: oldAt(20 + i) })
  for (let i = 0; i < 4; i++) addOld(mem, `OWNER_DETAIL 主人第${i}次给她买白米饭`, { about: OWNER, aboutName: '主人', chatId: `private:${OWNER}`, saidAt: oldAt(20 + i) })
  const r = await mem.consolidate({ includeToday: true })
  assert.equal(r.ok, true)
  assert.equal(r.compressed, 2)
  const groupAb = abstracts(mem).find((m) => m.chatId === `group:${G555}`)
  const ownerAb = abstracts(mem).find((m) => m.chatId === `private:${OWNER}`)
  assert.ok(groupAb && ownerAb, '两个可见范围各生成一条')
  assert.equal(groupAb.about, GUEST)
  assert.equal(ownerAb.about, OWNER)

  const query = '打球 朋友 白米饭 疼 惦记 小明 主人 关系'
  const recalled = mem.recall(query, {
    about: [GUEST], onlyAbout: [GUEST], requireAbout: true, excludeAbout: OWNER,
    where: `group:${G555}`, groupChatId: `group:${G555}`, includeGroup: false, limit: 20,
  }).map((h) => h.it.text).join('\n')
  assert.match(recalled, /小明和群里朋友关系很好/, '群里能想起本群的长期印象')
  assert.doesNotMatch(recalled, /主人很疼她/, '群聊不能看到主人私聊压缩出的印象')

  const ownerSaw = mem.recall(query, { where: `private:${OWNER}`, includeGroup: true, limit: 20 }).map((h) => h.it.text).join('\n')
  assert.match(ownerSaw, /主人很疼她/, '主人私聊仍能回忆全部')
})

test('群公共记忆压缩后仍是该群可见，别的群看不到', async () => {
  const { mem } = setup('groupscope')
  for (let i = 0; i < 4; i++) addOld(mem, `群里公共的细节${i}`, { scope: 'group', about: '', saidAt: oldAt(20 + i) })
  const r = await mem.consolidate({ includeToday: true })
  assert.equal(r.compressed, 1)
  const ab = abstracts(mem)[0]
  assert.equal(ab.scope, 'group')
  assert.equal(ab.chatId, `group:${G555}`)
  assert.equal(ab.about, '')
  const query = '公共 细节 大家 相处'
  const g555 = mem.recall(query, { where: `group:${G555}`, groupChatId: `group:${G555}`, limit: 20 }).map((h) => h.it.text)
  const g556 = mem.recall(query, { where: `group:${G556}`, groupChatId: `group:${G556}`, limit: 20 }).map((h) => h.it.text)
  assert.ok(g555.some((t) => t.includes('大家相处得不错')), '本群能看到')
  assert.equal(g556.some((t) => t.includes('大家相处得不错')), false, '别的群看不到')
})

// ---------- 峰谷省钱：峰时压缩推迟到谷时，不花模型调用 ----------
test('峰谷省钱：峰时 compressDetails 不调模型、返回 deferred；谷时照常压缩', async () => {
  const { cfg, asked, mem } = setup('offpeak-compress', { memory: { compress: true } })
  for (let i = 0; i < 4; i++) addOld(mem, `DETAIL_${i}`, { saidAt: Date.now() - 40 * DAY })
  cfg.cost.offPeak = true
  cfg.cost.offPeakHolidays = []
  const callsBefore = compressCalls(asked)
  const peakNow = Date.UTC(2026, 10, 2, 2, 0) // 北京时间周一 10:00 → 峰时
  const d = await mem.compressDetails({ now: peakNow })
  assert.equal(d.deferred, true, '峰时要标记推迟')
  assert.equal(d.calls, 0)
  assert.equal(d.created, 0)
  assert.equal(compressCalls(asked), callsBefore, '峰时不能调压缩模型')
  // 谷时（周末）→ 正常压缩
  const valleyNow = Date.UTC(2026, 10, 7, 2, 0) // 北京时间周六 10:00 → 谷时
  const r = await mem.compressDetails({ now: valleyNow })
  assert.notEqual(r.deferred, true, '谷时不再推迟')
  assert.equal(r.calls, 1)
  assert.equal(r.created, 1)
})
