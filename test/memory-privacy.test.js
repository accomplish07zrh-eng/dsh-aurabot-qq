// 记忆隐私回归（M06）：来源可见性 / recall_memory 群聊人物过滤 / mergeGroups 跨来源合并。
// 只读审计发现的三条路径：主人私聊里关于某人的记忆不能进别人的聊天、群聊不能翻不在场的人、合并不能跨来源。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { readMemoryState } from './helpers/memory-state.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'aurabot-mempriv-'))
process.env.AURABOT_DATA_DIR = join(ROOT, 'boot')
mkdirSync(process.env.AURABOT_DATA_DIR, { recursive: true })

const { normalize } = await import('../src/core/config.js')
const { createMemoryStore } = await import('../src/features/memory.js')

const OWNER = '10000001'
const GUEST = '10000111'
const OTHER = '20000222'
const G555 = '555'
const G556 = '556'
const OWNER_CHAT = `private:${OWNER}`
const GUEST_CHAT = `private:${GUEST}`
const G555_CHAT = `group:${G555}`
const G556_CHAT = `group:${G556}`
const log = { info () {}, warn () {}, debug () {} }

/** 每个用例一个独立数据目录：dataDir() 每次读 env，切目录即可隔离。 */
function freshStore (tag, memory = {}) {
  const dir = join(ROOT, tag)
  mkdirSync(dir, { recursive: true })
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({ enabled: true, ownerQQ: OWNER, ownerName: '主人', memory: { enabled: true, recallCount: 20, ...memory } })
  const hub = { chatLogOf: () => [], chatLogDays: () => [], deleteChatLog: () => {}, speakersOf: () => [] }
  return { dir, cfg, hub, store: createMemoryStore({ dsh: null, getConfig: () => cfg, hub, log }) }
}

// ---------- F1：检索层的来源可见性 ----------
test('F1：群聊 / 非主人私聊只看当前聊天来源的记忆，主人私聊可看全部', () => {
  const { store } = freshStore('f1')
  const query = '密码 外卖 篮球 周六 欠 500 私事'
  // 主人私聊里产生的记忆（含关于主人本人、关于群友的）
  store.add({ text: 'OWNER_OWN_CANARY 主人的银行卡密码是 123456', about: OWNER, aboutName: '主人', source: 'tool', chatId: OWNER_CHAT, importance: 0.9 })
  store.add({ text: 'OWNER_ABOUT_GUEST_CANARY 主人私下说小七篮球打得差还欠他500块', about: GUEST, aboutName: '群友小七', source: 'auto', chatId: OWNER_CHAT, importance: 0.9 })
  store.add({ text: 'OWNER_DIARY_CANARY 主人今天一个人吃外卖', source: 'diary', importance: 0.8 })
  // 群 555 里产生的记忆（普通条目 + 群公共记忆）
  store.add({ text: 'GROUP_555_ABOUT_GUEST 小七在群里约过周六打球', about: GUEST, aboutName: '群友小七', source: 'auto', chatId: G555_CHAT, importance: 0.6 })
  store.add({ text: 'GROUP_555_PUBLIC 群555周六篮球局', scope: 'group', chatId: G555_CHAT, source: 'auto', importance: 0.6 })
  // 群 556 的记忆
  store.add({ text: 'GROUP_556_CANARY 群556的篮球私事', about: GUEST, aboutName: '群友小七', source: 'auto', chatId: G556_CHAT, importance: 0.9 })
  // 小七自己的私聊里产生的记忆（同一聊天，社交场景应该能想起来）
  store.add({ text: 'GUEST_PRIVATE_SAME_CHAT 小七私聊说自己喜欢篮球', about: GUEST, aboutName: '群友小七', source: 'tool', chatId: GUEST_CHAT, importance: 0.7 })

  const socialRecall = (chatId, about) => store.recall(query, {
    about,
    onlyAbout: about,
    requireAbout: true,
    excludeAbout: OWNER,
    where: chatId,
    groupChatId: chatId.startsWith('group:') ? chatId : '',
    includeGroup: false,
    limit: 20,
  })
  const texts = (hits) => hits.map((h) => h.it.text).join('\n')

  // 群 555：只看群 555 里产生的+本群公共记忆
  const group = texts(socialRecall(G555_CHAT, [GUEST]))
  assert.doesNotMatch(group, /OWNER_OWN_CANARY/, '群聊不能看到主人私聊里关于主人本人的记忆')
  assert.doesNotMatch(group, /OWNER_ABOUT_GUEST_CANARY/, '群聊不能看到主人私聊里关于群友的记忆')
  assert.doesNotMatch(group, /OWNER_DIARY_CANARY/, '群聊不能看到无来源的私人日记')
  assert.doesNotMatch(group, /GROUP_556_CANARY/, '群聊不能看到别的群产生的记忆')
  assert.match(group, /GROUP_555_ABOUT_GUEST/, '本群产生的关于说话人的记忆仍要能想起来')
  assert.match(group, /GROUP_555_PUBLIC/, '本群公共记忆仍要能想起来')

  // 小七的非主人私聊：只看小七这个聊天里产生的记忆
  const guestPrivate = texts(socialRecall(GUEST_CHAT, [GUEST]))
  assert.doesNotMatch(guestPrivate, /OWNER_OWN_CANARY/)
  assert.doesNotMatch(guestPrivate, /OWNER_ABOUT_GUEST_CANARY/)
  assert.doesNotMatch(guestPrivate, /OWNER_DIARY_CANARY/)
  assert.doesNotMatch(guestPrivate, /GROUP_555_ABOUT_GUEST/, '别人的群聊不是当前聊天，不能带进非主人私聊')
  assert.doesNotMatch(guestPrivate, /GROUP_556_CANARY/)
  assert.match(guestPrivate, /GUEST_PRIVATE_SAME_CHAT/, '当前聊天产生的记忆不能丢')

  // 主人私聊：保持可以看全部（含别的聊天、日记、群公共记忆）
  const owner = texts(store.recall(query, { where: OWNER_CHAT, includeGroup: true, limit: 20 }))
  assert.match(owner, /OWNER_OWN_CANARY/)
  assert.match(owner, /OWNER_ABOUT_GUEST_CANARY/)
  assert.match(owner, /OWNER_DIARY_CANARY/, '日记/经历仍进主人私聊')
  assert.match(owner, /GROUP_555_PUBLIC/)
})

test('F1：社交场景取不到当前聊天 id 时不放行（fail closed）', () => {
  const { store } = freshStore('f1b')
  store.add({ text: 'NO_CHAT_CANARY 没有来源的旧记忆', about: GUEST, aboutName: '群友小七', source: 'import', importance: 0.9 })
  // where 为空 → 内部/主人视角（向后兼容）；社交路径都会带 where，这里验证带 group: 但条目没有 chatId 时会被挡
  const hits = store.recall('CANARY', {
    about: [GUEST], onlyAbout: [GUEST], requireAbout: true, where: G555_CHAT, groupChatId: G555_CHAT, limit: 10,
  })
  assert.equal(hits.some((h) => h.it.text.includes('NO_CHAT_CANARY')), false, '没有来源的条目不能进群聊')
})

// ---------- F5：mergeGroups 按来源分组，不跨聊天合并 ----------
function mergeDsh (getDir, mode) {
  // mode.crossAttempt = true：模型故意在每组里混入另一个来源的记忆 id，看执行层挡不挡
  const dsh = {
    llm: {
      async *stream (params) {
        const system = String(params?.system || '')
        const content = params?.messages?.[0]?.content
        const text = Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : ''
        if (system.includes('同一个人名下')) {
          const own = [...text.matchAll(/#([0-9a-f]{8})/g)].map((m) => m[1])
          let foreign = []
          if (mode.crossAttempt) {
            try {
              const items = readMemoryState(getDir()).items
              // 只挑“不在当前组里”的条目：整组都来自另一个来源时，模型想把它们和本组并在一起
              if (!own.some((id) => items.find((m) => m.id === id)?.chatId === OWNER_CHAT)) {
                foreign = items.filter((m) => m.chatId === OWNER_CHAT && !own.includes(m.id)).slice(0, 2).map((m) => m.id)
              }
              if (!own.some((id) => items.find((m) => m.id === id)?.chatId === G555_CHAT)) {
                foreign = foreign.concat(items.filter((m) => m.chatId === G555_CHAT && !own.includes(m.id)).slice(0, 2).map((m) => m.id))
              }
            } catch (error) {}
          }
          const ids = mode.crossAttempt
            ? [...foreign.slice(0, 2), ...own.slice(0, 1)] // 混合来源 + 本组 1 条：若放行就能凑成 2 条
            : own.slice(0, 4) // 只在同一来源内合并（正向对照）
          const merges = ids.length >= 2 ? [{ ids, text: 'MERGED_CANARY' }] : []
          yield { type: 'text-delta', text: JSON.stringify({ merges }) }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'text-delta', text: '[]' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
      listProviders: () => ['fake'],
    },
    get (n) { return n === 'llm' ? dsh.llm : null },
  }
  return dsh
}

test('F5：mergeGroups 不跨聊天合并（模型混入跨来源 id 会被拒；同来源内仍可合并）', async () => {
  const dir = join(ROOT, 'f5')
  mkdirSync(dir, { recursive: true })
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({
    enabled: true, ownerQQ: OWNER, ownerName: '主人', model: { provider: 'fake', model: 'fake-1' },
    memory: { enabled: true, recallCount: 20, mergeGroups: true },
  })
  const hub = { chatLogOf: () => [], chatLogDays: () => [], deleteChatLog: () => {}, groupNames: new Map(), speakersOf: () => [] }
  const mode = { crossAttempt: true }
  const dsh = mergeDsh(() => process.env.AURABOT_DATA_DIR, mode)
  const store = createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
  // 群 555：4 条低权重、同一人；主人私聊：4 条低权重、同一人
  for (let i = 0; i < 4; i++) store.add({ text: `GROUP_MERGE_${i} 小七喜欢篮球`, about: GUEST, aboutName: '群友小七', source: 'auto', chatId: G555_CHAT, importance: 0.4 })
  for (let i = 0; i < 4; i++) store.add({ text: `OWNER_MERGE_${i} 主人私下说小七欠他500块`, about: GUEST, aboutName: '群友小七', source: 'auto', chatId: OWNER_CHAT, importance: 0.4 })

  // ① 跨来源尝试：模型把另一个来源的 id 混进来 → 执行层只能凑到 1 条本组条目，必须整组不做
  const r1 = await store.consolidate({ includeToday: true })
  assert.equal(r1.ok, true)
  assert.equal(store.list('').filter((m) => m.text.includes('MERGED_CANARY')).length, 0, '跨来源的合并必须被拒绝')
  assert.equal(store.list('').filter((m) => /GROUP_MERGE_/.test(m.text)).length, 4, '群来源条目保持原样')
  assert.equal(store.list('').filter((m) => /OWNER_MERGE_/.test(m.text)).length, 4, '主人私聊来源条目保持原样')

  // ② 同来源内合并（正向对照）：模型只报本组 id → 允许合并，且合并结果保留合法来源
  mode.crossAttempt = false
  const r2 = await store.consolidate({ includeToday: true })
  assert.equal(r2.ok, true)
  const merged = store.list('').filter((m) => m.text.includes('MERGED_CANARY'))
  assert.ok(merged.length >= 2, '同一来源内部应能合并（两个来源各一组）')
  for (const m of merged) assert.equal([G555_CHAT, OWNER_CHAT].includes(m.chatId), true, '合并结果必须保留合法来源 chatId')
  assert.equal(store.list('').some((m) => m.text.includes('MERGED_CANARY') && !m.chatId), false, '不允许出现没有来源的合并条目')
})
