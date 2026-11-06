import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConversationArchive, queriesFor, retrieve, packEvidence, recentWithin } from '../src/chat/conversation-context.js'

test('省略说法可以借助多轮用户线索，明确转题不会带入旧主题', () => {
  const recent = [{ role: 'user', text: 'Coffee温控怎么调' }, { role: 'assistant', text: '试试低一点的水温' }, { role: 'user', text: '嗯' }]
  assert.ok(queriesFor('那后来呢', recent).some(q => q.includes('Coffee')))
  assert.deepEqual(queriesFor('换个话题，聊盆栽', recent), ['换个话题，聊盆栽'])
})

test('相关性检索不会给完全无关的问题制造记忆兜底', () => {
  const docs = [{ id: 'a', text: 'Coffee温控需要稳定' }, { id: 'b', text: '盆栽每周浇水' }]
  assert.equal(retrieve(['Coffee'], docs)[0].id, 'a')
  assert.deepEqual(retrieve(['火星婚礼'], docs), [])
})

test('预算保留完整证据记录，不截断JSON，并尝试后面的较小记录', () => {
  const result = packEvidence([{ text: 'x'.repeat(100) }, { text: 'Coffee' }], JSON.stringify, 30)
  assert.equal(JSON.parse(result.text).text, 'Coffee')
  assert.ok(result.characters <= 30)
  assert.deepEqual(recentWithin([{ role: 'user', text: 'a'.repeat(20) }, { role: 'assistant', text: 'b'.repeat(20) }], 30), [])
})

test('长会话中间的事实在重启后可检索，原话角色和证据ID保持不变', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aurabot-archive-'))
  let archive = createConversationArchive({ directory, namespace: 'paperboat' })
  const chat = 'private:fixture'
  for (let i = 0; i < 100; i++) {
    archive.append(chat, { role: 'user', id: 'u' + i, at: 1700000000000 + i * 1000, text: i === 40 ? 'Coffee温控约定用八十八度' : '今天讨论盆栽第' + i + '次' })
    archive.append(chat, { role: 'assistant', id: 'a' + i, at: 1700000000500 + i * 1000, text: '知道了' })
  }
  archive = createConversationArchive({ directory, namespace: 'paperboat' })
  const found = archive.recall(chat, 'Coffee温控的约定')
  assert.match(found.text, /八十八度/)
  assert.ok(found.selected.some(e => e.context.some(m => m.id === 'u40' && m.role === 'user')))
  assert.ok(found.characters <= 4000)
})

test('不同聊天、群聊和不同人格互相不能召回；重复结束事件不重复入库', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aurabot-isolation-'))
  const a = createConversationArchive({ directory, namespace: 'a' })
  a.append('private:owner', { id: 'one', role: 'user', text: 'Coffee秘密偏好' })
  assert.equal(a.append('private:owner', { id: 'one', role: 'user', text: '重复事件' }), false)
  assert.equal(a.recent('private:owner').length, 1)
  for (const chat of ['private:other', 'group:owner']) assert.equal(a.recall(chat, 'Coffee', { recentMessages: [] }).text, '')
  const b = createConversationArchive({ directory, namespace: 'b' })
  assert.equal(b.recall('private:owner', 'Coffee', { recentMessages: [] }).text, '')
})

test('机器人生成的经历保持assistant来源，不会转换成用户事实', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aurabot-attribution-'))
  const archive = createConversationArchive({ directory })
  archive.append('private:owner', { role: 'assistant', text: '我去过Coffee星球' })
  const found = archive.recall('private:owner', 'Coffee星球', { recentMessages: [] })
  assert.equal(found.selected[0].context[0].role, 'assistant')
  assert.equal(found.selected[0].source, 'new_conversation')
})

test('大段粘贴不会让旁边的小事实一起超过检索预算，原始长消息仍完整保存', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aurabot-paste-'))
  const archive = createConversationArchive({ directory })
  const chat = 'private:owner', pasted = '无关资料'.repeat(4000)
  archive.append(chat, { id: 'paste', role: 'user', text: pasted })
  archive.append(chat, { id: 'fact', role: 'user', text: 'Coffee温控约定用八十八度' })
  archive.append(chat, { id: 'reply', role: 'assistant', text: '行' })
  for (let i = 0; i < 40; i++) archive.append(chat, { id: 'filler-' + i, role: 'user', text: '讨论盆栽浇水第' + i + '次' })
  const recalled = archive.recall(chat, 'Coffee温控约定', { maxCharacters: 900 })
  assert.match(recalled.text, /八十八度/)
  assert.ok(recalled.characters <= 900)
  assert.ok(recalled.selected.some(e => e.context.some(m => m.id === 'fact' && m.role === 'user')))
  assert.equal(archive.recent(chat, 100).find(m => m.id === 'paste').text, pasted)
})
