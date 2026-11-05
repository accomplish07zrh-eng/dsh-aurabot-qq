import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApprovalRelay } from '../src/security/approval.js'

function setup({ over = {}, timeoutMs = 60_000 } = {}) {
  const sent = []
  const cfg = { enabled: true, dryRun: false, approvalViaQQ: true, ownerQQ: '1', ...over }
  const relay = createApprovalRelay({
    getConfig: () => cfg,
    deliver: async (chatId, text) => { sent.push({ chatId, text }) },
    chatOfSession: (id) => ({ own: 'private:1', group: 'group:9', other: 'private:2' })[id] || '',
    timeoutMs,
  })
  const req = (session = 'own', extra = {}) => ({ agent: { session: { id: session } }, toolName: 'bash', reason: '写工作区外的文件', ...extra })
  const never = () => new Promise(() => {})
  const unavailable = async () => 'unavailable'
  return { relay, sent, cfg, req, never, unavailable }
}
const tick = () => new Promise((r) => setTimeout(r, 5))

test('主人私聊回复「确认」批准这一次，消息不再交给她', async () => {
  const { relay, sent, req, unavailable } = setup()
  const p = relay.onRequest(req(), unavailable)
  await tick()
  assert.equal(sent[0].chatId, 'private:1')
  assert.match(sent[0].text, /bash[\s\S]*写工作区外的文件[\s\S]*确认/)
  assert.equal(relay.handleReply('private:1', '1', ' 确认 '), true)
  assert.equal(await p, 'allowed-once')
})

test('回复「取消」就拒绝', async () => {
  const { relay, req, unavailable } = setup()
  const p = relay.onRequest(req(), unavailable)
  relay.handleReply('private:1', '1', '取消')
  assert.equal(await p, 'rejected')
})

test('平时聊天的话不算批准，继续交给她', async () => {
  const { relay, req, unavailable } = setup()
  const p = relay.onRequest(req(), unavailable)
  for (const word of ['可以', 'ok', '好', '确认一下这个是什么', '不确认']) assert.equal(relay.handleReply('private:1', '1', word), false, word)
  assert.equal(relay.pending(), 1)
  relay.handleReply('private:1', '1', '确认')
  await p
})

test('别人和群里的回复都批不了', async () => {
  const { relay, req, unavailable } = setup()
  const p = relay.onRequest(req(), unavailable)
  assert.equal(relay.handleReply('private:2', '2', '确认'), false)
  assert.equal(relay.handleReply('group:9', '1', '确认'), false)
  assert.equal(relay.handleReply('private:1', '2', '确认'), false)
  relay.handleReply('private:1', '1', '取消')
  await p
})

test('群聊、别人的私聊、DSH 自己的会话都交回 DSH', async () => {
  const { relay, sent, req } = setup()
  for (const id of ['group', 'other', 'unknown']) assert.equal(await relay.onRequest(req(id), async () => 'unavailable'), 'unavailable')
  assert.equal(sent.length, 0)
})

test('关掉开关、试运行、总开关关着时交回 DSH', async () => {
  for (const over of [{ approvalViaQQ: false }, { dryRun: true }, { enabled: false }]) {
    const { relay, sent, req } = setup({ over })
    assert.equal(await relay.onRequest(req(), async () => 'rejected'), 'rejected')
    assert.equal(sent.length, 0)
  }
})

test('网页先点了：QQ 这边收掉，之后回确认没用', async () => {
  const { relay, sent, req } = setup()
  assert.equal(await relay.onRequest(req(), async () => 'allowed-once'), 'allowed-once')
  await tick()
  assert.match(sent.at(-1).text, /已经在 DSH 里处理/)
  assert.equal(relay.handleReply('private:1', '1', '确认'), false)
})

test('超时不批', async () => {
  const { relay, sent, req, unavailable } = setup({ timeoutMs: 10 })
  assert.equal(await relay.onRequest(req(), unavailable), 'unavailable')
  await tick()
  assert.match(sent.at(-1).text, /超时/)
})

test('DSH 取消请求时收掉', async () => {
  const { relay, req, never } = setup()
  const ctl = new AbortController()
  const p = relay.onRequest(req('own', { signal: ctl.signal }), never)
  ctl.abort()
  assert.equal(await p, 'cancelled')
  assert.equal(relay.pending(), 0)
})

test('多条排队：一次问一条，「确认」只批当前这条', async () => {
  const { relay, sent, req, unavailable } = setup()
  const a = relay.onRequest(req('own', { toolName: 'a' }), unavailable)
  const b = relay.onRequest(req('own', { toolName: 'b' }), unavailable)
  await tick()
  assert.equal(sent.length, 1)
  relay.handleReply('private:1', '1', '确认')
  assert.equal(await a, 'allowed-once')
  await tick()
  assert.ok(sent.some((m) => m.text.includes('【要授权】b')))
  relay.handleReply('private:1', '1', '取消')
  assert.equal(await b, 'rejected')
})

test('卸载时全部收掉，不留悬着的请求', async () => {
  const { relay, req, unavailable } = setup()
  const p = relay.onRequest(req(), unavailable)
  relay.dispose()
  assert.equal(await p, 'unavailable')
})

test('问过才算 askedRecently：没走到插件时通知照常发', async () => {
  const { relay, req, unavailable } = setup()
  assert.equal(relay.askedRecently(), false)
  const p = relay.onRequest(req(), unavailable)
  assert.equal(relay.askedRecently(), true)
  relay.handleReply('private:1', '1', '确认')
  await p
})

test('QQ 不问的 QQ 会话：网页一直没人点，到时间按没批准处理', async () => {
  const relay = createApprovalRelay({
    getConfig: () => ({ enabled: true, ownerQQ: '1', approvalViaQQ: false }),
    deliver: async () => {}, chatOfSession: (id) => (id === 'dsh' ? '' : 'group:9'), timeoutMs: 20,
  })
  const never = () => new Promise(() => {})
  const req = (id) => ({ toolName: 'bash', agent: { session: { id } } })
  assert.equal(await relay.onRequest(req('qq'), never), 'unavailable')
  assert.equal(await relay.onRequest(req('qq'), async () => 'allowed-once'), 'allowed-once')
  let waited = false
  const dsh = relay.onRequest(req('dsh'), () => new Promise((r) => setTimeout(() => { waited = true; r('rejected') }, 60)))
  assert.equal(await dsh, 'rejected')
  assert.ok(waited, 'DSH 自己的会话不加时限')
})

