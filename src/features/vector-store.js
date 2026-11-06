// 本地向量存储：id → 归一化 float 向量，存成 JSON（base64），内存里暴力点积。
// 每条记一个签名（条目改写时间），用来判断要不要重算；换模型就整库重算。
// 从「记忆（向量版）」模块移植过来，接口按 core 的 memory-vector.js 对齐。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const b64 = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64')
const unb64 = (s) => {
  const buf = Buffer.from(s, 'base64')
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

export function createVecStore(file, { model = 'bge-small-zh-v1.5-int8' } = {}) {
  let data = { model, dim: 0, items: {}, sigs: {}, updatedAt: 0 }
  let dirty = false

  function load() {
    try {
      if (!existsSync(file)) return
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      // 模型换了（或文件被人手改过）就整库不用，等上层重算
      if (raw && raw.model === model) data = { ...data, ...raw, sigs: raw.sigs || {} }
    } catch (error) {}
  }

  function save() {
    if (!dirty) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ ...data, updatedAt: Date.now() }))
      dirty = false
    } catch (error) {}
  }

  load()

  return {
    get size() {
      return Object.keys(data.items).length
    },
    get dim() {
      return data.dim || 0
    },
    has: (id) => Boolean(data.items[id]),
    sigOf: (id) => data.sigs[id] || '',
    /** 只读：库里有向量的 id 列表（给扩展做关联用） */
    ids: () => Object.keys(data.items),
    /** 只读：取某条的向量（Float32Array），没有就 undefined */
    get: (id) => {
      const s = data.items[id]
      return s ? unb64(s) : undefined
    },
    put(id, vec, sig = '') {
      data.items[id] = b64(vec)
      data.sigs[id] = String(sig || '')
      data.dim = vec.length
      dirty = true
    },
    keep(ids) {
      const set = new Set(ids)
      let changed = false
      for (const id of Object.keys(data.items)) {
        if (!set.has(id)) {
          delete data.items[id]
          delete data.sigs[id]
          changed = true
        }
      }
      if (changed) dirty = true
      return changed
    },
    flush: save,
    /** 暴力点积（都已归一化，点积就是余弦），返回 [{ id, sim }] 降序 */
    topK(vec, k = 8, filter) {
      const out = []
      for (const [id, s] of Object.entries(data.items)) {
        if (filter && !filter(id)) continue
        const v = unb64(s)
        if (v.length !== vec.length) continue
        let dot = 0
        for (let i = 0; i < v.length; i++) dot += v[i] * vec[i]
        out.push({ id, sim: dot })
      }
      out.sort((a, b) => b.sim - a.sim)
      return out.slice(0, k)
    },
  }
}
