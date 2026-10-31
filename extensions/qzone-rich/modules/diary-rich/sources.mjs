import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

export const clip = (value, max = 200) => String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max)
export const hash = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 28)
export const defaults = { enabled: true, stickers: true, browsing: true, local: true, cards: true, folder: '', maxImages: 2 }
export const publicText = (value) => !/(?:cookie|sessionid|access.token|验证码|身份证|银行卡|密码|手机号|住址|病历|私聊原文|\b\d{7,}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i.test(String(value))
export const browsingText = (value) => clip(value, 180).replace(/(?:光有|只有)店名(?:不给图|没图)/g, '只读取到商品文字资料').replace(/图也?不给看|(?:图|图片)也?(?:都)?没(?:放|给)|不给图/g, '我这里只读到文字，未解析图片')
export function imageFolder(value) {
  const folder = String(value || '').trim().replace(/^"(.*)"$/, '$1')
  if (!folder) return ''
  if (!isAbsolute(folder)) throw new Error('请填写图片文件夹的完整路径')
  try { if (!statSync(folder).isDirectory()) throw new Error('not-dir') } catch { throw new Error('图片文件夹不存在或无法读取') }
  return resolve(folder)
}
export function localPictures(folder) {
  if (!folder) return []
  const root = imageFolder(folder), queue = [{ dir: root, depth: 0 }], files = []; let entries = 0
  while (queue.length && entries < 1500) {
    const row = queue.shift(); let items
    try { items = readdirSync(row.dir, { withFileTypes: true }) } catch { continue }
    for (const item of items) {
      if (++entries > 1500) break
      if (item.isSymbolicLink()) continue
      const path = join(row.dir, item.name)
      if (item.isDirectory() && row.depth < 3) queue.push({ dir: path, depth: row.depth + 1 })
      else if (item.isFile() && /\.(png|jpe?g|gif|webp)$/i.test(item.name)) {
        const s = statSync(path)
        if (s.size > 0 && s.size <= 8 * 1024 * 1024) {
          let meta={};try{const side=path+'.json';if(statSync(side).size<65536){const value=JSON.parse(readFileSync(side,'utf8'));if(value.schema===1&&value.kind==='browsing')meta={sourceKind:'browsing',platform:clip(value.platform,30),title:clip(value.title,120),author:clip(value.author,60),url:remoteImage(value.url),caption:'浏览归档：'+clip(value.platform,30)+'《'+clip(value.title,80)+'》'}}}catch{}
          files.push({ id: 'local:' + hash(path), kind: 'local', src: path, caption: clip(basename(path, extname(path)), 60), at: s.mtimeMs, ...meta })
        }
      }
    }
  }
  return files.sort((a, b) => b.at - a.at).slice(0, 60)
}
const remoteImage = (value) => {
  try { const u = new URL(value); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : '' } catch { return '' }
}
function sourceLink(platform, item) {
  const id = String(item.id || '')
  if (platform === '抖音' && /^\d{5,25}$/.test(id)) return `https://www.douyin.com/${item.kind === 'image' ? 'note' : 'video'}/${id}`
  if (platform === '小红书' && /^[a-f0-9]{24}$/i.test(id)) return 'https://www.xiaohongshu.com/explore/' + id
  if (platform === '淘宝' && /^\d{5,25}$/.test(id)) return 'https://item.taobao.com/item.htm?id=' + id
  if (platform === '触站' && /^\d{1,15}$/.test(id)) return 'https://www.huashi6.com/draw/' + id
  return ''
}
export function collectSources(api, settings, history = [], now = Date.now()) {
  const events = [], pictures = [], seenEvents = new Set(), seenPictures = new Set(), used = new Set(history.filter((x) => x.ok && !x.dryRun).slice(0, 4).flatMap((x) => (x.images || []).map((i) => i.sourceId)))
  const addPicture = (p) => { if (!p.src || seenPictures.has(p.src)) return; seenPictures.add(p.src); pictures.push({ ...p, recent: used.has(p.id) }) }
  const recent = (at) => Number(at) <= now && Number(at) >= now - 48 * 3600_000
  const addEvent = (id, text, at, platform) => {
    const clean = clip(text, 260)
    if (!clean || !recent(at) || !publicText(clean) || seenEvents.has(clean)) return
    seenEvents.add(clean); events.push({ id, text: clean, at: Number(at), platform })
  }
  for (const [id, platform, kinds] of [['bili', 'B站', ['watch', 'share', 'comment']], ['xhs', '小红书', ['read', 'share']], ['douyin', '抖音', ['read', 'share']], ['taobao', '淘宝', ['select', 'share']], ['huashi6', '触站', ['read', 'share']]]) {
    let rows = []
    try { rows = api.use(id)?.state?.()?.history || [] } catch {}
    for (const row of rows.filter((r) => kinds.includes(r.kind) && recent(r.at) && r.ok !== false && !r.dryRun).slice(0, 16)) {
      const items = row.note ? [row.note] : row.item ? [row.item] : row.items?.length ? row.items.slice(0, 2) : [row]
      for (const item of items) {
        const title = clip(item.title || row.title, 70), feeling = browsingText(row.text || row.note?.text)
        if (!title || !publicText(title + feeling)) continue
        const key = `${id}:${item.id || row.bvid || hash(title)}`
        addEvent(key, `${platform === '淘宝' ? '逛淘宝挑选候选，并未购买' : platform === '触站' && item.vision?.state === 'seen' ? '在触站看了画作预览' : '在' + platform + '浏览文字资料'}《${title}》${feeling ? '：' + feeling : ''}`, row.at, platform)
        if (settings.browsing && events.some((x) => x.id === key)) {
          const src = remoteImage(item.cover || item.images?.[0])
          if (src) addPicture({ id: 'browse:' + key, kind: 'browsing', src, caption: `浏览摘记：${platform}《${title}》`, title, platform, author: clip(item.author, 40), url: sourceLink(platform, item), eventId: key, at: row.at })
        }
      }
    }
  }
  let memories = []
  try { memories = api.use('memory')?.recentEvents?.(48, 40) || [] } catch {}
  for (const m of memories) {
    if (m.about || m.invalidAt || m.supersededBy || m.source !== 'event' || !(m.tags || []).some((t) => ['B站', '小红书', '抖音', '淘宝', '触站', '翻唱', '唱歌', '生图'].includes(t))) continue
    if (/失败|未完成|没有搜到|找到\s*0\s*条|未播放|未提交/.test(m.text)) continue
    addEvent('memory:' + m.id, m.text, m.at, '经历')
  }
  if (settings.stickers) {
    let items = []
    try { const library = api.use('stickers')?.library?.(); items = library?.items || [] } catch {}
    const pathOf = api.lib('features/stickers.js').stickerPath
    for (const item of items.filter((x) => x.name || x.tags?.length)) {
      const src = pathOf(item)
      if (existsSync(src)) addPicture({ id: 'sticker:' + item.md5, kind: 'sticker', src, caption: clip([item.name, ...(item.tags || [])].join(' · '), 100), at: item.at || 0 })
    }
  }
  let folderError = ''
  if (settings.local && settings.folder) {
    try { for (const p of localPictures(settings.folder)) addPicture(p) } catch (error) { folderError = error.message }
  }
  return { events: events.sort((a, b) => b.at - a.at).slice(0, 18), pictures, folderError }
}
export function rankPictures(pictures, text, random = Math.random) {
  const words = String(text || '').match(/[\p{Script=Han}]{2,}|[a-z]{3,}/giu) || []
  const score = (p) => {
    let n = p.recent ? -10 : 0
    for (const w of words) {
      if (p.caption.includes(w)) n += 4
      else for (let i = 0; i < w.length - 1; i++) if (p.caption.includes(w.slice(i, i + 2))) n += 1
    }
    return n + (p.kind === 'browsing' ? 2 : 0) + random()
  }
  return pictures.map((p) => ({ p, score: score(p) })).sort((a, b) => b.score - a.score).map((x) => x.p)
}
