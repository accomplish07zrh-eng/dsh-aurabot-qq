// 内置模块：生视频。走「本地接口」的 video 脚本（ComfyUI 等），做完自动发回聊天。
// 生视频要十几分钟，不能让这一轮一直等：工具马上返回，后台做完再发。

import { pathToFileURL } from 'node:url'
import { defineTool, str } from '../../tools/tools.js'

/** 脚本的返回值统一成文件路径：字符串或 { file }。 */
export const videoFile = (r) => String(typeof r === 'string' ? r : r?.file || '').trim()

export default {
  id: 'video',
  name: '生视频',
  version: '1.0.0',
  description: '用本地脚本生成视频并发到聊天（qq_generate_video）',
  setup(api) {
    const { hub, local } = api.core
    let running = false
    let stopped = false
    api.onDispose?.(() => { stopped = true })

    async function deliver(chatId, file) {
      try {
        await hub.sendSegments(chatId, [{ type: 'video', data: { file: pathToFileURL(file).href } }], '[视频]', { throwOnError: true, timeoutMs: 120_000 })
      } catch (error) {
        api.log.warn('按视频发送失败，改发文件：', error.message)
        await hub.sendFile(chatId, file)
      }
    }

    async function generate(chatId, args) {
      running = true
      try {
        const file = videoFile(await local.call('video', args))
        if (stopped) return
        if (!file) throw new Error('脚本没有返回视频文件')
        await deliver(chatId, file)
      } catch (error) {
        if (!stopped) await hub.sendText(chatId, `视频没做成：${String(error.message || error).slice(0, 200)}`).catch(() => {})
      } finally {
        running = false
      }
    }

    api.rule(() => (local.active('video')
      ? ['- 你能用 qq_generate_video 生成视频，只有主人让你做时才用。生成很慢，通常要十几分钟，开始前先告诉对方要等多久；做好会自动发出来，不用再发一次。']
      : []))

    api.tool(({ chat, sessionId }) => (local.active('video') && chat.kind !== 'system' ? defineTool({
      name: 'qq_generate_video',
      description: '生成一段视频，做好后自动发到当前聊天。很慢，通常要十几分钟，开始前先告诉对方要等。只有主人让你做时才用。',
      properties: { prompt: str('视频内容描述'), seconds: str('可选：时长（秒）') },
      required: ['prompt'],
      execute: async ({ prompt, seconds }) => {
        if (!hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '只有主人能让我生成视频' }
        const text = String(prompt || '').trim()
        if (!text) return { ok: false, message: '要生成什么内容？' }
        if (running) return { ok: false, message: '上一段视频还在生成，等它好了再说' }
        generate(chat.chatId, { prompt: text, seconds: Number(seconds) || undefined }).catch(() => {})
        return { ok: true, message: '开始生成了，做好会自动发到这里。告诉对方要等一阵子，这一轮不用再发视频。' }
      },
    }) : []))
  },
}
