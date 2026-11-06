import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanOutboundText } from '../src/chat/reply.js'

// dsh-time-context 每一步都会往会话里追加一条 snapshot user message，正文固定三行。
// 模型有时候会把它们当正文抄出来，甚至顺手改写（"otherwise-unqualified dates and times" → "amongst questions"）。
const injected =
  'Time sampled while preparing turn 56, step 4: 2026-11-06T18:36:36+08:00[Asia/Shanghai]\n' +
  'Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.\n' +
  'Elapsed since the preceding step context: unavailable.'

test('模型续写出的 time-context 注入行不发到 QQ，剩下的话留着', () => {
  const out =
    'Time sampled while preparing turn 56, step 5: 2026-11-06T18:36:37+08:00[Asia/Shanghai]\n' +
    'Browser time zone for this request: unavailable. Ask the user to clarify amongst questions.\n\n' +
    '存好啦\n\n170/318 还在跑'
  const cleaned = cleanOutboundText(out, { promptSources: ['人格长文', injected], userText: '存这个', ownerPrivate: true })
  assert.doesNotMatch(cleaned, /Time sampled while preparing|Browser time zone for this request/)
  // 改写过的半句靠指纹拦不住，按行硬剔才管用
  assert.doesNotMatch(cleaned, /amongst questions/)
  assert.match(cleaned, /存好啦/)
  assert.match(cleaned, /170\/318 还在跑/)
})

test('主人私聊里整轮只有注入复读时保持沉默', () => {
  const out = 'Time sampled while preparing turn 56, step 5: x\nBrowser time zone for this request: unavailable.'
  assert.equal(cleanOutboundText(out, { ownerPrivate: true }), '')
})

test('逐字复读注入原文也拦得住', () => {
  assert.equal(cleanOutboundText(injected, { promptSources: [injected], ownerPrivate: true }), '')
})

test('正常聊天不会被这三行规则误删', () => {
  assert.equal(cleanOutboundText('话可以多说两句啦\n我去吃饭', { ownerPrivate: true }), '话可以多说两句啦\n我去吃饭')
  assert.equal(
    cleanOutboundText('我在看 Time sampled while preparing turn 这个话题\n真的', { ownerPrivate: true }),
    '我在看 Time sampled while preparing turn 这个话题\n真的'
  )
})

test('注入行夹在中间时只删那几行，前后正文都留着', () => {
  const out = '先说一句\nBrowser time zone for this request: unavailable.\n后面还有'
  assert.equal(cleanOutboundText(out, { ownerPrivate: true }), '先说一句\n后面还有')
})
