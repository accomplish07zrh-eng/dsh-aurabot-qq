// 内置模块：自驱引擎（P0 地基，默认关）。
// 给她一间自己的屋子（独立会话）、一本别人代记的账（机械审计）、一双手（工具），
// 以及一道动手前的闸（tools/pre-execute）。方案与约束见 docs/AUTOTELIC-PLAN.md（v3）与
// docs/AUTONOMY-NOTES.md（上游讨论结论，冲突时以那份为准）。
//
// P0 只铺地基：审计账本（哈希链）+ /autotelic/status 面板路由。她一行代码都不会自己跑；
// 引擎闭环（好奇→立项→落账）在 P1 接线，见 src/autotelic/（audit.js 已就位，engine/book 随 P1 来）。

import { verifyAuditChain } from '../../autotelic/audit.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export default {
  id: 'autotelic',
  name: '自驱引擎（实验）',
  version: '0.1.0',
  description: '给她自己的后台会话与账本：独立 preset、机械审计（哈希链，删了会断）、心跳看护。默认关闭，全关时插件行为与旧版一致。',
  // 独立标签页「自驱引擎」（页面在 client/client.js：TABS/TAB_MODS/NAV_GROUPS/Autotelic 组件）。
  tab: 'autotelic',
  files: ['autotelic/audit.js'],
  defaults: {
    enabled: false, // 总开关：默认关（关着时模块不做任何 IO）
    presetIdOverride: false, // hub 的 presetId 覆盖开关（§9 阿娘建议：默认关，最坏情况也只是「她不会动」）
    // —— 以下配置键先声明占位（P1/P2 才接线），面板可见，主人可以先想好数值 ——
    minCuriosity: 0.55, // 好奇分阈值，不够不立项
    maxSteps: 8, // 单任务步数上限
    maxTasksActive: 8, // 同时进行的任务数
    budgetActionsPerHour: 12, // 动作/小时（token 预算 P2 再接，§2.2）
    quietFrom: '23:30', // 安静时段：禁「打扰主人」，不禁「她自己做事」（§4.6）
    quietTo: '07:30',
    dailyReviewHour: 23, // 几点出「每日一页」
    minBatchForReview: 3, // 攒够几件才评（攒 3 件或满一天，先到者为准）
    dreamFrom: '03:00', // 「做梦」窗口（离线整理；留空=关闭做梦）
    dreamTo: '05:00',
    allowUserModules: true, // 允许她写用户模块（modules/<id>/）
    allowPython: true, // 允许她跑 Python 脚本
    pythonBin: '', // 留空 = 自动探测（§1.2）；填了就校验后直接用
    scriptTimeoutMs: 120000, // 单次脚本超时
  },
  settings: [
    { key: 'enabled', label: '启用自驱引擎', type: 'switch', hint: '默认关。P0 只铺「审计账本 + 独立会话」地基，她还不会自己跑任何事' },
    { key: 'presetIdOverride', label: '允许后台会话指定 preset', type: 'switch', hint: 'hub 只在主人明确开了这个开关时才接受 presetId 覆盖（防误伤主聊天）' },
    { key: 'minCuriosity', label: '好奇分阈值', type: 'number', min: 0, max: 1, step: 0.05, hint: '低于这个分不立项（P1 接线）' },
    { key: 'maxSteps', label: '单任务步数上限', type: 'number', min: 1, max: 32 },
    { key: 'maxTasksActive', label: '同时进行的任务数', type: 'number', min: 1, max: 16 },
    { key: 'budgetActionsPerHour', label: '动作数 / 小时', type: 'number', min: 1, max: 120 },
    { key: 'quietFrom', label: '安静时段 从', type: 'string', hint: 'HH:mm；安静时段只禁「打扰主人」，不禁她自己做事' },
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

    // P0.6：状态路由。显示「审计已开启 / 今日 N 条 / 链校验」，外加心跳节奏占位（§10.2：显示节奏而非状态）。
    api.route('/autotelic/status', async () => {
      const cfg = api.settings()
      const chain = await verifyAuditChain(auditDir())
      return {
        ok: true,
        enabled: !!cfg.enabled,
        audit: { wired: auditWired(), dir: auditDir(), today: countToday(auditDir()), chain },
        heartbeats: [], // P1 接线后填最近 6 次心跳间隔（§4.5）
      }
    })

    return { auditDir }
  },
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
