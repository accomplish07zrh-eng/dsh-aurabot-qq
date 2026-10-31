// 桌宠「AI 行为大脑（决策层）」测试（服务端部分）：
//   · 间隔 clamp 下限 1 分钟 / 每日上限 / force 绕过
//   · 动作单宽松解析：提取第一个 JSON 对象；非法/暂未开放动作一律拒绝
//   · 解析失败回退本地池子文案（铁律 1：AI 只能从硬编码枚举里选）
//   · behavior.json 落盘 round-trip（day/count/nextAt/lastAt/recent/lastReaction）
//   · /behavior 手动下发（force 默认 true）+ /playback 行为回执（played/failed/refused）写回 recent
//   · /behavior/reaction 反应层上报：只记录喂给 AI 下一轮，不重复 emit
// 全程 AURABOT_DATA_DIR 隔离，fake api 仿 test/pet.test.js 的 makeApi 面，不引入新依赖。
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

let mod
const OWNER = '10000001'
const MODULE_DIR = fileURLToPath(new URL('../src/modules/pet', import.meta.url))

before(async () => {
  mod = (await import('../src/modules/pet/index.js')).default
})

beforeEach(() => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-pet-behavior-'))
})

// ---------- 假模块环境（与 test/pet.test.js 同一个 makeApi 面） ----------

function startModule({ settings = {} } = {}) {
  const s = { carrier: 'pet', modality: 'text', petFallbackToQQ: true, pack: 'default', ...settings }
  const routes = new Map()
  const sentToQQ = []
  const api = {
    id: 'pet',
    dir: MODULE_DIR,
    version: 'test',
    __petTestHooks: {},
    log: { info() {}, warn() {}, debug() {}, error() {} },
    dataDir: (...parts) => join(process.env.AURABOT_DATA_DIR, 'modules-data', 'pet', ...parts),
    // 全天醒着：安静时段按真实时钟判（默认醒 8~23），不钉死的话这些用例一到 23:00 就集体误红
    config: () => ({ ownerQQ: OWNER, speakUp: { awakeFrom: 0, awakeTo: 24 } }),
    settings: () => ({ ...s }),
    saveSettings: (patch) => { Object.assign(s, patch); return { ...s } },
    route: (path, handler) => { routes.set(path, handler) },
    every: () => () => {},
    onDispose: () => {},
    has: (id) => id === 'mood' || id === 'memory',
    use: (id) => (id === 'mood' ? { current: () => moodValue, nudge: (d, r) => nudges.push({ d, r }) }
      : id === 'memory' ? { list: () => memItems, add: (e) => memAdds.push(e) } : null),
    sendText: async (chatId, text) => { sentToQQ.push({ chatId, text }) },
    core: {
      http: {
        send: (res, code, body) => { res.statusCode = code; res.end(JSON.stringify(body)) },
        query: (req) => { try { return Object.fromEntries(new URL(req.url, 'http://x').searchParams) } catch { return {} } },
        body: async (req) => req.__json ?? {},
      },
    },
  }
  let moodValue = 75
  let memItems = []
  let thinkReply = ''
  const nudges = []
  const memAdds = []
  const thinkCalls = []
  api.think = async (prompt, opts = {}) => {
    thinkCalls.push({ prompt, title: opts.title, noTools: opts.noTools, timeoutMs: opts.timeoutMs, key: opts.key })
    return thinkReply
  }
  const exports = mod.setup(api) ?? {}
  const token = readFileSync(api.dataDir('host-token'), 'utf8').trim()

  function req(path, { method = 'GET', query = {}, token: tk = token, json, headers = {} } = {}) {
    const qs = new URLSearchParams(query).toString()
    return {
      method,
      url: `${path}${qs ? '?' + qs : ''}`,
      headers: { host: '127.0.0.1:53210', ...(tk ? { 'x-pet-token': tk } : {}), ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
      __json: json,
    }
  }
  async function call(path, opts = {}) {
    const handler = routes.get(path.split('?')[0])
    if (!handler) return { status: 404, json: { ok: false, message: 'no route ' + path } }
    const res = { statusCode: 200, headers: {}, raw: null, setHeader() {}, end(b) { this.raw = b } }
    await handler(req(path, opts), res)
    let body = res.raw
    try { body = JSON.parse(res.raw) } catch {}
    return { status: res.statusCode, headers: res.headers, raw: res.raw, json: body }
  }
  /** 模拟客户端连上长轮询；wantEvents=true 时取增量事件。 */
  async function connect({ wantEvents = false, since } = {}) {
    const first = await call('/events', { query: { wait: '0', client: 'pet-test' } })
    assert.equal(first.json.ok, true)
    if (!wantEvents) return { cursor: first.json.cursor, events: [] }
    const r = await call('/events', { query: { since: String(since ?? first.json.cursor), wait: '0', client: 'pet-test' } })
    return { cursor: first.json.cursor, events: r.json.events }
  }
  return {
    api, exports, routes, call, connect, token, sentToQQ, nudges, memAdds, thinkCalls,
    setMood: (v) => { moodValue = v }, setMemory: (list) => { memItems = list }, setThinkReply: (t) => { thinkReply = t },
  }
}

/** 写一份 behavior.json 状态文件（nextAt 可指定；day 按今天算）。 */
function seedBehavior(api, patch = {}) {
  const day = new Date().toDateString()
  const file = api.dataDir('behavior.json')
  writeFileSync(file, JSON.stringify({ day, count: 0, nextAt: 0, lastAt: 0, recent: [], ...patch }))
  return file
}

// ---------- 配置与状态 ----------

test('间隔 clamp：下限 1 分钟（配 0 分钟也不许更快）、每日上限与默认值都对', () => {
  const env = startModule({ settings: { behaviorMinMinutes: 0, behaviorMaxMinutes: -3, behaviorMaxPerDay: 99999 } })
  const b = env.exports.behaviorStatus()
  assert.equal(b.minMinutes, 1, '间隔下限硬性 1 分钟')
  assert.equal(b.maxMinutes, 1, '上限低于下限被抬平')
  assert.equal(b.maxPerDay, 99999)
  assert.equal(b.enabled, true)
  assert.equal(b.closeWindowEnabled, false, '高危关窗开关默认关')
  assert.equal(b.turnTitle, '桌宠 · 行为大脑（自己的回合）')
  // 暂未开放的动作在状态里可查（骨架预留，客户端面板要显示它们）；第二批 drag_icon/hide_icon 已开放
  assert.ok(b.openActions.includes('chase_cursor'))
  assert.ok(b.openActions.includes('drag_icon'), '第二批：drag_icon 进入开放清单')
  assert.ok(b.openActions.includes('hide_icon'), '第二批：hide_icon 进入开放清单（可回滚）')
  assert.ok(b.openActions.includes('close_window'), '第三批：close_window 进入开放清单（另有物理闸）')
  assert.ok(b.openActions.includes('nudge_window'), '第三批：nudge_window 已开放')
  assert.ok(!b.openActions.includes('peek_window'), '2026-10-30 用户裁撤：peek_window 已删除')
  assert.deepEqual(b.deferredActions, [], '第三批已全部实现，没有占位动作')
  assert.deepEqual(b.disabledActions, [], '默认没有禁用动作')
})

test('排程落盘 round-trip：首次进 tick 先排 nextAt；跨天清 count；行为文件字段齐全', () => {
  const env = startModule()
  assert.equal(existsSync(env.api.dataDir('behavior.json')), true, '启动即落盘一次排程')
  const raw = JSON.parse(readFileSync(env.api.dataDir('behavior.json'), 'utf8'))
  assert.equal(raw.day, new Date().toDateString())
  assert.ok(raw.nextAt > Date.now(), 'nextAt 已排在未来')
  // 跨天：day 变了要清 count
  seedBehavior(env.api, { day: 'yesterday', count: 5, nextAt: Date.now() + 1000 })
  const st = env.exports.behaviorStatus()
  assert.equal(st.today, 0, '跨天清零')
})

// ---------- 闸门顺序 ----------

test('闸门：离线 force 也拦（没人执行）；到点没到不发；到点且在忙推迟一轮；每日上限拦住、force 绕过', async () => {
  const env = startModule()
  seedBehavior(env.api, { nextAt: Date.now() - 1000 })
  const off = await env.exports.behavior({ force: true })
  assert.equal(off.ok, false, JSON.stringify(off))
  assert.equal(off.reason, 'pet-offline')

  await env.connect() // 在线了
  seedBehavior(env.api, { nextAt: Date.now() + 30 * 60_000 })
  const notDue = await env.exports.behavior()
  assert.equal(notDue.reason, 'not-due')

  // 到点 + 干活中 → busy 推迟
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'turn/start' })
  seedBehavior(env.api, { nextAt: Date.now() - 1000 })
  const busy = await env.exports.behavior()
  assert.equal(busy.reason, 'busy')
  const afterBusy = JSON.parse(readFileSync(env.api.dataDir('behavior.json'), 'utf8'))
  assert.ok(afterBusy.nextAt > Date.now(), 'busy 推迟要重新排 nextAt')
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })

  // 每日上限：count 够了拦；force 绕过上限照常跑
  seedBehavior(env.api, { count: 99999, nextAt: Date.now() - 1000 })
  const capped = await env.exports.behavior()
  assert.equal(capped.reason, 'daily-max')
  env.setThinkReply('{"action":"wander","params":{},"say":"","moodDelta":0}')
  const forced = await env.exports.behavior({ force: true })
  assert.equal(forced.ok, true, 'force 绕过每日上限：' + JSON.stringify(forced))
})

// ---------- 动作单解析（铁律 1） ----------

test('解析：宽松提取第一个 JSON 对象；前后有杂物也能解析；非法/清单外动作返回 null', () => {
  const e = startModule()
  const p = e.exports.behaviorParse
  assert.deepEqual(p('好的，我选这个：{"action":"chase_cursor","params":{},"say":"扑！","moodDelta":3} 以上'),
    { action: 'chase_cursor', params: {}, say: '扑！', moodDelta: 3 }, '宽松提取第一个 JSON 对象')
  assert.equal(p.moodDelta, undefined)
  assert.deepEqual(p('{"action":"say","params":{"text":"嘿"},"say":"","moodDelta":99}').moodDelta, 10, 'moodDelta 钳到 +10')
  assert.deepEqual(p('{"action":"say","say":"","moodDelta":-99}').moodDelta, -10, 'moodDelta 钳到 -10')
  assert.deepEqual(p('{"action":"say"}'), { action: 'say', params: {}, say: '', moodDelta: 0 }, '缺省字段补默认')
  assert.equal(p('今天不想动'), null, '没有 JSON → null')
  assert.equal(p('{"action":"close_window","params":{}}').action, 'close_window', '第三批：关窗已进开放清单（安全闸在别处）')
  assert.equal(p('{"action":"drag_icon","params":{"icon":"x.lnk"}}').action, 'drag_icon', '第二批：drag_icon 在开放清单')
  assert.equal(p('{"action":"hide_icon","params":{"icon":"x.lnk"}}').action, 'hide_icon', '第二批：hide_icon 在开放清单')
  // 第三批：窗口动作的 title/text 只是可选片段，非法值一样按铁律 1 丢弃
  assert.equal(p('{"action":"close_window","params":{"title":"记事本"}}').action, 'close_window', '窗口动作可带 title')
  assert.equal(p('{"action":"nudge_window","params":{"title":""}}'), null, '空 title → 丢弃')
  assert.equal(p('{"action":"nudge_window","params":{"title":"带\\u0001控制符"}}'), null, '控制字符 → 丢弃')
  assert.equal(p(`{"action":"close_window","params":{"title":"${'x'.repeat(61)}"}}`), null, 'title 超长 → 丢弃')
  assert.equal(p('{"action":"不存在的动作"}'), null, '清单外动作 → 丢弃')
  assert.equal(p('{"action":"say","params":"不是对象"}'), null, '参数必须是对象')
  assert.equal(p('不是对象 [{"x":1}]'), null, '数组不算对象')
  assert.equal(e.api.id, 'pet')
})

test('解析失败回退本地池子文案（不调动作、不发行为事件之外的怪东西）', async () => {
  const env = startModule()
  await env.connect()
  seedBehavior(env.api, { nextAt: Date.now() - 1000 })
  env.setThinkReply('我根本看不懂要求')
  const r = await env.exports.behavior()
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.action, 'fallback')
  assert.ok(r.text.length > 0, '回退要有一句池子文案')
  const after = JSON.parse(readFileSync(env.api.dataDir('behavior.json'), 'utf8'))
  assert.equal(after.count, 0, '回退不计入每日配额')
  assert.equal(env.thinkCalls[0].title, '桌宠 · 行为大脑（自己的回合）')
  assert.equal(env.thinkCalls[0].noTools, true)
  assert.equal(env.thinkCalls[0].key, 'behavior', '必须带 key：否则和碎碎念挤进同一条会话（看不到这条、还互相排队）')
  assert.ok(env.thinkCalls[0].timeoutMs >= 120_000, '超时 120s')
})

// ---------- 正常下发链路 ----------

test('正常动作单：emit behavior 事件 + say 走气泡；mood 修正走 api.use(\'mood\')；落盘计数与 recent', async () => {
  const env = startModule()
  const { cursor } = await env.connect()
  seedBehavior(env.api, { nextAt: Date.now() - 1000 })
  env.setThinkReply('【思考】主人在摸鱼\n{"action":"chase_cursor","params":{},"say":"（扑向光标！）","moodDelta":2}')
  const r = await env.exports.behavior()
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.action, 'chase_cursor')
  assert.match(r.playbackId, /^[a-f0-9]{8}$/)
  assert.deepEqual(env.nudges, [{ d: 2, r: '行为大脑' }], '心情修正被调用了')

  const got = await env.connect({ wantEvents: true, since: cursor })
  const ev = got.events.find((e) => e.type === 'behavior')
  assert.ok(ev, '有 behavior 事件')
  assert.equal(ev.action, 'chase_cursor')
  assert.equal(ev.force, false, '定时轮次不带 force')
  assert.equal(ev.playbackId, r.playbackId, '回执号一致')
  // 气泡契约：台词挂在 behavior 事件上（客户端据此顶气泡），不再另发 proactive——
  // 原来两条通道都弹，同一句话会弹两次
  assert.equal(ev.say, '（扑向光标！）', 'AI 给的 say 随 behavior 事件下发')
  const bubble = got.events.find((e) => e.type === 'proactive')
  assert.equal(bubble, undefined, '不许再发 proactive：同一句话只弹一次气泡')
  assert.equal(env.sentToQQ.length, 0, '行为气泡绝不回落 QQ')

  const after = JSON.parse(readFileSync(env.api.dataDir('behavior.json'), 'utf8'))
  assert.equal(after.count, 1)
  assert.ok(after.lastAt > 0)
  assert.equal(after.recent[after.recent.length - 1], 'chase_cursor → 下发（等回执）')
  assert.ok(after.nextAt > Date.now(), '跑完重排下一轮')
  const prompt = env.thinkCalls[0].prompt
  assert.match(prompt, /chase_cursor/, '简报带硬编码动作表')
  assert.match(prompt, /暂未开放或已被主人禁用，禁止选择/, '简报标注禁选动作')
  assert.match(prompt, /close_window/, '默认关着物理闸 → 关窗出现在禁选清单里')
  assert.match(prompt, /窗口动作说明/, '第三批：简报要说明窗口动作只作用于当前前台窗口')
})

// ---------- 环境简报：桌面图标（服务端读目录）+ 窗口（客户端上报） ----------

test('环境简报：客户端上报的窗口清单进简报（★=前台），并写进 /behavior/status 供面板对账', async () => {
  const env = startModule()
  await env.connect()
  seedBehavior(env.api, { nextAt: Date.now() - 1000 })
  const rep = await env.call('/behavior/env', {
    method: 'POST',
    json: {
      windows: [
        { title: 'aurabot - Visual Studio Code', proc: 'Code', fg: true },
        { title: '哔哩哔哩  \u0000 直播', proc: 'chrome', fg: false },
      ],
    },
  })
  assert.equal(rep.json.ok, true)
  assert.equal(rep.json.windows, 2)
  env.setThinkReply('{"action":"wander","params":{},"say":"","moodDelta":0}')
  await env.exports.behavior({ force: true })
  const prompt = env.thinkCalls.at(-1).prompt
  assert.match(prompt, /主人现在开着的窗口/, '简报要有窗口清单这一段')
  assert.match(prompt, /★ aurabot/, '前台窗口前面要有 ★')
  assert.match(prompt, /Visual Studio Code/, '要把窗口标题原样给 AI')
  assert.match(prompt, /哔哩哔哩/, '非前台窗口也要在清单里')
  assert.ok(!/\u0000/.test(prompt), '标题里的控制字符必须清掉，别把简报结构搞乱')
  const st = (await env.call('/behavior/status')).json.behavior
  assert.equal(st.envWindows.length, 2, '面板能看到「AI 拿到了什么」')
  assert.ok(st.envWindowsAt > 0)
})

test('环境简报：没上报窗口时，简报不编造清单，并明确告诉 AI「别填 title」', async () => {
  const env = startModule()
  await env.connect()
  seedBehavior(env.api, { nextAt: Date.now() - 1000 })
  env.setThinkReply('{"action":"wander","params":{},"say":"","moodDelta":0}')
  await env.exports.behavior({ force: true })
  const prompt = env.thinkCalls.at(-1).prompt
  assert.ok(!/主人现在开着的窗口/.test(prompt), '一条窗口都没有就不该出现窗口段')
  assert.match(prompt, /没读到窗口清单/, '要说明「别填 title」，别让 AI 瞎编窗口名')
})

test('环境简报：桌面图标清单来自真实桌面（注入 desktopDir），图标动作被关掉时进禁选', async () => {
  const env = startModule()
  await env.connect()
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-env-icons-'))
  writeFileSync(join(dir, '游戏.lnk'), 'x')
  writeFileSync(join(dir, 'desktop.ini'), 'x') // 系统文件必须被过滤
  env.api.__petTestHooks.desktopDir = () => dir
  assert.deepEqual(env.exports.iconList(30), ['游戏.lnk'])
  seedBehavior(env.api, { nextAt: Date.now() - 1000 })
  env.setThinkReply('{"action":"wander","params":{},"say":"","moodDelta":0}')
  await env.exports.behavior({ force: true })
  assert.match(env.thinkCalls.at(-1).prompt, /游戏\.lnk/, '图标清单要进简报（AI 才能挑目标）')
  rmSync(dir, { recursive: true, force: true })
})

test('/config 下发 behavior 段：客户端反应层靠它尊重「行为总开关」与「鼠标闲置分钟」', async () => {
  const env = startModule({ settings: { behaviorEnabled: false, behaviorIdleCursorMinutes: 15 } })
  const cfg = (await env.call('/config')).json
  assert.deepEqual(cfg.behavior, { enabled: false, idleCursorMinutes: 15 }, '少了这一段，面板关开关也拦不住本地反应层')
})

test('/playback 行为回执：played/failed/refused 记录并写回 behavior.json recent + 短记忆', async () => {
  const env = startModule()
  await env.connect()
  seedBehavior(env.api, { nextAt: Date.now() - 1000 })
  env.setThinkReply('{"action":"steal_cursor","params":{},"say":"","moodDelta":0}')
  const r = await env.exports.behavior({ force: true })
  assert.equal(r.ok, true)
  const memBefore = env.memAdds.length
  const ack = await env.call('/playback', { method: 'POST', json: { playbackId: r.playbackId, action: 'steal_cursor', status: 'refused', reason: '安全闸' } })
  assert.equal(ack.json.ok, true)
  const hist = await env.call('/history')
  const p = hist.json.playbacks.find((x) => x.playbackId === r.playbackId)
  assert.equal(p.status, 'refused', 'refused 原样保留')
  assert.equal(p.action, 'steal_cursor')
  assert.equal(p.reason, '安全闸')
  const after = JSON.parse(readFileSync(env.api.dataDir('behavior.json'), 'utf8'))
  assert.match(after.recent[after.recent.length - 1], /steal_cursor → refused（安全闸）/, '最新回执进 recent（供下轮简报）')
  assert.ok(env.memAdds.length > memBefore, '写了一条短记忆')
  assert.match(env.memAdds[env.memAdds.length - 1].text, /steal_cursor/, '记忆内容带动作名')
})

// ---------- 手动通道（面板「试一下」/右键菜单）与反应层 ----------

test('/behavior 路由：force 默认 true 下发并返回 playbackId；未知动作 400', async () => {
  const env = startModule()
  const { cursor } = await env.connect()
  const r = await env.call('/behavior', { method: 'POST', json: { action: 'chase_cursor', params: {} } })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.match(r.json.playbackId, /^[a-f0-9]{8}$/)
  const got = await env.connect({ wantEvents: true, since: cursor })
  const ev = got.events.find((e) => e.type === 'behavior')
  assert.ok(ev, '手动通道也走同一条 emit 链路')
  assert.equal(ev.force, true, '手动默认 force')
  assert.equal(ev.reason, 'manual')
  const bad = await env.call('/behavior', { method: 'POST', json: { action: '不存在' } })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.reason, 'unknown-action')
  const st = await env.call('/behavior/status')
  assert.equal(st.json.ok, true)
  assert.equal(st.json.behavior.enabled, true)
  assert.ok(Array.isArray(st.json.behavior.recent))
})

test('/behavior/reaction：只记录 lastReaction 喂 AI，不重复 emit（客户端本地已执行）', async () => {
  const env = startModule()
  const { cursor } = await env.connect()
  const r = await env.call('/behavior/reaction', { method: 'POST', json: { kind: 'tease', detail: '主人在鼠标旁快速晃动' } })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.lastReaction.kind, 'tease')
  const raw = JSON.parse(readFileSync(env.api.dataDir('behavior.json'), 'utf8'))
  assert.equal(raw.lastReaction.kind, 'tease')
  assert.ok(raw.lastReaction.at > 0)
  assert.equal(raw.lastReaction.detail, '主人在鼠标旁快速晃动')
  const got = await env.connect({ wantEvents: true, since: cursor })
  assert.equal(got.events.filter((e) => e.type === 'behavior').length, 0, '反应层上报不双发')
  const bad = await env.call('/behavior/reaction', { method: 'POST', json: {} })
  assert.equal(bad.status, 400)
  // 反应层摘要要进下一轮简报（先排到点，反应事件写在 seed 之后才不会被覆盖掉）
  seedBehavior(env.api, { nextAt: Date.now() - 1000 })
  await env.call('/behavior/reaction', { method: 'POST', json: { kind: 'tease', detail: '主人在鼠标旁快速晃动' } })
  env.setThinkReply('{"action":"wander","params":{},"say":"","moodDelta":0}')
  await env.exports.behavior({ force: true })
  assert.match(env.thinkCalls[env.thinkCalls.length - 1].prompt, /tease/, '上一轮反应事件进了简报')
})

// ================= 第二批：图标隔离区（drag_icon / hide_icon） =================

import { mkdirSync, rmSync } from 'node:fs'

/** 伪造一个主人桌面目录（desktopDir 可注入），返回 {dir, env}；用完由测试自行 rmSync。 */
function withFakeDesktop(env, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-fake-desktop-'))
  for (const [name, content] of Object.entries(files)) {
    if (content === null) mkdirSync(join(dir, name)) // 文件夹
    else writeFileSync(join(dir, name), typeof content === 'string' ? content : 'x')
  }
  env.api.__petTestHooks.desktopDir = () => dir
  return dir
}

test('act 校验矩阵：lnk/url/普通文件过；文件夹/隐藏/不存在/CLSID/可执行扩展拒绝，reason 带回给客户端', () => {
  const env = startModule()
  const dir = withFakeDesktop(env, { '游戏.lnk': 'lnk', '某.url': 'url', '笔记.txt': 'hi', '文件夹': null, '.隐藏文件': 'x', '木马.exe': 'x', 'desktop.ini': 'x', '~$临时.docx': 'x', '{20D04FE0-3AEA-1069-A2D8-08002B30309D}.lnk': 'lnk' })
  try {
    const act = (json) => env.exports.iconAct(json)
    assert.equal(act({ mode: 'hide', icon: '游戏.lnk' }).ok, true)
    assert.equal(act({ mode: 'hide', icon: '某.url' }).ok, true)
    assert.equal(act({ mode: 'drag', icon: '笔记.txt' }).ok, true)
    assert.deepEqual(act({ mode: 'drag', icon: '笔记.txt' }), { ok: true, acted: false, name: '笔记.txt' }, 'drag 只校验不挪文件')
    for (const [icon, why] of [['文件夹', 'not-file'], ['.隐藏文件', 'hidden'], ['~$临时.docx', 'hidden'], ['desktop.ini', 'system-file'], ['不存在.lnk', 'not-found'], ['{20D04FE0-3AEA-1069-A2D8-08002B30309D}.lnk', 'system-icon'], ['木马.exe', 'bad-ext'], ['', 'bad-name'], ['../逃逸.txt', 'bad-name']]) {
      const r = act({ mode: 'hide', icon })
      assert.equal(r.ok, false, `${icon || '(空)'} 应拒绝`)
      assert.equal(r.reason, why, `${icon || '(空)'} 的 reason`)
    }
    // 桌面目录探测不到时拒绝
    env.api.__petTestHooks.desktopDir = () => null
    const nd = act({ mode: 'hide', icon: '笔记.txt' })
    assert.equal(nd.ok, false)
    assert.equal(nd.reason, 'desktop-not-found')
  } finally {
    env.api.__petTestHooks.desktopDir = undefined
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hide 落盘 round-trip：文件 rename 进隔离区 + manifest 记录齐全 + 回执进 recent + 短记忆', async () => {
  const env = startModule()
  await env.connect()
  const dir = withFakeDesktop(env, { '音乐.lnk': 'lnk' })
  try {
    const r = await env.call('/behavior/icon/act', { method: 'POST', json: { mode: 'hide', icon: '音乐.lnk', playbackId: 'abcd1234' } })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.acted, true)
    assert.match(r.json.id, /^[a-f0-9]{8}$/)
    assert.ok(!existsSync(join(dir, '音乐.lnk')), '桌面上的原文件被挪走')
    const qdir = env.api.dataDir('desktop-quarantine')
    assert.ok(existsSync(join(qdir, '音乐.lnk')), '隔离区里有文件')
    const list = JSON.parse(readFileSync(join(qdir, 'manifest.json'), 'utf8'))
    assert.equal(list.length, 1)
    assert.equal(list[0].name, '音乐.lnk')
    assert.equal(list[0].originalPath, join(dir, '音乐.lnk'))
    assert.equal(list[0].quarantinePath, join(qdir, '音乐.lnk'))
    assert.equal(list[0].playbackId, 'abcd1234')
    assert.ok(list[0].at > 0)
    assert.equal(list[0].reason, 'hide_icon')
    // 面板查询路由
    const q = await env.call('/behavior/icon/quarantine')
    assert.equal(q.json.ok, true)
    assert.equal(q.json.items.length, 1)
    assert.equal(q.json.items[0].id, r.json.id)
    // 回执进 behavior.json recent + 短记忆（复用第一批模式）
    const after = JSON.parse(readFileSync(env.api.dataDir('behavior.json'), 'utf8'))
    assert.match(after.recent[after.recent.length - 1], /音乐\.lnk/, '回执进 recent')
    assert.ok(env.memAdds.some((m) => /音乐\.lnk/.test(m.text)), '写了一条短记忆')
  } finally {
    env.api.__petTestHooks.desktopDir = undefined
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hide 重名加序号；restore 回原位；原路径被占则改名「名字(归还)」再放；铁律：绝不删除', async () => {
  const env = startModule()
  const dir = withFakeDesktop(env, { '重复.lnk': 'lnk' })
  try {
    // 收走 → 桌面又出现同名文件 → 再收走一次：隔离区重名加 (1)
    const r1 = env.exports.iconAct({ mode: 'hide', icon: '重复.lnk' })
    writeFileSync(join(dir, '重复.lnk'), 'lnk-new')
    const r2 = env.exports.iconAct({ mode: 'hide', icon: '重复.lnk' })
    assert.ok(r1.ok && r2.ok)
    const qdir = env.api.dataDir('desktop-quarantine')
    assert.ok(existsSync(join(qdir, '重复.lnk')), '第一个进隔离区用原名')
    assert.ok(existsSync(join(qdir, '重复(1).lnk')), '重名加序号')
    // 归还：原路径没被占 → 回原位，manifest 移除
    const restore1 = await env.call('/behavior/icon/restore', { method: 'POST', json: { id: r1.id } })
    assert.equal(restore1.status, 200)
    assert.equal(restore1.json.ok, true)
    assert.equal(restore1.json.restoredTo, join(dir, '重复.lnk'))
    assert.equal(JSON.parse(readFileSync(join(qdir, 'manifest.json'), 'utf8')).length, 1, 'manifest 移除已归还条目')
    // 归还第二个：原路径被同名占位 → 改名「重复(归还).lnk」
    const restore2 = await env.call('/behavior/icon/restore', { method: 'POST', json: { id: r2.id } })
    assert.equal(restore2.json.ok, true)
    assert.equal(restore2.json.restoredTo, join(dir, '重复(归还).lnk'), '原名被占则改名归还')
    assert.ok(existsSync(join(dir, '重复(归还).lnk')))
    // 未知 id 404；归还后文件回到桌面（全程只有 rename，没有任何 unlink）
    const bad = await env.call('/behavior/icon/restore', { method: 'POST', json: { id: '不存在' } })
    assert.equal(bad.status, 404)
    assert.equal(bad.json.reason, 'not-found')
  } finally {
    env.api.__petTestHooks.desktopDir = undefined
    rmSync(dir, { recursive: true, force: true })
  }
})

test('超期自动归还：超 iconQuarantineDays 全部放回并汇总气泡汇报一次；未到期不动', async () => {
  const env = startModule()
  const dir = withFakeDesktop(env, {})
  try {
    const qdir = env.api.dataDir('desktop-quarantine')
    const now = Date.now()
    const old = { id: 'a1b2c3d4', name: '旧图标.lnk', originalPath: join(dir, '旧图标.lnk'), quarantinePath: join(qdir, '旧图标.lnk'), at: now - 8 * 24 * 3600_000, reason: 'hide_icon', playbackId: '' }
    const fresh = { id: 'e5f6a7b8', name: '新图标.lnk', originalPath: join(dir, '新图标.lnk'), quarantinePath: join(qdir, '新图标.lnk'), at: now - 1000, reason: 'hide_icon', playbackId: '' }
    mkdirSync(qdir, { recursive: true })
    writeFileSync(join(qdir, '旧图标.lnk'), 'lnk')
    writeFileSync(join(qdir, '新图标.lnk'), 'lnk')
    writeFileSync(join(qdir, 'manifest.json'), JSON.stringify([old, fresh]))
    const r = await env.exports.iconSweep(now)
    assert.equal(r.ok, true)
    assert.deepEqual(r.names, ['旧图标.lnk'], '只有超期的被归还（默认 7 天）')
    assert.ok(existsSync(join(dir, '旧图标.lnk')), '超期图标回到原位')
    assert.ok(existsSync(join(qdir, '新图标.lnk')), '没到期的还躺在隔离区')
    const list = JSON.parse(readFileSync(join(qdir, 'manifest.json'), 'utf8'))
    assert.deepEqual(list.map((x) => x.id), ['e5f6a7b8'], 'manifest 只剩未到期条目')
    // 空隔离区/没到期：不打扰主人
    const r2 = await env.exports.iconSweep(now)
    assert.equal(r2.restored, 0)
  } finally {
    env.api.__petTestHooks.desktopDir = undefined
    rmSync(dir, { recursive: true, force: true })
  }
})

test('iconMischiefEnabled 只拦 AI 路径：AI 选图标动作被闸回退，force 手动照常（act 入口 force 不拦）', async () => {
  const env = startModule({ settings: { behaviorIconMischiefEnabled: false } })
  const dir = withFakeDesktop(env, { '目标.lnk': 'lnk' })
  try {
    await env.connect()
    // AI 路径（force=false）：选 hide_icon → 被 iconMischiefEnabled 拦，回退池子文案
    seedBehavior(env.api, { nextAt: Date.now() - 1000 })
    env.setThinkReply('{"action":"hide_icon","params":{"icon":"目标.lnk"},"say":"","moodDelta":0}')
    const ai = await env.exports.behavior()
    assert.equal(ai.action, 'fallback', JSON.stringify(ai))
    assert.ok(existsSync(join(dir, '目标.lnk')), 'AI 被闸：文件没被动')
    // 简报里把图标动作列入禁选
    assert.match(env.thinkCalls[env.thinkCalls.length - 1].prompt, /drag_icon.*hide_icon|hide_icon.*drag_icon/, '开关关掉时简报禁选图标动作')
    // 手动 force：emit 通道不拦（iconMischiefEnabled 是 AI 闸）
    const manual = await env.exports.behavior({ force: true })
    assert.equal(manual.ok, true)
    assert.equal(manual.action, 'hide_icon')
    // act 入口：force=false（模拟 AI 执行链）被拦；force=true 的手动测试按钮不拦
    const blocked = env.exports.iconAct({ mode: 'hide', icon: '目标.lnk', force: false })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.reason, 'icon-mischief-disabled')
    const forced = env.exports.iconAct({ mode: 'hide', icon: '目标.lnk', force: true })
    assert.equal(forced.ok, true, 'force 手动测试按钮绕过 iconMischiefEnabled')
    assert.ok(!existsSync(join(dir, '目标.lnk')), 'force 收走成功（可放回）')
  } finally {
    env.api.__petTestHooks.desktopDir = undefined
    rmSync(dir, { recursive: true, force: true })
  }
})

test('behaviorDisabledActions：禁用动作不进 AI 动作表（解析拒绝→回退），手动 /behavior 通道不受影响', async () => {
  const env = startModule({ settings: { behaviorDisabledActions: 'wander, steal_cursor ,不存在也没事' } })
  await env.connect()
  const b = env.exports.behaviorStatus()
  assert.deepEqual(b.disabledActions.sort(), ['steal_cursor', 'wander'], '解析成数组供面板渲染（未知名字被滤掉）')
  // AI 路径：选了被禁的 wander → 解析拒绝 → 回退池子文案
  seedBehavior(env.api, { nextAt: Date.now() - 1000 })
  env.setThinkReply('{"action":"wander","params":{},"say":"","moodDelta":0}')
  const ai = await env.exports.behavior()
  assert.equal(ai.action, 'fallback', JSON.stringify(ai))
  assert.match(env.thinkCalls[env.thinkCalls.length - 1].prompt, /wander/, '简报禁选清单里带被禁动作')
  // 直接解析也拒绝
  assert.equal(env.exports.behaviorParse('{"action":"wander","params":{}}'), null)
  assert.equal(env.exports.behaviorParse('{"action":"steal_cursor","params":{}}'), null)
  assert.equal(env.exports.behaviorParse('{"action":"chase_cursor","params":{}}').action, 'chase_cursor', '没禁的照常')
  // 手动通道不受限：wander 照样下发
  const manual = await env.call('/behavior', { method: 'POST', json: { action: 'wander', params: {} } })
  assert.equal(manual.status, 200)
  assert.equal(manual.json.ok, true)
  assert.equal(manual.json.action, 'wander')
})

test('决策简报带桌面图标清单（只列可碰的）；读不到桌面时图标动作进禁选', async () => {
  const env = startModule()
  const dir = withFakeDesktop(env, { '可拖.lnk': 'lnk', '文档.txt': 'hi', '收藏夹': null, '.藏起来': 'x', 'desktop.ini': 'x', 'setup.exe': 'x' })
  try {
    await env.connect()
    assert.deepEqual(env.exports.iconList().sort(), ['可拖.lnk', '文档.txt'].sort(), '清单与校验规则一致（文件夹/隐藏/壳层/可执行都不列）')
    seedBehavior(env.api, { nextAt: Date.now() - 1000 })
    env.setThinkReply('{"action":"drag_icon","params":{"icon":"可拖.lnk"},"say":"","moodDelta":0}')
    const r = await env.exports.behavior()
    assert.equal(r.ok, true, JSON.stringify(r))
    const prompt = env.thinkCalls[env.thinkCalls.length - 1].prompt
    assert.match(prompt, /可拖\.lnk/, '简报里给出可挑的图标名字')
    assert.match(prompt, /文档\.txt/)
    assert.ok(!/setup\.exe/.test(prompt), '可执行文件不进清单')
    // 读不到桌面 → 图标动作不列入禁选之外还会被明确禁选，避免瞎报名字
    env.api.__petTestHooks.desktopDir = () => null
    assert.deepEqual(env.exports.iconList(), [])
    seedBehavior(env.api, { nextAt: Date.now() - 1000 })
    env.setThinkReply('{"action":"wander","params":{},"say":"","moodDelta":0}')
    await env.exports.behavior()
    assert.match(env.thinkCalls[env.thinkCalls.length - 1].prompt, /禁止选择.*hide_icon/, '没有可挑图标时禁选图标动作')
  } finally {
    env.api.__petTestHooks.desktopDir = undefined
    rmSync(dir, { recursive: true, force: true })
  }
})

test('跨卷（EXDEV）退化为「拷贝→校验大小→删源」：收走与归还都还能用，内容不丢', async () => {
  const env = startModule()
  const dir = withFakeDesktop(env, { '跨盘.lnk': 'lnk-内容' })
  try {
    // 注入一个永远报 EXDEV 的 rename，模拟桌面在别的盘（真机 OneDrive/双盘）
    env.api.__petTestHooks.rename = () => { const e = new Error('cross-device link not permitted'); e.code = 'EXDEV'; throw e }
    const r = env.exports.iconAct({ mode: 'hide', icon: '跨盘.lnk' })
    assert.equal(r.ok, true, JSON.stringify(r))
    const qdir = env.api.dataDir('desktop-quarantine')
    assert.ok(!existsSync(join(dir, '跨盘.lnk')), '源文件已挪走')
    assert.equal(readFileSync(join(qdir, '跨盘.lnk'), 'utf8'), 'lnk-内容', '隔离区里是完整拷贝')
    const list = JSON.parse(readFileSync(join(qdir, 'manifest.json'), 'utf8'))
    assert.equal(list.length, 1)
    // 归还同样能跨卷
    const back = await env.exports.iconRestore(list[0].id)
    assert.equal(back.ok, true, JSON.stringify(back))
    assert.equal(readFileSync(join(dir, '跨盘.lnk'), 'utf8'), 'lnk-内容', '原样回到桌面')
    assert.equal(JSON.parse(readFileSync(join(qdir, 'manifest.json'), 'utf8')).length, 0)
  } finally {
    env.api.__petTestHooks.rename = undefined
    env.api.__petTestHooks.desktopDir = undefined
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 第二批的边界：参数校验 / 失败形态 / 死记录自愈 ----------

test('解析：图标动作必须带合法 icon（缺/空/带路径/非字符串都丢弃）；禁用动作不进最终动作表', () => {
  const e = startModule({ settings: { behaviorDisabledActions: 'hide_icon' } })
  const p = e.exports.behaviorParse
  assert.equal(p('{"action":"hide_icon","params":{}}'), null, '没 icon → 丢弃')
  assert.equal(p('{"action":"hide_icon","params":{"icon":"  "}}'), null, '空 icon → 丢弃')
  assert.equal(p('{"action":"hide_icon","params":{"icon":"C:\\\\Users\\\\a\\\\Desktop\\\\x.lnk"}}'), null, '带路径 → 丢弃（只认桌面文件名）')
  assert.equal(p('{"action":"drag_icon","params":{"icon":123}}'), null, '非字符串 → 丢弃')
  assert.equal(p('{"action":"drag_icon","params":{"icon":"x.lnk"}}').params.icon, 'x.lnk')
  assert.equal(p('{"action":"hide_icon","params":{"icon":"x.lnk"}}'), null, '被 behaviorDisabledActions 禁用 → AI 路径丢弃')
})

test('act 失败一律回 acted:false；quarantine 路由带 enabled/days；status 暴露隔离区条数', async () => {
  const env = startModule({ settings: { behaviorIconQuarantineDays: 3 } })
  const dir = withFakeDesktop(env, { 'a.lnk': 'lnk' })
  try {
    const bad = await env.call('/behavior/icon/act', { method: 'POST', json: { mode: 'hide', icon: '没有这个.lnk' } })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.ok, false)
    assert.equal(bad.json.acted, false, '失败不带 acted:true，客户端据此不播「得逞」')
    assert.equal(bad.json.reason, 'not-found')
    const badMode = await env.call('/behavior/icon/act', { method: 'POST', json: { mode: '乱写', icon: 'a.lnk' } })
    assert.equal(badMode.json.reason, 'bad-mode')
    const okHide = await env.call('/behavior/icon/act', { method: 'POST', json: { mode: 'hide', icon: 'a.lnk', force: true } })
    assert.equal(okHide.status, 200)
    const q = await env.call('/behavior/icon/quarantine')
    assert.equal(q.json.items.length, 1)
    assert.equal(q.json.days, 3, '面板拿天数写「超 3 天自动放回」')
    assert.equal(q.json.enabled, true)
    const st = await env.call('/behavior/status')
    assert.equal(st.json.behavior.quarantined, 1, '状态里给面板小红点用')
    assert.equal(st.json.behavior.iconQuarantineDays, 3)
  } finally {
    env.api.__petTestHooks.desktopDir = undefined
    rmSync(dir, { recursive: true, force: true })
  }
})

test('死记录自愈：隔离区文件已不在 → restore 报 quarantine-file-gone 并摘掉记录；sweep 顺手清理', async () => {
  const env = startModule()
  const dir = withFakeDesktop(env, {})
  try {
    const qdir = env.api.dataDir('desktop-quarantine')
    mkdirSync(qdir, { recursive: true })
    const ghost = { id: 'deadbeef', name: '幽灵.lnk', originalPath: join(dir, '幽灵.lnk'), quarantinePath: join(qdir, '幽灵.lnk'), at: Date.now() - 9 * 24 * 3600_000, reason: 'hide_icon', playbackId: '' }
    writeFileSync(join(qdir, 'manifest.json'), JSON.stringify([ghost]))
    const r = await env.call('/behavior/icon/restore', { method: 'POST', json: { id: 'deadbeef' } })
    assert.equal(r.json.ok, false)
    assert.equal(r.json.reason, 'quarantine-file-gone')
    assert.equal(JSON.parse(readFileSync(join(qdir, 'manifest.json'), 'utf8')).length, 0, '死记录被摘掉，面板不再挂点不动的按钮')
    // sweep 同样清理（不碰任何真实文件）
    writeFileSync(join(qdir, 'manifest.json'), JSON.stringify([{ ...ghost, id: 'dead0000' }]))
    const s = await env.exports.iconSweep(Date.now())
    assert.equal(s.restored, 0)
    assert.equal(JSON.parse(readFileSync(join(qdir, 'manifest.json'), 'utf8')).length, 0)
  } finally {
    env.api.__petTestHooks.desktopDir = undefined
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 第三批：窗口动作（§6.1 关窗四重闸 + 记录 + 道歉） ----------

test('close_window：物理闸默认关 → AI 简报里禁选，手动「试一下」也下发不出去（force 也不绕）', async () => {
  const env = startModule({ settings: { behaviorCloseWindowEnabled: false } })
  env.setMood(10) // 心情再低也不许，物理闸优先
  const st = env.exports.behaviorStatus()
  assert.equal(st.closeWindowEnabled, false)
  // 开关关着时连手动 force 都不下发：/behavior 是唯一收窄点，AI 与「试一下」共用它。
  // （早前这条断言基于「真拦截在客户端」，但客户端执行层根本拿不到这个开关，
  //   结果就是面板一点真关窗口 —— 物理闸必须落在服务端。）
  const b = env.exports.behaviorStatus()
  assert.ok(b.openActions.includes('close_window'), '动作本身仍在开放清单里（只是被物理闸拦）')
  const r = await env.call('/behavior', { method: 'POST', json: { action: 'close_window', force: true } })
  assert.equal(r.status, 400)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.reason, 'close-window-disabled')
  assert.match(r.json.message, /允许 AI 关闭窗口/, '要告诉主人去开哪个开关')
  // 打开开关后同一调用就能下发（先连上事件，否则游标已越过这一条）
  const env2 = startModule({ settings: { behaviorCloseWindowEnabled: true } })
  env2.setMood(10)
  const ev = await env2.connect({ wantEvents: true })
  const ok = await env2.call('/behavior', { method: 'POST', json: { action: 'close_window', force: true } })
  assert.equal(ok.json.ok, true)
  assert.ok(ok.json.playbackId)
  const got = await env2.call('/events', { query: { since: String(ev.cursor), wait: '0', client: 'pet-test' } })
  const evt = got.json.events.find((e) => e.type === 'behavior')
  assert.equal(evt.params.windowEnabled, true, '开关打开时下发 windowEnabled=true（客户端二次校验用）')
})

test('close_window 心情闸：开关开着但心情够高 → AI 简报禁选；心情很低 → 放行', async () => {
  const env = startModule({ settings: { behaviorCloseWindowEnabled: true, behaviorMoodCloseWindowBelow: 35 } })
  env.setThinkReply(JSON.stringify({ action: 'close_window', params: {}, say: '' }))
  env.setMood(80)
  await env.connect()
  seedBehavior(env.api, { nextAt: Date.now() - 1000 })
  const high = await env.exports.behavior({ force: false, reason: 'timed' })
  assert.equal(high.action, 'fallback', '心情 80 → 关窗被心情闸拦，回退本地池')
  // 心情 20 → 放行（会下发 behavior 事件）
  env.setMood(20)
  seedBehavior(env.api, { nextAt: Date.now() - 1000 })
  const ev = await env.connect({ wantEvents: true })
  const low = await env.exports.behavior({ force: false, reason: 'timed' })
  assert.equal(low.ok, true, JSON.stringify(low))
  assert.equal(low.action, 'close_window')
  const got = await env.call('/events', { query: { since: String(ev.cursor), wait: '0', client: 'pet-test' } })
  const evt = got.json.events.find((e) => e.type === 'behavior')
  assert.ok(evt, '行为事件已下发')
  assert.ok('whitelist' in evt.params, '窗口动作必须把白名单一起下发（客户端执行层要判）')
})

test('关窗记录：回执带 detail → 写进 closeLog；面板 data 里能查到今日次数与「要不要道歉」', async () => {
  const env = startModule({ settings: { behaviorCloseWindowEnabled: true } })
  const w = await env.call('/behavior', { method: 'POST', json: { action: 'close_window', force: true } })
  const pid = w.json.playbackId || (w.json.result && w.json.result.playbackId)
  assert.ok(pid)
  await env.call('/playback', { method: 'POST', json: { playbackId: pid, action: 'close_window', status: 'played', detail: '草稿.txt - 记事本' } })
  const st = env.exports.behaviorStatus()
  assert.equal(st.closeLog.length, 1)
  assert.equal(st.closeLog[0].window, '草稿.txt - 记事本')
  assert.equal(st.closeLog[0].status, 'played')
  assert.equal(st.closeToday, 1)
  assert.equal(st.apologyDue, true, '还没道歉 → 面板显示道歉按钮')
  assert.ok(env.memAdds.some((m) => String(m.text).includes('关掉了窗口「草稿.txt - 记事本」')), '关窗要留一条记忆')
  // 失败的回执也记账，但不计入「今天关了 N 个」
  await env.call('/playback', { method: 'POST', json: { playbackId: 'x2', action: 'close_window', status: 'failed', reason: 'close-failed', detail: '某个窗口' } })
  const st2 = env.exports.behaviorStatus()
  assert.equal(st2.closeLog.length, 2)
  assert.equal(st2.closeToday, 1, '只有 played 才算真关掉')
})

test('补偿道歉：心情 +8、标记最近一条未道歉记录；没有记录时报 nothing-to-apologize', async () => {
  const env = startModule({ settings: { behaviorCloseWindowEnabled: true } })
  const none = await env.call('/behavior/window/apologize', { method: 'POST', json: {} })
  assert.equal(none.status, 404)
  assert.equal(none.json.reason, 'nothing-to-apologize')

  const w = await env.call('/behavior', { method: 'POST', json: { action: 'close_window', force: true } })
  await env.call('/playback', { method: 'POST', json: { playbackId: w.json.playbackId || (w.json.result && w.json.result.playbackId), action: 'close_window', status: 'played', detail: '记事本' } })
  const before = env.nudges.length
  const r = await env.call('/behavior/window/apologize', { method: 'POST', json: {} })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.window, '记事本')
  assert.deepEqual(env.nudges.slice(before).map((n) => n.d), [8], '道歉让心情回一点')
  assert.equal(env.exports.behaviorStatus().apologyDue, false, '道过歉就不再提示')
  // 记录不删，只是标记 apologizedAt
  assert.equal(env.exports.behaviorStatus().closeLog.length, 1)
  // 再道歉一次 → 没有待道歉的记录了
  const again = await env.call('/behavior/window/apologize', { method: 'POST', json: {} })
  assert.equal(again.json.ok, false)
})

test('/behavior/status：带窗口动作的实时口径（心情 / 白名单 / 开关）', async () => {
  const env = startModule({ settings: { behaviorWindowWhitelist: 'code\nnotepad', behaviorCloseWindowEnabled: true } })
  env.setMood(42)
  const r = await env.call('/behavior/status')
  const b = r.json.behavior
  assert.equal(b.mood, 42)
  assert.equal(b.windowWhitelist, 'code\nnotepad')
  assert.equal(b.closeWindowEnabled, true)
  assert.equal(b.moodCloseWindowBelow, 35)
  assert.deepEqual(b.closeLog, [])
  assert.equal(b.closeToday, 0)
  assert.equal(b.apologyDue, false)
})

// ---------- 每个动作都必须有气泡台词（否则主人只看见她在动，不知道要干什么） ----------

test('动作表自带默认台词：除 say（自己会说）外，一个都不能是空的', () => {
  const env = startModule()
  const acts = env.exports.behaviorStatus().openActions
  const b = env.exports.BEHAVIOR_SAY_FOR_TEST || null
  assert.equal(env.exports.behaviorActionsForTest().length, 9, '动作表 9 条（2026-10-30 裁撤后）')
  // 走一遍真实下发：拿不到 say 时事件里必须有默认台词
  for (const a of acts) {
    if (a === 'say') continue
    const line = env.exports.behaviorSayForTest(a)
    assert.ok(line && line.length >= 4, `${a} 缺默认台词，面板「试一下」时不会有气泡`)
  }
  assert.equal(env.exports.behaviorSayForTest('say'), '', 'say 用 params.text，不挂默认台词')
  void b
})

test('手动「试一下」（force、无 say）也会带默认台词下发', async () => {
  const env = startModule()
  const ev0 = await env.connect({ wantEvents: true })
  const r = await env.call('/behavior', { method: 'POST', json: { action: 'steal_cursor', force: true } })
  assert.equal(r.json.ok, true, JSON.stringify(r.json))
  assert.equal(r.json.say, '（叼走你的鼠标）', '返回值里带台词（面板能直接显示）')
  const got = await env.call('/events', { query: { since: String(ev0.cursor), wait: '0', client: 'pet-test' } })
  const ev = got.json.events.find((e) => e.type === 'behavior')
  assert.equal(ev.say, '（叼走你的鼠标）', '事件里必须有台词，客户端才顶得出气泡')
})

test('say 动作：用 params.text 当台词；没给内容直接拒，不空弹一个气泡', async () => {
  const env = startModule()
  const ev0 = await env.connect({ wantEvents: true })
  const ok = await env.call('/behavior', { method: 'POST', json: { action: 'say', params: { text: '哼，别看我' }, force: true } })
  assert.equal(ok.json.ok, true)
  assert.equal(ok.json.say, '哼，别看我')
  const got = await env.call('/events', { query: { since: String(ev0.cursor), wait: '0', client: 'pet-test' } })
  assert.equal(got.json.events.find((e) => e.type === 'behavior').say, '哼，别看我')

  const bad = await env.call('/behavior', { method: 'POST', json: { action: 'say', params: {}, force: true } })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.reason, 'empty-text')
})

test('服务端与客户端的默认台词必须逐字一致（客户端要能在拿不到服务端 say 时自己顶气泡）', async () => {
  const env = startModule()
  const clientSrc = readFileSync(new URL('../src/modules/pet/pet-client/behavior.js', import.meta.url), 'utf8')
  for (const a of env.exports.behaviorActionsForTest().map((x) => x.action)) {
    const m = new RegExp("  " + a + ": \\{[\\s\\S]{0,400}?\\n    say: '([^']*)',").exec(clientSrc)
    assert.ok(m, `客户端 ACTIONS 里 ${a} 缺 say 字段`)
    assert.equal(m[1], env.exports.behaviorSayForTest(a), `${a} 两边台词不一致（改一处忘另一处）`)
  }
})
