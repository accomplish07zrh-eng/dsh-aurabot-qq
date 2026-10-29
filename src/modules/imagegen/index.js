// 内置模块：生图。她能画图发到聊天里（OpenAI 兼容的生图服务，或「本地接口」里接的 SD WebUI / ComfyUI）。

import { readFileSync } from 'node:fs'
import { createImageGen, drawResultBlocks, drawToolMessage, imageToolBlock } from '../../features/imagegen.js'
import { listPaintings, openPaintFolder, paintingPath, removePainting, savePainting } from '../../features/paintings.js'
import { defineTool, str } from '../../tools/tools.js'
import { dataDir } from '../../core/store.js'
import { mimeOf } from '../../chat/inbound.js'

export default {
  id: 'imagegen',
  name: '生图',
  version: '1.0.0',
  description: '画一张图发到聊天里（qq_draw_image）',
  tab: 'imagegen',
  files: ['features/imagegen.js', 'features/paintings.js'],
  setup(api) {
    const { hub, local } = api.core
    const memory = api.lazy('memory')
    const gen = createImageGen({ getConfig: api.config, log: api.log, local })

    // 她的画作：面板底下的图库（直接读存图目录，可以单张删、开文件夹）
    api.route('/image/gallery', async (req) => {
      const q = api.core.http.query(req)
      const limit = q && q.limit ? Number(q.limit) : api.config().imageGen.galleryShown
      return { ok: true, ...listPaintings({ limit }), dir: dataDir('imagegen') }
    })
    api.route('/image/gallery/image', async (req, res) => {
      const p = paintingPath(api.core.http.query(req).file)
      if (!p) return api.core.http.send(res, 404, '')
      const buf = readFileSync(p)
      api.core.http.send(res, 200, buf, String(mimeOf(buf) || 'image/png'))
    })
    api.route('/image/gallery/delete', async (req) => {
      const b = await api.core.http.body(req).catch(() => ({}))
      return removePainting(String((b && b.file) || ''))
    })
    api.route('/image/open-folder', async () => openPaintFolder())

    api.tool(({ chat, sessionId }) => (gen.enabled() && chat.kind !== 'system' ? defineTool({
      name: 'qq_draw_image',
      description: '画一张图并发到当前 QQ 聊天里。prompt 用中文或英文详细描述画面（主体、动作、场景、风格）。画好会直接发出去，回复里简单说一句就行。',
      properties: { prompt: str('画面描述') },
      required: ['prompt'],
      // 能看图时把原图放进工具结果（image 块），她当轮就能看见自己画了什么
      render: drawResultBlocks,
      execute: async ({ prompt }) => {
        if (api.config().imageGen.ownerOnly && !hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '画图只给主人画哦' }
        const startedAt = Date.now()
        const buf = await gen.generate(String(prompt || ''))
        const sent = await hub.sendSegments(chat.chatId, [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }], `[生图] ${String(prompt).slice(0, 30)}`)
        if (!sent) return { ok: false, message: '画好了，但没有发到 QQ（请检查试运行和网关）' }
        const saved = savePainting(buf, String(prompt || ''))
        if (saved) api.log.debug(`生图已存盘：${saved}`)
        try { memory.addEvent?.({ text: `按提示词画了一张图（不一定等于实际画面）：${String(prompt).slice(0, 120)}`, about: chat.kind === 'private' ? chat.userId : '', tags: ['画画'], importance: 0.4 }) }
        catch (error) { api.log.warn('生图已发送，但经历没记下来：', error.message) }
        let visual = (await hub.canSeeImages(chat)) === true
        // 只有明确能看图的模型才把图交给它；纯文本模型只拿文字，不会崩。
        // 图要先缩、再登记成 DSH 附件块 —— 直接塞 base64 会让下一轮请求整轮失败（实测）
        let img = null
        if (visual) {
          img = await imageToolBlock(api.dsh, buf, { ffmpegPath: api.config().bili && api.config().bili.ffmpegPath })
          if (!img) {
            // 图没给成：如实说看不了，别让她照着提示词编画面细节
            visual = false
            api.log.debug('这次生图没把图交给模型（缩图/登记失败），只给文字')
          }
        }
        const out = {
          ok: true,
          message: drawToolMessage({ visual }),
          prompt: String(prompt || ''),
          bytes: buf.length,
          elapsedMs: Date.now() - startedAt,
          ...(saved ? { path: saved } : {}),
        }
        if (img) out.image = img
        // 能看图的模型才把本地路径告诉她（#59）：收录表情包 / 存素材 / 之后 qq_add_sticker 用；
        // 看不了图的模型不给路径，免得她知道路径就去读图，绕开「不给看」的判断。
        if (visual && saved) out.message += `\n已保存到本机：${saved}（要收录表情包、存素材时可以用这个路径）`
        return out
      },
    }) : []))
    return gen
  },
}
