// 面板集成：桌宠「聊天联动」的 /panel/pet/config 写入通道。
// 1.2.0 起 pet 模块代码在 mods 仓（dsh-aurabot-qq-mods），但聊天联动这些键的面板写入通道
// 仍在核心 host.js 的 /panel/pet/config（模块 settings 表单对内置/市场模块不渲染的场景兜底）。
// 不测这条，聊天联动的开关在面板上就是「打不开的开关」。fake-dsh 模式；不引入新依赖。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001'
const BOT = '20000002'

const call = async (path, body) => (await fake.call(path, body)).json()

let mock
let fake
let api
let dataDir

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-panel-pet-chat-'))
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
  fake = createFakeDsh({ brain: async () => '嗯' })
  fake.ctx.webServer.port = 5099
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await api.ready.catch(() => {})
  await fake.call('/onebot/reconnect')
})

after(async () => {
  fake?.dispose()
  await mock?.close()
  setTimeout(() => process.exit(0), 200).unref()
})

const extPet = () => JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')).ext?.pet || {}

test('聊天联动：/panel/pet/config 能写聊天联动键，数字按范围钳制，未知键不收', async () => {
  const r = await call('/panel/pet/config', {
    chatBehaviorEnabled: true,
    chatBehaviorCooldownMinutes: 99999, // 钳到 1440
    chatBehaviorMaxPerDay: -5,          // 钳到 0（= 聊天时她也不动）
    chatBehaviorWhitelist: 'private:12345\ngroup:67890',
    chatBehaviorFoo: 1, // 不存在的键 → 无视
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  const pet = extPet()
  assert.equal(pet.chatBehaviorEnabled, true)
  assert.equal(pet.chatBehaviorCooldownMinutes, 1440, '冷却钳到 1440')
  assert.equal(pet.chatBehaviorMaxPerDay, 0, '每日上限钳到 0')
  assert.equal(pet.chatBehaviorWhitelist, 'private:12345\ngroup:67890', '范围白名单原样存（含换行）')
  assert.equal(pet.chatBehaviorFoo, undefined, '未知键被拒之门外')
  // 类型不对的不收：布尔键给字符串、数字键给字符串都落不了盘
  const bad = await call('/panel/pet/config', { chatBehaviorEnabled: 'yes', chatBehaviorCooldownMinutes: 'five' })
  assert.equal(bad.ok, false, '全是类型不对的字段 → 明确拒绝')
  // 复原，别污染别的用例
  const back = await call('/panel/pet/config', { chatBehaviorEnabled: false, chatBehaviorCooldownMinutes: 5, chatBehaviorMaxPerDay: 20, chatBehaviorWhitelist: '' })
  assert.equal(back.ok, true)
  assert.equal(extPet().chatBehaviorEnabled, false)
})
