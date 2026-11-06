// 安全默认：危险命令（删文件、关机等）默认要二次确认；显式关闭仍然生效。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, normalize } from '../src/core/config.js'

test('dangerConfirm 默认开启', () => {
  assert.equal(DEFAULTS.security.dangerConfirm, true)
  assert.equal(normalize({}).security.dangerConfirm, true)
  assert.equal(normalize({ security: {} }).security.dangerConfirm, true)
})

test('显式关闭 dangerConfirm 仍然生效（老配置 / 主动关掉的用户不受影响）', () => {
  assert.equal(normalize({ security: { dangerConfirm: false } }).security.dangerConfirm, false)
})
