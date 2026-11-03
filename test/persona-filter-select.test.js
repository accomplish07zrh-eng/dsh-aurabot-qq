// 人物墙的筛选控件：替换原生下拉后仍能筛选并支持键盘。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

function setupPanel() {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const marker = '    exports.apply = apply'
  assert.ok(source.includes(marker))
  let loader
  new Script(source.replace(marker, '    exports.filterTest = { PersonaWall, Select }\n' + marker)).runInNewContext({
    window: { innerWidth: 1200, __ModuleLoader__: { load: (value) => { loader = value } } },
  })
  let hook = 0
  const slots = []
  const React = {
    Component: class {}, Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => {
      const i = hook++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }]
    },
    useRef: (initial) => {
      const i = hook++
      if (!(i in slots)) slots[i] = { current: initial }
      return slots[i]
    },
    useEffect() {}, useCallback: (fn) => fn, useMemo: (fn) => fn(),
  }
  const panel = loader.factory(() => React).filterTest
  const render = (component, props) => { hook = 0; return component(props) }
  return { panel, slots, render }
}

test('人物墙的群、标签、状态筛选保留全部选项和筛选功能', () => {
  const { panel, slots, render } = setupPanel()
  slots[0] = [
    { qq: '10001', name: '主人', isOwner: true, groups: [{ id: '1', name: '测试群' }], tags: ['喜欢'], notes: 1 },
    { qq: '10002', name: '朋友', isOwner: false, groups: [], tags: [], notes: 0 },
  ]
  const wall = () => render(panel.PersonaWall, { toast() {} })
  const filters = () => wall().children[0].children[0].children.slice(1)
  assert.deepEqual(Array.from(filters(), (f) => f.props.ariaLabel), ['所有群', '所有标签', '所有状态'])
  const status = filters()[2]
  assert.deepEqual(Array.from(status.props.options, (o) => o.label), ['所有状态', '主人', '最近 7 天活跃', '有人物关系', '有相处经验'])
  status.props.onChange('owner')
  const rows = wall().children[0].children[1].children[0]
  assert.deepEqual(Array.from(rows, (row) => row.props.key), ['10001'])
  filters()[2].props.onChange('')
  assert.equal(wall().children[0].children[1].children[0].length, 2)
})

test('自定义筛选可用键盘选择、离开后收起', () => {
  const { panel, render } = setupPanel()
  const options = [{ value: '', label: '所有状态' }, { value: 'owner', label: '主人' }]
  let value = ''
  const select = () => render(panel.Select, { value, options, ariaLabel: '所有状态', onChange: (v) => { value = v } })
  let tree = select()
  const key = (node, name) => node.children[0].props.onKeyDown({ key: name, preventDefault() {} })
  assert.equal(tree.children[0].props['aria-label'], '所有状态')
  key(tree, 'ArrowDown')
  tree = select()
  assert.equal(tree.children[0].props['aria-expanded'], true)
  assert.equal(tree.children[1].props.role, 'listbox')
  key(tree, 'ArrowDown')
  tree = select()
  key(tree, 'Enter')
  assert.equal(value, 'owner')
  tree = select()
  assert.equal(tree.children[0].props['aria-expanded'], false)
  assert.equal(tree.children[0].children[0].children[0], '主人')
  tree.children[0].props.onClick()
  tree = select()
  assert.equal(tree.children[0].props['aria-expanded'], true)
  tree.props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null })
  assert.equal(select().children[0].props['aria-expanded'], false)
})
