import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { readMemoryState, writeMemoryState } from './helpers/memory-state.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { normalize } from '../src/core/config.js'
import { createMemoryStore, buildIndex, search, memoryLine, parseValidityDate, pastWindow, compressionClusters, shouldForget, SEEN_META_LIMITS, RELATED_LIMIT } from '../src/features/memory.js'
import memoryModule from '../src/modules/memory/index.js'

const OWNER = '10000001'
const GUEST = '10000002'
const DAY = 86400_000
const log = { info() {}, warn() {}, debug() {} }
const ownerChat = { kind: 'private', userId: OWNER, chatId: `private:${OWNER}` }
const date = (y, m = 1, d = 1) => new Date(y, m - 1, d).getTime()
const dayKey = (at) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-time-related-seen-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({ ownerQQ: OWNER, ownerName: '主人', model: { provider: 'p', model: 'm' }, memory: { compress: false, mergeGroups: false, keepChatlogDays: -1, ...options.memory } })
  const rows = options.rows || []
  const calls = []
  const dsh = { get: () => null, llm: { async *stream({ system, messages }) {
    calls.push({ system, text: messages?.[0]?.content?.[0]?.text || '' })
    const text = system.includes('整理长期记忆') ? JSON.stringify(options.extraction || { facts: [] })
      : system.includes('压成一句') ? '{"text":"我和主人聊了旅行"}'
        : system.includes('人物小档案') ? '喜欢旅行的朋友' : '{"insights":[],"style":[]}'
    yield { type: 'text-delta', text }
    yield { type: 'finish', reason: { kind: 'completed' } }
  } } }
  const hub = {
    chatLogDays: () => [...new Set(rows.map((r) => dayKey(r.t)))].sort(),
    chatLogOf: (day) => rows.filter((r) => dayKey(r.t) === day),
    deleteChatLog: (day) => { for (let i = rows.length - 1; i >= 0; i--) if (dayKey(rows[i].t) === day) rows.splice(i, 1) },
    speakersOf: () => [], groupNames: new Map(), forgetChatLog: () => 0,
  }
  const make = () => createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
  const mem = make()
  const state = () => readMemoryState(dir)
  const seed = (items, extra = {}) => writeMemoryState(dir, { items, ...extra })
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { mem, make, cfg, calls, rows, hub, dsh, state, seed }
}

const addPair = (mem, about = OWNER, chatId = `private:${OWNER}`) => {
  const a = mem.add({ text: '小明喜欢摄影', about, chatId })
  const b = mem.add({ text: '小明喜欢摄影，周末背着相机去公园拍鸟记录迁徙', about, chatId })
  assert.ok(a.id && b.id)
  return [a.id, b.id]
}

test('时间段读写、默认 saidAt、旧 invalidAt 兼容，显示值不重复落盘', (t) => {
  const { mem, make, seed, state } = setup(t)
  const now = Date.now()
  seed([{ id: 'legacy', text: '以前在杭州工作', saidAt: now - 30 * DAY, at: now, invalidAt: now - DAY }])
  const old = mem.list('').find((m) => m.id === 'legacy')
  assert.equal(old.validFrom, now - 30 * DAY)
  assert.equal(old.validUntil, now - DAY)
  assert.equal(state().items[0].validUntil, undefined, '读老数据不写迁移')
  const added = mem.add({ text: '小明现在住在上海', saidAt: now - 1000 })
  assert.equal(make().list('').find((m) => m.id === added.id).validFrom, now - 1000)
  const defaultTime = mem.add({ text: '一件没有指定说话时间的新事实' })
  const stored = state().items.find((m) => m.id === defaultTime.id)
  assert.equal(stored.validFrom, stored.saidAt)
  assert.equal(mem.update(added.id, { validFrom: '2025-03', validUntil: '2025-05-12' }).ok, true)
  const read = make().list('').find((m) => m.id === added.id)
  assert.equal(read.validFrom, date(2025, 3))
  assert.equal(read.validUntil, date(2025, 5, 12))
  assert.match(memoryLine(read, date(2027, 6)), /2025年3月起.*到2025年5月.*当时/)
  for (const m of state().items) for (const key of ['validityText', 'displayText', 'relatedItems']) assert.equal(Object.hasOwn(m, key), false)
  assert.equal(mem.restore(added.id).ok, true)
  assert.equal(make().list('').find((m) => m.id === added.id).validUntil, undefined)
})

test('过去查询只取对应时间段的事实；普通查询不带过时或尚未成立的事实', (t) => {
  const { mem, seed } = setup(t)
  const year = new Date().getFullYear()
  const common = { about: OWNER, chatId: ownerChat.chatId, importance: 0.8, at: Date.now() }
  seed([
    { ...common, id: 'last-year', text: '小明在杭州工作', saidAt: date(year - 2), validFrom: date(year - 2), validUntil: date(year), invalidAt: Date.now() },
    { ...common, id: 'current', text: '小明在上海工作', saidAt: date(year), validFrom: date(year) },
    { ...common, id: 'ancient', text: '小明在北京工作', saidAt: date(year - 5), validFrom: date(year - 5), validUntil: date(year - 3), invalidAt: Date.now() },
    { ...common, id: 'future', text: '小明在深圳工作', saidAt: date(year + 1), validFrom: date(year + 1) },
  ])
  const recall = (query) => mem.recall(query, { where: ownerChat.chatId, limit: 8, shown: false })
  assert.deepEqual(recall('去年小明在哪里工作').map((h) => h.it.id), ['last-year'])
  assert.deepEqual(recall('小明在哪里工作').map((h) => h.it.id), ['current'])
  assert.ok(recall('以前小明在哪里工作').some((h) => h.it.id === 'ancient'))
  const hint = mem.recallHint(ownerChat, '那时候小明在杭州工作吗')
  assert.match(hint, /当时：小明在杭州工作/)
  assert.doesNotMatch(mem.recallHint(ownerChat, '小明在杭州工作吗'), /当时：小明在杭州工作/)
  assert.equal(parseValidityDate('去年3月', date(2026, 6)), date(2025, 3))
  assert.equal(parseValidityDate('上个月', date(2026, 1)), date(2025, 12))
  assert.equal(parseValidityDate('很久以前', date(2026, 1)), undefined)
  assert.equal(parseValidityDate('2025-02-30'), undefined)
  assert.equal(parseValidityDate('去年13月', date(2026, 1)), undefined)
  assert.deepEqual(pastWindow('2025年3月在哪里工作', date(2026, 6)), { start: date(2025, 3), end: date(2025, 4) })
  const indexed = buildIndex([{ id: 'old', text: '杭州工作', at: date(2024), saidAt: date(2024), invalidAt: date(2026), importance: 0.9 }])
  assert.equal(search(indexed, '杭州工作', { now: date(2026, 6) }).length, 0)
  assert.equal(search(indexed, '去年杭州工作', { now: date(2026, 6) })[0].it.id, 'old')
})

test('提炼 add/update 解析时间，outdated 结束于新事实 saidAt 并清理关联', async (t) => {
  const at = Date.now() - 10 * 60_000
  const row = { chatId: ownerChat.chatId, who: '主人', uid: OWNER, text: '小明搬家到上海了，去年在杭州工作', t: at }
  const extraction = { facts: [] }
  const { mem, calls, state } = setup(t, { rows: [row], extraction })
  const [old, related] = addPair(mem)
  mem.update(old, { validFrom: at - DAY })
  extraction.facts.push({ op: 'outdated', id: old, text: '小明现在住在上海', about_qq: OWNER, speaker: OWNER, status: 'fact', said: '无法解析' })
  extraction.facts.push({ op: 'add', text: '小明去年在杭州工作', about_qq: OWNER, speaker: OWNER, validFrom: '去年', validUntil: '今年', tier: 0 })
  assert.equal((await mem.consolidate({ includeToday: true })).ok, true)
  const before = state().items.find((m) => m.id === old)
  const replacement = state().items.find((m) => m.id === before.supersededBy)
  assert.equal(before.validUntil, replacement.saidAt)
  assert.equal(before.validUntil, at)
  assert.ok(!state().items.find((m) => m.id === related).related?.includes(old))
  assert.deepEqual(before.related, [])
  const historical = state().items.find((m) => m.text === '小明去年在杭州工作')
  assert.equal(historical.validFrom, date(new Date(at).getFullYear() - 1))
  assert.equal(historical.validUntil, date(new Date(at).getFullYear()))
  assert.equal(shouldForget(historical), false, '刚补记的往事不能按成立时间立即清掉')
  assert.match(calls.find((c) => c.system.includes('整理长期记忆')).system, /validFrom.*validUntil/)
})

test('提炼 update 保留同一个事实和已知开始时间，能补充结束时间', async (t) => {
  const at = Date.now() - 1000
  const extraction = { facts: [] }
  const { mem, state } = setup(t, { extraction, rows: [{ chatId: ownerChat.chatId, who: '主人', uid: OWNER, text: '去年在杭州工作，到上个月结束', t: at }] })
  const original = mem.add({ text: '小明在杭州工作', about: OWNER, chatId: ownerChat.chatId, validFrom: '2024-03' })
  extraction.facts.push({ op: 'update', id: original.id, text: '小明在杭州做设计', speaker: OWNER, about_qq: OWNER, validUntil: '上个月' })
  assert.equal((await mem.consolidate({ includeToday: true })).ok, true)
  const m = state().items.find((m) => m.id === original.id)
  assert.equal(m.text, '小明在杭州做设计')
  assert.equal(m.validFrom, date(2024, 3))
  assert.equal(m.validUntil, parseValidityDate('上个月', at))
})

test('相关事实双向保留，仍走原去重/矛盾判断，删除和忘掉清理引用', (t) => {
  const { mem, make } = setup(t)
  const [a, b] = addPair(mem)
  assert.deepEqual(make().list('').find((m) => m.id === a).related, [b])
  assert.deepEqual(make().list('').find((m) => m.id === b).related, [a])
  assert.equal(mem.personaPerson(OWNER).notes.find((m) => m.id === a).relatedItems[0].id, b)
  assert.equal(mem.add({ text: '小明喜欢摄影', about: OWNER, chatId: ownerChat.chatId }).updated, a)
  const opposite = mem.add({ text: '小明不喜欢摄影', about: OWNER, chatId: ownerChat.chatId })
  assert.ok(opposite.id)
  assert.ok(!mem.list('').find((m) => m.id === a).related.includes(opposite.id))
  mem.remove(b)
  assert.deepEqual(mem.list('').find((m) => m.id === a).related, [])
  const next = mem.add({ text: '小明喜欢摄影，带着长焦镜头在湿地记录候鸟的迁徙过程', about: OWNER, chatId: ownerChat.chatId })
  assert.ok(mem.list('').find((m) => m.id === a).related.includes(next.id))
  assert.equal(mem.handleCommand(ownerChat, '忘掉小明喜欢摄影').ok, true)
  assert.deepEqual(mem.list('').find((m) => m.id === a).related, [])
  assert.equal(mem.recall('以前小明喜欢摄影', { where: ownerChat.chatId }).length, 0, '忘掉的内容不能借历史查询复活')
})

test('手动结束事实会清理双向引用；忘掉也覆盖已经过时的历史事实', (t) => {
  const { mem } = setup(t)
  const [a, b] = addPair(mem)
  const until = Date.now() - DAY
  mem.update(a, { validFrom: until - DAY, validUntil: until })
  assert.deepEqual(mem.list('').find((m) => m.id === a).related, [])
  assert.deepEqual(mem.list('').find((m) => m.id === b).related, [])
  assert.ok(mem.recall('以前小明喜欢摄影', { where: ownerChat.chatId }).some((h) => h.it.id === a))
  assert.equal(mem.handleCommand(ownerChat, '忘掉小明喜欢摄影').ok, true)
  assert.equal(mem.recall('以前小明喜欢摄影', { where: ownerChat.chatId }).length, 0)
})

test('相关引用至多六条，容量淘汰也清理双向引用', (t) => {
  const { mem, cfg } = setup(t)
  const base = mem.add({ text: '小明喜欢摄影', about: OWNER, chatId: ownerChat.chatId, source: 'auto', importance: 0.9 })
  const tails = ['周末背相机在公园拍候鸟记录迁徙', '春天带镜头上山追寻星空光影', '夏天去海边观察潮汐拍摄日出', '秋天走过田野留下金色麦浪', '冬天等雪落下拍老街的屋顶', '假期旅行记录沿途风景与人文', '傍晚走进湿地等待白鹭归巢', '清晨走到湖边观察水面的倒影']
  for (const tail of tails) mem.add({ text: `小明喜欢摄影，${tail}`, about: OWNER, chatId: ownerChat.chatId, source: 'auto', importance: 0.5 })
  const all = mem.list('')
  assert.equal(all.find((m) => m.id === base.id).related.length, RELATED_LIMIT)
  for (const m of all) {
    assert.ok((m.related || []).length <= RELATED_LIMIT)
    for (const id of m.related || []) assert.ok(all.find((x) => x.id === id).related.includes(m.id))
  }
  cfg.memory.capacity.auto = 1
  mem.add({ text: '海边风景', source: 'auto', importance: 0.4 })
  assert.equal(mem.list('').length, 1)
  assert.deepEqual(mem.list('')[0].related, [])
})

test('相关召回可以带无关键词的另一条，但不绕过聊天/人物/群权限或数量和字数限制', (t) => {
  const { mem, seed } = setup(t)
  const now = Date.now() - 1000
  const item = (id, text, extra = {}) => ({ id, text, about: GUEST, chatId: `private:${GUEST}`, at: now, saidAt: now, importance: 0.9, ...extra })
  seed([
    item('seed', '相机', { related: ['safe', 'private', 'owner', 'group', 'outdated'] }),
    item('safe', '周末会去湿地看鸟', { related: ['seed'] }),
    item('private', '私聊密码线索', { chatId: `private:${OWNER}`, related: ['seed'] }),
    item('owner', '主人的私事', { about: OWNER, related: ['seed'] }),
    item('group', '群里的公共事', { scope: 'group', about: '', chatId: 'group:999', related: ['seed'] }),
    item('outdated', '已经结束的近况', { invalidAt: now, validUntil: now, related: ['seed'] }),
  ])
  const opts = { where: `private:${GUEST}`, about: GUEST, onlyAbout: [GUEST], requireAbout: true, limit: 6, shown: false }
  assert.deepEqual(mem.recall('相机', opts).map((h) => h.it.id), ['seed', 'safe'])
  assert.equal(mem.recall('相机', { ...opts, limit: 1 }).length, 1)
  const hint = mem.recallHint({ kind: 'private', userId: GUEST, chatId: `private:${GUEST}` }, '相机')
  assert.match(hint, /湿地看鸟/)
  assert.doesNotMatch(hint, /密码|主人的私事|公共事|已经结束/)
  assert.ok(hint.length < 450, '现有 300 字正文限制仍生效')
})

test('seen 仍存 items/event、meta 限长、显示不冒充说话人且不污染画像或压缩', async (t) => {
  const { mem, state, calls, seed } = setup(t)
  const meta = Object.fromEntries(Object.keys(SEEN_META_LIMITS).map((key) => [key, '长'.repeat(800)]))
  const added = mem.addEvent({ kind: 'seen', text: '视频里的小明喜欢吃辣', about: OWNER, aboutName: '主人', meta: { ...meta, extra: { huge: true } } })
  const m = state().items.find((m) => m.id === added.id)
  assert.equal(m.source, 'event')
  assert.equal(m.kind, 'seen')
  assert.equal(m.about, '')
  assert.equal(m.aboutName, '')
  assert.equal(m.speaker, undefined)
  assert.deepEqual(Object.keys(m.meta).sort(), Object.keys(SEEN_META_LIMITS).sort())
  for (const [key, length] of Object.entries(SEEN_META_LIMITS)) assert.equal(m.meta[key].length, length)
  const seen = mem.addEvent({ kind: 'seen', meta: { title: '候鸟迁徙', author: '拍鸟的阿明', id: 12345, platform: 'new-site' } })
  const read = mem.list('').find((m) => m.id === seen.id)
  assert.equal(read.meta.id, '12345')
  assert.match(memoryLine(read), /看过《候鸟迁徙》（拍鸟的阿明）/)
  assert.doesNotMatch(memoryLine(read), /\[主人\]|说：/)
  assert.match(mem.contextFor(ownerChat), /看过《候鸟迁徙》（拍鸟的阿明）/)
  assert.equal(compressionClusters(Array.from({ length: 4 }, (_, i) => ({ ...m, id: String(i), at: Date.now() - 30 * DAY, saidAt: Date.now() - 30 * DAY }))).length, 0)
  assert.equal(await mem.buildProfile(OWNER), false)
  assert.equal(calls.length, 0)
  seed([...state().items.map((m) => ({ ...m, about: OWNER })), { ...m, id: 'legacy-seen', about: OWNER }])
  mem.addEvent({ kind: 'seen', text: '另一篇看过的文章', meta: { title: '另一篇' } })
  assert.equal(await mem.buildProfile(OWNER), false, '旧 seen 即便错误挂了 about，也不能作为画像来源')
  assert.equal(calls.length, 0)
  const normal = mem.addEvent({ text: '给主人唱了歌', about: OWNER })
  assert.equal(state().items.find((m) => m.id === normal.id).kind, undefined)
})

test('seen 流水既不进事实提炼，也不进画像和相处经验', async (t) => {
  const at = Date.now() - 1000
  const secret = 'SEEN_ONLY_AUTHOR_SAYS_HE_IS_OWNER'
  const { mem, calls } = setup(t, { rows: [
    { chatId: ownerChat.chatId, who: '作者', uid: OWNER, text: secret, kind: 'seen', t: at },
    { chatId: ownerChat.chatId, who: '主人', uid: OWNER, text: '我喜欢旅行', t: at + 1 },
  ] })
  assert.equal((await mem.consolidate({ includeToday: true })).ok, true)
  assert.ok(calls.some((c) => c.system.includes('整理长期记忆')))
  for (const call of calls) assert.doesNotMatch(call.text, new RegExp(secret))
  assert.equal(mem.list('').length, 0)
})

test('只有 seen 的流水直接推进进度，不调用提炼、画像或经验模型', async (t) => {
  const { mem, calls } = setup(t, { rows: [{ chatId: ownerChat.chatId, who: '作者', uid: OWNER, text: '外部视频内容', kind: 'seen', t: Date.now() - 1000 }] })
  assert.equal((await mem.consolidate({ includeToday: true })).ok, true)
  assert.equal(calls.length, 0)
  assert.deepEqual(mem.list(''), [])
})

test('时间轴类型和平台筛选使用 meta.platform / via 汇总，路由沿用同一个 store', async (t) => {
  const { mem, seed, cfg, hub, dsh } = setup(t)
  seed([], { gists: [
    { id: 'qq', kind: 'gist', chatId: ownerChat.chatId, level: 1, text: '聊了天气', at: Date.now(), via: ['custom-chat', 'other-chat'] },
    { id: 'old-via', kind: 'gist', chatId: 'group:999', level: 2, text: '相处愉快', at: Date.now() - 1000, via: 'legacy-platform' },
  ] })
  const seen = mem.addEvent({ kind: 'seen', meta: { title: '候鸟', platform: 'custom-video' } })
  assert.deepEqual(mem.timeline({ kind: 'seen' }).map((m) => m.id), [seen.id])
  assert.equal(mem.timeline({ kind: 'gist' }).length, 2)
  assert.equal(mem.timeline({ kind: 'seen', platform: 'custom-chat' }).length, 0)
  assert.equal(mem.timeline({ platform: 'legacy-platform' })[0].id, 'old-via')
  assert.equal(mem.timeline({ level: 1 }).length, 1)
  const platforms = new Set(mem.timeline().flatMap((m) => m.platforms))
  assert.deepEqual(platforms, new Set(['custom-chat', 'other-chat', 'legacy-platform', 'custom-video']))
  const routes = new Map()
  memoryModule.setup({ config: () => cfg, dsh, log, core: { hub, http: { query: (req) => req.query || {} } }, context() {}, on() {}, every() {}, tool() {}, route: (path, handler) => routes.set(path, handler) })
  const response = await routes.get('/memory/timeline')({ query: { kind: 'seen', platform: 'custom-video' } })
  assert.deepEqual(response.list.map((m) => m.id), [seen.id])
  assert.match(response.list[0].displayText, /看过《候鸟》/)
})

test('流水压成 gist 时保留所有 via，seen 不混入聊天梗概', async (t) => {
  const at = Date.now() - 2 * DAY
  const { mem, calls } = setup(t, { memory: { keepChatlogDays: 0, keepChatlogSet: true }, rows: [
    { chatId: ownerChat.chatId, who: '主人', uid: OWNER, text: '计划去旅行', via: 'custom-chat', t: at },
    { chatId: ownerChat.chatId, who: '主人', uid: OWNER, text: '想去杭州', via: 'other-chat', t: at + 1 },
    { chatId: ownerChat.chatId, who: '作者', text: 'SEEN_GIST_POISON', kind: 'seen', via: 'video-site', t: at + 2 },
  ] })
  assert.equal((await mem.consolidate({ includeToday: true })).ok, true)
  const gist = mem.gists().find((g) => g.origin === 'chatlog')
  assert.ok(gist)
  assert.deepEqual(gist.via, ['custom-chat', 'other-chat'])
  assert.deepEqual(mem.timeline({ platform: 'custom-chat' }).map((m) => m.id), [gist.id])
  for (const call of calls) assert.doesNotMatch(call.text, /SEEN_GIST_POISON/)
})

test('面板脚本可解析，人物详情显示时间段和相关事实，时间轴提供类型/平台筛选', () => {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  new Script(source)
  assert.match(source, /m\.validityText/)
  assert.match(source, /m\.relatedItems/)
  assert.match(source, /筛选经历类型/)
  assert.match(source, /筛选平台/)
  assert.match(source, /get\('\/memory\/timeline'\)/)
})
