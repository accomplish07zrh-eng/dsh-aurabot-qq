// 「别处说过」桥接只记实际发出的文本（#211 review）：
//   deliver 返回值带 sent（实际发出的正文），saidElsewhere 只记真发出去的话——
//   dry-run 没真发、hook 拦下、部分发送失败、hook 改写后，都不能把没说出口/不一样的话算成说过。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'

// 假环境：onebot.call 可脚本化（第 N 次调用可抛错），hooks 可注入 reply/items。
function setup(t, { dryRun = false, enabled = true, onebotCall = null, hooks = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-said-bridge-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const calls = []
  const cfg = normalize({ enabled, dryRun, workspaceDir: dir, voice: { enabled: false }, stickers: { enabled: false } })
  const hub = createHub({
    dsh: {}, getConfig: () => cfg,
    log: Object.fromEntries(['info', 'warn', 'debug', 'error'].map((k) => [k, () => {}])),
    onebot: { async call(action, params) { calls.push(params); if (onebotCall) await onebotCall(calls.length); return { message_id: 42 } } },
    ...(hooks ? { hooks } : {}),
  })
  t.after(() => {
    hub.dispose()
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
    rmSync(dir, { recursive: true, force: true })
  })
  return { hub, calls }
}

test('正常发送：桥接记下全部正文，deliver 返回 sent', async (t) => {
  const s = setup(t)
  const r = await s.hub.deliver('private:1', '早上好|||记得吃饭')
  assert.equal(r.failed, 0)
  assert.equal(r.sent, '早上好 记得吃饭')
  assert.deepEqual(s.hub.saidElsewhereOf('private:1'), ['早上好 记得吃饭'])
})

test('dry-run：没真发，sent 必须为空，桥接不记', async (t) => {
  const s = setup(t, { dryRun: true })
  const r = await s.hub.deliver('private:1', '早上好|||记得吃饭')
  assert.equal(s.calls.length, 0, '试运行不打网关')
  assert.equal(r.sent, '', '试运行没真发，不能算说过')
  assert.deepEqual(s.hub.saidElsewhereOf('private:1'), [])
})

test('总开关关闭：同样没真发，sent 为空，桥接不记', async (t) => {
  const s = setup(t, { enabled: false })
  const r = await s.hub.deliver('private:1', '早上好|||记得吃饭')
  assert.equal(s.calls.length, 0)
  assert.equal(r.sent, '')
  assert.deepEqual(s.hub.saidElsewhereOf('private:1'), [])
})

test('hook 拦下回复：不记桥接，返回 undefined', async (t) => {
  const s = setup(t, { hooks: { reply: async () => null } })
  const r = await s.hub.deliver('private:1', '早上好')
  assert.equal(r, undefined)
  assert.equal(s.calls.length, 0)
  assert.deepEqual(s.hub.saidElsewhereOf('private:1'), [])
})

test('hook 拦下消息段：同样不记桥接', async (t) => {
  const s = setup(t, { hooks: { items: async () => null } })
  await s.hub.deliver('private:1', '早上好')
  assert.equal(s.calls.length, 0)
  assert.deepEqual(s.hub.saidElsewhereOf('private:1'), [])
})

test('部分发送失败：桥接只记发出去的那条，sent 只含成功正文', async (t) => {
  const s = setup(t, { onebotCall: async (n) => { if (n === 1) throw new Error('第一条没发出去') } })
  const r = await s.hub.deliver('private:1', '第一条|||第二条')
  assert.equal(r.failed, 1)
  assert.equal(r.sent, '第二条')
  assert.deepEqual(s.hub.saidElsewhereOf('private:1'), ['第二条'])
})

test('hook 改写回复：桥接记改写后实际发出的文本', async (t) => {
  const s = setup(t, { hooks: { reply: async () => '改写后的话' } })
  const r = await s.hub.deliver('private:1', '原始的话')
  assert.equal(r.sent, '改写后的话')
  assert.deepEqual(s.hub.saidElsewhereOf('private:1'), ['改写后的话'])
})

test('own:true：自己的轮次不进桥接', async (t) => {
  const s = setup(t)
  await s.hub.deliver('private:1', '早上好', { own: true })
  assert.deepEqual(s.hub.saidElsewhereOf('private:1'), [])
})
