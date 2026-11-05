// 扩展自己占一页时的两个小约定：
//   1) 定义里写 group（或 defaults.__panelGroup）就能挂到「人设」这类分组下面；
//   2) 设置里有 enabled 的扩展，标题栏右侧显示和「表情包」页一样的总开关，设置列表里不重复。
// 这两个约定是从「讨饭 / 印象卡片 / 价格监控 每次升级都掉进『系统』组」那个反馈来的。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

function loadPanel () {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const marker = '    exports.apply = apply'
  const instrumented = source.replace(marker, '    exports.panelTest = { TABS, NAV_GROUPS, navGroupOf, ExtPage }\n' + marker)
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
    useEffect () {}, useRef: () => ({ current: null }), useCallback: (fn) => fn, useMemo: (fn) => fn(),
  }
  return { panel: loader.factory(() => React).panelTest, source, reset: () => { hook = 0 } }
}

test('扩展页可以挂到自己写的分组下面', () => {
  const { panel, source } = loadPanel()
  assert.equal(panel.navGroupOf({ id: 'ext:impression-card', ext: 'impression-card', group: 'self' }).id, 'self')
  assert.equal(panel.navGroupOf({ id: 'ext:beg-for-money', ext: 'beg-for-money', group: 'express' }).id, 'express')
  assert.equal(panel.navGroupOf({ id: 'ext:price-watch', ext: 'price-watch', group: 'platform' }).id, 'platform')
  assert.equal(panel.navGroupOf({ id: 'ext:x', ext: 'x', group: 'character' }).id, 'self', '组里任一页 id 也能认')
  assert.equal(panel.navGroupOf({ id: 'ext:y', ext: 'y', label: '天气' }).id, 'system', '不写 group 还是系统组')
  // 老宿主不返回 group 时的兜底标记
  assert.match(source, /extGroupOf/)
  assert.match(source, /__panelGroup/)
})

test('有 enabled 的扩展：标题栏放总开关，设置列表不重复', () => {
  const { panel, reset } = loadPanel()
  const st = {
    modules: [{
      id: 'demo', name: '演示扩展', description: '说明', defaults: { enabled: true }, flag: 'enabled',
      settings: [{ key: 'enabled', label: '总开关', type: 'switch' }, { key: 'a', type: 'text' }, { key: 'b', type: 'text' }],
      panel: false, errors: [],
    }],
    config: { ext: {} },
  }
  reset()
  const tree = panel.ExtPage({ st, draft: { ext: {} }, setDraft () {}, toast () {}, mod: 'demo' })
  const card = tree.children[0]
  assert.equal(card.props.title, '演示扩展')
  assert.equal(card.props.right.type.name, 'Switch', '标题栏右边应该是开关')
  assert.match(String(card.props.right.props.title), /开 \/ 关/, '开关要有说明')
  const rows = card.children[0]
  assert.ok(Array.isArray(rows))
  assert.deepEqual(rows.map((row) => row.props.label), ['a', 'b'], 'enabled 那一行不再重复')
})

test('没有 enabled 的扩展仍然是原来的徽标（面板自己画开关的不受影响）', () => {
  const { panel, reset } = loadPanel()
  const st = {
    modules: [{ id: 'demo', name: '演示', description: '', defaults: { active: true }, flag: 'active', settings: [{ key: 'a', type: 'text' }], panel: false, errors: [] }],
    config: { ext: {} },
  }
  reset()
  const tree = panel.ExtPage({ st, draft: { ext: {} }, setDraft () {}, toast () {}, mod: 'demo' })
  const right = tree.children[0].props.right
  assert.equal(right.type, 'span')
  assert.match(right.children.join(''), /demo/)
})
