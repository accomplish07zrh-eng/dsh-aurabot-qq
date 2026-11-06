// 网关未就绪时的发送队列：不丢确定没发出去的消息，连接后补发；超时/不确定不重复发。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-outbox-'))

const { createOutbox } = await import('../src/onebot/outbox.js')
const log = { info () {}, warn () {}, debug () {} }

function make (o = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-outbox-case-'))
  return createOutbox({ log, now: () => 1_000_000, file: join(dir, 'outbox', 'queue.json'), ...o })
}

test('确定没发出去的消息入队，连上后补发并删除', async () => {
  let now = 1_000_000
  const q = make({ now: () => now })
  const r = q.add({ action: 'send_private_msg', params: { user_id: 1, message: [{ type: 'text', data: { text: 'hi' } }] }, chatId: 'private:1', note: '回复' })
  assert.equal(r.ok, true)
  assert.equal(q.status().count, 1)

  let calls = 0
  const failed = await q.flush(async () => { calls++; throw Object.assign(new Error('ECONNREFUSED'), { transport: true }) })
  assert.equal(calls, 1)
  assert.equal(failed.left, 1, '网关还没好时留在队列里')
  now += 2_000

  const ok = await q.flush(async () => { calls++; return { message_id: 9 } })
  assert.equal(calls, 2)
  assert.equal(ok.sent, 1)
  assert.equal(q.status().count, 0)
})

test('超时/不确定的发送直接丢弃，避免重复', async () => {
  const q = make()
  q.add({ action: 'send_private_msg', params: { user_id: 1 }, note: '可能已发出' })
  const r = await q.flush(async () => { throw Object.assign(new Error('超时'), { uncertain: true }) })
  assert.equal(r.dropped, 1)
  assert.equal(q.status().count, 0)
})

test('过期消息不补发', async () => {
  let now = 2_000_000
  const q = createOutbox({ log, now: () => now })
  q.add({ action: 'send_group_msg', params: { group_id: 1 }, kind: 'proactive', note: '过期' })
  now += 61_000
  const r = await q.flush(async () => { throw new Error('不应该调用') })
  assert.equal(r.sent, 0)
  assert.equal(q.status().count, 0)
})

test('队列落盘可恢复，且只接受消息类 action', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-outbox-file-'))
  const file = join(dir, 'outbox', 'queue.json')
  const q = createOutbox({ log, file })
  assert.equal(q.add({ action: 'get_group_info', params: {} }).ok, false)
  q.add({ action: 'send_group_msg', params: { group_id: 1, message: [] }, chatId: 'group:1' })
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.length, 1)
  const q2 = createOutbox({ log, file })
  assert.equal(q2.status().count, 1, '新实例能读回队列')
})
