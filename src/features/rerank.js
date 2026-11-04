// 检索精排：只对已经通过权限/范围过滤的候选做 query-document 打分。
// 统一走 OpenAI 兼容的 POST {baseUrl}/rerank（硅基 BAAI/bge-reranker-v2-m3 免费）。
// 失败 / 超时一律由调用方回退原顺序，绝不阻塞回复。

const DEFAULT_BASE = 'https://api.siliconflow.cn/v1'
const DEFAULT_MODEL = 'BAAI/bge-reranker-v2-m3'

function clamp(n, min, max, fallback) {
  const v = Number(n)
  return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback
}

export function createReranker({ getConfig, log, fetchImpl = globalThis.fetch }) {
  function settings() {
    const memory = getConfig().memory || {}
    const c = memory.rerank
    if (!c || !c.enabled) return null
    const vector = memory.vector || {}
    const baseUrl = String(c.baseUrl || vector.baseUrl || DEFAULT_BASE).trim().replace(/\/+$/, '').replace(/\/embeddings\/?$/i, '').replace(/\/rerank\/?$/i, '')
    const model = String(c.model || DEFAULT_MODEL).trim()
    const apiKey = String(c.apiKey || vector.apiKey || '').trim()
    if (!baseUrl || !model) return null
    try {
      const u = new URL(baseUrl)
      if (!['http:', 'https:'].includes(u.protocol)) return null
    } catch (error) { return null }
    return {
      baseUrl,
      model,
      apiKey,
      topN: Math.round(clamp(c.topN, 2, 50, 20)),
      timeoutMs: Math.round(clamp(c.timeoutMs, 500, 10_000, 2000)),
    }
  }

  function configured() {
    return Boolean(settings())
  }

  async function rank(query, hits) {
    const c = settings()
    if (!c || !Array.isArray(hits) || hits.length < 2) return hits
    const candidates = hits.slice(0, c.topN)
    const documents = candidates.map((h) => String(h?.it?.text || '').slice(0, 1200))
    const usable = documents.map((d, i) => ({ d, i })).filter((x) => x.d)
    if (usable.length < 2) return hits
    const headers = { 'content-type': 'application/json' }
    if (c.apiKey) headers.authorization = `Bearer ${c.apiKey}`
    const r = await fetchImpl(`${c.baseUrl}/rerank`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: c.model,
        query: String(query || '').slice(0, 1200),
        documents: usable.map((x) => x.d),
        top_n: usable.length,
        return_documents: false,
      }),
      signal: AbortSignal.timeout(c.timeoutMs),
      redirect: 'error',
    })
    const raw = await r.text()
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    let json
    try { json = JSON.parse(raw) } catch (error) { throw new Error('重排服务返回的不是 JSON') }
    const rows = Array.isArray(json?.results) ? json.results : []
    if (!rows.length) return hits
    const scored = []
    const seen = new Set()
    for (const row of rows) {
      const at = Number(row?.index)
      const original = usable[at]
      if (!original || seen.has(original.i)) continue
      const score = Number(row?.relevance_score)
      if (!Number.isFinite(score)) continue
      seen.add(original.i)
      scored.push({ ...candidates[original.i], rerankScore: score, rerankAt: original.i })
    }
    if (scored.length < 2) return hits
    // 分数相同保持原顺序（稳定排序靠原始下标）
    scored.sort((a, b) => b.rerankScore - a.rerankScore || a.rerankAt - b.rerankAt)
    return scored
  }

  async function test(text = '主人喜欢吃什么') {
    const c = settings()
    if (!c) throw new Error('没开启重排（Reranker）')
    const docs = ['主人喜欢吃白米饭', '主人养了一只猫', '今天天气很好']
    const r = await fetchImpl(`${c.baseUrl}/rerank`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}) },
      body: JSON.stringify({ model: c.model, query: String(text || '测试'), documents: docs, top_n: docs.length, return_documents: false }),
      signal: AbortSignal.timeout(c.timeoutMs),
      redirect: 'error',
    })
    const raw = await r.text()
    if (!r.ok) throw new Error(`HTTP ${r.status}：${raw.slice(0, 120)}`)
    let json
    try { json = JSON.parse(raw) } catch (error) { throw new Error('重排服务返回的不是 JSON') }
    const rows = Array.isArray(json?.results) ? json.results : []
    if (!rows.length) throw new Error('没返回排序结果')
    return { model: c.model, top: rows[0]?.index ?? -1, score: Number(rows[0]?.relevance_score) || 0 }
  }

  return { settings, configured, rank, test }
}
