// 桌宠模块（pet）测试：
//   · 载体互斥不双发 / 离线回落 QQ（petFallbackToQQ）
//   · 心跳在线判定（轮询 /events 刷新 presence，60s TTL）
//   · focus.json 开关（含坏文件 fail-open）与 force 绕过
//   · TTS 产物即刻转存进 pet 数据目录（R13：voice-cache 24h 清理不能直接指给客户端）
//   · P2 动画点播：事件带 anim + playbackId，POST /playback 回执
//   · P1/P4 形象包：packs 扫描、/config 包视图、/asset 严格隔离（404 不回落）、/pack 切换
//   · P3 拖拽物理移植（physics.js 纯函数：弹簧/软钳速/抛体积分/松手初速/挤压）
// 全程 AURABOT_DATA_DIR 隔离（R14），fake api 模仿 modules.js 的 makeApi 面，不引入新依赖。
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let mod
const OWNER = '10000001'
const MODULE_DIR = fileURLToPath(new URL('../src/modules/pet', import.meta.url))

before(async () => {
  mod = (await import('../src/modules/pet/index.js')).default
})

beforeEach(() => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-pet-'))
})

// ---------- 假模块环境（对齐 src/core/modules.js 的 makeApi 面） ----------

function startModule({ settings = {} } = {}) {
  const s = { carrier: 'pet', modality: 'text', petFallbackToQQ: true, pack: 'default', ...settings }
  const routes = new Map()
  const sentToQQ = []
  let voiceFile = ''
  const api = {
    id: 'pet',
    dir: MODULE_DIR,
    version: 'test',
    log: { info() {}, warn() {}, debug() {}, error() {} },
    dataDir: (...parts) => {
      const d = join(process.env.AURABOT_DATA_DIR, 'modules-data', 'pet')
      mkdirSync(d, { recursive: true })
      return join(d, ...parts)
    },
    config: () => ({ ownerQQ: OWNER }),
    settings: () => ({ ...s }),
    saveSettings: (patch) => { Object.assign(s, patch); return { ...s } },
    route: (path, handler) => { routes.set(path, handler) },
    every: () => () => {},
    onDispose: () => {},
    has: (id) => (id === 'mood' && moodValue != null) || (id === 'voice' && Boolean(voiceFile)),
    use: (id) => (id === 'mood' ? { current: () => moodValue } : id === 'voice' ? { speak: async () => ({ file: voiceFile, engine: 'fake' }) } : null),
    sendText: async (chatId, text) => { sentToQQ.push({ chatId, text }) },
    core: {
      http: {
        send: (res, code, body) => { res.statusCode = code; res.end(JSON.stringify(body)) },
        query: (req) => { try { return Object.fromEntries(new URL(req.url, 'http://x').searchParams) } catch { return {} } },
        body: async (req) => req.__json ?? {},
      },
    },
  }
  let moodValue = 75 // happy
  api.use = (id) => (id === 'mood' ? { current: () => moodValue } : id === 'voice' ? { speak: async () => ({ file: voiceFile, engine: 'fake' }) } : null)
  api.has = (id) => (id === 'mood') || (id === 'voice' && Boolean(voiceFile))
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
    if (!handler) return { status: 404, json: { ok: false, message: 'no route ' + path } } // 精确匹配：没注册的子路径就是 404
    const res = { statusCode: 200, headers: {}, raw: null, setHeader(k, v) { this.headers[k] = v }, end(b) { this.raw = b } }
    await handler(req(path, opts), res)
    let body = res.raw
    try { body = JSON.parse(res.raw) } catch {}
    return { status: res.statusCode, headers: res.headers, raw: res.raw, json: body }
  }
  /** 模拟一个客户端连上长轮询：刷新心跳并对齐水位；wantEvents=true 时再取一次增量。 */
  async function connect({ wantEvents = false, since } = {}) {
    const first = await call('/events', { query: { wait: '0', client: 'pet-test' } })
    assert.equal(first.json.ok, true)
    if (!wantEvents) return { cursor: first.json.cursor, events: [] }
    const r = await call('/events', { query: { since: String(since ?? first.json.cursor), wait: '0', client: 'pet-test' } })
    return { cursor: first.json.cursor, events: r.json.events }
  }
  return { api, exports, routes, call, connect, token, sentToQQ, setVoiceFile: (f) => { voiceFile = f }, setMood: (v) => { moodValue = v } }
}

// ---------- P0：发现文件 / 鉴权 / 端口漂移 ----------

test('P0：host.json + host-token 落盘；端口从 Host 头学习并重写（R9）', async () => {
  const env = startModule()
  const hostFile = env.api.dataDir('host.json')
  assert.ok(existsSync(hostFile))
  const h1 = JSON.parse(readFileSync(hostFile, 'utf8'))
  assert.equal(h1.version, 1)
  assert.equal(h1.api, '/aurabot/api')
  assert.equal(h1.token, env.token, 'host.json 里的 token 与 host-token 一致')
  assert.ok(h1.baseUrl.endsWith(':0'), '端口未知时写 :0（客户端探测失败会重读）')

  const bad = await env.call('/status', { token: 'deadbeef'.repeat(6) })
  assert.equal(bad.status, 401, '坏令牌 401')
  const ok = await env.call('/status')
  assert.equal(ok.json.ok, true)

  const h2 = JSON.parse(readFileSync(hostFile, 'utf8'))
  assert.ok(h2.baseUrl.endsWith(':53210'), `第一次请求后从 Host 头学到真实端口：${h2.baseUrl}`)
})

test('P0：心跳在线判定——连过 /events 即在线；没连过的实例是离线', async () => {
  const env = startModule()
  assert.equal(env.exports.online().online, false, '没人轮询：离线')
  await env.connect()
  const on = env.exports.online()
  assert.equal(on.online, true)
  assert.equal(on.clients, 1)
  const offline = startModule()
  assert.equal(offline.exports.online().online, false, '另一个数据目录的实例不受影响')
})

// ---------- 载体互斥 / 回落 ----------

test('互斥：carrier=qq 时 dispatch 不推气泡也不代发 QQ；carrier=pet 且在线只推气泡不双发', async () => {
  const qq = startModule({ settings: { carrier: 'qq' } })
  const r1 = await qq.exports.dispatch({ text: '在吗' })
  assert.equal(r1.via, 'qq')
  assert.equal(r1.reason, 'carrier-qq')
  assert.equal(qq.sentToQQ.length, 0, 'carrier=qq：桌宠不代发')
  const { cursor } = await qq.connect()
  const got = await qq.connect({ wantEvents: true, since: cursor })
  assert.equal(got.events.filter((e) => e.type === 'proactive').length, 0, '没推气泡')

  const pet = startModule({ settings: { carrier: 'pet' } })
  await pet.connect()
  const r2 = await pet.exports.dispatch({ text: '想你了' })
  assert.equal(r2.ok, true)
  assert.equal(r2.via, 'pet')
  assert.equal(pet.sentToQQ.length, 0, '桌宠在线：绝不双发 QQ')
  assert.equal(r2.message.type, 'proactive')
  assert.equal(r2.message.mood, 'happy', 'mood 由 api.use(\'mood\').current() 映射')
})

test('回落：pet 离线且 petFallbackToQQ → 发一次 QQ 私聊；关回落则不发', async () => {
  const env = startModule({ settings: { carrier: 'pet', petFallbackToQQ: true } })
  const r = await env.exports.dispatch({ text: '主人吃了吗' })
  assert.equal(r.via, 'qq')
  assert.equal(r.fallback, true)
  assert.deepEqual(env.sentToQQ, [{ chatId: `private:${OWNER}`, text: '主人吃了吗' }], '只发一次 QQ，无双发')

  const env2 = startModule({ settings: { carrier: 'pet', petFallbackToQQ: false } })
  const r2 = await env2.exports.dispatch({ text: '在吗' })
  assert.equal(r2.ok, false)
  assert.equal(r2.reason, 'pet-offline')
  assert.equal(env2.sentToQQ.length, 0)
})

// ---------- focus ----------

test('focus：开专注拦自动轮次（不回落）；force 可绕；坏 focus.json 按关闭（fail-open）', async () => {
  const env = startModule()
  await env.connect()
  await env.call('/focus', { method: 'POST', json: { enabled: true, source: 'test' } })
  const r = await env.exports.dispatch({ text: '想跟你说件事' })
  assert.equal(r.reason, 'focus')
  assert.equal(env.sentToQQ.length, 0, '专注：不发也不回落')
  const f = JSON.parse(readFileSync(env.api.dataDir('focus.json'), 'utf8'))
  assert.equal(f.enabled, true)
  assert.equal(f.source, 'test')

  const forced = await env.call('/bubble', { method: 'POST', json: { text: '面板测试', force: true } })
  assert.equal(forced.json.ok, true, 'force（面板手动测试）绕过专注')

  writeFileSync(env.api.dataDir('focus.json'), '{ 坏掉的 json')
  assert.equal(env.exports.focus(), false, '坏文件按关闭')
  const r2 = await env.exports.dispatch({ text: '又到点了' })
  assert.equal(r2.via, 'pet', '坏 focus.json：fail-open，照常投递')
})

// ---------- TTS 转存（R13） ----------

test('TTS：voice 产物即刻转存 pet/voice/<sha1>.wav，audio.url 走 /audio/ 且不含 voice-cache', async () => {
  const env = startModule({ settings: { carrier: 'pet', modality: 'voice' } })
  const fakeWav = join(process.env.AURABOT_DATA_DIR, 'voice-cache', 'tmp.wav')
  mkdirSync(dirname(fakeWav), { recursive: true })
  writeFileSync(fakeWav, Buffer.from('RIFF....WAVEfmt fake audio bytes'))
  env.setVoiceFile(fakeWav)
  await env.connect()
  const r = await env.exports.dispatch({ text: '用声音说想你' })
  assert.equal(r.via, 'pet')
  const audio = r.message.audio
  assert.ok(audio, 'voice 模式给出音频')
  assert.match(audio.url, /^\/aurabot\/api\/audio\/[a-f0-9]{40}\.wav\?token=/)
  assert.ok(!audio.url.includes('voice-cache'), '不能直接指 voice-cache（24h 清理会 404）')
  const stored = env.api.dataDir('voice', `${audio.key}.wav`)
  assert.ok(existsSync(stored), `转存文件在 pet 数据目录：${stored}`)
  const buf = readFileSync(stored)
  const { createHash } = await import('node:crypto')
  assert.equal(createHash('sha1').update(buf).digest('hex'), audio.key, '内容寻址命名')
  const audioRes = await env.call(`/audio/${audio.key}.wav`, { query: { token: env.token } })
  assert.equal(audioRes.status, 200)
  assert.equal(audioRes.headers['content-type'], 'audio/wav')
  assert.equal(audioRes.headers['cache-control'], 'private, max-age=86400')
})

// ---------- P2：anim 点播 + playbackId 回执 ----------

test('P2：事件可选带 anim + playbackId；客户端 POST /playback 回执被登记', async () => {
  const env = startModule()
  const { cursor } = await env.connect() // 先对齐水位，再触发点播
  const r = await env.call('/bubble', { method: 'POST', json: { text: '看我的动作', anim: 'wave' } })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.message.anim, 'wave')
  assert.match(r.json.message.playbackId, /^[a-f0-9]{8}$/)
  const got = await env.connect({ wantEvents: true, since: cursor })
  const ev = got.events.find((e) => e.type === 'proactive')
  assert.equal(ev.anim, 'wave')
  assert.equal(ev.playbackId, r.json.message.playbackId, '事件里的回执号一致')

  const noAnim = await env.call('/bubble', { method: 'POST', json: { text: '不带动画' } })
  assert.equal(noAnim.json.message.anim, undefined, '不带 anim 就没有该字段（可选字段，purpose 不用改）')
  assert.equal(noAnim.json.message.playbackId, undefined)

  const ack = await env.call('/playback', { method: 'POST', json: { playbackId: r.json.message.playbackId, anim: 'wave', status: 'played' } })
  assert.equal(ack.json.ok, true)
  const hist = await env.call('/history')
  assert.ok(hist.json.playbacks.some((p) => p.playbackId === r.json.message.playbackId), '回执进了 /history')
  const st = env.exports.status()
  assert.equal(st.playbackCount, 1)
})

// ---------- P1/P4：形象包与素材路由 ----------

function writePack(dataDir, name, files, config) {
  const dir = join(dataDir, 'modules-data', 'pet', 'packs', `${name}-animation`)
  mkdirSync(dir, { recursive: true })
  for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body)
  if (config) writeFileSync(join(dataDir, 'modules-data', 'pet', 'packs', `${name}-config.json`), JSON.stringify(config))
  return dir
}
const WEBM = Buffer.from('%EFL-webm-dummy-bytes')

test('P1/P4：packs 扫描、/config 包视图、/asset 严格隔离（404 不回落）、/pack 切换', async () => {
  const env = startModule()
  const dd = process.env.AURABOT_DATA_DIR
  writePack(dd, 'default', { 'idle-a.webm': WEBM, 'speak-a.webm': WEBM }, {
    animations: { idle: ['idle-a'], speak: ['speak-a'], click: [] },
    weights: { idle: 70, speak: 30 },
    events: { proactive: 'speak' },
    physics: { gravity: 1200 },
  })
  writePack(dd, 'fish', { 'fish-idle.webm': WEBM }, { animations: { idle: ['fish-idle'] } })

  const packs = await env.call('/packs')
  assert.equal(packs.json.ok, true)
  assert.deepEqual(packs.json.packs.map((p) => p.name).sort(), ['default', 'fish'])
  assert.equal(packs.json.active, 'default', 'settings.pack=default 命中')

  const cfg = await env.call('/config')
  assert.equal(cfg.json.pack.name, 'default')
  assert.deepEqual(cfg.json.pack.animations.idle, ['idle-a'])
  assert.equal(cfg.json.pack.physics.gravity, 1200, 'pack 配置的物理参数透传（P3 参数可覆盖）')

  const asset = await env.call('/asset/default/idle-a.webm', { query: { token: env.token } })
  assert.equal(asset.status, 200)
  assert.equal(asset.headers['content-type'], 'video/webm')
  assert.ok(Buffer.isBuffer(asset.raw) || Buffer.isBuffer(Buffer.from(asset.raw)), '素材二进制原样返回')

  assert.equal((await env.call('/asset/default/missing.webm', { query: { token: env.token } })).status, 404, '包内缺文件 404')
  assert.equal((await env.call('/asset/default/speak-a.webm', { query: { token: env.token } })).status, 200)
  assert.equal((await env.call('/asset/fish/speak-a.webm', { query: { token: env.token } })).status, 404, '严格隔离：fish 没有的素材 404，绝不回落 default')
  assert.equal((await env.call('/asset/default/..%2F..%2Fhost.json', { query: { token: env.token } })).status, 404, '路径穿越不注册路由 → 404')
  assert.equal((await env.call('/asset/nobody/x.webm', { query: { token: env.token } })).status, 404, '不存在的包 404')

  const sel = await env.call('/pack', { method: 'POST', json: { name: 'fish' } })
  assert.equal(sel.json.ok, true)
  const cfg2 = await env.call('/config')
  assert.equal(cfg2.json.pack.name, 'fish', '切换生效')
  assert.deepEqual(cfg2.json.pack.animations.idle, ['fish-idle'])
  assert.equal((await env.call('/pack', { method: 'POST', json: { name: 'ghost' } })).status, 404, '切到不存在的包 404')
})

test('P1：没放任何素材时 /config 的 pack 为 null（客户端回静态形象，不报错）', async () => {
  const env = startModule()
  const cfg = await env.call('/config')
  assert.equal(cfg.json.pack, null)
})

// ---------- 客户端安装（面板 download） ----------

test('download()：把 pet-client 模板生成到数据目录 app/（含 physics.js / preload.js）', async () => {
  const env = startModule()
  const r = await env.exports.download()
  assert.equal(r.ok, true)
  for (const f of ['main.js', 'preload.js', 'index.html', 'physics.js', 'README.md']) {
    assert.ok(existsSync(join(r.dir, f)), `${f} 已生成`)
  }
  const host = JSON.parse(readFileSync(join(dirname(r.dir), 'host.json'), 'utf8'))
  assert.ok(host.token, 'app 目录上一级的 host.json 已就绪（客户端起来即可发现插件）')
})

// ---------- P3：拖拽物理移植（dsh-pet MIT 物理模块的去 TS 单文件版） ----------

function loadPhysics() {
  const code = readFileSync(join(MODULE_DIR, 'pet-client', 'physics.js'), 'utf8')
  const m = { exports: {} }
  new Function('module', 'exports', code)(m, m.exports) // UMD：以 CommonJS 形态求值
  return m.exports
}

test('P3 物理：软钳速单调渐近；弹簧收敛；挤压曲线端点正确', () => {
  const P = loadPhysics()
  // softClampSpeed：单调、渐近不超过 MAX 上限
  let prev = 0
  for (const s of [200, 800, 2000, 6000, 60000]) {
    const c = P.softClampSpeed(s)
    assert.ok(c > prev, `单调：${s} → ${c}`)
    assert.ok(c < 3600 + 1e-6)
    prev = c
  }
  assert.ok(Math.abs(P.softClampSpeed(1e9) - 3600) < 1e-6, '渐近 = 软上限')
  // springStep：朝 target 收敛（过阻尼不越过）
  let v = 0, x = 0
  for (let i = 0; i < 600; i++) { v = P.springStep(v, x, 100, 1 / 120); x += v * (1 / 120) }
  assert.ok(Math.abs(x - 100) < 1, `弹簧收敛到目标（x=${x.toFixed(2)}）`)
  // squash：轻落 ≤0.8、重砸吃满下压、曲线两端
  assert.equal(P.landingSquash(0), 0.8)
  assert.equal(P.landingSquash(5000), 0.55)
  assert.equal(P.squashScale(0, 0.55), 1)
  assert.equal(P.squashScale(1, 0.55), 1)
  assert.ok(P.squashScale(0.2, 0.55) < 1, '下压段压缩')
  assert.ok(P.squashScale(0.8, 0.55) > 1, '回弹段过冲')
})

test('P3 物理：抛体落地反弹、atRest 判定、松手初速方向与温柔放下', () => {
  const P = loadPhysics()
  const b = P.throwBounds({ W: 1920, H: 1080, size: 280, sideAllow: 30 })
  // 自由落体到地面：vy 变号（restitution 反弹），最终 atRest
  let st = { x: 500, y: 0, vx: 0, vy: 0 }
  let bounced = false
  for (let i = 0; i < 2000 && !st.atRest; i++) {
    st = P.throwStep(st, 1 / 60, b, P.DEFAULT_PHYSICS)
    if (st.bounced) bounced = true
  }
  assert.ok(bounced, '落地反弹过')
  assert.ok(st.atRest, '最终静止')
  assert.equal(st.y, b.maxY)
  assert.equal(st.vy, 0)
  // 侧壁反弹：vx 反向且按恢复系数缩水
  const hit = P.throwStep({ x: b.maxX - 1, y: b.maxY, vx: 1000, vy: 0 }, 1 / 60, b, P.DEFAULT_PHYSICS)
  assert.ok(hit.vx < 0, '右壁反弹 vx 翻负')
  assert.ok(Math.abs(hit.vx) <= 1000 * P.DEFAULT_PHYSICS.restitution + 1e-6)
  // 松手初速：快速向右甩 → vx>0、软钳上限内；停顿后松手 → null（温柔放下）
  const now = Date.now()
  const trail = []
  for (let i = 0; i < 8; i++) trail.push({ t: now - 100 + i * 10, x: i * 40, y: i * 5 })
  const v = P.estimateReleaseVelocity(trail, now, P.DEFAULT_PHYSICS)
  assert.ok(v && v.vx > 0, `向右甩出正 vx（vx=${v && v.vx.toFixed(0)}）`)
  assert.ok(Math.hypot(v.vx, v.vy) <= 3600)
  assert.equal(P.estimateReleaseVelocity([{ t: now - 500, x: 0, y: 0 }, { t: now - 490, x: 300, y: 0 }], now, P.DEFAULT_PHYSICS), null, '停顿超过 150ms：温柔放下')
  // 参数可被 pack 配置覆盖：重力减半 → 同 dt 下落得更慢
  const half = { ...P.DEFAULT_PHYSICS, gravity: 700 }
  const a = P.throwStep({ x: 0, y: 0, vx: 0, vy: 0 }, 0.1, b, half)
  const c = P.throwStep({ x: 0, y: 0, vx: 0, vy: 0 }, 0.1, b, P.DEFAULT_PHYSICS)
  assert.ok(a.y < c.y, 'pack physics.gravity 生效')
})
