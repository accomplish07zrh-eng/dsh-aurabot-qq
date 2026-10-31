// 图文日记只取表情、公开浏览记录和主人明确指定的目录，不读取聊天流水或私人记忆。

import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, realpathSync, readFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { stickerPath } from '../../features/stickers.js'
import { loadShots, shotPath } from '../../bili/shots.js'
import { dataDir } from '../../core/store.js'
import { clipText } from '../../core/text.js'

export const clip = (value, max = 160) => clipText(String(value || '').replace(/[\r\n\t]+/g, ' ').trim(), max)
export const sourceId = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 28)
export const publicText = (value) => !/(?:cookie|sessionid|access.token|验证码|身份证|银行卡|密码|手机号|住址|病历|私聊原文|\b\d{7,}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i.test(String(value))

export function imageFolder(value) {
  const folder = String(value || '').trim()
  if (!folder) return ''
  if (!isAbsolute(folder)) throw new Error('请填写图片文件夹的完整路径')
  const path = resolve(folder)
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error('图片目录不能是链接，且必须是文件夹')
  return realpathSync(path)
}

export function insideFolder(root, file) {
  const rel = relative(root, file)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

// 只信任本模块的归档格式；重新校验链接，避免手改 sidecar 把登录参数带回空间。
function archiveMetadata(file) {
  try {
    const sidecar = file + '.json'
    const stat = lstatSync(sidecar)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return {}
    const metadata = JSON.parse(readFileSync(sidecar, 'utf8'))
    if (metadata.schema !== 1 || metadata.kind !== 'browsing') return {}
    const url = new URL(metadata.url)
    let id = ''
    if (metadata.platform === 'B站') id = /^\/video\/(BV\w{10})\/?$/.exec(url.pathname)?.[1]
    if (metadata.platform === '抖音') id = /^\/(?:video|note)\/(\d{5,25})\/?$/.exec(url.pathname)?.[1]
    if (metadata.platform === '小红书') id = /^\/explore\/([a-f0-9]{24})\/?$/i.exec(url.pathname)?.[1]
    if (metadata.platform === '触站') id = /^\/draw\/(\d{1,15})\/?$/.exec(url.pathname)?.[1]
    if (metadata.platform === '淘宝') id = url.searchParams.get('id')
    const canonical = sourceLink(metadata.platform, { id })
    if (!canonical || new URL(canonical).hostname !== url.hostname) return {}
    const title = clip(metadata.title, 70)
    const author = clip(metadata.author, 40)
    if (!title || !publicText(title + author)) return {}
    return { sourceKind: 'browsing', platform: metadata.platform, title, author, url: canonical, caption: '浏览归档：' + metadata.platform + '《' + title + '》' }
  } catch (error) { return {} }
}

/** 最多三层、1500 个目录项、60 张图；空目录配置不会扫描任何地方。 */
export function localPictures(folder) {
  const root = imageFolder(folder)
  if (!root) return []
  const queue = [{ dir: root, depth: 0 }]
  const files = []
  let entries = 0
  while (queue.length && entries < 1500) {
    const { dir, depth } = queue.shift()
    let items
    try { items = readdirSync(dir, { withFileTypes: true }) } catch (error) { continue }
    for (const item of items) {
      if (++entries > 1500) break
      if (item.isSymbolicLink()) continue
      const file = join(dir, item.name)
      try {
        const stat = lstatSync(file)
        if (stat.isSymbolicLink() || !insideFolder(root, realpathSync(file))) continue
        if (stat.isDirectory() && depth < 3) queue.push({ dir: file, depth: depth + 1 })
        if (!stat.isFile() || !/\.(png|jpe?g|gif|webp)$/i.test(file) || stat.size <= 0 || stat.size > 8 * 1024 * 1024) continue
        const caption = clip(basename(file, extname(file)), 60)
        if (!publicText(caption)) continue
        files.push({ id: 'local:' + sourceId(file), kind: 'local', src: file, root, caption, at: stat.mtimeMs, ...archiveMetadata(file) })
      } catch (error) { /* 文件被移动或无法读取时跳过。 */ }
    }
  }
  return files.sort((a, b) => b.at - a.at).slice(0, 60)
}

function remoteImage(value) {
  try {
    const url = new URL(value)
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : ''
  } catch (error) { return '' }
}

// 公开作品链接重新构造，不把 Cookie、分享令牌或任意查询参数带进正文。
function sourceLink(platform, item) {
  const id = String(item.id || item.bvid || '')
  if (platform === 'B站' && /^BV[\w]{10}$/.test(id)) return 'https://www.bilibili.com/video/' + id
  if (platform === '抖音' && /^\d{5,25}$/.test(id)) return 'https://www.douyin.com/video/' + id
  if (platform === '小红书' && /^[a-f0-9]{24}$/i.test(id)) return 'https://www.xiaohongshu.com/explore/' + id
  if (platform === '淘宝' && /^\d{5,25}$/.test(id)) return 'https://item.taobao.com/item.htm?id=' + id
  if (platform === '触站' && /^\d{1,15}$/.test(id)) return 'https://www.huashi6.com/draw/' + id
  return ''
}

export function collectSources(api, settings, history = [], now = Date.now()) {
  const events = []
  const pictures = []
  const seen = new Set()
  const used = new Set(history.filter((row) => row.ok && !row.dryRun).slice(0, 4).flatMap((row) => (row.media || []).map((image) => image.sourceId)))
  const add = (picture) => {
    if (!picture.src || seen.has(picture.src)) return
    seen.add(picture.src)
    pictures.push({ ...picture, recent: used.has(picture.id) })
  }
  if (settings.browsing) {
    const platforms = [
      ['bili', 'B站', ['watch', 'share']],
      ['xhs', '小红书', ['read', 'share']],
      ['douyin', '抖音', ['read', 'share']],
      ['taobao', '淘宝', ['select', 'share']],
      ['huashi6', '触站', ['read', 'share']],
    ]
    for (const [id, platform, kinds] of platforms) {
      let rows = []
      try { rows = api.use(id)?.state?.()?.history || [] } catch (error) { continue }
      if (!Array.isArray(rows)) continue
      for (const row of rows.slice(0, 80)) {
        if (!row || typeof row !== 'object') continue
        if (!kinds.includes(row.kind) || row.ok === false || row.dryRun || !(row.at >= now - 48 * 3600_000 && row.at <= now)) continue
        const items = row.note ? [row.note] : row.item ? [row.item] : Array.isArray(row.items) ? row.items.slice(0, 2) : [row]
        for (const item of items) {
          if (!item || typeof item !== 'object') continue
          const title = clip(item.title || row.title, 70)
          const author = clip(item.author, 40)
          const url = sourceLink(platform, item)
          if (!title || !url || !publicText(title + author)) continue
          const key = id + ':' + sourceId(url)
          if (events.some((event) => event.id === key)) continue
          // 不沿用评论、私信或模型旧感想，避免把私人信息写进公开日记。
          events.push({ id: key, text: `浏览了${platform}的公开作品《${title}》`, at: Number(row.at) })
          add({ id: key, kind: 'browsing', src: remoteImage(item.cover || item.images?.[0]), caption: platform + '《' + title + '》', title, author, platform, url, at: Number(row.at) })
        }
      }
    }
    // 只读已有 B 站视频抽帧，不调用会裁剪图库的 panel()，也不抓取桌面。
    for (const item of loadShots().items.slice(0, 40)) {
      const title = clip(item.title, 70)
      const url = sourceLink('B站', item)
      if (!url || !title || !publicText(title) || !(item.at >= now - 48 * 3600_000 && item.at <= now)) continue
      add({ id: 'bili-shot:' + item.md5, kind: 'browsing', localShot: true, src: shotPath(item), root: dataDir('bili-shots'), caption: 'B站视频抽帧《' + title + '》', title, platform: 'B站', url, at: item.at })
    }
  }
  if (settings.stickers) {
    let items = []
    try { items = api.use('stickers')?.library?.()?.items || [] } catch (error) {}
    if (!Array.isArray(items)) items = []
    for (const item of items.slice(-300)) {
      if (!item || typeof item.file !== 'string' || basename(item.file) !== item.file || /[\\/]/.test(item.file) || !/\.(png|jpe?g|gif|webp)$/i.test(item.file)) continue
      const caption = clip([item.name, ...(Array.isArray(item.tags) ? item.tags : [])].filter(Boolean).join(' · '), 100)
      if (!caption || !publicText(caption)) continue
      const src = stickerPath(item)
      if (src) add({ id: 'sticker:' + item.md5, kind: 'sticker', src, root: dataDir('stickers'), caption, at: item.at || 0 })
    }
  }
  let folderError = ''
  if (settings.local && settings.folder) {
    try { localPictures(settings.folder).forEach(add) }
    catch (error) { folderError = '指定的图片目录无法读取，请检查路径和权限。' }
  }
  return { events: events.slice(0, 18), pictures, folderError }
}
