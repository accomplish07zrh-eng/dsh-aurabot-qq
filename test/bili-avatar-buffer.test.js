// B 站换头像除了图片网址，也要接受图片 Buffer（她画的图 / 聊天里收到的图）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBiliApi } from '../src/bili/api.js'

// 1x1 PNG
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000a49444154789c6360000002000154a24f6d0000000049454e44ae426082',
  'hex',
)

const okReply = () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: {} }) })

const make = (calls) => createBiliApi({
  getCookie: () => 'bili_jct=csrf123; SESSDATA=x',
  log: { warn() {} },
  fetchImpl: async (url, opts = {}) => {
    calls.push({ url: String(url), opts })
    return okReply()
  },
})

test('setFace：图片 Buffer 直接上传，不再去下载 URL', async () => {
  const calls = []
  await make(calls).setFace(PNG)
  assert.equal(calls.length, 1, '只应该发一次上传请求（不应先下载）')
  assert.match(calls[0].url, /\/x\/member\/web\/face\/update/)
  assert.ok(calls[0].opts.body instanceof FormData)
})

test('setFace：Buffer 不是图片要拒绝，且不发上传', async () => {
  const calls = []
  await assert.rejects(() => make(calls).setFace(Buffer.from('not an image')), /不是图片/)
  assert.equal(calls.length, 0)
})

test('setFace：Buffer 超过 2MB 要拒绝', async () => {
  const calls = []
  await assert.rejects(() => make(calls).setFace(Buffer.alloc(2 * 1024 * 1024 + 1, 1)), /2MB/)
  assert.equal(calls.length, 0)
})
