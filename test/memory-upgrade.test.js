import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as nodeModule from 'node:module'
import { spawnSync } from 'node:child_process'
import { normalize, DEFAULTS } from '../src/core/config.js'
import { createMemoryStore, COMPRESS } from '../src/features/memory.js'
import { createMemoryStorage, MEMORY_SCHEMA } from '../src/features/memory-store.js'
import { createBackup, stageRestore, applyPendingRestore } from '../src/core/backup.js'
import memoryModule from '../src/modules/memory/index.js'

let Database
try { ({ DatabaseSync: Database } = await import('node:sqlite')) } catch {}
const versions = ['v1.1.24', 'v1.2.0-beta.2']
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/memory-upgrade/${name}.json`, import.meta.url), 'utf8'))
const log = { info() {}, warn() {}, debug() {} }
const DAY = 86400_000
const BASE = 1780272000000
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function setup(t, state, json = false) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-upgrade-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  if (state) writeFileSync(join(dir, 'memories.json'), JSON.stringify(state, null, 2))
  if (json) writeFileSync(join(dir, 'memory-json-fallback.json'), '{}')
  writeFileSync(join(dir, 'config.json'), '{}')
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}
function storage(t, dir, options = {}) {
  const store = createMemoryStorage({ directory: dir, log, ...options })
  t.after(() => store.close())
  return store
}
const migratedFiles = (dir) => readdirSync(dir).filter((n) => /^memories\.migrated-.*\.json$/.test(n))
function databaseState(dir) {
  const db = new Database(join(dir, 'memory.sqlite'))
  try {
    const state = Object.fromEntries(db.prepare('SELECT key, json FROM kv').all().map((r) => [r.key, JSON.parse(r.json)]))
    const meta = new Map(db.prepare('SELECT key, json FROM meta').all().map((r) => [r.key, JSON.parse(r.json)]))
    for (const table of ['items', 'gists']) {
      const order = meta.get(`${table}:order`) || []
      const rows = new Map(db.prepare(`SELECT id, json FROM ${table}`).all().map((r) => [r.id, JSON.parse(r.json)]))
      if (meta.get('collections').includes(table)) state[table] = order.map((id) => rows.get(id))
    }
    return state
  } finally { db.close() }
}
// 只有业务测试平移时间；迁移、往返和备份测试都使用未经改动的原始 fixture。
function recentFixture(version) {
  const delta = Date.now() - BASE
  const shift = (value, key = '') => {
    if (typeof value === 'number' && ['at', 'lastHit', 'invalidAt', 'saidAt'].includes(key)) return value + delta
    if (Array.isArray(value)) return value.map((v) => shift(v))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shift(v, k)]))
    return value
  }
  return shift(fixture(version))
}
function business(cfg, rows = [], answer = () => '[]') {
  const calls = []
  const today = dayKey()
  const dsh = { get: () => null, llm: { async *stream({ system, messages }) {
    const call = { system, text: messages[0].content[0].text }
    calls.push(call)
    yield { type: 'text-delta', text: answer(call) }
    yield { type: 'finish', reason: { kind: 'completed' } }
  } } }
  const hub = { chatLogDays: () => rows.length ? [today] : [], chatLogOf: () => rows, deleteChatLog: () => {}, speakersOf: () => [] }
  return { mem: createMemoryStore({ dsh, getConfig: () => cfg, hub, log }), calls }
}
const compressionCalls = (calls) => calls.filter((c) => c.system.includes('下面是你记得的一些具体的事'))

for (const version of versions) {
  test(`${version}：SQLite 原样迁移、条数/内容/顺序/可选字段一致，旧文件原字节留底`, { skip: !Database }, (t) => {
    const original = fixture(version)
    const dir = setup(t, original)
    const bytes = readFileSync(join(dir, 'memories.json'))
    const store = storage(t, dir)
    assert.deepEqual(store.load(), original)
    assert.equal(store.status().backend, 'sqlite')
    assert.equal(existsSync(join(dir, 'memories.json')), false)
    assert.equal(migratedFiles(dir).length, 1)
    assert.deepEqual(readFileSync(join(dir, migratedFiles(dir)[0])), bytes)
    store.close()
    assert.deepEqual(storage(t, dir).load(), original, '重新打开仍然完全相同')
    const db = new Database(join(dir, 'memory.sqlite'))
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n, original.items.length)
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, MEMORY_SCHEMA)
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
    } finally { db.close() }
  })

  test(`${version}：node:sqlite 不可用时保持 JSON 内容，保存与重启一致，只警告一次`, (t) => {
    const original = fixture(version)
    const dir = setup(t, original)
    const warnings = []
    const store = storage(t, dir, { Database: null, log: { warn: (...args) => warnings.push(args.join(' ')) } })
    assert.deepEqual(store.load(), original)
    const changed = store.load()
    changed.items[0].hits = 99
    store.save(changed)
    assert.deepEqual(store.load(), changed)
    assert.equal(store.status().backend, 'json')
    assert.equal(warnings.length, 1)
    assert.deepEqual(storage(t, dir, { Database: null }).load(), changed)
    assert.equal(existsSync(join(dir, 'memory.sqlite')), false)
    assert.equal(migratedFiles(dir).length, 0)
  })

  for (const backend of ['json', 'sqlite']) {
    test(`${version} → ${backend}：新业务打开旧数据，空提炼后整理一次、tick 三次不丢记忆或旧画像`, { skip: backend === 'sqlite' && !Database }, async (t) => {
      const original = recentFixture(version)
      original.processed = { [dayKey()]: Object.values(original.processed)[0] }
      const dir = setup(t, original, backend === 'json')
      const cfg = normalize({ ownerQQ: '10000001', model: { provider: 'p', model: 'm' }, memory: {
        ...fixture(`${version}.config`).normalizedMemory,
        enabled: true, dailyConsolidate: true, consolidateTimes: ['00:00'], keepChatlogDays: -1,
      } })
      const rows = Array.from({ length: 100 }, (_, i) => ({
        chatId: 'private:30000001', uid: '30000001', who: '小明', text: `旧流水第${i}句，最近在练习手作`, t: Date.now() - 3600_000 + i,
      }))
      const { mem, calls } = business(cfg, rows)
      const store = storage(t, dir)
      assert.deepEqual(store.load(), original)
      assert.equal(mem.list('').length, original.items.length)
      assert.deepEqual(mem.styles(), original.styles)
      assert.equal(mem.profiles().find((p) => p.qq === '30000001').text, original.profiles['30000001'].text)
      assert.equal(store.status().backend, backend)
      const check = () => {
        const state = store.load()
        assert.deepEqual(state.items, original.items, '旧条目、文字、时间、tier、过时历史均不变')
        for (const key of ['profiles', 'insights', 'styles', 'insightNames']) assert.deepEqual(state[key], original[key], key)
        for (const item of state.items.filter((m) => ['tool', 'panel', 'import'].includes(m.source))) assert.equal(item.invalidAt, undefined)
      }
      let before = calls.length
      const result = await mem.consolidate({ includeToday: true })
      assert.equal(result.ok, true, result.message)
      assert.equal(result.forgot, 0)
      assert.equal(result.compressed, 0)
      assert.equal(calls.filter((c) => c.system.includes('整理长期记忆')).length, version === 'v1.1.24' ? 2 : 1, '数字进度保守重扫，beta 的已完成 80 行继续从第 81 行提炼')
      assert.equal(store.load().processed[dayKey()].offset, 100)
      assert.ok(compressionCalls(calls.slice(before)).length <= COMPRESS.maxCallsPerRun)
      check()
      for (let i = 0; i < 3; i++) {
        before = calls.length
        await mem.tick()
        assert.ok(compressionCalls(calls.slice(before)).length <= COMPRESS.maxCallsPerRun)
        check()
      }
      assert.ok(calls.some((c) => c.system.includes('整理长期记忆')), '确实执行了空提炼')
      assert.equal(mem.lastConsolidate().forgot, 0)
    })
  }

  test(`${version} 配置：旧 normalize 的记忆输出交给新版，旧值保留、新键取默认`, () => {
    const { raw, normalizedMemory } = fixture(`${version}.config`)
    const cfg = normalize({ ownerQQ: raw.ownerQQ, memory: normalizedMemory })
    for (const [key, value] of Object.entries(normalizedMemory)) assert.deepEqual(cfg.memory[key], value, key)
    for (const [key, value] of Object.entries(DEFAULTS.memory)) {
      if (Object.hasOwn(normalizedMemory, key) || key === 'keepChatlogSet') continue
      assert.deepEqual(cfg.memory[key], value, `新增键 ${key}`)
    }
    assert.equal(cfg.memory.keepChatlogSet, true)
  })

  test(`${version} 配置 fixture 与只读旧源码的真实 normalize 一致`, async (t) => {
    const reference = process.env.AURABOT_UPGRADE_REFERENCE || 'C:/Users/17018/AppData/Local/Temp/claude/D--Aurabot/372d710e-bb39-4c9d-a1ec-c3ba2d5d9634/scratchpad/upg'
    const path = join(reference, version, 'src', 'core', 'config.js')
    if (!existsSync(path)) { t.skip('只读旧源码未安装；固定配置升级用例仍执行'); return }
    const old = await import(pathToFileURL(path).href)
    const { raw, normalizedMemory } = fixture(`${version}.config`)
    const actual = old.normalize(raw)
    assert.deepEqual(actual.memory, normalizedMemory)
    const upgraded = normalize(actual)
    for (const [key, value] of Object.entries(normalizedMemory)) assert.deepEqual(upgraded.memory[key], value, key)
  })
}

for (const broken of [false, true]) {
  test(`模块启动即处理旧数据，${broken ? 'SQLite 打不开仍能启动' : '无需第一条聊天就完成迁移'}`, { skip: !Database }, (t) => {
    const original = fixture(versions[0])
    const dir = setup(t, original)
    if (broken) writeFileSync(join(dir, 'memory.sqlite'), 'broken sqlite')
    const warnings = []
    const cfg = normalize({})
    const mem = memoryModule.setup({
      core: { hub: {}, http: {} }, dsh: null, config: () => cfg,
      log: { ...log, warn: (s) => warnings.push(s) },
      context() {}, on() {}, every() {}, tool() {}, route() {},
    })
    assert.equal(mem.list('').length, original.items.length)
    assert.ok(memoryModule.files.includes('features/memory-store.js'))
    assert.equal(migratedFiles(dir).length, broken ? 0 : 1)
    assert.equal(warnings.length, broken ? 1 : 0)
    assert.deepEqual(storage(t, dir).load(), original)
  })
}

test('beta.2 默认保留天数 0 有意升级为 7；显式保留 0 与 -1 仍保留', () => {
  assert.equal(normalize({ memory: { keepChatlogDays: 0 } }).memory.keepChatlogDays, 7)
  assert.equal(normalize({ memory: { keepChatlogDays: 0, keepChatlogSet: true } }).memory.keepChatlogDays, 0)
  assert.equal(normalize({ memory: { keepChatlogDays: -1 } }).memory.keepChatlogDays, -1)
})

test('实际拦截动态 import node:sqlite：模块仍可加载并使用 JSON', { skip: typeof nodeModule.registerHooks !== 'function' }, (t) => {
  const original = fixture(versions[0])
  const dir = setup(t, original)
  const moduleUrl = new URL('../src/features/memory-store.js', import.meta.url).href
  const script = `
    import { registerHooks } from 'node:module';
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === 'node:sqlite') throw new Error('simulated missing node:sqlite');
      return next(specifier, context);
    } });
    const { createMemoryStorage } = await import(${JSON.stringify(moduleUrl)});
    const warnings = [];
    const store = createMemoryStorage({ log: { warn: (text) => warnings.push(text) } });
    const expected = JSON.parse(readFileSync(${JSON.stringify(join(dir, 'memories.json'))}, 'utf8'));
    assert.deepEqual(store.load(), expected);
    store.save(expected);
    assert.equal(store.status().backend, 'json');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /simulated missing/);
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', env: { ...process.env, AURABOT_DATA_DIR: dir }, timeout: 15000 })
  assert.equal(child.status, 0, child.stderr || child.error?.message)
})

// 包装真实 SQLite，仅在指定语句处制造故障；事务、回滚、磁盘内容仍由真实引擎执行。
function faultDatabase(control) {
  return class {
    constructor(file) { this.db = new Database(file) }
    exec(sql) { return this.db.exec(sql) }
    close() { this.db.close() }
    prepare(sql) {
      const statement = this.db.prepare(sql)
      return {
        run(...args) {
          if (control.armed && /^(INSERT|UPDATE|DELETE)\b/.test(sql) && ++control.writes === control.failAt) throw new Error('模拟写入中断')
          return statement.run(...args)
        },
        get(...args) {
          const row = statement.get(...args)
          if (control.badCount && sql.includes('count(*)') && sql.includes('FROM items')) return { ...row, count: row.count + 1 }
          return row
        },
        all: (...args) => statement.all(...args),
      }
    }
  }
}

test('迁移写到一半失败仍读原 JSON，下次重启可从原文件重新迁移', { skip: !Database }, (t) => {
  const original = fixture(versions[0])
  const dir = setup(t, original)
  const control = { armed: true, writes: 0, failAt: 3 }
  const store = storage(t, dir, { Database: faultDatabase(control) })
  assert.deepEqual(store.load(), original)
  assert.equal(control.writes, 3)
  assert.equal(store.status().backend, 'json')
  assert.equal(existsSync(join(dir, 'memory.sqlite')), false)
  assert.equal(migratedFiles(dir).length, 0)
  assert.deepEqual(storage(t, dir).load(), original)
})

test('上次导入中断留下临时库，下次仍从原 JSON 重新导入', { skip: !Database }, (t) => {
  const original = fixture(versions[0])
  const dir = setup(t, original)
  writeFileSync(join(dir, 'memory.sqlite.migrating'), 'interrupted database')
  writeFileSync(join(dir, 'memory.sqlite.migrating-wal'), 'interrupted wal')
  assert.deepEqual(storage(t, dir).load(), original)
  assert.equal(existsSync(join(dir, 'memory.sqlite.migrating')), false)
  assert.equal(migratedFiles(dir).length, 1)
})

test('未来 schema 不被降级覆盖，旧库保留并 warn 后读取 JSON 备份', { skip: !Database }, (t) => {
  const original = fixture(versions[0])
  const dir = setup(t, original)
  storage(t, dir).load()
  const db = new Database(join(dir, 'memory.sqlite'))
  db.exec('PRAGMA user_version = 999')
  db.close()
  const warnings = []
  const store = storage(t, dir, { log: { warn: (s) => warnings.push(s) } })
  assert.deepEqual(store.load(), original)
  assert.equal(store.status().backend, 'json')
  assert.match(warnings[0], /999/)
  const check = new Database(join(dir, 'memory.sqlite'))
  try { assert.equal(check.prepare('PRAGMA user_version').get().user_version, 999) } finally { check.close() }
})

test('打开 SQLite 失败仍可启动，原 JSON 保留且只 warn 一次', (t) => {
  const original = fixture(versions[0])
  const dir = setup(t, original)
  const warnings = []
  const store = storage(t, dir, { Database: class { constructor() { throw new Error('打不开数据库') } }, log: { warn: (s) => warnings.push(s) } })
  assert.deepEqual(store.load(), original)
  store.save(original)
  assert.equal(warnings.length, 1)
  assert.equal(store.status().backend, 'json')
  assert.equal(migratedFiles(dir).length, 0)
})

test('迁移核对条数失败时不切换，不改名 JSON，也不遗留可被误用的主库', { skip: !Database }, (t) => {
  const original = fixture(versions[0])
  const dir = setup(t, original)
  const warnings = []
  const store = storage(t, dir, { Database: faultDatabase({ badCount: true }), log: { warn: (s) => warnings.push(s) } })
  assert.deepEqual(store.load(), original)
  assert.equal(store.status().backend, 'json')
  assert.equal(existsSync(join(dir, 'memory.sqlite')), false)
  assert.equal(existsSync(join(dir, 'memories.json')), true)
  assert.equal(migratedFiles(dir).length, 0)
  assert.match(warnings[0], /条数不一致/)
  assert.deepEqual(storage(t, dir).load(), original, '正常引擎下次可以重新迁移')
})

test('重复或缺失 id 的旧条目不得合并丢失，留在 JSON', { skip: !Database }, (t) => {
  const original = fixture(versions[0])
  original.items.push({ ...original.items[0], text: '同 id 的另一段原文' }, { text: '没有 id 的原文' })
  const dir = setup(t, original)
  const store = storage(t, dir)
  assert.deepEqual(store.load(), original)
  assert.equal(store.status().backend, 'json')
  assert.equal(migratedFiles(dir).length, 0)
})

test('SQLite 中途写失败：已写的行也回滚；新状态完整写 JSON，重启继续 JSON', { skip: !Database }, (t) => {
  const original = { ...fixture(versions[1]), gists: [{ id: 'g1', text: '原梗概' }] }
  const dir = setup(t, original)
  const warnings = []
  const control = { armed: false, writes: 0, failAt: 3 }
  const store = storage(t, dir, { Database: faultDatabase(control), log: { warn: (s) => warnings.push(s) } })
  const next = store.load()
  next.items[0].text = '改动一'
  next.items[1].text = '改动二'
  next.gists[0].text = '改动三'
  next.profiles['30000001'].text = '新画像'
  control.armed = true
  store.save(next)
  assert.equal(control.writes, 3, '真正写了两行后才抛错')
  assert.deepEqual(databaseState(dir), original, '磁盘 SQLite 必须仍为上一版完整状态')
  assert.deepEqual(store.load(), next, '本轮使用完整 JSON 新状态')
  assert.equal(store.status().backend, 'json')
  assert.equal(warnings.length, 1)
  assert.equal(existsSync(join(dir, 'memory-json-fallback.json')), true)
  assert.deepEqual(storage(t, dir).load(), next, '重启不得误切回旧 SQLite')
})

test('SQLite 只写变化行；items/gists/kv 的删除、顺序、未知顶层字段也能往返', { skip: !Database }, (t) => {
  const initial = { ...fixture(versions[0]), gists: [{ id: 'g1', text: '梗概甲' }, { id: 'g2', text: '梗概乙' }], legacyTop: { keep: true } }
  const dir = setup(t, initial)
  const store = storage(t, dir)
  store.load()
  const db = new Database(join(dir, 'memory.sqlite'))
  try {
    db.exec('CREATE TABLE audit (collection TEXT, operation TEXT, id TEXT)')
    for (const table of ['items', 'gists', 'kv']) {
      const key = table === 'kv' ? 'key' : 'id'
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const ref = operation === 'DELETE' ? 'old' : 'new'
        db.exec(`CREATE TRIGGER audit_${table}_${operation} AFTER ${operation} ON ${table} BEGIN INSERT INTO audit VALUES ('${table}', '${operation}', ${ref}.${key}); END`)
      }
    }
    const state = store.load()
    store.save(state)
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit').get().n, 0, '原样 save 不写任何状态行')
    state.items[0].hits++
    state.gists[0].text = '梗概甲修改'
    state.profiles['30000001'].text += '（补充）'
    store.save(state)
    assert.deepEqual(db.prepare('SELECT collection, operation, id FROM audit').all().map((r) => ({ ...r })), [
      { collection: 'items', operation: 'UPDATE', id: state.items[0].id },
      { collection: 'gists', operation: 'UPDATE', id: 'g1' },
      { collection: 'kv', operation: 'UPDATE', id: 'profiles' },
    ])
    db.exec('DELETE FROM audit')
    state.items.splice(1, 1)
    state.items.reverse()
    state.gists.splice(0, 1)
    delete state.styles
    delete state.legacyTop
    store.save(state)
    assert.equal(db.prepare("SELECT count(*) AS n FROM audit WHERE collection IN ('items', 'gists') AND operation = 'UPDATE'").get().n, 0, '删条目和重排不重写文字没变的行')
    assert.deepEqual(store.load(), state)
    store.close()
    assert.deepEqual(storage(t, dir).load(), state)
  } finally { db.close() }
})

for (const backend of ['json', 'sqlite']) {
  test(`${backend}：升级后的有效压缩每次最多两簇、每簇八条，手动/导入/core 不标过时`, { skip: backend === 'sqlite' && !Database }, async (t) => {
    const state = recentFixture(versions[0])
    const template = state.items[0]
    state.items = []
    // 三簇，每簇超过 maxItems，才能发现「把全簇一起标过时」的回归。
    for (let group = 0; group < 3; group++) for (let i = 0; i < COMPRESS.maxItems + 3; i++) state.items.push({
      ...template, id: `cluster-${group}-${i}`, text: `小明和朋友一起练习手作，留下了作品${i}`,
      source: ['auto', 'event', 'diary'][i % 3], chatId: `group:${700 + group}`, at: Date.now() - (20 + i) * DAY,
    })
    for (const source of ['tool', 'panel', 'import']) state.items.push({ ...template, id: source, source, text: `手动保留的${source}原文`, chatId: 'group:700' })
    state.items.push({ ...template, id: 'core', source: 'auto', tier: 'core', text: '一直保留的重要印象', chatId: 'group:700' })
    state.items.push({ ...template, id: 'numeric-core', source: 'auto', tier: 0, text: '数字永久档也一直保留', chatId: 'group:700' })
    const dir = setup(t, state, backend === 'json')
    const cfg = normalize({ ownerQQ: '10000001', model: { provider: 'p', model: 'm' }, memory: { keepChatlogDays: -1 } })
    const { mem, calls } = business(cfg, [], ({ system }) => system.includes('下面是你记得的一些具体的事') ? '{"text":"朋友们相处融洽，常常一起练习手作"}' : '[]')
    const store = storage(t, dir)
    for (let run = 0; run < 2; run++) {
      const before = store.load()
      const previousCalls = compressionCalls(calls).length
      const result = await mem.consolidate({ includeToday: true })
      assert.equal(result.ok, true, result.message)
      assert.ok(result.compressed > 0 && result.compressed <= COMPRESS.maxCallsPerRun)
      assert.ok(compressionCalls(calls).length - previousCalls <= COMPRESS.maxCallsPerRun)
      const after = store.load()
      const invalid = after.items.filter((m) => m.invalidAt && !before.items.find((b) => b.id === m.id)?.invalidAt)
      assert.ok(invalid.length <= COMPRESS.maxCallsPerRun * COMPRESS.maxItems)
      for (const abstract of after.items.filter((m) => m.source === 'abstract')) assert.ok(abstract.abstractOf.length <= COMPRESS.maxItems)
      for (const id of ['tool', 'panel', 'import', 'core', 'numeric-core']) assert.deepEqual(after.items.find((m) => m.id === id), state.items.find((m) => m.id === id))
      assert.equal(result.forgot, 0)
    }
  })
}

test('备份主库和 WAL 使用同一份快照；备份期间产生的新写入不混入，恢复后内容完整', { skip: !Database }, async (t) => {
  const original = fixture(versions[1])
  const dir = setup(t, original)
  const store = storage(t, dir)
  store.load()
  // 留着连接并关闭自动 checkpoint，确保被备份的更新确实只在 WAL 中。
  const db = new Database(join(dir, 'memory.sqlite'))
  let closed = false
  t.after(() => { if (!closed) db.close() })
  db.exec('PRAGMA wal_autocheckpoint = 0')
  const expected = structuredClone(original)
  expected.items[0].text = '只存在 WAL 中的新原文'
  db.prepare('UPDATE items SET json = ? WHERE id = ?').run(JSON.stringify(expected.items[0]), expected.items[0].id)
  assert.ok(existsSync(join(dir, 'memory.sqlite-wal')))
  let changed = false
  const backup = await createBackup({ onProgress() {
    if (changed) return
    changed = true
    const later = { ...expected.items[0], text: '打包进行中才写入的下一版' }
    db.prepare('UPDATE items SET json = ? WHERE id = ?').run(JSON.stringify(later), later.id)
  } })
  assert.deepEqual(backup.skipped, [])
  await stageRestore(backup.file)
  assert.ok(existsSync(join(dir, '.restore', 'memory.sqlite')))
  assert.ok(existsSync(join(dir, '.restore', 'memory.sqlite-wal')))
  assert.equal(existsSync(join(dir, '.restore', 'memory.sqlite-shm')), false)
  db.close(); closed = true
  applyPendingRestore(991)
  assert.deepEqual(storage(t, dir).load(), expected)
  assert.ok(existsSync(join(dir, 'backups', 'pre-restore-991', 'memory.sqlite')))
})

test('回退后的 JSON 和权威后端标记也一起备份，恢复时不误读旧 SQLite', { skip: !Database }, async (t) => {
  const original = fixture(versions[1])
  const dir = setup(t, original)
  const control = { armed: false, writes: 0, failAt: 2 }
  const store = storage(t, dir, { Database: faultDatabase(control) })
  const expected = store.load()
  expected.items[0].text = '回退时保存的新原文'
  expected.items[1].text = '同一版的第二条新原文'
  control.armed = true
  store.save(expected)
  const backup = await createBackup({ onProgress() {
    const later = structuredClone(expected)
    later.items[0].text = '备份开始后的改动'
    store.save(later)
  } })
  await stageRestore(backup.file)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.restore', 'memories.json'), 'utf8')), expected)
  assert.ok(existsSync(join(dir, '.restore', 'memory-json-fallback.json')))
  applyPendingRestore(993)
  const restored = storage(t, dir)
  assert.deepEqual(restored.load(), expected)
  assert.equal(restored.status().backend, 'json')
  assert.deepEqual(databaseState(dir), original)
})

test('恢复只有 JSON 的旧备份：现有库/WAL/SHM/回退标记留底，再按正常流程迁移', { skip: !Database }, async (t) => {
  const original = fixture(versions[0])
  const dir = setup(t, original)
  const oldBackup = await createBackup()
  const store = storage(t, dir)
  store.load()
  const newer = store.load()
  newer.items[0].text = '恢复前的新电脑内容'
  store.save(newer)
  store.close()
  // 恢复时还要移走残留 sidecar；不把它们接到恢复后的新库上。
  writeFileSync(join(dir, 'memory.sqlite-wal'), 'obsolete wal')
  writeFileSync(join(dir, 'memory.sqlite-shm'), 'obsolete shm')
  writeFileSync(join(dir, 'memory-json-fallback.json'), '{}')
  await stageRestore(oldBackup.file)
  applyPendingRestore(992)
  assert.equal(existsSync(join(dir, 'memory.sqlite')), false)
  for (const name of ['memory.sqlite', 'memory.sqlite-wal', 'memory.sqlite-shm', 'memory-json-fallback.json']) assert.ok(existsSync(join(dir, 'backups', 'pre-restore-992', name)), name)
  assert.deepEqual(storage(t, dir).load(), original)
  assert.equal(migratedFiles(dir).length, 2, '原迁移备份和这次旧备份迁移的留底都保留')
})
