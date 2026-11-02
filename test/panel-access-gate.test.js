// 面板访问闸（2026-11-02 安全基线）：/aurabot/api/panel/* 默认只允许本机回环访问。
//
// 为什么要有这条：DSH 的 webServer 对插件路由没有服务器级鉴权，而 panel 接口能改配置、
// 能下「客户端包」（包内嵌 host.json，含 bearer 令牌）。同机部署时插件只绑回环，本来打不到；
// 一旦用户把端口经反代发布到公网，整组面板接口就裸奔。这里锁死「默认只许本机」。
//
// fake-dsh 的 call() 不传 socket —— 无 socket = 进程内直调，按本机处理（见 host.js requestIsLocal）。
// 因此「远端」用 x-forwarded-for 模拟：反代会把真实来源追加为最后一跳。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001'
const BOT = '20000002'

let fake
let api
let dataDir

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-panel-gate-'))
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

test('面板闸：本机（无 socket / 回环）照常放行——同机零退化', async () => {
  const r = await fake.call('/panel/pet/behavior/status')
  assert.equal(r.status, 200, '本机直调放行（无 socket = 进程内）')
  const loop = await fake.call('/panel/pet/behavior/status', null, { 'x-forwarded-for': '127.0.0.1' })
  assert.equal(loop.status, 200, '反代后仍是本机来源：放行')
})

test('面板闸：外网来源被 403 拦下（含反代最后一跳）', async () => {
  const far = await fake.call('/panel/pet/behavior/status', null, { 'x-forwarded-for': '203.0.113.7' })
  assert.equal(far.status, 403, '外网直连面板接口必须拒绝')
  assert.match(String(far.raw() || ''), /只允许本机|panelRemoteAccess/, '错误信息要说明「只允许本机」与开启方式')

  // 反代：客户端伪造首跳回环，但反代追加的真实最后一跳是外网 → 仍须拒绝
  const spoofed = await fake.call('/panel/pet/behavior/status', null, { 'x-forwarded-for': '127.0.0.1, 203.0.113.7' })
  assert.equal(spoofed.status, 403, '伪造首跳回环不能骗过闸（只认最后一跳）')
})

test('面板闸：/ext 与 /asset 不受限制（客户端跨机直连的正当通道）', async () => {
  // /ext/pet/* 走模块路由，自带 x-pet-token 校验，不该被面板闸拦
  const ext = await fake.call('/ext/pet/status', null, { 'x-forwarded-for': '203.0.113.7' })
  assert.notEqual(ext.status, 403, '/ext 不该被面板闸 403（它是令牌鉴权的通道）')
  // 无令牌时它应报令牌问题，而不是面板闸文案
  assert.ok(!/只允许本机/.test(String(ext.raw() || '')), '/ext 的拒绝理由不能是面板闸')
})

test('面板闸：默认拒绝是硬约束（fake 环境无法热改配置时至少锁住默认行为）', async () => {
  const cfgFile = join(dataDir, 'config.json')
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'))
  cfg.ext = { ...(cfg.ext || {}), panelRemoteAccess: true }
  writeFileSync(cfgFile, JSON.stringify(cfg))
  fake.ctx.config = cfg // fake 的 getConfig 是闭包，可能不热生效
  const afterOk = await fake.call('/panel/pet/behavior/status', null, { 'x-forwarded-for': '203.0.113.7' })
  if (afterOk.status === 200) {
    // 热改生效：关回去必须立刻恢复拦截
    cfg.ext.panelRemoteAccess = false
    writeFileSync(cfgFile, JSON.stringify(cfg))
    fake.ctx.config = cfg
    const back403 = await fake.call('/panel/pet/behavior/status', null, { 'x-forwarded-for': '203.0.113.7' })
    assert.equal(back403.status, 403, '关掉后立刻恢复拦截')
    return
  }
  assert.equal(afterOk.status, 403, '默认拒绝（fake 环境无法热改配置）')
})
