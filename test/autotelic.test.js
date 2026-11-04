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
function mkAuditor(t, name, { chatMap = {}, owned = () => true, flushMs = 1 } = {}) {
  const dir = tmpDir(t, name)
  const debug = []
  const auditor = createAuditor({
    dir,
    chatOfSession: (sid) => chatMap[sid] || '',
    isOwnedSession: owned,
    log: { debug: (...v) => debug.push(v.join(' ')) },
    flushMs,
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
  for (const [sid, tool] of [['her', 'pwsh'], ['owner', 'qq_send_message'], ['group', 'fs'], ['gui', 'pwsh']]) {
    const r = await auditor.preExecute({ name: tool, arguments: { command: 'echo hi' }, agent: { session: { id: sid } } }, next)
    assert.deepEqual(r, { kind: 'allow' }, '审计钩子永远放行，不改变执行结果')
  }
  await auditor.flush()
  const chain = await verifyAuditChain(dir)
  assert.equal(chain.total, 1, '只有她那一调用进了账本')
  const text = readFileSync(join(dir, chainFile(dir)), 'utf8')
  assert.match(text, /"tool":"pwsh"/)
  assert.match(text, /system:autotelic/)
  assert.doesNotMatch(text, /qq_send_message|private:|group:/)
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

test('结果补记：session/event 的 tool/* 事件进账本，非 tool 事件不进', async (t) => {
  const { dir, auditor } = mkAuditor(t, 'result', { chatMap: { her: 'system:autotelic' } })
  const session = { id: 'her' }
  auditor.onSessionEvent(session, { type: 'tool/result', data: { toolName: 'fs', result: 'ok' } })
  auditor.onSessionEvent(session, { type: 'assistant/message', data: { message: {} } })
  auditor.onSessionEvent(session, { type: 'turn/end', data: { turn: 1 } })
  await auditor.flush()
  const chain = await verifyAuditChain(dir)
  assert.equal(chain.total, 1)
  const text = readFileSync(join(dir, chainFile(dir)), 'utf8')
  assert.match(text, /tool\/result/)
  assert.match(text, /"tool":"fs"/)
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
    every: () => {}, // 心跳注册（P1）；测试里不需要真跑
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
  assert.deepEqual(Object.keys(routes).sort(), ['/autotelic/preview', '/autotelic/run', '/autotelic/status'].sort(), 'P0+P1：状态 / 预览 / 手动跑一轮')
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

test('声明式配置：settings 键与 defaults 一一对应，首期不存在的键不许混进来', () => {
  const keys = module.settings.map((s) => s.key)
  assert.deepEqual(keys.sort(), Object.keys(module.defaults).sort(), 'settings 数组与 defaults 完全对齐（面板按数组生成）')
  assert.equal(module.defaults.enabled, false, '总开关默认关')
  assert.equal(module.defaults.presetIdOverride, false, 'presetId 覆盖开关默认关（§9）')
  for (const forbidden of ['l2PerDay', 'budgetTokensPerDay']) {
    assert.equal(keys.includes(forbidden), false, `${forbidden} 首期不存在（§2.2 / §4.8）`)
  }
})
