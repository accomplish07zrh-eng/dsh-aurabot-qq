import test from 'node:test'
import assert from 'node:assert/strict'
import { createDanmaku, danmakuInput, danmakuPanelRequest } from '../src/modules/bili/danmaku.js'
import definition from '../src/modules/bili/index.js'
import { bangumiEpisode } from '../src/bili/danmaku.js'
const video = 'BV1xx411c7mD'
const input = { video, text: '这一段好有意思😀', seconds: 8.25, position: 'bottom' }

function fixture() {
  let data = { history: [] }, time = Date.parse('2026-10-31T10:00:00+08:00')
  let cookie = 'SESSDATA=fake; bili_jct=csrf; DedeUserID=10001'
  const cfg = { enabled: true, dryRun: false, ownerQQ: '10000', bili: { enabled: true } }
  const settings = { danmakuEnabled: true, autoDanmaku: false, maxDanmakuPerDay: 3 }
  Object.assign(cfg.bili, settings)
  Object.defineProperty(cfg.bili, 'cookie', { get: () => cookie })
  const calls = [], memories = [], disposers = [], prompts = []
  let onPrepare = () => {}, onPost = () => {}, response = { dmid_str: '12345678901234567890' }
  const api = {
    config: () => cfg, settings: () => cfg.bili, dataDir: () => '/unused/danmaku.json',
    lib: () => ({ readJson: () => structuredClone(data), writeJson: (file, next) => { data = structuredClone(next) } }),
    use: (name) => name === 'login-manager' ? { resolve: () => ({ handled: true, ok: !!cookie, cookie }) } : name === 'memory' ? { addEvent: (event) => memories.push(event) } : null,
    onDispose: (fn) => disposers.push(fn), log: { warn() {} },
    core: { hub: { runSystemTurn: async (...args) => { prompts.push(args); return JSON.stringify({ send: true, text: '这个主题挺有趣', seconds: 0 }) } } },
  }
  const controller = createDanmaku(api, { read: () => structuredClone(data), write: (file, next) => { data = structuredClone(next) }, now: () => time, prepare: async (options) => {
    calls.push({ type: 'prepare', options })
    onPrepare()
    return { info: { bvid: video, aid: '1', cid: '2', duration: 90, title: '测试视频', part: options.part },
      async post(text, progress, mode) {
        onPost()
        options.beforePost()
        calls.push({ type: 'post', text, progress, mode })
        if (response instanceof Error) throw response
        return response
      } }
  } })
  return { api, controller, cfg, settings: cfg.bili, calls, memories, prompts, disposers,
    tick: () => { time += 31000 }, now: () => time, setCookie: (next) => { cookie = next },
    onPrepare: (fn) => { onPrepare = fn }, onPost: (fn) => { onPost = fn }, response: (next) => { response = next } }
}

test('弹幕参数：完整链接分P、秒数、小数与 emoji；拒绝不合法内容', () => {
  const parsed = danmakuInput({ ...input, video: `https://www.bilibili.com/video/${video}?p=2` })
  assert.equal(parsed.part, 2)
  assert.equal(parsed.video, video)
  assert.equal(parsed.seconds, 8.25)
  for (const patch of [{ video: 'https://example.com/video/' + video }, { text: '' }, { text: 'a'.repeat(101) }, { text: '\ud83d' }, { text: 'a\nb' }, { seconds: -1 }, { seconds: '' }, { part: 1.5 }, { position: 'bad' }]) assert.throws(() => danmakuInput({ ...input, ...patch }))
})

test('番剧整季按选集序号解析，ep链接直接定位单集，时长由毫秒转换', () => {
  const body = { code: 0, result: { title: '番剧', episodes: [
    { id: 123, bvid: video, aid: 1, cid: 2, title: '1', duration: 90000 },
    { id: 456, bvid: video, aid: 3, cid: 4, title: '2', duration: 120000 },
  ] } }
  const parsed = danmakuInput({ ...input, video: 'https://www.bilibili.com/bangumi/play/ss39706?spm_id_from=test' })
  assert.equal(parsed.video, 'ss39706')
  assert.equal(bangumiEpisode(body, parsed.video, 1).cid, '2')
  assert.equal(bangumiEpisode(body, parsed.video, 2).duration, 120)
  assert.equal(bangumiEpisode(body, 'ep456', 1).cid, '4')
  assert.equal(danmakuInput({ ...input, video: 'ep456', part: 9 }).part, 1)
  assert.throws(() => bangumiEpisode(body, 'ss39706', 3), /没有找到/)
  assert.throws(() => bangumiEpisode({ code: -404 }, 'ep123', 1), /未成功/)
})

test('发送一次，秒转毫秒，返回字符串弹幕ID，并只在成功时写记忆', async () => {
  const f = fixture()
  const result = await f.controller.send(input)
  assert.equal(result.ok, true)
  assert.equal(result.id, '12345678901234567890')
  assert.deepEqual(f.calls[1], { type: 'post', text: input.text, progress: 8250, mode: 4 })
  assert.equal(f.memories.length, 1)
  assert.equal(f.controller.state().sentToday, 1)
})

test('总开关、B站开关、弹幕开关、缺登录以及试运行都不提交请求', async () => {
  for (const scenario of ['master', 'bili', 'danmaku', 'login', 'dry']) {
    const f = fixture()
    if (scenario === 'master') f.cfg.enabled = false
    if (scenario === 'bili') f.cfg.bili.enabled = false
    if (scenario === 'danmaku') f.settings.danmakuEnabled = false
    if (scenario === 'login') f.setCookie('')
    if (scenario === 'dry') f.cfg.dryRun = true
    const result = await f.controller.send(input)
    assert.equal(f.calls.length, 0)
    assert.equal(f.memories.length, 0)
    assert.equal(f.controller.state().attemptsToday, 0)
    if (scenario === 'dry') assert.equal(result.dryRun, true)
    else assert.equal(result.ok, false)
  }
})

test('准备期间换账号、开启试运行或关闭总开关，实际提交前会停止', async () => {
  for (const scenario of ['login', 'dry', 'master']) {
    const f = fixture()
    f.onPost(() => {
      if (scenario === 'login') f.setCookie('SESSDATA=new; bili_jct=new')
      if (scenario === 'dry') f.cfg.dryRun = true
      if (scenario === 'master') f.cfg.enabled = false
    })
    assert.equal((await f.controller.send(input)).ok, false)
    assert.equal(f.calls.filter((call) => call.type === 'post').length, 0)
    assert.equal(f.controller.state().attemptsToday, 0)
  }
})

test('时间超出分P时长不发；检查视频只读、不消耗次数', async () => {
  const f = fixture()
  assert.equal((await f.controller.inspect({ video, part: 1 })).info.duration, 90)
  assert.equal((await f.controller.send({ ...input, seconds: 90 })).ok, false)
  assert.equal(f.calls.filter((call) => call.type === 'post').length, 0)
  assert.equal(f.controller.state().attemptsToday, 0)
})

test('平台拒绝、超时或没有ID不能伪报成功，也不能自动重复提交', async () => {
  for (const response of [new Error('timeout'), Object.assign(new Error('login failed'), { code: 'AUTH_REQUIRED' }), {}]) {
    const f = fixture()
    f.response(response)
    const first = await f.controller.send(input)
    assert.equal(first.ok, false)
    assert.equal(first.uncertain, true)
    assert.equal(f.memories.length, 0)
    f.tick()
    assert.equal((await f.controller.send(input)).ok, false)
    assert.equal(f.calls.filter((call) => call.type === 'post').length, 1)
    assert.equal(f.controller.state().attemptsToday, 1)
  }
})

test('成功弹幕去重并遵守每日限额，失败请求也计入提交次数', async () => {
  const f = fixture()
  f.settings.maxDanmakuPerDay = 1
  assert.equal((await f.controller.send(input)).ok, true)
  f.tick()
  assert.equal((await f.controller.send({ ...input, text: '另一条' })).ok, false)
  assert.equal(f.calls.filter((call) => call.type === 'post').length, 1)
})

test('更换凭证不重置额度；别名链接与同一毫秒的弹幕仍去重', async () => {
  const f = fixture()
  assert.equal((await f.controller.send({ ...input, seconds: 8.2501 })).ok, true)
  f.tick()
  f.setCookie('SESSDATA=fresh; bili_jct=new; DedeUserID=10002')
  assert.equal(f.controller.state().attemptsToday, 1)
  assert.equal((await f.controller.send({ ...input, video: 'av170001', seconds: 8.2502 })).ok, false)
  assert.equal(f.calls.filter((call) => call.type === 'post').length, 1)
})

test('自动弹幕默认关闭；打开后仅为本轮观看生成，不重发同一视频', async () => {
  const f = fixture()
  const watched = [{ bvid: video, title: '测试视频', text: '有趣' }]
  await f.controller.afterBrowse(watched)
  assert.equal(f.prompts.length, 0)
  f.settings.autoDanmaku = true
  await f.controller.afterBrowse(watched)
  assert.equal(f.prompts.length, 1)
  assert.equal(f.prompts[0][3].noTools, true)
  assert.equal(f.controller.state().sentToday, 1)
  await f.controller.afterBrowse(watched)
  assert.equal(f.prompts.length, 1)
})

test('模块停止后不继续发送', async () => {
  const f = fixture()
  f.onPrepare(() => f.disposers.forEach((fn) => fn()))
  assert.equal((await f.controller.send(input)).ok, false)
  assert.equal(f.calls.filter((call) => call.type === 'post').length, 0)
})

test('新安装、旧配置和非法配置的两个弹幕开关都默认关闭', async () => {
  const { normalize } = await import('../src/core/config.js')
  for (const raw of [{}, { bili: {} }, { bili: { danmakuEnabled: 'true', autoDanmaku: 'true' } }]) {
    assert.equal(normalize(raw).bili.danmakuEnabled, false)
    assert.equal(normalize(raw).bili.autoDanmaku, false)
  }
  const f = fixture()
  delete f.settings.danmakuEnabled
  assert.equal((await f.controller.send(input)).ok, false)
  assert.equal(f.calls.length, 0)
  f.settings.autoDanmaku = true
  await f.controller.afterBrowse([{ bvid: video }])
  assert.equal(f.prompts.length, 0)
})

test('面板请求拒绝GET、跨站、伪造Origin和缺操作头；接受本页面请求', () => {
  const headers = { 'content-type': 'application/json', 'x-aurabot-bili-danmaku': '1', host: 'localhost:1234' }
  assert.equal(danmakuPanelRequest({ method: 'GET', headers }), false)
  assert.equal(danmakuPanelRequest({ method: 'POST', headers: {} }), false)
  assert.equal(danmakuPanelRequest({ method: 'POST', headers: { ...headers, 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(danmakuPanelRequest({ method: 'POST', headers: { ...headers, origin: 'https://other.example' } }), false)
  assert.equal(danmakuPanelRequest({ method: 'POST', headers: { ...headers, origin: 'http://localhost:1234' } }), true)
  assert.equal(danmakuPanelRequest({ method: 'POST', headers: { ...headers, origin: 'dsh-app://localhost' } }), true)
})

test('内置弹幕工具默认不挂载，只接受主人私聊且执行时复核身份', async () => {
  const f = fixture()
  const builders = []
  definition.setup({ ...f.api, on() {}, every() {}, route() {},
    lazy: () => ({}), tool: (builder) => builders.push(builder),
    core: { hub: { turnSendersAllOwner: () => false } },
  })
  const context = { level: 'full', chat: { kind: 'private', userId: '10000' }, sessionId: 'test' }
  const find = (ctx) => builders.flatMap((build) => build(ctx)).find((tool) => tool?.name === 'bili_danmaku')
  f.settings.danmakuEnabled = false
  assert.equal(find(context), undefined)
  f.settings.danmakuEnabled = true
  assert.equal(find({ ...context, chat: { kind: 'group', userId: '10000' } }), undefined)
  assert.equal(find({ ...context, level: 'social' }), undefined)
  const tool = find(context)
  assert.ok(tool)
  const result = await tool.execute({ link: video, text: '测试', seconds: 0 })
  assert.equal(result.ok, false)
  assert.equal(f.calls.length, 0)
})
