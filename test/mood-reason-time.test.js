import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMood } from '../src/features/companion.js'
import { normalize } from '../src/core/config.js'
import { moodReason } from '../src/features/mood-context.js'
import moodModule from '../src/modules/mood/index.js'

const HOUR = 3600_000
const now = new Date(2026, 10, 4, 14, 0).getTime()
function setup(t, patch = {}, dsh) {
  const previous = process.env.AURABOT_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-mood-time-'))
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
  })
  t.mock.timers.enable({ apis: ['Date'], now })
  const cfg = normalize({ mood: { enabled: true, halfLifeHours: 24, ...patch }, model: { provider: 'p', model: 'm' } })
  return { mood: createMood({ getConfig: () => cfg, dsh }), cfg, file: join(dir, 'mood.json') }
}

test('心情理由记录发生时间，重启后按分钟/小时展示，三小时后隐藏', (t) => {
  const { mood, cfg, file } = setup(t)
  mood.nudge(30, '主人调侃她存图')
  const state = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(state.reasonAt, now)
  assert.equal(state.reasonAt, state.at)
  assert.match(mood.contextLine(), /1 分钟前因为主人调侃她存图/)
  t.mock.timers.setTime(now + 25 * 60_000)
  const restored = createMood({ getConfig: () => cfg })
  assert.match(restored.contextLine(), /25 分钟前因为主人调侃她存图/)
  t.mock.timers.setTime(now + 2 * HOUR)
  assert.match(restored.contextLine(), /2 小时前因为主人调侃她存图/)
  t.mock.timers.setTime(now + 3 * HOUR)
  assert.match(restored.contextLine(), /开心/)
  assert.doesNotMatch(restored.contextLine(), /因为|调侃|存图/)
})

test('模型判断未达到阈值，不把旧理由刷新为现在发生', async (t) => {
  let answer = { delta: 1, reason: '不重要的新话', confidence: 1 }
  const dsh = { get: () => null, llm: { async *stream() {
    yield { type: 'text-delta', text: JSON.stringify(answer) }
    yield { type: 'finish', reason: { kind: 'completed' } }
  } } }
  const { mood } = setup(t, { judge: true }, dsh)
  mood.nudge(30, '被调侃了')
  t.mock.timers.setTime(now + HOUR)
  await mood.judge({ userText: '嗯', reply: '嗯嗯' })
  assert.equal(mood.state().reasonAt, now)
  assert.match(mood.contextLine(), /1 小时前因为被调侃了/)
  answer = { delta: 10, reason: '没把握的推测', confidence: 0.2 }
  t.mock.timers.setTime(now + 3 * HOUR)
  await mood.judge({ userText: '哦', reply: '好' })
  assert.doesNotMatch(mood.contextLine(), /因为|被调侃|推测/)
  answer = { delta: 5, reason: '主人夸她', confidence: 0.9 }
  await mood.judge({ userText: '真棒', reply: '嘿嘿' })
  assert.equal(mood.state().reasonAt, now + 3 * HOUR)
  assert.match(mood.contextLine(), /1 分钟前因为主人夸她/)
})

test('旧 mood.json 使用原 at，缺失或无效时间不把旧理由当作新事件', (t) => {
  const { mood, file } = setup(t)
  writeFileSync(file, JSON.stringify({ value: 95, at: now - HOUR, reason: '旧事', history: [] }))
  assert.match(mood.contextLine(), /1 小时前因为旧事/)
  writeFileSync(file, JSON.stringify({ value: 95, at: now - 4 * HOUR, reason: '旧事', history: [] }))
  assert.doesNotMatch(mood.contextLine(), /旧事|因为/)
  for (const reasonAt of [0, 'bad', now + 1]) {
    assert.equal(moodReason({ reason: '旧事', at: now, reasonAt }, 90, 60, now), '')
  }
  assert.equal(moodReason({ reason: '旧事' }, 90, 60, now), '')
})

test('心情衰减回基线、平常状态、关闭模块时都不注入理由，支持自定义基线', (t) => {
  const { mood, file, cfg } = setup(t, { base: 80, halfLifeHours: 0.01 })
  mood.nudge(15, '刚才的夸奖')
  t.mock.timers.setTime(now + HOUR)
  assert.equal(mood.current(), 80)
  assert.doesNotMatch(mood.contextLine(), /因为|夸奖/)
  cfg.mood.base = 60
  writeFileSync(file, JSON.stringify({ value: 60, at: Date.now(), reasonAt: Date.now(), reason: '旧事' }))
  assert.equal(mood.contextLine(), '')
  cfg.mood.enabled = false
  assert.equal(mood.contextLine(), '')
})

test('普通聊天和主动搭话共用有时效的心情提示，只放本轮消息，不注册上下文快照', (t) => {
  const { cfg } = setup(t)
  const handlers = new Map()
  const mood = moodModule.setup({ config: () => cfg, log: {}, dsh: null,
    on: (event, handler) => handlers.set(event, handler),
    context: () => assert.fail('动态心情不得进入常驻上下文'),
  })
  mood.nudge(30, '被主人夸了')
  t.mock.timers.setTime(now + HOUR)
  for (const prompt of ['你好', '【系统提醒，不是主人说的话】想主动找主人说点什么']) {
    const content = [{ type: 'text', text: prompt }]
    const result = handlers.get('prompt')(content, { chat: { kind: 'private' } })
    assert.match(result.at(-1).text, /1 小时前因为被主人夸了/)
    assert.equal(content.length, 1)
    t.mock.timers.setTime(now + 3 * HOUR)
    assert.doesNotMatch(handlers.get('prompt')(content, { chat: { kind: 'private' } }).at(-1).text, /因为|被主人夸了/)
    t.mock.timers.setTime(now + HOUR)
  }
  const content = [{ type: 'text', text: '后台' }]
  assert.equal(handlers.get('prompt')(content, { chat: { kind: 'system' } }), content)
})
