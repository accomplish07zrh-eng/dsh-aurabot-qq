import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { selfName, selfNames, isSelfName, savePersona, currentPersonaText } from '../src/persona/personas.js'
import { createMemoryStore } from '../src/features/memory.js'
import { createMood } from '../src/features/companion.js'
import { createPurpose, cleanReply } from '../src/purpose/module.js'
import { collectMaterials, needAffinity } from '../src/purpose/engine.js'
import { createBridge } from '../src/core/bridge.js'
import { writeMemoryState } from './helpers/memory-state.js'

const OWNER = '10000001', BOT = '20000001'
const DAY = 86400_000
const log = { info() {}, warn() {}, debug() {} }
const dayKey = (at) => {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function setup(t, answer) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-self-name-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  const cfg = normalize({ ownerQQ: OWNER, botQQ: BOT, model: { provider: 'p', model: 'm' },
    mood: { enabled: true, judge: true },
    memory: { keepChatlogDays: 0, keepChatlogSet: true, mergeGroups: true },
  })
  const calls = []
  const logs = new Map()
  const dsh = { get: () => null, llm: { async *stream({ system, messages }) {
    const text = messages[0].content[0].text
    calls.push({ system, text })
    const response = answer ? answer({ system, text })
      : system.includes('整理长期记忆') ? '{"facts":[]}'
        : system.includes('回顾自己和') ? '{"insights":[],"style":[]}'
          : system.includes('自然会被带上') ? '["偶尔用叠字"]'
            : system.includes('可以并成一条') ? '{"merges":[]}'
              : system.includes('心情变化') ? '{"delta":0,"reason":"平常","confidence":1}'
                : system.includes('人物小档案') ? '主人是熟人，喜欢喝茶。'
                  : system.includes('长期印象') ? '{"text":"主人常和我分享生活，相处很亲近"}'
                    : system.includes('整理自己的记忆') ? '{"text":"我和主人聊了近况"}' : '[]'
    yield { type: 'text-delta', text: response }
    yield { type: 'finish', reason: { kind: 'completed' } }
  } } }
  const hub = {
    chatLogDays: () => [...logs.keys()].sort(),
    chatLogOf: (day) => logs.get(day) || [],
    deleteChatLog: (day) => logs.delete(day),
    speakersOf: () => [OWNER],
  }
  const memory = () => createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
  const select = (id, name) => {
    savePersona(id, { name, body: `你是${name}。` })
    cfg.persona.current = id
  }
  return { dir, cfg, calls, logs, dsh, hub, memory, select }
}

function assertName(prompt, name = 'Claude') {
  assert.ok(prompt.includes(name), `提示词应包含 ${name}：${prompt}`)
  if (name !== '大肥鱼') assert.doesNotMatch(prompt, /大肥鱼|肥鱼|鱼鱼/)
}

test('默认人格仍叫大肥鱼；名字和正文同步切换，保存同一人格的名字也立即生效', (t) => {
  const s = setup(t)
  assert.equal(selfName(s.cfg), '大肥鱼')
  s.select('claude', 'Claude')
  assert.equal(selfName(s.cfg), 'Claude')
  assert.match(currentPersonaText(s.cfg.persona.current), /Claude/)
  savePersona('claude', { name: 'Alice', body: '你是Alice。' })
  assert.equal(selfName(s.cfg), 'Alice')
  s.cfg.persona.current = 'dafeiyu'
  assert.equal(selfName(s.cfg), '大肥鱼')
})

test('缺少 name、空白 name、无可用人格、读取失败时回退；失效 id 与正文选用同一张卡', (t) => {
  const s = setup(t)
  mkdirSync(join(s.dir, 'personas'), { recursive: true })
  for (const [id, raw] of [['no-name', '只有正文'], ['blank', '---\nname:   \n---\n正文']]) {
    writeFileSync(join(s.dir, 'personas', `${id}.md`), raw)
    s.cfg.persona.current = id
    assert.equal(selfName(s.cfg), '大肥鱼')
  }
  s.select('aaa', 'Claude')
  s.cfg.persona.current = 'missing'
  assert.equal(selfName(s.cfg), 'Claude')
  assert.match(currentPersonaText('missing'), /Claude/)
  // 不可写的路径既无法播种，也无法读取人格。
  const blocker = join(s.dir, 'blocker')
  writeFileSync(blocker, 'x')
  process.env.AURABOT_DATA_DIR = blocker
  assert.equal(selfName(s.cfg), '大肥鱼')
  assert.equal(selfName(undefined), '大肥鱼')
  process.env.AURABOT_DATA_DIR = s.dir
  // 同名目录让 readPersona 的读取抛错，也必须有兜底。
  mkdirSync(join(s.dir, 'personas', 'broken.md'))
  s.cfg.persona.current = 'broken'
  assert.equal(selfName(s.cfg), '大肥鱼')
})

test('自身识别兼容当前名、旧名、自称，按字面匹配特殊字符，不误认别人的名字', (t) => {
  const s = setup(t)
  s.select('claude', 'Claude')
  for (const name of ['Claude', 'claude', ' Claude ', 'Claude自己', 'Claude的人设', '大肥鱼', '肥鱼', '鱼鱼', '我', '我自己', '自己']) {
    assert.equal(isSelfName(name, s.cfg), true, name)
  }
  for (const name of ['', 'Claude的朋友', 'Claude同学', '小明']) assert.equal(isSelfName(name, s.cfg), false, name)
  s.select('special', 'C++ (小云)')
  assert.equal(selfName(s.cfg), 'C++ (小云)')
  assert.equal(isSelfName('C++ (小云)', s.cfg), true)
  assert.equal(cleanReply('C++ (小云)：你好', undefined, s.cfg), '你好')
  assert.equal(cleanReply('大肥鱼：你好', undefined, s.cfg), '你好')
  assert.equal(cleanReply('其他人：你好', undefined, s.cfg), '其他人：你好')
})

test('Claude 的整理、回顾、说话习惯、人物档案、梗概、印象压缩、合并与心情提示都使用当前名', async (t) => {
  const s = setup(t)
  s.select('claude', 'Claude')
  const old = Date.now() - 20 * DAY
  writeMemoryState(s.dir, { items: ['主人常分享工作近况', '主人喜欢喝茶', '主人周末会散步', '主人每天早睡'].map((text, i) => ({
    id: `old${i}`, text, about: OWNER, aboutName: '主人', source: 'auto', chatId: `private:${OWNER}`,
    at: old, saidAt: old, importance: 0.6,
  })), styles: { 'qq:30000001': ['习惯短句', '偶尔叠字', '常用语气词'] } })
  const at = Date.now() - DAY
  s.logs.set(dayKey(at), [{ chatId: `private:${OWNER}`, uid: OWNER, who: '主人', text: '今天过得不错，下午去散步了', t: at }])
  const memory = s.memory()
  assert.equal(await memory.buildProfile(OWNER), true)
  const result = await memory.consolidate()
  assert.equal(result.ok, true, result.message)
  await memory.importCandidates('小明喜欢吃辣')
  const mood = createMood({ getConfig: () => s.cfg, dsh: s.dsh, log })
  assert.ok(await mood.judge({ userText: '真棒', reply: '嘿嘿' }))
  for (const marker of ['整理长期记忆', '回顾自己和', '自然会被带上', '人物小档案', '整理自己的记忆', '长期印象', '可以并成一条', '从旧档案', '心情变化']) {
    const call = s.calls.find((c) => c.system.includes(marker))
    assert.ok(call, `必须实际走到 ${marker} 的模型调用`)
    assertName(call.system)
  }
})

test('自动提炼拒绝当前名、旧名和自称的事实，保留别人及双方相处的事实', async (t) => {
  const facts = [
    ...['Claude', '大肥鱼', '肥鱼', '鱼鱼', '我自己'].map((about) => ({ text: `${about}喜欢白米饭`, about })),
    { text: 'Claude喜欢白米饭' },
    { text: '有个叫 Claude 的人喜欢白米饭' },
    { text: '她有蓝色头发', aboutName: 'Claude' },
    { text: '机器人喜欢白米饭', about_qq: BOT },
    { text: '主人喜欢喝茶', about: '主人', about_qq: OWNER },
    { text: '主人答应周末陪Claude看电影', about: '主人', about_qq: OWNER },
    { text: 'Claude的朋友喜欢画画' },
  ].map((fact) => ({ ...fact, speaker: OWNER, importance: 0.6 }))
  const s = setup(t, ({ system }) => system.includes('整理长期记忆') ? JSON.stringify({ facts }) : '{"insights":[],"style":[]}')
  s.select('claude', 'Claude')
  const at = Date.now()
  s.logs.set(dayKey(at), [{ chatId: `private:${OWNER}`, uid: OWNER, who: '主人', text: '我喜欢喝茶，周末陪Claude看电影', t: at }])
  const memory = s.memory()
  assert.equal((await memory.consolidate({ includeToday: true })).ok, true)
  assert.deepEqual(memory.list('').map((m) => m.text).sort(), [
    '主人喜欢喝茶', '主人答应周末陪Claude看电影', 'Claude的朋友喜欢画画',
  ].sort())
})

test('旧档案导入也过滤她自己，当前名与旧名不会出现在第三人的导入候选里', async (t) => {
  const s = setup(t, () => JSON.stringify([
    { text: 'Claude有蓝色头发', about: 'Claude' },
    { text: '大肥鱼喜欢白米饭', about: '大肥鱼' },
    { text: '有个叫 Claude 的人喜欢白米饭' },
    { text: '小明喜欢吃辣', about: '小明' },
    { text: '主人给Claude买了礼物', about: '主人' },
  ]))
  s.select('claude', 'Claude')
  const memory = s.memory()
  const candidates = await memory.importCandidates('旧档案内容')
  assert.deepEqual(candidates.map((m) => m.aboutName).sort(), ['主人', '小明'].sort())
  assert.equal(memory.importCommit(candidates), 2)
  assert.equal(memory.importCommit([{ text: 'Claude有蓝色头发', aboutName: 'Claude' }, { text: '大肥鱼喜欢白米饭', aboutName: '大肥鱼' }]), 0)
  assertName(s.calls[0].system)
})

test('同一个记忆和心情实例在切换人格与保存改名后，下一次调用立即使用新名', async (t) => {
  const s = setup(t)
  const memory = s.memory()
  const mood = createMood({ getConfig: () => s.cfg, dsh: s.dsh, log })
  for (const [id, name] of [['dafeiyu', '大肥鱼'], ['claude', 'Claude'], ['claude', 'Alice']]) {
    s.select(id, name)
    s.calls.length = 0
    await memory.importCandidates('小明喜欢辣椒')
    await mood.judge({ userText: '你好', reply: '你好呀' })
    assert.equal(s.calls.length, 2)
    for (const call of s.calls) assertName(call.system, name)
  }
})

test('目的引擎以当前名识别自我素材和身份话题，保留旧称兼容；生成与回包清洗同步换名', async (t) => {
  const s = setup(t)
  s.select('claude', 'Claude')
  const now = Date.now()
  const materials = collectMaterials({ now, ownerUin: OWNER, roleName: selfName(s.cfg), roleAliases: selfNames(s.cfg),
    conversations: [{ key: `private:${OWNER}`, recentMessages: ['Claude', '大肥鱼', '鱼鱼'].map((name, i) => ({
      text: `${name}今天真可爱`, time: now - i, isOwner: true,
    })) }],
  }).items
  assert.equal(materials.length, 3)
  for (const material of materials) {
    assert.equal(material.selfRef, true)
    assert.ok(material.needAffinity.identity > 0)
  }
  assert.ok(needAffinity('Claude', selfName(s.cfg)).identity > 0)
  s.cfg.enabled = true
  s.cfg.ext.purpose = { enabled: true, minMaterials: 0 }
  Object.assign(s.cfg.speakUp, { awakeFrom: 0, awakeTo: 24 })
  const prompts = [], sent = []
  const purpose = createPurpose({ getConfig: () => s.cfg, log,
    personaText: () => currentPersonaText(s.cfg.persona.current),
    memory: () => ({ list: () => [{ id: 'm1', text: '主人周末想找人一起玩游戏', importance: 0.8, at: now }] }),
    hub: { ...s.hub, lastOwnerChatAt: 0,
      runSystemTurn: async (_key, _title, prompt) => { prompts.push(prompt); return `${selfName(s.cfg)}：一起玩吧` },
      deliver: async (_chat, text) => { sent.push(text); return { sent: text } },
    },
  })
  assertName((await purpose.preview()).prompt)
  s.select('alice', 'Alice')
  assertName((await purpose.preview()).prompt, 'Alice')
  s.cfg.persona.current = 'claude'
  assert.equal((await purpose.fire()).outcome, 'sent')
  assertName(prompts[0])
  assert.equal(sent[0], '一起玩吧')
  s.select('alice', 'Alice')
  assert.equal(cleanReply('Alice：你好', undefined, s.cfg), '你好')
  assert.equal(cleanReply('大肥鱼：你好', undefined, s.cfg), '你好')
})

test('联动工具描述刷新后使用当前人格名', (t) => {
  const s = setup(t)
  const tools = new Map()
  s.cfg.bridge.dshTools = true
  const bridge = createBridge({ getConfig: () => s.cfg, log,
    ctx: { get: () => ({ register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } }) },
    mods: { dshTools: () => [], listen: () => () => {} }, hub: s.hub,
  })
  t.after(() => bridge.dispose())
  bridge.refresh()
  assert.equal(tools.size, 3)
  for (const tool of tools.values()) assertName(tool.description, '大肥鱼')
  for (const name of ['Claude', 'Alice']) {
    s.select('custom', name)
    bridge.refresh()
    assert.equal(tools.size, 3)
    for (const tool of tools.values()) assertName(tool.description, name)
  }
})
