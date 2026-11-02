// 安全防护页源码契约：页签、组件、搜索索引、SSRF 模式配置与 host 注入都不能丢。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8')
const config = readFileSync(new URL('../src/core/config.js', import.meta.url), 'utf8')

test('安全防护页接上了页签、组件、搜索和 SSRF 模式配置', () => {
  assert.ok(client.includes("{ id: 'security', label: '安全防护' }"), '缺安全防护页签')
  assert.ok(client.includes("tabs: ['connect', 'model', 'access', 'security', 'backup', 'about', 'logs']"), '安全防护要注册在系统组')
  assert.ok(client.includes('security: Security'), '组件表缺 security → Security')
  assert.ok(client.includes('function Security({ st, draft, setDraft })'), '缺 Security 组件')
  assert.ok(client.includes("security: '安全 防护 ssrf 内网 图片"), '搜索索引缺安全防护关键词')
  assert.ok(client.includes("security: ['security', 'update']"), '安全防护页的未保存改动没接上')
  assert.ok(config.includes("security: { dangerConfirm: false, ssrfMode: 'strict' }"), '缺 ssrfMode 默认值')
  assert.ok(config.includes("c.security.ssrfMode = c.security.ssrfMode === 'loose' ? 'loose' : 'strict'"), '缺 ssrfMode 归一化')
  assert.ok(host.includes('setSsrpMode('), 'host 没把 ssrfMode 注入 net.js')
})

test('危险命令确认放在安全防护页，不能藏在聊天页', () => {
  const groupStart = client.indexOf('function Group(')
  const securityStart = client.indexOf('function Security(')
  const logsStart = client.indexOf('function Logs(')
  assert.ok(groupStart >= 0 && securityStart > groupStart && logsStart > securityStart, '页面组件边界找不到')
  const group = client.slice(groupStart, securityStart)
  const security = client.slice(securityStart, logsStart)
  assert.ok(security.includes('security.dangerConfirm'), '安全防护页缺危险命令确认')
  assert.ok(!group.includes('security.dangerConfirm'), '聊天页不该再出现危险命令确认')
})
