// Reranker：配置收敛、OpenAI 兼容 /rerank 请求、排序、失败回退。全部假 fetch，不联网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize, publicConfig } from '../src/core/config.js'
import { createReranker } from '../src/features/rerank.js'

const log = { info() {}, warn() {}, debug() {} }
const hits = () => [
  { it: { id: 'a', text: '主人喜欢吃白米饭' }, score: 1 },
  { it: { id: 'b', text: '主人养了一只猫' }, score: 0.9 },
  { it: { id: 'c', text: '今天天气很好' }, score: 0.8 },
]

test('默认关闭；地址/Key 留空时复用向量服务', () => {
  const cfg = normalize({ memory: { vector: { baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk-v' }, rerank: { enabled: true } } })
  assert.equal(cfg.memory.rerank.model, 'BAAI/bge-reranker-v2-m3')
  const r = createReranker({ getConfig: () => cfg, log })
  const s = r.settings()
  assert.equal(s.baseUrl, 'https://api.siliconflow.cn/v1')
  assert.equal(s.apiKey, 'sk-v')
  assert.equal(s.topN, 20)
  assert.equal(s.timeoutMs, 2000)
  const full = normalize({ memory: { vector: { baseUrl: 'https://api.siliconflow.cn/v1/embeddings', apiKey: 'sk-v' }, rerank: { enabled: true } } })
  assert.equal(createReranker({ getConfig: () => full, log }).settings().baseUrl, 'https://api.siliconflow.cn/v1')
  assert.equal(createReranker({ getConfig: () => normalize({}), log }).configured(), false)
})

test('重排 Key 在面板不回显', () => {
  const cfg = normalize({ memory: { rerank: { enabled: true, apiKey: 'sk-r-secret' } } })
  const pub = publicConfig(cfg)
  assert.equal(pub.memory.rerank.apiKey, '')
  assert.equal(pub.memory.rerank.apiKeySet, true)
  assert.equal(JSON.stringify(pub).includes('sk-r-secret'), false)
})

test('按服务端分数重排，只送 topN 候选；带 Authorization', async () => {
  const cfg = normalize({ memory: { rerank: { enabled: true, baseUrl: 'https://api.example/v1', model: 'r', apiKey: 'sk-r', topN: 3 } } })
  const calls = []
  const fake = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, text: async () => JSON.stringify({ results: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.8 }, { index: 1, relevance_score: 0.1 }] }) }
  }
  const r = createReranker({ getConfig: () => cfg, log, fetchImpl: fake })
  const out = await r.rank('今天吃什么', hits())
  assert.deepEqual(out.map((x) => x.it.id), ['c', 'a', 'b'])
  assert.equal(calls[0].url, 'https://api.example/v1/rerank')
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-r')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, 'r')
  assert.equal(body.query, '今天吃什么')
  assert.equal(body.documents.length, 3)
  assert.equal(body.return_documents, false)
})

test('HTTP 失败抛错；调用方回退原顺序（这里验证错误信息不泄露 Key）', async () => {
  const cfg = normalize({ memory: { rerank: { enabled: true, baseUrl: 'https://api.example/v1', model: 'r', apiKey: 'sk-secret' } } })
  const r = createReranker({ getConfig: () => cfg, log, fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'Token is invalid' }) })
  await assert.rejects(r.rank('q', hits()), /HTTP 401/)
  await assert.rejects(r.test('q'), (e) => !String(e.message).includes('sk-secret'))
})

test('候选不足两条不发请求', async () => {
  const cfg = normalize({ memory: { rerank: { enabled: true, baseUrl: 'https://api.example/v1', model: 'r' } } })
  let called = 0
  const r = createReranker({ getConfig: () => cfg, log, fetchImpl: async () => { called++; throw new Error('no') } })
  const one = await r.rank('q', hits().slice(0, 1))
  assert.equal(one.length, 1)
  assert.equal(called, 0)
})
