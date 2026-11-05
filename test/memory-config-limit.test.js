// 面板调整自动记忆容量：复用既有来源配额，不改存储和淘汰规则。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { normalize, mergeFromPanel, saveConfig, loadConfig } from '../src/core/config.js'
import { createMemoryStore } from '../src/features/memory.js'
import { createMemoryStorage } from '../src/features/memory-store.js'

function panelHarness(initial = {}) {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const marker = '    exports.apply = apply'
  assert.ok(source.includes(marker))
  let loader
  new Script(source.replace(marker, '    exports.capacityTest = { Mood, resizeMemoryCapacity }\n' + marker)).runInNewContext({
    window: { __ModuleLoader__: { load: (value) => { loader = value } } },
  })
  let hook = 0
  const slots = []
  const React = {
    Component: class {}, Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const i = hook++
      if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
      return [slots[i], (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }]
    },
    useRef: (init) => {
      const i = hook++
      if (!(i in slots)) slots[i] = { current: init }
      return slots[i]
    },
    useEffect() {}, useCallback: (fn) => fn, useMemo: (fn) => fn(),
  }
  const panel = loader.factory(() => React).capacityTest
  let draft = normalize(initial)
  const render = () => {
    hook = 0
    return panel.Mood({ st: { modules: [{ id: 'memory', running: true }] }, draft, setDraft: (value) => { draft = value }, toast() {} })
  }
  const findInput = (node) => {
    if (!node || typeof node !== 'object') return null
    if (Array.isArray(node)) return node.map(findInput).find(Boolean) || null
    if (node.type === 'input' && node.props['aria-label'] === '自动记忆容量') return node
    return findInput(node.children)
  }
  return { panel, input: () => findInput(render()), draft: () => draft }
}

function isolatedDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-memory-capacity-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

test('容量输入显示实际来源配额之和，调整并保存不会改掉其他设置', (t) => {
  isolatedDir(t)
  const ui = panelHarness({ memory: { recallCount: 7 } })
  assert.equal(ui.input().props.value, 3000)
  ui.input().props.onFocus()
  for (const raw of ['6', '60', '600', '6000']) ui.input().props.onChange({ target: { value: raw } })
  assert.equal(ui.input().props.value, '6000')
  assert.deepEqual(JSON.parse(JSON.stringify(ui.draft().memory.capacity)), { auto: 4000, event: 1200, diary: 800 })
  ui.input().props.onBlur({ target: { value: '6000' } })
  assert.equal(ui.input().props.value, 6000)
  const normalized = mergeFromPanel(normalize({}), { memory: ui.draft().memory })
  assert.equal(normalized.memory.recallCount, 7)
  saveConfig(normalized)
  assert.deepEqual(loadConfig().memory.capacity, { auto: 4000, event: 1200, diary: 800 })
})

test('旧的自定义配额按实际总数展示，调整时保留比例与零配额', () => {
  const ui = panelHarness({ memory: { capacity: { auto: 2100, event: 700, diary: 500 } } })
  assert.equal(ui.input().props.value, 3300)
  ui.input().props.onFocus()
  ui.input().props.onChange({ target: { value: '6600' } })
  assert.deepEqual(JSON.parse(JSON.stringify(ui.draft().memory.capacity)), { auto: 4200, event: 1400, diary: 1000 })
  const resized = JSON.parse(JSON.stringify(ui.panel.resizeMemoryCapacity({ auto: 2, event: 0, diary: 1 }, 6000)))
  assert.deepEqual(resized, { auto: 4000, event: 0, diary: 2000 })
  assert.deepEqual(JSON.parse(JSON.stringify(ui.panel.resizeMemoryCapacity({ auto: 0, event: 0, diary: 0 }, 6000))), { auto: 4000, event: 1200, diary: 800 })
})

test('越界输入离开时恢复编辑前的配额', () => {
  const ui = panelHarness()
  ui.input().props.onFocus()
  ui.input().props.onChange({ target: { value: '6000' } })
  ui.input().props.onChange({ target: { value: '100001' } })
  ui.input().props.onBlur({ target: { value: '100001' } })
  assert.deepEqual(JSON.parse(JSON.stringify(ui.draft().memory.capacity)), { auto: 2000, event: 600, diary: 400 })
  assert.equal(ui.input().props.value, 3000)
})

for (const backend of ['sqlite', 'json']) {
  test(`${backend}：面板提高容量后旧 2000 条自动记忆不会在新增时被淘汰`, (t) => {
    const dir = isolatedDir(t)
    const now = Date.now()
    const items = Array.from({ length: 2000 }, (_, i) => ({ id: `auto-${i}`, text: `自动记忆 ${i}`, about: 'existing', source: 'auto', at: now - i, importance: 0.5 }))
    writeFileSync(join(dir, 'memories.json'), JSON.stringify({ items }))
    if (backend === 'json') writeFileSync(join(dir, 'memory-json-fallback.json'), '{}')
    const storage = createMemoryStorage({ directory: dir, log: { info() {}, warn() {}, debug() {} } })
    t.after(() => storage.close())
    assert.equal(storage.status().backend, backend)
    const cfg = normalize({ memory: { capacity: { auto: 4000, event: 1200, diary: 800 } } })
    const hub = { chatLogDays: () => [], chatLogOf: () => [], speakersOf: () => [] }
    const memory = createMemoryStore({ dsh: {}, getConfig: () => cfg, hub, log: { info() {}, warn() {}, debug() {} } })
    const result = memory.add({ source: 'auto', text: '这是新添加的记忆', about: 'new-user', importance: 0.8 })
    assert.equal(result.ok, true)
    const saved = storage.load().items
    assert.equal(saved.length, 2001)
    assert.ok(saved.some((m) => m.id === 'auto-0'))
    assert.ok(saved.some((m) => m.id === 'auto-1999'))
    assert.equal(createMemoryStore({ dsh: {}, getConfig: () => cfg, hub, log: { info() {}, warn() {}, debug() {} } }).list('').length, 2001)
  })
}
