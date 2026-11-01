// qq_send_file 的权限边界（#169）：主人私聊能发；群里只有「这一轮说话的人全是主人」能发；
// 图片先按图发，明确发不出去才按文件发，结果不确定时绝不发第二份。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import qqTools from '../src/modules/qq-tools/index.js'

function setup({ level = 'full', kind = 'private', ownerAll = true, files = { enabled: true }, hubOver = {} } = {}) {
  const sent = [], images = []
  const hub = {
    turnSendersAllOwner: () => ownerAll,
    checkSendableFile: () => ({ src: '/tmp/a.zip', external: false, size: 1, maxBytes: 1 << 20 }),
    sendImage: async (chatId) => { images.push(chatId); return { message_id: 1 } },
    sendFile: async (chatId) => { sent.push(chatId); return { message_id: 2 } },
    ...hubOver,
  }
  const cfg = { enabled: true, dryRun: false, ownerQQ: '1', allow: { private: [], groups: ['9'] }, files }
  let build = null
  qqTools.setup({ core: { hub, onebot: { call: async () => ({}) } }, config: () => cfg, tool: (fn) => { build = fn } })
  const tools = build({ chat: { kind, chatId: kind === 'group' ? 'group:9' : 'private:1' }, level, sessionId: 's1' })
  return { tool: tools.find((t) => t.name === 'qq_send_file'), sent, images, cfg }
}

test('主人私聊：能发，走 sendFile', async () => {
  const s = setup()
  const r = await s.tool.execute({ file: '/tmp/a.zip' })
  assert.equal(r.ok, true)
  assert.equal(r.message, '文件发出去了：a.zip')
  assert.deepEqual(s.sent, ['private:1'])
})

test('群聊里这一轮说话的全是主人：能发到群里', async () => {
  const s = setup({ kind: 'group', level: 'social' })
  const r = await s.tool.execute({ file: '/tmp/a.zip' })
  assert.equal(r.ok, true)
  assert.deepEqual(s.sent, ['group:9'])
})

test('群里主人和别人同处这一轮：拒绝，一条都不发', async () => {
  const s = setup({ kind: 'group', level: 'social', ownerAll: false })
  const r = await s.tool.execute({ file: '/tmp/a.zip' })
  assert.equal(r.ok, false)
  assert.match(r.message, /只有主人开口时才能发文件/)
  assert.deepEqual(s.sent, [])
  assert.deepEqual(s.images, [])
})

test('别人私聊里根本没有这个工具', () => {
  assert.equal(setup({ kind: 'private', level: 'social' }).tool, undefined)
})

test('面板关掉发文件：群里也不挂', () => {
  assert.equal(setup({ kind: 'group', level: 'social', files: { enabled: false } }).tool, undefined)
})

test('图片：先按图发，不走 sendFile', async () => {
  const s = setup()
  const r = await s.tool.execute({ file: '/tmp/a.png' })
  assert.equal(r.ok, true)
  assert.equal(r.message, '图片发出去了：a.png')
  assert.deepEqual(s.images, ['private:1'])
  assert.deepEqual(s.sent, [])
})

test('图片明确发不出去时，按文件发', async () => {
  const s = setup({ hubOver: { sendImage: async () => null } })
  const r = await s.tool.execute({ file: '/tmp/a.png' })
  assert.equal(r.ok, true)
  assert.equal(r.message, '文件发出去了：a.png')
  assert.deepEqual(s.sent, ['private:1'])
})

test('图片结果不确定（超时）：报错，绝不按文件再发一份', async () => {
  const s = setup({ hubOver: { sendImage: async () => { throw new Error('图片可能已经发出去了，但网关没确认：超时') } } })
  const r = await s.tool.execute({ file: '/tmp/a.png' })
  assert.equal(r.ok, false)
  assert.match(r.message, /可能已经发出去了/)
  assert.deepEqual(s.sent, [])
})

test('路径不在允许目录里：图片也不发，直接报原因', async () => {
  const s = setup({ hubOver: { checkSendableFile: () => { throw new Error('这个文件不在允许发送的目录里') } } })
  const r = await s.tool.execute({ file: '/etc/a.png' })
  assert.equal(r.ok, false)
  assert.match(r.message, /不在允许发送的目录里/)
  assert.deepEqual(s.images, [])
  assert.deepEqual(s.sent, [])
})

test('target 不在白名单里：拒绝', async () => {
  const s = setup()
  const r = await s.tool.execute({ file: '/tmp/a.zip', target: 'group:12345' })
  assert.equal(r.ok, false)
  assert.match(r.message, /不在白名单里/)
  assert.deepEqual(s.sent, [])
})
