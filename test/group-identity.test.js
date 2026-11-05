import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickAutoReply, sameNameNote } from '../src/chat/group-policy.js'

const msg = (uid, mid, direct = false, nick = '小明') => ({ uid, mid, direct, nick })

test('只有一个人说话且 @ 了她：自动引用并 @', () => {
  assert.deepEqual(pickAutoReply([msg('1', 'a'), msg('1', 'b', true)]), { mid: 'b', uid: '1' })
})

test('多人说话时不自动 @，哪怕只有一个人 @ 了她（#160 情况 2）', () => {
  assert.equal(pickAutoReply([msg('2', 'a'), msg('3', 'b', true)]), null)
})

test('没人 @ 她不自动引用', () => {
  assert.equal(pickAutoReply([msg('1', 'a')]), null)
  assert.equal(pickAutoReply([]), null)
})

test('重名才提醒，名字不同或同一个人不提醒', () => {
  assert.match(sameNameNote([msg('1', 'a'), msg('2', 'b')]), /「小明」.*不同的人/)
  assert.equal(sameNameNote([msg('1', 'a'), msg('1', 'b')]), '')
  assert.equal(sameNameNote([msg('1', 'a'), msg('2', 'b', false, '小红')]), '')
})
