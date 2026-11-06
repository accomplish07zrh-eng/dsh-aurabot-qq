import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { normalize } from '../src/core/config.js'
import { createSpeakUp } from '../src/features/companion.js'
import { currentTimeLine } from '../src/chat/time-context.js'

const root = mkdtempSync(join(tmpdir(), 'aurabot-time-poke-'))
process.env.AURABOT_WORKSPACE = join(root, 'workspace')
const { createHub } = await import('../src/chat/hub.js')
const OWNER = '10000001', BOT = '20000002', GROUP = '30000003'
const CHAT = `private:${OWNER}`
const deferred = () => {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(setImmediate) }
const until = async (predicate) => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(setImmediate)
  assert.ok(predicate(), '等待预期的消息或轮次')
}
const event = (kind, text, extra = []) => ({
  post_type: 'message', message_type: kind, sub_type: kind === 'group' ? 'normal' : 'friend',
  self_id: Number(BOT), user_id: Number(OWNER), message_id: 123,
  ...(kind === 'group' ? { group_id: Number(GROUP) } : {}),
  sender: { user_id: Number(OWNER), nickname: '主人' },
  message: [{ type: 'text', data: { text } }, ...extra],
})
const poke = (kind) => ({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
  self_id: Number(BOT), user_id: Number(OWNER), sender_id: Number(OWNER), target_id: Number(BOT),
  ...(kind === 'group' ? { group_id: Number(GROUP) } : {}),
})
const at = { type: 'at', data: { qq: BOT } }
function setup(t, { brain = async () => '收到啦', hooks, patch = {}, call } = {}) {
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(root, 'data-'))
  const cfg = normalize({ enabled: true, dryRun: false, setupDone: true, ownerQQ: OWNER, botQQ: BOT,
    allow: { groups: [GROUP], private: [] }, merge: { enabled: false },
    group: { interjectChance: 0, quietHours: [0, 0] },
    voice: { enabled: false }, stickers: { enabled: false, collect: false, reactChance: 0 },
    model: { vision: 'on' }, ...patch })
  const fake = createFakeDsh({ brain })
  const calls = []
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg, hooks,
    log: Object.fromEntries(['info', 'warn', 'error', 'debug'].map(k => [k, (...args) => fake.logs.push(args.join(' '))])),
    onebot: { connected: true, async call(action, params) {
      calls.push({ action, params })
      if (call) return call(action, params)
      return { message_id: calls.length, nickname: '主人', group_name: '测试群' }
    } },
  })
  const off = fake.ctx.on('session/event', hub.onSessionEvent)
  t.after(() => {
    hub.dispose(); off(); fake.dispose()
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
  })
  const sent = () => calls.filter(c => c.action === 'send_private_msg' || c.action === 'send_group_msg')
  return { hub, fake, cfg, calls, sent }
}

test('本机时间包含日期、星期、时分和时段，跨日重新生成', () => {
  assert.match(currentTimeLine(new Date(2026, 10, 4, 14, 5)), /2026-11-04 星期三 下午 14:05/)
  for (const [h, period] of [[0, '凌晨'], [8, '上午'], [12, '中午'], [15, '下午'], [21, '晚上']]) {
    assert.ok(currentTimeLine(new Date(2026, 10, 4, h, 7)).includes(`${period} ${String(h).padStart(2, '0')}:07`))
  }
  assert.match(currentTimeLine(new Date(2026, 10, 5, 0, 1)), /2026-11-05 星期四 凌晨 00:01/)
})

for (const kind of ['private', 'group']) test(`${kind} 普通聊天和看图每轮都有时间，常驻上下文不含时间`, async (t) => {
  const now = new Date(2026, 10, 4, 14, 5).getTime()
  t.mock.timers.enable({ apis: ['Date'], now })
  const s = setup(t)
  await s.hub.onMessage(event(kind, '先聊一句', kind === 'group' ? [at] : []))
  await until(() => s.fake.turns.length === 1 && s.sent().length === 1)
  await settle()
  assert.ok(s.fake.turns[0].userText.includes(currentTimeLine()))
  assert.doesNotMatch(s.fake.turns[0].ctxText, /当前本机时间/)
  const image = { type: 'image', data: { file: 'base64://' + Buffer.from('89504e470d0a1a0a00000000000000000000000100000001', 'hex').toString('base64') } }
  t.mock.timers.setTime(now + 5 * 3600_000)
  await s.hub.onMessage(event(kind, '这张睡觉图好可爱', kind === 'group' ? [at, image] : [image]))
  await until(() => s.fake.turns.length === 2)
  assert.ok(s.fake.turns[1].userText.includes(currentTimeLine()))
  assert.match(s.fake.turns[1].userText, /晚上 19:05/)
  assert.equal(s.fake.turns[1].images, 1)
  assert.doesNotMatch(s.fake.turns[1].ctxText, /当前本机时间/)
})

test('主动找主人、白名单朋友和目的引擎后台轮次都带当前时间', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 4, 9, 8).getTime() })
  const s = setup(t, { patch: {
    speakUp: { enabled: true, allow: ['10000004'], awakeFrom: 0, awakeTo: 24 },
    ext: { purpose: { enabled: false } },
  } })
  const speakUp = createSpeakUp({ getConfig: () => s.cfg, hub: s.hub, log: { info() {} } })
  await speakUp.fire()
  await settle()
  assert.ok(s.fake.turns[0].userText.includes(currentTimeLine()))
  assert.doesNotMatch(s.fake.turns[0].ctxText, /当前本机时间/)
  const day = new Date().toDateString()
  writeFileSync(join(process.env.AURABOT_DATA_DIR, 'speakup.json'), JSON.stringify({
    day, count: 0, nextAt: Date.now() + 3600_000,
    friends: { '10000004': { day, count: 0, nextAt: Date.now() - 1 } },
  }))
  await speakUp.tick()
  assert.match(s.fake.turns[1].userText, /这位朋友/)
  assert.ok(s.fake.turns[1].userText.includes(currentTimeLine()))
  await s.hub.runSystemTurn('purpose', '主动搭话', '想主动说一句', { noTools: true })
  assert.ok(s.fake.turns[2].userText.includes(currentTimeLine()))
  assert.doesNotMatch(s.fake.turns[2].ctxText, /当前本机时间/)
})

test('戳一戳轮次结束于插话准备期间，后续私聊改为 followup，不留在空闲 steer 队列', async (t) => {
  const reply = deferred(), preparing = deferred(), prepared = deferred()
  t.after(() => { reply.resolve(); preparing.resolve() })
  let inPoke = false
  const s = setup(t, {
    brain: async ({ text }) => {
      if (text.includes('戳了戳你')) { inPoke = true; await reply.promise; return '干嘛戳我' }
      return '现在也能聊'
    },
    hooks: { prompt: async (content, info) => {
      if (info.steer) { prepared.resolve(); await preparing.promise }
      return content
    } },
  })
  await s.hub.onPoke(poke('private'))
  await until(() => inPoke)
  const agent = s.fake.agents.get(s.hub.sessions()[CHAT].sessionId)
  // 真实宿主的空闲 steer 只入队，不启动模型；fake 的默认 steer 会自动 followup，掩盖竞态。
  let steers = 0
  agent.steer = async () => { steers++ }
  await s.hub.onMessage(event('private', '接着聊一句'))
  await prepared.promise
  reply.resolve()
  await until(() => s.sent().length === 1)
  await settle()
  preparing.resolve()
  await until(() => s.fake.turns.length === 2 && s.sent().length === 2)
  assert.equal(steers, 0)
  assert.match(s.fake.turns[1].userText, /接着聊一句/)
  assert.equal(s.hub.sessions()[CHAT].sessionId, agent.session.id)
  await settle()
  await s.hub.onMessage(event('private', '再说一句'))
  await until(() => s.fake.turns.length === 3 && s.sent().length === 3)
})

test('私聊原轮次仍在运行时保留 steer，插话也带时间', async (t) => {
  const reply = deferred()
  t.after(() => reply.resolve())
  let started = false
  const s = setup(t, { brain: async () => { started = true; await reply.promise; return '嗯嗯' } })
  await s.hub.onPoke(poke('private'))
  await until(() => started)
  const agent = [...s.fake.agents.values()][0]
  await s.hub.onMessage(event('private', '继续聊'))
  await until(() => agent.steered.length === 1)
  assert.ok(agent.steered[0].content.some(c => c.type === 'text' && c.text.includes(currentTimeLine())))
  reply.resolve()
  await settle()
})

for (const kind of ['private', 'group']) test(`${kind} 戳后普通消息不受戳冷却影响；沉默、发送失败也释放队列`, async (t) => {
  for (const outcome of ['normal', 'silent', 'send-failed']) await t.test(outcome, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    let fail = outcome === 'send-failed'
    let modelTurns = 0
    const s = setup(t, {
      // 群聊后续提示会保留戳一戳历史；只让本场景首轮沉默，不能按全文关键词判断当前轮次。
      brain: async () => ++modelTurns === 1 && outcome === 'silent' ? '[沉默]' : '可以继续聊',
      call: async (action) => {
        if (fail && action.startsWith('send_')) { fail = false; throw new Error('模拟发送失败') }
        return { message_id: 1, nickname: '主人' }
      },
    })
    await s.hub.onPoke(poke(kind))
    await until(() => s.fake.turns.length === 1)
    await settle()
    assert.match(s.fake.turns[0].userText, /戳了戳你/)
    assert.equal(s.fake.turns[0].reply, outcome === 'silent' ? '[沉默]' : '可以继续聊')
    if (outcome === 'silent') assert.equal(s.sent().length, 0, '戳一戳首轮沉默时不发送')
    await s.hub.onPoke(poke(kind))
    await settle()
    assert.equal(s.fake.turns.length, 1, '20 秒内重复戳不触发')
    const sentBeforeFollowup = s.sent().length
    await s.hub.onMessage(event(kind, '继续说吧', kind === 'group' ? [at] : []))
    await until(() => s.fake.turns.length === 2)
    await settle()
    assert.match(s.fake.turns[1].userText, /继续说吧/)
    assert.equal(s.fake.turns[1].reply, '可以继续聊')
    assert.equal(s.sent().length, sentBeforeFollowup + 1, '后续普通消息应新增一条回复')
    assert.ok(s.sent().at(-1).params.message.some(seg => seg.type === 'text' && seg.data.text.includes('可以继续聊')))
    const typing = s.calls.filter(c => c.action === 'set_input_status').length
    t.mock.timers.tick(15_001)
    await settle()
    assert.equal(s.calls.filter(c => c.action === 'set_input_status').length, typing, '轮次结束后停止 typing')
  })
})

for (const kind of ['private', 'group']) test(`${kind} 戳回复发送期间到达的合批消息，在发送结束后继续处理`, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const sending = deferred()
  t.after(() => sending.resolve())
  let entered = false, blocked = false
  const s = setup(t, {
    patch: { merge: { enabled: true, waitSec: 1, maxSec: 3, groupWaitSec: 1, groupMaxSec: 3 } },
    hooks: { send: async segments => {
      if (!blocked) { blocked = true; entered = true; await sending.promise }
      return segments
    } },
  })
  await s.hub.onPoke(poke(kind))
  t.mock.timers.tick(1001)
  await until(() => entered)
  await s.hub.onMessage(event(kind, '接着第一句', kind === 'group' ? [at] : []))
  await s.hub.onMessage(event(kind, '再补第二句', kind === 'group' ? [at] : []))
  t.mock.timers.tick(1001)
  await settle()
  assert.equal(s.fake.turns.length, 1, '发送期间先保留在 pending')
  sending.resolve()
  await until(() => s.fake.turns.length === 2 && s.sent().length === 2)
  assert.match(s.fake.turns[1].userText, /接着第一句/)
  assert.match(s.fake.turns[1].userText, /再补第二句/)
})

test('群聊戳完后紧接着追问，无需 @ 也能越过刹车和关闭插话的设置', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 4, 14, 5).getTime() })
  const s = setup(t, {
    patch: { group: { interjectChance: 0, burstMax: 1, quietHours: [0, 0] } },
    brain: async () => { t.mock.timers.setTime(Date.now() + 1); return '继续聊呀' },
  })
  await s.hub.onPoke(poke('group'))
  await until(() => s.fake.turns.length === 1 && s.sent().length === 1)
  await settle()
  await s.hub.onMessage(event('group', '人呢'))
  await until(() => s.fake.turns.length === 2 && s.sent().length === 2)
  assert.match(s.fake.turns[1].userText, /人呢/)
  assert.match(s.fake.logs.join('\n'), /刚说完被追问/)
  await settle()
  await s.hub.onMessage(event('group', '普通无关群消息'))
  await s.hub.onMessage(event('group', '在吗'))
  await settle()
  assert.equal(s.fake.turns.length, 2, '群友互相追问不能误判成在叫她')
})
