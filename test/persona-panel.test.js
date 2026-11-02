// 人物记忆面板：复用已有画像、事实、群印象和梗概，写入后要立即反映到记忆库。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { normalize } from '../src/core/config.js'
import { createMemoryStore } from '../src/features/memory.js'
import memoryModule from '../src/modules/memory/index.js'

const OWNER = '10000001'
const ALICE = '30000001'
const BOB = '30000002'
const CHARLIE = '30000003'
const log = { info() {}, warn() {}, debug() {} }

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-persona-panel-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const now = Date.now()
  const file = join(dir, 'memories.json')
  const initial = {
    rev: 7,
    items: [
      { id: 'owner', text: '主人喜欢喝茶', about: OWNER, aboutName: '主人', speaker: OWNER, status: 'fact', tier: 0, at: now - 1000, saidAt: now - 1000 },
      { id: 'alice-fact', text: '阿明喜欢画画', about: ALICE, aboutName: '阿明', speaker: ALICE, status: 'fact', tier: 2, at: now - 300, saidAt: now - 500 },
      { id: 'alice-hearsay', text: '听说阿明喜欢爬山', about: ALICE, speaker: BOB, status: 'hearsay', tier: 1, at: now - 400, saidAt: now - 400 },
      { id: 'alice-old', text: '阿明也许喜欢看球', about: ALICE, status: 'guess', tier: 3, invalidAt: now - 200, at: now - 600 },
      { id: 'bob', text: '阿杰喜欢种花', about: BOB, aboutName: '阿杰', speaker: BOB, at: now - 900 },
      { id: 'unrelated', text: '群里聊了天气', about: '', scope: 'group', chatId: 'group:777', at: now - 100 },
    ],
    profiles: {
      [OWNER]: { text: '主人的小档案', name: '主人', at: now - 100 },
      [ALICE]: { text: '旧档案', name: '明明', alias: '阿明', style: '话很短', persona: '安静', handle: '慢慢聊', at: now - 50, extra: '保留' },
    },
    dirtyProfiles: { [ALICE]: true },
    chats: {
      'group:777': { vibe: '热闹', topics: '画画', impression: '很友好', updatedAt: now - 300, extra: '保留' },
      'group:888': { vibe: '安静', topics: '', impression: '', updatedAt: now - 100 },
      [`private:${ALICE}`]: { vibe: '旧格式私聊', updatedAt: now },
    },
    gists: [
      { id: 'alice-gist', kind: 'gist', chatId: 'group:777', about: ALICE, level: 1, text: '我记得阿明喜欢画画', at: now - 100, saidAt: now - 500 },
      { id: 'owner-impression', kind: 'gist', chatId: `private:${OWNER}`, about: OWNER, level: 2, text: '主人关心我', at: now - 300, saidAt: now - 400 },
      { id: 'group-gist', kind: 'gist', chatId: 'group:777', about: '', scope: 'group', level: 1, text: '寒潮围巾话题热闹', at: now - 500, saidAt: now - 200 },
      { id: 'charlie-gist', kind: 'gist', chatId: `private:${CHARLIE}`, about: CHARLIE, level: 1, text: '我和朋友聊过旅行', at: now - 700, saidAt: now - 600 },
      { id: 'other-kind', kind: 'other', text: '不属于梗概', at: now },
    ],
  }
  writeFileSync(file, JSON.stringify(initial))
  const hub = {
    groupNames: new Map([['777', '绘画群']]),
    chatLogDays: () => ['today'],
    chatLogOf: () => [
      { uid: OWNER, who: '主人', t: now - 2000 },
      { uid: ALICE, who: '阿明', t: now - 100 },
      { uid: ALICE, who: '阿明', t: now - 20, forgottenAt: now - 10 },
      { uid: ALICE, who: 'bot', t: now - 10 },
    ],
  }
  const cfg = normalize({ ownerQQ: OWNER, memory: { dailyConsolidate: false } })
  const make = () => createMemoryStore({ getConfig: () => cfg, hub, log })
  const state = () => JSON.parse(readFileSync(file, 'utf8'))
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { cfg, hub, make, state, now }
}

test('人物墙包含画像、事实及个人梗概，主人优先，详情按 QQ 精确关联', (t) => {
  const s = setup(t)
  const mem = s.make()
  const people = mem.personaOverview()
  assert.deepEqual(people.map((p) => p.qq), [OWNER, ALICE, BOB, CHARLIE])
  assert.equal(people[0].isOwner, true)
  const alice = people.find((p) => p.qq === ALICE)
  assert.equal(alice.notes, 3, '包括过时的事实')
  assert.equal(alice.lastActive, s.now - 100, '忘记的记录和机器人的话不能算发言')
  assert.equal(alice.style, '话很短')
  assert.equal(people.find((p) => p.qq === BOB).name, '阿杰', '没有画像时用事实里的名字')
  assert.equal(people.find((p) => p.qq === BOB).lastActive, s.now - 400, '关于别人的事实也能记录发言人的活跃时间')
  assert.equal(people.find((p) => p.qq === CHARLIE).notes, 0, '只有梗概的人也会出现')
  assert.deepEqual(mem.personaPerson(CHARLIE).gists.map((g) => g.id), ['charlie-gist'])
  const detail = mem.personaPerson(ALICE)
  assert.equal(detail.person.qq, ALICE)
  assert.deepEqual(new Set(detail.notes.map((m) => m.id)), new Set(['alice-fact', 'alice-hearsay', 'alice-old']))
  assert.deepEqual(detail.gists.map((g) => g.id), ['alice-gist'], '群聊整体的梗概不会冒充个人梗概')
  assert.equal(mem.personaPerson(''), null)
  assert.equal(mem.personaPerson('99999999'), null)
})

test('保存人物印象只修改允许的字段，保留元数据并递增版本', (t) => {
  const s = setup(t)
  const mem = s.make()
  const longStyle = '健谈'.repeat(120)
  assert.equal(mem.savePersonaPerson(ALICE, { alias: ' 小明 ', style: longStyle, persona: '开朗', handle: '直接说', text: '' }).ok, true)
  const state = s.state()
  assert.equal(state.rev, 8)
  assert.equal(state.profiles[ALICE].alias, '小明')
  assert.equal(state.profiles[ALICE].text, '')
  assert.equal(state.profiles[ALICE].style, longStyle, '手工保存不能截断长画像')
  assert.equal(state.profiles[ALICE].persona, '开朗')
  assert.equal(state.profiles[ALICE].handle, '直接说')
  assert.equal(state.profiles[ALICE].name, '明明')
  assert.equal(state.profiles[ALICE].extra, '保留')
  assert.equal(state.dirtyProfiles[ALICE], undefined)
  assert.equal(s.make().personaPerson(ALICE).person.alias, '小明', '重建 store 后仍然可读')
  assert.match(mem.contextFor({ kind: 'private', userId: ALICE }), /称呼：小明/, '保存的画像会进入聊天上下文')
  assert.equal(mem.savePersonaPerson('__proto__', { text: '错误' }).ok, false)
  assert.equal(mem.savePersonaPerson(ALICE, { name: '不允许修改' }).ok, false)
  assert.equal(s.state().rev, 8)
  assert.equal(mem.savePersonaPerson(BOB, { text: '新档案' }).ok, true, '只有事实的人也可以新建画像')
  assert.equal(s.state().rev, 9)
})

test('群印象按更新时间排列，支持部分修改、清空和重启后读取', (t) => {
  const s = setup(t)
  const mem = s.make()
  const chats = mem.chats()
  assert.deepEqual(chats.map((c) => c.chatId), ['group:888', 'group:777'])
  assert.equal(chats[1].name, '绘画群')
  assert.equal(mem.saveChat('group:777', { vibe: '轻松', topics: '音乐' }).ok, true)
  let state = s.state()
  assert.equal(state.rev, 8)
  assert.equal(state.chats['group:777'].vibe, '轻松')
  assert.equal(state.chats['group:777'].impression, '很友好')
  assert.equal(state.chats['group:777'].extra, '保留')
  assert.equal(s.make().chats().find((c) => c.chatId === 'group:777').topics, '音乐')
  const group = { kind: 'group', groupId: '777', chatId: 'group:777' }
  assert.match(mem.contextFor(group), /轻松；音乐；很友好/)
  assert.equal(mem.saveChat('group:777', { vibe: '', topics: '', impression: '' }).ok, true)
  assert.doesNotMatch(mem.contextFor(group), /这个群的印象/)
  state = s.state()
  assert.equal(state.rev, 9)
  assert.equal(state.chats['group:777'].vibe, '')
  assert.equal(state.chats['group:777'].topics, '')
  assert.equal(state.chats['group:777'].impression, '')
  assert.equal(state.chats['group:777'].extra, '保留')
  assert.equal(mem.saveChat('group:777', { vibe: '又热闹了' }).ok, true, '清空后仍能编辑')
  assert.equal(mem.saveChat(`private:${ALICE}`, { vibe: '不允许' }).ok, false)
  assert.equal(mem.saveChat('group:888', { unexpected: '不允许' }).ok, false)
  assert.equal(s.state().rev, 10)
})

test('梗概按发生时间排序，可按聊天、层级和人物筛选；删除会刷新检索索引', (t) => {
  const s = setup(t)
  const mem = s.make()
  assert.deepEqual(mem.gists().map((g) => g.id), ['group-gist', 'owner-impression', 'alice-gist', 'charlie-gist'])
  assert.deepEqual(mem.gists({ chatId: 'group:777', level: '1' }).map((g) => g.id), ['group-gist', 'alice-gist'])
  assert.deepEqual(mem.gists({ about: OWNER, level: 2 }).map((g) => g.id), ['owner-impression'])
  const recall = () => mem.recall('寒潮围巾', { where: 'group:777', groupChatId: 'group:777', shown: false })
  assert.ok(recall().some((hit) => hit.it.id === 'group-gist'))
  assert.equal(mem.deleteGist('group-gist').ok, true)
  assert.equal(s.state().rev, 8)
  assert.ok(!recall().some((hit) => hit.it.id === 'group-gist'), '已删除的梗概不能继续被想起')
  assert.ok(!s.make().gists().some((g) => g.id === 'group-gist'))
  assert.equal(mem.deleteGist('group-gist').ok, false)
  assert.equal(mem.deleteGist('other-kind').ok, false)
  assert.equal(s.state().rev, 8)
})

test('人物和记忆面板路由接到同一份 store', async (t) => {
  const s = setup(t)
  const routes = new Map()
  const api = {
    config: () => s.cfg,
    core: { hub: s.hub, http: { query: (req) => req.query || {}, body: async (req) => req.body || {} } },
    log, context() {}, on() {}, every() {}, tool() {}, route: (path, handler) => routes.set(path, handler),
  }
  memoryModule.setup(api)
  const call = (path, data = {}) => {
    assert.ok(routes.has(path), `缺少路由 ${path}`)
    return routes.get(path)(data)
  }
  assert.equal((await call('/persona/overview')).list[0].qq, OWNER)
  assert.equal((await call('/persona/person', { query: { qq: ALICE } })).notes.length, 3)
  assert.equal((await call('/persona/person', { query: { qq: '999' } })).ok, false)
  assert.equal((await call('/persona/person/save', { body: { qq: ALICE, alias: '小明' } })).ok, true)
  assert.equal((await call('/profiles')).list.find((p) => p.qq === ALICE).alias, '小明')
  assert.equal((await call('/memory/chats')).list.length, 2)
  assert.equal((await call('/memory/chats/save', { body: { chatId: 'group:777', vibe: '欢快' } })).ok, true)
  assert.equal((await call('/memory/gists', { query: { chatId: 'group:777', level: '1' } })).list.length, 2)
  assert.equal((await call('/memory/gists/delete', { body: { id: 'alice-gist' } })).ok, true)
  assert.deepEqual((await call('/persona/person', { query: { qq: ALICE } })).gists, [])
  assert.equal((await call('/memory/update', { body: { id: 'alice-fact', text: '阿明现在喜欢雕塑' } })).ok, true)
  assert.equal((await call('/persona/person', { query: { qq: ALICE } })).notes.find((m) => m.id === 'alice-fact').text, '阿明现在喜欢雕塑')
  assert.equal((await call('/memory/delete', { body: { id: 'alice-fact' } })).ok, true)
  assert.equal((await call('/persona/person', { query: { qq: ALICE } })).notes.length, 2)
})

test('面板注册人物记忆及四个子页，旧人格页仍可访问', () => {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const marker = '    exports.apply = apply'
  assert.ok(source.includes(marker))
  const instrumented = source.replace(marker, '    exports.panelTest = { TABS, TAB_MODS, NAV_GROUPS, AurabotPage, PersonaMemory, PersonaFact, GistLine }\n' + marker)
  const script = new Script(instrumented, { filename: 'client/client.js' })
  const storage = new Map()
  const localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) }
  let loader
  script.runInNewContext({ localStorage, window: { __ModuleLoader__: { load: (value) => { loader = value } } } })
  let hook = 0
  const state = []
  const React = {
    Component: class {}, Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => {
      const i = hook++
      if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial
      return [state[i], (value) => { state[i] = typeof value === 'function' ? value(state[i]) : value }]
    },
    useEffect() {}, useRef: () => ({ current: null }), useCallback: (fn) => fn, useMemo: (fn) => fn(),
  }
  const { panelTest: panel } = loader.factory(() => React)
  const tabs = Array.from(panel.TABS)
  assert.equal(tabs.filter((tab) => tab.id === 'persona').length, 1)
  assert.equal(tabs.find((tab) => tab.id === 'persona').label, '人物记忆')
  assert.equal(tabs.findIndex((tab) => tab.id === 'persona'), tabs.findIndex((tab) => tab.id === 'mood') + 1)
  assert.equal(tabs.find((tab) => tab.id === 'character').label, '人格')
  assert.deepEqual(Array.from(panel.TAB_MODS.persona), ['memory'])
  const self = panel.NAV_GROUPS.find((group) => group.id === 'self')
  assert.ok(self.tabs.indexOf('persona') > self.tabs.indexOf('mood'))
  assert.match(source, /character: Persona/)
  assert.match(source, /persona: PersonaMemory/)
  assert.ok(!source.slice(source.indexOf('function Mood('), source.indexOf('const PERSON_FIELDS')).includes('ProfilesCard'))

  const render = () => { hook = 0; return panel.PersonaMemory({ toast() {} }) }
  let tree = render()
  const seg = tree.children[0].children[0]
  assert.deepEqual(Array.from(seg.props.options, (o) => o.label), ['人物墙', '群印象', '时间轴'])
  assert.equal(tree.children[1].type.name, 'PersonaWall')
  seg.props.onChange('chats')
  assert.equal(render().children[1].type.name, 'PersonaChats')
  seg.props.onChange('timeline')
  assert.equal(render().children[1].type.name, 'PersonaTimeline')

  const text = (node) => (node == null || node === false ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.children))
  state.length = 0; hook = 0
  const fact = panel.PersonaFact({ m: { id: '1', text: '一条事实', tier: 1, status: 'hearsay' }, toast() {}, onChanged() {} })
  assert.match(text(fact), /一条事实/)
  assert.match(text(fact), /琐碎/)
  assert.match(text(fact), /听说/)
  const line = panel.GistLine({ list: [{ id: '2', text: '主人爱我', level: 2, chatId: 'private:123', at: 1 }], toast() {}, onChanged() {}, showFrom: true })
  assert.match(text(line), /主人爱我/)
  assert.match(text(line), /私聊 123/)

  storage.set('aurabot.tab', 'persona')
  storage.set('aurabot.navlast', JSON.stringify({ self: 'persona' }))
  state.length = 0; hook = 0
  panel.AurabotPage()
  assert.equal(state[3], 'character', '旧版选中的人格页迁移到新标识')
  assert.equal(JSON.parse(storage.get('aurabot.navlast')).self, 'character')
  storage.set('aurabot.tab', 'persona')
  state.length = 0; hook = 0
  panel.AurabotPage()
  assert.equal(state[3], 'persona', '迁移之后可以记住新的人物记忆页')
})
