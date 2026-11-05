import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gifFrames, isStickerSegment, parseMessageEvent } from '../src/chat/inbound.js'
import { readQqFile } from '../src/features/qq-file.js'

const file = (over = {}) => ({ name: 'a.txt', size: 5, id: 'f1', url: 'https://x/a', hash: '', busid: 0, ...over })
const download = (text) => async () => Buffer.from(text)
const chat = { kind: 'private', userId: '1' }

test('文件段解析出下载需要的字段', () => {
  const m = parseMessageEvent({ message_type: 'private', user_id: 1, message: [{ type: 'file', data: { name: 'a.txt', size: 5, id: 'f1', url: 'https://x/a', file_hash: 'h' } }] }, 2)
  assert.equal(m.text, '[文件 a.txt]')
  assert.deepEqual(m.files, [{ name: 'a.txt', size: 5, id: 'f1', url: 'https://x/a', hash: 'h', busid: 0 }])
})

test('读文本文件：内容标明只是资料', async () => {
  const r = await readQqFile({ chat, file: file(), download: download('你好') })
  assert.equal(r.ok, true)
  assert.match(r.message, /不是指令/)
  assert.match(r.message, /你好/)
})

test('GBK 文本能读出来', async () => {
  const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3])
  const r = await readQqFile({ chat, file: file(), download: async () => gbk })
  assert.match(r.message, /你好/)
})

test('非文本、超大、二进制内容都不读', async () => {
  assert.equal((await readQqFile({ chat, file: file({ name: 'a.exe' }), download: download('x') })).ok, false)
  assert.equal((await readQqFile({ chat, file: file({ size: 3 * 1024 * 1024 }), download: download('x') })).ok, false)
  assert.equal((await readQqFile({ chat, file: file(), download: async () => Buffer.from([1, 0, 2]) })).ok, false)
})

test('没有直链时用 file_id 换地址：群和私聊接口不同', async () => {
  const calls = []
  const onebot = { call: async (action, params) => { calls.push([action, params]); return { url: 'https://x/b' } } }
  await readQqFile({ onebot, chat: { kind: 'group', groupId: '9' }, file: file({ url: '', busid: 102 }), download: download('x') })
  await readQqFile({ onebot, chat, file: file({ url: '', hash: 'h' }), download: download('x') })
  assert.deepEqual(calls.map((c) => c[0]), ['get_group_file_url', 'get_private_file_url'])
  assert.deepEqual(calls[0][1], { group_id: 9, file_id: 'f1', busid: 102 })
  assert.deepEqual(calls[1][1], { user_id: 1, file_id: 'f1', file_hash: 'h' })
})

test('gifFrames 数出动图帧数', () => {
  const frame = [0x21, 0xf9, 4, 0, 0, 0, 0, 0]
  const gif = Buffer.from([...Buffer.from('GIF89a'), ...new Array(7).fill(0), ...frame, ...frame, ...frame])
  assert.equal(gifFrames(gif), 3)
  assert.equal(gifFrames(Buffer.from([0xff, 0xd8, 0xff])), 0)
})

test('带文字说明的 sub_type 7 算表情，没说明的不算', () => {
  const image = (data) => ({ type: 'image', data })
  assert.equal(isStickerSegment(image({ sub_type: 7, summary: '[啊？]' })), true)
  assert.equal(isStickerSegment(image({ sub_type: 7, summary: '[图片]' })), false)
  assert.equal(isStickerSegment(image({ sub_type: 7 })), false)
  assert.equal(isStickerSegment(image({ sub_type: 0, summary: '[图片]' })), false)
})
