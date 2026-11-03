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
    origin: 'https://evil.example',
    'content-type': 'application/json',
  }, '127.0.0.1')
  assert.equal(r.status, 403, '恶意 Origin 的 /save 必须被 CSRF 闸拦下')
  assert.match(String(r.raw() || ''), /跨站/, '拒绝理由要写明是跨站')
})

test('CSRF：Sec-Fetch-Site: cross-site 也必须 403（不带 Origin 的变体）', async () => {
  const r = await fake.call('/save', { ownerName: '攻击者' }, {
    'sec-fetch-site': 'cross-site',
    'content-type': 'application/json',
  }, '127.0.0.1')
  assert.equal(r.status, 403, 'cross-site 的 Sec-Fetch-Site 必须拦')
})

test('CSRF：同源请求照常放行（本机面板不被误伤）', async () => {
  // 本机面板的 fetch 会带回环 Origin + same-origin
  const r = await fake.call('/save', { ownerName: '主人' }, {
    origin: 'http://127.0.0.1:5099',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  }, '127.0.0.1')
  assert.equal(r.status, 200, '同源写请求放行')
  // 配了 publicHostname 时，这个域名的 Origin 也算同源
  api.setConfig({ ...api.getConfig(), security: { ...api.getConfig().security, publicHostname: 'panel.example.com' } })
  const remote = await fake.call('/save', { ownerName: '主人' }, {
    origin: 'https://panel.example.com',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  }, '127.0.0.1')
  assert.equal(remote.status, 200, '面板对外域名的 Origin 算同源（反代部署场景）')
  api.setConfig({ ...api.getConfig(), security: { ...api.getConfig().security, publicHostname: '' } })
})

test('CSRF：无 Origin/Sec-Fetch-Site 的客户端（curl 等）不受 CSRF 闸影响', async () => {
  // 非浏览器客户端不带这些头——它们的防线是本机闸与各自令牌，CSRF 只管浏览器跨站
  const r = await fake.call('/save', { ownerName: '脚本' }, { 'content-type': 'application/json' }, '127.0.0.1')
  assert.equal(r.status, 200, '无浏览器头的写请求不被 CSRF 误拦')
})

test('CSRF：/open/* 带正确密钥跨机放行（复审 P1-2 回归：上轮被面板闸误拦）', async () => {
  // 打开联动 + 拿密钥
  api.setConfig({ ...api.getConfig(), bridge: { ...api.getConfig().bridge, http: true } })
  const t = await fake.call('/bridge/token')
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
  const body = { origin: 'http://127.0.0.1:5099', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
  // 只给 force 不给 confirm → 拒绝
  const f1 = await fake.call('/panel/pet/public-base', { publicBaseUrl: 'http://192.168.1.5', force: true }, body, '127.0.0.1')
  assert.equal(f1.json().ok, false, '只 force 不 confirm 不放行')
  assert.match(String(f1.json().message || ''), /confirm|确认/, '要求显式二次确认')
  // force + confirm → 审计放行（内网自测的合法场景）
  const f2 = await fake.call('/panel/pet/public-base', { publicBaseUrl: 'http://192.168.1.5', force: true, confirm: true }, body, '127.0.0.1')
  assert.equal(f2.json().ok, true, 'force + confirm 显式确认后放行（内网自测场景）')
  assert.equal(f2.json().confirmedPrivate, true, '响应标记 confirmedPrivate')
})
