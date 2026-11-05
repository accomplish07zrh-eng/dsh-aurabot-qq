// 记忆的持久化边界：业务仍然整份 load/save，SQLite 内按行比较并原子提交。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { dataDir, readJson, writeJson } from '../core/store.js'

let NativeDatabase
let sqliteError
try { ({ DatabaseSync: NativeDatabase } = await import('node:sqlite')) } catch (error) { sqliteError = error }

export const MEMORY_SCHEMA = 1
export const MEMORY_FILES = ['memory.sqlite', 'memory.sqlite-wal', 'memory.sqlite-shm', 'memories.json', 'memory-json-fallback.json']
const empty = () => ({ items: [] })
const tables = ['items', 'gists', 'kv', 'meta']

function rowsOf(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || !Array.isArray(state.items)) throw new Error('记忆格式不正确')
  const rows = { items: new Map(), gists: new Map(), kv: new Map(), meta: new Map() }
  const collections = []
  for (const [key, value] of Object.entries(state)) {
    if (key === 'items' || key === 'gists') {
      if (!Array.isArray(value)) throw new Error(`${key} 不是数组`)
      value.forEach((item) => {
        if (!item || typeof item.id !== 'string' || !item.id || rows[key].has(item.id)) throw new Error(`${key} 有缺失或重复的 id，保留 JSON`)
        rows[key].set(item.id, { json: JSON.stringify(item) })
      })
      rows.meta.set(`${key}:order`, { json: JSON.stringify([...rows[key].keys()]) })
      collections.push(key)
    } else rows.kv.set(key, { json: JSON.stringify(value) })
  }
  // 元数据单独存，kv 只放其余顶层字段，也不占用用户可能已有的键。
  rows.meta.set('collections', { json: JSON.stringify(collections.sort()) })
  return rows
}

function readDatabase(db) {
  const meta = new Map(db.prepare('SELECT key, json FROM meta').all().map((r) => [r.key, JSON.parse(r.json)]))
  const collections = meta.get('collections') || []
  const state = Object.fromEntries(db.prepare('SELECT key, json FROM kv ORDER BY rowid').all().map((r) => [r.key, JSON.parse(r.json)]))
  for (const table of ['items', 'gists']) {
    const ranks = new Map((meta.get(`${table}:order`) || []).map((id, i) => [id, i]))
    const items = db.prepare(`SELECT id, json FROM ${table}`).all()
      .sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity))
      .map((r) => JSON.parse(r.json))
    if (collections.includes(table) || items.length) state[table] = items
  }
  return state
}

function initialize(db) {
  db.exec('PRAGMA busy_timeout = 1000')
  const version = db.prepare('PRAGMA user_version').get().user_version
  if (version > MEMORY_SCHEMA) throw new Error(`记忆数据库版本 ${version} 比插件新，保留原库`)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL')
  if (version === MEMORY_SCHEMA) return
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS gists (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, json TEXT NOT NULL);
    PRAGMA user_version = ${MEMORY_SCHEMA};
    COMMIT;`)
}

/** Database 可注入，供不支持 SQLite 的运行环境及故障测试使用；null 明确选 JSON。 */
export function createMemoryStorage({ directory = () => dataDir(), log = console, Database = NativeDatabase } = {}) {
  let root
  let db
  let snapshot
  let lastState
  let backend
  let warned = false
  let fallbackReason = ''
  const path = (name) => join(root, name)
  const warn = (error) => {
    fallbackReason = error?.message || String(error)
    if (!warned) { log?.warn?.(`记忆存储改用 JSON：${fallbackReason}`); warned = true }
  }
  const closeDatabase = () => { try { db?.close() } catch {} db = null }
  const selectDirectory = () => {
    const next = typeof directory === 'function' ? directory() : directory
    if (root === next) return
    closeDatabase()
    root = next
    snapshot = lastState = backend = undefined
    warned = false
  }
  function jsonState() {
    const file = path('memories.json')
    if (existsSync(file)) return readJson(file, () => structuredClone(lastState || empty()))
    if (lastState) return structuredClone(lastState)
    // SQLite 在这个运行时完全不可用时，至少能读升级时留下的旧档；原库始终保留。
    try {
      const backups = readdirSync(root).filter((n) => /^memories\.migrated-.*\.json$/.test(n)).sort()
      return backups.length ? readJson(path(backups.at(-1)), empty) : empty()
    } catch { return empty() }
  }
  function fallback(error) {
    warn(error)
    closeDatabase()
    backend = 'json'
    // 先写恢复快照，再记权威后端。下次启动不能误读写失败前的 SQLite。
    if (lastState && !existsSync(path('memories.json'))) {
      try { writeJson(path('memories.json'), lastState) } catch (error) { log?.warn?.('记忆 JSON 恢复快照写入失败：', error.message) }
    }
  }
  function archiveJson() {
    const file = path('memories.json')
    if (!existsSync(file)) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    let backup = path(`memories.migrated-${stamp}.json`)
    for (let n = 1; existsSync(backup); n++) backup = path(`memories.migrated-${stamp}-${n}.json`)
    renameSync(file, backup)
  }
  function writeRows(state, { verify = false } = {}) {
    const next = rowsOf(state)
    const previous = snapshot || { items: new Map(), gists: new Map(), kv: new Map(), meta: new Map() }
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const table of tables) {
        const scalar = table === 'kv' || table === 'meta'
        const key = scalar ? 'key' : 'id'
        const put = db.prepare(`INSERT INTO ${table} (${key}, json) VALUES (?, ?) ON CONFLICT(${key}) DO UPDATE SET json=excluded.json`)
        const del = db.prepare(`DELETE FROM ${table} WHERE ${key} = ?`)
        for (const id of previous[table].keys()) if (!next[table].has(id)) del.run(id)
        for (const [id, row] of next[table]) {
          const old = previous[table].get(id)
          if (old?.json === row.json) continue
          put.run(id, row.json)
        }
      }
      if (verify) {
        for (const table of tables) {
          if (db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count !== next[table].size) throw new Error(`迁移核对失败：${table} 条数不一致`)
        }
        if (!isDeepStrictEqual(readDatabase(db), state)) throw new Error('迁移核对失败：记忆内容不一致')
      }
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    }
    snapshot = next
    lastState = structuredClone(state)
  }
  function openDatabase() {
    selectDirectory()
    if (backend === 'json') return
    if (existsSync(path('memory-json-fallback.json'))) {
      fallback(new Error('上次 SQLite 写入失败，继续使用 JSON，避免读到旧数据'))
      return
    }
    if (backend === 'sqlite') {
      try {
        db = new Database(path('memory.sqlite'))
        db.exec('PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL')
      } catch (error) { fallback(error) }
      return
    }
    if (!Database) {
      const detail = sqliteError?.message || 'node:sqlite 不可用'
      fallback(new Error(detail + (existsSync(path('memory.sqlite')) ? '；原库保留，当前只能读取 JSON 或迁移时的备份，可能缺少后续改动' : '')))
      return
    }
    const file = path('memory.sqlite')
    const staging = path('memory.sqlite.migrating')
    const migrating = !existsSync(file)
    try {
      mkdirSync(root, { recursive: true })
      if (migrating) {
        // 在旁边建完整新库；进程在导入中退出也不会留下一个被误认成迁移成功的空库。
        for (const suffix of ['', '-wal', '-shm']) rmSync(staging + suffix, { force: true })
        const state = existsSync(path('memories.json')) ? readJson(path('memories.json'), null) : empty()
        rowsOf(state) // 先验证；坏文件不得改名、不得切换。
        db = new Database(staging)
        initialize(db)
        writeRows(state, { verify: true })
        const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
        if (checkpoint.busy) throw new Error('迁移数据库仍被占用')
        closeDatabase()
        renameSync(staging, file)
        // 切换后才改名；改名失败仍回到 JSON，原 JSON 未被删除。
        archiveJson()
      }
      db = new Database(file)
      initialize(db)
      const state = readDatabase(db)
      snapshot = rowsOf(state)
      lastState = state
      backend = 'sqlite'
      // 处理「新库已落盘，旧文件还没改名」时进程退出的情况。
      if (existsSync(path('memories.json')) && isDeepStrictEqual(readJson(path('memories.json'), null), state)) archiveJson()
    } catch (error) {
      fallback(error)
      if (migrating) {
        for (const suffix of ['', '-wal', '-shm']) { try { rmSync(staging + suffix, { force: true }) } catch {} }
      }
    }
  }
  // 句柄不跨同步操作持有，避免插件重载和 Windows 恢复/搬目录时占用数据库文件。
  // 比较快照保留在内存中；连接关闭并不会把未变化的行重新写一遍。
  function load() {
    openDatabase()
    if (backend === 'sqlite') {
      try {
        // 每次读都刷新比较快照；不把调用方随后对对象的修改当成「已保存」。
        const state = readDatabase(db)
        snapshot = rowsOf(state)
        lastState = structuredClone(state)
        return state
      } catch (error) { fallback(error) } finally { closeDatabase() }
    }
    lastState = jsonState()
    return structuredClone(lastState)
  }
  function save(state) {
    openDatabase()
    if (backend === 'sqlite') {
      try { writeRows(state); return } catch (error) { fallback(error) } finally { closeDatabase() }
    }
    // JSON 写入仍使用现有的临时文件 + 改名。先确保 JSON 是上一版完整状态，
    // 再标记权威后端，最后原子替换为新状态；三步之间退出也不会读到陈旧残档。
    // 磁盘完全不可写时不能假报保存成功。
    if (existsSync(path('memory.sqlite'))) {
      writeJson(path('memories.json'), lastState || jsonState())
      writeJson(path('memory-json-fallback.json'), { reason: fallbackReason, at: Date.now() })
    }
    writeJson(path('memories.json'), state)
    lastState = structuredClone(state)
  }
  return {
    load, save,
    status: () => { openDatabase(); closeDatabase(); return { backend, schema: backend === 'sqlite' ? MEMORY_SCHEMA : null, reason: backend === 'json' ? fallbackReason : '' } },
    close: () => { closeDatabase(); backend = undefined; snapshot = undefined },
  }
}

/** 同步锁住写入并一起读取主库与 WAL、JSON 回退状态；不能逐个异步读取活库。 */
export function captureMemoryBackup(root = dataDir()) {
  const file = join(root, 'memory.sqlite')
  const files = new Map()
  let db
  try {
    if (existsSync(file)) {
      if (!NativeDatabase) throw sqliteError || new Error('node:sqlite 不可用，无法安全备份 SQLite')
      db = new NativeDatabase(file)
      db.exec('PRAGMA busy_timeout = 1000; BEGIN IMMEDIATE')
      files.set('memory.sqlite', readFileSync(file))
      if (existsSync(file + '-wal')) files.set('memory.sqlite-wal', readFileSync(file + '-wal'))
    }
    for (const name of ['memories.json', 'memory-json-fallback.json']) {
      if (existsSync(join(root, name))) files.set(name, readFileSync(join(root, name)))
    }
    db?.exec('ROLLBACK')
    return files
  } finally { db?.close() }
}
