// 内置模块：语音。把她的话念出来发语音条（edge-tts / Windows 语音 / CosyVoice / GPT-SoVITS / 本地接口），
// 面板里的试听、语音识别自检也在这里。
// 导出 speak(text) → { file, engine }：聊天中枢发语音时找它。替换这个模块就能换成任何你想要的念法。

import { existsSync, readFileSync } from 'node:fs'
import { textToSpeech, edgeInstalled, installEdge, voiceConverters, volcanoResourceFor, volcanoSynth } from '../../voice/tts.js'
import { VOLCANO_VOICES } from '../../voice/volcano-voices.js'
import { createSongVoice } from '../../voice/rvc.js'
import { toMono16k } from '../../voice/wav.js'
import { fileOf } from '../../local/local.js'
import { asrConfigured, transcribeAudio } from '../../voice/asr.js'
import { mergeFromPanel, normalize } from '../../core/config.js'

export default {
  id: 'voice',
  name: '语音',
  version: '1.0.0',
  description: '发语音条：把她的话念出来（关掉后想发语音时改发文字）',
  tab: 'voice',
  files: ['voice/tts.js', 'voice/asr.js', 'voice/rvc.js', 'voice/volcano-voices.js'],
  setup(api) {
    const { hub, onebot, local, http } = api.core

    async function speak(text, voice = api.config().voice, { useLocal = true } = {}) {
      // 本地接口接管语音合成；出错退回内置。试听用 useLocal=false，避免「本地接口」把任何引擎都顶掉
      if (useLocal && local.active('tts')) {
        try {
          const file = fileOf(await local.call('tts', { text }))
          if (file && existsSync(file)) return { file, engine: 'local' }
        } catch (error) {}
      }
      return textToSpeech(text, voice, api.log)
    }

    /** 试听用：把面板上「还没保存」的语音草稿合并进当前配置；空着的 Key 沿用已保存的。 */
    function voiceFromBody(body) {
      const saved = api.config()
      if (!body || !body.voice || typeof body.voice !== 'object') return saved.voice
      try { return normalize(mergeFromPanel(saved, { voice: body.voice })).voice } catch (error) { return saved.voice }
    }

    // 语音条变声：如果面板里选了「翻唱里导入的音色」，TTS 后再用 RVC 换成她的声音。
    // 挂在 tts.js 的 voiceConverters 上（卸载时摘掉）；变声失败会保留 TTS 原声。
    const songVoice = createSongVoice({ getConfig: api.config, getSong: () => api.use('song'), dataDir: api.dataDir, log: api.log })
    voiceConverters.push(songVoice)
    api.onDispose?.(() => {
      const i = voiceConverters.indexOf(songVoice)
      if (i >= 0) voiceConverters.splice(i, 1)
    })

    // 面板「语音」页用：翻唱模块现成的音色列表 + 是否可用（只读，不触发任何转换）
    api.route('/voice/song-voices', async () => {
      const song = api.use('song')
      if (!song || typeof song.status !== 'function') return { ok: true, available: false, voices: [], message: '翻唱模块没在跑' }
      try {
        const st = song.status()
        return { ok: true, available: Boolean(st.ready), ready: Boolean(st.ready), voices: st.voices || [], selected: api.config().voice.songVoice || '', message: st.message || '' }
      } catch (error) {
        return { ok: false, available: false, voices: [], message: String(error.message || error) }
      }
    })

    api.route('/voice/test', async (req) => {
      const b = await http.body(req)
      // 面板会带上当前页面的 voice 草稿：没保存也能试听，空密钥用已保存的
      const voice = voiceFromBody(b)
      const { file, engine } = await speak(String(b.text || '你好呀，我是大肥鱼'), voice, { useLocal: false })
      const buf = readFileSync(file)
      return { ok: true, engine, mime: file.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg', data: buf.toString('base64') }
    })
    api.route('/voice/install', async () => installEdge(api.log))
    // 自检云端识别：先用内置语音念一句，再交给配好的 ASR 服务
    api.route('/voice/asr-provider-test', async (req) => {
      const b = await http.body(req)
      const voice = voiceFromBody(b)
      if (!asrConfigured(voice)) return { ok: false, message: '没配置云端识别（面板「语音 → 听语音」里选一个）' }
      const text = String(b.text || '今天想吃白米饭')
      let file
      try {
        const r = await textToSpeech(text, { engine: process.platform === 'win32' ? 'windows' : 'edge' }, api.log)
        file = r.file
      } catch (error) {
        return { ok: false, message: '生成测试语音失败：' + error.message }
      }
      try {
        const t = Date.now()
        const heard = await transcribeAudio(readFileSync(file), voice, api.log)
        return { ok: Boolean(heard), said: text, heard, provider: voice.asrApi?.provider || '', ms: Date.now() - t }
      } catch (error) {
        return { ok: false, message: '识别失败：' + error.message }
      }
    })

    // 单独试听一个音色：用面板上「还没保存」的 Key / 音色 / 语速直接念一句，方便一个个挑。
    // 面板里 Key 框是密码框、保存后不回传原文，所以这里没传 Key 就用存好的那份。
    api.route('/voice/volcano-preview', async (req) => {
      const b = await http.body(req)
      const saved = api.config().voice.volcano || {}
      const c = {
        apiKey: String(b.apiKey || '').trim() || String(saved.apiKey || ''),
        voiceType: String(b.voiceType || saved.voiceType || '').trim(),
        resourceId: String(b.resourceId || saved.resourceId || '').trim(),
        speedRatio: Number(b.speedRatio) || Number(saved.speedRatio) || 1,
      }
      if (!c.apiKey) return { ok: false, message: '先在上面把 API Key 填上，再试听' }
      try {
        const file = await volcanoSynth(String(b.text || '你好呀，我是大肥鱼。这个声音你听着怎么样？'), c)
        const buf = readFileSync(file)
        return { ok: true, engine: 'volcano', mime: 'audio/mpeg', data: buf.toString('base64') }
      } catch (error) {
        return { ok: false, message: String((error && error.message) || error) }
      }
    })

    // 面板「豆包语音」的音色下拉：火山官方预置音色，按语种 / 性别分组，2.0 排在 1.0 前面。
    // resourceId 一起给出去，面板选中时顺手写进配置，省得猜模型版本。
    api.route('/voice/volcano-voices', async () => ({
      ok: true,
      voices: VOLCANO_VOICES.map((v) => ({ id: v.id, name: v.name, group: v.group, ver: v.ver, scene: v.scene || '', resourceId: volcanoResourceFor(v.id) })),
    }))

    // DSH 自带语音识别：看状态 / 下载模型
    const stt = () => api.dsh.get('speechToText')
    api.route('/voice/asr-status', async () => {
      const s0 = stt()
      if (!s0 || typeof s0.snapshot !== 'function') return { ok: false, enabled: false, message: 'DSH 里没有开启「语音输入」插件' }
      const s = s0.snapshot()
      const p = s.providers.find((x) => x.id === s.selection.providerId) || s.providers[0]
      return { ok: true, enabled: true, provider: p?.id, phase: p?.preparation?.phase || 'ready', detail: p?.preparation }
    })
    api.route('/voice/asr-prepare', async () => {
      const s0 = stt()
      if (!s0 || typeof s0.snapshot !== 'function') return { ok: false, message: 'DSH 里没有开启「语音输入」插件' }
      s0.prepare(s0.snapshot().selection.providerId)
      return { ok: true, message: '开始下载识别模型（约 200MB，下好后常驻本机）' }
    })
    // 自检「听语音」（真 QQ）：拿和某人私聊里最近一条语音，走一遍 get_record → 16k → DSH 识别
    api.route('/voice/asr-last', async (req) => {
      const b = await http.body(req)
      const uid = Number(b.userId || api.config().ownerQQ)
      const h = await onebot.call('get_friend_msg_history', { user_id: uid, count: 30 })
      const recs = (h?.messages || []).filter((m) => String(m.user_id) === String(uid)).flatMap((m) => (m.message || []).filter((s) => s.type === 'record').map((s) => ({ seg: s, time: m.time })))
      const last = recs.at(-1)
      if (!last) return { ok: false, message: '最近的聊天里没有对方发的语音' }
      const t = Date.now()
      const text = await hub.localTranscribe(last.seg)
      return { ok: Boolean(text), heard: text, at: new Date(last.time * 1000).toLocaleString(), ms: Date.now() - t }
    })
    // 自检「听语音」：Windows 语音念一句 → 转 16k 单声道 → DSH 自带识别 → 看能不能认回来
    api.route('/voice/asr-test', async (req) => {
      const b = await http.body(req)
      const s0 = stt()
      if (!s0 || typeof s0.resolve !== 'function') return { ok: false, message: 'DSH 里没有开启语音识别（设置 → 插件 → 语音输入）' }
      const text = String(b.text || '今天想吃白米饭')
      const { file } = await textToSpeech(text, { engine: 'windows' })
      const t = Date.now()
      const spec = s0.resolve({ audio: new Uint8Array(toMono16k(readFileSync(file))) })
      const r = await s0.transcribe(spec, AbortSignal.timeout(120000))
      const heard = typeof r === 'string' ? r : r?.text || r?.transcript || JSON.stringify(r)
      return { ok: Boolean(heard), said: text, heard, ms: Date.now() - t }
    })

    return { speak, edgeInstalled }
  },
}
