// 面板「小黑盒」页的源码契约：排期可编辑 + 卡片说明与模块新行为一致。
// 客户端是单文件 client/client.js，只能在源码上断言。
// 这些点在 2026-11-02 集中修过（排期从只读改可编辑、配图文案、刷新按钮的 ok 判断），
// 回退会直接红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

test('「今天发什么」的每一项都可改：风格/分区/字数/话题/额外要求', () => {
  // 排期从只读展示改成可编辑（对照模块 dailyPosts 的字段）
  assert.ok(src.includes("f.select('heybox.dailyPosts.' + i + '.style'"), '缺每篇风格下拉')
  assert.ok(src.includes("f.select('heybox.dailyPosts.' + i + '.topic'"), '缺每篇分区下拉')
  assert.ok(src.includes("f.num('heybox.dailyPosts.' + i + '.wordsMin'"), '缺每篇字数下限')
  assert.ok(src.includes("f.num('heybox.dailyPosts.' + i + '.wordsMax'"), '缺每篇字数上限')
  assert.ok(src.includes("f.text('heybox.dailyPosts.' + i + '.hint'"), '缺每篇额外要求')
  // 篇数也能增删
  assert.ok(src.includes('const addPostSlot = () => setDraft'), '缺「新增一篇」')
  assert.ok(src.includes('const removePostSlot = (i) => setDraft'), '缺「删掉这篇」')
})

test('话题是多选（带搜索），不是只读列表', () => {
  assert.ok(src.includes('const [topicKw, setTopicKw] = useState'), '缺话题搜索关键词状态')
  assert.ok(src.includes('const toggleTopic = (i, name) => setDraft'), '缺话题勾选')
  assert.ok(src.includes('const renderTopicGroups = function (i)'), '缺话题分组渲染')
  assert.ok(src.includes('const renderSelSummary = function (i)'), '缺已选摘要')
})

test('卡片说明与模块新行为一致：配图按字数自动配，不再说「走小黑盒图床」', () => {
  assert.ok(src.includes('配图按正文字数自动配'), '说明要写自动配图')
  assert.ok(!src.includes('配图走小黑盒图床'), '旧的「配图走小黑盒图床」不该还在')
})

test('刷新分区/话题按接口真实 ok 状态给提示，零结果不冒充成功', () => {
  // 模块侧在「一个都没拉到」时返回 ok:false，面板要照实显示失败
  assert.ok(src.includes("toast(r.message || '已刷新', r.ok === false ? 'err' : 'ok')"),
    '刷新按钮要用 r.ok 决定提示样式')
})

test('分区下拉优先用接口拉到的话题/分区全表，不是写死几个', () => {
  assert.ok(src.includes("f.select('heybox.defaultTopic'"), '缺默认分区下拉')
  assert.ok(src.includes('s.topicsList'), '分区下拉要读 topicsList')
  // 拉不到时的内置保底仍在
  assert.ok(src.includes("{ value: 7214, label: '盒友杂谈'"), '缺内置保底分区')
})
