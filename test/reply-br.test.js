// 回归：模型把换行写成 HTML <br> 时当换行处理，别把标签原样发到 QQ（来自社区 PR #207）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReply } from '../src/chat/reply.js'

const texts = (r) => r.items.filter((i) => i.kind === 'text').map((i) => i.value)

test('常见 <br> 变体和普通换行一样拆成气泡', () => {
  assert.deepEqual(texts(parseReply('5070<br>5060ti 8g 显存是个坑')), ['5070', '5060ti 8g 显存是个坑'])
  for (const br of ['<br>', '<br/>', '<BR >', '<br />']) {
    assert.deepEqual(texts(parseReply(`a${br}b`)), texts(parseReply('a\nb')))
  }
})

test('不误删普通标签：<b>、<brk>、<br class> 原样保留', () => {
  assert.deepEqual(texts(parseReply('a<b>c')), ['a<b>c'])
  assert.deepEqual(texts(parseReply('a<brk>b')), ['a<brk>b'])
  assert.deepEqual(texts(parseReply('a<br class="x">b')), ['a<br class="x">b'])
})

test('和语音混排及语音里的换行都正确处理', () => {
  const r = parseReply('你好<br><voice>开头<br/>结尾</voice>')
  assert.deepEqual(texts(r), ['你好'])
  assert.deepEqual(r.items.filter((i) => i.kind === 'voice').map((i) => i.value), ['开头\n结尾'])
})

test('代码示例中的字面量保持原样，示例外的 br 仍换行', () => {
  assert.deepEqual(texts(parseReply('例如 `<br>` 表示换行<br>结束')), ['例如 <br> 表示换行', '结束'])
  assert.ok(texts(parseReply('示例：\n```html\n第一行<br>第二行\n```')).join('\n').includes('第一行<br>第二行'))
})
