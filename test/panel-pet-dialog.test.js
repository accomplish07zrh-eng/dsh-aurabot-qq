// 面板集成：桌宠「对话框」的 /panel/pet/config 写入通道（petChat* / petWeather*）。
// pet 1.0.5 起模块在 mods 仓，模块 settings 不渲染成表单，核心 host.js 这条路由是它们唯一的写入口。
// 钉住：布尔透传、文本 trim + 截断、天气地址只收 http/https（空串合法）、历史数字按模块口径钳制。
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
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-panel-pet-dialog-'))
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
  fake.ctx.webServer.port = 5098
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
// 客户端是单文件 client/client.js（数据目录里没有构建产物），面板行只能在源码上断言。
const clientSrc = () => readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

test('对话框开关：布尔直接透传，未知键与错误类型一律不收', async () => {
  const r = await call('/panel/pet/config', { petChatEnabled: true, petChatBlurHide: false, petChatFoo: 1 })
  assert.equal(r.ok, true, JSON.stringify(r))
  const pet = extPet()
  assert.equal(pet.petChatEnabled, true)
  assert.equal(pet.petChatBlurHide, false)
  assert.equal(pet.petChatFoo, undefined, '未知键被拒之门外')

  const bad = await call('/panel/pet/config', { petChatEnabled: 'yes' })
  assert.equal(bad.ok, false, '只有类型不对的字段 → 明确拒绝')
  assert.notEqual(extPet().petChatEnabled, 'yes')
})

test('快捷键 / 关闭关键字 / 天气城市：trim 后按模块口径截断，空串合法（= 关掉该项）', async () => {
  await call('/panel/pet/config', {
    petChatHotkey: '  Alt+P  ',
    petChatCloseKeyword: 'x'.repeat(50), // 截到 20
    petWeatherCity: '  上海  ',
  })
  const pet = extPet()
  assert.equal(pet.petChatHotkey, 'Alt+P', '首尾空白要 trim')
  assert.equal(pet.petChatCloseKeyword, 'x'.repeat(20), '关键字截到 20 字')
  assert.equal(pet.petWeatherCity, '上海', '城市名 trim')
  // 清空：空串能落盘，面板才能把项关掉
  await call('/panel/pet/config', { petChatHotkey: '', petChatCloseKeyword: '', petWeatherCity: '' })
  const empty = extPet()
  assert.equal(empty.petChatHotkey, '')
  assert.equal(empty.petChatCloseKeyword, '')
  assert.equal(empty.petWeatherCity, '')
})

test('天气接口地址：只收 http/https（留空回落内置默认），file:// 之类不收', async () => {
  await call('/panel/pet/config', { petWeatherUrl: 'https://wttr.in?format=3&lang=zh' })
  assert.equal(extPet().petWeatherUrl, 'https://wttr.in?format=3&lang=zh')
  await call('/panel/pet/config', { petWeatherUrl: 'http://127.0.0.1:8080/weather' })
  assert.equal(extPet().petWeatherUrl, 'http://127.0.0.1:8080/weather')
  // 非法协议：这条字段被忽略，不覆盖已有值（别把下载/请求源改成 file://）
  const r = await call('/panel/pet/config', { petWeatherUrl: 'file:///etc/passwd' })
  assert.equal(r.ok, false, '唯一字段非法 → 没有可保存的字段')
  assert.equal(extPet().petWeatherUrl, 'http://127.0.0.1:8080/weather', '非法地址不能覆盖旧值')
})

test('历史条数 / 保留天数：按模块 settings 口径钳制（10~2000 条；0~3650 天，0 = 永久）', async () => {
  await call('/panel/pet/config', { petChatMaxEntries: 5, petChatRetentionDays: -1 })
  let pet = extPet()
  assert.equal(pet.petChatMaxEntries, 10, '低于下限钳到 10')
  assert.equal(pet.petChatRetentionDays, 0, '负数钳到 0（永久保留）')
  await call('/panel/pet/config', { petChatMaxEntries: 99999, petChatRetentionDays: 99999 })
  pet = extPet()
  assert.equal(pet.petChatMaxEntries, 2000, '高于上限钳到 2000')
  assert.equal(pet.petChatRetentionDays, 3650, '高于上限钳到 3650')
  await call('/panel/pet/config', { petChatMaxEntries: 200.9, petChatRetentionDays: 30.6 })
  pet = extPet()
  assert.equal(pet.petChatMaxEntries, 201, '四舍五入')
  assert.equal(pet.petChatRetentionDays, 31, '四舍五入')
})

test('面板入口：有 chat 字段才渲染对话框设置，且每个输入都写着保存时用的键名', () => {
  const src = clientSrc()
  // 老模块（pet < 1.0.5）没有 chat 字段 → 整块不渲染，免得拨了没反应
  assert.match(src, /const chatCfg = \(pet && pet\.chat\) \|\| null/)
  assert.match(src, /chatCfg \? h\('div'/, '没有 chat 字段就不显示对话框设置')
  assert.match(src, /hotkeyState/, '快捷键注册状态要展示（注册失败要能看见）')
  // 每个可写项都要真的把键名发到 /panel/pet/config
  for (const key of ['petChatEnabled', 'petChatHotkey', 'petChatCloseKeyword', 'petChatBlurHide', 'petChatMaxEntries', 'petChatRetentionDays', 'petWeatherCity']) {
    assert.ok(src.includes(key), `面板缺 ${key} 的写入`)
    assert.match(src, new RegExp(key + '[:\\s]'), `${key} 要出现在 savePet/saveChat 的 patch 里`)
  }
})
