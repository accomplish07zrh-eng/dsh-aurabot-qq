import { createRichDiary } from './engine.mjs'
import { defaults, imageFolder, localPictures } from './sources.mjs'

const panelRequest = (req) => req.method === 'POST' && req.headers?.['x-aurabot-diary'] === '1'
export default {
  id: 'diary-rich', name: '空间日记 · 图文生活', version: '0.1.0', api: 1, tab: 'diary', panel: 'panel.js', defaults,
  description: '按真实经历写空间日记，自选表情、浏览图、日常图库或手记卡；支持只预览。',
  setup(api) {
    const diary = createRichDiary(api), { http } = api.core
    api.route('/state', () => diary.state())
    api.route('/preview', async (req) => panelRequest(req) ? diary.writeDiary({ preview: true }) : { ok: false, message: '请从日记页生成预览' })
    api.route('/settings', async (req) => {
      if (!panelRequest(req)) return { ok: false, message: '请从日记页修改配图设置' }
      const body = await http.body(req), patch = {}
      for (const key of ['enabled', 'stickers', 'browsing', 'local', 'cards']) if (typeof body[key] === 'boolean') patch[key] = body[key]
      if (body.maxImages !== undefined) patch.maxImages = Math.max(1, Math.min(4, Math.floor(Number(body.maxImages) || 2)))
      api.saveSettings(patch); diary.invalidate(); return { ok: true }
    })
    api.route('/folder', async (req) => {
      if (!panelRequest(req)) return { ok: false, message: '请从日记页读取图片文件夹' }
      try {
        const folder = imageFolder((await http.body(req)).folder), count = folder ? localPictures(folder).length : 0
        api.saveSettings({ folder }); diary.invalidate(); return { ok: true, count, message: folder ? `已读取 ${count} 张可用图片` : '已清空日常图库路径' }
      } catch (error) { return { ok: false, message: error.message } }
    })
    api.route('/image', (req, res) => {
      try { const bytes = diary.image(http.query(req).id); res.setHeader?.('Cache-Control', 'private, max-age=60'); return http.send(res, 200, bytes, api.lib('chat/inbound.js').mimeOf(bytes)) }
      catch { return http.send(res, 404, '配图不存在', 'text/plain; charset=utf-8') }
    })
    return diary
  },
}
