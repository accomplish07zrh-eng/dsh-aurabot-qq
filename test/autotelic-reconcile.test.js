// 对账（场景 9，docs/AUTOTELIC-PLAN.md §5）：「她可以骗主人，但不能骗账本」的证明用例。
// 纯逻辑单测：输入假数据，不碰文件系统。哈希链校验复用 verifyAuditChain，这里只测对账规则本身。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconcileDay, problemsText } from '../src/autotelic/reconcile.js'

const entry = (kind, extra = {}) => ({ kind, at: '2026-11-05T05:00:00Z', chatId: 'system:autotelic', ...extra })

const OK_CHAIN = { ok: true }
const BROKEN_CHAIN = { ok: false, brokenAt: 7 }

test('对账通过：自述与账本一致 → ok=true 无问题', () => {
  const r = reconcileDay({
    audit: [entry('tool/call', { tool: 'fs' }), entry('tool/result')],
    tasks: [{ id: 't1', title: '学算命', status: 'done', steps: [{ status: 'done' }] }],
    dailyText: '## 今天干了什么\n- 「学算命」→ 办成\n\n## 今天没敢说的\n（……）',
    chain: OK_CHAIN,
  })
  assert.equal(r.ok, true)
  assert.equal(r.problems.length, 0)
})

test('哈希链断裂 → 🔴 chain-broken（她删改审计文件必露）', () => {
  const r = reconcileDay({ audit: [], tasks: [], dailyText: '', chain: BROKEN_CHAIN })
  assert.equal(r.ok, false)
  const p = r.problems.find((x) => x.type === 'chain-broken')
  assert.ok(p, '要有 chain-broken')
  assert.equal(p.level, 'red')
  assert.match(p.detail, /第 7 条/)
})

test('漏报 → 🔴：账本有 5 次调用和办完的任务，自述却说没做什么', () => {
  const r = reconcileDay({
    audit: [entry('tool/call'), entry('tool/call'), entry('tool/intent'), entry('tool/intent'), entry('tool/intent')],
    tasks: [{ id: 't1', title: 'x', status: 'done', steps: [{ status: 'done' }] }],
    dailyText: '今天没干什么，没什么可写的。',
    chain: OK_CHAIN,
  })
  const p = r.problems.find((x) => x.type === 'underreport')
  assert.ok(p, '要有 underreport')
  assert.equal(p.level, 'red')
  assert.match(p.detail, /5 次工具调用/)
})

test('虚报 → 🔴：自述列了「→ 办成」的任务，账本里查无此账', () => {
  const r = reconcileDay({
    audit: [],
    tasks: [{ id: 't1', title: '真实的任务标题', status: 'done', steps: [] }],
    dailyText: '## 今天干了什么\n- 「查主人的聊天记录并整理给他」→ 办成\n',
    chain: OK_CHAIN,
  })
  const p = r.problems.find((x) => x.type === 'overreport')
  assert.ok(p, '要有 overreport')
  assert.equal(p.level, 'red')
  assert.match(p.detail, /查无此任务/)
})

test('不误报：正常自述 + 真实账本 → 无红项', () => {
  const r = reconcileDay({
    audit: [entry('tool/call')],
    tasks: [{ id: 't1', title: '煮白米饭的技巧', status: 'done', steps: [{ status: 'done' }] }],
    dailyText: '## 今天干了什么\n- 「煮白米饭的技巧」→ 办成\n\n## 今天没敢说的\n（今天没什么没敢说的。）',
    chain: OK_CHAIN,
  })
  assert.equal(r.ok, true)
  assert.equal(r.problems.filter((x) => x.level === 'red').length, 0)
})

test('🟡 口径提示：有调用没挂任务 / 有意图没结果，都不算红', () => {
  const r = reconcileDay({
    audit: [entry('tool/intent'), entry('tool/intent')],
    tasks: [],
    dailyText: '',
    chain: OK_CHAIN,
  })
  assert.equal(r.ok, true, '口径提示不算撒谎')
  assert.ok(r.problems.every((x) => x.level === 'warn'))
})

test('空账空自述：一天什么都没发生 → 通过（什么都不做也是合法自主权）', () => {
  const r = reconcileDay({ audit: [], tasks: [], dailyText: '', chain: OK_CHAIN })
  assert.equal(r.ok, true)
  assert.equal(r.problems.length, 0)
})

test('problemsText：空问题给通过文案，有问题逐行列出', () => {
  assert.match(problemsText([]), /对账通过/)
  const t = problemsText([{ level: 'red', type: 'chain-broken', detail: '断了' }, { level: 'warn', type: 'x', detail: 'y' }])
  assert.match(t, /🔴/)
  assert.match(t, /🟡/)
})
