import { test } from 'node:test'
import assert from 'node:assert/strict'
import { noticeText } from '../src/chat/notices.js'

const n = (e) => noticeText({ post_type: 'notice', group_id: 9, ...e }, { botQQ: '1', name: (q) => `U${q}`, ownMessage: (id) => id === 7 })

test('常见群事件翻成一句话', () => {
  assert.deepEqual(n({ notice_type: 'group_recall', user_id: 2, operator_id: 2 }), { chatId: 'group:9', text: 'U2撤回了一条消息' })
  assert.equal(n({ notice_type: 'group_recall', user_id: 2, operator_id: 3 }).text, 'U3撤回了U2的一条消息')
  assert.equal(n({ notice_type: 'group_ban', sub_type: 'ban', user_id: 1, operator_id: 3, duration: 600 }).text, 'U3禁言了你 10 分钟')
  assert.equal(n({ notice_type: 'group_ban', sub_type: 'lift_ban', user_id: 2, operator_id: 3 }).text, 'U3解除了U2的禁言')
  assert.equal(n({ notice_type: 'group_decrease', sub_type: 'kick', user_id: 2, operator_id: 3 }).text, 'U3把U2踢出了群')
  assert.equal(n({ notice_type: 'group_decrease', sub_type: 'leave', user_id: 2, operator_id: 2 }).text, 'U2退群了')
  assert.equal(n({ notice_type: 'essence', sub_type: 'add', sender_id: 2, operator_id: 3 }).text, 'U3把U2的消息设为精华')
  assert.equal(n({ notice_type: 'notify', sub_type: 'group_name', user_id: 3, name_new: '新群名' }).text, 'U3把群名改成了「新群名」')
})

test('私聊事件落到对方的聊天', () => {
  assert.deepEqual(n({ notice_type: 'friend_recall', user_id: 2 }), { chatId: 'private:2', text: '对方撤回了一条消息' })
})

test('不用告诉她的不翻', () => {
  assert.equal(n({ notice_type: 'group_recall', user_id: 1, operator_id: 1 }), null, '自己撤回的')
  assert.equal(n({ notice_type: 'group_msg_emoji_like', sub_type: 'add', user_id: 2, message_id: 8 }), null, '别人消息上的表情')
  assert.equal(n({ notice_type: 'group_msg_emoji_like', sub_type: 'add', user_id: 2, message_id: 7 }).text, 'U2给你的消息点了表情回应')
  assert.equal(n({ notice_type: 'notify', sub_type: 'input_status', user_id: 2 }), null)
  assert.equal(noticeText({ post_type: 'message' }), null)
})
