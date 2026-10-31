// 面板「关于」页的源码契约：页签注册、组件接线、核心开发者与贡献者头像墙。
// 客户端是单文件 client/client.js（数据目录里没有构建产物），只能在源码上断言；
// 这样合并或重构时把这一页连同接线丢掉会直接红，而不是上线后才发现点不开。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

test('面板源码契约：「关于」页签注册在系统组，组件表与搜索索引都接上了', () => {
  assert.ok(src.includes("{ id: 'about', label: '关于' }"), '缺「关于」页签')
  assert.ok(src.includes("tabs: ['connect', 'model', 'access', 'local', 'modules', 'about', 'logs']"), '「关于」要排在「扩展」和「日志」之间')
  assert.ok(src.includes('about: About, logs: Logs'), '组件表缺 about → About 的接线')
  assert.ok(src.includes("about: '关于 关于我们 版本 许可 鸣谢 开源'"), '搜索索引缺「关于」关键词')
  assert.ok(src.includes('function About({ st })'), '缺 About 组件')
})

test('面板源码契约：「关于」页有核心开发者卡，三个人一个不落', () => {
  assert.ok(src.includes("title: '核心开发者'"), '缺「核心开发者」卡')
  assert.ok(src.includes("className: 'ab-devs'"), '核心开发者要用拱形网格排头像')
  assert.ok(src.includes("const devs = ['accomplish07zrh-eng', 'baihengaead', 'RookieApe-tao']"), '核心开发者名单被改了')
  for (const u of ['accomplish07zrh-eng', 'baihengaead', 'RookieApe-tao']) {
    assert.ok(src.includes(`'${u}'`), `核心开发者缺 ${u}`)
  }
  // 上头像、下名字：头像容器里先放首字母，图片盖在上面，拉不到也不留破图
  assert.ok(src.includes("n.slice(0, 1).toUpperCase()"), '头像要有首字母兜底')
  assert.ok(src.includes("e.currentTarget.style.display = 'none'"), '头像加载失败要隐藏，别留破图')
})

test('面板源码契约：贡献者头像墙走 contrib.rocks 自动更新', () => {
  assert.ok(src.includes('https://contrib.rocks/image?repo=accomplish07zrh-eng/dsh-aurabot-qq'), '贡献者头像墙地址没了，新人提交就不会自动出现')
  assert.ok(src.includes("referrerPolicy: 'no-referrer'"), '头像墙要带 no-referrer')
  assert.ok(src.includes("loading: 'lazy'"), '头像墙要懒加载，别拖慢面板首屏')
})

test('面板源码契约：「关于」页是只读的，不走任何写接口', () => {
  const start = src.indexOf('function About({ st })')
  const end = src.indexOf('function RecentLogs({ go })')
  assert.ok(start > 0 && end > start, 'About 组件位置异常')
  const body = src.slice(start, end)
  assert.ok(!body.includes("post('/"), '「关于」页不该有任何写请求')
  assert.ok(!body.includes('savePet('), '「关于」页不该保存配置')
})
