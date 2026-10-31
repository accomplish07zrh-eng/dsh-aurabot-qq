import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export function createAssets(api, injected = {}) {
  const dir = api.dataDir('images'); mkdirSync(dir, { recursive: true })
  const { imageSize, mimeOf } = api.lib('chat/inbound.js'), { fetchImage, assertPublicUrl } = api.lib('core/net.js')
  const download = injected.download || (async (src) => {
    if (!/^https?:\/\//i.test(src)) return fetchImage(src, { maxBytes: 8 * 1024 * 1024 })
    let url = src
    for (let i = 0; i < 4; i++) {
      await assertPublicUrl(url)
      const host=new URL(url).hostname
      const referer=/huashi6\.com$/.test(host)?'https://www.huashi6.com/':/hdslb\.com$/.test(host)?'https://www.bilibili.com/':/alicdn\.com$|taobaocdn\.com$/.test(host)?'https://item.taobao.com/':/xhscdn\.com$/.test(host)?'https://www.xiaohongshu.com/':/douyinpic\.com$|byteimg\.com$/.test(host)?'https://www.douyin.com/':''
      const response = await fetch(url, { redirect: 'manual', headers:{'User-Agent':'Mozilla/5.0',...(referer?{Referer:referer}:{})}, signal: AbortSignal.timeout(12000) })
      if ([301, 302, 303, 307, 308].includes(response.status)) { const next = response.headers.get('location'); await response.body?.cancel(); if (!next) throw new Error('配图跳转缺少地址'); url = new URL(next, url).href; continue }
      if (!response.ok) { await response.body?.cancel(); throw new Error('配图 HTTP ' + response.status) }
      if (Number(response.headers.get('content-length')) > 8 * 1024 * 1024) { await response.body?.cancel(); throw new Error('配图超过 8MB') }
      const reader = response.body.getReader(), chunks = []; let length = 0
      for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('配图超过 8MB') }; chunks.push(value) }
      return Buffer.concat(chunks)
    }
    throw new Error('配图跳转过多')
  })
  const path = (id) => /^[a-f0-9]{32}\.(png|jpe?g|gif|webp)$/.test(String(id)) ? join(dir, id) : ''
  function store(bytes) {
    const mime = mimeOf(bytes), size = imageSize(bytes), ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mime]
    if (!ext || bytes.length > 8 * 1024 * 1024 || bytes.length < 32 || !size.width || !size.height) throw new Error('配图不是有效图片，或超过 8MB')
    const id = createHash('md5').update(bytes).digest('hex') + '.' + ext
    if (!existsSync(path(id))) writeFileSync(path(id), bytes)
    return id
  }
  async function materialize(p) { return { id: store(await download(p.src)), sourceId: p.id, kind: p.kind, sourceKind:p.sourceKind||'', caption: p.caption, title: p.title || '', platform: p.platform || '', url: p.url || '' } }
  function read(id) { const file = path(id); if (!file || !existsSync(file)) throw new Error('配图已不存在'); return readFileSync(file) }
  return { materialize, store, read, path }
}
