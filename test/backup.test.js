import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

let api
const root = mkdtempSync(join(tmpdir(), 'aurabot-backup-'))
const put = (rel, text) => {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const read = (rel) => readFileSync(join(root, rel), 'utf8')

before(async () => {
  process.env.AURABOT_DATA_DIR = root
  api = await import('../src/core/backup.js')
})

test('备份、暂存、启动时换上：内容一致，旧文件留底，排除项不进备份', async () => {
  put('config.json', JSON.stringify({ ownerQQ: '1', song: { root: join(root, 'songs') } }))
  put('memories.json', '记忆🤔')
  put('personas/鱼.md', '人设')
  put('stickers/a.png', Buffer.alloc(5000, 7))
  put('modules/pet/module.json', '{}')
  put('logs/a.log', 'x')
  put('sessions.json', '{}')
  put('douyin/edge-profile/Cookies', 'x')
  put('douyin/im/db', 'keep')
  put('modules-data/pet/app/node_modules/electron/a', 'x')

  const b = await api.createBackup({ version: '1.2.0-beta.1' })
  assert.equal(b.files, 7)
  assert.deepEqual(b.skipped, [])
  assert.deepEqual(api.listBackups().map((x) => x.name), [b.name])

  // 模拟换了电脑：数据目录里是别的东西
  put('memories.json', '新电脑的')
  put('config.json', '{"ownerQQ":"2"}')
  put('only-here.json', '留着')

  const r = await api.stageRestore(b.file)
  assert.equal(r.ok, true)
  assert.equal(read('memories.json'), '新电脑的', '运行中不替换')
  assert.equal(api.pendingRestore().files, 7)

  // 备份来自别的路径：配置里的旧路径要换成这台电脑的
  const pending = join(root, '.restore-pending.json')
  const oldRoot = 'C:\\old\\aurabot'
  const stageConfig = join(root, '.restore', 'config.json')
  writeFileSync(stageConfig, JSON.stringify({ ownerQQ: '1', dir: oldRoot + '\\songs' }))
  writeFileSync(pending, JSON.stringify({ ...JSON.parse(readFileSync(pending, 'utf8')), dataDir: oldRoot }))

  assert.equal(api.applyPendingRestore(123), 7)
  assert.equal(read('memories.json'), '记忆🤔')
  assert.equal(read('personas/鱼.md'), '人设')
  assert.equal(readFileSync(join(root, 'stickers/a.png')).length, 5000)
  assert.equal(JSON.parse(read('config.json')).dir, join(root, 'songs'))
  assert.equal(read('only-here.json'), '留着')
  assert.equal(read('backups/pre-restore-123/memories.json'), '新电脑的', '旧文件留底')
  assert.equal(api.pendingRestore(), null)
  assert.equal(existsSync(join(root, '.restore')), false)
  assert.equal(api.applyPendingRestore(), 0, '没有待恢复时什么都不做')
})

test('坏文件和别的 zip 都拒绝，且不留待恢复', async () => {
  const bad = join(root, 'bad.zip')
  writeFileSync(bad, 'not a zip at all, sorry about that friend')
  await assert.rejects(api.stageRestore(bad), /不是有效的备份/)
  assert.equal(api.pendingRestore(), null)
})

test('内容被改动过的备份过不了校验', async () => {
  const b = await api.createBackup({ version: 'x', now: new Date(Date.now() + 60000) })
  const buf = readFileSync(b.file)
  const at = buf.indexOf(Buffer.from('data/config.json')) + 16
  buf[at + 2] ^= 0xff
  const broken = join(root, 'broken.zip')
  writeFileSync(broken, buf)
  await assert.rejects(api.stageRestore(broken))
  assert.equal(api.pendingRestore(), null)
})

test('取消恢复清掉暂存', async () => {
  const b = api.listBackups()[0]
  await api.stageRestore(join(root, 'backups', b.name))
  assert.ok(api.pendingRestore())
  api.cancelRestore()
  assert.equal(api.pendingRestore(), null)
  assert.ok(readdirSync(root).every((n) => n !== '.restore'))
})

test('会话目录名和 DSH 的规则一致', () => {
  assert.equal(api.sessionDirName('C:\\Aurabot\\qq-chats'), '--C-Aurabot-qq-chats--')
  assert.equal(api.sessionDirName('C:\\Users\\17018\\.dsh\\profiles\\desktop'), '--C-Users-17018-.dsh-profiles-desktop--')
  assert.equal(api.sessionDirName('D:\\dsh插件开发'), '--D-dsh~63D2~4EF6~5F00~53D1--')
  assert.equal(api.sessionDirName('D:\\knorvia studio开发'), '--D-knorvia~0020studio~5F00~53D1--')
})

test('市场模块只记名字，会话带上并放回工作区目录，已有的不覆盖', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aurabot-home-'))
  process.env.DSH_HOME = home
  const ws = join(home, 'qq-chats')
  const sess = join(home, 'sessions', api.sessionDirName(ws))
  mkdirSync(join(sess, 'session-a'), { recursive: true })
  mkdirSync(join(sess, 'session-b'), { recursive: true })
  writeFileSync(join(sess, 'session-a', 'session.v4.jsonl.zstd'), 'A')
  writeFileSync(join(sess, 'session-b', 'session.v4.jsonl.zstd'), 'B')
  put('modules/heybox/.aurabot-source.json', '{}')
  put('modules/heybox/index.mjs', 'x')
  put('modules/mine/index.mjs', 'mine')

  const b = await api.createBackup({ version: 'x', workspaceDir: ws, now: new Date(Date.now() + 120000) })
  assert.deepEqual(b.market, ['heybox'])
  assert.equal(b.sessions, 2)

  // 新电脑：市场模块没装，自己写的模块被清空，有一个同名会话
  rmSync(join(root, 'modules'), { recursive: true, force: true })
  rmSync(join(sess, 'session-a'), { recursive: true, force: true })
  writeFileSync(join(sess, 'session-b', 'session.v4.jsonl.zstd'), '这台电脑的')
  const r = await api.stageRestore(b.file)
  assert.deepEqual(r.market, ['heybox'])
  api.applyPendingRestore(456)

  assert.equal(read('modules/mine/index.mjs'), 'mine')
  assert.equal(existsSync(join(root, 'modules/heybox')), false, '市场模块不打包')
  assert.deepEqual(api.pendingModules(), ['heybox'])
  assert.equal(readFileSync(join(sess, 'session-a', 'session.v4.jsonl.zstd'), 'utf8'), 'A')
  assert.equal(readFileSync(join(sess, 'session-b', 'session.v4.jsonl.zstd'), 'utf8'), '这台电脑的')
  assert.equal(JSON.parse(read('config.json')).workspaceDir, ws)
  api.setPendingModules([])
  assert.deepEqual(api.pendingModules(), [])
  delete process.env.DSH_HOME
})
