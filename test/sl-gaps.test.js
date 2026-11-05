import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMessageEvent, cardText } from '../src/chat/inbound.js'
import { decideGroupReply } from '../src/chat/group-policy.js'
import { normalize } from '../src/core/config.js'
import contacts from '../src/modules/contacts/index.js'
import qqTools from '../src/modules/qq-tools/index.js'
import { QQ_API, paramsOf } from '../src/modules/qq-api/actions.js'
import qqApi, { refusal, pickParams } from '../src/modules/qq-api/index.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { startMockOneBot } from './helpers/mock-onebot.js'

const OWNER = '10000001'
const BOT = '20000002'
const OTHER = '30000003'
const ownerChat = { kind: 'private', userId: OWNER, groupId: '', chatId: `private:${OWNER}` }
const otherChat = { kind: 'private', userId: OTHER, groupId: '', chatId: `private:${OTHER}` }
const groupChat = { kind: 'group', userId: OTHER, groupId: '44444444', chatId: 'group:44444444' }
const groupEvent = (patch = {}) => ({ post_type: 'request', request_type: 'group', sub_type: 'add', user_id: Number(OTHER), group_id: 44444444, flag: '原样:flag/1', comment: '你好', ...patch })

function setupContacts({ cfg = {}, allOwner = true, callImpl } = {}) {
  let config = normalize({ ownerQQ: OWNER, botQQ: BOT, enabled: true, dryRun: false, ...cfg })
  let owner = allOwner
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-sl-contacts-'))
  const sent = [], calls = []
  let listener, builder
  contacts.setup({
    core: { hub: { turnSendersAllOwner: () => owner }, onebot: { call: async (action, params) => { calls.push({ action, params }); return callImpl?.(action, params) } } },
    config: () => config,
    dataDir: (...parts) => join(dir, ...parts),
    log: { warn() {} },
    on: (_name, fn) => { listener = fn },
    tool: (fn) => { builder = fn },
    sendText: async (chatId, text) => { sent.push({ chatId, text }) },
  })
  return {
    event: (ev) => listener(ev), sent, calls,
    tools: (chat) => Object.fromEntries(builder({ chat, sessionId: 's' }).map((tool) => [tool.name, tool])),
    set: (patch) => { config = normalize({ ...config, ...patch }) },
    setOwner: (value) => { owner = value },
  }
}

test('加群申请和邀请：通知、去重、列出并原样处理 flag', async () => {
  const s = setupContacts()
  const a = groupEvent()
  const b = groupEvent({ sub_type: 'invite', flag: 'invite:2', user_id: 50000005, group_id: 55555555, invited_id: Number(BOT), comment: '' })
  const c = groupEvent({ sub_type: 'invite', flag: 'invite:3', invited_id: 60000006, comment: '' })
  s.event(a)
  s.event(a)
  s.event(b)
  s.event(c)
  s.event(groupEvent({ flag: '' }))
  s.event(groupEvent({ sub_type: 'unknown', flag: 'ignored' }))
  assert.equal(s.sent.length, 3)
  assert.equal(s.sent[0].chatId, `private:${OWNER}`)
  assert.match(s.sent[0].text, /30000003.*申请.*44444444/)
  assert.match(s.sent[1].text, /50000005.*邀请我.*55555555/)
  assert.match(s.sent[2].text, /60000006/)
  const tools = s.tools(ownerChat)
  const list = await tools.qq_list_group_requests.execute({})
  assert.match(list.message, /原样:flag\/1/)
  assert.match(list.message, /invite:2/)
  assert.equal((await tools.qq_handle_group_request.execute({ approve: true })).ok, false)
  assert.equal((await tools.qq_handle_group_request.execute({ flag: a.flag, approve: true })).ok, true)
  assert.equal((await tools.qq_handle_group_request.execute({ flag: b.flag, approve: false, reason: '暂不加入' })).ok, true)
  assert.deepEqual(s.calls, [
    { action: 'set_group_add_request', params: { flag: a.flag, sub_type: 'add', approve: true } },
    { action: 'set_group_add_request', params: { flag: b.flag, sub_type: 'invite', approve: false, reason: '暂不加入' } },
  ])
  const remaining = await tools.qq_list_group_requests.execute({})
  assert.doesNotMatch(remaining.message, /invite:2|原样:flag/)
  assert.match(remaining.message, /invite:3/)
})

test('加群申请：仅主人、权限变化、试运行和失败重试', async () => {
  let fail = true
  const s = setupContacts({ cfg: { profilePerms: { qqFriendRequest: 'all' } }, callImpl: () => { if (fail) throw new Error('网关失败') } })
  s.event(groupEvent())
  assert.equal(s.tools(otherChat).qq_handle_group_request, undefined)
  assert.equal(s.tools(groupChat).qq_list_group_requests, undefined)
  const { qq_handle_group_request: handle, qq_list_group_requests: list } = s.tools(ownerChat)
  s.setOwner(false)
  assert.equal((await list.execute({})).ok, false)
  assert.equal((await handle.execute({ approve: true })).ok, false)
  s.setOwner(true)
  s.set({ profilePerms: { qqFriendRequest: 'off' } })
  assert.equal((await handle.execute({ approve: true })).ok, false)
  assert.equal(s.tools(ownerChat).qq_handle_group_request, undefined)
  s.set({ profilePerms: { qqFriendRequest: 'owner' }, dryRun: true })
  assert.match((await handle.execute({ approve: true })).message, /试运行/)
  assert.equal(s.calls.length, 0)
  s.set({ dryRun: false })
  assert.match((await handle.execute({ approve: true })).message, /网关失败/)
  assert.match((await list.execute({})).message, /原样:flag/)
  fail = false
  assert.equal((await handle.execute({ approve: false })).ok, true)
  assert.match((await list.execute({})).message, /没有待处理/)
  const off = setupContacts({ cfg: { profilePerms: { qqFriendRequest: 'off' } } })
  off.event(groupEvent())
  assert.equal(off.sent.length, 0)
  off.set({ profilePerms: { qqFriendRequest: 'owner' } })
  assert.match((await off.tools(ownerChat).qq_list_group_requests.execute({})).message, /原样:flag/)
  const missing = setupContacts()
  missing.event(groupEvent({ user_id: 0, group_id: 0 }))
  assert.match((await missing.tools(ownerChat).qq_list_group_requests.execute({})).message, /未知用户.*未知群/)
})

test('加群申请并发处理只发一次', async () => {
  let release
  const wait = new Promise((resolve) => { release = resolve })
  const s = setupContacts({ callImpl: () => wait })
  s.event(groupEvent())
  const handle = s.tools(ownerChat).qq_handle_group_request
  const first = handle.execute({ approve: true })
  assert.match((await handle.execute({ approve: true })).message, /正在处理/)
  assert.equal(s.calls.length, 1)
  release()
  assert.equal((await first).ok, true)
})

test('解析闪传、@全体和结果编号，不误认 @机器人', () => {
  const p = parseMessageEvent({ message_type: 'group', group_id: 4, user_id: 3, message: [
    { type: 'at', data: { qq: 'all' } },
    { type: 'flash_file', data: { title: '资料.zip' } },
    { type: 'face', data: { id: '358', resultId: '3' } },
    { type: 'face', data: { id: '359', resultId: 'rock-id' } },
    { type: 'face', data: { id: '10', resultId: 0 } },
  ] }, BOT, { faceName: (id) => String(id) === '10' ? '笑' : '' })
  assert.equal(p.mentioned, false)
  assert.equal(p.atOthers, false)
  assert.match(p.text, /@全体成员/)
  assert.match(p.text, /\[闪传文件：资料\.zip\]/)
  assert.match(p.text, /\[骰子：3\]/)
  assert.match(p.text, /\[猜拳：rock-id\]/)
  assert.match(p.text, /\[笑：0\]/)
  const decision = decideGroupReply({ policy: { wakeWords: ['全体成员'], interjectChance: 0 }, mentioned: p.mentioned, text: p.wakeText, now: Date.now() })
  assert.equal(decision.reply, false)
  const named = parseMessageEvent({ message_type: 'group', message: [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: '大肥鱼你好' } }] }, BOT)
  assert.equal(decideGroupReply({ policy: { wakeWords: ['大肥鱼'] }, mentioned: named.mentioned, text: named.wakeText, now: Date.now() }).reply, true)
  const other = parseMessageEvent({ message_type: 'group', message: [{ type: 'at', data: { qq: BOT } }, { type: 'at', data: { qq: OTHER } }] }, BOT)
  assert.equal(other.mentioned, true)
  assert.equal(other.atOthers, true)
})

test('解析位置和联系人卡片，只提取核对到的字段，分享卡片保留原逻辑', () => {
  assert.equal(cardText({ app: 'com.tencent.map', meta: { Location: { title: '公园', address: '北门', lat: '1', lng: '2' } } }), '[位置：公园 北门]')
  assert.equal(cardText({ app: 'com.tencent.map', meta: { Location: { address: '北门' } } }), '[位置：北门]')
  assert.equal(cardText({ app: 'com.tencent.contact.lua', meta: { contact: { type: 'qq', id: '12345', name: '未核对' } } }), '[联系人：12345]')
  assert.equal(cardText({ app: 'com.tencent.contact.lua', meta: { contact: {} } }), '[联系人]')
  assert.equal(cardText(JSON.stringify({ meta: { news: { title: '标题', jumpUrl: 'https://example.com/?x=1' } } })), '[分享卡片：标题 https://example.com/]')
  assert.equal(cardText('坏 JSON'), '[卡片消息]')
})

test('临时私聊保存来源群，普通好友不带来源群', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-sl-temp-'))
  process.env.AURABOT_DATA_DIR = join(root, 'data')
  process.env.AURABOT_WORKSPACE = join(root, 'workspace')
  const { createHub } = await import('../src/chat/hub.js')
  const fake = createFakeDsh({ brain: async () => '' })
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: OWNER, botQQ: BOT, allow: { private: [OTHER], groups: [] }, stickers: { collect: false } })
  const calls = []
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg, log: { debug() {}, info() {}, warn() {}, error() {} }, onebot: { call: async (action, params) => { calls.push({ action, params }); return { message_id: 1 } } }, hooks: { message: () => true } })
  t.after(() => { hub.dispose(); fake.dispose() })
  const ev = { post_type: 'message', message_type: 'private', sub_type: 'group', self_id: Number(BOT), user_id: Number(OTHER), sender: { user_id: Number(OTHER), group_id: 44444444 }, message: [{ type: 'text', data: { text: '你好' } }] }
  const parsed = parseMessageEvent(ev, BOT)
  assert.equal(parseMessageEvent({ ...ev, sub_type: 'friend' }, BOT).sourceGroupId, '')
  assert.equal(parseMessageEvent({ ...ev, sender: { group_id: 0 } }, BOT).sourceGroupId, '')
  assert.equal(parsed.chatId, `private:${OTHER}`)
  assert.equal(parsed.groupId, '')
  assert.equal(parsed.sourceGroupId, '44444444')
  await hub.onMessage(ev)
  await hub.sendSegments(`private:${OTHER}`, [{ type: 'text', data: { text: '好' } }], '好')
  assert.deepEqual(calls.at(-1), { action: 'send_private_msg', params: { user_id: Number(OTHER), group_id: 44444444, message: [{ type: 'text', data: { text: '好' } }] } })
  await hub.onMessage({ ...ev, sender: { ...ev.sender, group_id: 55555555 } })
  await hub.sendSegments(`private:${OTHER}`, [{ type: 'dice', data: {} }], '骰子')
  assert.equal(calls.at(-1).params.group_id, 55555555)
  const card = setupTools({ chat: otherChat, hub }).tools.qq_send_card
  assert.equal((await card.execute({ type: 'dice' })).ok, true)
  assert.equal(calls.at(-1).params.group_id, 55555555)
  assert.deepEqual(calls.at(-1).params.message, [{ type: 'dice', data: {} }])
  await hub.onMessage({ ...ev, sub_type: 'friend' })
  await hub.sendSegments(`private:${OTHER}`, [{ type: 'text', data: { text: '好友' } }], '好友')
  assert.equal('group_id' in calls.at(-1).params, false)
  await hub.sendSegments(groupChat.chatId, [{ type: 'text', data: { text: '群' } }], '群')
  assert.equal(calls.at(-1).action, 'send_group_msg')
  assert.equal(calls.at(-1).params.group_id, 44444444)
})

function setupTools({ chat = otherChat, level = 'social', cfg = {}, hub = {}, callImpl } = {}) {
  const calls = [], sent = []
  const config = { enabled: true, dryRun: false, botQQ: BOT, group: { crossRead: 'private' }, allow: { groups: ['44444444', '55555555'] }, files: { enabled: false }, ...cfg }
  let builder
  qqTools.setup({
    core: {
      hub: { turnHasOwner: () => false, turnSenders: () => [OTHER], sendSegments: async (...args) => { sent.push(args); return { message_id: 99 } }, ...hub },
      onebot: { call: async (action, params) => { calls.push({ action, params }); return callImpl?.(action, params) } },
    },
    config: () => config,
    tool: (fn) => { builder = fn },
  })
  return { config, calls, sent, tools: Object.fromEntries(builder({ chat, level, sessionId: 's' }).map((tool) => [tool.name, tool])) }
}

test('卡片工具在群和普通私聊可用，按 SnowLuma 字段发送', async () => {
  const s = setupTools()
  const tool = s.tools.qq_send_card
  const cases = [
    [{ type: 'share', url: 'https://example.com', title: '链接', content: '介绍', image: 'https://example.com/a.png' }, { type: 'share', data: { url: 'https://example.com', title: '链接', content: '介绍', image: 'https://example.com/a.png' } }],
    [{ type: 'music', music_type: 'qq', id: '42', title: '不会改变平台音乐' }, { type: 'music', data: { type: 'qq', id: '42' } }],
    [{ type: 'music', music_type: 'custom', url: 'https://x', audio: 'https://x/a.mp3', title: '歌', content: '歌手' }, { type: 'music', data: { type: 'custom', url: 'https://x', audio: 'https://x/a.mp3', title: '歌', content: '歌手' } }],
    [{ type: 'location', lat: 0, lon: 120.5, title: '公园', content: '北门' }, { type: 'location', data: { lat: '0', lon: '120.5', title: '公园', content: '北门' } }],
    [{ type: 'contact', contact_type: 'group', id: '44444444' }, { type: 'contact', data: { type: 'group', id: '44444444' } }],
    [{ type: 'dice' }, { type: 'dice', data: {} }],
    [{ type: 'rps' }, { type: 'rps', data: {} }],
  ]
  for (const [args, segment] of cases) {
    assert.equal((await tool.execute(args)).ok, true, JSON.stringify(args))
    assert.equal(s.sent.at(-1)[0], otherChat.chatId)
    assert.deepEqual(s.sent.at(-1)[1], [segment])
    assert.equal(s.sent.at(-1)[3].throwOnError, true)
  }
  const g = setupTools({ chat: groupChat })
  assert.equal((await g.tools.qq_send_card.execute({ type: 'rps' })).ok, true)
  assert.equal(g.sent[0][0], groupChat.chatId)
  for (const bad of [{ type: 'share', title: '缺链接' }, { type: 'music', music_type: 'custom', url: 'x' }, { type: 'location', lat: 91, lon: 0 }, { type: 'contact', contact_type: 'qq', id: 'abc' }, { type: 'bad' }]) {
    assert.equal((await tool.execute(bad)).ok, false)
  }
  assert.equal(s.sent.length, cases.length)
})

test('卡片发送失败和试运行不报成功', async () => {
  const dry = setupTools({ cfg: { dryRun: true }, hub: { sendSegments: async () => null } })
  assert.match((await dry.tools.qq_send_card.execute({ type: 'dice' })).message, /试运行/)
  const blocked = setupTools({ hub: { sendSegments: async () => null } })
  assert.equal((await blocked.tools.qq_send_card.execute({ type: 'dice' })).ok, false)
  const failed = setupTools({ hub: { sendSegments: async () => { throw new Error('发送失败') } } })
  assert.match((await failed.tools.qq_send_card.execute({ type: 'dice' })).message, /发送失败/)
})

test('历史记录以消息 ID 向前翻页，排除锚点并返回最早 ID', async () => {
  const records = [1, 2, 3, 4, 5].map((id) => ({ message_id: id, time: id, user_id: Number(OTHER), sender: { nickname: '朋友' }, message: [{ type: 'text', data: { text: `消息${id}` } }] }))
  const impl = (action, params) => {
    if (action === 'get_group_msg_history' || action === 'get_friend_msg_history') {
      const end = params.message_id ? records.findIndex((x) => x.message_id === params.message_id) + 1 : records.length
      return { messages: records.slice(Math.max(0, end - params.count), end) }
    }
    return null
  }
  for (const chat of [otherChat, groupChat]) {
    const s = setupTools({ chat, callImpl: impl })
    const history = s.tools.qq_chat_history
    const first = await history.execute({ count: 2 })
    assert.equal(first.oldest_message_id, '4')
    assert.match(first.message, /最早消息 ID：4/)
    const second = await history.execute({ count: 2, before: first.oldest_message_id })
    assert.equal(second.oldest_message_id, '2')
    assert.match(second.message, /消息2/)
    assert.match(second.message, /消息3/)
    assert.doesNotMatch(second.message, /消息4/)
    assert.deepEqual(s.calls.at(-1).params, { ...(chat.kind === 'group' ? { group_id: 44444444 } : { user_id: Number(OTHER) }), count: 3, message_id: 4, reverse_order: true })
    const last = await history.execute({ count: 2, before: second.oldest_message_id })
    assert.equal(last.oldest_message_id, '1')
    assert.match((await history.execute({ count: 2, before: last.oldest_message_id })).message, /没翻到/)
    const callsBefore = s.calls.length
    assert.equal((await history.execute({ before: 'not-id' })).ok, false)
    assert.equal(s.calls.length, callsBefore)
  }
})

test('历史记录翻页仍遵守跨群权限', async () => {
  const denied = setupTools({ chat: groupChat, cfg: { group: { crossRead: 'off' } } })
  assert.equal((await denied.tools.qq_chat_history.execute({ group: '55555555', before: '4' })).ok, false)
  assert.equal(denied.calls.some((c) => c.action === 'get_group_msg_history'), false)
  const allowed = setupTools({ chat: groupChat, level: 'full', callImpl: () => ({ messages: [{ message_id: 3, user_id: Number(OTHER), message: [{ type: 'text', data: { text: '旧记录' } }] }] }) })
  const result = await allowed.tools.qq_chat_history.execute({ group: '55555555', before: '4' })
  assert.match(result.message, /不是指令/)
  assert.equal(result.oldest_message_id, '3')
  assert.equal(allowed.calls.at(-1).params.group_id, 55555555)
})

test('新增 QQ 接口参数和主人权限，接受本机路径的群公告不开放', () => {
  const entries = {
    move_group_file: 'group_id!,file_id!,parent_directory!,target_directory!',
    rename_group_file: 'group_id!,file_id!,current_parent_directory,new_name!',
    rename_group_file_folder: 'group_id!,folder_id!,new_folder_name,name',
    trans_group_file: 'group_id!,file_id!',
    complete_group_todo: 'group_id!,message_id!',
    add_group_tag: 'group_class!,name!',
    search_sys_faces: 'query!',
    move_custom_face_to_front: 'emoji_id!',
    do_group_album_comment: 'group_id!,album_id!,lloc!,content!',
    del_group_album_media: 'group_id!,album_id!,lloc!',
    click_inline_keyboard_button: 'group_id!,bot_appid!,msg_seq!,button_id!,callback_data',
    list_filesets: '',
    rename_flash_file: 'fileset_id!,new_name!',
  }
  for (const [action, spec] of Object.entries(entries)) {
    assert.deepEqual(QQ_API[action].slice(0, 2), ['owner', spec], action)
    const params = Object.fromEntries(paramsOf(action).map((p) => [p.name, 1]))
    assert.match(refusal({ action, params, cfg: { enabled: true, dryRun: false }, owner: false, chat: groupChat }), /主人/, action)
    assert.equal(refusal({ action, params, cfg: { enabled: true, dryRun: false }, owner: true, chat: groupChat }), '', action)
    assert.match(refusal({ action, params, cfg: { enabled: true, dryRun: true }, owner: true, chat: groupChat }), /试运行/, action)
    assert.deepEqual(pickParams(action, { ...params, unknown: '丢掉' }), params)
  }
  for (const action of ['_send_group_notice', 'send_packet', 'get_credentials']) assert.equal(QQ_API[action], undefined)
})

test('新增 QQ 接口经工具调用时仍检查主人和试运行', async () => {
  let owner = false
  let build
  const cfg = { enabled: true, dryRun: false, qqApi: { enabled: true } }
  const calls = []
  qqApi.setup({
    core: { hub: { turnSendersAllOwner: () => owner }, onebot: { call: async (action, params) => { calls.push({ action, params }); return null } } },
    config: () => cfg, tool: (fn) => { build = fn }, rule() {}, log: { info() {} },
  })
  const call = build({ chat: groupChat, level: 'social', sessionId: 's' }).find((tool) => tool.name === 'qq_api_call')
  const args = { action: 'move_group_file', param: JSON.stringify({ group_id: 44444444, file_id: 'file', parent_directory: '/', target_directory: '/目录', extra: '忽略' }) }
  assert.equal((await call.execute(args)).ok, false)
  assert.equal(calls.length, 0)
  owner = true
  cfg.dryRun = true
  assert.equal((await call.execute(args)).ok, false)
  assert.equal(calls.length, 0)
  cfg.dryRun = false
  assert.equal((await call.execute(args)).ok, true)
  assert.deepEqual(calls, [{ action: 'move_group_file', params: { group_id: 44444444, file_id: 'file', parent_directory: '/', target_directory: '/目录' } }])
})

test('账号离线只记 warn，不走聊天通知或发送 QQ 消息', { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-sl-offline-'))
  process.env.AURABOT_DATA_DIR = root
  process.env.AURABOT_WORKSPACE = join(root, 'workspace')
  const mock = await startMockOneBot({ selfId: BOT })
  const fake = createFakeDsh({ brain: async () => '' })
  t.after(async () => { fake.dispose(); await mock.close() })
  writeFileSync(join(root, 'config.json'), JSON.stringify({ enabled: true, dryRun: false, setupDone: true, gateway: 'onebot', botQQ: BOT, ownerQQ: OWNER, snowluma: { httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, autoStart: false, autoAttach: false } }))
  const { apply } = await import('../src/host.js')
  const app = apply(fake.ctx)
  await app.ready
  assert.equal((await fake.call('/onebot/reconnect')).json().ok, true)
  let notices = 0
  app.hub.onNotice = async () => { notices++ }
  const sentBefore = mock.calls.filter((c) => c.action === 'send_private_msg' || c.action === 'send_group_msg').length
  mock.push({ post_type: 'notice', notice_type: 'bot_offline', user_id: Number(BOT), tag: '下线', message: '连接被关闭' })
  const deadline = Date.now() + 3000
  while (!app.logger.recent().some((e) => e.level === 'warn' && e.text.includes('QQ 账号离线')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  const log = app.logger.recent().find((e) => e.level === 'warn' && e.text.includes('QQ 账号离线'))
  assert.ok(log)
  assert.match(log.text, /下线.*连接被关闭/)
  assert.equal(notices, 0)
  assert.equal(mock.calls.filter((c) => c.action === 'send_private_msg' || c.action === 'send_group_msg').length, sentBefore)
})

test('卡片里的地址只认网址，本机路径发不出去', async () => {
  const { default: mod } = await import('../src/modules/qq-tools/index.js')
  const sent = []
  let build
  mod.setup({
    core: { hub: { sendSegments: async (c, seg) => { sent.push(seg); return { message_id: 1 } } }, onebot: { call: async () => ({}) } },
    config: () => ({ enabled: true, dryRun: false, ownerQQ: '1', allow: { private: [], groups: ['9'] }, files: {} }),
    tool: (fn) => { build = fn },
  })
  const card = build({ chat: { kind: 'group', groupId: '9', chatId: 'group:9' }, level: 'social', sessionId: 's' }).find((t) => t.name === 'qq_send_card')
  for (const image of ['C:\secret.png', 'file:///C:/secret.png', '/etc/passwd']) {
    assert.equal((await card.execute({ type: 'share', url: 'https://a.com', title: 't', image })).ok, false, image)
  }
  assert.equal(sent.length, 0)
  assert.equal((await card.execute({ type: 'share', url: 'https://a.com', title: 't', image: 'https://a.com/x.png' })).ok, true)
  assert.equal(sent.length, 1)
})

test('跨聊天发消息：群里只有主人那一轮能发，别人私聊没有这个工具', async () => {
  const { default: mod } = await import('../src/modules/qq-tools/index.js')
  const sent = []
  let owner = false
  let build
  mod.setup({
    core: { hub: { turnSendersAllOwner: () => owner, deliver: async (id, text) => { sent.push([id, text]); return {} } }, onebot: { call: async () => ({}) } },
    config: () => ({ enabled: true, ownerQQ: '1', allow: { private: ['2'], groups: ['9', '8'] }, files: {} }),
    tool: (fn) => { build = fn },
  })
  const group = { kind: 'group', groupId: '9', chatId: 'group:9' }
  const tool = build({ chat: group, level: 'social', sessionId: 's' }).find((t) => t.name === 'qq_send_message')
  assert.equal((await tool.execute({ target: 'group:8', text: '嗨' })).ok, false)
  assert.equal(sent.length, 0)
  owner = true
  assert.equal((await tool.execute({ target: 'group:8', text: '嗨' })).ok, true)
  assert.equal((await tool.execute({ target: 'private:2', text: '嗨' })).ok, true)
  assert.equal((await tool.execute({ target: 'group:7', text: '嗨' })).ok, false, '白名单外')
  assert.equal((await tool.execute({ target: 'group:9', text: '嗨' })).ok, false, '当前聊天')
  assert.deepEqual(sent.map((x) => x[0]), ['group:8', 'private:2'])
  const stranger = build({ chat: { kind: 'private', userId: '2', chatId: 'private:2' }, level: 'social', sessionId: 's' })
  assert.equal(stranger.find((t) => t.name === 'qq_send_message'), undefined)
})

