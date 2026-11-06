// 自驱引擎 P0 地基：机械审计（哈希链 / 会话过滤 / 永远放行）+ 模块壳状态路由。
// 方案见 docs/AUTOTELIC-PLAN.md §3 P0、§4.1；验收场景 §5（重点：9 对账、23 只记她的会话、24 删了会断链）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuditor, verifyAuditChain, isAutotelicChat, AUTOTELIC_CHAT_PREFIX } from '../src/autotelic/audit.js'
import module from '../src/modules/autotelic/index.js'

function tmpDir(t, name) {
  const root = mkdtempSync(join(tmpdir(), `aurabot-autotelic-${name}-`))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/** 构造审计器：chatOfSession 只认她的会话；isOwnedSession 照 hub 口径。 */
function mkAuditor(t, name, { chatMap = {}, owned = () => true, flushMs = 1, ownRoot = '' } = {}) {
  const dir = tmpDir(t, name)
  const debug = []
  const auditor = createAuditor({
    dir,
    chatOfSession: (sid) => chatMap[sid] || '',
    isOwnedSession: owned,
    log: { debug: (...v) => debug.push(v.join(' ')) },
    flushMs,
    ownRoot,
  })
  t.after(() => auditor.dispose())
  return { dir, auditor, debug }
}

function chainFile(dir) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`
}

test('是她的聊天：只有 system:autotelic 前缀算数', () => {
  assert.equal(isAutotelicChat('system:autotelic'), true)
  assert.equal(isAutotelicChat('system:autotelic:task-1'), true)
  assert.equal(isAutotelicChat('system:purpose'), false)
  assert.equal(isAutotelicChat('private:10000'), false)
  assert.equal(isAutotelicChat('group:123'), false)
  assert.equal(isAutotelicChat(''), false)
  assert.equal(AUTOTELIC_CHAT_PREFIX, 'system:autotelic')
})

test('审计只记她自己的会话：主人私聊 / 群聊 / GUI 会话都不进账本（场景 23）', async (t) => {
  const { dir, auditor } = mkAuditor(t, 'filter', {
    chatMap: { her: 'system:autotelic', owner: 'private:10000', group: 'group:123', gui: '' },
    owned: (sid) => sid !== 'gui', // GUI 会话连 aurabot 的会话都不算
  })
  const next = async () => ({ kind: 'allow' })
  for (const [sid, tool] of [['her', 'fs'], ['owner', 'qq_send_message'], ['group', 'fs'], ['gui', 'pwsh']]) {
    const r = await auditor.preExecute({ name: tool, arguments: { command: 'echo hi' }, agent: { session: { id: sid } } }, next)
    assert.deepEqual(r, { kind: 'allow' }, '审计钩子永远放行，不改变执行结果')
  }
  await auditor.flush()
  const chain = await verifyAuditChain(dir)
  assert.equal(chain.total, 1, '只有她那一调用进了账本')
  const text = readFileSync(join(dir, chainFile(dir)), 'utf8')
  assert.match(text, /"tool":"fs"/)
  assert.match(text, /system:autotelic/)
  assert.doesNotMatch(text, /qq_send_message|private:|group:/)
})

test('第二道门（P2.3）：她的会话碰 shell / 进程级工具直接拒并记账；别人的会话不拦', async (t) => {
  const { dir, auditor } = mkAuditor(t, 'gate', { chatMap: { her: 'system:autotelic', owner: 'private:10000' } })
  const next = async () => ({ kind: 'allow' })
  const exec = (sid, tool) => ({ name: tool, arguments: { command: 'Remove-Item /' }, agent: { session: { id: sid } } })
  const denied = await auditor.preExecute(exec('her', 'pwsh'), next)
  assert.equal(denied.kind, 'deny', '她的 pwsh 被拒（第一道门在 preset 不给，这里是兜底）')
  assert.match(denied.reason, /动作菜单|提案/)
  const spawnDenied = await auditor.preExecute(exec('her', 'spawn_teammate'), next)
  assert.equal(spawnDenied.kind, 'deny')
  const ownerOk = await auditor.preExecute(exec('owner', 'pwsh'), next)
  assert.deepEqual(ownerOk, { kind: 'allow' }, '主人私聊不受第二道门管')
  await auditor.flush()
  const chain = await verifyAuditChain(dir)
  assert.equal(chain.total, 2, '她两次被拒的调用留了账；主人的调用不进她的账本')
  const text = readFileSync(join(dir, chainFile(dir)), 'utf8')
  assert.match(text, /tool\/denied/)
})

test('哈希链：连续记录 prevHash 首尾相接，面板校验通过（场景 24 的正面）', async (t) => {
  const { dir, auditor } = mkAuditor(t, 'chain', { chatMap: { her: 'system:autotelic' } })
  const next = async () => ({ kind: 'allow' })
  const exec = (tool) => ({ name: tool, arguments: { q: tool }, agent: { session: { id: 'her' } } })
  await auditor.preExecute(exec('fs'), next)
  await auditor.preExecute(exec('fetch'), next)
  await auditor.preExecute(exec('fs-search'), next)
  await auditor.flush()
  const chain = await verifyAuditChain(dir)
  assert.equal(chain.ok, true)
  assert.equal(chain.total, 3)
  const lines = readFileSync(join(dir, chainFile(dir)), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  assert.equal(lines[0].prevHash, '', '第一条的 prevHash 是空串')
  for (let i = 1; i < lines.length; i++) assert.equal(lines[i].prevHash, lines[i - 1].hash, '每条接上一条的 hash')
})

test('账本被删 / 被改会露：断链能被校验出来并报出位置（场景 24）', async (t) => {
  const { dir, auditor } = mkAuditor(t, 'tamper', { chatMap: { her: 'system:autotelic' } })
  const next = async () => ({ kind: 'allow' })
  for (const tool of ['fs', 'fetch', 'fs-search']) {
    await auditor.preExecute({ name: tool, arguments: {}, agent: { session: { id: 'her' } } }, next)
  }
  await auditor.flush()
  const file = join(dir, chainFile(dir))
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  // 她把中间一条「撕了」：链在第二条处断开
  writeFileSync(file, lines.filter((_, i) => i !== 1).join('\n') + '\n', 'utf8')
  const broken = await verifyAuditChain(dir)
  assert.equal(broken.ok, false)
  assert.equal(broken.brokenAt.file, chainFile(dir))
  assert.equal(broken.brokenAt.line, 2, '断点在第 2 条')
  assert.match(broken.brokenAt.reason, /断链|对不上/)
})

test('结果回填：结果不另起一行，回填到她这次动作的那行（2026-11-05 修 3 连冗余）', async (t) => {
  const { dir, auditor } = mkAuditor(t, 'result', { chatMap: { her: 'system:autotelic' } })
  const session = { id: 'her' }
  await auditor.preExecute({ name: 'fs', arguments: { path: 'x' }, agent: { session: { id: session.id } } }, async () => ({ kind: 'allow' }))
  auditor.onSessionEvent(session, { type: 'tool/result', data: { toolName: 'fs', result: 'ok' } })
  auditor.onSessionEvent(session, { type: 'assistant/message', data: { message: {} } })
  auditor.onSessionEvent(session, { type: 'turn/end', data: { turn: 1 } })
  await auditor.flush()
  const chain = await verifyAuditChain(dir)
  assert.equal(chain.total, 1, '同一动作只落一行（意图 + 结果回填，不再是 3 行）')
  const text = readFileSync(join(dir, chainFile(dir)), 'utf8')
  assert.match(text, /tool\/call/)
  assert.match(text, /"tool":"fs"/)
  assert.match(text, /outcome.*ok/, '结果回填到同一行的 outcome')
})

// —— 2026-11-05 真机审计实证补的两个缺陷 ——

test('结果回填按 DSH 真实事件形状（tool/result 的载荷是 {turn,step,message}，工具名不在顶层）', async (t) => {
  // 真机证据：171 条 tool/result 全是空 tool / 空 outcome——旧实现按 d.toolName 取，永远取不到。
  // DSH 的真实形状：tool/call = {turn,step,callId,name,arguments}；tool/result = {turn,step,message}
  const { dir, auditor } = mkAuditor(t, 'realshape', { chatMap: { her: 'system:autotelic' } })
  const session = { id: 'her' }
  const next = async () => ({ kind: 'allow' })
  await auditor.preExecute({ name: 'read', callId: 'call-1', arguments: { path: 'a.md' }, agent: { session: { id: 'her' } } }, next)
  // 真实形状的结果事件
  auditor.onSessionEvent(session, {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: '文件内容：大肥鱼' }] },
    },
  })
  await auditor.flush()
  const lines = readFileSync(join(dir, chainFile(dir)), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  assert.equal(lines.length, 1, '同一动作仍然只落一行')
  assert.match(lines[0].outcome, /文件内容：大肥鱼/, `结果要真回填（真机旧实现这里是空的）：${JSON.stringify(lines[0])}`)
})

test('结果回填按 callId 关联：同一工具并发调用不会串行（按工具名会串）', async (t) => {
  const { dir, auditor } = mkAuditor(t, 'callid', { chatMap: { her: 'system:autotelic' } })
  const next = async () => ({ kind: 'allow' })
  // 两次 read 并发：pending 里按工具名只有一个槽，旧实现第二条会覆盖第一条／串台
  await auditor.preExecute({ name: 'read', callId: 'c-1', arguments: { path: 'first.md' }, agent: { session: { id: 'her' } } }, next)
  await auditor.preExecute({ name: 'read', callId: 'c-2', arguments: { path: 'second.md' }, agent: { session: { id: 'her' } } }, next)
  const session = { id: 'her' }
  auditor.onSessionEvent(session, { type: 'tool/result', data: { message: { toolCallId: 'c-1', content: [{ type: 'text', text: '第一个的结果' }] } } })
  await auditor.flush()
  const lines = readFileSync(join(dir, chainFile(dir)), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  assert.equal(lines.length, 2, '两次调用各一行')
  const hit = lines.filter((l) => /第一个的结果/.test(l.outcome || ''))
  assert.equal(hit.length, 1, `结果只能落到一条上，实得 ${hit.length} 条`)
})

test('第二道门补拦 MCP / 团队类工具（真机审计：browser_navigate、team_task_list、list_agents 被她调到了）', async (t) => {
  const { dir, auditor } = mkAuditor(t, 'mcpgate', { chatMap: { her: 'system:autotelic', owner: 'private:10000' } })
  const next = async () => ({ kind: 'allow' })
  const exec = (sid, tool) => ({ name: tool, arguments: {}, agent: { session: { id: sid } } })
  for (const tool of ['mcp__browser__browser_navigate', 'mcp__browser__browser_snapshot', 'team_task_list', 'task_board_list', 'list_agents']) {
    const r = await auditor.preExecute(exec('her', tool), next)
    assert.equal(r.kind, 'deny', `她的会话不许碰 ${tool}`)
  }
  // 只读 fs 仍然放行（别把闸做成一刀切）
  const ok = await auditor.preExecute(exec('her', 'read'), next)
  assert.deepEqual(ok, { kind: 'allow' }, 'read 照常放行')
  // 主人私聊不受影响
  const ownerOk = await auditor.preExecute(exec('owner', 'mcp__browser__browser_navigate'), next)
  assert.deepEqual(ownerOk, { kind: 'allow' }, '主人自己用浏览器不受她的闸管')
  await auditor.flush()
  const text = readFileSync(join(dir, chainFile(dir)), 'utf8')
  assert.match(text, /tool\/denied/, '被拒的要留账')
})

test('写工具只许写她自己目录：目录外拒绝，目录内放行（真机审计：她用 edit/write 改过自己的 notes）', async (t) => {
  const root = tmpDir(t, 'writeroot')
  const { dir, auditor } = mkAuditor(t, 'writescope', { chatMap: { her: 'system:autotelic' }, ownRoot: root })
  const next = async () => ({ kind: 'allow' })
  const exec = (tool, p) => ({ name: tool, arguments: { file_path: p }, agent: { session: { id: 'her' } } })
  const inside = await auditor.preExecute(exec('write', join(root, 'notes', 'a.md')), next)
  assert.deepEqual(inside, { kind: 'allow' }, '写自己 notes 放行')
  const outside = await auditor.preExecute(exec('edit', 'D:/Trae CN/project/pulis/aurabot/repo/src/host.js'), next)
  assert.equal(outside.kind, 'deny', '写框架代码要被拒')
  const escape = await auditor.preExecute(exec('write', join(root, '..', 'outside.md')), next)
  assert.equal(escape.kind, 'deny', '用 .. 跳出目录也要被拒')
  await auditor.flush()
  const text = readFileSync(join(dir, chainFile(dir)), 'utf8')
  assert.match(text, /tool\/denied/)
})

/** 造一个写工具测试用的临时根（跟审计目录分开）。 */
test('孤儿结果：没有对应意图的结果事件不落行（非她会话的结果被前置过滤挡住）', async (t) => {  const { dir, auditor } = mkAuditor(t, 'orphan', { chatMap: { her: 'system:autotelic' } })
  const session = { id: 'her' }
  auditor.onSessionEvent(session, { type: 'tool/result', data: { toolName: 'fs', result: 'ok' } })
  await auditor.flush()
  const chain = await verifyAuditChain(dir)
  assert.equal(chain.total, 0, '没有意图的结果事件没有行可回填，直接丢')
})

test('参数截断：超长参数只留头部，落盘不炸', async (t) => {
  const { dir, auditor } = mkAuditor(t, 'clip', { chatMap: { her: 'system:autotelic' } })
  const big = { text: 'x'.repeat(100_000) }
  await auditor.preExecute({ name: 'fs', arguments: big, agent: { session: { id: 'her' } } }, async () => ({ kind: 'allow' }))
  await auditor.flush()
  const chain = await verifyAuditChain(dir)
  assert.equal(chain.ok, true)
  const text = readFileSync(join(dir, chainFile(dir)), 'utf8')
  assert.ok(text.length < 5000, '参数被截断，不整段落盘')
})

test('重启恢复链头：新审计器接旧链能续上', async (t) => {
  const dir = tmpDir(t, 'resume')
  const opts = { dir, chatOfSession: (sid) => (sid === 'her' ? 'system:autotelic' : ''), isOwnedSession: () => true, flushMs: 1 }
  const first = createAuditor({ ...opts, log: { debug: () => {} } })
  await first.preExecute({ name: 'fs', arguments: {}, agent: { session: { id: 'her' } } }, async () => ({}))
  await first.dispose()
  // 「重启」：新审计器实例，同一目录
  const second = createAuditor({ ...opts, log: { debug: () => {} } })
  await second.preExecute({ name: 'fetch', arguments: {}, agent: { session: { id: 'her' } } }, async () => ({}))
  await second.dispose()
  const chain = await verifyAuditChain(dir)
  assert.equal(chain.ok, true, '新实例接着旧链写，不断')
  assert.equal(chain.total, 2)
})

test('模块壳：默认全关、状态路由返回审计链校验，enabled=false 不做任何 IO（场景 1）', async (t) => {
  const root = tmpDir(t, 'module')
  const routes = {}
  const settingsStore = { ...module.defaults }
  const api = {
    dataDir: (...parts) => join(root, 'modules-data', 'autotelic', ...parts),
    settings: () => settingsStore,
    route: (path, fn) => { routes[path] = fn },
    every: () => {},
    tool: () => {}, // 心跳注册（P1）；测试里不需要真跑
    config: () => ({ ownerQQ: '' }),
    log: { debug: () => {}, info: () => {}, warn: () => {} },
    core: {}, // host 没接线 → audit.wired = false
  }
  const exported = module.setup(api)
  assert.equal(typeof exported.auditDir, 'function')
  assert.equal(typeof exported.runtime.tick, 'function', 'P1：模块导出运行时')
  assert.equal(api.dataDir('audit').includes(join('modules-data', 'autotelic', 'audit')), true, '审计目录在 modules-data/autotelic/audit，不多一层')
  const status = await routes['/autotelic/status']()
  assert.equal(status.ok, true)
  assert.equal(status.enabled, false)
  assert.equal(status.audit.wired, false, 'host 没接线时如实报告「未开启」')
  assert.equal(status.audit.today, 0)
  assert.equal(status.audit.chain.ok, true, '空目录 = 完好的空链')
  assert.deepEqual(status.heartbeats, [])
  assert.equal(status.summary.total, 0)
  assert.deepEqual(status.tasks, [], '默认关时账本是空的')
  assert.deepEqual(Object.keys(routes).sort(), ['/autotelic/day', '/autotelic/env', '/autotelic/journal', '/autotelic/preview', '/autotelic/proposals', '/autotelic/run', '/autotelic/skills', '/autotelic/status', '/autotelic/step', '/autotelic/takeover', '/autotelic/takeover-status', '/autotelic/tune'].sort(), 'P0~P4 + 接管：状态/预览/手动跑/推进一步/调参/复盘/技能/提案/环境/某天记录/接管与还原/接管状态')
})

test('模块壳：host 接线后状态路由显示「审计已开启」与当日条数', async (t) => {
  const root = tmpDir(t, 'module-wired')
  const routes = {}
  const settingsStore = { ...module.defaults, enabled: true }
  const api = {
    dataDir: (...parts) => join(root, 'modules-data', 'autotelic', ...parts),
    settings: () => settingsStore,
    route: (path, fn) => { routes[path] = fn },
    every: () => {},
    tool: () => {},
    config: () => ({ ownerQQ: '' }),
    log: { debug: () => {} },
    core: { autotelicAuditOn: true },
  }
  module.setup(api)
  // host 侧的审计器往同一目录写了一条
  const auditDir = join(root, 'modules-data', 'autotelic', 'audit')
  mkdirSync(auditDir, { recursive: true })
  writeFileSync(join(auditDir, chainFile(auditDir)), '\n', 'utf8')
  const status = await routes['/autotelic/status']()
  assert.equal(status.audit.wired, true)
  assert.equal(status.audit.chain.total, 0) // 空行不算条目
})

test('声明式配置：settings 覆盖所有用户可见键，内部键不进面板', () => {
  const keys = module.settings.map((s) => s.key)
  // 内部状态键（takenOver = 接管原值备份）：不进 settings 数组，面板不展示表单，只在状态里只读显示
  const INTERNAL = ['takenOver']
  const visible = Object.keys(module.defaults).filter((k) => !INTERNAL.includes(k)).sort()
  assert.deepEqual(keys.sort(), visible, 'settings 数组与 defaults 对齐（内部键除外；面板按数组生成）')
  for (const k of INTERNAL) assert.equal(keys.includes(k), false, `内部键 ${k} 不该出现在面板表单里`)
  assert.equal(module.defaults.enabled, false, '总开关默认关')
  assert.equal(module.defaults.presetIdOverride, false, 'presetId 覆盖开关默认关（§9）')
  assert.equal(module.defaults.takeover, false, '接管默认关（主人手动点才生效，TAKEOVER §3）')
  for (const forbidden of ['l2PerDay', 'budgetTokensPerDay']) {
    assert.equal(keys.includes(forbidden), false, `${forbidden} 首期不存在（§2.2 / §4.8）`)
  }
})
