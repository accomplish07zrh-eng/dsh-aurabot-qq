// 实验性语义索引：两种模式
//   local  —— 用本机 bge-small 小模型，纯离线，不联网（默认推荐）
//   remote —— 把文字发给用户配置的兼容 OpenAI 的 embedding 服务
// 向量本身都只存在本机；开关默认关闭，用户主动打开才生效。
import { createHash } from 'node:crypto'
import { dataDir, readJson, writeJson } from '../core/store.js'
import { createLocalVectorIndex } from './memory-vector-local.js'

// 一批多少条：方舟等服务的单次 input 上限比 OpenAI 小，默认 10 最稳；面板可调。
const DEFAULT_BATCH = 10
const DEFAULT_QUERY_TIMEOUT = 3000
const SYNC_TIMEOUT = 30_000
const COOLDOWN = 10 * 60_000
const CACHE_TTL = 5 * 60_000
const hash = (s) => createHash('sha256').update(s).digest('hex')
const stamp = (text, vec) => hash(JSON.stringify([String(text || ''), vec]))
const validVector = (v, dims) => Array.isArray(v) && v.length > 0 && (!dims || v.length === dims) && v.every((n) => typeof n === 'number' && Number.isFinite(n)) && v.some((n) => n !== 0)

/** 请求头：一行一个「Key: Value」；也兼容手写成对象。 */
function parseHeaders(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...raw }
  const out = {}
  for (const line of String(raw || '').split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const i = s.indexOf(':')
    if (i <= 0) continue
    const k = s.slice(0, i).trim()
    const v = s.slice(i + 1).trim()
    if (k && v) out[k] = v
  }
  return out
}

/** 有的网关用 base64 返回 float32 数组；统一成普通数组再校验。 */
function toVector(v) {
  if (Array.isArray(v)) return v
  if (typeof v !== 'string' || !v) return v
  try {
    const bytes = Uint8Array.from(Buffer.from(v, 'base64'))
    return Array.from(new Float32Array(bytes.buffer, 0, Math.floor(bytes.length / 4)))
  } catch (error) { return v }
}

export function createVectorIndex({ getConfig, log, fetchImpl = globalThis.fetch }) {
  const file = () => dataDir('memory-vectors.json')
  const metaFile = () => dataDir('memory-vectors-meta.json')
  let data, meta
  let loaded = false
  let identity = ''
  let generation = 0
  let failures = 0
  let retryAt = 0
  let syncing = null
  let needsSave = false
  let lastError = ''
  const cache = new Map()
  const pending = new Map()
  const verified = new Map()
  const norm = (v) => Math.sqrt(v.reduce((sum, n) => sum + n * n, 0))

  function load() {
    if (loaded) return
    data = readJson(file(), () => ({ model: '', dims: 0, items: {} }))
    meta = readJson(metaFile(), () => ({ model: '', base: '', items: {} }))
    if (!data || typeof data !== 'object' || !Number.isInteger(data.dims) || data.dims < 0 || !data.items || typeof data.items !== 'object' || Array.isArray(data.items)) data = { model: '', dims: 0, items: {} }
    if (!meta || typeof meta !== 'object' || !meta.items || typeof meta.items !== 'object' || Array.isArray(meta.items)) meta = { model: '', base: '', items: {} }
    data.items = Object.assign(Object.create(null), data.items)
    meta.items = Object.assign(Object.create(null), meta.items)
    loaded = true
  }

  function settings() {
    const memory = getConfig()?.memory
    const c = memory?.vector
    if (memory?.enabled === false || c?.enabled !== true) return null
    // 只填到 /v1；误贴完整 /embeddings 时自动去掉，避免拼成双路径 404
    const baseUrl = String(c.baseUrl || '').trim().replace(/\/+$/, '').replace(/\/embeddings\/?$/i, '')
    const model = String(c.model || '').trim()
    if (!baseUrl || !model) return null
    try {
      const url = new URL(baseUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
    } catch (error) { return null }
    return {
      baseUrl,
      model,
      apiKey: String(c.apiKey || ''),
      dimensions: Math.max(0, Math.min(8192, Math.round(Number(c.dimensions) || 0))),
      batchSize: Math.max(1, Math.min(64, Math.round(Number(c.batchSize) || DEFAULT_BATCH))),
      queryTimeoutMs: Math.max(500, Math.min(15_000, Number(c.queryTimeoutMs) || DEFAULT_QUERY_TIMEOUT)),
      headers: String(c.headers || ''),
    }
  }

  function prepare() {
    const c = settings()
    if (!c) return null
    load()
    const key = JSON.stringify([c.baseUrl, c.model, c.apiKey, c.dimensions])
    if (key !== identity) {
      identity = key
      generation++
      failures = 0
      retryAt = 0
      cache.clear()
      pending.clear()
    }
    const base = hash(c.baseUrl)
    if (data.model !== c.model || meta.model !== c.model || meta.base !== base) {
      data = { model: c.model, dims: 0, items: Object.create(null) }
      meta = { model: c.model, base, items: Object.create(null) }
      needsSave = true
      cache.clear()
      verified.clear()
    }
    return { ...c, key, generation }
  }

  function current(c) {
    const next = settings()
    return next && c.generation === generation && JSON.stringify([next.baseUrl, next.model, next.apiKey, next.dimensions]) === c.key
  }

  function failed(c, error) {
    if (!current(c)) return
    failures++
    if (failures >= 3) retryAt = Date.now() + COOLDOWN
    lastError = String((error && error.message) || error || '请求失败').slice(0, 200)
    // 不记录服务返回的错误文字：里面可能包含密钥或用户内容。
    log?.debug?.('向量检索请求失败，暂时使用关键词检索')
  }

  async function request(texts, timeout) {
    const c = prepare()
    if (!c || !Array.isArray(texts) || !texts.length || Date.now() < retryAt) return []
    const controller = new AbortController()
    let timer
    try {
      const work = async () => {
        const headers = { 'Content-Type': 'application/json', ...parseHeaders(c.headers) }
        const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')
        if (c.apiKey && !hasAuth) headers.Authorization = `Bearer ${c.apiKey}`
        const input = texts.map((text) => String(text || ''))
        const body = { model: c.model, input }
        if (c.dimensions) body.dimensions = c.dimensions
        const response = await fetchImpl(`${c.baseUrl}/embeddings`, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const json = await response.json()
        if (!current(c)) return []
        if (!Array.isArray(json?.data) || json.data.length !== texts.length) throw new Error('向量数量不符')
        const rows = [...json.data]
        if (rows.every((row) => Number.isInteger(row?.index))) {
          rows.sort((a, b) => a.index - b.index)
          if (rows.some((row, i) => row.index !== i)) throw new Error('向量顺序不符')
        }
        const vectors = rows.map((row) => toVector(row?.embedding))
        const dims = data.dims || vectors[0]?.length
        if (!vectors.every((v) => validVector(v, dims))) throw new Error('向量无效')
        if (c.dimensions && vectors.some((v) => v.length !== c.dimensions)) throw new Error('返回维度与配置不符')
        return vectors
      }
      const vectors = await Promise.race([work(), new Promise((resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('请求超时')) }, timeout)
      })])
      if (!current(c) || Date.now() < retryAt) return []
      if (!vectors.every((v) => validVector(v, data.dims))) throw new Error('向量维度已变化')
      failures = 0
      retryAt = 0
      lastError = ''
      return vectors
    } catch (error) {
      failed(c, error)
      return []
    } finally {
      clearTimeout(timer)
    }
  }

  function embed(texts) {
    return request(texts, SYNC_TIMEOUT)
  }

  async function queryVector(text) {
    const c = prepare()
    const q = String(text || '').trim()
    if (!c || !q) return null
    const saved = cache.get(q)
    if (saved && Date.now() - saved.at < CACHE_TTL && validVector(saved.vec, data.dims)) return saved.vec
    if (saved) cache.delete(q)
    if (pending.has(q)) return pending.get(q)
    const task = (async () => {
      const [vec] = await request([q], c.queryTimeoutMs)
      if (!vec || !current(c)) return null
      cache.delete(q)
      cache.set(q, { at: Date.now(), vec })
      if (cache.size > 100) cache.delete(cache.keys().next().value)
      return vec
    })()
    pending.set(q, task)
    try { return await task } finally { if (pending.get(q) === task) pending.delete(q) }
  }

  // 文字与向量的摘要用于校验，两个文件写到一半就中断时不会误认成有效的旧向量。
  function validItem(it) {
    if (!it || it.invalidAt) return false
    const v = data.items[it.id]
    const proof = meta.items[it.id]
    const text = String(it.text || '')
    if (v === undefined || proof === undefined) { verified.delete(it.id); return false }
    const known = verified.get(it.id)
    if (known && known.vec === v && known.proof === proof && known.text === text && known.dims === data.dims) return known.valid
    const valid = data.dims > 0 && validVector(v, data.dims) && proof === stamp(text, v)
    verified.set(it.id, { vec: v, proof, text, dims: data.dims, valid, norm: valid ? norm(v) : 0 })
    return valid
  }

  function validIds(items) {
    if (!prepare()) return []
    return (items || []).filter(validItem).map((it) => it.id)
  }

  // 关闭开关后仍能在面板看到本机已经同步的条数。
  function count(items) {
    const c = getConfig()?.memory?.vector
    const base = String(c?.baseUrl || '').trim().replace(/\/+$/, '').replace(/\/embeddings\/?$/i, '')
    const model = String(c?.model || '').trim()
    if (!base || !model) return 0
    load()
    if (data.model !== model || meta.model !== model || meta.base !== hash(base)) return 0
    return (items || []).filter(validItem).length
  }

  function search(vec, ids, limit = 6) {
    if (!prepare() || !validVector(vec, data.dims)) return []
    const queryNorm = norm(vec)
    const hits = []
    for (const id of ids || []) {
      const v = data.items[id]
      const known = verified.get(id)
      const checked = known?.valid && known.vec === v && known.dims === data.dims && known.proof === meta.items[id]
      if (!checked && !validVector(v, vec.length)) continue
      let dot = 0
      for (let i = 0; i < vec.length; i++) dot += vec[i] * v[i]
      const similarity = dot / (queryNorm * (checked ? known.norm : norm(v)))
      if (Number.isFinite(similarity)) hits.push({ id, similarity })
    }
    return hits.sort((a, b) => b.similarity - a.similarity).slice(0, Math.max(0, limit))
  }

  function save() {
    writeJson(file(), data)
    writeJson(metaFile(), meta)
    needsSave = false
  }

  function prune(items) {
    const live = new Map((items || []).filter((it) => it && it.id && !it.invalidAt).map((it) => [it.id, it]))
    let changed = false
    for (const id of Object.keys(data.items)) {
      const it = live.get(id)
      if (!validItem(it)) {
        delete data.items[id]
        delete meta.items[id]
        verified.delete(id)
        changed = true
      }
    }
    for (const id of Object.keys(meta.items)) if (!data.items[id]) { delete meta.items[id]; changed = true }
    return changed
  }

  async function sync(items, latest = () => items) {
    if (syncing) return syncing
    const c = prepare()
    if (!c) return
    syncing = (async () => {
      try {
        const changed = prune(items)
        if (changed) needsSave = true
        if (needsSave) save()
        const batch = (items || []).filter((it) => it && it.id && !it.invalidAt && String(it.text || '').trim() && !data.items[it.id]).slice(0, c.batchSize).map((it) => ({ id: it.id, text: it.text }))
        if (!batch.length) return
        const vectors = await embed(batch.map((it) => it.text))
        if (vectors.length !== batch.length || !current(c)) return
        const live = new Map((latest() || []).filter((it) => it && !it.invalidAt).map((it) => [it.id, it]))
        prune([...live.values()])
        data.dims = vectors[0].length
        for (let i = 0; i < batch.length; i++) {
          const it = batch[i]
          if (live.get(it.id)?.text !== it.text) continue
          data.items[it.id] = vectors[i]
          meta.items[it.id] = stamp(it.text, vectors[i])
        }
        needsSave = true
        save()
      } catch (error) {
        log?.debug?.('向量索引同步失败，稍后再试')
      }
    })()
    try { await syncing } finally { syncing = null }
  }

  /** 面板用：已同步多少 / 一共多少、模型、维度和最后一次错误。 */
  function status(items) {
    const c = settings()
    const cfg = getConfig()?.memory?.vector || {}
    load()
    return {
      enabled: Boolean(cfg.enabled),
      configured: Boolean(c),
      provider: String(cfg.provider || ''),
      model: c?.model || String(cfg.model || ''),
      dims: data?.dims || 0,
      indexed: c ? count(items) : 0,
      total: (items || []).filter((it) => it && !it.invalidAt).length,
      lastError,
    }
  }

  /** 面板「测试」：真发一条短文本，返回维度，不写进索引。 */
  async function test(text = '今天想吃白米饭') {
    const t = Date.now()
    const [vec] = await embed([String(text || '测试')])
    if (!vec) throw new Error(lastError || '没有返回向量（检查地址、模型和 Key）')
    return { dims: vec.length, ms: Date.now() - t }
  }

  /** 清空本机向量，下一次 tick / rebuild 会按当前记忆重新同步。 */
  function reset() {
    const c = prepare()
    if (!c) return false
    data = { model: c.model, dims: 0, items: Object.create(null) }
    meta = { model: c.model, base: hash(c.baseUrl), items: Object.create(null) }
    verified.clear()
    cache.clear()
    needsSave = true
    save()
    return true
  }

  return { embed, queryVector, search, sync, validIds, count, status, test, reset }
}

/**
 * 按配置挑一个向量实现，没开就返回 null（上层自动退回纯关键词）。
 *
 * 模式判定（要兼容老配置）：
 *   mode === 'remote'            → 在线服务
 *   mode === 'local'             → 本地模型
 *   mode 没写、但填了 baseUrl     → 老配置，按原来的在线服务跑（不然升级后向量直接断）
 *   mode 没写、也没填 baseUrl     → 新装用户，用本地模型
 */
export function createVectorIndexByMode({ getConfig, log, fetchImpl = globalThis.fetch }) {
  const memory = getConfig()?.memory
  const c = memory?.vector
  if (memory?.enabled === false || c?.enabled !== true) return null
  const hasBase = Boolean(String(c.baseUrl || '').trim())
  const mode = c.mode === 'remote' || c.mode === 'local'
    ? c.mode
    : (hasBase ? 'remote' : 'local')
  if (mode === 'local') {
    try {
      const idx = createLocalVectorIndex({ dataDir: dataDir(), log })
      if (!idx.ready || !idx.ready()) {
        // 本地模型还没装好时，如果老配置里有在线服务，就先用它，别把用户的向量检索弄没
        if (hasBase) return createVectorIndex({ getConfig, log, fetchImpl })
        log?.debug?.('本地向量不可用：' + (idx.error || '模型未就绪') + '，这次只走关键词')
        return null
      }
      return idx
    } catch (error) {
      log?.warn?.('本地向量初始化失败，退回关键词检索：' + error.message)
      return hasBase ? createVectorIndex({ getConfig, log, fetchImpl }) : null
    }
  }
  return createVectorIndex({ getConfig, log, fetchImpl })
}
