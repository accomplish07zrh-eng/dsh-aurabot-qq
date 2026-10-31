import test from 'node:test'
import assert from 'node:assert/strict'
import { loginSessionKey, recoverLoginPause } from '../src/bili/login-pause.js'
const day = '2026-10-31'
const key = loginSessionKey('SESSDATA=fake; bili_jct=csrf; buvid3=device')
const state = (reason = 'B 站没登录或 Cookie 过期了') => ({ day, pauseDay: day, pauseReason: reason, comments: 2, replies: 1, history: [{ kind: 'error', text: '-101' }] })

test('登录核验成功后恢复过时的登录暂停，保留计数与历史', () => {
  const s = state()
  assert.equal(recoverLoginPause(s, { isLogin: true, sessionKey: key, day }), true)
  assert.equal(s.pauseDay, undefined)
  assert.equal(s.comments, 2)
  assert.equal(s.replies, 1)
  assert.deepEqual(s.history, [{ kind: 'error', text: '-101' }])
  assert.ok(!JSON.stringify(s).includes('fake'))
})

test('风控、验证码和过于频繁不因登录成功解除', () => {
  for (const reason of ['被 B 站风控了', '发得太频繁', 'B 站要求验证码']) {
    const s = state(reason)
    assert.equal(recoverLoginPause(s, { isLogin: true, sessionKey: key, day }), false)
    assert.equal(s.pauseReason, reason)
  }
})

test('没有完整 Cookie、未登录或非当天暂停不恢复', () => {
  assert.equal(loginSessionKey('SESSDATA=fake'), '')
  for (const options of [{ isLogin: false, sessionKey: key, day }, { isLogin: true, sessionKey: '', day }, { isLogin: true, sessionKey: key, day: '2026-11-01' }]) {
    assert.equal(recoverLoginPause(state(), options), false)
  }
})

test('同一登录再次被评论接口拒绝后不无限恢复，换凭证后可重新核验', () => {
  const s = state()
  assert.equal(recoverLoginPause(s, { isLogin: true, sessionKey: key, day }), true)
  s.pauseDay = day
  s.pauseReason = 'B 站没登录或 Cookie 过期了'
  assert.equal(recoverLoginPause(s, { isLogin: true, sessionKey: key, day }), false)
  const next = loginSessionKey('SESSDATA=fresh; bili_jct=new')
  assert.equal(recoverLoginPause(s, { isLogin: true, sessionKey: next, day }), true)
  assert.equal(loginSessionKey('SESSDATA=fake; bili_jct=csrf; buvid3=changed'), key)
})
