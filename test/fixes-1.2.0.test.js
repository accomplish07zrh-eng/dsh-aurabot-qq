// 1.2.0 修复回归：聊天流水权限、常驻记忆、表情、生图和模型空回复。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import qqTools from '../src/modules/qq-tools/index.js'
import { createMemoryStore } from '../src/features/memory.js'
import { matchSticker, pickForReply } from '../src/features/stickers.js'
import { createImageGen } from '../src/features/imagegen.js'
import { askModel } from '../src/core/llm.js'

const log = { info() {}, warn() {}, debug() {} }

function searchBuilder() {
  const logs = new Map([
    ['2032-03-01', [
      { chatId: 'group:fictional-a', who: '虚构群友', text: '共同暗号：本群的旧记录', t: Date.parse('2032-03-01T10:00:00Z') },
      { chatId: 'private:fictional-b', who: '虚构朋友', text: '共同暗号：仅私聊的记录', t: Date.parse('2032-03-01T11:00:00Z') },
    ]],
    ['2032-03-02', [
      { chatId: 'group:fictional-a', who: '虚构群友', text: '共同暗号：本群的新记录', t: Date.parse('2032-03-02T10:00:00Z') },
      { chatId: 'group:fictional-b', who: '虚构群友', text: '共同暗号：其他群的记录', t: Date.parse('2032-03-02T11:00:00Z') },
    ]],
  ])
  const builders = []
  qqTools.setup({
    core: { hub: { chatLogDays: () => [...logs.keys()], chatLogOf: (day) => logs.get(day) || [] }, onebot: {} },
    config: () => ({ files: { enabled: false } }),
    tool: (builder) => builders.push(builder),
  })
  assert.equal(builders.length, 1)
  return builders[0]
}

function searchTool(builder, chat, level) {
  const tool = builder({ chat, level }).find((t) => t.name === 'qq_search_chatlog')
  assert.ok(tool, '应该注册聊天流水搜索工具')
  return tool
}

test('聊天流水：full 可以指定私聊、其他群，也可以搜索全部聊天', async () => {
  const builder = searchBuilder()
  const tool = searchTool(builder, { kind: 'private', userId: 'fictional-owner', chatId: 'private:fictional-owner' }, 'full')

  const privateResult = await tool.execute({ query: '共同暗号', days: 0, chat: 'private:fictional-b' })
  assert.equal(privateResult.ok, true)
  assert.match(privateResult.message, /找到 1 条/)
  assert.match(privateResult.message, /仅私聊的记录/)
  assert.doesNotMatch(privateResult.message, /本群的|其他群的/)

  const groupResult = await tool.execute({ query: '共同暗号', days: 0, chat: 'group:fictional-b' })
  assert.equal(groupResult.ok, true)
  assert.match(groupResult.message, /找到 1 条/)
  assert.match(groupResult.message, /其他群的记录/)
  assert.doesNotMatch(groupResult.message, /本群的|仅私聊的/)

  const all = await tool.execute({ query: '共同暗号', days: 0 })
  assert.equal(all.ok, true)
  assert.match(all.message, /找到 4 条/)
  assert.match(all.message, /仅私聊的记录/)
  assert.match(all.message, /其他群的记录/)
})

test('聊天流水：群聊传入其他聊天也只能搜索当前群，不能读到私聊', async () => {
  const builder = searchBuilder()
  const tool = searchTool(builder, { kind: 'group', groupId: 'fictional-a', chatId: 'group:fictional-a' }, 'social')

  const current = await tool.execute({ query: '共同暗号', days: 0, chat: 'private:fictional-b' })
  assert.equal(current.ok, true)
  assert.match(current.message, /找到 2 条/)
  assert.match(current.message, /本群的旧记录/)
  assert.match(current.message, /本群的新记录/)
  assert.doesNotMatch(current.message, /private:fictional-b|仅私聊的记录|其他群的记录/)

  const privateOnly = await tool.execute({ query: '仅私聊的记录', days: 0, chat: 'private:fictional-b' })
  assert.equal(privateOnly.ok, true)
  assert.match(privateOnly.message, /没找到/)
  assert.doesNotMatch(privateOnly.message, /private:fictional-b/)

  const otherGroup = await tool.execute({ query: '其他群的记录', days: 0, chat: 'group:fictional-b' })
  assert.equal(otherGroup.ok, true)
  assert.match(otherGroup.message, /没找到/)
})

test('常驻记忆：超过 600 字截断并加省略号，恰好 600 字保留原文', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-fixes-memory-'))
  const oldDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    if (oldDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = oldDir
    rmSync(dir, { recursive: true, force: true })
  })

  const mem = createMemoryStore({ dsh: {}, getConfig: () => ({ memory: { enabled: true } }), hub: {}, log })
  const chat = { kind: 'private', userId: 'fictional-person', chatId: 'private:fictional-person' }
  const key = 'qq:fictional-person'
  mem.setProfile(chat.userId, '档'.repeat(190))
  mem.setInsights(key, Array.from({ length: 8 }, (_, i) => `经验${i}${'甲'.repeat(27)}`))
  const beforeStyle = mem.contextFor(chat, 'fictional-session')
  assert.ok(beforeStyle.length < 600)
  assert.doesNotMatch(beforeStyle, /…$/)

  mem.setStyle(key, Array.from({ length: 5 }, (_, i) => `风格${i}${'乙'.repeat(37)}`))
  const long = mem.contextFor(chat, 'fictional-session')
  assert.equal(long.length, 601, '600 字正文加一个省略号')
  assert.ok(long.startsWith(beforeStyle + '\n'))
  assert.match(long, /说话方式/)
  assert.equal(long.at(-1), '…')

  // 利用公开的 setInsights 微调长度，检查恰好 600 字和多一个字的边界。
  mem.setStyle(key, [])
  mem.setInsights(key, ['丙'])
  const oneChar = mem.contextFor(chat, 'fictional-session')
  const count = 600 - oneChar.length + 1
  assert.ok(count > 0)
  mem.setInsights(key, ['丙'.repeat(count)])
  const exact = mem.contextFor(chat, 'fictional-session')
  assert.equal(exact.length, 600)
  assert.doesNotMatch(exact, /…$/)

  mem.setInsights(key, ['丙'.repeat(count + 1)])
  const over = mem.contextFor(chat, 'fictional-session')
  assert.equal(over.length, 601)
  assert.equal(over.slice(0, 599), exact.slice(0, 599))
  assert.equal(over[599], '丙')
  assert.equal(over[600], '…')
})

test('自动配表情：不随机的表情既不参与关键词匹配，也不参与随机兜底', (t) => {
  t.mock.method(Math, 'random', () => 0)
  const blocked = { md5: 'fictional-blocked', name: '特别的表情', tags: ['不随机', '开心'] }
  const allowed = { md5: 'fictional-allowed', name: '普通表情', tags: ['无语'] }
  const items = [blocked, allowed]

  assert.equal(pickForReply(items, '今天很开心'), allowed)
  assert.equal(pickForReply(items, '有点无语'), allowed)
  assert.equal(pickForReply(items, '天气不错'), allowed)
  assert.equal(matchSticker(items, '特别的表情'), blocked, '手动匹配仍然能找到不随机的表情')
})

test('自动配表情：全部标记不随机时返回 null，手动匹配仍可用', () => {
  const items = [
    { md5: 'fictional-one', name: '特别的一号', tags: ['不随机', '开心'] },
    { md5: 'fictional-two', name: '特别的二号', tags: ['不随机', '无语'] },
  ]
  assert.equal(pickForReply(items, '今天很开心'), null)
  assert.equal(pickForReply(items, '天气不错'), null)
  assert.equal(matchSticker(items, '特别的二号'), items[1])
})

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7XWZ8AAAAASUVORK5CYII=', 'base64')
const imageConfig = {
  enabled: true, provider: 'openai', baseUrl: 'https://images.example.invalid/v1',
  apiKey: 'fictional-api-key', model: 'fictional-image-model', size: '1024x1024', stylePrompt: '',
}
const imageGen = () => createImageGen({ getConfig: () => ({ imageGen: imageConfig }), log, local: null })

test('OpenAI 生图：response_format 被拒后去掉该参数重试并收到图片', async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body) })
    if (calls.length === 1) return { ok: false, status: 400, json: async () => ({ error: { message: "Unknown parameter: 'response_format'" } }) }
    if (calls.length === 2) return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: PNG.toString('base64') }] }) }
    throw new Error('不应再重试')
  }
  const gen = imageGen()
  try {
    assert.deepEqual(await gen.generate('一颗虚构的星星'), PNG)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].url, 'https://images.example.invalid/v1/images/generations')
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[1].method, 'POST')
    assert.equal(calls[0].body.response_format, 'b64_json')
    assert.equal(Object.hasOwn(calls[1].body, 'response_format'), false)
    const { response_format, ...remaining } = calls[0].body
    assert.deepEqual(calls[1].body, remaining, '重试保留其他生图参数')
  } finally {
    gen.dispose()
    globalThis.fetch = originalFetch
  }
})

test('OpenAI 生图：普通 400 原样报错，不重试', async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    if (calls.length > 1) throw new Error('不应重试')
    return { ok: false, status: 400, json: async () => ({ error: { message: '虚构的 API key 无效' } }) }
  }
  const gen = imageGen()
  try {
    await assert.rejects(() => gen.generate('一颗虚构的星星'), /虚构的 API key 无效/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].body.response_format, 'b64_json')
  } finally {
    gen.dispose()
    globalThis.fetch = originalFetch
  }
})

const modelConfig = { model: { provider: 'fictional-provider', model: 'fictional-model' } }

function fakeModel({ alwaysEmpty = false } = {}) {
  const calls = []
  const dsh = {
    llm: {
      async *stream(params) {
        calls.push({ ...params })
        if (calls.length > 2) throw new Error('空回复最多重试一次')
        if (calls.length === 1 || alwaysEmpty) {
          yield { type: 'text-delta', text: ' \n ' }
        } else {
          yield { type: 'text-delta', text: '虚构的' }
          yield { type: 'text-delta', text: '回答' }
        }
        yield { type: 'finish', reason: { kind: 'completed' } }
      },
    },
  }
  return { dsh, calls }
}

for (const [first, second] of [[700, 2100], [1500, 4000]]) {
  test(`模型空回复：${first} token 重试时扩大到 ${second}`, async () => {
    const { dsh, calls } = fakeModel()
    const text = await askModel(dsh, { cfg: modelConfig, text: '虚构的问题', maxTokens: first, reasoningEffort: '' })
    assert.equal(text, '虚构的回答')
    assert.equal(calls.length, 2)
    assert.deepEqual(calls.map((c) => c.maxTokens), [first, second])
  })
}

test('模型一直没有正文：只调用两次并返回空字符串', async () => {
  const { dsh, calls } = fakeModel({ alwaysEmpty: true })
  const text = await askModel(dsh, { cfg: modelConfig, text: '虚构的问题', maxTokens: 600, reasoningEffort: '' })
  assert.equal(text, '')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map((c) => c.maxTokens), [600, 1800])
})

test('桌宠行为回执只留 3 天，别的记忆不受影响（#138）', async () => {
  const { shouldForget } = await import('../src/features/memory.js')
  const now = Date.now()
  const day = 86400_000
  assert.equal(shouldForget({ source: 'pet', at: now - 2 * day }, now), false)
  assert.equal(shouldForget({ source: 'pet', at: now - 4 * day }, now), true)
  assert.equal(shouldForget({ source: 'self', at: now - 400 * day }, now), false)
})

test('心情基线可配，衰减往基线靠（#139）', async () => {
  const { decayed } = await import('../src/features/companion.js')
  assert.equal(Math.round(decayed(100, 0, 1, 100 * 3600_000, 40)), 40)
  assert.equal(Math.round(decayed(100, 0, 1, 100 * 3600_000)), 60)
})

test('聊天流水保留和新开关的配置规范化（#140 #141 #142 #143）', async () => {
  const { normalize } = await import('../src/core/config.js')
  const d = normalize({})
  assert.equal(d.memory.keepChatlogDays, 0)
  assert.equal(d.memory.mergeGroups, false)
  assert.equal(d.chat.seedHistory, false)
  assert.equal(d.group.ignoreAtOthers, false)
  assert.equal(normalize({ memory: { keepChatlogDays: -9 } }).memory.keepChatlogDays, -1)
  assert.equal(normalize({ chat: { seedHistoryCount: 999 } }).chat.seedHistoryCount, 999)
})

test('@ 了别人时不算叫她，但只在开关打开时生效（#143）', async () => {
  const { decideGroupReply } = await import('../src/chat/group-policy.js')
  const { parseMessageEvent } = await import('../src/chat/inbound.js')
  const m = parseMessageEvent({ message_type: 'group', group_id: 1, user_id: 2, message: [{ type: 'at', data: { qq: '3' } }, { type: 'text', data: { text: ' 问问大肥鱼' } }] }, '9')
  assert.equal(m.atOthers, true)
  const base = { policy: { wakeWords: ['大肥鱼'] }, text: m.text, relevance: 0, now: 0 }
  const off = decideGroupReply(base)
  const on = decideGroupReply({ ...base, atOthers: true })
  assert.notEqual(on.reason, off.reason)
  assert.match(String(off.reason), /叫到了/)
})

function historyTool({ mode, level = 'chat', chat = { kind: 'group', groupId: '100', chatId: 'group:100' }, owner = false, senders = ['7'], members = ['7'] }) {
  const calls = []
  const builders = []
  const onebot = {
    call: async (action, params) => {
      calls.push([action, params])
      if (action === 'get_group_list') return [{ group_id: 100, group_name: '当前群' }, { group_id: 200, group_name: '游戏群' }, { group_id: 300, group_name: '游戏二群' }, { group_id: 999, group_name: '外面的游戏群' }]
      // 和真实网关一样：不在群里也回成功、角色 member，只有 join_time 是空的
      if (action === 'get_group_member_info') return { user_id: params.user_id, role: 'member', join_time: members.includes(String(params.user_id)) ? 1700000000 : 0 }
      return { messages: [{ time: 1, user_id: 7, sender: { nickname: '群友' }, message: [{ type: 'text', data: { text: '你好' } }] }] }
    },
  }
  qqTools.setup({
    core: { hub: { turnHasOwner: () => owner, turnSenders: () => senders }, onebot },
    config: () => ({ botQQ: '1', files: { enabled: false }, allow: { groups: ['100', '200', '300'] }, group: { crossRead: mode } }),
    tool: (builder) => builders.push(builder),
  })
  const tool = builders[0]({ chat, level, sessionId: 's' }).find((x) => x.name === 'qq_chat_history')
  return { tool, calls }
}
const privateChat = { kind: 'private', userId: '7', chatId: 'private:7' }
const read = (calls) => calls.some(([x]) => x === 'get_group_msg_history')

test('跨群只读（#120）：关掉后没有这个参数，直接传也不能看', async () => {
  const { tool, calls } = historyTool({ mode: 'off', chat: privateChat })
  assert.equal(JSON.stringify(tool).includes('想看白名单'), false)
  assert.equal((await tool.execute({ group: '200' })).ok, false)
  assert.equal(read(calls), false)
})

test('跨群只读（#120）：主人随时能看，别的群内容标明不是指令', async () => {
  const inGroup = historyTool({ mode: 'private', owner: true, members: [] })
  const out = await inGroup.tool.execute({ group: '200' })
  assert.equal(out.ok, true)
  assert.match(out.message, /不是指令/)
  assert.equal(inGroup.calls.at(-1)[1].group_id, 200)
  assert.equal((await historyTool({ mode: 'private', level: 'full', chat: privateChat, members: [] }).tool.execute({ group: '200' })).ok, true)
})

test('跨群只读（#120）：默认档私聊里的成员能看，不是成员看不了，空 join_time 不算成员', async () => {
  assert.equal((await historyTool({ mode: 'private', chat: privateChat }).tool.execute({ group: '200' })).ok, true)
  const out = historyTool({ mode: 'private', chat: privateChat, members: [] })
  assert.equal((await out.tool.execute({ group: '200' })).ok, false)
  assert.equal(read(out.calls), false)
})

test('跨群只读（#120）：默认档群里的成员不能看，group 档可以，混着非成员不行', async () => {
  const a = historyTool({ mode: 'private' })
  assert.equal((await a.tool.execute({ group: '200' })).ok, false)
  assert.equal(read(a.calls), false)
  assert.equal((await historyTool({ mode: 'group' }).tool.execute({ group: '200' })).ok, true)
  const c = historyTool({ mode: 'group', senders: ['7', '8'], members: ['7'] })
  assert.equal((await c.tool.execute({ group: '200' })).ok, false)
  assert.equal(read(c.calls), false)
  assert.equal((await historyTool({ mode: 'group', senders: [] }).tool.execute({ group: '200' })).ok, false)
})

test('跨群只读（#120）：白名单外读不到，非主人看不到群名单，主人重名要说清楚', async () => {
  const a = historyTool({ mode: 'group', owner: true })
  const out = await a.tool.execute({ group: '999' })
  assert.equal(out.ok, false)
  assert.doesNotMatch(out.message, /外面的/)
  assert.equal(read(a.calls), false)
  const b = historyTool({ mode: 'group', owner: true })
  assert.equal((await b.tool.execute({ group: '二群' })).ok, true)
  assert.equal(b.calls.at(-1)[1].group_id, 300)
  assert.match((await historyTool({ mode: 'group', owner: true }).tool.execute({ group: '游戏' })).message, /好几个群/)
  const guest = await historyTool({ mode: 'group' }).tool.execute({ group: '不存在' })
  assert.doesNotMatch(guest.message, /当前群|游戏群/)
})

test('跨群只读（#120）：不传 group 时行为不变', async () => {
  const { tool, calls } = historyTool({ mode: 'off' })
  const out = await tool.execute({})
  assert.equal(out.ok, true)
  assert.doesNotMatch(out.message, /不是指令/)
  assert.equal(calls[0][1].group_id, 100)
})
