// 实验性语义索引：向量存在本机，文字只发给用户配置的 embedding 服务。
import { createHash } from 'node:crypto'
import { dataDir, readJson, writeJson } from '../core/store.js'

const BATCH = 32
const QUERY_TIMEOUT = 2000
const SYNC_TIMEOUT = 30_000
const COOLDOWN = 10 * 60_000
const CACHE_TTL = 5 * 60_000
const hash = (s) => createHash('sha256').update(s).digest('hex')
const stamp = (text, vec) => hash(JSON.stringify([String(text || ''), vec]))
const validVector = (v, dims) => Array.isArray(v) && v.length > 0 && (!dims || v.length === dims) && v.every((n) => typeof n === 'number' && Number.isFinite(n)) && v.some((n) => n !== 0)

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
    const baseUrl = String(c.baseUrl || '').trim().replace(/\/+$/, '')
    const model = String(c.model || '').trim()
    if (!baseUrl || !model) return null
    try {
      const url = new URL(baseUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
    } catch (error) { return null }
    return { baseUrl, model, apiKey: String(c.apiKey || '') }
  }

  function prepare() {
    const c = settings()
    if (!c) return null
    load()
    const key = JSON.stringify([c.baseUrl, c.model, c.apiKey])
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
    return next && c.generation === generation && JSON.stringify([next.baseUrl, next.model, next.apiKey]) === c.key
  }

  function failed(c) {
    if (!current(c)) return
    failures++
    if (failures >= 3) retryAt = Date.now() + COOLDOWN
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
        const headers = { 'Content-Type': 'application/json' }
        if (c.apiKey) headers.Authorization = `Bearer ${c.apiKey}`
        const input = texts.map((text) => String(text || ''))
        const response = await fetchImpl(`${c.baseUrl}/embeddings`, { method: 'POST', headers, body: JSON.stringify({ model: c.model, input }), signal: controller.signal, redirect: 'error' })
        if (!response.ok) throw new Error('请求失败')
        const json = await response.json()
        if (!current(c)) return []
        if (!Array.isArray(json?.data) || json.data.length !== texts.length) throw new Error('向量数量不符')
        const rows = [...json.data]
        if (rows.every((row) => Number.isInteger(row?.index))) {
          rows.sort((a, b) => a.index - b.index)
          if (rows.some((row, i) => row.index !== i)) throw new Error('向量顺序不符')
        }
        const vectors = rows.map((row) => row?.embedding)
        const dims = data.dims || vectors[0]?.length
        if (!vectors.every((v) => validVector(v, dims))) throw new Error('向量无效')
        return vectors
      }
      const vectors = await Promise.race([work(), new Promise((resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('请求超时')) }, timeout)
      })])
      if (!current(c) || Date.now() < retryAt) return []
      if (!vectors.every((v) => validVector(v, data.dims))) throw new Error('向量维度已变化')
      failures = 0
      retryAt = 0
      return vectors
    } catch (error) {
      failed(c)
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
      const [vec] = await request([q], QUERY_TIMEOUT)
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
    const base = String(c?.baseUrl || '').trim().replace(/\/+$/, '')
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
        const batch = (items || []).filter((it) => it && it.id && !it.invalidAt && String(it.text || '').trim() && !data.items[it.id]).slice(0, BATCH).map((it) => ({ id: it.id, text: it.text }))
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

  return { embed, queryVector, search, sync, validIds, count }
}
