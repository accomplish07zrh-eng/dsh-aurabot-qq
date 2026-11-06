// 本地向量化：bge-small-zh-v1.5（int8 ONNX）的分词 + 推理 + L2 归一化。
// 从「记忆（向量版）」模块移植过来。onnxruntime-node 是**可选依赖**：
// 没装就 throw，调用方 catch 后自动降级成关键词检索，不会把整个插件带崩。

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** bge 用 BERT 那套 WordPiece：中文基本一字一个 token，英文按词再拆子词。 */
function buildTokenizer(vocabPath) {
  const vocab = new Map()
  readFileSync(vocabPath, 'utf8')
    .split('\n')
    .forEach((w, i) => {
      const t = w.replace(/\r$/, '')
      if (t || i === 0) vocab.set(t, i)
    })
  const cls = vocab.get('[CLS]') ?? 101
  const sep = vocab.get('[SEP]') ?? 102
  const unk = vocab.get('[UNK]') ?? 100

  function clean(s) {
    let out = ''
    for (const ch of String(s ?? '').normalize('NFD')) {
      if (/[\u0300-\u036f]/.test(ch)) continue
      const c = ch.toLowerCase()
      if (/\s/.test(c)) out += ' '
      else if (/[\u4e00-\u9fff]/.test(c)) out += ` ${c} `
      else if (/[\p{L}\p{N}]/u.test(c)) out += c
      else out += ` ${c} `
    }
    return out.replace(/\s+/g, ' ').trim()
  }

  function pieces(tok) {
    if (vocab.has(tok)) return [vocab.get(tok)]
    const out = []
    let start = 0
    while (start < tok.length) {
      let end = tok.length
      let hit = null
      while (start < end) {
        const piece = (start > 0 ? '##' : '') + tok.slice(start, end)
        if (vocab.has(piece)) {
          hit = vocab.get(piece)
          break
        }
        end -= 1
      }
      if (hit == null) return [unk]
      out.push(hit)
      start = end
    }
    return out
  }

  return function encode(text, maxLen = 256) {
    const ids = [cls]
    for (const tok of clean(text).split(' ')) {
      if (!tok) continue
      for (const id of pieces(tok)) {
        ids.push(id)
        if (ids.length >= maxLen - 1) break
      }
      if (ids.length >= maxLen - 1) break
    }
    ids.push(sep)
    return ids
  }
}

export function createEmbedder(assetsDir) {
  let tokenizer = null
  let session = null
  let loading = null
  let dim = 512
  let failed = ''

  /**
   * 同步探测运行时能不能用（不加载模型，只看 onnxruntime-node 装没装）。
   * ready() 必须靠它：createEmbedder 是懒加载的，不主动探一下的话
   * embedder.error 永远是空的，面板就会显示「已就绪」、
   * 结果真正算向量时才抛「运行时没装好」——用户看到的是「开着但没效果」。
   */
  function probe() {
    if (failed) return failed
    try {
      require('onnxruntime-node')
      return ''
    } catch (error) {
      failed = '向量运行时没装好（onnxruntime-node 装不上时联想不可用，记忆仍按关键词检索）：' + error.message
      return failed
    }
  }

  function tokenizerOf() {
    if (tokenizer) return tokenizer
    tokenizer = buildTokenizer(join(assetsDir, 'vocab.txt'))
    return tokenizer
  }

  async function load() {
    if (session) return session
    if (failed) throw new Error(failed)
    if (!loading) {
      loading = (async () => {
        let ort
        try {
          ort = require('onnxruntime-node')
        } catch (error) {
          failed = '向量运行时没装好：' + error.message
          throw new Error(failed)
        }
        const modelPath = join(assetsDir, 'model_int8.onnx')
        if (!existsSync(modelPath)) {
          failed = '找不到向量模型：' + modelPath
          throw new Error(failed)
        }
        session = await ort.InferenceSession.create(modelPath, {
          intraOpNumThreads: 2,
          graphOptimizationLevel: 'all',
        })
        session._ort = ort
        return session
      })()
    }
    return loading
  }

  async function embed(text) {
    const s = await load()
    const ort = s._ort
    const ids = tokenizerOf()(text)
    const big = (arr) => new ort.Tensor('int64', BigInt64Array.from(arr, (v) => BigInt(v)), [1, arr.length])
    const out = await s.run({
      input_ids: big(ids),
      attention_mask: big(ids.map(() => 1)),
      token_type_ids: big(ids.map(() => 0)),
    })
    const first = out[Object.keys(out)[0]]
    const v = Float32Array.from(first.data)
    // 输出是 [1, 序列长度, 512]；取最后一维，别拿 v.length / ids.length 去推
    const dims = Array.isArray(first.dims) ? first.dims : []
    dim = Number(dims[dims.length - 1]) || 512
    // bge 官方用法：取 [CLS] 那一位，再 L2 归一化
    const pooled = new Float32Array(dim)
    let norm = 0
    for (let d = 0; d < dim; d++) {
      pooled[d] = v[d]
      norm += pooled[d] * pooled[d]
    }
    norm = Math.sqrt(norm) || 1
    for (let d = 0; d < dim; d++) pooled[d] /= norm
    return pooled
  }

  return {
    embed,
    // 同步探测运行时（不加载模型）；ready() 用它，避免「显示就绪、一算就失败」
    probe,
    get error() {
      return failed
    },
    get dim() {
      return dim
    },
  }
}
