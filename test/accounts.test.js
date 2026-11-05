import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('账号数据目录与配置按账号隔离，默认账号保持老路径', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-accounts-'))
  process.env.AURABOT_DATA_DIR = root
  try {
    const store = await import('../src/core/store.js')
    const accounts = await import('../src/core/accounts.js')

    // 默认账号仍在根目录，不迁移
    assert.equal(store.accountDir('default'), root)
    assert.equal(store.dataDir('config.json'), join(root, 'config.json'))

    // 新账号 ID 由插件生成，不能用 QQ；配置独立，模块直接复制默认账号
    const created = accounts.createAccount({ name: '测试二' })
    const id = created.account.id
    assert.match(id, /^acc-[a-f0-9]{8}$/)
    assert.equal(store.accountDir(id), join(root, 'accounts', id))
    assert.equal(store.withAccount(id, () => store.dataDir('config.json')), join(root, 'accounts', id, 'config.json'))

    const cfg = accounts.loadConfigFor(id)
    assert.equal(cfg.botQQ, '')
    assert.equal(cfg.enabled, false)
    assert.deepEqual(cfg.modules, {})
    assert.equal(cfg.persona.current, 'dafeiyu')
    assert.equal((await import('node:fs')).existsSync(join(root, 'accounts', id, 'personas', 'dafeiyu.md')), true)
    assert.equal(cfg.snowluma.webuiPort, 5100)
    const personaSettings = JSON.parse((await import('node:fs')).readFileSync(join(root, 'accounts', id, 'modules-data', 'persona-memory', 'settings.json'), 'utf8'))
    assert.equal(personaSettings.serviceUrl, 'http://127.0.0.1:19093')

    // 默认账号配置没有被新账号改掉
    assert.equal(accounts.loadConfigFor('default').modules.song?.enabled, undefined)
    assert.deepEqual(accounts.loadAccounts().map((a) => a.id), ['default', id])
    assert.throws(() => accounts.createAccount({ id: '41090573' }), /不能用 QQ/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


