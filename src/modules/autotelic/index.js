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
import { createExec } from '../../autotelic/exec.js'
import { createJournal } from '../../autotelic/reflect.js'
import { probePython, loadEnvCache, saveEnvCache, envUsable, runPython } from '../../autotelic/python.js'
import { createSkills, writeUserModule } from '../../autotelic/skills.js'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export default {
  id: 'autotelic',
  name: '自驱引擎（实验）',
  version: '0.4.0',
  description: '给她自己的后台会话与账本：独立 preset、机械审计（哈希链）、好奇判分与立项、L1 分级执行（反思/每日一页/做梦）、Python 与用户模块（P3）、技能库与提案通道（P4）。默认关闭，全关时插件行为与旧版一致。',
  files: ['autotelic/audit.js', 'autotelic/engine.js', 'autotelic/book.js', 'autotelic/runtime.js', 'autotelic/exec.js', 'autotelic/reflect.js', 'autotelic/python.js', 'autotelic/skills.js'],
  // 独立标签页「自驱引擎」（页面在 client/client.js：TABS/TAB_MODS/NAV_GROUPS/Autotelic 组件）。
  tab: 'autotelic',
  defaults: {
    enabled: false, // 总开关：默认关（关着时模块不做任何 IO，验收场景 1）
    presetIdOverride: false, // hub 的 presetId 覆盖开关（§9 阿娘建议：默认关，最坏情况也只是「她不会动」）
    // —— 判分与立项（P1）——
    minCuriosity: 0.55, // 好奇分阈值，不够不立项
    evalModel: '', // 便宜模型自评（'provider/model'）；留空 = 只用可复算公式
    maxCandidates: 3, // 一轮最多立几个项
    allowAct: true, // 允许动手（L1做事回合）；false 时只「想」不「做」
    actTimeoutMs: 180000, // 做事回合超时（§4.6b：做事用主模型，这里只限时长）
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
    { key: 'allowAct', label: '允许动手（L1）', type: 'switch', hint: '立项后她会跑做事回合推进任务（presetIdOverride 开着才带工具；关着只「想」）。失败 2 次自动卡住，同指纹 2 次熔断' },
    { key: 'actTimeoutMs', label: '做事回合超时（毫秒）', type: 'number', min: 30000, max: 600000 },
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

    // P1+P2 运行时：心跳 tick（立项+推进+复盘+做梦）+ 预览 + 账本。账本落 api.dataDir('ledger.json')。
    const journal = createJournal(api.dataDir())
    const runtime = createRuntime({
      settings: () => api.settings(),
      cfg: api.config(),
      hub: api.core.hub,
      memoryOf: () => { try { return api.use('memory') } catch { return null } },
      personaName: () => '', // 人格名（素材提权重用）；取不到就空着
      ledgerFile: api.dataDir('ledger.json'),
      evalTurn: (prompt, { model, timeoutMs }) => api.core.hub.runSystemTurn('autotelic-eval', '自驱 · 好奇自评', prompt, { timeoutMs, noTools: true, key: 'eval', model }),
      // L1 分级执行器（P2.1）：做事回合 + 非工具路径的审计记账（§4.1 ③）
      act: createExec({
        settings: () => api.settings(),
        hub: api.core.hub,
        auditNote: (entry) => api.core?.autotelicAudit?.note?.(entry),
        log: api.log,
      }),
      journal,
      auditNote: (entry) => api.core?.autotelicAudit?.note?.(entry),
      auditStat: () => api.core?.autotelicAudit?.status?.(),
      log: api.log,
    })

    // ---------- P3/P4 的手（她的工具：只在 system:autotelic* 的会话里出现） ----------
    // 她的动作菜单 = 这些工具 + preset 的 fs 只读（presetIdOverride 开着才有）。
    // 门：enabled 总闸 + 各能力分闸（allowPython / allowUserModules）+ 动作预算 + 全程进审计。
    const skills = createSkills(api.dataDir())
    const note = (entry) => api.core?.autotelicAudit?.note?.(entry)
    const userModulesDir = () => { try { return (typeof api.core?.modules?.dir === 'function') ? api.core.modules.dir() : '' } catch { return '' } }
    let envCache = null
    // 测试钩子（照 pet 的 __petTestHooks 模式）：CI 注入 fake 探测，不依赖真机器环境（场景 16~18）
    const probeFn = api.__autotelicTestHooks?.probePython || probePython
    const readEnv = () => { if (envCache == null) envCache = loadEnvCache(api.dataDir('env.json')); return envCache }
    // 探测（惰性 + 只在开着时做；场景 1：关着零 IO）。配置优先，结果缓存 env.json，24h 内直接用。
    const pythonEnv = async () => {
      const cached = readEnv()
      const s = api.settings()
      if (envUsable(cached) && (!s.pythonBin || cached.source === 'configured')) return cached
      envCache = await probeFn({ configured: s.pythonBin })
      saveEnvCache(api.dataDir('env.json'), envCache)
      if (!envCache) api.log.info?.('自驱：本机没有探测到可用 Python，这项能力关闭（面板可手动填路径）')
      else api.log.info?.(`自驱：Python 用 ${envCache.bin}（${envCache.version}）`)
      return envCache
    }
    // 动作预算 + 记账（L1 起都要）：预算到顶直接拒（场景 7 的工具侧口径）
    const spend = (what) => {
      const s = api.settings()
      const bk = runtime.book()
      if (bk.actionsInLastHour() >= s.budgetActionsPerHour) return { ok: false, message: `动作预算到顶（${s.budgetActionsPerHour}/小时），这小时不再动手` }
      bk.recordAction()
      note({ kind: 'autotelic/tool', tool: what, outcome: '动作预算内' })
      return { ok: true }
    }
    const isHer = (where) => String(where?.chat?.chatId || '').startsWith('system:autotelic')
    const clip = (s, n) => { const t = String(s || ''); return t.length > n ? t.slice(0, n) + '…' : t }
    api.tool((where) => {
      if (!api.settings().enabled || !isHer(where)) return []
      return [
        api.defineTool({
          name: 'autotelic_note',
          description: '写一篇笔记到你自己的目录（notes/ 年月日-标题.md）。用于记录你查到的东西、想留给以后的想法。',
          properties: { title: { type: 'string', description: '标题（做文件名用）' }, text: { type: 'string', description: '正文' } },
          required: ['title', 'text'],
          execute: async ({ title, text }) => {
            const spendR = spend('autotelic_note')
            if (!spendR.ok) return spendR
            try {
              const day = new Date()
              const p2 = (n) => String(n).padStart(2, '0')
              const safe = String(title || '无题').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || '无题'
              const file = api.dataDir('notes', `${day.getFullYear()}-${p2(day.getMonth() + 1)}-${p2(day.getDate())}-${safe}.md`)
              const { mkdirSync, writeFileSync } = await import('node:fs')
              mkdirSync(api.dataDir('notes'), { recursive: true })
              writeFileSync(file, `# ${title}\n\n${text}\n`, 'utf8')
              return { ok: true, message: `写好了：${file}` }
            } catch (error) { return { ok: false, message: `写不了：${error.message}` } }
          },
        }),
        api.defineTool({
          name: 'autotelic_run_python',
          description: '跑一段 Python 脚本（子进程，超时会杀，不继承主程序的任何密钥环境变量）。stdout 会回给你；要留产物就写到你目录的 out/ 附近。',
          properties: { code: { type: 'string', description: 'Python 3 源码' }, saveAs: { type: 'string', description: '可选：保存为技能（id，小写字母/数字/-）。跑成功会累计，连续 2 次成功就学会' } },
          required: ['code'],
          execute: async ({ code, saveAs }) => {
            const s = api.settings()
            if (!s.allowPython) return { ok: false, message: '「允许跑 Python 脚本」没开（主人关的，提案也改不动）' }
            const env = await pythonEnv()
            if (!env || !env.pythonBin) return { ok: false, message: '本机没有可用 Python（这项能力关闭；面板「自驱引擎」页可手动填解释器路径）' }
            const spendR = spend('autotelic_run_python')
            if (!spendR.ok) return spendR
            const r = await runPython({ dir: api.dataDir(), pythonBin: env.pythonBin, code, timeoutMs: Number(s.scriptTimeoutMs) || 120000 })
            note({ kind: 'autotelic/python', tool: 'run_python', args: { bytes: String(code || '').length, saveAs: saveAs || '' }, outcome: r.ok ? 'ok' : (r.error || 'failed') })
            // 技能记账（P4.2）：复现 2 次成功才 learned
            let skillMsg = ''
            if (saveAs && String(saveAs).trim()) {
              const saved = skills.save({ id: saveAs, script: code })
              skillMsg = saved.ok ? `；技能「${saveAs}」${skills.recordRun(saveAs, r.ok).status}` : `；技能没存上：${saved.why}`
            } else {
              // 没点名 saveAs 但内容跟某个候选技能一致 → 也算复现（按脚本内容匹配）
              const m = (skills.list() || []).find((x) => { const g = skills.get(x.id); return g && g.script === code && g.status !== 'learned' })
              if (m) skillMsg = `；技能「${m.id}」${skills.recordRun(m.id, r.ok).status}`
            }
            return { ok: r.ok, message: `${r.ok ? '跑完了' : '没跑成'}（${r.ms}ms）${r.error ? '：' + r.error : ''}${r.stdout ? '\n输出：' + clip(r.stdout, 3000) : ''}${skillMsg}` }
          },
        }),
        api.defineTool({
          name: 'autotelic_write_module',
          description: '给自己写一个用户模块（扩展能力，升级不丢）。只能写你自己的模块目录；框架代码永远写不到。',
          properties: { id: { type: 'string', description: '模块 id（小写字母开头，小写字母/数字/-）' }, code: { type: 'string', description: 'index.mjs 完整内容，必须 export default 模块对象' } },
          required: ['id', 'code'],
          execute: async ({ id, code }) => {
            if (!api.settings().allowUserModules) return { ok: false, message: '「允许写用户模块」没开（主人关的）' }
            const dir = userModulesDir()
            if (!dir) return { ok: false, message: '拿不到用户模块目录（模块系统不可用）' }
            const spendR = spend('autotelic_write_module')
            if (!spendR.ok) return spendR
            const r = writeUserModule({ dir, id, code })
            note({ kind: 'autotelic/module', tool: 'write_module', args: { id }, outcome: r.ok ? 'ok' : r.why })
            return { ok: r.ok, message: r.ok ? `写好了 ${r.file}。${r.note}` : r.why }
          },
        }),
        api.defineTool({
          name: 'autotelic_propose_say',
          description: '你想对主人说一句话。不直接发：交给出站治理统筹排程；安静时段先攒着。说不说、怎么说由治理和你判断，但「想过要说」会留痕。',
          properties: { text: { type: 'string', description: '想说的话' }, reason: { type: 'string', description: '为什么现在想说' } },
          required: ['text'],
          execute: async ({ text, reason }) => {
            const body = clip(text, 2000)
            const { readJson, writeJson } = await import('../../core/store.js')
            // 安静时段自己判（§4.6：不能指望 outbound 治理，两者窗口不同）——先攒着
            if (isQuietNow(api.settings())) {
              const pending = readJson(api.dataDir('say-pending.json'), [])
              pending.push({ at: Date.now(), text: body, reason: clip(reason, 200) })
              writeJson(api.dataDir('say-pending.json'), pending.slice(-20))
              return { ok: true, message: '现在是安静时段，这句先攒着（没丢，安静结束再交给治理）' }
            }
            const r = await api.proactive.submit({ text: body, itemId: `say-${Date.now()}`, cause: { kind: 'background' } })
            note({ kind: 'autotelic/say', tool: 'propose_say', args: { reason: clip(reason, 120) }, outcome: r?.state || 'unknown' })
            if (!r || r.state === 'unsupported') return { ok: false, message: '出站治理没开成 broker 档，这句话送不出去（要主人把 outboundPolicy.tier 设为 broker）' }
            if (r.state === 'dropped') return { ok: false, message: `治理没放行：${r.reason || 'denied'}（可以攒着以后再说）` }
            return { ok: true, message: `交给出站治理了（${r.state}）` }
          },
        }),
        api.defineTool({
          name: 'autotelic_propose',
          description: '给主人写提案（proposals/）：想要新能力、想改框架、想加工具，都写在这里。你永远改不到框架代码（src/）。',
          properties: { title: { type: 'string' }, body: { type: 'string' } },
          required: ['title', 'body'],
          execute: async ({ title, body }) => {
            const safe = String(title || '无题').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || '无题'
            try {
              const { mkdirSync, writeFileSync } = await import('node:fs')
              mkdirSync(api.dataDir('proposals'), { recursive: true })
              const file = api.dataDir('proposals', `${Date.now()}-${safe}.md`)
              writeFileSync(file, `# 提案：${title}\n\n${body}\n`, 'utf8')
              note({ kind: 'autotelic/proposal', args: { title: clip(title, 60) }, outcome: 'ok' })
              return { ok: true, message: `提案写好了：${file}` }
            } catch (error) { return { ok: false, message: `写不了：${error.message}` } }
          },
        }),
        api.defineTool({
          name: 'autotelic_modules',
          description: '看看现在有哪些模块装着、开着（比如抖音、B站）。你只能看到清单——每个模块的具体能力要等主人逐个接给你。',
          properties: {},
          execute: async () => {
            const want = ['douyin', 'bili', 'heybox', 'tophub', 'tieba-reader', 'pet', 'phone', 'song', 'imagegen', 'memory']
            const rows = []
            for (const id of want) {
              let mod = null
              try { mod = api.use(id) } catch { mod = null }
              rows.push(`${mod ? '✓' : '✗'} ${id}${mod ? '（开着，能力待接入）' : '（没装或没开）'}`)
            }
            return { ok: true, message: rows.join('\n') }
          },
        }),
      ]
    })
    // P4.4 提案 / P4.2 技能 / P3.3 Python 环境：面板口
    api.route('/autotelic/skills', async () => ({ ok: true, list: skills.list() }))
    api.route('/autotelic/proposals', async () => {
      let list = []
      try { list = readdirSync(api.dataDir('proposals')).filter((f) => f.endsWith('.md')).sort().reverse().slice(0, 20) } catch {}
      return { ok: true, list }
    })
    api.route('/autotelic/env', async (req) => {
      if (req && req.method === 'POST') {
        const body = await api.core.http.body(req).catch(() => ({}))
        if (body && typeof body.pythonBin === 'string') api.setConfig({ ext: { autotelic: { pythonBin: body.pythonBin.trim() } } })
        envCache = null // 强制重新探测
      }
      const env = api.settings().enabled && api.settings().allowPython ? await pythonEnv() : readEnv()
      return { ok: true, env: env || null, usable: envUsable(env), hint: env?.pythonBin ? `${env.pythonBin}（${env.version}）` : '本机没有可用 Python（可以在这里手填解释器路径）' }
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
        env: api.settings().enabled && api.settings().allowPython ? await pythonEnv() : readEnv(),
        skills: skills.list().slice(0, 12),
        proposals: (() => { try { return readdirSync(api.dataDir('proposals')).filter((f) => f.endsWith('.md')).length } catch { return 0 } })(),
        sayPending: (() => { try { return (JSON.parse(readFileSync(api.dataDir('say-pending.json'), 'utf8') || '[]') || []).length } catch { return 0 } })(),
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
    // 手动推进一步（调试用）：开着 + 允许动手才动。
    api.route('/autotelic/step', async () => {
      const s = api.settings()
      if (!s.enabled) return { ok: false, message: '自驱引擎没开' }
      if (!s.allowAct) return { ok: false, message: '「允许动手」关着，她只想想' }
      const r = await runtime.step({ manual: true })
      return { ok: r.outcome !== 'error', message: stepMessage(r), ...r }
    })
    // 她自己调参数（P2.6，C5）：白名单 + 上限钳制 + 本次调整进审计。主人也能代调（by=owner 不钳制方向）。
    api.route('/autotelic/tune', async (req) => {
      const body = await api.core.http.body(req).catch(() => ({}))
      const patch = body && typeof body === 'object' ? body.patch || body : {}
      const by = String(body?.by || 'she') === 'owner' ? 'owner' : 'she'
      const r = runtime.tune(patch, { by })
      if (!r.ok) return { ok: false, message: Object.entries(r.rejected).map(([k, v]) => `${k}：${v}`).join('；') || r.why, ...r }
      api.setConfig({ ext: { autotelic: r.applied } })
      api.core?.autotelicAudit?.note?.({ kind: 'autotelic/tune', args: { by, patch: r.applied, rejected: r.rejected }, outcome: '调参动作本身进审计（C5）' })
      return { ok: true, message: `调好了：${Object.entries(r.applied).map(([k, v]) => `${k}=${v}`).join('、')}${Object.keys(r.rejected).length ? `（拒了 ${Object.keys(r.rejected).length} 项）` : ''}`, ...r }
    })
    // 复盘刊物：每日一页 + 做梦记录（P2.5/P2.7 的面板口）。
    api.route('/autotelic/journal', async () => ({ ok: true, daily: journal.list('daily'), dreams: journal.list('dreams') }))

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

function stepMessage(r) {
  if (r.outcome === 'step-done') return '这步办完了'
  if (r.outcome === 'step-failed') return `这步没办成（${r.taskStatus || '记了失败'}）`
  if (r.outcome === 'loop-broken') return '死循环熔断：同样的观察出现两次，任务放弃'
  if (r.outcome === 'no-step') return r.why ? `没有可开的步：${r.why}` : '没有待办的步'
  if (r.outcome === 'act-unavailable') return '执行器没接上（hub 不可用？）'
  if (r.outcome === 'act-disabled') return '「允许动手」没开'
  return `结束：${r.outcome}`
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
