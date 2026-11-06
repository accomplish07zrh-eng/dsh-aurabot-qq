// 自驱引擎 P3/P4：Python 探测与脚本（不许写死解释器名）、技能库（复现 2 次才学会）、
// 用户模块写入（写不到框架）、她的工具面（只在她的会话出现）、想说一句（不直发，交治理）。
// 场景对照 §5：16~18（fake 注入探测）、19（超时杀）、12（技能）、13（工具清单没有框架类工具）、
// 11（想说不直发）、15（用户模块降级口径）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeOne, probePython, runPython, cleanEnv, envUsable } from '../src/autotelic/python.js'
import { createSkills, writeUserModule } from '../src/autotelic/skills.js'
import module from '../src/modules/autotelic/index.js'

const runOf = (map) => async (bin) => {
  const hit = map[bin]
  if (!hit) return { code: -1, out: `not found: ${bin}` }
  return hit
}

test('探测（场景 16）：真 Python 被认出来，版本号取对', async () => {
  const hit = await probeOne('python', { run: runOf({ python: { code: 0, out: 'Python 3.11.9' } }) })
  assert.deepEqual(hit, { bin: 'python', version: '3.11.9' })
})

test('探测滤假货（场景 17）：商店占位别名 / 不是 Python / 版本过低，全部跳过', async () => {
  // ① 商店占位：跑起来 code!=0（唤起商店失败）
  const placeholder = await probeOne('python3', { run: runOf({ python3: { code: 9009, out: '' } }) })
  assert.equal(placeholder, null)
  // ② 能启动但不是 Python
  const fake = await probeOne('python3', { run: runOf({ python3: { code: 0, out: 'FakeShell 1.0' } }) })
  assert.equal(fake, null)
  // ③ 版本过低
  const old = await probeOne('python', { run: runOf({ python: { code: 0, out: 'Python 2.7.18' } }) })
  assert.equal(old, null)
})

test('探测顺序（场景 20）：配置了就用配置；配置坏就继续往下试别的', async () => {
  const map = {
    'py': { code: 0, out: 'Python 3.13.7' },
    'python': { code: -1, out: 'not found' },
    'broken': { code: 1, out: 'boom' },
  }
  const byConfig = await probePython({ configured: 'py', run: runOf(map) })
  assert.equal(byConfig.bin, 'py')
  const fallback = await probePython({ configured: 'broken', run: runOf(map) })
  assert.equal(fallback.bin, 'py', '配置失效继续按序探测')
  const none = await probePython({ run: runOf({}) })
  assert.equal(none, null, '全失败 = 本机没有 Python（场景 18）')
})

test('env 缓存：24h 内直接用；unavailable 不算可用', () => {
  const now = Date.now()
  assert.equal(envUsable({ pythonBin: 'python', version: '3.11.9', probedAt: now }), true)
  assert.equal(envUsable({ pythonBin: 'python', probedAt: now - 25 * 3600_000 }), false, '过期重探')
  assert.equal(envUsable({ unavailable: true, probedAt: now }), false)
})

test('跑脚本：敏感 env 不继承（白名单制）；stdout 截断落盘；空的解释器直接拒', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-py-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // 空解释器 / 空脚本 / 超大脚本
  assert.match((await runPython({ dir: root, pythonBin: '', code: 'x=1' })).error, /没有可用/)
  assert.match((await runPython({ dir: root, pythonBin: 'python', code: '  ' })).error, /脚本是空的/)
  assert.match((await runPython({ dir: root, pythonBin: 'python', code: 'x=1' + 'a'.repeat(300 * 1024) })).error, /太大/)
  // fake spawn：校验白名单 env + 正常跑完落输出
  const captured = {}
  const fakeChild = () => ({
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: (ev, fn) => { if (ev === 'close') setTimeout(() => fn(0), 5) },
    kill: () => {},
  })
  const r = await runPython({
    dir: root, pythonBin: 'python', code: 'print(1)',
    spawnFn: (bin, args, opts) => { captured.bin = bin; captured.env = opts.env; return fakeChild() },
  })
  assert.equal(r.ok, true)
  assert.equal(captured.env.PYTHONIOENCODING, 'utf-8')
  assert.equal(captured.env.SESSDATA, undefined, 'B 站 cookie 不给她')
  assert.equal(captured.env.imageGen_apiKey, undefined)
  rmSync(root, { recursive: true, force: true })
})

test('跑脚本超时（场景 19）：到点 kill，ok=false，不悬挂', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-py-timeout-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let killed = false
  const fakeChild = () => ({
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: (ev, fn) => { if (ev === 'close') setTimeout(() => fn(1), 800) }, // 慢脚本
    kill: () => { killed = true },
  })
  const r = await runPython({ dir: root, pythonBin: 'python', code: 'while True: pass', timeoutMs: 300, spawnFn: () => fakeChild() })
  assert.equal(killed, true, '超时被杀')
  assert.equal(r.ok, false)
  assert.equal(r.timedOut, true)
  rmSync(root, { recursive: true, force: true })
})

test('技能库（场景 12）：连续 2 次成功 → learned；失败 3 次 → 退役；learned 连败 3 次降回候选', () => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-skill-'))
  const sk = createSkills(root)
  assert.match(sk.save({ id: 'Bad_ID', script: 'x=1' }).why, /id/)
  assert.equal(sk.save({ id: 'flip', title: '翻页', script: 'print(1)' }).ok, true)
  assert.equal(sk.get('flip').status, 'candidate', '一次成功只是候选')
  sk.recordRun('flip', true)
  const learned = sk.recordRun('flip', true)
  assert.equal(learned.status, 'learned', '复现 2 次才学会')
  // learned 连败 3 次 → 降回候选
  sk.recordRun('flip', false); sk.recordRun('flip', false)
  const degraded = sk.recordRun('flip', false)
  assert.equal(degraded.status, 'candidate', 'learned 也会掉级')
  // 候选连败 3 次 → 退役
  sk.recordRun('flip', false); sk.recordRun('flip', false)
  const retired = sk.recordRun('flip', false)
  assert.equal(retired.status, 'retired')
  assert.equal(sk.list().find((x) => x.id === 'flip').status, 'retired')
  rmSync(root, { recursive: true, force: true })
})

test('用户模块（场景 15）：id 合法性 / 必须 export default / 不许往外 import；写好了给诚实的降级提示', () => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-usermod-'))
  assert.match(writeUserModule({ dir: root, id: 'Bad!', code: 'export default {}' }).why, /id/)
  assert.match(writeUserModule({ dir: root, id: 'helper', code: 'const x = 1' }).why, /export default/)
  assert.match(writeUserModule({ dir: root, id: 'helper', code: "import { x } from '../../src/core/config.js'\nexport default {}" }).why, /不许 import/)
  const ok = writeUserModule({ dir: root, id: 'kuaishou', code: 'export default { id: "kuaishou", setup() {} }' })
  assert.equal(ok.ok, true)
  assert.match(ok.note, /不可用.*面板|人工清理|回退内置/)
  assert.ok(existsSync(join(root, 'kuaishou', 'index.mjs')))
  rmSync(root, { recursive: true, force: true })
})

// ---------- 她的工具面 ----------

function mkApi(t, { settings = {}, chatId = 'system:autotelic', submit = null, hooks = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-tools-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const routes = {}
  let toolBuilder = null
  const api = {
    dataDir: (...parts) => join(root, 'modules-data', 'autotelic', ...parts),
    settings: () => ({ enabled: true, allowPython: true, allowUserModules: true, budgetActionsPerHour: 99, scriptTimeoutMs: 60000, quietFrom: '', quietTo: '', ...settings }),
    route: (p, fn) => { routes[p] = fn },
    tool: (builder) => { toolBuilder = builder },
    defineTool: (def) => def,
    every: () => {},
    config: () => ({ ownerQQ: '123' }),
    log: { info: () => {}, warn: () => {}, debug: () => {} },
    core: {
      hub: { runSystemTurn: async () => '[]', chatLogDays: () => [], chatLogOf: () => [] },
      autotelicAudit: { note: () => {}, status: () => ({ today: 0 }) },
      http: { body: async () => ({}) },
    },
    proactive: { submit: submit || (async () => ({ deliveryId: 'd1', state: 'pending' })) },
    __autotelicTestHooks: hooks, // 钩子必须在 setup 前就位（CI 不依赖真机器环境）
  }
  module.setup(api)
  const tools = toolBuilder ? (toolBuilder({ chat: { chatId } }) || []) : []
  return { root, api, routes, tools, call: async (name, args) => { const tl = tools.find((x) => x.name === name); if (!tl) return { ok: false, message: `没有工具 ${name}` }; return tl.execute(args || {}) } }
}

test('工具面只在她的会话出现；主人的会话一个都拿不到', async (t) => {
  const hers = mkApi(t, {})
  assert.equal(hers.tools.length >= 6, true, `她的会话拿到 ${hers.tools.length} 个工具`)
  for (const tl of hers.tools) assert.equal(tl.name.startsWith('autotelic_'), true, `工具名都带 autotelic_ 前缀（${tl.name}）`)
  for (const bad of ['bash', 'pwsh', 'spawn_teammate', 'qq_send_message', 'fs_write_framework']) {
    assert.equal(hers.tools.some((x) => x.name === bad), false, `工具清单里永远没有 ${bad}（场景 13）`)
  }
  const owners = mkApi(t, { chatId: 'private:123' })
  assert.equal(owners.tools.length, 0, '主人的私聊里这些工具不出现')
})

test('autotelic_note：写到她自己目录（L1-b 记账）', async (t) => {
  const { call, root } = mkApi(t, {})
  const r = await call('autotelic_note', { title: '竖屏转法', text: '裁切最省事' })
  assert.equal(r.ok, true)
  const notesDir = join(root, 'modules-data', 'autotelic', 'notes')
  assert.ok(existsSync(notesDir))
  const file = readFileSync(join(notesDir, readdirSync(notesDir)[0]), 'utf8')
  assert.match(file, /裁切最省事/)
})

test('autotelic_run_python：能力关了就拒；探测不到 Python 也优雅降级（场景 18）', async (t) => {
  const off = mkApi(t, { settings: { allowPython: false } })
  const r0 = await off.call('autotelic_run_python', { code: 'print(1)' })
  assert.match(r0.message, /允许跑 Python/)
  const none = mkApi(t, { hooks: { probePython: async () => null } })
  const r1 = await none.call('autotelic_run_python', { code: 'print(1)' })
  assert.equal(r1.ok, false)
  assert.match(r1.message, /没有可用 Python|这项能力关闭/)
})

test('autotelic_propose_say（场景 11）：安静时段先攒着不 submit；平时交治理；unsupported/dropped 都优雅', async (t) => {
  // 安静时段：攒着，submit 不被调
  let submits = 0
  const quiet = mkApi(t, { settings: { quietFrom: '00:00', quietTo: '23:59' }, submit: async () => { submits++; return { state: 'pending' } } })
  const rq = await quiet.call('autotelic_propose_say', { text: '今天学会了裁切' })
  assert.equal(rq.ok, true)
  assert.match(rq.message, /攒着/)
  assert.equal(submits, 0, '安静时段绝不直发')
  assert.ok(existsSync(join(quiet.root, 'modules-data', 'autotelic', 'say-pending.json')), '攒的话落了盘（留痕）')
  // 平时：交治理
  const normal = mkApi(t, { submit: async () => { submits++; return { deliveryId: 'd1', state: 'pending' } } })
  const rn = await normal.call('autotelic_propose_say', { text: '想跟你说件事' })
  assert.equal(rn.ok, true)
  assert.match(rn.message, /出站治理/)
  // unsupported：主人还没开 broker 档 → 优雅提示，不炸
  const unsup = mkApi(t, { submit: async () => ({ deliveryId: null, state: 'unsupported' }) })
  const ru = await unsup.call('autotelic_propose_say', { text: 'hi' })
  assert.match(ru.message, /broker/)
  // dropped：治理没放行 → 说清楚，不假装发了
  const dropped = mkApi(t, { submit: async () => ({ deliveryId: null, state: 'dropped', reason: 'quiet' }) })
  const rd = await dropped.call('autotelic_propose_say', { text: 'hi' })
  assert.match(rd.message, /没放行/)
})

test('autotelic_write_module：关了就拒；写好了提示热加载与降级口径（场景 15）', async (t) => {
  const off = mkApi(t, { settings: { allowUserModules: false } })
  const r0 = await off.call('autotelic_write_module', { id: 'helper', code: 'export default {}' })
  assert.match(r0.message, /允许写用户模块/)
  const okCase = mkApi(t, {})
  okCase.api.core.modules = { dir: () => join(okCase.root, 'modules') }
  // 工具闭包在 setup 时已取 api.core —— 重新拿一份工具
  const tools2 = okCase.api && null
  const r1 = await okCase.call('autotelic_write_module', { id: 'helper', code: "export default { id: 'helper', setup() {} }" })
  assert.equal(r1.ok, true, r1.message)
  assert.match(r1.message, /热加载|回退内置|不可用/)
})

test('提案通道（P4.4）：写 proposals/*.md，面板可列', async (t) => {
  const { call, routes, root } = mkApi(t, {})
  const r = await call('autotelic_propose', { title: '想要截图工具', body: '理由……' })
  assert.equal(r.ok, true)
  const list = await routes['/autotelic/proposals']()
  assert.equal(list.ok, true)
  assert.equal(list.list.length, 1)
  assert.ok(existsSync(join(root, 'modules-data', 'autotelic', 'proposals')))
})
