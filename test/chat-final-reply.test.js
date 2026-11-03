// 回归：一轮结束时只发最后一条 assistant 消息的文字；带工具调用的过程性发言不能当回复补发。
// 否则模型在调工具前写的计划/心里话（例如「我先想想怎么回」）会被原样发到 QQ。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assistantReplyText } from '../src/chat/hub.js'

const msg = (content) => ({ content })

test('只取 text 块：reasoning 块不外发', () => {
  assert.equal(assistantReplyText(msg([{ type: 'reasoning', text: '心里想：先哄一下' }, { type: 'text', text: '嗯 好' }])), '嗯 好')
})

test('带工具调用的过程性发言不算回复', () => {
  assert.equal(assistantReplyText(msg([{ type: 'text', text: '我先想想怎么回' }, { type: 'tool-call', name: 'x', arguments: '{}' }])), '')
  assert.equal(assistantReplyText(msg([{ type: 'tool_use', name: 'x' }])), '')
})

test('空消息 / 空文字返回空（宁可沉默，不拿上一条补）', () => {
  assert.equal(assistantReplyText(null), '')
  assert.equal(assistantReplyText({}), '')
  assert.equal(assistantReplyText(msg([])), '')
  assert.equal(assistantReplyText(msg([{ type: 'text', text: '   ' }])), '')
})

test('多个 text 块按行拼接', () => {
  assert.equal(assistantReplyText(msg([{ type: 'text', text: '第一行' }, { type: 'text', text: '第二行' }])), '第一行\n第二行')
})
