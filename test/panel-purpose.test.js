// 面板集成：目的机制 / 桌宠的 /panel/* 代理与 /state 聚合。
// fake-dsh 模式；AURABOT_DATA_DIR 隔离；不引入新依赖。
// 模块侧（speakup 升级 / pet 模块）由 A/B 两个 agent 负责：这里验证的是「模块没升级时面板不炸、
// 接口升级后字段能透传聚合」，全部按降级语义断言。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001'
const BOT = '20000002'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function brain() { await sleep(1); return '嗯' }

const call = async (path, body) => (await fake.call(path, body)).json()

let mock
let fake
let api
let dataDir

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-panel-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  mock = await startMockOneBot({ selfId: BOT })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: false,
    setupDone: true,
    botQQ: BOT,
    ownerQQ: OWNER,
    allow: { private: [OWNER], groups: [] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'no-snowluma') },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
    bridge: { dshTools: false, http: true, token: 'a'.repeat(32) },
  }))
  fake = createFakeDsh({ brain })
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await fake.call('/onebot/reconnect')
})

after(async () => {
  fake?.dispose()
  await mock?.close()
  setTimeout(() => process.exit(0), 200).unref()
})

const sentToOwner = () => mock.calls.filter((c) => c.action === 'send_private_msg' && String(c.params.user_id) === OWNER)

test('/state 聚合 purpose / pet 字段（与 speakup→purpose 模块真实对接）', async () => {
  const st = await call('/state')
  assert.equal(st.ok, true)
  // R10：概览页要的 speakUp.count 必须还在
  assert.equal(typeof st.speakUp.count, 'number')
  assert.ok(st.purpose, 'purpose 聚合字段存在')
  assert.equal(st.purpose.available, true, 'purpose 模块已提供 status()')
  assert.equal(st.purpose.status.countToday, 0, 'status() 摘要含 countToday')
  assert.equal(typeof st.purpose.status.dailyMax, 'number', 'status() 摘要含 dailyMax')
  assert.equal(st.purpose.carrier, 'qq', '载体默认 qq')
  assert.equal(st.purpose.petFallbackToQQ, true, '回落默认开')
  assert.equal(st.purpose.pacing, 'default')
  assert.equal(st.purpose.dailyMax, 4, 'dailyMax 取自 speakUp.maxPerDay 默认值')
  assert.equal(st.purpose.quietStart, '23:00', '安静时段由醒着窗口 8~23 推算')
  assert.equal(st.purpose.quietEnd, '08:00')
  assert.ok(st.pet && typeof st.pet.online === 'boolean', 'pet 已是内置模块：/state 聚合桌宠状态卡')
  // token 脱敏：32 位 bridge token 不出现在任何返回里
  assert.ok(!JSON.stringify(st).includes('a'.repeat(32)), 'state 返回不得出现 32 位令牌明文')
})

test('面板代理 /panel/purpose/status：聚合 purpose + pet，token 已脱敏', async () => {
  const r = await call('/panel/purpose/status')
  assert.equal(r.ok, true)
  assert.equal(r.purpose.carrier, 'qq')
  assert.ok(r.pet && typeof r.pet.online === 'boolean', 'pet 已内置：/panel/purpose/status 聚合桌宠状态')
  assert.ok(!JSON.stringify(r).includes('a'.repeat(32)))
})

test('carrier 切换透传：/panel/purpose/config 写入配置并可读回（含回落/节奏/醒着窗口/每日上限）', async () => {
  const r = await call('/panel/purpose/config', { carrier: 'pet', petFallbackToQQ: false, pacing: 'conservative', awakeFrom: 9, awakeTo: 22, maxPerDay: 2 })
  assert.equal(r.ok, true)
  assert.equal(r.purpose.carrier, 'pet')
  assert.equal(r.purpose.petFallbackToQQ, false)
  assert.equal(r.purpose.pacing, 'conservative')
  assert.equal(r.purpose.awakeFrom, 9)
  assert.equal(r.purpose.awakeTo, 22)
  assert.equal(r.purpose.quietStart, '22:00', '安静时段随醒着窗口重推')
  assert.equal(r.purpose.quietEnd, '09:00')
  assert.equal(r.purpose.dailyMax, 2)
  // 透传到 /state（面板另一处数据源一致）
  const st = await call('/state')
  assert.equal(st.purpose.carrier, 'pet')
  assert.equal(st.purpose.petFallbackToQQ, false)
  // 非法字段拒绝
  const bad = await call('/panel/purpose/config', { carrier: 'wechat' })
  assert.equal(bad.ok, false)
  // 切回来，不污染别的用例
  const back = await call('/panel/purpose/config', { carrier: 'qq', petFallbackToQQ: true, pacing: 'default' })
  assert.equal(back.ok, true)
  assert.equal(back.purpose.carrier, 'qq')
})

test('预览零副作用：/panel/purpose/preview 收素材拼提示词，但不发 QQ', async () => {
  const before = sentToOwner().length
  const r = await call('/panel/purpose/preview')
  assert.equal(r.ok, true)
  assert.ok(r.result, '有预览结果')
  assert.ok(r.result.stats, '预览含素材统计：' + JSON.stringify(r).slice(0, 400))
  assert.ok(Array.isArray(r.result.materials), '预览含素材列表')
  assert.ok(!JSON.stringify(r).includes('a'.repeat(32)), '预览返回不得出现 32 位令牌明文')
  await sleep(50)
  assert.equal(sentToOwner().length, before, '预览不得向 QQ 发送任何消息')
})

test('桌宠面板代理：pet 已是内置模块，status/download/focus 三个代理都工作（api.use 前缀无关）', async () => {
  const st = await call('/panel/pet/status')
  assert.equal(st.ok, true)
  assert.ok(st.pet && typeof st.pet.online === 'boolean', '内置 pet 在跑：status 状态卡（扁平结构，online 布尔）')
  const dl = await call('/panel/pet/download', {})
  assert.equal(dl.ok, true, 'download 代理走 pet.download()（installClient）')
  assert.equal(dl.result.ok, true)
  assert.ok(Array.isArray(dl.result.files) && dl.result.files.length > 0, '客户端模板已生成到数据目录')
  const fc = await call('/panel/pet/focus', { enabled: true })
  assert.equal(fc.ok, true)
  assert.equal(fc.result.enabled, true, 'focus 代理走 pet.setFocus()')
  const st2 = await call('/panel/pet/status')
  assert.equal(st2.pet.focus, true, 'status 回读专注状态')
})
