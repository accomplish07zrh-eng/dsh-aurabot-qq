// H03/F5 隔离探针：群聊整理模型即便返回主人记忆 ID，也不能改写主人记忆。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-h03-consolidate-'))
const { normalize } = await import('../src/core/config.js')
const { createMemoryStore } = await import('../src/features/memory.js')

const owner = '10000001'
const group = '999999'
const day = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

test('H03：群聊整理不能按 ID 改写主人记忆', async () => {
  const cfg = normalize({ enabled: true, ownerQQ: owner, ownerName: '主人', model: { provider: 'p', model: 'm' } })
  const logs = new Map()
  const log = { info () {}, warn () {}, debug () {} }
  const hub = {
    chatLogDays: () => [...logs.keys()],
    chatLogOf: (d) => logs.get(d) || [],
    deleteChatLog: (d) => logs.delete(d),
    lastTextOf: () => '',
    prevTextOf: () => '',
    speakersOf: () => [],
    groupNameOf: () => '测试群',
  }
  let ownerId = ''
  const dsh = {
    get: () => null,
    llm: {
      async *stream ({ system, messages }) {
        if (system.includes('整理长期记忆')) {
          yield { type: 'text-delta', text: JSON.stringify([{ op: 'update', id: ownerId, text: '主人喜欢奶茶' }]) }
        } else {
          yield { type: 'text-delta', text: '[]' }
        }
        yield { type: 'finish', reason: { kind: 'completed' } }
      },
    },
  }
  const mem = createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
  const added = mem.add({ text: '主人喜欢咖啡', about: owner, aboutName: '主人', source: 'auto', chatId: `private:${owner}` })
  ownerId = added.id
  const before = mem.list('').find((x) => x.id === ownerId)
  logs.set(day(), [
    { chatId: `group:${group}`, who: '白', uid: '30000003', text: '今天天气不错' },
    { chatId: `group:${group}`, who: '白', uid: '30000003', text: '我们去吃饭吧' },
    { chatId: `group:${group}`, who: '白', uid: '30000003', text: '就吃白米饭' },
  ])
  await mem.consolidate({ includeToday: true })
  const after = mem.list('').find((x) => x.id === ownerId)
  assert.equal(after.text, before.text, '群聊整理改写了主人记忆')
  assert.equal(after.about, owner)
})
