// 本地向量索引：对外暴露和 core 的 memory-vector.js 同样的 6 个接口
// (embed / queryVector / search / sync / validIds / count)，这样上层代码不用改。
//
// 设计要点：
//   - onnxruntime-node 是可选依赖：没装就 ready() 返回 false，上层自动降级成关键词
//   - 模型和向量库都在 dataDir 下，与「在线服务」模式的 memory-vectors.json 互不干扰
//   - sync 只重算新增/改写的条目（靠 sig 比对），不整库重算

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createVecStore } from './vector-store.js'
import { createEmbedder } from './vector-embed.js'

export const LOCAL_MODEL = 'bge-small-zh-v1.5-int8'

// 大库保护：一次 sync 最多算这么多条，剩下的留到下次 tick；
// 每算 BATCH 条让出一次事件循环，别把聊天卡住。
const SYNC_MAX_PER_RUN = 300
const BATCH = 10

/**
 * 模型文件可能放在这几个位置，依次找：
 *   1. 数据目录的 models/（自动下载存这儿，用户换模型也放这儿）
 *   2. 数据目录的 memory-assets/（旧路径）
 *   3. 插件自带的 models/（开发者本地或离线安装时放这儿）
 */
export function resolveAssets(dataDir) {
  const here = fileURLToPath(new URL('../../models', import.meta.url))
  const cands = [
    join(dataDir, 'models'),
    join(dataDir, 'memory-assets'),
    here,
  ]
  for (const dir of cands) {
    if (existsSync(join(dir, 'model_int8.onnx')) && existsSync(join(dir, 'vocab.txt'))) return dir
  }
  return null
}

export function createLocalVectorIndex({ dataDir, log }) {
  const file = join(dataDir, 'local-vectors.json')
  const store = createVecStore(file, { model: LOCAL_MODEL })
  let assets = resolveAssets(dataDir)
  let embedder = assets ? createEmbedder(assets) : null

  // 模型随插件一起发布（仓库 models/ 目录，package.json 的 files 已包含它），
  // **不再联网自动下载**。早期版本去 GitHub Release 拉 assets，但那个 Release
  // 从来没有上传过资源（实测 404），只会让面板一直显示「下载失败」。
  // 现在模型不在时直接给一句能看懂的说明，让人知道该把文件放哪。
  let lastError = assets ? '' : '本地向量模型缺失：models/ 目录里应该有 model_int8.onnx 和 vocab.txt（插件包自带；手动安装时把它们放进数据目录的 models/ 也可以）'

  // 条目签名：文字 + 改写时间，变了就重算
  /**
   * 条目签名：文字内容 + 改写时间，变了就重算。
   * 注意必须用文字本身的哈希，不能用长度——「主人喜欢吃辣」改成
   * 「主人讨厌吃辣」长度一样，只比长度会漏掉，检索到的还是旧语义。
   */
  const sigOfItem = (m) => {
    const text = String(m.text || '')
    let h = 2166136261
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return `${m.at || 0}|${text.length}|${(h >>> 0).toString(36)}`
  }

  function ready() {
    if (!embedder) return false
    // 必须真探一下运行时：createEmbedder 是懒加载的，只看 embedder.error 会得到空字符串，
    // 于是 onnxruntime-node 没装也报告「就绪」，面板显示打开却算不出向量。
    if (typeof embedder.probe === 'function') {
      const why = embedder.probe()
      if (why) { lastError = why; return false }
    } else if (embedder.error) return false
    return true
  }

  /**
   * 重新查一次模型目录。
   * 不做联网下载（以前那个 Release 地址是 404，assets 一直是空的）：
   * 只重新扫一遍磁盘，用户把模型文件放进去之后下次 tick 就能用上。
   */
  async function ensureModel() {
    if (ready()) return true
    const dir = resolveAssets(dataDir)
    if (!dir) return false
    assets = dir
    embedder = createEmbedder(assets)
    lastError = embedder.error || ''
    return ready()
  }

  async function embed(texts) {
    // 第一次真正要算向量时，如果模型还没下好就先去下载
    if (!ready() && !(await ensureModel())) throw new Error(lastError || '本地向量不可用')
    const list = Array.isArray(texts) ? texts : [texts]
    const out = []
    for (const t of list) {
      try {
        out.push(await embedder.embed(t))
      } catch (error) {
        lastError = error.message
        throw error
      }
    }
    return out
  }

  async function queryVector(text) {
    const [vec] = await embed([text])
    return vec
  }

  function search(vec, ids, limit = 6) {
    if (!vec) return []
    const allow = ids ? new Set(ids) : null
    // 上层偶尔会把 Set 当 limit 传进来（Set 没有 length，拿到的会是 undefined）。
    // 这里兜底成「尽量多」，否则一次向量检索会被截成 0 条，语义检索等于没开。
    const want = Number(limit)
    const cap = Number.isFinite(want) && want > 0 ? want : (allow ? allow.size : 200)
    // 字段名对齐在线版（memory-vector.js 用的是 similarity），
    // 上层按 h.similarity 过滤阈值，这里必须是同一个键，否则向量命中会被全部丢掉。
    return store
      .topK(vec, cap, allow ? (id) => allow.has(id) : undefined)
      .map((h) => ({ id: h.id, similarity: h.sim }))
  }

  /**
   * 增量同步：只算新增/改写的。
   * 大库时不能一口气算完（5000 条要 9 秒，会把聊天卡住），所以：
   *   - 每算 BATCH 条就让出一次事件循环
   *   - 每 FLUSH_EVERY 条落一次盘，进程中途被杀也不至于全丢
   *   - 单轮有上限，剩下的留到下次 tick 接着补
   * @returns {Promise<number>} 本次实际算了几条
   */
  async function sync(items, latest = () => items) {
    // 后台 tick 也会走到这儿：模型没下好就先拉一次，这次没拉到就等下一轮
    if (!ready() && !(await ensureModel())) return 0
    // 空文本不索引：算出来的向量所有空文本都一样（等于噪声），
    // 留着只会在检索时干扰排序。记忆本身在 add() 里已经拒绝空文本，
    // 这里是给脏数据/历史条目兜底。
    const live = (Array.isArray(items) ? items : [])
      .filter((m) => m && m.id && !m.invalidAt && String(m.text || '').trim())
    // 记忆被删/被合并时，向量跟着走
    const pruned = store.keep(live.map((m) => String(m.id)))
    let computed = 0
    let dirty = pruned
    for (const m of live) {
      if (computed >= SYNC_MAX_PER_RUN) break
      const id = String(m.id)
      const sig = sigOfItem(m)
      if (store.has(id) && store.sigOf(id) === sig) continue
      try {
        const vec = await embedder.embed(String(m.text || ''))
        store.put(id, vec, sig)
        computed++
        dirty = true
      } catch (error) {
        lastError = error.message
        break
      }
      // 让出事件循环，别把聊天/面板卡死
      if (computed % BATCH === 0) {
        if (dirty) {
          store.flush()
          dirty = false
        }
        await new Promise((r) => setImmediate(r))
      }
    }
    // 只删了孤儿向量（没重算任何条目）时也要落盘，否则库里会留着无效 id
    if (dirty) store.flush()
    return computed
  }

  /**
   * 和在线版 memory-vector.js 的契约保持一致：**返回数组**（不是 Set）。
   * 上层 memory.js 用 `.length` 判空、把返回值当 limit 传给 search，
   * 返回 Set 会让这两个用法全部失效（Set 没有 length → 永远判空 → 语义检索等于没开）。
   */
  function validIds(items) {
    const list = Array.isArray(items) ? items : []
    return list.filter((m) => m && m.id && store.has(String(m.id))).map((m) => String(m.id))
  }

  function count(items) {
    if (!Array.isArray(items)) return store.size
    return items.filter((m) => m && m.id && store.has(String(m.id))).length
  }

  /**
   * 给「记忆中枢 / 星图」这类扩展用的只读接口：返回 id → Float32Array 的 Map。
   * 只读，不触发任何计算和写盘，多个模块同时调用也不会互相影响。
   */
  function all() {
    const out = new Map()
    for (const id of store.ids()) {
      const v = store.get(id)
      if (v) out.set(id, v)
    }
    return out
  }

  /** 给扩展用：某条记忆最像的几条（只读，不写盘）。 */
  function neighbors(id, k = 4) {
    const v = store.get(String(id))
    if (!v) return []
    return store
      .topK(v, k + 1)
      .filter((h) => h.id !== String(id) && h.sim > 0.45)
      .slice(0, k)
      .map((h) => ({ id: h.id, sim: h.sim }))
  }

  return {
    mode: 'local',
    embed,
    queryVector,
    search,
    sync,
    validIds,
    count,
    all,
    neighbors,
    ready,
    model: LOCAL_MODEL,
    /** 面板看模型状态用：模型在不在、为什么不可用（不再有「下载中」这种状态） */
    modelStatus: () => ({
      present: Boolean(resolveAssets(dataDir)),
      running: false,
      error: lastError || '',
    }),
    /**
     * 与在线版（memory-vector.js）对齐的状态接口。
     * 没有它的话 memory.vectorStatus() 会走兜底分支，返回
     * 「enabled:false、lastError:模型还没就绪」——本地模式下明明可用，
     * 面板却显示没开，点「测试」和「重建索引」都会失败（实测踩到）。
     */
    status: (items) => ({
      ok: true,
      enabled: true,
      configured: Boolean(resolveAssets(dataDir)),
      mode: 'local',
      provider: 'local',
      model: LOCAL_MODEL,
      dims: 0,
      indexed: count(items),
      total: Array.isArray(items) ? items.length : store.size,
      ready: ready(),
      lastError: lastError || '',
    }),
    /** 面板「测试」按钮：真算一条，回报维度和耗时。 */
    test: async (text) => {
      if (!ready()) return { ok: false, message: lastError || '本地向量不可用' }
      const t0 = Date.now()
      const vec = await queryVector(String(text || '今天想吃白米饭'))
      return { ok: true, mode: 'local', model: LOCAL_MODEL, dims: vec.length, ms: Date.now() - t0 }
    },
    get error() {
      return lastError
    },
  }
}
