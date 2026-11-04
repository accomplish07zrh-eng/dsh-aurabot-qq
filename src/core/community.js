// 社区模块：从 dsh-aurabot-qq-mods 仓库的索引下载、校验、安装、更新、卸载模块。
//
// 规则见 mods 仓库的 docs/MODULE_SPEC.md「插件端要遵守的约定」：
// - 下载后先核对 sha256，zip 里的路径不合法就整包拒绝
// - 解压到 modules/.<id>.installing/（. 开头不会被扫描），校验通过才改名落位
// - 写 .aurabot-source.json 记来源；没有这个文件的同名文件夹是用户自己写的，绝不覆盖
// - 能力声明不是沙箱：安装前面板要把来源和能力给用户看
//
// 从内置搬到社区库的模块（MOVED），老用户升级时自动装回来，只装一次，卸载后不会再装。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { inflateRawSync, crc32 } from 'node:zlib'
import { dataDir } from './store.js'
import { API_VERSION, builtinDir, userDir } from './modules.js'

export const REGISTRY_URL = 'https://raw.githubusercontent.com/aureth-labs/dsh-aurabot-qq-mods/registry/index.json'
export const SOURCE_FILE = '.aurabot-source.json'
const MAX_ZIP_BYTES = 25 * 1024 * 1024
const MAX_FILE_BYTES = 64 * 1024 * 1024
const ID_RE = /^[a-z][a-z0-9-]{1,39}$/
const INDEX_TTL = 5 * 60_000
const RETRY_MS = 1000
// 安装量用模块库 Releases 里安装包的下载次数：不用额外服务，代价是 GitHub 接口没登录时一小时只给 60 次，
// 所以读一次缓存一小时；读失败也记下来，5 分钟内不再试，别把额度耗在断网上。
const STATS_TTL = 60 * 60_000
const STATS_FAIL_TTL = 5 * 60_000
const RELEASES_PAGES = 3

/** fetch 断网时只说 fetch failed，这里把真正的原因换成人话。 */
const isNetError = (error) => error instanceof TypeError || error?.name === 'TimeoutError' || error?.name === 'AbortError' || Boolean(error?.cause?.code)
const netError = (error) => new Error(`连不上 GitHub（${error?.cause?.code || error?.name || error?.message}），检查网络或代理后再试`)

/** 网络断了再试一次：代理和直连 GitHub 都常有瞬断。 */
async function withRetry(fn, retryMs) {
  try { return await fn() } catch (error) {
    if (!isNetError(error)) throw error
    await new Promise((done) => setTimeout(done, retryMs))
    try { return await fn() } catch (again) { throw isNetError(again) ? netError(again) : again }
  }
}

/** 边收边报进度；没有流的响应（测试替身）直接整包读。 */
async function readBody(r, onBytes) {
  if (!r.body) return Buffer.from(await r.arrayBuffer())
  const chunks = []
  let got = 0
  for await (const chunk of r.body) {
    got += chunk.length
    if (got > MAX_ZIP_BYTES) throw new Error('安装包太大')
    chunks.push(chunk)
    onBytes(got)
  }
  return Buffer.concat(chunks)
}

/** 搬到社区库的原内置模块：id → 老用户是否在用（在用才自动装回来）。 */
export const MOVED = {
  pet: () => existsSync(dataDir('modules-data', 'pet', 'app')), // 装过桌宠客户端才算在用
  douyin: (cfg) => cfg.douyin?.enabled === true,
  heybox: (cfg) => cfg.heybox?.enabled === true,
  'group-admin': (cfg) => cfg.setupDone === true,
}

/** 只比 x.y.z：1.2.0-beta.1 算满足 minPluginVersion 1.2.0，模块不用跟着测试版改版本要求。 */
export function compareVersions(a, b) {
  const x = String(a).split('-')[0].split('.').map(Number)
  const y = String(b).split('-')[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1
  return 0
}

/** 解开 zip，返回 Map(路径 → Buffer)。不合法的路径、压缩方式、校验和一律抛错。 */
export function readZip(buf) {
  let end = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break }
  if (end < 0) throw new Error('不是有效的 zip')
  const count = buf.readUInt16LE(end + 10)
  let p = buf.readUInt32LE(end + 16)
  const files = new Map()
  let total = 0
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 目录损坏')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const packed = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (flags & 1) throw new Error('zip 不能加密')
    if (name.endsWith('/')) continue
    if (!safeName(name)) throw new Error(`zip 里有不安全的路径：${name}`)
    if (method !== 0 && method !== 8) throw new Error(`zip 用了不支持的压缩方式：${name}`)
    total += size
    if (total > MAX_FILE_BYTES) throw new Error('解压后太大')
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('zip 文件头损坏')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + packed)
    const data = method === 8 ? inflateRawSync(raw, { maxOutputLength: MAX_FILE_BYTES }) : Buffer.from(raw)
    if (data.length !== size || crc32(data) !== crc) throw new Error(`zip 校验失败：${name}`)
    files.set(name, data)
  }
  return files
}

function safeName(name) {
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false
  return name.split('/').every((seg) => seg && seg !== '.' && seg !== '..')
}

// registry 地址的优先级：调用方显式传入 > 配置 ext.market.registryUrl > 环境变量 AURABOT_REGISTRY_URL > 内置默认。
// 让模块市场支持换地址（自建索引 / 国内镜像 / 内网部署）而不必改代码或设环境变量。
function resolveRegistryUrl(arg, getConfig) {
  if (typeof arg === 'string' && arg.trim() && arg !== REGISTRY_URL) return arg // 显式传参优先（测试 / 旧式调用）
  const fromConfig = String(getConfig?.()?.ext?.market?.registryUrl || '').trim()
  if (fromConfig && /^https?:\/\//i.test(fromConfig)) return fromConfig
  const fromEnv = String(process.env.AURABOT_REGISTRY_URL || '').trim()
  if (fromEnv) return fromEnv
  return REGISTRY_URL
}

export function createCommunity({ mods, getConfig, setConfig, log, version, alive = () => true, registryUrl, fetcher = fetch, retryMs = RETRY_MS }) {
  const dirOf = (id) => join(userDir(), id)
  // 模块市场索引地址：单一真相，index 下载 / 安装量读取都用它。
  // 支持换地址（自建索引 / 镜像 / 内网）：先看配置 ext.market.registryUrl，再退环境变量，最后回到内置 github。
  const registryUrlOf = () => resolveRegistryUrl(registryUrl, getConfig)
  let cache = null // { at, index }
  let busy = null // 同一时间只跑一个安装 / 卸载
  let progress = null // 安装中：{ id, name, stage: 'index' | 'download' | 'install' | 'start', received, total }
  let statsCache = null // { at, repo, value }：安装量，见 loadStats
  let statsMiss = null // { at, repo }：上次读安装量失败的时间

  const readSource = (id) => {
    try { return JSON.parse(readFileSync(join(dirOf(id), SOURCE_FILE), 'utf8')) } catch (error) { return null }
  }
  const hasFolder = (id) => existsSync(dirOf(id))

  async function loadIndex({ force = false } = {}) {
    const url = registryUrlOf()
    // 换地址后旧缓存作废（按 URL 判），否则改完地址可能 5 分钟内仍读到旧的索引。
    if (!force && cache && cache.url === url && Date.now() - cache.at < INDEX_TTL) return cache.index
    const index = await withRetry(async () => {
      const r = await fetcher(url, { signal: AbortSignal.timeout(20_000), cache: 'no-store' })
      if (!r.ok) throw new Error(`读不到社区模块索引（HTTP ${r.status}）`)
      return r.json()
    }, retryMs)
    if (index?.schema !== 1) throw new Error('社区模块索引的格式是新版的，先更新插件')
    cache = { at: Date.now(), url, index }
    return index
  }

  const revokedReason = (index, id, v) => (index.revoked || []).find((r) => r.id === id && r.versions?.includes(v))?.reason || ''

  /** 索引里的仓库地址 → owner/repo。索引是可下载的第三方数据，只认长得对的。 */
  function repoOf(index) {
    for (const url of [index?.assetsBase, index?.homepage, registryUrlOf()]) {
      const m = String(url || '').match(/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/)
      if (m && ID_RE.test(m[1].toLowerCase()) && ID_RE.test(m[2].toLowerCase())) return `${m[1]}/${m[2]}`
    }
    return ''
  }

  /** 把 Releases 列表按模块聚合成 { 模块 id: 下载次数 }。tag 形如 pet-v1.0.7。 */
  function sumReleases(releases) {
    const out = {}
    for (const rel of Array.isArray(releases) ? releases : []) {
      const m = String(rel?.tag_name || '').match(/^([a-z][a-z0-9-]{1,39})-v\d+\.\d+\.\d+$/)
      if (!m) continue
      const n = (Array.isArray(rel.assets) ? rel.assets : []).reduce((sum, a) => sum + (Number(a?.download_count) || 0), 0)
      out[m[1]] = (out[m[1]] || 0) + n
    }
    return out
  }

  /**
   * 下载量是锦上添花：最多等 6 秒，等不到就先当没有，别把市场页拖住。
   * 超时后台继续，下一次进来就用缓存了（不重复打接口）。
   */
  function statsWithin(index, { force = false } = {}) {
    return new Promise((done) => {
      const timer = setTimeout(() => done({ counts: {}, source: '', at: 0, failed: true }), 6000)
      loadStats(index, { force }).then((value) => { clearTimeout(timer); done(value) }, () => { clearTimeout(timer); done({ counts: {}, source: '', at: 0, failed: true }) })
    })
  }

  /**
   * 每个模块的安装量（近似值：Releases 里安装包的下载次数，更新也算一次）。
   * 读不到就返回空表，市场照常能用——统计不是必需功能，不能因为它挂掉。
   */
  async function loadStats(index, { force = false } = {}) {
    const repo = repoOf(index)
    if (!repo) return { counts: {}, source: '', at: 0 }
    if (!force && statsCache && statsCache.repo === repo && Date.now() - statsCache.at < STATS_TTL) return statsCache.value
    if (!force && statsMiss && statsMiss.repo === repo && Date.now() - statsMiss.at < STATS_FAIL_TTL) return { counts: {}, source: repo, at: 0, failed: true }
    try {
      const counts = {}
      // 有令牌就用上：没登录时 GitHub 接口一小时只给 60 次，用户多的机器会不够
      const token = String(process.env.AURABOT_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '').trim()
      for (let page = 1; page <= RELEASES_PAGES; page++) {
        const r = await fetcher(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
          signal: AbortSignal.timeout(5000),
          headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        })
        // 403 是没登录的额度用完了：别再翻页，已有的照用
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const list = await r.json()
        for (const [id, n] of Object.entries(sumReleases(list))) counts[id] = (counts[id] || 0) + n
        if (!Array.isArray(list) || list.length < 100) break
      }
      const value = { counts, source: repo, at: Date.now() }
      statsCache = { at: value.at, repo, value }
      statsMiss = null
      return value
    } catch (error) {
      statsMiss = { at: Date.now(), repo }
      log.debug?.('读不到模块下载量：', error?.message || error)
      return { counts: {}, source: repo, at: 0, failed: true }
    }
  }

  /** 这一条现在装不了的原因；能装返回空串。 */
  function blocked(index, e) {
    if (Number(e.api) > API_VERSION) return `要扩展接口 v${e.api}，现在的插件只有 v${API_VERSION}，先更新插件`
    if (compareVersions(e.minPluginVersion, version) > 0) return `要插件 ${e.minPluginVersion} 以上，现在是 ${version}，先更新插件`
    if (revokedReason(index, e.id, e.version)) return `这个版本已撤回：${revokedReason(index, e.id, e.version)}`
    const known = new Set(mods.status().map((m) => m.id))
    const missing = (e.requires || []).filter((dep) => !known.has(dep))
    return missing.length ? `要先装：${missing.join('、')}` : ''
  }

  function view(index, e, counts = {}) {
    const src = readSource(e.id)
    return {
      ...e,
      installed: src?.version || '',
      foreign: !src && hasFolder(e.id), // 同名文件夹是用户自己写的
      update: Boolean(src && compareVersions(e.version, src.version) > 0),
      blocked: blocked(index, e),
      moved: e.id in MOVED,
      // 安装量：模块库 Releases 里安装包的下载次数（更新也算），读不到时是 0
      downloads: Number(counts[e.id]) || 0,
    }
  }

  async function list({ force = false } = {}) {
    const index = await loadIndex({ force })
    const stats = await statsWithin(index, { force })
    const counts = stats.counts || {}
    const entries = (index.modules || []).filter((e) => ID_RE.test(String(e.id))).map((e) => view(index, e, counts))
    // 已安装但索引里没有了（下架）的也列出来，好让用户卸载
    const known = new Set(entries.map((e) => e.id))
    const delisted = mods.status().filter((m) => !known.has(m.id) && readSource(m.id)).map((m) => ({ id: m.id, name: m.name, description: m.description, version: readSource(m.id).version, installed: readSource(m.id).version, delisted: true, capabilities: [], blocked: '', downloads: Number(counts[m.id]) || 0 }))
    const revoked = entries.concat(delisted).filter((e) => e.installed && revokedReason(index, e.id, e.installed)).map((e) => ({ id: e.id, version: e.installed, reason: revokedReason(index, e.id, e.installed) }))
    return { list: [...entries, ...delisted], revoked, generatedAt: index.generatedAt || '', downloads: { source: stats.source || '', at: stats.at || 0, failed: Boolean(stats.failed) } }
  }

  async function download(index, e) {
    const url = String(index.assetsBase || '') + e.path
    if (!/^https:\/\//.test(url)) throw new Error('下载地址不对')
    const buf = await withRetry(async () => {
      progress = { id: e.id, name: e.name, stage: 'download', received: 0, total: 0 }
      const r = await fetcher(url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' })
      if (!r.ok) throw new Error(`下载失败（HTTP ${r.status}）`)
      progress.total = Number(r.headers?.get?.('content-length')) || 0
      return readBody(r, (received) => { progress.received = received })
    }, retryMs)
    if (buf.length > MAX_ZIP_BYTES) throw new Error('安装包太大')
    const sha = createHash('sha256').update(buf).digest('hex')
    if (sha !== e.sha256) throw new Error('安装包校验不通过，已丢弃')
    return buf
  }

  /** 解压到 .<id>.installing/，检查通过再换上去。 */
  function place(e, files) {
    const manifest = JSON.parse(files.get('module.json')?.toString('utf8') || 'null')
    if (manifest?.id !== e.id || manifest?.version !== e.version) throw new Error('安装包内容和索引对不上')
    const stage = join(userDir(), `.${e.id}.installing`)
    const old = join(userDir(), `.${e.id}.old`)
    rmSync(stage, { recursive: true, force: true })
    rmSync(old, { recursive: true, force: true })
    mkdirSync(stage, { recursive: true })
    try {
      const root = resolve(stage) + sep
      for (const [name, data] of files) {
        const dest = resolve(stage, name)
        if (!dest.startsWith(root)) throw new Error(`zip 里有不安全的路径：${name}`)
        mkdirSync(dirname(dest), { recursive: true })
        writeFileSync(dest, data)
      }
      if (!existsSync(join(stage, 'index.mjs')) && !existsSync(join(stage, 'index.js'))) throw new Error('安装包里没有入口文件')
      writeFileSync(join(stage, SOURCE_FILE), JSON.stringify({ id: e.id, version: e.version, sha256: e.sha256, installedAt: new Date().toISOString() }, null, 2))
      const target = dirOf(e.id)
      if (existsSync(target)) renameSync(target, old)
      try { renameSync(stage, target) } catch (error) {
        if (existsSync(old)) renameSync(old, target) // 换不上就把旧的放回去
        throw error
      }
      rmSync(old, { recursive: true, force: true })
    } finally { rmSync(stage, { recursive: true, force: true }) }
  }

  const exclusive = (fn) => {
    if (busy) return Promise.resolve({ ok: false, message: '上一个操作还没做完，稍等' })
    busy = Promise.resolve().then(fn).catch((error) => {
      log.warn('模块市场操作失败：', error?.message || error)
      return { ok: false, message: String(error?.message || error) }
    }).finally(() => { busy = null; progress = null })
    return busy
  }

  /** 安装或更新。同名但不是社区装的文件夹不碰；替换内置模块要明确 confirmReplace。 */
  const install = (id, { confirmReplace = false } = {}) => exclusive(async () => {
    // id 会拼进目录路径（modules/.<id>.installing → modules/<id>）：先白名单，防被篡改的索引/调用方越目录写
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, message: 'id 不对' }
    progress = { id, name: id, stage: 'index', received: 0, total: 0 }
    const index = await loadIndex({ force: true })
    const e = (index.modules || []).find((x) => x.id === id)
    if (!e || e.id !== id) return { ok: false, message: `社区库里没有「${id}」` }
    if (hasFolder(id) && !readSource(id)) return { ok: false, message: `modules/${id} 是你自己的文件夹，不会覆盖；先挪走它` }
    // 替换内置按真实文件判断：index 里的 replacesBuiltin 可能被篡改/漏填，不能只信它
    const replacesBuiltin = Boolean(e.replacesBuiltin) || existsSync(join(builtinDir(), id))
    if (replacesBuiltin && !confirmReplace) return { ok: false, needConfirm: true, message: `「${e.name}」会替换内置模块，请确认` }
    const why = blocked(index, e)
    if (why) return { ok: false, message: why }
    const files = readZip(await download(index, e))
    progress = { id, name: e.name, stage: 'install', received: 0, total: 0 }
    place(e, files)
    progress = { id, name: e.name, stage: 'start', received: 0, total: 0 }
    await mods.sync()
    const m = mods.status().find((x) => x.id === id)
    if (m?.error) return { ok: false, message: `装好了，但加载失败：${m.error}` }
    log.info(`社区模块「${e.name}」${e.version} 已安装`)
    return { ok: true, message: `「${e.name}」${e.version} 装好了` }
  })

  /** 卸载。默认保留 modules-data/<id>/ 和设置；purge 才清掉。 */
  const remove = (id, { purge = false } = {}) => exclusive(async () => {
    if (!ID_RE.test(id)) return { ok: false, message: 'id 不对' }
    if (!readSource(id)) return { ok: false, message: `「${id}」不是从社区库装的，不能在这里卸载` }
    mods.stop(id)
    rmSync(dirOf(id), { recursive: true, force: true })
    if (purge) {
      rmSync(dataDir('modules-data', id), { recursive: true, force: true })
      const cfg = getConfig()
      const { [id]: _ext, ...ext } = cfg.ext || {}
      const { [id]: _mod, ...modules } = cfg.modules || {}
      setConfig({ ...cfg, ext, modules })
    }
    await mods.sync()
    return { ok: true, message: purge ? '卸载好了，数据和设置也清掉了' : '卸载好了，数据和设置还留着' }
  })

  /** 升级后把搬走的模块自动装回来：每个 id 只成功处理一次，失败下次启动重试。 */
  async function migrate() {
    const done = { ...(getConfig().communityMigrated || {}) }
    const result = []
    for (const [id, inUse] of Object.entries(MOVED)) {
      if (!alive()) return result
      if (done[id]) continue
      const cfg = getConfig()
      if (hasFolder(id)) done[id] = 'kept' // 已有同名文件夹：用户的版本优先
      else if (cfg.modules?.[id]?.enabled === false || !inUse(cfg)) done[id] = 'skipped'
      else {
        const r = await install(id)
        result.push({ id, ...r })
        if (r.ok) done[id] = 'installed'
        else log.warn(`搬到社区库的模块「${id}」没装上，下次启动再试：`, r.message)
      }
    }
    if (!alive()) return result // 插件已卸载：旧实例不能把旧配置写回去
    setConfig({ ...getConfig(), communityMigrated: done })
    return result
  }

  return { progress: () => progress, registryUrl: registryUrlOf, list, install, remove, migrate, source: readSource }
}
