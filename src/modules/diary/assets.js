// 预览和发布用同一份已缓存的图片；外部请求逐跳检查，接口只接受内容摘要。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, lstatSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertPublicUrl, fetchImage } from '../../core/net.js'
import { imageSize, mimeOf } from '../../chat/inbound.js'
import { insideFolder } from './sources.js'

const MAX_BYTES = 8 * 1024 * 1024

export async function downloadImage(src) {
  const initial = new URL(src)
  if (initial.username || initial.password) throw new Error('配图地址含登录信息')
  let url = src
  const deadline = AbortSignal.timeout(20_000)
  for (let redirects = 0; redirects < 4; redirects++) {
    await assertPublicUrl(url)
    const response = await fetch(url, { redirect: 'manual', signal: deadline })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location')
      await response.body?.cancel()
      if (!next) throw new Error('配图跳转缺少地址')
      const target = new URL(next, url)
      if (target.username || target.password) throw new Error('配图地址含登录信息')
      url = target.href
      continue
    }
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) {
      await response.body?.cancel()
      throw new Error('配图无法下载或超过 8MB')
    }
    const reader = response.body.getReader()
    const chunks = []
    let length = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > MAX_BYTES) {
        await reader.cancel()
        throw new Error('配图超过 8MB')
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  }
  throw new Error('配图跳转过多')
}

export function createDiaryAssets(dir, { download = downloadImage } = {}) {
  const path = (id) => /^[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(String(id)) ? join(dir, id) : ''
  function store(bytes) {
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mimeOf(bytes)]
    const size = imageSize(bytes)
    if (!ext || bytes.length < 32 || bytes.length > MAX_BYTES || !size.width || !size.height) throw new Error('配图不是有效图片或超过 8MB')
    const id = createHash('md5').update(bytes).digest('hex') + '.' + ext
    mkdirSync(dir, { recursive: true })
    if (!existsSync(path(id))) writeFileSync(path(id), bytes, { flag: 'wx' })
    return id
  }
  async function materialize(picture) {
    let bytes
    if (picture.kind === 'browsing' && !picture.localShot) bytes = await download(picture.src)
    else {
      // 目录扫描与实际读取之间再次检查，链接或越界文件不能混进选图。
      if (picture.root) {
        if (lstatSync(picture.src).isSymbolicLink() || !insideFolder(picture.root, realpathSync(picture.src))) throw new Error('配图已经移出授权目录')
      }
      bytes = await fetchImage(picture.src, { maxBytes: MAX_BYTES })
    }
    return {
      id: store(bytes), sourceId: picture.id, kind: picture.kind,
      sourceKind: picture.sourceKind || '',
      caption: picture.caption, title: picture.title || '', author: picture.author || '',
      platform: picture.platform || '', url: picture.url || '',
    }
  }
  function read(id) {
    const file = path(id)
    if (!file || !existsSync(file)) throw new Error('配图不存在')
    return readFileSync(file)
  }
  return { store, materialize, path, read }
}
