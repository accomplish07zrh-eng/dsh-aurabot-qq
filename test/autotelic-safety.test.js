// 自驱引擎安全契约（维护者 review 要求补的兜底）：
//   1) 默认关闭时行为完全不变——不碰 hub、不碰模型、不落盘；
//   2) 审计链断点：篡改后可检出（status().chain），且断点后记账不掩盖断裂；
//   3) L2 分级拒绝：白名单外的动作一律不在允许集合内（首期白名单为空）；
//   4) 重启恢复：在途 step 改判 failed，done 原样保留，坏账本兜底不抛。
// 本文件只做契约断言，不启动真实 DSH / 真模型 / 真子进程。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuditor } from '../src/autotelic/audit.js'
import { createBook } from '../src/autotelic/book.js'
import { createRuntime } from '../src/autotelic/runtime.js'
import { ALLOWED_TOOLS } from '../src/autotelic/exec.js'

const root = () => mkdtempSync(join(tmpdir(), 'aurabot-safety-'))
// 审计账本按本地时区命名（audit.js 的 dayFile 用 getFullYear/getMonth/getDate）
const dayFileOf = (dir) => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return join(dir, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`)
}

// ---------- 1. 默认关闭：行为完全不变 ----------

test('默认关闭（契约）：tick 返回 disabled，且零 IO——不建账本、不调模型、不碰 hub', async (t) => {
  const dir = root()
  const calls = { evalTurn: 0, screenTurn: 0, hub: 0 }
  const rt = createRuntime({
    settings: () => ({ enabled: false }),
    cfg: {}, memoryOf: () => ({ list: () => [{ id: 'm1', text: '素材', at: Date.now() }] }),
    ledgerFile: join(dir, 'ledger.json'),
    evalTurn: async () => { calls.evalTurn++; return '[]' },
    screenTurn: async () => { calls.screenTurn++; return '[]' },
    hub: { deliver: async () => { calls.hub++ } },
    log: { debug: () => {} },
  })
  const r = await rt.tick()
  assert.equal(r.outcome, 'disabled', '关闭时的出口是 disabled')
  assert.equal(existsSync(join(dir, 'ledger.json')), false, '关着不落任何盘')
  assert.equal(calls.evalTurn, 0, '关着不调评估模型')
  assert.equal(calls.screenTurn, 0, '关着不调审阅模型')
  assert.equal(calls.hub, 0, '关着绝不向 hub 发任何消息')
})

test('默认关闭（契约）：settings 缺省值等同关闭（没显式开启就不跑）', async (t) => {
  const dir = root()
  const rt = createRuntime({
    settings: () => ({}),
    cfg: {}, memoryOf: () => ({ list: () => [] }),
    ledgerFile: join(dir, 'ledger.json'),
    evalTurn: async () => '[]', log: { debug: () => {} },
  })
  const r = await rt.tick()
  assert.equal(r.outcome, 'disabled', '缺省即关闭')
  assert.equal(existsSync(join(dir, 'ledger.json')), false)
})

test('默认关闭（契约）：空账本只读不落盘、不产生任务', () => {
  const dir = root()
  const file = join(dir, 'ledger.json')
  const book = createBook({ file, now: () => Date.now() })
  assert.equal(existsSync(file), false, '只读账本不落盘')
  assert.deepEqual(book.list(), [], '空账本')
})

test('审计器只记录不拦截：非她会话的工具调用一律放行', async () => {
  const dir = root()
  const auditor = createAuditor({ dir, ownRoot: dir, chatMap: {} })
  // audit 的设计契约：非她的会话 preExecute 直接 return next()，只记账不阻断
  const next = () => ({ kind: 'pass', allowed: true })
  const out = await auditor.preExecute({ name: 'fs', arguments: {}, agent: { session: { id: 'system:owner' } } }, next)
  assert.ok(out, '主人会话必须正常放行')
  assert.equal(out.kind, 'pass', '不改变原有放行结果')
})

// ---------- 2. 审计链断点 ----------

test('审计链断点：篡改账本后 status().chain 检出 brokenAt，不静默通过', async () => {
  const dir = root()
  const auditor = createAuditor({ dir, ownRoot: dir, chatMap: { her: 'system:autotelic' } })
  auditor.note({ kind: 'tool/call', tool: 'fs', args: {}, outcome: 'ok' })
  auditor.note({ kind: 'tool/call', tool: 'fs', args: {}, outcome: 'ok' })
  auditor.note({ kind: 'tool/call', tool: 'fs', args: {}, outcome: 'ok' })
  await auditor.flush()
  const good = await auditor.status()
  assert.equal(good.chain.ok, true, '未篡改时链条完整')
  assert.ok(good.today >= 3, '今天的条目数对得上')
  const f = dayFileOf(dir)
  assert.equal(existsSync(f), true, '账本已落盘')
  const rows = readFileSync(f, 'utf8').split('\n').filter(Boolean)
  const tampered = rows.map((line, i) => {
    if (i !== 1) return line
    const obj = JSON.parse(line)
    return JSON.stringify({ ...obj, outcome: '被改过' })
  })
  writeFileSync(f, tampered.join('\n') + '\n', 'utf8')
  const bad = await auditor.status()
  assert.equal(bad.chain.ok, false, '篡改必须被检出')
  assert.ok(bad.chain.brokenAt !== undefined, '给出断点位置，供面板显示')
})

test('审计链断点：断点后继续记账不掩盖断裂', async () => {
  const dir = root()
  const auditor = createAuditor({ dir, ownRoot: dir, chatMap: { her: 'system:autotelic' } })
  auditor.note({ kind: 'tool/call', tool: 'a', args: {}, outcome: 'ok' })
  auditor.note({ kind: 'tool/call', tool: 'b', args: {}, outcome: 'ok' })
  await auditor.flush()
  const f = dayFileOf(dir)
  const rows = readFileSync(f, 'utf8').split('\n').filter(Boolean)
  rows[0] = JSON.stringify({ ...JSON.parse(rows[0]), tool: '篡改' })
  writeFileSync(f, rows.join('\n') + '\n', 'utf8')
  auditor.note({ kind: 'tool/call', tool: 'c', args: {}, outcome: 'ok' })
  await auditor.flush()
  const chain = await auditor.status()
  assert.equal(chain.chain.ok, false, '后续记账不能让前面被改的痕迹消失')
})

// ---------- 3. L2 分级拒绝 ----------

test('L2 拒绝：白名单只含只读/取数类工具，发消息与 shell 一律不在其中', () => {
  assert.ok(Array.isArray(ALLOWED_TOOLS), '白名单是显式集合')
  assert.ok(ALLOWED_TOOLS.length > 0, '至少有只读工具')
  // L2 = 白名单外的 shell / onebot / 发消息 → 首期全排除
  for (const danger of ['shell', 'exec', 'onebot', 'sendText', 'sendMessage', 'qq']) {
    assert.equal(ALLOWED_TOOLS.includes(danger), false, `L2 工具 ${danger} 不得在白名单内`)
  }
  // L0/L1 只读能力应在其中
  assert.ok(ALLOWED_TOOLS.includes('fs'), '只读 fs 允许')
  assert.ok(ALLOWED_TOOLS.includes('web'), '取数 web 允许')
})

test('L2 拒绝：白名单是冻结的（运行时改不动，防止自我提权）', () => {
  assert.equal(Object.isFrozen(ALLOWED_TOOLS), true, '白名单必须冻结，运行时代码改不了')
})

// ---------- 4. 重启恢复 ----------

test('重启恢复：在途 step 改判 failed（写明重启原因），done 的 step 不重跑', () => {
  const dir = root()
  const file = join(dir, 'ledger.json')
  const a = createBook({ file, now: () => Date.now() })
  const { task } = a.addTask({ title: '在途', reason: 'r', todos: [{ desc: '会挂' }, { desc: '没到' }] })
  a.beginStep(task.id) // 第一步跑到一半（running）
  const b = createBook({ file, now: () => Date.now() }) // 新实例 = 插件重启
  const t2 = b.list().find((x) => x.id === task.id)
  assert.ok(t2, '任务本身还在')
  const running = (t2.steps || []).filter((s) => s.status === 'running')
  assert.equal(running.length, 0, '重启后不应再有 running 的 step')
  const failedSteps = (t2.steps || []).filter((s) => s.status === 'failed')
  assert.ok(failedSteps.length >= 1, '在途 step 改判 failed 等重试')
  assert.match(String(failedSteps[0].why || ''), /重启|在途/, '失败原因写明是重启导致')
})

test('重启恢复：done 的 step 保持 done，不被重跑', () => {
  const dir = root()
  const file = join(dir, 'ledger.json')
  const a = createBook({ file, now: () => Date.now() })
  const { task } = a.addTask({ title: '办完一步', reason: 'r', todos: [{ desc: 'a' }, { desc: 'b' }] })
  a.beginStep(task.id)
  a.endStep(task.id, { ok: true, note: '成了' })
  const b = createBook({ file, now: () => Date.now() })
  const t2 = b.list().find((x) => x.id === task.id)
  const doneSteps = (t2.steps || []).filter((s) => s.status === 'done')
  assert.ok(doneSteps.length >= 1, '已完成的 step 保持 done')
  assert.equal((t2.steps || []).filter((s) => s.status === 'running').length, 0, '没有残留 running')
})

test('重启恢复：落盘账本续读——新实例读到旧任务', () => {
  const dir = root()
  const file = join(dir, 'ledger.json')
  const a = createBook({ file, now: () => Date.now() })
  const { task } = a.addTask({ title: '办好它', reason: 'r', todos: [{ desc: 'a' }] })
  const before = a.list()
  const b = createBook({ file, now: () => Date.now() })
  const after = b.list()
  assert.equal(after.length, before.length, '任务数不变')
  assert.equal(after[0].id, before[0].id, '同一任务续读')
})

test('重启恢复：账本文件损坏时不抛，按空账本兜底', () => {
  const dir = root()
  const file = join(dir, 'ledger.json')
  writeFileSync(file, '{ 这不是合法 json', 'utf8')
  const book = createBook({ file, now: () => Date.now() })
  assert.deepEqual(book.list(), [], '坏文件按空账本处理，不让插件起不来')
})
