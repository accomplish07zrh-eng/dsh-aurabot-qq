import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
const mod = (await import('../index.mjs')).default

test('模块定义完整', () => {
  assert.equal(mod.id, 'weibo')
  assert.equal(mod.api, 1)
  assert.equal(typeof mod.setup, 'function')
  assert.ok(Array.isArray(mod.settings) && mod.settings.length > 0)
})

test('每个设置项都有 key/label/hint（不暴露裸控件）', () => {
  for (const s of mod.settings) {
    assert.ok(s.key, '缺 key')
    assert.ok(s.label, `${s.key} 缺 label`)
    assert.ok(s.hint, `${s.key} 缺 hint`)
  }
})

test('危险操作默认安全：试运行 + 每日上限 + 间隔都在代码里', () => {
  assert.match(src, /dryRun/)
  assert.match(src, /minGapMinutes/)
  assert.match(src, /caps/)
  assert.match(src, /PRESETS/)
})

test('不把登录态塞进模块代码', () => {
  assert.ok(!/SUB=[A-Za-z0-9]/.test(src), '源码里不该有 cookie')
})

test('工具命名统一 weibo_ 前缀', () => {
  const names = [...src.matchAll(/name: '(weibo_[a-z_]+)'/g)].map((m) => m[1])
  assert.ok(names.length >= 7, `工具数量异常：${names.length}`)
  for (const n of names) assert.match(n, /^weibo_/)
})
