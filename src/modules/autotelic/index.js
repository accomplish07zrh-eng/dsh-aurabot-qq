// 内置模块：自驱引擎（P1，默认关）。
// 给她一间自己的屋子（独立会话）、一本别人代记的账（机械审计）、一双手（工具，P2 起），
// 以及一道动手前的闸（tools/pre-execute）。方案与约束见 docs/AUTOTELIC-PLAN.md（v3）与
// docs/AUTONOMY-NOTES.md（上游讨论结论，冲突时以那份为准）。
//
// P1 已接线：心跳 tick（感知 → 好奇判分 → 立项 → 落账，全程 L0 只想不出门）、
// /autotelic/preview 零副作用预览、/autotelic/status 任务列表与心跳节奏。
// P0 地基：审计账本（哈希链，host.js 挂钩子）。P2 起她才会动手。

import { verifyAuditChain } from '../../autotelic/audit.js'
import { createRuntime, isQuietNow } from '../../autotelic/runtime.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export default {
  id: 'autotelic',
  name: '自驱引擎（实验）',
  version: '0.2.0',
  description: '给她自己的后台会话与账本：独立 preset、机械审计（哈希链，删了会断）、好奇判分与立项、心跳看护。默认关闭，全关时插件行为与旧版一致。',
  files: ['autotelic/audit.js', 'autotelic/engine.js', 'autotelic/book.js', 'autotelic/runtime.js'],
  // 独立标签页「自驱引擎」（页面在 client/client.js：TABS/TAB_MODS/NAV_GROUPS/Autotelic 组件）。
  tab: 'autotelic',
  defaults: {
    enabled: false, // 总开关：默认关（关着时模块不做任何 IO，验收场景 1）
    presetIdOverride: false, // hub 的 presetId 覆盖开关（§9 阿娘建议：默认关，最坏情况也只是「她不会动」）
    // —— 判分与立项（P1）——
    minCuriosity: 0.55, // 好奇分阈值，不够不立项
    evalModel: '', // 便宜模型自评（'provider/model'）；留空 = 只用可复算公式
    maxCandidates: 3, // 一轮最多立几个项
    // —— 预算（C5：她可调频率但必须有上限；上限值她永远调不动）——
    maxSteps: 8, // 单任务步数上限
    maxTasksActive: 8, // 同时进行的任务数
    budgetActionsPerHour: 12, // 动作/小时（token 预算 P2 再接，§2.2）
    // —— 节奏 ——
    quietFrom: '23:30', // 安静时段：禁「打扰主人」，不禁「她自己做事」（§4.6）
    quietTo: '07:30',
    dailyReviewHour: 23, // 几点出「每日一页」（P2 接线）
    minBatchForReview: 3, // 攒够几件才评（攒 3 件或满一天，先到者为准）
    dreamFrom: '03:00', // 「做梦」窗口（离线整理；留空=关闭做梦，P2 接线）
    dreamTo: '05:00',
    // —— 能力（P2/P3 接线）——
    allowUserModules: true, // 允许她写用户模块（modules/<id>/）
    allowPython: true, // 允许她跑 Python 脚本
    pythonBin: '', // 留空 = 自动探测（§1.2）；填了就校验后直接用
    scriptTimeoutMs: 120000, // 单次脚本超时
  },
  settings: [
    { key: 'enabled', label: '启用自驱引擎', type: 'switch', hint: '默认关。开着时她每分钟想一次「有什么值得自己弄清楚的」，够好奇就立项记账（只在脑子里办，不出门）' },
    { key: 'presetIdOverride', label: '允许后台会话指定 preset', type: 'switch', hint: 'hub 只在主人明确开了这个开关时才接受 presetId 覆盖（防误伤主聊天）' },
    { key: 'minCuriosity', label: '好奇分阈值', type: 'number', min: 0, max: 1, step: 0.05, hint: '低于这个分不立项；落选原因在「预览」里看得到' },
    { key: 'evalModel', label: '自评模型', type: 'string', hint: "provider/model 形式（如 workbuddy/hy4free）。给候选方向做一次便宜模型自评微调分数；留空只用公式" },
    { key: 'maxCandidates', label: '一轮最多立项', type: 'number', min: 1, max: 5 },
    { key: 'maxSteps', label: '单任务步数上限', type: 'number', min: 1, max: 32 },
    { key: 'maxTasksActive', label: '同时进行的任务数', type: 'number', min: 1, max: 16 },
    { key: 'budgetActionsPerHour', label: '动作数 / 小时', type: 'number', min: 1, max: 120 },
    { key: 'quietFrom', label: '安静时段 从', type: 'string', hint: 'HH:mm；安静时段只禁「打扰主人」，不禁她自己做事；留空 = 不启用' },
    { key: 'quietTo', label: '安静时段 到', type: 'string' },
    { key: 'dailyReviewHour', label: '每日一页（点）', type: 'number', min: 0, max: 23 },
    { key: 'minBatchForReview', label: '攒几件才评', type: 'number', min: 1, max: 20 },
    { key: 'dreamFrom', label: '做梦窗口 从', type: 'string', hint: 'HH:mm；留空 = 关闭做梦' },
    { key: 'dreamTo', label: '做梦窗口 到', type: 'string' },
    { key: 'allowUserModules', label: '允许写用户模块', type: 'switch', hint: '写不到框架（src/ 锁死），只能写自己数据目录的 modules/<id>/' },
    { key: 'allowPython', label: '允许跑 Python 脚本', type: 'switch' },
    { key: 'pythonBin', label: 'Python 解释器路径', type: 'string', hint: '留空 = 自动探测（会滤掉商店占位别名）；探测不到时填全路径' },
    { key: 'scriptTimeoutMs', label: '脚本超时（毫秒）', type: 'number', min: 1000, max: 600000 },
  ],
  setup(api) {
    // 审计目录：api.dataDir 已自动带 modules-data/autotelic 前缀，别再叠一层「autotelic」（§2.1 的坑）。
    const auditDir = () => api.dataDir('audit')
    // 审计钩子由 host.js 挂（tools/pre-execute 是进程级事件，模块拿不到 ctx.on）。
    // host 装好审计器后会把「已接线」标记放 core 上，面板据此显示「审计已开启」。
    const auditWired = () => Boolean(api.core?.autotelicAuditOn)

    // P1 运行时：心跳 tick + 预览 + 账本。账本落 api.dataDir('ledger.json')。
    const runtime = createRuntime({
      settings: () => api.settings(),
      cfg: api.config(),
      hub: api.core.hub,
      memoryOf: () => { try { return api.use('memory') } catch { return null } },
      personaName: () => '', // 人格名（素材提权重用）；取不到就空着
      ledgerFile: api.dataDir('ledger.json'),
      evalTurn: (prompt, { model, timeoutMs }) => api.core.hub.runSystemTurn('autotelic-eval', '自驱 · 好奇自评', prompt, { timeoutMs, noTools: true, key: 'eval', model }),
      log: api.log,
    })

    // 心跳：每分钟一次判定（§4.5）。enabled=false 时 tick 第一行就返回，零 IO。
    api.every(60_000, () => runtime.tick().catch(() => {}), '自驱引擎心跳')

    // P0.6 + P1：状态路由（审计 + 任务账本 + 心跳节奏 §10.2：显示节奏而非「运行中」）。
    api.route('/autotelic/status', async () => {
      const cfg = api.settings()
      const chain = await verifyAuditChain(auditDir())
      const tasks = runtime.book().list()
      return {
        ok: true,
        enabled: !!cfg.enabled,
        quiet: { now: isQuietNow(cfg), from: cfg.quietFrom, to: cfg.quietTo },
        audit: { wired: auditWired(), dir: auditDir(), today: countToday(auditDir()), chain },
        summary: runtime.book().summary(),
        tasks: tasks.slice(-20).reverse(),
        heartbeats: runtime.book().meta().ticks,
        running: runtime.running,
      }
    })
    // 零副作用预览（验收 2/3）：今天会立什么项、为什么、分数多少、落选原因。
    api.route('/autotelic/preview', async () => runtime.preview())
    // 手动跑一轮（调试与验收用，§4.5 触发源）；开着才动。
    api.route('/autotelic/run', async () => {
      if (!api.settings().enabled) return { ok: false, message: '自驱引擎没开（本页可以打开）' }
      const r = await runtime.tick({ manual: true })
      return { ok: r.outcome !== 'error', message: tickMessage(r), ...r }
    })

    return { auditDir, runtime }
  },
}

function tickMessage(r) {
  if (r.outcome === 'proposed') return `立项了 ${r.added?.length || 0} 个：${(r.added || []).map((a) => `「${a.title}」`).join('、')}`
  if (r.outcome === 'skipped-busy') return '上一轮还没想完，先不叠'
  if (r.outcome === 'skipped-no-material') return '素材不足，这轮不立项'
  if (r.outcome === 'below-threshold') return '这轮没有够得着阈值的方向（预览里看落选原因）'
  if (r.outcome === 'skipped-budget') return '预算见底，不开新坑'
  if (r.outcome === 'error') return '这轮出错了，看日志'
  return `这轮结束：${r.outcome}`
}

/** 今天的审计条数（读文件数行，供面板显示；出错按 0 处理）。 */
function countToday(dir) {
  try {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const text = readFileSync(join(dir, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`), 'utf8')
    return text.split('\n').filter((l) => l.trim()).length
  } catch {
    return 0
  }
}
