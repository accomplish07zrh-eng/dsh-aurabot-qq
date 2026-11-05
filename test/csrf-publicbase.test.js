// CSRF 闸与 public-base SSRF 收口的回归（2026-11-03 复审 P1-1 / P1-4）
//
// 背景（复审实测）：恶意网页可以从攻击者页面 fetch('http://127.0.0.1:<port>/save', {method:'POST'})——
// 请求 socket 是本机回环（面板闸放行）、跨站。没有 CSRF 校验时 /save、public-base、rotate
// 全都能被恶意页面打穿，无需暴露端口。
//
// 口径：写方法必须带同源 Origin 或合法 Sec-Fetch-Site；两者都没有 = 非浏览器客户端，放行
//（它们的防线是本机闸与各自的令牌）。/open/* 有 Bearer 密钥，被面板闸与 CSRF 同时豁免。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001'
const BOT = '20000002'

let fake
let api
let dataDir

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-csrf-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: true,
    setupDone: true,
    botQQ: BOT,
    ownerQQ: OWNER,
    allow: { private: [OWNER], groups: [] },
    snowluma: { autoStart: false, autoAttach: false, dir: join(dataDir, 'no-snowluma') },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
  }))
  fake = createFakeDsh({ brain: async () => '嗯' })
  fake.ctx.webServer.port = 5099
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await api.ready.catch(() => {})
})

after(async () => {
  try { fake.dispose() } catch (e) {}
  try { await api?.dispose?.() } catch (e) {}
})

test('CSRF：恶意 Origin 的写请求必须 403（复审 P1-1 回归）', async () => {
  // 复审实测：本机回环 socket + 恶意网页 Origin → POST /save 曾 200 且改掉了配置
  const r = await fake.call('/save', { ownerName: '攻击者' }, {
    host: '127.0.0.1:5099',
    origin: 'https://evil.example',
    'content-type': 'application/json',
  }, '127.0.0.1')
  assert.equal(r.status, 403, '恶意 Origin 的 /save 必须被 CSRF 闸拦下')
  assert.match(String(r.raw() || ''), /跨站/, '拒绝理由要写明是跨站')
})

test('CSRF：Sec-Fetch-Site: cross-site 也必须 403（不带 Origin 的变体）', async () => {
  const r = await fake.call('/save', { ownerName: '攻击者' }, {
    host: '127.0.0.1:5099',
    'sec-fetch-site': 'cross-site',
    'content-type': 'application/json',
  }, '127.0.0.1')
  assert.equal(r.status, 403, 'cross-site 的 Sec-Fetch-Site 必须拦')
})

test('CSRF：同源请求照常放行（本机面板不被误伤）', async () => {
  // 本机面板的 fetch 会带回环 Origin + same-origin
  const r = await fake.call('/save', { ownerName: '主人' }, {
    host: '127.0.0.1:5099',
    origin: 'http://127.0.0.1:5099',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  }, '127.0.0.1')
  assert.equal(r.status, 200, '同源写请求放行')
  // 配了 publicHostname 时，这个域名的 Origin 也算同源
  api.setConfig({ ...api.getConfig(), security: { ...api.getConfig().security, publicHostname: 'panel.example.com' } })
  const remote = await fake.call('/save', { ownerName: '主人' }, {
    host: 'panel.example.com',
    origin: 'https://panel.example.com',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  }, '127.0.0.1')
  assert.equal(remote.status, 200, '面板对外域名的 Origin 算同源（反代部署场景）')
  api.setConfig({ ...api.getConfig(), security: { ...api.getConfig().security, publicHostname: '' } })
})

test('CSRF：无 Origin/Sec-Fetch-Site 的客户端（curl 等）不受 CSRF 闸影响', async () => {
  // 非浏览器客户端不带这些头——它们的防线是本机闸与各自令牌，CSRF 只管浏览器跨站
  const r = await fake.call('/save', { ownerName: '脚本' }, { host: '127.0.0.1:5099', 'content-type': 'application/json' }, '127.0.0.1')
  assert.equal(r.status, 200, '无浏览器头的写请求不被 CSRF 误拦')
})

test('CSRF：/open/* 带正确密钥跨机放行（复审 P1-2 回归：上轮被面板闸误拦）', async () => {
  // 打开联动 + 拿密钥
  api.setConfig({ ...api.getConfig(), bridge: { ...api.getConfig().bridge, http: true } })
  const t = await fake.call('/bridge/token', null, { host: '127.0.0.1:5099' })
  const token = t.json().token
  assert.ok(token, '联动密钥拿到了')
  // 外网直连 + 正确 Bearer → 必须放行（上轮它被「默认拒绝」面板闸拦成 403）。
  // 注意 /open/* 的鉴权失败是 body 层 ok:false（HTTP 恒 200），断言要看 body。
  const r = await fake.call('/open/info', null, { authorization: 'Bearer ' + token }, '203.0.113.7')
  assert.equal(r.status, 200, '面板闸不再拦 /open/*（豁免生效）')
  assert.equal(r.json().ok, true, '正确密钥：业务放行')
  // 错误密钥：HTTP 仍是 200，但 body.ok = false（bridge 自己的 401 语义）
  const bad = await fake.call('/open/info', null, { authorization: 'Bearer wrong' }, '203.0.113.7')
  assert.equal(bad.json().ok, false, '错误密钥业务层拒绝')
  api.setConfig({ ...api.getConfig(), bridge: { ...api.getConfig().bridge, http: false } })
})

test('public-base：IPv4-mapped IPv6 不再绕过（复审 P1-4 回归）', async () => {
  // 旧手写正则只看字符串：https://[::ffff:127.0.0.1] 不匹配 127. 前缀，曾直接放行
  const r = await fake.call('/panel/pet/public-base', { publicBaseUrl: 'https://[::ffff:127.0.0.1]' }, {
    host: '127.0.0.1:5099',
    origin: 'http://127.0.0.1:5099',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  }, '127.0.0.1')
  assert.equal(r.status, 200, '路由本身可达（CSRF 同源放行）')
  const j = r.json()
  assert.equal(j.ok, false, 'mapped IPv6 的本机地址必须拒绝保存')
  assert.match(String(j.message || ''), /force|内网|本机/, '提示要走显式确认通道')
})

test('public-base：内网地址 force 必须配 confirm 才放行，且走审计（复审 P1-4）', async () => {
  const body = { host: '127.0.0.1:5099', origin: 'http://127.0.0.1:5099', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
  // 只给 force 不给 confirm → 拒绝
  const f1 = await fake.call('/panel/pet/public-base', { publicBaseUrl: 'http://192.168.1.5', force: true }, body, '127.0.0.1')
  assert.equal(f1.json().ok, false, '只 force 不 confirm 不放行')
  assert.match(String(f1.json().message || ''), /confirm|确认/, '要求显式二次确认')
  // force + confirm → 审计放行（内网自测的合法场景）
  const f2 = await fake.call('/panel/pet/public-base', { publicBaseUrl: 'http://192.168.1.5', force: true, confirm: true }, body, '127.0.0.1')
  assert.equal(f2.json().ok, true, 'force + confirm 显式确认后放行（内网自测场景）')
  assert.equal(f2.json().confirmedPrivate, true, '响应标记 confirmedPrivate')
})

test('Host 允许名单：rebind 域名的 GET 请求必须 403（复审 2·P1-1 回归）', async () => {
  // DNS rebinding：恶意页面把 evil.example rebind 到 127.0.0.1，
  // `GET http://evil.example:port/state` —— socket 回环（面板闸放行）、GET（不过 CSRF）。
  // 旧实现 /state、/logs、/bridge/token 全 200 可读；现在 Host 不在白名单直接 403。
  const paths = ['/state', '/logs', '/commands']
  for (const p of paths) {
    const r = await fake.call(p, null, { host: 'evil.example' }, '127.0.0.1')
    assert.equal(r.status, 403, `${p} 的异常 Host 必须拒绝`)
  }
  // 白名单内的 Host 照常
  const ok1 = await fake.call('/state', null, { host: '127.0.0.1:5099' }, '127.0.0.1')
  assert.equal(ok1.status, 200, '回环 Host 正常')
  const ok2 = await fake.call('/state', null, { host: 'localhost:5099' }, '127.0.0.1')
  assert.equal(ok2.status, 200, 'localhost 正常')
  // 反代域名（security.publicHostname）也在白名单
  api.setConfig({ ...api.getConfig(), security: { ...api.getConfig().security, publicHostname: 'panel.example.com' } })
  const ok3 = await fake.call('/state', null, { host: 'panel.example.com' }, '127.0.0.1')
  assert.equal(ok3.status, 200, 'publicHostname 正常')
  api.setConfig({ ...api.getConfig(), security: { ...api.getConfig().security, publicHostname: '' } })
  // 复审 3 点名补齐：/bridge/token（返回 bearer 令牌）与 /panel/pet/client-package
  //（含令牌的 zip，手动注册路由）对异常 Host 必须同样 403——client-package 之前漏接 Host 校验。
  const tokenEvil = await fake.call('/bridge/token', null, { host: 'evil.example' }, '127.0.0.1')
  assert.equal(tokenEvil.status, 403, '/bridge/token 的异常 Host 必须拒绝')
  const pkgEvil = await fake.call('/panel/pet/client-package', null, { host: 'evil.example' }, '127.0.0.1')
  assert.equal(pkgEvil.status, 403, '/panel/pet/client-package 的异常 Host 必须拒绝')
})

test('Host 允许名单：IPv6 回环带端口的 Host 必须放行（复审 3·小建议回归）', async () => {
  // 旧实现先剥 `[` 再剥 `]`：`[::1]:5099` 剥完端口剩 `::1]`，回环 Host 被误 403。
  // 正确顺序是先剥端口再剥方括号。
  const r = await fake.call('/state', null, { host: '[::1]:5099' }, '127.0.0.1')
  assert.equal(r.status, 200, 'IPv6 回环 `[::1]:5099` 是本机面板，必须放行')
  // 方括号之外的经典 rebinding Host 照旧拒绝
  const evil = await fake.call('/state', null, { host: 'evil.example' }, '127.0.0.1')
  assert.equal(evil.status, 403, '异常 Host 依旧拒绝')
})

test('Host 允许名单：publicHostname 可配多个（对外域名与内网地址并存）', async () => {
  // 反代部署常见两个入口同时开面板：对外域名走反代、内网/直连地址走另一条路。
  // 旧实现只认一个值，第二个入口打开面板后管理接口一律 403（连 /state 都读不到）。
  api.setConfig({ ...api.getConfig(), security: { ...api.getConfig().security, publicHostname: 'panel.example.com, 192.0.2.10' } })
  const byDomain = await fake.call('/state', null, { host: 'panel.example.com' }, '127.0.0.1')
  assert.equal(byDomain.status, 200, '第一个主机放行')
  const bySecond = await fake.call('/state', null, { host: '192.0.2.10:5099' }, '127.0.0.1')
  assert.equal(bySecond.status, 200, '第二个主机（带端口）放行')
  // 归一化没退化：大小写、结尾点、方括号都按主机名比
  const sloppy = await fake.call('/state', null, { host: 'Panel.Example.COM.' }, '127.0.0.1')
  assert.equal(sloppy.status, 200, '大小写与结尾点不影响匹配')
  // Origin 同源校验同样认第二个主机（CSRF 闸与 Host 闸共用同一份名单）
  const save = await fake.call('/save', { ownerName: '主人' }, {
    host: '192.0.2.10:5099',
    origin: 'https://192.0.2.10',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  }, '127.0.0.1')
  assert.equal(save.status, 200, '第二个主机的 Origin 算同源')
  // 白名单之外照旧拒绝
  const evil = await fake.call('/state', null, { host: 'evil.example' }, '127.0.0.1')
  assert.equal(evil.status, 403, '未列出的主机仍拒绝（不能配多个就放宽成通配）')
  // 列表是精确主机名，不是域名后缀：子域名不能借父域名混进来
  const sub = await fake.call('/state', null, { host: 'evil.panel.example.com' }, '127.0.0.1')
  assert.equal(sub.status, 403, '子域名不算白名单（精确匹配）')
  // 手滑写成通配也不生效：列表里就是字面主机名，不做后缀或通配匹配
  api.setConfig({ ...api.getConfig(), security: { ...api.getConfig().security, publicHostname: '*.example.com, *' } })
  const wildcard = await fake.call('/state', null, { host: 'evil.example.com' }, '127.0.0.1')
  assert.equal(wildcard.status, 403, '通配符不生效（写 *.example.com 不会放行整个域）')
  // 清空配置回到「只有回环」
  api.setConfig({ ...api.getConfig(), security: { ...api.getConfig().security, publicHostname: '' } })
  const cleared = await fake.call('/state', null, { host: 'panel.example.com' }, '127.0.0.1')
  assert.equal(cleared.status, 403, '清空后旧主机也拒绝（空配置行为不变）')
})

test('Host 允许名单：白名单项自带端口也能匹配（与请求 Host 同一口径）', async () => {
  // 内网直连地址平时都带端口，用户很可能照直填进 publicHostname。
  // Host 侧一直剥端口再比，白名单项不剥的话这一项会永不匹配、且很难自查（上游复审建议）。
  api.setConfig({ ...api.getConfig(), security: { ...api.getConfig().security, publicHostname: 'panel.example.com, 192.0.2.10:5099' } })
  const byPortItem = await fake.call('/state', null, { host: '192.0.2.10:5099' }, '127.0.0.1')
  assert.equal(byPortItem.status, 200, '白名单项带端口，Host 带同样端口放行')
  // 端口不参与主机身份：Host 的端口和白名单项里写的端口不同，仍是同一个主机
  const otherPort = await fake.call('/state', null, { host: '192.0.2.10:8080' }, '127.0.0.1')
  assert.equal(otherPort.status, 200, '端口不参与主机身份（请求 Host 与白名单项都先剥端口再比）')
  // 剥端口不改变精确匹配口径：相邻 IP 照样拒绝
  const otherHost = await fake.call('/state', null, { host: '192.0.2.11:5099' }, '127.0.0.1')
  assert.equal(otherHost.status, 403, '相邻 IP 即使端口相同也进不来')
  // Origin 侧共用同一份列表：带端口的白名单项也要让第二个主机的 Origin 算同源
  const save = await fake.call('/save', { ownerName: '主人' }, {
    host: '192.0.2.10:5099',
    origin: 'https://192.0.2.10',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  }, '127.0.0.1')
  assert.equal(save.status, 200, '白名单项带端口时第二个主机的 Origin 仍算同源')
  api.setConfig({ ...api.getConfig(), security: { ...api.getConfig().security, publicHostname: '' } })
})

test('Host 允许名单：反代场景缺 XFF 从 fail-open 兜成 fail-closed（复审 2·P1-1）', async () => {
  // socket 是回环且没配 trustedProxy → 本机直连，正常放行
  const direct = await fake.call('/state', null, { host: '127.0.0.1:5099' }, '127.0.0.1')
  assert.equal(direct.status, 200, '本机直连照常')
  // 配了 trustedProxy（说明部署在反代后）但请求没带 XFF → 反代没配好，fail-closed 拒绝
  api.setConfig({ ...api.getConfig(), security: { ...api.getConfig().security, trustedProxy: '127.0.0.1' } })
  const noXff = await fake.call('/state', null, { host: '127.0.0.1:5099' }, '127.0.0.1')
  assert.equal(noXff.status, 403, '反代后却没带 XFF = 反代配置缺失，拒绝（不再当成本机）')
  // 带了 XFF 就按最后一跳正常判定
  const withXff = await fake.call('/state', null, { host: '127.0.0.1:5099', 'x-forwarded-for': '127.0.0.1' }, '127.0.0.1')
  assert.equal(withXff.status, 200, '反代 + XFF 本机来源放行')
  api.setConfig({ ...api.getConfig(), security: { ...api.getConfig().security, trustedProxy: '' } })
})

test('模块 prefix 路由也过 CSRF（复审 2·P1-2 回归）', async () => {
  // 旧实现 mods.handle 完全绕过 CSRF：本机 socket + 恶意 Origin 能跨站打
  // POST /aurabot/api/<模块>/run 这类无 token 的模块路由（真实触发逛/ADB）。
  // 现在走 prefix handler 的 csrfBlocked。用一个不存在的模块路由断言「CSRF 先于 404」即可：
  // 若 CSRF 生效 → 403（跨站拒绝）；若绕过 → 404（no route）。
  const r = await fake.call('/nonexistent-module/run', {}, {
    origin: 'https://evil.example',
    'content-type': 'application/json',
  }, '127.0.0.1')
  assert.equal(r.status, 403, '模块 prefix 路由的跨站 POST 必须被 CSRF 拦下（先于路由匹配）')
  assert.match(String(r.raw() || ''), /跨站/, '拒绝理由是 CSRF')
})
