// 把一轮回复拆成要发到 QQ 的一条条气泡：模型偶尔会把换行写成 HTML 的 <br>，
// 得当成真换行，别让标签原样发到对方那里。其余分条规则（一行一条、|||、<at:>、<voice>）不受影响。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReply } from '../src/chat/reply.js'

const values = (text) => parseReply(text).items.map((i) => i.value)

test('模型写 <br> 当换行处理，不把标签原样发出去', () => {
  assert.deepEqual(values('5070<br>5060ti 8g 显存是个坑'), ['5070', '5060ti 8g 显存是个坑'])
})

test('<br/>、<br />、大写 <BR> 都认', () => {
  for (const s of ['甲<br/>乙', '甲<br />乙', '甲<BR>乙', '甲<Br />乙']) {
    assert.deepEqual(values(s), ['甲', '乙'], s)
  }
})

test('语音里的 <br> 也转真换行（不然 TTS 会把 br 念出来）', () => {
  assert.deepEqual(parseReply('<voice>开头<br>结尾</voice>').items, [
    { kind: 'voice', value: '开头\n结尾' },
  ])
})

test('真的换行和 <br> 混用时顺序不变；<at:> 照旧留给发送层处理', () => {
  const raw = '第一句\n第二句<br><at:1987382642> 5070<br>显存是个坑'
  assert.deepEqual(values(raw), ['第一句', '第二句', '<at:1987382642> 5070', '显存是个坑'])
})

test('不带 <br> 的正常文本行为不变', () => {
  assert.deepEqual(values('一行\n二行'), ['一行', '二行'])
  assert.deepEqual(values('只有一句'), ['只有一句'])
  assert.equal(parseReply('').silent, true)
  assert.equal(parseReply('[沉默]').silent, true)
  assert.deepEqual(values('甲|||乙'), ['甲', '乙'])
})
