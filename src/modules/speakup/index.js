// 内置模块：主动搭话（目的机制版）。
// 实现：把 surfcore 的「目的引擎」移植进 aurabot —— 定期、像人一样主动找主人搭话：
// 素材（记忆 + 聊天流水）→ 目标假设（带归属/置信度/风险）→ 选一个目的 → 生成一句话 → 投递私聊。
// 薄壳只做注册；引擎在 src/purpose/engine.js（纯函数），接线在 src/purpose/module.js。
//
// 兼容硬约束：id 保持 'speakup'，导出保留 { tick, fire, state }（client.js / host.js 硬编码依赖），
// 路由前缀保持 /speakup/*。setup 必须同步返回（R1），所有 I/O 都在 tick / 路由里发生。

import { createPurpose } from '../../purpose/module.js'

export default {
  id: 'speakup',
  name: '主动搭话',
  version: '2.0.0',
  description: '目的机制：像人一样定期主动找主人搭话（素材 → 目标假设 → 目的 → 一句话）',
  tab: 'speakup',
  files: ['purpose/engine.js', 'purpose/module.js'],
  defaults: {
    minMaterials: 2, // 素材少于这个数（也没有惦记的事/人格卡）就不硬找话
    initialDelayMinutes: 15, // 启动后的第一枪延迟
    maxCandidates: 6,
    promptMaxChars: 16000,
  },
  settings: [
    { key: 'minMaterials', label: '最少素材数', type: 'number', min: 0, max: 20, hint: '低于这个数且没有惦记的事/人格卡时，这轮不硬找话' },
    { key: 'initialDelayMinutes', label: '启动延迟（分钟）', type: 'number', min: 1, max: 720, hint: '插件启动后第一次主动搭话前先等多久' },
    { key: 'maxCandidates', label: '候选方向数', type: 'number', min: 3, max: 10 },
  ],
  setup(api) {
    const purpose = createPurpose({
      getConfig: api.config,
      setConfig: api.setConfig,
      hub: api.core.hub,
      log: api.log,
      isMuted: (chatId) => { try { return api.core.mutes.muted(chatId) } catch { return false } },
      mood: () => api.use('mood'),
      memory: () => api.use('memory'),
      pet: () => api.use('pet'), // 载体分发用（carrier=pet 时推桌宠气泡；没装/关了是 null，按离线处理）
      personaText: () => { try { return api.core.personas?.current?.() || '' } catch { return '' } },
    })
    api.every(60_000, () => purpose.tick(), '主动搭话')
    api.route('/speakup/fire', async () => {
      if (!api.config().enabled) return { ok: false, message: '先打开总开关' }
      const r = await purpose.fire('手动')
      if (!r) return { ok: false, message: '没有结果' }
      if (r.outcome === 'sent') return { ok: true, message: '已经去找你了' }
      if (r.outcome === 'silent') return { ok: true, message: '她这轮想了想，决定不说（不硬发）' }
      if (r.outcome === 'muted') return { ok: false, message: '主人在私聊里让她闭嘴了' }
      if (r.outcome === 'disabled') return { ok: false, message: '主动搭话开关是关的' }
      return { ok: true, message: `这轮结束：${r.outcome}` }
    })
    api.route('/speakup/status', async () => ({ ok: true, status: purpose.status(), state: purpose.state() }))
    api.route('/speakup/preview', async () => ({ ok: true, preview: purpose.preview() }))
    // 驱动向量 → 提示层：把「最近比较想要什么」轻描淡写地写进每一轮的上下文
    api.rule(() => purpose.drivesRule())
    return purpose
  },
}
