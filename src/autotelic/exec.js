// 自驱引擎 · 分级执行器（P2.1，docs/AUTOTELIC-PLAN.md §3 P2 / §4.4）。
//
// 动作优先级（少爷 2026-11-04 确认）：
//   L0   只读（任何工具）                    → 自动
//   L1-a 调已装模块（经 autotelic 包装工具）  → 自动 + 记账 ← 首选（P2.2 的工具在模块壳注册）
//   L1-b 写自己的数据目录                    → 自动 + 记账
//   L2   白名单外的 shell / onebot / 发消息   → 一律拒绝（首期白名单为空，§4.3/§4.8）
//
// 她做事的形态：一轮后台回合（runSystemTurn）。presetId 指到 aurabot-autotelic 时她手里有
// fs 只读 + autotelic_* 工具（模型直调不经过这里，第一道门在提示词，第二道在 host 的审计钩子）。
// §4.6b：做事用主模型（不传 model），决策/自评才用便宜模型。

import { AUTOTELIC_CHAT_PREFIX } from './audit.js'

/** 首期工具白名单：她的回合里允许出现的动作形状（L2 全排除）。 */
export const ALLOWED_TOOLS = Object.freeze(['fs', 'fs-search', 'fetch', 'web'])

/** 一轮「做事」的提示词。明确边界：只读为主、写只能写自己的目录、不发消息。
 *  2026-11-05 少爷定：进工作间先让模型自审「这事值不值得做」，不值得直接关掉。 */
export function buildActPrompt(task, step, { quiet = false } = {}) {
  return [
    `你刚给自己立了一件事，进工作间先问自己一句：这件事到底值不值得做。`,
    `任务：${task.title}`,
    `当初立项的理由：${task.reason}`,
    '',
    '【先自审】这件事真的值得我花时间去做吗？',
    '- 如果它只是一句寒暄、一个称呼、一句闲聊应答、没有可挖的内容，或者根本不是我该操心的：',
    '  **别硬做**，直接输出 {"abandon": true, "why": "一句话说明为什么这事不值得做"}，这件事会被关掉。',
    '- 如果它确实有点意思、有值得弄明白的东西，再往下走。',
    '',
    '【再做】',
    `当前这一步：${step.desc}（${step.level}）`,
    '边界（必须遵守）：',
    '- 只做这一步；只读为主，要写就只能写你自己数据目录里的文件（notes/ 之类）',
    '- 不许发 QQ 消息、不许碰 onebot、不许跑 shell 命令——这些不在你的工具里，也别想办法绕',
    '- 安静时段（现在是安静时段）只是不打扰主人，你照常做事',
    '',
    '做完（或做不动了）只输出一个 JSON 对象，不要解释：',
    '{"done": true/false, "observation": "这步实际看到了什么/做了什么（≤200字）", "hypothesis": "你当初的判断", "evidence": "支撑或推翻判断的证据", "lesson": "下次怎么办"}',
  ].join('\n')
}

/** 回包解析：剥围栏取第一个 JSON 对象；解析不出就当纯文本观察（不炸执行链）。 */
export function parseActMemo(raw) {
  const text = String(raw || '')
  const m = text.match(/\{[\s\S]*\}/)
  if (m) {
    try {
      const o = JSON.parse(m[0])
      if (o && typeof o === 'object') {
        return {
          ok: Boolean(o.done),
          // 自审否决（2026-11-05 少爷定）：模型判断这事不值得做 → 任务关掉，不算失败
          abandon: o.abandon === true,
          why: String(o.why || ''),
          observation: String(o.observation || text.slice(0, 200)),
          hypothesis: String(o.hypothesis || ''),
          evidence: String(o.evidence || ''),
          lesson: String(o.lesson || ''),
        }
      }
    } catch { /* 落到纯文本 */ }
  }
  return { ok: Boolean(text.trim()), abandon: false, why: '', observation: text.trim().slice(0, 200) || '（没有产出）', hypothesis: '', evidence: '', lesson: '' }
}

/**
 * 造执行器。
 * @param {object} o
 * @param {()=>object} o.settings 模块设置
 * @param {object} o.hub hub（runSystemTurn / chatOfSession）
 * @param {(entry:object)=>void} [o.auditNote] 审计备注通道（做梦 / tune / 非工具路径记账，§4.1 ③）
 * @param {object} [o.log]
 */
export function createExec({ settings, hub, auditNote, log } = {}) {
  /** 她的回合能不能带工具：主人的 presetIdOverride 开着才给（P0.2 的总开关）。 */
  const toolsAllowed = () => Boolean(settings().presetIdOverride)

  /**
   * 推进一步。全程记账口径：动作 = 有工具的做事回合（记 actions 预算 + 审计 note）。
   * @returns {{ok:boolean, observation:string, memo:object, hadTools:boolean, error?:string}}
   */
  async function runStep(task, step) {
    const s = settings()
    const hadTools = toolsAllowed()
    const prompt = buildActPrompt(task, step, { quiet: false })
    const opts = { timeoutMs: Number(s.actTimeoutMs) || 180000, noTools: !hadTools, key: 'workbench' }
    // §4.6b：做事用主模型（不传 model）；带工具时指 aurabot-autotelic preset（fs 只读，无 shell）
    if (hadTools) opts.presetId = 'aurabot-autotelic'
    let raw = ''
    try {
      // 2026-11-05 修「会话爆炸」（少爷真机反馈：任务多时侧栏一排 autotelic 会话）：
      // 所有任务共享一个工作间会话（key=workbench），任务上下文由提示词带进去，
      // 不再每任务一个会话（16 任务 = 16 条侧栏记录，不优雅也没必要）。
      raw = await hub.runSystemTurn('autotelic-act', `${AUTOTELIC_CHAT_PREFIX} · 工作间`, prompt, opts)
    } catch (error) {
      log?.warn?.(`自驱：任务「${task.title}」这步出错：`, error?.message)
      return { ok: false, observation: `回合失败：${error?.message || error}`, memo: parseActMemo(''), hadTools, error: String(error?.message || error) }
    }
    const memo = parseActMemo(raw)
    if (hadTools) {
      // 记账（L1）：动作预算 + 审计（非工具路径的显式记账，§4.1 ③）
      auditNote?.({ kind: 'autotelic/act', tool: 'runSystemTurn', args: { task: task.title, step: step.desc }, outcome: memo.observation })
    }
    return { ...memo, hadTools, memo }
  }

  return { runStep, toolsAllowed }
}
