// 向量检索只使用假接口，不访问网络。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize, publicConfig, mergeFromPanel } from '../src/core/config.js'
import { createVectorIndex } from '../src/features/memory-vector.js'
import { buildIndex, createMemoryStore, memoryLine, search } from '../src/features/memory.js'
import memoryModule from '../src/modules/memory/index.js'

const OWNER = '10000001'
const FRIEND = '30000001'
const log = { info() {}, warn() {}, debug() {} }

function setup(t, fetchImpl) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-vector-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({ ownerQQ: OWNER, memory: { dailyConsolidate: false, vector: { enabled: true, baseUrl: 'http://localhost:1234/v1/', model: 'fake', apiKey: '秘密密钥', batchSize: 32, queryTimeoutMs: 2000 } } })
  const hub = { chatLogDays: () => [], chatLogOf: () => [], speakersOf: () => [FRIEND] }
  const calls = []
  const fake = fetchImpl || (async (url, options) => {
    const body = JSON.parse(options.body)
    calls.push({ url, options, body })
    const vectorOf = (text) => /宠物|橘猫|猫毛|小猫/.test(text) ? [1, 0, 0] : /医院|护士/.test(text) ? [0, 1, 0] : [0, 0, 1]
    return { ok: true, json: async () => ({ data: body.input.map((text, index) => ({ index, embedding: vectorOf(text) })).reverse() }) }
  })
  const index = () => createVectorIndex({ getConfig: () => cfg, log, fetchImpl: fake })
  const store = () => createMemoryStore({ getConfig: () => cfg, hub, log, fetchImpl: fake })
  t.after(() => {
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, cfg, hub, calls, fake, index, store }
}

const items = () => [
  { id: 'cat', text: '小明养了一只橘猫叫年糕', about: FRIEND, importance: 0.6, at: Date.now() },
  { id: 'nurse', text: '阿花在杭州当护士', about: FRIEND, importance: 0.6, at: Date.now() },
]

test('默认关闭，配置不全时不请求；密钥遮罩并在面板保存时保留', async (t) => {
  const s = setup(t)
  assert.deepEqual(normalize({}).memory.vector, {
    enabled: false,
    provider: 'siliconflow',
    baseUrl: '',
    model: '',
    apiKey: '',
    dimensions: 0,
    batchSize: 10,
    queryTimeoutMs: 3000,
    headers: '',
  })
  const index = s.index()
  s.cfg.memory.vector.enabled = false
  await index.sync(items())
  assert.equal(await index.queryVector('宠物'), null)
  s.cfg.memory.vector.enabled = true
  s.cfg.memory.vector.model = ''
  await index.sync(items())
  assert.deepEqual(await index.embed(['宠物']), [])
  assert.equal(s.calls.length, 0)
  s.cfg.memory.vector.model = 'fake'
  const visible = publicConfig(s.cfg)
  assert.equal(visible.memory.vector.apiKey, '')
  assert.equal(visible.memory.vector.apiKeySet, true)
  assert.equal(JSON.stringify(visible).includes('秘密密钥'), false)
  assert.equal(mergeFromPanel(s.cfg, visible).memory.vector.apiKey, '秘密密钥')
  assert.equal(mergeFromPanel(s.cfg, { memory: { vector: { apiKey: null } } }).memory.vector.apiKey, '')
  s.cfg.memory.vector.baseUrl = ''
  const mem = s.store()
  mem.add({ text: '小明养了一只橘猫', about: FRIEND })
  await mem.tick()
  assert.deepEqual(await mem.vectorHits('宠物'), [])
  assert.equal(s.calls.length, 0)
})

test('假向量补充宠物→猫、医院→护士，关键词仍可命中', async (t) => {
  const s = setup(t)
  const vector = s.index()
  const facts = items()
  await vector.sync(facts)
  assert.equal(s.calls[0].url, 'http://localhost:1234/v1/embeddings')
  assert.deepEqual(s.calls[0].body, { model: 'fake', input: facts.map((x) => x.text) })
  assert.equal(s.calls[0].options.headers.Authorization, 'Bearer 秘密密钥')
  assert.deepEqual(s.calls[0].options.signal.aborted, false)
  assert.equal(vector.search([1, 0], facts.map((x) => x.id), 10).length, 0, '维度不同不能计算相似度')
  assert.equal(vector.search([1, 0, 0], ['nurse'], 10)[0].similarity, 0)
  const idx = buildIndex(facts)
  for (const [q, wanted] of [['他有宠物吗', 'cat'], ['谁在医院上班', 'nurse']]) {
    const vec = await vector.queryVector(q)
    const vectorHits = vector.search(vec, facts.map((x) => x.id), 10)
    assert.ok(search(idx, q, { vectorHits }).some((h) => h.it.id === wanted))
  }
  assert.ok(search(idx, '杭州', { vectorHits: [] }).some((h) => h.it.id === 'nurse'))
  assert.deepEqual(search(idx, '不相干的天气', { vectorHits: [{ id: 'cat', similarity: 0.549 }] }), [])
  assert.equal(search(idx, '不相干的天气', { minScore: 100, vectorHits: [{ id: 'cat', similarity: 0.55 }] })[0].it.id, 'cat')
  const count = s.calls.length
  await vector.queryVector('他有宠物吗')
  assert.equal(s.calls.length, count, '同一查询使用缓存')
})

test('向量补召回：宠物、太辣、医院上班；关闭向量时明确不命中', async (t) => {
  const fake = async (url, options) => {
    const body = JSON.parse(options.body)
    const vectorOf = (text) => /宠物|橘猫|猫毛|小猫/.test(text) ? [1, 0, 0]
      : /医院|护士/.test(text) ? [0, 1, 0]
        : /辣|火锅/.test(text) ? [0, 0, 1]
          : [0.5, 0.5, 0.5]
    return { ok: true, json: async () => ({ data: body.input.map((text, index) => ({ index, embedding: vectorOf(text) })) }) }
  }
  const s = setup(t, fake)
  const vector = s.index()
  const facts = [
    { id: 'cat', text: '小明养了一只橘猫叫年糕', importance: 0.6, at: Date.now() },
    { id: 'spicy', text: '小明不吃辣', importance: 0.6, at: Date.now() },
    { id: 'nurse', text: '阿花在杭州当护士', importance: 0.6, at: Date.now() },
  ]
  await vector.sync(facts)
  const idx = buildIndex(facts)
  for (const [q, wanted] of [
    ['他有宠物吗', 'cat'],
    ['这个火锅太辣了吧', 'spicy'],
    ['谁在医院上班', 'nurse'],
  ]) {
    const qv = await vector.queryVector(q)
    const vectorHits = vector.search(qv, facts.map((x) => x.id), 10)
    assert.ok(search(idx, q, { vectorHits }).some((h) => h.it.id === wanted), q)
  }

  // 默认关闭时这些语义问题仍走纯关键词，不命中是已定义行为。
  s.cfg.memory.vector.enabled = false
  assert.equal(await vector.queryVector('他有宠物吗'), null)
  assert.deepEqual(search(idx, '他有宠物吗', { vectorHits: [] }), [])
})

test('关键词和向量按各自名次做 RRF，零关键词不能靠人物加分入选', () => {
  const now = Date.now()
  const idx = buildIndex([
    { id: 'keyword', text: '咖啡咖啡', about: FRIEND, at: now },
    { id: 'both', text: '咖啡', about: FRIEND, at: now },
    { id: 'semantic', text: '小猫', about: FRIEND, at: now },
    { id: 'unrelated', text: '晴天', about: FRIEND, at: now },
  ])
  const vectorHits = [{ id: 'semantic', similarity: 0.99 }, { id: 'both', similarity: 0.8 }, { id: 'unrelated', similarity: 0.54 }]
  const hits = search(idx, '咖啡', { about: FRIEND, vectorHits, now })
  assert.equal(hits[0].it.id, 'both')
  assert.ok(hits.some((h) => h.it.id === 'semantic'))
  assert.ok(!hits.some((h) => h.it.id === 'unrelated'))
  assert.ok(hits.find((h) => h.it.id === 'semantic').why.includes('（语义相关）'))
})

test('向量命中同样受群聊、人物和失效权限限制，传闻保留原来的标注', async (t) => {
  const s = setup(t)
  const mem = s.store()
  const mine = mem.add({ text: '主人的小猫', about: OWNER }).id
  const own = mem.add({ text: '小明有小猫', about: FRIEND, chatId: 'group:777' }).id
  const other = mem.add({ text: '别人养了小猫', about: '30000002' }).id
  const general = mem.add({ text: '街上有只小猫' }).id
  const heard = mem.add({ text: '听说小明捡到小猫', about: FRIEND, status: 'hearsay', chatId: 'group:777' }).id
  const guessed = mem.add({ text: '小明可能捡到小猫', about: FRIEND, status: 'guess', chatId: 'group:777' }).id
  const stale = mem.add({ text: '小明的小猫走丢', about: FRIEND }).id
  const group = mem.add({ text: '本群有只小猫', scope: 'group', chatId: 'group:777' }).id
  const foreign = mem.add({ text: '隔壁群有小猫', scope: 'group', chatId: 'group:888' }).id
  assert.equal(s.calls.length, 0, '新增记忆不会立即请求')
  await mem.tick()
  assert.equal(mem.stats().vector, 9)
  mem.handleCommand({ kind: 'private', userId: FRIEND, chatId: `private:${FRIEND}` }, '忘掉小猫走丢')
  assert.equal(mem.stats().vector, 8)
  const hits = await mem.vectorHits('宠物')
  assert.ok(hits.some((h) => h.id === mine), '索引确实命中主人的记忆，后续权限过滤必须将其排除')
  assert.ok(!hits.some((h) => h.id === stale), '失效的条目不能再通过旧向量命中')
  const staleResult = search(buildIndex(mem.list('')), '宠物', { vectorHits: [{ id: stale, similarity: 1 }] })
  assert.ok(!staleResult.some((h) => h.it.id === stale), '即使传入旧命中也不能绕过检索过滤')
  const result = mem.recall('宠物', { where: 'group:777', about: [FRIEND, OWNER], onlyAbout: [FRIEND, OWNER], requireAbout: true, groupChatId: 'group:777', vectorHits: hits, limit: 20, shown: false })
  const ids = result.map((h) => h.it.id)
  assert.ok(ids.includes(own))
  assert.ok(ids.includes(group))
  assert.ok(ids.includes(heard))
  assert.ok(ids.includes(guessed))
  for (const id of [mine, other, general, stale, foreign]) assert.ok(!ids.includes(id), `不应出现 ${id}`)
  assert.match(memoryLine(result.find((h) => h.it.id === heard).it), /听说/)
  assert.match(memoryLine(result.find((h) => h.it.id === guessed).it), /可能/)
  const hint = mem.recallHint({ kind: 'group', chatId: 'group:777', groupId: '777' }, '宠物', '', '', [FRIEND, OWNER], hits)
  assert.match(hint, /小明有小猫/)
  assert.doesNotMatch(hint, /主人的小猫|隔壁群/)
  mem.update(own, { text: '小明搬到杭州' })
  const changed = mem.recall('宠物', { where: 'group:777', onlyAbout: [FRIEND], requireAbout: true, groupChatId: 'group:777', vectorHits: hits, limit: 20, shown: false })
  assert.ok(!changed.some((h) => h.it.id === own), '查询之后改写的条目不能使用旧命中')
  s.cfg.memory.groupMemory = false
  const disabled = mem.recall('宠物', { where: 'group:777', onlyAbout: [FRIEND], requireAbout: true, groupChatId: 'group:777', vectorHits: hits, limit: 20, shown: false })
  assert.ok(!disabled.some((h) => h.it.id === group))
})

test('群聊的 recall_memory 工具也不能用向量翻出主人的记忆', async (t) => {
  const s = setup(t)
  let builder
  const api = {
    config: () => s.cfg, core: { hub: s.hub, http: {} }, log,
    context() {}, on() {}, every() {}, tool: (fn) => { builder = fn }, route() {},
  }
  const mem = memoryModule.setup(api, { fetchImpl: s.fake })
  mem.add({ text: '主人的小猫', about: OWNER })
  mem.add({ text: '小明养了小猫', about: FRIEND, chatId: 'group:777' })
  await mem.tick()
  const chat = { kind: 'group', chatId: 'group:777', groupId: '777', userId: FRIEND }
  const tool = builder({ chat, sessionId: 's' }).find((x) => x.name === 'recall_memory')
  const response = await tool.execute({ query: '宠物' })
  assert.match(response.message, /小明养了小猫/)
  assert.doesNotMatch(response.message, /主人的小猫/)
})

test('每次同步最多 32 条，改写、删除、失效和换模型后不会使用旧向量', async (t) => {
  const s = setup(t)
  const vector = s.index()
  const list = Array.from({ length: 35 }, (_, i) => ({ id: String(i), text: `第${i}只小猫` }))
  await vector.sync(list)
  assert.equal(s.calls[0].body.input.length, 32)
  assert.equal(vector.validIds(list).length, 32)
  const metadata = JSON.parse(readFileSync(join(s.dir, 'memory-vectors-meta.json'), 'utf8'))
  assert.equal(JSON.stringify(metadata).includes(list[0].text), false)
  await vector.sync(list)
  assert.equal(s.calls[1].body.input.length, 3)
  list[0].text = '换成护士'
  list[1].invalidAt = Date.now()
  list.splice(2, 1)
  assert.equal(vector.validIds(list).length, 32, '改写的文字立即丢弃旧向量')
  await vector.sync(list)
  assert.deepEqual(s.calls[2].body.input, ['换成护士'])
  const saved = JSON.parse(readFileSync(join(s.dir, 'memory-vectors.json'), 'utf8'))
  assert.deepEqual(Object.keys(saved).sort(), ['dims', 'items', 'model'])
  assert.equal(saved.model, 'fake')
  assert.equal(saved.dims, 3)
  assert.deepEqual(saved.items['0'], [0, 1, 0])
  assert.equal(saved.items['1'], undefined)
  assert.equal(saved.items['2'], undefined)
  const reload = s.index()
  assert.equal(reload.validIds(list).length, 33)
  list[0].text = '重启后又改成小猫'
  assert.ok(!reload.validIds(list).includes('0'))
  s.cfg.memory.vector.baseUrl = 'http://localhost:4321/v1'
  assert.deepEqual(reload.validIds(list), [], '换服务时同名模型的向量也不能混用')
  s.cfg.memory.vector.model = 'new-model'
  assert.deepEqual(reload.validIds(list), [])
  await reload.sync([])
  const rebuilt = JSON.parse(readFileSync(join(s.dir, 'memory-vectors.json'), 'utf8'))
  assert.equal(rebuilt.model, 'new-model')
  assert.deepEqual(rebuilt.items, {})
})

test('无密钥服务可用，响应维度不一致会回退并保留现有索引', async (t) => {
  const s = setup(t)
  s.cfg.memory.vector.apiKey = ''
  const vector = s.index()
  await vector.sync(items())
  assert.equal(s.calls[0].options.headers.Authorization, undefined)
  const invalid = createVectorIndex({ getConfig: () => s.cfg, log, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) }) })
  assert.equal(await invalid.queryVector('维度错误'), null)
  assert.equal(invalid.validIds(items()).length, 2)
})

test('查询缓存在同步确定维度后重新校验', async (t) => {
  let calls = 0
  const s = setup(t, async (url, options) => {
    const input = JSON.parse(options.body).input
    calls++
    const vec = calls === 1 ? [1, 0] : [1, 0, 0]
    return { ok: true, json: async () => ({ data: input.map(() => ({ embedding: vec })) }) }
  })
  const vector = s.index()
  assert.deepEqual(await vector.queryVector('宠物'), [1, 0])
  await vector.sync(items())
  assert.deepEqual(await vector.queryVector('宠物'), [1, 0, 0])
  assert.equal(calls, 3)
})

test('并发的同一查询共用一次请求，配置变化后不会缓存旧响应', async (t) => {
  let calls = 0, reply
  const s = setup(t, () => { calls++; return new Promise((resolve) => { reply = resolve }) })
  const vector = s.index()
  const first = vector.queryVector('宠物')
  const second = vector.queryVector('宠物')
  assert.equal(calls, 1)
  s.cfg.memory.vector.model = 'new-model'
  reply({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) })
  assert.equal(await first, null)
  assert.equal(await second, null)
  const third = vector.queryVector('宠物')
  assert.equal(calls, 2)
  reply({ ok: true, json: async () => ({ data: [{ embedding: [0, 1] }] }) })
  assert.deepEqual(await third, [0, 1])
  s.cfg.memory.vector.enabled = false
  assert.equal(await vector.queryVector('宠物'), null, '关闭后不能命中旧查询缓存')
})

test('同步期间删除或修改记忆不会把旧文字的向量写回', async (t) => {
  let finish
  const started = new Promise((resolve) => { finish = resolve })
  let reply
  const s = setup(t, async () => {
    finish()
    return new Promise((resolve) => { reply = resolve })
  })
  const vector = s.index()
  const original = items()
  const live = structuredClone(original)
  const pending = vector.sync(original, () => live)
  await started
  live[0].text = '内容已改'
  live.splice(1, 1)
  reply({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] }) })
  await pending
  assert.deepEqual(vector.validIds(live), [])
})

test('切换模型后旧请求返回不会污染新模型的冷却状态', async (t) => {
  let firstReply, calls = 0
  const s = setup(t, () => {
    calls++
    return calls === 1 ? new Promise((resolve) => { firstReply = resolve }) : Promise.resolve({ ok: false })
  })
  const vector = s.index()
  const old = vector.queryVector('旧请求')
  s.cfg.memory.vector.model = 'new-model'
  for (let i = 0; i < 3; i++) assert.equal(await vector.queryVector('新请求' + i), null)
  assert.equal(calls, 4)
  firstReply({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) })
  assert.equal(await old, null)
  assert.equal(await vector.queryVector('仍在冷却'), null)
  assert.equal(calls, 4)
})

test('查询超时最多两秒，连续三次失败冷却十分钟，只写不含密钥的 debug', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  let calls = 0
  const messages = []
  const s = setup(t, () => { calls++; return new Promise(() => {}) })
  const vector = createVectorIndex({ getConfig: () => s.cfg, log: { debug: (...a) => messages.push(a.join(' ')) }, fetchImpl: s.fake })
  for (let i = 0; i < 3; i++) {
    const pending = vector.queryVector('问题' + i)
    t.mock.timers.tick(2000)
    assert.equal(await pending, null)
  }
  assert.equal(calls, 3)
  assert.equal(await vector.queryVector('冷却中'), null)
  assert.equal(calls, 3)
  assert.ok(messages.length === 3 && messages.every((m) => !m.includes('秘密密钥')))
  t.mock.timers.tick(10 * 60_000)
  const retry = vector.queryVector('恢复后')
  t.mock.timers.tick(2000)
  assert.equal(await retry, null)
  assert.equal(calls, 4)
})

test('自动回忆和 recall_memory 工具都使用向量，失败时保留关键词', async (t) => {
  let broken = false
  const s = setup(t)
  const fetchImpl = (...args) => broken ? Promise.reject(new Error('秘密密钥')) : s.fake(...args)
  let prompt, builder, tick
  const api = {
    config: () => s.cfg, core: { hub: s.hub, http: {} }, log,
    context() {}, on: (name, fn) => { if (name === 'prompt') prompt = fn },
    every: (ms, fn) => { tick = fn }, tool: (fn) => { builder = fn }, route() {},
  }
  const mem = memoryModule.setup(api, { fetchImpl })
  mem.add({ text: '小明养了一只橘猫叫年糕', about: FRIEND, chatId: `private:${FRIEND}` })
  mem.add({ text: '阿花在杭州当护士', about: FRIEND, chatId: `private:${FRIEND}` })
  await tick()
  const chat = { kind: 'private', chatId: `private:${FRIEND}`, userId: FRIEND }
  const content = [{ type: 'text', text: '他有宠物吗' }]
  const injected = await prompt(content, { chat, queryText: '他有宠物吗' })
  assert.match(injected[0].text, /橘猫/)
  const tool = builder({ chat, sessionId: 's' }).find((x) => x.name === 'recall_memory')
  assert.match((await tool.execute({ query: '谁在医院上班' })).message, /护士/)
  broken = true
  assert.match((await tool.execute({ query: '杭州' })).message, /护士/)
  s.cfg.memory.vector.enabled = false
  assert.equal(mem.stats().vector, 2, '关闭检索后仍显示已同步数量')
  assert.match((await tool.execute({ query: '杭州' })).message, /护士/)
})

test('服务地址误填完整 /embeddings 时自动去掉，不拼成双路径', async (t) => {
  const s = setup(t)
  s.cfg.memory.vector.baseUrl = 'http://localhost:1234/v1/embeddings'
  await s.index().embed(['x'])
  assert.equal(s.calls.at(-1).url, 'http://localhost:1234/v1/embeddings')
})

test('自定义请求头、维度、批量、base64 向量；状态/测试/重建', async (t) => {
  const s = setup(t)
  const v = s.cfg.memory.vector
  v.headers = 'X-Api-Key: header-key\nAuthorization: Custom token'
  v.dimensions = 3
  v.batchSize = 2
  const calls = []
  const fake = async (url, options) => {
    const body = JSON.parse(options.body)
    calls.push({ url, options, body })
    const vec = Buffer.from(new Float32Array([1, 0, 0]).buffer).toString('base64')
    return { ok: true, json: async () => ({ data: body.input.map((_, index) => ({ index, embedding: vec })) }) }
  }
  const vector = createVectorIndex({ getConfig: () => s.cfg, log, fetchImpl: fake })
  const facts = [1, 2, 3].map((i) => ({ id: String(i), text: '小猫' + i }))
  await vector.sync(facts)
  assert.equal(calls[0].body.input.length, 2, '按 batchSize 分批')
  assert.equal(calls[0].body.dimensions, 3)
  assert.equal(calls[0].options.headers['X-Api-Key'], 'header-key')
  assert.equal(calls[0].options.headers.Authorization, 'Custom token', '自定义 Authorization 优先')
  assert.equal(vector.validIds(facts).length, 2)
  await vector.sync(facts)
  assert.equal(vector.validIds(facts).length, 3)
  assert.equal(vector.status(facts).indexed, 3)
  assert.equal(vector.status(facts).dims, 3)
  const tested = await vector.test('测试')
  assert.equal(tested.dims, 3)
  assert.equal(vector.reset(), true)
  assert.equal(vector.validIds(facts).length, 0)
})

test('错误响应只记 debug，接口失败时自动回忆仍能按关键词找到记忆', async (t) => {
  const messages = []
  let fail = false
  const s = setup(t)
  const fetchImpl = (...args) => fail ? Promise.resolve({ ok: false }) : s.fake(...args)
  let prompt
  const api = {
    config: () => s.cfg, core: { hub: s.hub, http: {} },
    log: { debug: (...a) => messages.push(a.join(' ')), info() {}, warn: () => assert.fail('不应写警告日志') },
    context() {}, on: (name, fn) => { if (name === 'prompt') prompt = fn }, every() {}, tool() {}, route() {},
  }
  const mem = memoryModule.setup(api, { fetchImpl })
  mem.add({ text: '阿花在杭州当护士', about: FRIEND, chatId: `private:${FRIEND}` })
  await mem.tick()
  fail = true
  const chat = { kind: 'private', chatId: `private:${FRIEND}`, userId: FRIEND }
  const injected = await prompt([{ type: 'text', text: '杭州' }], { chat, queryText: '杭州' })
  assert.match(injected[0].text, /护士/)
  assert.equal(messages.length, 1)
  assert.ok(!messages[0].includes('秘密密钥'))
})
