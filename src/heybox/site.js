// 小黑盒业务层：信息流 / 帖子详情 / 热榜 / 搜索 / 点赞 / 评论 / 发帖（带图）/ 删帖 / 配额。
//
// 几条硬经验（实测踩出来的，别改）：
//   · 发帖 link_tag：11=文章（富文本、行内插图真正夹在文字中间）、27=图文（图片被挤到文末）、28=动态（只能纯文本）
//   · topic_ids 必须是真的分区 id（7214 / 18745 / 806933），乱填一直报「错误的帖子类型」
//   · 帖详情接口频繁访问会触发验证码，还会连坐浏览器会话 → 统一限速 900ms 起
//   · 搜索接口最容易弹验证码 → 单独拉长间隔，被挡就降级，不阻断主流程
//   · 图片走腾讯云 COS 四步直传，任何一步失败都只是少一张图，不打断发帖

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { HeyboxClient, HeyboxError, cosSign, WEB_BASE, TOPICS } from './api.js'
import { POST_STYLES, DEFAULT_POST_STYLE, styleOf, stylePrompt } from './styles.js'
import { startQrLogin, pollQrLogin } from './qr.js'

const HOME = process.env.USERPROFILE || os.homedir()
const CRED_DIR = path.join(HOME, '.heybox-ai')
const CRED_FILE = path.join(CRED_DIR, 'credentials.json')

const DEFAULT_STATE = {
  account: { checkedAt: 0, nickname: '', heyboxId: '', loggedIn: false, message: '' },
  quota: { date: '', like: 0, comment: 0, post: 0, browse: 0, share: 0 },
  history: [],
  lastRun: 0,
  lastSkipReason: '',
  // 风控冷却：{ level, until, reason, at }。掉线也不丢，重启后接着冷却（不然一重启就撞回去）
  risk: { level: 0, until: 0, reason: '', at: 0 },
  // 连续失败次数 + 下次允许尝试的时刻：会话卡住 / 模型抽风时别每分钟硬撞
  failures: 0,
  retryAt: 0,
}

// 后台会话连续失败后的重试间隔：2 分钟 → 5 → 15 → 30 → 60 → 120 分钟
const RETRY_BACKOFF_MS = [2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000, 120 * 60_000]

// 用**本地**日期，不用 UTC：东八区 0-8 点这段 UTC 还停在前一天，
// 用 toISOString() 会让额度在早上 8 点「跨天重置」，一天实际能逛两轮。
const today = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const nowMs = () => Date.now()

/** 把 blocks 里的正文抽成纯文本（正文是 JSON 块数组，可能是 text / html / img） */
function textOf(value) {
  if (typeof value !== 'string') return ''
  try {
    const blocks = JSON.parse(value)
    if (Array.isArray(blocks)) {
      return blocks.map((b) => {
        if (!b) return ''
        if (b.type === 'text') return b.text || ''
        if (b.type === 'html') return String(b.text || '').replace(/<[^>]+>/g, '')
        return ''
      }).filter(Boolean).join('\n')
    }
  } catch { /* 不是 JSON，原样返回 */ }
  return value
}

/** 从模型输出里取 JSON 对象（外面裹了 markdown 代码块、或者前后多说两句都能取出来）。 */
export function pickJson(out, fallback) {
  const s = String(out || '')
  const m = s.match(/```(?:json)?[^`]*?```/) || s.match(/[{][\s\S]*[}]/)
  const body = m ? String(m[0]).replace(/```(?:json)?/g, '').replace(/```/g, '').trim() : ''
  for (const cand of [body, s]) {
    const a = cand.indexOf('{')
    const b = cand.lastIndexOf('}')
    if (a < 0 || b <= a) continue
    try { return JSON.parse(cand.slice(a, b + 1)) } catch { /* 试下一个 */ }
  }
  return fallback
}

const htmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const countWords = (s) => String(s || '').replace(/\s/g, '').length

/** 从各种写法的链接里挖出 link_id */
export function linkIdOf(input) {
  const s = String(input || '')
  const m = s.match(/link\/(\d+)/)
  if (m) return m[1]
  const digits = s.replace(/\D/g, '')
  return digits.length >= 6 ? digits : ''
}

export function createHeybox({ getConfig, hub, memory, log, verifier = null }) {
  let client = null
  let clientCookie = ''

  /** Cookie 从配置或凭据文件读；配置优先（面板里填的） */
  function cookie() {
    const c = (getConfig().heybox || {}).cookie || ''
    if (c) return String(c).trim()
    try {
      const j = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'))
      return Object.entries(j.cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ')
    } catch { return '' }
  }

  /** 是否已登录：Cookie 里有 pkey / user_pkey 才算（和 HeyboxClient.loggedIn 同一判定） */
  function hasLogin() {
    const ck = cookie()
    return Boolean(ck) && /pkey=|user_pkey=/.test(ck)
  }

  /** 冷却状态变了就落盘，重启后接着冷却（一重启就撞回去最容易被判成脚本） */
  function saveRisk(info) {
    try {
      const st = readState()
      st.risk = { level: info.level || 0, until: info.until || 0, reason: info.reason || '', at: info.at || 0 }
      writeState(st)
    } catch { /* 落盘失败不影响请求 */ }
  }

  function getClient() {
    const c = cookie()
    if (!client || c !== clientCookie) {
      client = new HeyboxClient({ cookie: c, risk: readState().risk, onRisk: saveRisk })
      clientCookie = c
    }
    return client
  }

  /** 现在是不是在冷却（给上层和面板用） */
  function risk() {
    return getClient().riskInfo()
  }

  /** 状态文件：主板数据，掉线也不丢 */
  function readState() {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(HOME, '.dsh', 'heybox-state.json'), 'utf8'))
      return { ...DEFAULT_STATE, ...raw }
    } catch { return { ...DEFAULT_STATE } }
  }

  function writeState(next) {
    try {
      fs.mkdirSync(path.join(HOME, '.dsh'), { recursive: true })
      fs.writeFileSync(path.join(HOME, '.dsh', 'heybox-state.json'), JSON.stringify(next, null, 2))
    } catch (e) { log?.warn?.('写小黑盒状态失败：' + e.message) }
  }

  function quota() {
    const st = readState()
    if (st.quota.date !== today()) return { date: today(), like: 0, comment: 0, post: 0, browse: 0, share: 0 }
    return st.quota
  }

  function bump(kind) {
    const st = readState()
    const q = quota()
    q[kind] = (q[kind] || 0) + 1
    st.quota = q
    writeState(st)
    return q[kind]
  }

  function left(kind) {
    const c = getConfig().heybox || {}
    const cap = { like: c.likeDaily, comment: c.commentDaily, post: c.maxPostsPerDay, browse: c.maxRunsPerDay, share: c.shareDaily }[kind] ?? 0
    return Math.max(0, (Number(cap) || 0) - (quota()[kind] || 0))
  }

  /** 模型说「没什么好分享的」也算静默 */
  const isSilenceText = (t) => /^[\s\u3000]*$/.test(t) || /^(沉默|［沉默］|（沉默）|\(沉默\)|无|没有|none|null|n\/a)$/i.test(String(t).trim())

  function pushHistory(item) {
    const st = readState()
    st.history = [{ at: nowMs(), ...item }, ...(st.history || [])].slice(0, 60)
    writeState(st)
  }

  // ── 只读：信息流 / 帖子 / 热榜 / 搜索 / 分区 ─────────────────────────

  async function feed(offset = 0) {
    const d = await getClient().get('/bbs/app/feeds', { pull: 0, offset, dw: 604 })
    const r = d.result || {}
    const list = r.links || r.list || []
    return list.map((x) => ({
      linkId: String(x.linkid ?? x.link_id ?? ''),
      title: String(x.title || ''),
      author: String((x.user && (x.user.username || x.user.nickname)) || ''),
      likes: Number(x.link_like_count ?? x.like_num ?? 0),
      comments: Number(x.comment_num ?? x.comment_count ?? 0),
      topics: (Array.isArray(x.topics) ? x.topics : []).map((t) => String(t.name || '')).filter(Boolean),
    })).filter((x) => x.linkId)
  }

  async function feedReport() {
    const list = await feed(0)
    return {
      ok: true,
      message: list.length
        ? list.map((x) => `[${x.linkId}] ${x.title || '（无标题）'}　by ${x.author}　赞${x.likes} 评${x.comments}`).join('\n')
        : '信息流是空的',
      links: list,
    }
  }

  function findComments(value, depth = 0) {
    if (!value || depth > 4) return null
    if (Array.isArray(value)) {
      if (value.length && value.every((v) => v && typeof v === 'object' && ('commentid' in v || 'comment_id' in v))) return value
      for (const v of value) { const r = findComments(v, depth + 1); if (r) return r }
      return null
    }
    if (typeof value === 'object') {
      for (const k of ['comments', 'comment_list', 'list', 'data']) {
        if (value[k]) { const r = findComments(value[k], depth + 1); if (r) return r }
      }
      for (const v of Object.values(value)) { const r = findComments(v, depth + 1); if (r) return r }
    }
    return null
  }

  async function detail(linkId) {
    const d = await getClient().get('/bbs/app/link/tree', {
      link_id: linkId, page: 1, is_first: 1, index: 1, owner_only: 0, offset: 0, limit: 20, sort_filter: 'hot',
    })
    const r = d.result || {}
    const link = r.link || r
    const user = link.user || {}
    const comments = findComments(r) || []
    return {
      linkId,
      url: `${WEB_BASE}/app/bbs/link/${linkId}`,
      title: String(link.title || ''),
      author: String(user.username ?? user.nickname ?? ''),
      likes: Number(link.link_like_count ?? link.like_num ?? 0),
      body: textOf(link.text) || String(link.description || ''),
      topics: (Array.isArray(link.topics) ? link.topics : []).map((t) => '#' + String(t.name || '') + '#').filter((t) => t.length > 2),
      comments: comments.slice(0, 12).map((c) => ({
        id: String(c.commentid ?? c.comment_id ?? ''),
        user: String((c.user && (c.user.username || c.user.nickname)) || '匿名'),
        likes: Number(c.up ?? c.like_num ?? 0),
        text: String(c.text ?? c.content ?? ''),
        replyId: String(c.replyid ?? c.reply_id ?? '-1'),
      })),
    }
  }

  async function watch(link) {
    const id = linkIdOf(link)
    if (!id) return { ok: false, message: '没看出帖子编号（要 /link/数字 或者 6 位以上的数字 id）' }
    const d = await detail(id)
    return {
      ok: true,
      message: [
        `《${d.title || '（无标题）'}》by ${d.author || '未知'}　赞${d.likes}`,
        d.topics.join(' '),
        '',
        d.body.slice(0, 800) || '（无正文）',
        '',
        d.comments.length ? '热评：' : '（还没有评论）',
        ...d.comments.slice(0, 6).map((c) => `· ${c.user}：${c.text.slice(0, 80)}`),
      ].join('\n'),
      url: d.url,
    }
  }

  /** 热榜：接口 result.Lists 是几组，只取「黑盒热议」那组 */
  async function hot(limit = 8) {
    const d = await getClient().get('/bbs/app/api/search/welcome_page/v2', { force_refresh: 'false' })
    const r = d.result || {}
    const groups = r.Lists
    if (!Array.isArray(groups)) throw new HeyboxError('热榜接口结构变了，找不到 Lists', 'schema')
    const target = groups.find((g) => String(g?.head_text || '').includes('热议'))
      || groups.find((g) => Array.isArray(g?.items) && g.items.length)
      || groups[0]
    const items = Array.isArray(target?.items) ? target.items : []
    const list = []
    for (const it of items.slice(0, Math.max(1, Number(limit) || 8))) {
      const text = String(it?.text || '').trim()
      if (text) list.push({ text, tag: String((it?.right_tag && (it.right_tag.text || it.right_tag)) || '').slice(0, 20) })
    }
    return {
      ok: true,
      group: String(target?.head_text || ''),
      list,
      message: [`【${target?.head_text || '热榜'}】`].concat(list.map((x, i) => `${i + 1}. ${x.text}${x.tag ? ' [' + x.tag + ']' : ''}`)).join('\n'),
    }
  }

  /**
   * 搜索：最容易验证码的接口。限速由 api.js 按档位统一管（8 秒起 + 抖动），
   * 这里只负责把「被挡」翻译成 blocked，好让上层的「写帖流程」降级到「热榜 + 信息流」。
   */
  async function search(query, limit = 8, { sort = 'award_num', timeRange = '7d' } = {}) {
    const q = String(query || '').trim()
    if (!q) return { ok: false, message: '要给个关键词' }
    let d
    try {
      d = await getClient().get('/bbs/app/api/general/search/v1', {
        q, search_type: 'general', is_pull_down: '0', offset: 0,
        limit: Math.max(1, Math.min(Number(limit) || 8, 30)), dw: 744,
        sort_filter: sort, time_range: timeRange,
      })
    } catch (err) {
      if (err.code === 'cooldown' || err.code === 'captcha' || err.code === 'rate_limit') {
        return { ok: false, blocked: true, cooldown: true, message: '小黑盒在冷却中：' + err.message + '。这接口查太勤就会要验证码，先用 heybox_feed 看信息流找角度。' }
      }
      return { ok: false, blocked: true, message: '搜索被小黑盒挡了（' + err.message + '）。这接口查太勤就会要验证码，隔一会儿再试，或者先用 heybox_feed 看信息流找角度。' }
    }
    const r = d.result || {}
    const items = Array.isArray(r.items) ? r.items : []
    const list = items.map((it) => {
      const x = it.link || it.info || it
      return {
        linkId: String(x.linkid ?? x.link_id ?? ''),
        title: String(x.title ?? x.link_title ?? x.text ?? ''),
        likes: Number(x.link_like_count ?? x.like_num ?? x.award_num ?? 0),
        comments: Number(x.comment_num ?? x.comment_count ?? 0),
      }
    }).filter((x) => x.linkId || x.title).slice(0, Number(limit) || 8)
    return {
      ok: true,
      list,
      message: list.length
        ? list.map((x) => `[${x.linkId || '—'}] ${x.title}　赞${x.likes} 评${x.comments}`).join('\n')
        : '没搜到',
    }
  }

  async function topicList() {
    const fallback = Object.entries(TOPICS).map(([id, name]) => ({ id, name }))
    try {
      const d = await getClient().get('/bbs/app/api/topic/index', { is_post: 1 })
      const r = d.result || {}
      const raw = r.topics || r.list || r.categories || []
      const out = []
      const walk = (arr, dep = 0) => {
        if (!Array.isArray(arr) || dep > 2) return
        for (const t of arr) {
          if (t && t.topic_id && t.name) out.push({ id: String(t.topic_id), name: String(t.name) })
          if (t && Array.isArray(t.children)) walk(t.children, dep + 1)
        }
      }
      walk(raw)
      if (out.length) return { ok: true, list: out, message: out.map((t) => `${t.id} = ${t.name}`).join('\n') }
    } catch { /* 拿不到就用内置的三个 */ }
    return { ok: true, list: fallback, message: fallback.map((t) => `${t.id} = ${t.name}`).join('\n') + '（接口没返回，这是内置的三个）' }
  }

  // ── 写：点赞 / 评论 / 删帖 ───────────────────────────────────────
  //
  // 写操作一律不重试（重试只会把风控拖得更久）。冷却 / 验证码 / 登录失效都翻译成
  // 「今天先别动手」的普通失败，让调用方（人和后台会话）知道该停手，而不是硬怼。

  /** 把请求错误的语义翻译成给上层看的话。写操作专用：一旦碰上就建议停手。 */
  function writeFail(e) {
    const code = e?.code
    if (code === 'cooldown' || code === 'captcha' || code === 'rate_limit') {
      return { ok: false, stopped: true, risk: risk(), message: '小黑盒在冷却中，今天先不动手：' + e.message }
    }
    if (code === 'auth') return { ok: false, stopped: true, needLogin: true, message: '小黑盒登录态失效了，先在面板里重新填 Cookie：' + e.message }
    return { ok: false, message: e.message }
  }

  async function like(link) {
    const id = linkIdOf(link)
    if (!id) return { ok: false, message: '没看出帖子编号' }
    if (left('like') <= 0) return { ok: false, message: '今天的点赞额度用完了' }
    try {
      await getClient().post('/bbs/app/profile/award/link', { link_id: id, award_type: '1' })
    } catch (e) { return writeFail(e) }
    bump('like')
    pushHistory({ kind: 'like', linkId: id })
    return { ok: true, message: `给 [${id}] 点了个赞`, url: `${WEB_BASE}/app/bbs/link/${id}` }
  }

  async function comment(link, text, { rootId = '-1', replyId = '-1' } = {}) {
    const id = linkIdOf(link)
    if (!id) return { ok: false, message: '没看出帖子编号' }
    const t = String(text || '').trim().slice(0, 100)
    if (!t) return { ok: false, message: '评论内容空了' }
    if (left('comment') <= 0) return { ok: false, message: '今天的评论额度用完了' }
    try {
      await getClient().post('/bbs/app/comment/create', { link_id: id, text: t, root_id: String(rootId), reply_id: String(replyId), is_cy: '0' })
    } catch (e) { return writeFail(e) }
    bump('comment')
    pushHistory({ kind: 'comment', linkId: id, text: t })
    return { ok: true, message: `评论发了：${t}`, url: `${WEB_BASE}/app/bbs/link/${id}` }
  }

  async function remove(link) {
    const id = linkIdOf(link)
    if (!id) return { ok: false, message: '没看出帖子编号' }
    try {
      await getClient().post('/bbs/app/link/delete', { link_id: id })
    } catch (e) { return writeFail(e) }
    pushHistory({ kind: 'delete', linkId: id })
    return { ok: true, message: `删掉了 [${id}]` }
  }

  // ── 写：发帖（文章模式 + 行内图） ────────────────────────────────

  function imageInfo(buf, filename) {
    const head = buf.slice(0, 8).toString('latin1')
    const isPng = head.includes('PNG')
    const isJpg = buf.slice(0, 2).toString('latin1') === '\u00ff\u00d8'
    return {
      mimetype: isPng ? 'image/png' : isJpg ? 'image/jpeg' : 'image/jpeg',
      name: filename || (isPng ? 'a.png' : 'a.jpg'),
    }
  }

  /** 腾讯云 COS 四步直传，返回 { url, width, height } */
  async function uploadImage(buf, filename, width, height) {
    const c = getClient()
    const info = imageInfo(buf, filename)
    const fileInfos = JSON.stringify([{ name: info.name, mimetype: info.mimetype, fsize: buf.length, width: width || 1000, height: height || 600 }])

    const step1 = await c.post('/bbs/app/api/qcloud/cos/upload/info/v2', { file_infos: fileInfos, scope: 'bbs', need_cache: '0' })
    const r1 = step1.result || {}
    const key = (r1.keys || [])[0]
    if (!key) throw new HeyboxError('图片上传第一步没拿到 key', 'upload')

    const step2 = await c.post('/bbs/app/api/qcloud/cos/upload/token/v2', {
      bucket: r1.bucket, keys: JSON.stringify([key]), mimetypes: JSON.stringify([info.mimetype]), is_multipart_upload: '0',
    })
    const creds = (step2.result || {}).credentials || {}
    if (!creds.tmpSecretId) throw new HeyboxError('图片上传第二步没拿到临时凭证', 'upload')

    const cosHost = `${r1.bucket}.cos.${r1.region}.myqcloud.com`
    const now = Math.floor(Date.now() / 1000)
    const keyTime = `${now};${now + 180}`
    const auth = cosSign({ secretId: creds.tmpSecretId, secretKey: creds.tmpSecretKey, path: key, host: cosHost, contentLength: buf.length, keyTime })
    await c.putCOS(`https://${cosHost}${key.split('/').map(encodeURIComponent).join('/')}`, buf, {
      contentType: info.mimetype, authorization: auth, sessionToken: creds.sessionToken,
    })

    const step4 = await c.post('/bbs/app/api/qcloud/cos/upload/callback/v2', { keys: JSON.stringify([key]) }, { is_finished: 'true' })
    const url = ((step4.result || {}).preview_urls || [])[0]
    if (!url) throw new HeyboxError('图片上传最后一步没拿到地址', 'upload')
    return { url, width: width || 1000, height: height || 600 }
  }

  /** 文章模式组装：html 块（行内 <img>）+ 末尾 img 引用块（封面/图库） */
  async function buildArticle(segments) {
    const htmlParts = []
    const imgRefs = []
    const texts = []
    for (const seg of segments || []) {
      if (seg.type === 'text') {
        const t = String(seg.text || '').replace(/\n+$/, '')
        if (!t.trim()) continue
        texts.push(t)
        const esc = htmlEscape(t)
        for (const para of esc.split(/\n\s*\n/)) {
          if (para.trim()) htmlParts.push('<p>' + para.trim().replace(/\n/g, '<br>') + '</p>')
        }
      } else if (seg.type === 'img' && seg.buf) {
        let up
        try { up = await uploadImage(seg.buf, seg.filename, seg.width, seg.height) } catch (e) {
          log?.warn?.('小黑盒配图上传失败，跳过这张：' + e.message)
          continue
        }
        imgRefs.push(up)
        htmlParts.push(`<p><img data-type="image" data-original="${up.url}" data-width="${up.width}" data-height="${up.height}" data-description=""></p>`)
      }
    }
    if (!htmlParts.length) throw new HeyboxError('没内容可发', 'input')
    const blocks = [{ type: 'html', text: htmlParts.join('') }]
    for (const b of imgRefs) blocks.push({ type: 'img', url: b.url, width: String(b.width), height: String(b.height) })
    return { blocks, fullText: texts.join('\n') || '（图片帖）' }
  }

  /** 创作者中心最新帖 id：文章模式一般直接返回 link_id，这个只做兜底 */
  async function latestPostId() {
    try {
      const d = await getClient().get('/bbs/app/author/concept/article/list', {
        article_type: 'all', artilce_state: 'all', sort_filter: 'create_at', offset: 0, limit: 1,
      })
      const r = d.result || {}
      const list = r.articles || r.links || r.list || []
      const first = list[0]
      return first ? String(first.linkid ?? first.link_id ?? '') : ''
    } catch { return '' }
  }

  async function post({ title, text = '', images = [], topic = '', style = '' }) {
    const cfg = getConfig().heybox || {}
    if (left('post') <= 0) return { ok: false, message: '今天的发帖额度用完了（建议一天别超过 3 篇）' }
    const t = String(title || '').trim()
    if (!t) return { ok: false, message: '标题不能空' }
    if (t.length > 30) return { ok: false, message: `标题 ${t.length} 字，太长了（最多 30 字）` }

    // 风格只影响提示词和字数下限，不改发帖接口
    const st = styleOf(style || cfg.postStyle)
    const words = countWords(text)
    if (text && words && words < st.words[0] * 0.6) {
      log?.warn?.(`小黑盒发帖正文 ${words} 字，比「${st.label}」建议的 ${st.words[0]}~${st.words[1]} 字短不少`)
    }

    const topicId = String(topic || cfg.defaultTopic || 7214)
    const segs = []
    if (text) segs.push({ type: 'text', text })
    for (const p of images) {
      try {
        const buf = fs.readFileSync(p)
        segs.push({ type: 'img', buf, filename: path.basename(p) })
      } catch { log?.warn?.('配图读不到，跳过：' + p) }
    }

    const { blocks, fullText } = await buildArticle(segs)
    const desc = fullText.replace(/\s+/g, ' ').slice(0, 80)
    let d
    try {
      d = await getClient().post('/bbs/app/api/link/post', {
        link_tag: '11',                         // 11=文章（富文本，行内插图真正生效）
        text: JSON.stringify(blocks),
        title: t,
        desc,
        words_count: String(countWords(fullText)),
        topic_ids: topicId,                     // 必须给，否则「请添加分区」
        hashtags: '[]',
        schedule_ts: '0',
        view_limit: '1',                        // 1=所有人
        post_type: '1',
        original: '1',
        declaration: '0',
      })
    } catch (e) { return writeFail(e) }

    const r = d.result || {}
    let id = String((typeof r === 'object' && (r.link_id ?? r.linkid)) || d.link_id || d.linkid || '')
    if (!id) id = await latestPostId()
    bump('post')
    const url = id ? `${WEB_BASE}/app/bbs/link/${id}` : ''
    pushHistory({ kind: 'post', linkId: id, title: t })
    memory?.addEvent?.({ text: `我在小黑盒发了一帖《${t}》`, tags: ['小黑盒'], importance: 0.5 })

    const inline = blocks[0]?.type === 'html' ? (blocks[0].text.match(/<img /g) || []).length : 0
    return {
      ok: true,
      message: (url ? `发出去了：${url}` : '发出去了，但没拿到帖子编号') + `（风格：${st.label}，行内图 ${inline} 张）`,
      url, linkId: id, inline, topicId, style: st.id,
    }
  }

  /** 按风格给「这一帖该怎么写」的提示词（她生成正文前拿这个） */
  function postBrief(style = '', ctx = {}) {
    return stylePrompt(style || (getConfig().heybox || {}).postStyle, ctx)
  }

  // ── 分享给主人（和 B 站同一个思路：模型判断值不值得，代码只负责发） ──

  /**
   * 把这一轮觉得有意思的帖子私聊发给主人。带标题和链接，主人点开就能看。
   * 额度、开关都在这里判断；发不出去只返回失败，不影响主流程。
   * @param {object} verdict 模型输出的 JSON（含 share / linkId）
   */
  async function shareToOwner(verdict, { owner = '主人' } = {}) {
    const c = getConfig().heybox || {}
    if (!c.shareToOwner) return { ok: false, skipped: true, message: '分享给主人这个开关关着' }
    const text = String((verdict && verdict.share) || '').trim()
    if (!text || isSilenceText(text)) return { ok: false, skipped: true, message: '这一轮没有值得分享的' }
    if (left('share') <= 0) return { ok: false, skipped: true, message: '今天的分享额度用完了' }

    const qq = String(getConfig().ownerQQ || '').trim()
    if (!qq) return { ok: false, message: '没设主人 QQ 号，没处发' }

    const id = linkIdOf(String((verdict && verdict.linkId) || ''))
    const url = id ? `${WEB_BASE}/app/bbs/link/${id}` : ''
    const body = url ? `${text}\n${url}` : text

    const sent = await hub.sendText(`private:${qq}`, body)
    if (!sent) return { ok: false, message: 'QQ 没发出去（可能被风控或网关断了）' }

    bump('share')
    pushHistory({ kind: 'share', linkId: id, text: text.slice(0, 60) })
    return { ok: true, message: '分享给' + owner + '了', linkId: id, url, text }
  }

  // ── 定时自己逛（只读） ─────────────────────────────────────────

  async function browse({ ownerAsked = false, report } = {}) {
    const c = getConfig().heybox || {}
    if (!c.enabled) return { ok: false, message: '小黑盒没打开' }
    if (!cookie()) return { ok: false, message: '还没登录小黑盒（面板里填 Cookie）' }
    const cd = risk()
    if (cd.leftMs > 0) return { ok: false, cooling: true, risk: cd, message: `小黑盒还在冷却（还要等 ${Math.ceil(cd.leftMs / 60000)} 分钟），这轮不逛了` }
    if (left('browse') <= 0) return { ok: false, message: '今天逛的轮数到上限了' }
    try {
      const list = await feed(0)
      const picked = list.slice(0, Math.max(1, Number(c.perRun) || 3))
      bump('browse')
      const st = readState()
      st.lastRun = nowMs()
      st.lastSkipReason = ''
      writeState(st)
      pushHistory({ kind: 'browse', count: picked.length })
      return {
        ok: true,
        message: picked.length
          ? '逛完了，看到这些：\n' + picked.map((x) => `《${x.title || '无标题'}》赞${x.likes} 评${x.comments}  ${WEB_BASE}/app/bbs/link/${x.linkId}`).join('\n')
          : '逛完了，信息流是空的',
        links: picked,
      }
    } catch (e) {
      if (e.code === 'cooldown' || e.code === 'captcha' || e.code === 'rate_limit') {
        return { ok: false, cooling: true, risk: risk(), message: '逛小黑盒被挡了，先停手：' + e.message }
      }
      return { ok: false, message: '逛小黑盒失败：' + e.message }
    }
  }

  // ── 后台会话：定时自己刷（独立 system 会话，带人格，结果不发到 QQ） ──
  //
  // 说明（原作者 review 里点到的）：
  //   · 工具永远跑在「调用它的那个聊天」的会话里，所以要有独立会话就得自己开一个；
  //   · api.think / hub.runSystemTurn 会建 system:ext-heybox 后台会话，带人格；
  //   · 记忆是全局一份，但后台 system 会话不会自动带记忆、也不会被提取，
  //     所以这里手动 recall 拼进 prompt，想留下的再用 memory.add 写回去。

  async function runDuty({ memory, owner = '' } = {}) {
    const c = getConfig().heybox || {}
    if (!c.enabled || !c.autoBrowse || !hasLogin()) return { ok: false, message: '没开或没登录' }
    const cd = risk()
    if (cd.leftMs > 0) return { ok: false, cooling: true, risk: cd, message: `小黑盒还在冷却（还要等 ${Math.ceil(cd.leftMs / 60000)} 分钟）` }
    if (left('browse') <= 0) return { ok: false, message: '今天逛的轮数到上限了' }

    // 手动把相关记忆拼进 prompt（后台会话不会自动带）
    let about = []
    try {
      about = memory?.recall?.('小黑盒 游戏 帖子 兴趣', { limit: 6 }) || []
    } catch { about = [] }
    const aboutText = (Array.isArray(about) ? about : []).map((m) => '- ' + (m.text || m)).join('\n') || '（暂无）'

    // 分享额度 + 积极程度（和 B 站同一套思路：让模型判断值不值得分享，代码只负责发）
    const shareLeft = Math.max(0, left('share'))
    const bias = String(c.shareBias || 'normal')
    const shareHint = bias === 'stingy'
      ? `只有你觉得${owner || '主人'}一定会喜欢才写 share，拿不准就空着。`
      : bias === 'proactive'
        ? `看到有趣、有信息量、值得${owner || '主人'}一看的就写 share，不用太吝啬。`
        : `你觉得${owner || '主人'}会喜欢才写 share，不然空字符串。`

    const prompt = [
      '【刷小黑盒，不是聊天，这一轮不会发到 QQ，只按最后那段格式回】',
      owner ? `主人是 ${owner}。` : '',
      `你记得的关于游戏/社区的事：
${aboutText}`,
      '先看热榜挑一个游戏相关的题（电竞和商业新闻不适合），再看社区高赞帖在聊什么角度，然后决定这次做什么。',
      '只读浏览不用征求同意；要发帖、点赞、评论的话，先按你的自检清单过一遍再动手。',
      '要是哪个接口回了「要安全验证」「操作太频繁」或者干脆没响应，这一轮就停手，别换接口重试、别反复点——重试只会把冷却拖得更久。',
      `最后只输出一个 JSON 对象，不要别的字：{"note":"一两句话说说你这一轮看了什么、做了什么","share":"想私聊分享给${owner || '主人'}的一句话（${shareHint}）","linkId":"要分享的那条帖子的编号（没有就空字符串）","remember":"值得长期记住的一件事（没有就空字符串）"}。`,
      shareLeft <= 0 ? '今天的分享额度用完了，share 一律留空。' : `这次最多分享 ${shareLeft} 条。`,
    ].filter(Boolean).join('\n\n')

    const out = await hub.runSystemTurn('heybox', 'QQ · 刷小黑盒', prompt, { timeoutMs: 240000 })
    const verdict = pickJson(String(out || ''), null)
    const note = String((verdict && verdict.note) || out || '').trim()
    bump('browse')
    const st = readState()
    st.lastRun = nowMs()
    st.lastSkipReason = ''
    writeState(st)
    pushHistory({ kind: 'browse', note: note.slice(0, 80) })

    // 分享给主人：和 B 站一样，模型说值得就私聊发过去（带帖子链接）
    let shared = null
    try {
      shared = await shareToOwner(verdict, { owner: owner || getConfig().ownerName || '主人' })
    } catch (e) { log?.warn?.('小黑盒分享失败：' + e.message) }


    // 想留下的东西写进记忆
    try {
      const t = note
      if (t && t.length > 10) memory?.addEvent?.({ text: `我在小黑盒逛了一圈：${t.slice(0, 120)}`, tags: ['小黑盒'], importance: 0.45 })
    } catch { /* 记忆模块没在跑就算了 */ }

    return {
      ok: true,
      message: note.slice(0, 300) || '逛完了',
      shared: shared && shared.ok ? shared : null,
      shareError: shared && shared.ok === false ? shared.message : '',
      session: 'system:ext-heybox',
    }
  }

  // ── 谷时逛：避开峰时，省 token ─────────────────────────────
  //
  // 峰时 = 工作日 9-12 与 14-18（左闭右开）。这段时间模型排队久、单价高，
  // 她逛一轮要拉好几条帖子 + 跑一次后台会话，token 花得多。
  // 打开「只在谷时逛」之后，峰时到点也不跑，等她空下来再逛。

  /** 现在是不是峰时（工作日的高峰段）。周末默认不算峰时（peakWeekend=false）。 */
  function isPeakTime(at = new Date()) {
    const c = getConfig().heybox || {}
    const day = at.getDay() // 0=周日 … 6=周六
    const weekend = day === 0 || day === 6
    if (weekend && !c.peakWeekend) return false
    const h = at.getHours()
    const inRange = (h0, h1) => h >= Number(h0) && h < Number(h1)
    return inRange(c.peakStartAM ?? 9, c.peakEndAM ?? 12) || inRange(c.peakStartPM ?? 14, c.peakEndPM ?? 18)
  }

  /** 峰时段的人话描述（面板和日志里用） */
  function peakText() {
    const c = getConfig().heybox || {}
    const hh = (n) => String(n).padStart(2, '0') + ':00'
    return `${hh(c.peakStartAM ?? 9)}-${hh(c.peakEndAM ?? 12)}、${hh(c.peakStartPM ?? 14)}-${hh(c.peakEndPM ?? 18)}（${c.peakWeekend ? '含周末' : '仅工作日'}）`
  }

  async function tick({ memory, owner } = {}) {
    const c = getConfig().heybox || {}
    if (!c.enabled || !c.autoBrowse || !hasLogin()) return
    if (risk().leftMs > 0) return // 冷却期内定时也别试，省得每次都把风控拖长
    const st = readState()
    // 谷时逛：开着且现在是峰时，这一拍就不跑（不占额度、不花 token）
    if (c.offPeakOnly && isPeakTime()) {
      if (!st.peakSkipAt || nowMs() - st.peakSkipAt > 30 * 60_000) {
        st.peakSkipAt = nowMs()
        st.lastSkipReason = `峰时（${peakText()}），等谷时再逛`
        writeState(st)
        log?.info?.('小黑盒：现在是峰时，这一轮先不逛')
      }
      return
    }
    if (st.retryAt && nowMs() < st.retryAt) return // 上次失败了，退避期内先不重试
    const gap = (Number(c.intervalHours) || 4) * 3600_000
    if (st.lastRun && nowMs() - st.lastRun < gap) return
    if (left('browse') <= 0) {
      st.lastSkipReason = '今天逛的轮数到上限了'
      writeState(st)
      return
    }
    try {
      const r = await runDuty({ memory, owner })
      // ⚠ 写盘前必须重读：runDuty 内部 bump 了额度、也写了 lastRun，
      // 拿开头那份旧 st 覆盖会把它们冲掉（额度永远不涨、lastRun 不更新 → 每分钟重复跑）。
      const fresh = readState()
      if (!r.ok) {
        // runDuty 返回的失败（没开 / 没登录 / 冷却 / 额度）不算技术故障，不用退避
        fresh.failures = 0
        fresh.retryAt = 0
        fresh.lastSkipReason = r.message
        writeState(fresh)
        return
      }
      fresh.failures = 0
      fresh.retryAt = 0
      writeState(fresh)
      log?.info?.('小黑盒后台会话跑完：' + r.message.slice(0, 40))
    } catch (e) {
      // 真正的技术故障（会话卡住、模型超时、宿主没回来）：指数退避，别每分钟硬撞一次
      const fresh = readState()
      const n = Math.min(6, (Number(fresh.failures) || 0) + 1)
      fresh.failures = n
      fresh.retryAt = nowMs() + RETRY_BACKOFF_MS[Math.min(RETRY_BACKOFF_MS.length - 1, n - 1)]
      fresh.lastSkipReason = e.message
      writeState(fresh)
      log?.warn?.(`小黑盒后台会话失败（第 ${n} 次，${Math.round((fresh.retryAt - nowMs()) / 60_000)} 分钟后才重试）：` + e.message)
    }
  }


  async function account(force = false) {
    const st = readState()
    const ck = cookie()
    if (!ck) {
      const next = { loggedIn: false, message: '还没填 Cookie', checkedAt: nowMs(), nickname: '', heyboxId: '' }
      st.account = next
      writeState(st)
      return { ok: true, ...next }
    }
    if (!force && st.account.checkedAt && nowMs() - st.account.checkedAt < 10 * 60_000) return { ok: true, ...st.account }
    try {
      const d = await getClient().get('/account/restore_login')
      const r = d.result || {}
      const profile = r.profile || r.account_detail || {}
      const next = {
        loggedIn: true,
        nickname: String(profile.username ?? profile.nickname ?? ''),
        heyboxId: String(profile.heybox_id ?? r.heybox_id ?? ''),
        message: '',
        checkedAt: nowMs(),
      }
      st.account = next
      writeState(st)
      return { ok: true, ...next }
    } catch (e) {
      const next = { loggedIn: false, nickname: '', heyboxId: '', message: e.message, checkedAt: nowMs() }
      st.account = next
      writeState(st)
      return { ok: true, ...next }
    }
  }

  function saveCookie(raw) {
    const s = String(raw || '').trim()
    if (!s) return { ok: false, message: 'Cookie 是空的' }
    if (!/pkey=/.test(s)) return { ok: false, message: '这串 Cookie 里没有 pkey，多半没复制全' }
    clientCookie = s
    client = null
    const st = readState()
    st.account = { ...DEFAULT_STATE.account }
    // 换了新会话（通常是浏览器验证后收回来的）：冷却一并解除，不然还会挡着不让用
    st.risk = { level: 0, until: 0, reason: '', at: 0 }
    writeState(st)
    return { ok: true, cookie: s, message: /x_xhh_tokenid=/.test(s) ? 'Cookie 存好了（有发帖令牌，写操作也能用）' : 'Cookie 存好了（缺 x_xhh_tokenid，点赞评论可能会被拒）' }
  }

  function clearQuota() {
    const st = readState()
    st.quota = { date: today(), like: 0, comment: 0, post: 0, browse: 0, share: 0 }
    writeState(st)
    return { ok: true, message: '今天的小黑盒额度清零了' }
  }

  function state() {
    const st = readState()
    const c = getConfig().heybox || {}
    return {
      ...st,
      quota: quota(),
      limits: { likeDaily: c.likeDaily, commentDaily: c.commentDaily, maxPostsPerDay: c.maxPostsPerDay, maxRunsPerDay: c.maxRunsPerDay, shareDaily: c.shareDaily },
      left: { like: left('like'), comment: left('comment'), post: left('post'), browse: left('browse'), share: left('share') },
      hasCookie: Boolean(cookie()),
      hasToken: /x_xhh_tokenid=/.test(cookie()),
      // 谷时逛：面板上要显示「现在是峰时吗」「峰时段是什么」
      peak: { on: Boolean(c.offPeakOnly), now: isPeakTime(), text: peakText(), weekend: Boolean(c.peakWeekend) },
      risk: { ...risk(), tier: 'search 8s / detail 2.5s / feed 1.2s / 写 3s（都带 ±20% 抖动）' },
      verifier: verifier?.status?.() || null,
      topics: TOPICS,
    }
  }

  // ── 扫码登录（纯接口，不开浏览器窗口） ──────────────────────
  //
  // 面板点「扫码登录」→ 拿到二维码 → 主人用 App 扫 → 轮询到 pkey → 存配置。
  // 这条路比开浏览器友好得多，所以 captcha 也优先用它（见 verifyStart）。

  let qrSession = null // { token, at, cookies }

  /** 第一步：拿二维码（返回 PNG dataURL，面板直接显示；也可以发到 QQ） */
  async function qrStart() {
    try {
      const r = await startQrLogin()
      qrSession = { token: r.token, at: nowMs(), cookies: {} }
      return { ok: true, token: r.token, png: r.png, qrUrl: r.qrUrl, expire: r.expire, message: '用小黑盒 App 扫上面这个码（' + Math.round(r.expire / 60) + ' 分钟内有效）' }
    } catch (e) {
      qrSession = null
      return { ok: false, message: '拿二维码失败：' + e.message }
    }
  }

  /** 第二步：轮询扫码结果；扫成了就把 Cookie 存进配置、清冷却 */
  async function qrPoll() {
    if (!qrSession) return { ok: false, state: 'none', message: '先点「扫码登录」拿二维码' }
    if (nowMs() - qrSession.at > 5 * 60_000) {
      qrSession = null
      return { ok: false, state: 'expired', message: '二维码过期了，重新拿一个' }
    }
    try {
      const r = await pollQrLogin(qrSession.token, qrSession.cookies)
      qrSession.cookies = r.cookies || qrSession.cookies
      if (r.state !== 'ok') {
        const s = r.state
        return {
          ok: s !== 'unknown',
          state: s,
          message: s === 'wait' ? '还没扫，或者扫了还没在手机上确认' : s === 'ready' ? '扫到了，等手机上点确认' : s === 'expired' ? '二维码过期了，重新拿一个' : '状态：' + s,
        }
      }
      if (!r.hasPkey) return { ok: false, state: 'no-pkey', message: '扫成功了，但服务端没给 pkey，再扫一次试试' }
      const saved = saveCookie(r.cookie)
      if (!saved.ok) return { ok: false, state: 'save-failed', message: saved.message }
      qrSession = null
      return {
        ok: true,
        state: 'ok',
        cookie: saved.cookie,
        nickname: r.nickname || '',
        heyboxId: r.heyboxId || '',
        verified: r.verified,
        message: '扫码登录成功' + (r.nickname ? '：' + r.nickname : '') + '，冷却也解除了',
      }
    } catch (e) {
      return { ok: false, state: 'error', message: '查扫码状态失败：' + e.message }
    }
  }

  // ── 安全验证通道（接口被 show_captcha 挡住时用） ──────────────
  //
  // 小黑盒的验证码挂在浏览器会话上，算签名绕不过去。做法和 dph-heybox / xiaoheihe-cli 一致：
  // 开一个有界面的真浏览器 → 用户自己点完 → 把浏览器里的 Cookie 收回来给接口用。

  /**
   * 统一入口：要验证了怎么办。
   *   默认（verifyMode=qr）→ 直接给扫码二维码，**不开浏览器窗口**；
   *   verifyMode=browser → 后台开浏览器（窗口默认在屏幕外）。
   */
  async function verifyStart() {
    const mode = String((getConfig().heybox || {}).verifyMode || 'qr')
    if (mode === 'browser') {
      if (!verifier) return { ok: false, mode, message: '这个环境没有浏览器通道（要 Edge 或 Chrome）' }
      const r = await verifier.begin({ visible: false })
      return { ...r, mode }
    }
    // 扫码优先：不开窗口、不抢前台，手机上扫一下就行
    const r = await qrStart()
    return { ...r, mode: 'qr' }
  }

  /** 浏览器兜底：把窗口挪进屏幕 / 挪回屏幕外（默认不显示，这是主人主动要看的） */
  async function verifyShow(visible = true) {
    if (!verifier) return { ok: false, message: '这个环境没有浏览器通道' }
    return verifier.showWindow(Boolean(visible))
  }

  /** 用户点完验证后调：收 Cookie → 存进配置 → 清冷却 */
  async function verifyFinish() {
    if (!verifier) return { ok: false, message: '这个环境没有浏览器通道' }
    const r = await verifier.finish()
    if (!r.ok) return r
    const saved = saveCookie(r.cookie)
    if (!saved.ok) return { ...saved, shot: r.shot }
    return {
      ok: true,
      cookie: saved.cookie,
      message: saved.message + '，冷却也解除了',
      shot: r.shot,
      hasPkey: r.hasPkey,
    }
  }

  /** 手动解除冷却（用户确认「我这边验证过了」的时候用，不用等阶梯自动回落） */
  function clearRisk() {
    const info = getClient().clearRisk()
    return { ok: true, message: '冷却解除了，可以继续用', risk: info }
  }

  log?.info?.('小黑盒模块起来了' + (cookie() ? '' : '（还没填 Cookie）'))

  return {
    feed, feedReport, detail, watch, hot, search, topicList,
    like, comment, remove, post, browse, tick, account, saveCookie, clearQuota, state,
    risk, clearRisk, verifyStart, verifyFinish, verifyShow, qrStart, qrPoll, shareToOwner,
    linkIdOf, postBrief, POST_STYLES, DEFAULT_POST_STYLE, runDuty,
  }
}
