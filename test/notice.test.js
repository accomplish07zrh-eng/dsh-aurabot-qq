// 上报通道的纯逻辑：开关判定、去重、合并窗口、失败重试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNoticeRelay, normalizeWorkspace } from '../src/features/notice.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cfg = (over = {}) => ({
  enabled: true,
  dryRun: false,
  ownerQQ: '10001',
  notice: { approval: true, question: true, workspaces: {} },
  ...over,
})

test('normalizeWorkspace：大小写、斜杠、末尾分隔符都抹平', () => {
  assert.equal(normalizeWorkspace('C:\\Work\\Proj\\'), 'c:/work/proj')
  assert.equal(normalizeWorkspace('C:/Work/Proj'), 'c:/work/proj')
  assert.equal(normalizeWorkspace('/home/user/proj/'), '/home/user/proj')
  assert.equal(normalizeWorkspace(''), '')
})

test('总开关 / 试运行 / 没配主人号时一律不报', () => {
  assert.equal(createNoticeRelay({ getConfig: () => cfg({ enabled: false }) }).enabled('approval', 's'), false)
  assert.equal(createNoticeRelay({ getConfig: () => cfg({ dryRun: true }) }).enabled('approval', 's'), false)
  assert.equal(createNoticeRelay({ getConfig: () => cfg({ ownerQQ: '' }) }).enabled('approval', 's'), false)
  assert.equal(createNoticeRelay({ getConfig: () => cfg() }).enabled('approval', 's'), true)
})

test('按工作区覆盖：关掉审批不影响提问', () => {
  const r = createNoticeRelay({
    getConfig: () => cfg({ notice: { approval: true, question: true, workspaces: { 'c:/proj': { approval: false } } } }),
    workspaceOf: () => 'C:\\proj',
  })
  assert.equal(r.enabled('approval', 's'), false)
  assert.equal(r.enabled('question', 's'), true)
})

test('同一个 id 只收一次', () => {
  const r = createNoticeRelay({ getConfig: () => cfg(), compose: async () => true })
  assert.equal(r.announce('approval', { id: 'x', sessionId: 's', title: 'A' }), true)
  assert.equal(r.announce('approval', { id: 'x', sessionId: 's', title: 'A' }), false)
  assert.equal(r.pending(), 1)
})

test('窗口内多条合并成一批，只推一次', async () => {
  const pushed = []
  const r = createNoticeRelay({ getConfig: () => cfg(), compose: async (items) => { pushed.push(items); return true }, windowMs: 10 })
  r.announce('approval', { id: 'a', sessionId: 's', title: 'A', tool: 'pwsh' })
  r.announce('question', { id: 'b', sessionId: 's', title: 'B', questions: [{ question: '选哪个' }] })
  assert.equal(r.pending(), 2)
  await sleep(40)
  assert.equal(pushed.length, 1)
  assert.equal(pushed[0].length, 2)
  assert.equal(r.pending(), 0)
})

test('攒满 maxItems 立刻推，不等窗口', async () => {
  const pushed = []
  const r = createNoticeRelay({ getConfig: () => cfg(), compose: async (items) => { pushed.push(items); return true }, windowMs: 5000, maxItems: 2 })
  r.announce('approval', { id: 'a', sessionId: 's', title: 'A' })
  r.announce('approval', { id: 'b', sessionId: 's', title: 'B' })
  await sleep(20)
  assert.equal(pushed.length, 1)
  assert.equal(pushed[0].length, 2)
})

test('推送失败会重试，成功后不再重试', async () => {
  let calls = 0
  const r = createNoticeRelay({
    getConfig: () => cfg(),
    compose: async () => { calls += 1; return calls >= 2 },
    windowMs: 5,
    retryDelayMs: 5,
  })
  r.announce('approval', { id: 'a', sessionId: 's', title: 'A' })
  await sleep(60)
  assert.equal(calls, 2)
  assert.equal(r.pending(), 0)
})

test('重试到上限后放弃，不无限重跑', async () => {
  let calls = 0
  const r = createNoticeRelay({
    getConfig: () => cfg(),
    compose: async () => { calls += 1; return false },
    windowMs: 5,
    retryDelayMs: 5,
    retryMax: 2,
  })
  r.announce('approval', { id: 'a', sessionId: 's', title: 'A' })
  await sleep(80)
  assert.equal(calls, 3)   // 首次 + 2 次重试
  assert.equal(r.pending(), 0)
})

test('compose 抛错也算失败，走重试', async () => {
  let calls = 0
  const r = createNoticeRelay({
    getConfig: () => cfg(),
    compose: async () => { calls += 1; throw new Error('boom') },
    windowMs: 5,
    retryDelayMs: 5,
    retryMax: 1,
  })
  r.announce('approval', { id: 'a', sessionId: 's', title: 'A' })
  await sleep(50)
  assert.equal(calls, 2)
})

test('已经处理完的事可以从缓冲里撤掉，不再推送', async () => {
  const pushed = []
  const r = createNoticeRelay({ getConfig: () => cfg(), compose: async (items) => { pushed.push(items); return true }, windowMs: 20 })
  r.announce('approval', { id: 'a', sessionId: 's', title: 'A' })
  r.announce('approval', { id: 'b', sessionId: 's', title: 'B' })
  assert.equal(r.pending(), 2)
  assert.equal(r.cancel('a'), true)
  assert.equal(r.pending(), 1)
  await sleep(50)
  assert.equal(pushed.length, 1)
  assert.equal(pushed[0].length, 1)
  assert.equal(pushed[0][0].id, 'b')
})

test('撤光了就不会再推', async () => {
  let called = 0
  const r = createNoticeRelay({ getConfig: () => cfg(), compose: async () => { called += 1; return true }, windowMs: 20 })
  r.announce('approval', { id: 'a', sessionId: 's', title: 'A' })
  assert.equal(r.cancel('a'), true)
  assert.equal(r.pending(), 0)
  await sleep(50)
  assert.equal(called, 0)
})

test('撤一个不存在的 id 不影响别的', async () => {
  const r = createNoticeRelay({ getConfig: () => cfg(), compose: async () => true, windowMs: 20 })
  r.announce('approval', { id: 'a', sessionId: 's', title: 'A' })
  assert.equal(r.cancel('nope'), false)
  assert.equal(r.pending(), 1)
})
