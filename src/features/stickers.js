// 表情库：偷表情（严格判定 + 尺寸兜底 + MD5 去重 + 每小时限额）→ 收藏到 QQ → 视觉模型起备注；
// 发送时按备注 / 标签模糊匹配。本地库：~/.dsh/plugins-data/aurabot/stickers/

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir, readJson, writeJson } from '../core/store.js'
import { imageSize, mimeOf, stickerSizeOk } from '../chat/inbound.js'
import { segmentBytes, fetchImage } from '../core/net.js'
import { askModel, canSeeImages } from '../core/llm.js'

const dir = () => dataDir('stickers')
const indexFile = () => join(dir(), 'index.json')
const ext = (mime) => ({ 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' })[mime] || 'jpg'

export const DEFAULT_TAGS = ['开心', '卖萌', '生气', '委屈', '无语', '嘲讽', '疑惑', '早晚安']

export function loadLibrary() {
  return readJson(indexFile(), () => ({ items: [] }))
}

function saveLibrary(lib) {
  writeJson(indexFile(), lib)
}

export function stickerPath(item) {
  return join(dir(), item.file)
}

/** 模糊匹配：备注 / 标签里包含关键词得分高；完全找不到返回 null。 */
export function matchSticker(items, query) {
  const q = String(query || '').trim()
  if (!q || !items.length) return null
  let best = null
  let bestScore = 0
  for (const it of items) {
    const hay = [it.name || '', ...(it.tags || [])]
    let s = 0
    for (const h of hay) {
      if (!h) continue
      if (h === q) s = Math.max(s, 10)
      else if (h.includes(q) || q.includes(h)) s = Math.max(s, 6)
      else {
        const common = [...q].filter((c) => h.includes(c)).length
        if (common >= 2) s = Math.max(s, common / Math.max(q.length, 1) * 4)
      }
    }
    if (s > bestScore || (s === bestScore && s > 0 && Math.random() < 0.5)) {
      best = it
      bestScore = s
    }
  }
  return bestScore >= 1.5 ? best : null
}

/** 打了这个标签的表情不参与自动配（太吓人、容易误会的梗图靠手动发）。 */
export const NEVER_RANDOM = '不随机'

/** 自动配表情：先按回复里的词匹配，匹配不到随机挑一张；带「不随机」标签的不参与。 */
export function pickForReply(items, replyText) {
  if (!items.length) return null
  const pool = items.filter((i) => !(i.tags || []).includes(NEVER_RANDOM))
  if (!pool.length) return null // 全被打上标签时，这一轮就不自动配
  const words = DEFAULT_TAGS.concat(pool.flatMap((i) => i.tags || []))
  for (const w of words) {
    if (w && String(replyText).includes(w)) {
      const m = matchSticker(pool, w)
      if (m) return m
    }
  }
  return pool[Math.floor(Math.random() * pool.length)]
}

/** 超过上限时该清掉哪张：只看偷来的，最少被发过的里最老的那张。 */
export function pickEvict(items) {
  // 主人加的、从 QQ 收藏导进来的不清（那些本来就在机器人号的收藏里）
  const pool = items.filter((i) => !['manual', 'panel', 'qq', 'tool'].includes(i.from))
  if (!pool.length) return null
  return pool.slice().sort((a, b) => (a.uses || 0) - (b.uses || 0) || (a.lastUsed || a.at || 0) - (b.lastUsed || b.at || 0))[0]
}

export function createStickerStore({ dsh, getConfig, onebot, log }) {
  const recent = [] // 每小时限额

  /** 面板里给起名单独挑的模型；没挑（或者只填了一半）就返回 null = 跟随聊天用的模型。 */
  function captionModelOf(cfg = getConfig()) {
    const m = cfg && cfg.stickers && cfg.stickers.captionModel
    return m && m.provider && m.model ? { provider: m.provider, model: m.model } : null
  }

  async function caption(buf, mime, hint) {
    try {
      const cfg = getConfig()
      const target = captionModelOf(cfg)
      // 模型看不了图就别硬发：会报错，名字也起不出来
      if ((await canSeeImages(dsh, cfg, target)) === false) {
        log.debug('模型不支持看图，跳过表情起名')
        return { name: '', tags: [], noVision: true }
      }
      const ask = (extra = {}) => askModel(dsh, {
        module: 'stickers',
        cfg,
        ...(target ? { model: target } : {}),
        system: '你给表情包起名字。只输出一行：不超过 12 个字的中文备注，描述这个表情表达的情绪或内容（例如「委屈巴巴的小猫」「得意地叉腰」）。然后空格，再写 1~3 个标签，从这些里挑：' + DEFAULT_TAGS.join('、') + '。格式：备注 #标签1 #标签2',
        text: hint ? `QQ 给的描述是「${hint}」。请看图起名。` : '请看图起名。',
        images: [{ data: buf.toString('base64'), mediaType: mime }],
        // ⚠ 别给太小：模型会先思考，120 这种上限会被思考吃光，正文是空的（实测踩过）
        maxTokens: 1000,
        temperature: 0.2,
        ...extra,
      })
      let text = await ask()
      // 推理模型的思考有时会把预算吃光，正文空着回来（和记忆提炼同一类毛病）：这次先关思考（模型支持的话），
      // 再把预算放大；光放大预算、思考关不掉的话照样吃光。
      if (!text) {
        log.warn('看图起名：模型没给出文字，关掉思考、放大 token 预算重试一次')
        text = await ask({ reasoningEffort: 'off', maxTokens: 2500, temperature: 0.1 })
      }
      if (!text) log.warn('看图起名：重试后仍然没有文字')
      const line = text.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || ''
      const tags = [...line.matchAll(/#\s*([^\s#]+)/g)].map((m) => m[1]).filter((t) => t.length <= 6).slice(0, 3)
      const name = line.replace(/#\s*[^\s#]+/g, '').replace(/[「」"'“”]/g, '').trim().slice(0, 12)
      return { name, tags }
    } catch (error) {
      log.warn('看图起名失败：', error.message)
      return { name: '', tags: [] }
    }
  }

  /** 收一张表情。seg 必须已经过 isStickerSegment 严格判定。 */
  async function collect(seg, from) {
    const cfg = getConfig().stickers
    if (!cfg.enabled || !cfg.collect) return { ok: false, reason: '偷表情关着' }
    const now = Date.now()
    while (recent.length && now - recent[0] > 3600_000) recent.shift()
    if (recent.length >= cfg.maxPerHour) return { ok: false, reason: '这小时收够了' }
    const d = seg.data || {}
    let buf
    try {
      buf = await segmentBytes(seg, onebot, { maxBytes: 1024 * 1024 * 1024 })
    } catch (error) {
      return { ok: false, reason: '下载失败：' + error.message }
    }
    const { width, height } = imageSize(buf)
    if (!stickerSizeOk({ width, height, bytes: buf.length })) return { ok: false, reason: `尺寸不像表情（${width}x${height}，${Math.round(buf.length / 1024)}KB）` }
    const md5 = createHash('md5').update(buf).digest('hex')
    const lib = loadLibrary()
    if (lib.items.some((i) => i.md5 === md5)) return { ok: false, reason: '已经有了' }
    const mime = mimeOf(buf)
    mkdirSync(dir(), { recursive: true })
    const file = `collected-${md5}.${ext(mime)}`
    writeFileSync(join(dir(), file), buf)
    const item = { md5, file, name: '', tags: [], from, at: now, width, height, bytes: buf.length, emojiId: '', summary: String(d.summary || '').replace(/[[\]]/g, '') }
    // 商城表情（QQ 表情商店里的）：存下来的只是一张预览图，原样发回去才会按商城表情播放动画（#31）
    const marketId = String(d.emoji_id ?? d.emojiId ?? '').trim()
    if (marketId) item.market = { emojiId: marketId, packageId: Number(d.emoji_package_id ?? d.emojiPackageId ?? 0) || 0, key: String(d.key ?? '') }
    recent.push(now)
    // 收藏到 QQ
    if (!getConfig().dryRun) {
      try {
        const r = await onebot.call('add_custom_face', { file: 'base64://' + buf.toString('base64') })
        item.emojiId = String(r?.emoji_id || '')
      } catch (error) {
        log.warn('收藏到 QQ 失败（本地已留档）：', error.message)
      }
    }
    lib.items.push(item)
    saveLibrary(lib)
    log.info(`收了一张表情 ${md5.slice(0, 8)}（${width}x${height}）`)
    await trim()
    // 后台起备注，写回 QQ 和本地
    if (getConfig().stickers.caption) {
      caption(buf, mime, item.summary).then(async ({ name, tags }) => {
        const l = loadLibrary()
        const it = l.items.find((i) => i.md5 === md5)
        if (!it) return
        it.name = name || item.summary || '表情'
        it.tags = tags.length ? tags : it.tags
        saveLibrary(l)
        if (it.emojiId && it.name) {
          try { await onebot.call('modify_custom_face', { emoji_id: it.emojiId, desc: it.name.slice(0, 20) }) } catch (error) { log.warn('写回 QQ 备注失败：', error.message) }
        }
        log.info(`表情 ${md5.slice(0, 8)} 起名「${it.name}」${it.tags.length ? ' #' + it.tags.join(' #') : ''}`)
      }).catch((error) => log.warn('表情起名收尾出错：', error.message))
    }
    return { ok: true, item }
  }

  /** 手动添加（工具 / 面板上传）。 */
  async function addFromBuffer(buf, { name = '', tags = [], from = 'manual', toQQ = true } = {}) {
    const md5 = createHash('md5').update(buf).digest('hex')
    const lib = loadLibrary()
    const exist = lib.items.find((i) => i.md5 === md5)
    if (exist) return { ok: true, item: exist, existed: true }
    const mime = mimeOf(buf)
    if (!mime.startsWith('image/')) return { ok: false, reason: '不是图片' }
    mkdirSync(dir(), { recursive: true })
    const file = `manual-${md5}.${ext(mime)}`
    writeFileSync(join(dir(), file), buf)
    const { width, height } = imageSize(buf)
    const item = { md5, file, name: String(name).slice(0, 12), tags, from, at: Date.now(), width, height, bytes: buf.length, emojiId: '' }
    if (toQQ && !getConfig().dryRun) {
      try {
        const r = await onebot.call('add_custom_face', { file: 'base64://' + buf.toString('base64') })
        item.emojiId = String(r?.emoji_id || '')
        if (item.emojiId && item.name) await onebot.call('modify_custom_face', { emoji_id: item.emojiId, desc: item.name })
      } catch (error) {
        log.warn('收藏到 QQ 失败（本地已留档）：', error.message)
      }
    }
    lib.items.push(item)
    saveLibrary(lib)
    return { ok: true, item }
  }

  /** 表情库超过上限就清掉最少用的（QQ 收藏表情有数量上限，满了就收不进去了）。 */
  async function trim() {
    const max = getConfig().stickers.maxLibrary
    for (let guard = 0; guard < 20; guard++) {
      const items = loadLibrary().items
      if (items.length <= max) return
      const out = pickEvict(items)
      if (!out) return
      log.info(`表情库满了（上限 ${max}），清掉一张不常用的：${out.name || out.md5.slice(0, 8)}`)
      await remove(out.md5)
    }
  }

  /** 发出去一次：记下来，常用的不会被清掉。 */
  function markUsed(md5) {
    const lib = loadLibrary()
    const it = lib.items.find((i) => i.md5 === md5)
    if (!it) return
    it.uses = (it.uses || 0) + 1
    it.lastUsed = Date.now()
    saveLibrary(lib)
  }

  async function remove(md5, { fromQQ = true } = {}) {
    const lib = loadLibrary()
    const it = lib.items.find((i) => i.md5 === md5)
    if (!it) return { ok: false, reason: '没有这张' }
    if (fromQQ && it.emojiId) {
      try { await onebot.call('delete_custom_face', { emoji_id: it.emojiId }) } catch (error) { log.warn('从 QQ 收藏里删除失败：', error.message) }
    }
    try { unlinkSync(join(dir(), it.file)) } catch (error) {}
    lib.items = lib.items.filter((i) => i.md5 !== md5)
    saveLibrary(lib)
    return { ok: true }
  }

  /** 一次删一批：面板多选后一键删掉。fromQQ = 连 QQ 收藏里的那张一起删。 */
  async function removeMany(md5s, { fromQQ = true } = {}) {
    const list = [...new Set((Array.isArray(md5s) ? md5s : []).map((x) => String(x || '').trim()).filter(Boolean))]
    if (!list.length) return { ok: false, removed: 0, message: '没选表情' }
    const found = loadLibrary().items.filter((i) => list.includes(i.md5))
    if (!found.length) return { ok: false, removed: 0, message: '这些表情已经不在库里了' }
    let qqFailed = 0
    if (fromQQ && !getConfig().dryRun) {
      for (const it of found) {
        if (!it.emojiId) continue
        try { await onebot.call('delete_custom_face', { emoji_id: it.emojiId }) } catch (error) { qqFailed++; log.warn('从 QQ 收藏里删除失败：', error.message) }
      }
    }
    for (const it of found) { try { unlinkSync(join(dir(), it.file)) } catch (error) {} }
    const gone = new Set(found.map((i) => i.md5))
    // 重新读一遍再写：后台可能刚给别的表情起完名，别把那些改动冲掉
    const fresh = loadLibrary()
    fresh.items = fresh.items.filter((i) => !gone.has(i.md5))
    saveLibrary(fresh)
    log.info(`批量删掉 ${found.length} 张表情${fromQQ ? '' : '（QQ 收藏保留）'}`)
    return { ok: true, removed: found.length, qqFailed, message: `删掉了 ${found.length} 张${qqFailed ? `（${qqFailed} 张没从 QQ 收藏删掉）` : ''}` }
  }

  function rename(md5, name, tags) {
    const lib = loadLibrary()
    const it = lib.items.find((i) => i.md5 === md5)
    if (!it) return { ok: false }
    if (name !== undefined) it.name = String(name).trim().slice(0, 12)
    if (tags !== undefined) it.tags = [...new Set((Array.isArray(tags) ? tags : []).map((t) => String(t).replace(/^#/, '').trim().slice(0, 8)).filter(Boolean))].slice(0, 5)
    saveLibrary(lib)
    if (it.emojiId && !getConfig().dryRun) onebot.call('modify_custom_face', { emoji_id: it.emojiId, desc: it.name }).catch(() => {})
    return { ok: true, item: it }
  }

  /** 发表情用的消息段：商城表情按商城表情原样发（带 emoji_id，网关会认回成 mface）；其余本地图片按表情（sub_type=1）发。 */
  function segmentFor(item) {
    if (item.market?.emojiId) return { type: 'image', data: { emoji_id: item.market.emojiId, emoji_package_id: item.market.packageId, key: item.market.key, summary: `[${item.name || '表情'}]` } }
    const p = stickerPath(item)
    if (!existsSync(p)) return null
    return { type: 'image', data: { file: 'base64://' + readFileSync(p).toString('base64'), sub_type: 1, summary: `[${item.name || '表情'}]` } }
  }

  /**
   * 把机器人号 QQ「我喜欢的」里已有的表情导进表情库（fetch_custom_face）。已经有的跳过；
   * 不再往 QQ 收藏里加一遍。开了「看图起名」就在后台一张张起名。
   */
  let importing = null
  async function importFromQQ({ limit = getConfig().stickers.maxLibrary } = {}) {
    if (importing) return importing
    importing = (async () => {
      let urls
      try {
        const r = await onebot.call('fetch_custom_face', { count: Math.max(1, Math.min(500, Number(limit) || 300)) }, { timeoutMs: 30000 })
        urls = (Array.isArray(r) ? r : r?.data || []).map((x) => (typeof x === 'string' ? x : x?.url || '')).filter(Boolean)
      } catch (error) {
        return { ok: false, message: '读不到机器人号的 QQ 收藏表情：' + error.message }
      }
      let added = 0
      let existed = 0
      let failed = 0
      const named = []
      for (const url of urls) {
        let buf
        try { buf = await fetchImage(url, { maxBytes: 1024 * 1024 * 1024 }) } catch (error) { failed++; continue }
        const md5 = createHash('md5').update(buf).digest('hex')
        if (loadLibrary().items.some((i) => i.md5 === md5)) { existed++; continue }
        const r = await addFromBuffer(buf, { from: 'qq', toQQ: false })
        if (r.ok && !r.existed) { added++; named.push({ md5, buf }) } else failed++
      }
      log.info(`从 QQ 收藏导入表情：新加 ${added} 张，已有 ${existed} 张${failed ? `，${failed} 张下不来` : ''}`)
      // 后台起名（一张张来，别一下子打满模型）
      if (named.length && getConfig().stickers.caption) {
        ;(async () => {
          for (const { md5, buf } of named) {
            const { name, tags } = await caption(buf, mimeOf(buf), '')
            const l = loadLibrary()
            const it = l.items.find((i) => i.md5 === md5)
            if (!it || it.name) continue
            it.name = name || '表情'
            if (tags.length) it.tags = tags
            saveLibrary(l)
          }
        })().catch((error) => log.warn('给导入的表情起名出错：', error.message))
      }
      return { ok: true, added, existed, failed, total: urls.length, message: urls.length ? `QQ 收藏里有 ${urls.length} 张：新导入 ${added} 张，已经有 ${existed} 张${failed ? `，${failed} 张下载失败` : ''}${added && getConfig().stickers.caption ? '。名字在后台慢慢起' : ''}` : 'QQ 收藏里没有表情' }
    })().finally(() => { importing = null })
    return importing
  }

  // ---------- 批量补名字 / 标签 ----------
  // 整理整个表情库：一张张交给模型看图起名（复用 caption，和偷表情同一套提示词），后台跑、面板轮询进度。
  // 任务状态留在闭包里，关掉面板也照跑；模块卸载 / 重载时 dispose 负责叫停 —— 不然旧实例会接着调模型、写库，
  // 和新实例互相覆盖。
  let captionJob = null
  let disposed = false

  function captionStatus() {
    const t = captionModelOf(getConfig())
    const model = t ? t.provider + '/' + t.model : ''
    if (!captionJob) return { running: false, total: 0, done: 0, ok: 0, failed: 0, skipped: 0, message: '', model }
    return {
      running: captionJob.running, total: captionJob.total, done: captionJob.done,
      ok: captionJob.ok, failed: captionJob.failed, skipped: captionJob.skipped,
      startedAt: captionJob.startedAt, current: captionJob.current, last: captionJob.last,
      canceled: Boolean(captionJob.cancel), message: captionJob.message, model,
    }
  }

  function captionCancel() {
    if (!captionJob || !captionJob.running) return { running: false, message: '没有在跑的任务' }
    captionJob.cancel = true
    return { running: true, message: '这一张跑完就停' }
  }

  /** 模块卸载 / 重载：叫停后台任务（循环里每张之前也会看 cancel）。 */
  function dispose() {
    disposed = true
    if (captionJob && captionJob.running) {
      captionJob.cancel = true
      captionJob.message = '模块重载，这一轮先停了'
      log.info('表情库批量起名：模块卸载，停止后台任务')
    }
  }

  /** 哪些要补：默认只补名字或标签空着的（文件丢了的跳过）；all = 全库重做。 */
  function captionTargets({ all = false } = {}) {
    const items = loadLibrary().items.filter((i) => existsSync(join(dir(), i.file)))
    return all ? items : items.filter((i) => !String(i.name || '').trim() || !(i.tags || []).length)
  }

  /** 开始批量起名：立刻返回，真正干活在后台。 */
  async function captionLibrary({ all = false, limit = 0 } = {}) {
    if (disposed) return { ok: false, message: '模块重载了，重新打开面板再试' }
    if (captionJob && captionJob.running) return { ok: false, message: '上一轮还在跑，等它跑完（或者点「停」）', status: captionStatus() }
    const target = captionModelOf(getConfig())
    if ((await canSeeImages(dsh, getConfig(), target)) === false) {
      return {
        ok: false,
        message: target
          ? '「起名用的模型」' + target.provider + '/' + target.model + ' 看不了图，起不了名字：换一个能看图的模型，或者把它清空、改用聊天模型'
          : '当前模型看不了图，起不了名字：面板「模型」里把「视觉能力」改成「支持」，或者换一个能看图的模型',
      }
    }
    let queue = captionTargets({ all })
    const cap = Math.max(0, Number(limit) || 0)
    if (cap) queue = queue.slice(0, cap)
    if (!queue.length) return { ok: true, total: 0, message: all ? '表情库里还没有表情' : '每张都有名字和标签了（想全部重做就勾「全部重做」）' }
    const job = { running: true, total: queue.length, done: 0, ok: 0, failed: 0, skipped: 0, startedAt: Date.now(), current: '', last: '', cancel: false, all, message: '' }
    captionJob = job
    log.info(`开始给 ${queue.length} 张表情补名字（${all ? '全部重做' : '只补空缺'}${target ? '，模型 ' + target.provider + '/' + target.model : ''}）`)
    ;(async () => {
      let streak = 0 // 连续失败几张就收手，别在额度用光 / 网络断了的时候还一路烧下去
      for (const want of queue) {
        if (job.cancel) break
        if (streak >= 5) { job.message = `连续失败 ${streak} 张，先停了（模型或网络有问题）`; break }
        // 一张一张来，别一瞬间把模型打满
        await new Promise((r) => setTimeout(r, 350))
        if (job.cancel) break
        // 每张都读一遍最新的库：跑到一半用户改过名字、或者删了这张，就跳过
        const it = loadLibrary().items.find((i) => i.md5 === want.md5)
        if (!it || (!all && String(it.name || '').trim() && (it.tags || []).length)) { job.skipped++; job.done++; continue }
        job.current = it.name || it.md5.slice(0, 8)
        let buf
        try { buf = readFileSync(join(dir(), it.file)) } catch (error) { job.failed++; job.done++ }
        if (!buf) continue
        const { name, tags, noVision } = await caption(buf, mimeOf(buf), it.summary || '')
        if (!name) {
          job.failed++
          job.done++
          // 跑到一半模型换成看不了图的（或者元数据变了）：再跑下去只会一路失败，直接收手
          if (noVision) { job.message = '模型看不了图，先停了：换一个能看图的模型再试'; break }
          streak++
          continue
        }
        streak = 0
        const l = loadLibrary()
        const cur = l.items.find((i) => i.md5 === it.md5)
        if (!cur) { job.skipped++; job.done++; continue }
        cur.name = name
        if (tags.length) cur.tags = tags
        saveLibrary(l)
        if (cur.emojiId && !getConfig().dryRun) {
          try { await onebot.call('modify_custom_face', { emoji_id: cur.emojiId, desc: cur.name.slice(0, 20) }) } catch (error) { log.warn('写回 QQ 备注失败：', error.message) }
        }
        job.ok++
        job.last = cur.name
        job.done++
      }
      job.running = false
      job.current = ''
      if (!job.message) job.message = (job.cancel ? '停下来了：这轮' : '整理完了：') + `起了 ${job.ok} 张名字，跳过 ${job.skipped} 张，失败 ${job.failed} 张`
      log.info(job.message)
    })().catch((error) => {
      job.running = false
      job.message = '出错了：' + error.message
      log.warn('批量起名出错：', error.message)
    })
    return { ok: true, total: queue.length, started: true, status: captionStatus(), message: `开始给 ${queue.length} 张表情起名字（后台跑，可以关掉面板）` }
  }

  return { importFromQQ, collect, addFromBuffer, remove, removeMany, rename, segmentFor, markUsed, trim, captionLibrary, captionStatus, captionCancel, captionTargets, dispose, library: loadLibrary, match: (q) => matchSticker(loadLibrary().items, q), pickForReply: (t) => pickForReply(loadLibrary().items, t) }
}
