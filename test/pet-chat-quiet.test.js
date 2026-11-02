// #184：QQ 聊天回合不能触发桌宠的「干活」动画/完工气泡——聊天每句都有 turn/start→turn/end，
// 桌宠只该跟 DSH 自己发起的活儿走。这里测「是不是 QQ 聊天会话」这个判定。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isChatSession } from '../src/host.js'

test('QQ 聊天会话：不转发给桌宠', () => {
  const hub = { chatOfSession: (id) => (id === 'session-qq' ? 'private:10001' : '') }
  assert.equal(isChatSession(hub, { id: 'session-qq' }), true, '私聊/群聊映射到的会话都算聊天')
  assert.equal(isChatSession(hub, { id: 'session-panel' }), false, 'DSH 自己发起的会话照常联动')
})

test('判定不出/异常时不要误伤：按非聊天处理（保持原联动行为）', () => {
  assert.equal(isChatSession({ chatOfSession: () => 'group:123' }, { id: 'g' }), true)
  assert.equal(isChatSession({}, { id: 'x' }), false, 'hub 没有映射方法：当非聊天')
  assert.equal(isChatSession(null, { id: 'x' }), false, 'hub 为空：当非聊天')
  assert.equal(isChatSession({ chatOfSession: () => { throw new Error('boom') } }, { id: 'x' }), false, '抛错：当非聊天')
  assert.equal(isChatSession({ chatOfSession: () => 'private:1' }, null), false, '没有 session：当非聊天')
})
