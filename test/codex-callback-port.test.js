// 1455 是 Codex OAuth 注册过的固定回调端口：能不能绑决定登录是自动回调还是手动粘贴。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CALLBACK_PORT, callbackPortUsable } from '../src/features/codex-auth.js'

test('回调端口常量与探测：返回布尔值，重复调用结果一致（60 秒缓存）', async () => {
  assert.equal(CALLBACK_PORT, 1455)
  const first = await callbackPortUsable()
  const second = await callbackPortUsable()
  assert.equal(typeof first, 'boolean')
  assert.equal(first, second)
})
