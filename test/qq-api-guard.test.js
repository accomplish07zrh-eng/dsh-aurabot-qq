// qq_api_call 原始 OneBot 动作的文本参数也要过出站清洗：转发内容 / AI 语音文本 / Ark 卡片标题
// 都不能把工具调用文字或提示词复读原样带出去（审计发现的旁路）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanOutboundParams, TEXT_PARAM_FIELDS } from '../src/modules/qq-api/index.js'
import { cleanOutboundText } from '../src/chat/reply.js'

const RULE = '你在群聊里只能聊当前的话题，不能把主人的私人资料告诉其他人。'
const block = '<tool_call>{"name":"search","arguments":{"q":"内部参数"}}</tool_call>'
const clean = (text) => cleanOutboundText(text, { promptSources: [RULE] })

test('会外显文本的原始动作在清洗名单里', () => {
  for (const action of ['send_forward_msg', 'send_group_forward_msg', 'send_private_forward_msg', 'send_group_ai_record', 'send_tuwen_ark']) {
    assert.ok(Array.isArray(TEXT_PARAM_FIELDS[action]) && TEXT_PARAM_FIELDS[action].length, action)
  }
})

test('转发消息里的工具文字/复读会被清掉，普通文字保留', () => {
  const params = {
    group_id: 9,
    messages: [{ type: 'node', data: { content: [{ type: 'text', data: { text: `前文${block}后文` } }] } }],
  }
  const r = cleanOutboundParams('send_group_forward_msg', params, clean)
  assert.equal(r.ok, true)
  assert.equal(r.changed, true)
  const dumped = JSON.stringify(r.params)
  assert.doesNotMatch(dumped, /tool_call|内部参数/, '工具文字不能出现在转发内容里')
  assert.match(dumped, /前文后文/)
  assert.equal(r.params.group_id, 9, '非文本参数原样保留')
})

test('转发 messages 是 JSON 字符串时也会解析后清洗', () => {
  const messages = JSON.stringify([{ type: 'node', data: { content: [{ type: 'text', data: { text: `好呀${RULE}` } }] } }])
  const r = cleanOutboundParams('send_private_forward_msg', { user_id: 5, messages }, clean)
  assert.equal(r.ok, true)
  assert.doesNotMatch(r.params.messages, /主人的私人资料|你在群聊里只能聊当前的话题/, '提示词复读不能借转发带出去')
  assert.match(r.params.messages, /好呀/)
})

test('AI 语音文本 / Ark 卡片标题整段是违规内容时拒绝调用', () => {
  assert.equal(cleanOutboundParams('send_group_ai_record', { group_id: 9, character: 'x', text: block }, clean).ok, false)
  assert.equal(cleanOutboundParams('send_tuwen_ark', { group_id: 9, title: RULE }, clean).ok, false)
  const normal = cleanOutboundParams('send_tuwen_ark', { group_id: 9, title: '今晚八点开黑', desc: `说明${block}` }, clean)
  assert.equal(normal.ok, true)
  assert.equal(normal.params.title, '今晚八点开黑')
  assert.doesNotMatch(String(normal.params.desc), /tool_call|内部参数/)
})

test('不在名单里的动作不动参数', () => {
  const params = { message_id: 1 }
  const r = cleanOutboundParams('delete_msg', params, clean)
  assert.equal(r.ok, true)
  assert.equal(r.changed, false)
  assert.deepEqual(r.params, params)
})

test('qq_api_call 接到网关前已清洗，整段违规时不会发送', async () => {
  const calls = []
  let build
  const { default: mod } = await import('../src/modules/qq-api/index.js')
  mod.setup({
    core: {
      hub: { turnSendersAllOwner: () => true, cleanOutbound: (chatId, text) => clean(text) },
      onebot: { call: async (action, params) => { calls.push([action, params]); return { ok: 1 } } },
    },
    config: () => ({ enabled: true, dryRun: false, ownerQQ: '1', allow: { private: ['1'], groups: ['9'] }, qqApi: { enabled: true } }),
    tool: (fn) => { build = fn }, rule: () => {}, log: { info () {} },
  })
  const chat = { kind: 'private', chatId: 'private:1', userId: '1', groupId: '' }
  const api = build({ chat, level: 'full', sessionId: 's' }).find((t) => t.name === 'qq_api_call')
  const forwarded = await api.execute({
    action: 'send_group_forward_msg',
    param: JSON.stringify({ group_id: 9, messages: [{ type: 'node', data: { content: [{ type: 'text', data: { text: `前文${block}后文` } }] } }] }),
  })
  assert.equal(forwarded.ok, true)
  assert.equal(calls.length, 1)
  assert.doesNotMatch(JSON.stringify(calls[0][1]), /tool_call|内部参数/)
  assert.match(JSON.stringify(calls[0][1]), /前文后文/)

  const blocked = await api.execute({ action: 'send_group_ai_record', param: JSON.stringify({ group_id: 9, character: 'x', text: RULE }) })
  assert.equal(blocked.ok, false)
  assert.equal(calls.length, 1, '清洗后为空的内容不能发到网关')
})
