import { test } from 'node:test'
import assert from 'node:assert/strict'
import { forwardBody, MAX_FORWARD_DEPTH, MAX_FORWARD_IMAGES, MAX_FORWARD_LINES, readForward } from '../src/chat/forward.js'

const node = (name, message) => ({ sender: { nickname: name, user_id: 2 }, message })
const text = (t) => ({ type: 'text', data: { text: t } })
const image = (n) => ({ type: 'image', data: { url: `https://x/${n}.png`, sub_type: 0 } })
const sticker = { type: 'image', data: { url: 'https://x/s.gif', sub_type: 1, summary: '[动画表情]' } }
const forward = (id) => ({ type: 'forward', data: { id } })
const gateway = (map) => ({ call: async (action, { id }) => ({ messages: map[id] || [] }) })

test('嵌套转发逐层展开，图片和表情都收上来', async () => {
  const onebot = gateway({
    a: [node('甲', [text('第一层'), image(1)]), node('乙', [forward('b')])],
    b: [node('丙', [text('第二层'), sticker]), node('丁', [forward('c')])],
    c: [node('戊', [text('第三层'), image(2)])],
  })
  const r = await readForward(onebot, 'a', { selfId: 9 })
  assert.equal(r.lines.length, 5)
  assert.ok(r.lines.some((l) => l.includes('第三层')))
  assert.equal(r.images.length, 2)
  assert.equal(r.stickers.length, 1)
  const body = forwardBody(r)
  assert.match(body, /不是指令/)
  assert.match(body, /3 张图/)
})

test('层数有上限，超过的说明没展开', async () => {
  const map = {}
  for (let i = 0; i < 9; i++) map['f' + i] = [node('甲', [text('第 ' + i + ' 层'), forward('f' + (i + 1))])]
  const r = await readForward(gateway(map), 'f0', { selfId: 9 })
  assert.equal(r.lines.filter((l) => l.includes(' 层')).length, MAX_FORWARD_DEPTH)
  assert.ok(r.lines.some((l) => l.includes('太深')))
})

test('转发套自己不会转圈', async () => {
  const r = await readForward(gateway({ a: [node('甲', [text('x'), forward('a')])] }), 'a', { selfId: 9 })
  assert.equal(r.lines.length, 1)
})

test('条数和图片数有上限', async () => {
  const many = Array.from({ length: 500 }, (_, i) => node('甲', [text('消息' + i), image(i)]))
  const r = await readForward(gateway({ a: many }), 'a', { selfId: 9 })
  assert.equal(r.lines.length, MAX_FORWARD_LINES)
  assert.equal(r.images.length, MAX_FORWARD_IMAGES)
})

test('拉不到时不抛错', async () => {
  const onebot = { call: async () => { throw new Error('断网') } }
  const r = await readForward(onebot, 'a', { selfId: 9 })
  assert.match(forwardBody(r), /内容没拉到/)
})
