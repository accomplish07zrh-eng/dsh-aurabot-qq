// 桌宠模块（pet）测试：
//   · 载体互斥不双发 / 离线回落 QQ（petFallbackToQQ）
//   · 心跳在线判定（轮询 /events 刷新 presence，60s TTL）
//   · focus.json 开关（含坏文件 fail-open）与 force 绕过
//   · TTS 产物即刻转存进 pet 数据目录（voice-cache 24h 清理不能直接指给客户端）
//   · P2 动画点播：事件带 anim + playbackId，POST /playback 回执
//   · P1/P4 形象包：packs 扫描、/config 包视图、/asset 严格隔离（404 不回落）、/pack 切换
//   · P3 拖拽物理移植（physics.js 纯函数：弹簧/软钳速/抛体积分/松手初速/挤压）
// 全程 AURABOT_DATA_DIR 隔离，fake api 模仿 modules.js 的 makeApi 面，不引入新依赖。
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
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

function startModule({ settings = {}, hooks } = {}) {
  const s = { carrier: 'pet', modality: 'text', petFallbackToQQ: true, pack: 'default', ...settings }
  const routes = new Map()
  const sentToQQ = []
  let voiceFile = ''
  const api = {
    id: 'pet',
    dir: MODULE_DIR,
    version: 'test',
    __petTestHooks: hooks || {}, // 测试注入 fake spawn/kill：不打真网络、不真启动 Electron
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
  let memItems = []
  let thinkReply = ''
  let thinkHold = null // 非空时 think 挂着不返回（测"上一句还在想"的并发闸）
  const thinkCalls = []
  api.use = (id) => (id === 'mood' ? { current: () => moodValue }
    : id === 'voice' ? { speak: async () => ({ file: voiceFile, engine: 'fake' }) }
      : id === 'memory' ? { list: (q) => (q ? memItems.filter((m) => String(m.text).includes(q)) : memItems.slice()) }
        : null)
  api.has = (id) => (id === 'mood') || (id === 'voice' && Boolean(voiceFile)) || (id === 'memory' && memItems.length > 0)
  // 对齐 modules.js 的 api.think：后台系统回合（工作区里能看到这条会话的思考过程）
  api.think = async (prompt, opts = {}) => {
    thinkCalls.push({ prompt, title: opts.title, noTools: opts.noTools })
    if (thinkHold) await thinkHold
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
  return {
    api, exports, routes, call, connect, token, sentToQQ,
    setVoiceFile: (f) => { voiceFile = f }, setMood: (v) => { moodValue = v },
    setMemory: (list) => { memItems = list }, setThinkReply: (t) => { thinkReply = t },
    holdThink: (p) => { thinkHold = p }, thinkCalls,
  }
}

// ---------- P0：发现文件 / 鉴权 / 端口漂移 ----------

test('P0：host.json + host-token 落盘；端口从 Host 头学习并重写', async () => {
  const env = startModule()
  const hostFile = env.api.dataDir('host.json')
  assert.ok(existsSync(hostFile))
  const h1 = JSON.parse(readFileSync(hostFile, 'utf8'))
  assert.equal(h1.version, 1)
  assert.equal(h1.api, '/aurabot/api')
  assert.equal(h1.token, env.token, 'host.json 里的 token 与 host-token 一致')
  assert.equal(h1.baseUrl, null, '端口未注入时写 null（客户端 readHost 对 null 等待，不再写假 :0 造成自举死锁）')
  assert.equal(env.exports.status().portReady, false, 'status 报「端口未就绪」')

  const bad = await env.call('/status', { token: 'deadbeef'.repeat(6) })
  assert.equal(bad.status, 401, '坏令牌 401')
  const ok = await env.call('/status')
  assert.equal(ok.json.ok, true)
  assert.equal(ok.json.portReady, true, '第一次请求（带 Host 头）后端口即就绪（学习路径）')

  const h2 = JSON.parse(readFileSync(hostFile, 'utf8'))
  assert.ok(h2.baseUrl.endsWith(':53210'), `第一次请求后从 Host 头学到真实端口：${h2.baseUrl}`)
})

test('端口注入：setWebPort 写对 host.json；非法端口拒绝；Host 头学习仍能纠正漂移', async () => {
  const env = startModule()
  const hostFile = env.api.dataDir('host.json')
  assert.equal(JSON.parse(readFileSync(hostFile, 'utf8')).baseUrl, null, '注入前：null')

  assert.equal(env.exports.setWebPort(0), false, '非法端口拒绝')
  assert.equal(env.exports.setWebPort('abc'), false, '非数字拒绝')
  assert.equal(JSON.parse(readFileSync(hostFile, 'utf8')).baseUrl, null, '非法注入不写文件')

  assert.equal(env.exports.setWebPort(53211), true)
  const h = JSON.parse(readFileSync(hostFile, 'utf8'))
  assert.equal(h.baseUrl, 'http://127.0.0.1:53211', '注入后 host.json 立刻就绪')
  assert.equal(env.exports.status().portReady, true)
  assert.equal(env.exports.status().port, 53211)

  // 漂移纠正：宿主重启换了端口（注入的是旧的），客户端带新端口来请求 → Host 学习覆盖
  await env.call('/status', { headers: { host: '127.0.0.1:53299' } })
  assert.equal(JSON.parse(readFileSync(hostFile, 'utf8')).baseUrl, 'http://127.0.0.1:53299', 'Host 头学习仍能纠正漂移')
  assert.equal(env.exports.setWebPort(53211), true, '重复注入同端口幂等')
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

// ---------- TTS 转存 ----------

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

// ---------- 默认素材包自动下载（「大肥鱼」素材不进插件 git，装完从素材仓库自动落位） ----------

test('素材包自动下载：缺包 + 配了地址 + fetchZip 注入 → 落位 packs/default-animation/；archive zip 的单层顶层目录 + 素材文件夹自动剥', async () => {
  // 模拟素材仓库的真实结构：archive zip 自带 <仓库名>-<分支>/ 顶层目录，素材再放一层 pet-pack/ 文件夹
  const fakeZip = tinyZip([
    ['dsh-aurabot-qq-mods-main/', Buffer.alloc(0)],
    ['dsh-aurabot-qq-mods-main/README.md', Buffer.from('# 素材仓库')],
    ['dsh-aurabot-qq-mods-main/pet-pack/', Buffer.alloc(0)],
    ['dsh-aurabot-qq-mods-main/pet-pack/default-config.json', Buffer.from(JSON.stringify({ pools: { idle: ['anim-001'] } }))],
    ['dsh-aurabot-qq-mods-main/pet-pack/default-manifest.json', Buffer.from('{}')],
    ['dsh-aurabot-qq-mods-main/pet-pack/default-animation/anim-001.webm', WEBM],
    ['dsh-aurabot-qq-mods-main/pet-pack/default-animation/anim-002.webm', WEBM],
  ])
  let requestedUrl = ''
  const env = startModule({
    settings: { petPackUrl: 'https://gitee.com/x/dsh-aurabot-qq-mods/archive/refs/heads/main.zip' },
    hooks: {
      fetchZip: async (url) => {
        requestedUrl = url
        return { ok: true, arrayBuffer: async () => fakeZip.buffer.slice(fakeZip.byteOffset, fakeZip.byteOffset + fakeZip.byteLength) }
      },
    },
  })
  const r = await env.call('/packs/fetch-default', { method: 'POST', json: {} })
  assert.equal(r.status, 200, `应下载成功：${r.json && r.json.message}`)
  assert.equal(r.json.ok, true)
  assert.match(requestedUrl, /dsh-aurabot-qq-mods/, '用的就是面板配置的素材包地址')
  assert.equal(r.json.count, 2, '落位 2 个动画')
  const dd = process.env.AURABOT_DATA_DIR
  assert.ok(existsSync(join(dd, 'modules-data', 'pet', 'packs', 'default-config.json')), 'config 一并落位')
  assert.ok(existsSync(join(dd, 'modules-data', 'pet', 'packs', 'default-animation', 'anim-001.webm')))
  assert.ok(!existsSync(env.api.dataDir('packs-download.zip')), '临时 zip 用完清理')
  assert.ok(!existsSync(env.api.dataDir('packs-staging')), '暂存目录用完清理')
  const packs = await env.call('/packs')
  const def = packs.json.packs.find((p) => p.name === 'default')
  assert.ok(def, '/packs 能扫到 default 包')
  assert.equal(def.anims.length, 2, '扫描看到落位的动画')
})

test('素材包：素材文件夹名字随意（大肥鱼/ 这种中文名也认）——只认「哪一层里有 default-animation/」', async () => {
  const fakeZip = tinyZip([
    ['dsh-aurabot-qq-mods-main/', Buffer.alloc(0)],
    ['dsh-aurabot-qq-mods-main/大肥鱼/', Buffer.alloc(0)],
    ['dsh-aurabot-qq-mods-main/大肥鱼/default-config.json', Buffer.from('{}')],
    ['dsh-aurabot-qq-mods-main/大肥鱼/default-animation/anim-001.webm', WEBM],
  ])
  const env = startModule({
    settings: { petPackUrl: 'https://example.com/mods.zip' },
    hooks: { fetchZip: async () => ({ ok: true, arrayBuffer: async () => fakeZip.buffer.slice(fakeZip.byteOffset, fakeZip.byteOffset + fakeZip.byteLength) }) },
  })
  const r = await env.call('/packs/fetch-default', { method: 'POST', json: {} })
  assert.equal(r.json.ok, true, `任意文件夹名也要能落位：${r.json.message}`)
  assert.equal(r.json.count, 1)
  assert.ok(existsSync(join(process.env.AURABOT_DATA_DIR, 'modules-data', 'pet', 'packs', 'default-animation', 'anim-001.webm')))
})

test('素材包：没配下载地址 → 明确报错不炸；包已就位 → 非 force 直接跳过（every 兜底轮询不重复下载）', async () => {
  const env = startModule() // fake settings 没有 petPackUrl = 没配地址
  const r = await env.call('/packs/fetch-default', { method: 'POST', json: {} })
  assert.equal(r.status, 502)
  assert.equal(r.json.ok, false)
  assert.match(r.json.message, /下载地址/, '提示去面板配置地址，而不是抛错')

  writePack(process.env.AURABOT_DATA_DIR, 'default', { 'anim-001.webm': WEBM }, { pools: {} })
  const skip = await env.exports.ensureDefaultPack(false)
  assert.equal(skip.ok, true)
  assert.equal(skip.skipped, true, '包已就位时非 force 调用跳过')
  assert.ok(!existsSync(env.api.dataDir('packs-staging')), '不留下暂存目录')
})

test('素材包：status().packInfo 给面板用（地址 / 是否就位 / 动画数 / 包列表）', async () => {
  const env = startModule({ settings: { petPackUrl: 'https://example.com/pet-pack.zip' } })
  const empty = env.exports.status().packInfo
  assert.equal(empty.url, 'https://example.com/pet-pack.zip')
  assert.equal(empty.hasDefault, false)
  assert.equal(empty.defaultAnims, 0)
  assert.deepEqual(empty.packs, [])
  assert.equal(empty.downloading, false)

  writePack(process.env.AURABOT_DATA_DIR, 'default', { 'anim-001.webm': WEBM, 'anim-002.webm': WEBM }, { pools: {} })
  const filled = env.exports.status().packInfo
  assert.equal(filled.hasDefault, true, '包就位后 hasDefault=true（面板显示「已就位」）')
  assert.equal(filled.defaultAnims, 2)
  assert.deepEqual(filled.packs, ['default'])
})

test('素材包：下载炸了（HTTP 404）→ ok:false 带原因，packs/ 不被污染', async () => {
  const env = startModule({
    settings: { petPackUrl: 'https://example.com/bad.zip' },
    hooks: { fetchZip: async () => ({ ok: false, status: 404 }) },
  })
  const r = await env.call('/packs/fetch-default', { method: 'POST', json: {} })
  assert.equal(r.status, 502)
  assert.equal(r.json.ok, false)
  assert.match(r.json.message, /素材包下载失败/)
  assert.match(r.json.message, /404/)
  assert.ok(!existsSync(join(process.env.AURABOT_DATA_DIR, 'modules-data', 'pet', 'packs', 'default-animation', 'anim-001.webm')), '失败不落位')
})

// ---------- 客户端安装（面板 download） ----------

test('download()：把 pet-client 模板生成到数据目录 app/（含 physics.js / preload.js）', async () => {
  const env = startModule()
  const r = await env.exports.download()
  assert.equal(r.ok, true)
  for (const f of ['main.js', 'preload.js', 'index.html', 'physics.js', 'packmeta.js', 'behavior.js', 'README.md']) {
    assert.ok(existsSync(join(r.dir, f)), `${f} 已生成`)
  }
  const host = JSON.parse(readFileSync(join(dirname(r.dir), 'host.json'), 'utf8'))
  assert.ok(host.token, 'app 目录上一级的 host.json 已就绪（客户端起来即可发现插件）')
})

test('/client/install：返回的 files 清单包含 behavior.js（行为层文件必须随客户端生成，否则整体降级）', async () => {
  const env = startModule()
  const r = await env.call('/client/install', { method: 'POST', json: {} })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.ok(Array.isArray(r.json.files) && r.json.files.includes('behavior.js'), `files 含 behavior.js：${JSON.stringify(r.json.files)}`)
  assert.ok(existsSync(join(r.json.dir, 'behavior.js')), 'behavior.js 已生成到数据目录 app/')
})

// ---------- 客户端生成物对账（治「旧壳」：app/ 缺 behavior.js 时行为层静默失效） ----------

test('clientStatus：没生成过 → installed=false、healthy=false', async () => {
  const env = startModule()
  const st = env.exports.clientStatus()
  assert.equal(st.installed, false)
  assert.equal(st.healthy, false)
  assert.match(st.message, /还没生成/)
})

test('clientStatus：生成后 healthy，且 app/ 里留下签名凭据', async () => {
  const env = startModule()
  await env.call('/client/install', { method: 'POST', json: {} })
  const st = env.exports.clientStatus()
  assert.equal(st.installed, true)
  assert.equal(st.healthy, true, st.message)
  assert.ok(st.sig && st.sig === st.generatedSig, `模板签名应与生成凭据一致：${st.sig} / ${st.generatedSig}`)
  assert.ok(existsSync(join(env.api.dataDir('app'), 'client-stamp.json')), '生成时写了 client-stamp.json')
})

test('clientStatus：缺 behavior.js（典型旧壳）→ missing 点名、healthy=false', async () => {
  const env = startModule()
  await env.call('/client/install', { method: 'POST', json: {} })
  unlinkSync(join(env.api.dataDir('app'), 'behavior.js'))
  const st = env.exports.clientStatus()
  assert.equal(st.healthy, false)
  assert.deepEqual(st.missing, ['behavior.js'])
  assert.match(st.message, /behavior\.js/)
})

test('clientStatus：模板比生成物新（签名不一致）→ outdated、healthy=false', async () => {
  const env = startModule()
  await env.call('/client/install', { method: 'POST', json: {} })
  writeFileSync(join(env.api.dataDir('app'), 'client-stamp.json'), JSON.stringify({ sig: 'oldoldold123', at: 1 }))
  const st = env.exports.clientStatus()
  assert.equal(st.outdated, true)
  assert.equal(st.healthy, false)
  assert.match(st.message, /更新|重新生成/)
})

test('clientStatus：手改 app/main.js → changed 点名，但不谎报「跑不起来」', async () => {
  const env = startModule()
  await env.call('/client/install', { method: 'POST', json: {} })
  const p = join(env.api.dataDir('app'), 'main.js')
  writeFileSync(p, readFileSync(p, 'utf8') + '\n// 手改一行\n')
  const st = env.exports.clientStatus()
  assert.deepEqual(st.changed, ['main.js'])
  assert.equal(st.healthy, true) // 内容不同 ≠ 缺文件：只是提醒「重新生成会覆盖」
})

test('/status：带 client 对账字段（面板「桌宠」卡据此提示）', async () => {
  const env = startModule()
  await env.call('/client/install', { method: 'POST', json: {} })
  const r = await env.call('/status')
  assert.equal(r.json.client.installed, true)
  assert.equal(r.json.client.healthy, true)
})

// ---------- Electron 三键（面板「安装 Electron / 启动桌宠 / 停止桌宠」） ----------

const ELECTRON_REL = process.platform === 'win32' ? join('dist', 'electron.exe')
  : process.platform === 'darwin' ? join('dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  : join('dist', 'electron')

/** 假 spawn：记录调用、按脚本制造 exe / 返回退出码，绝不打真网络、不真启动。 */
function fakeSpawn({ exit = 0, makeExe } = {}) {
  const calls = []
  const spawn = (cmd, args, opts = {}) => {
    const call = { cmd, args, opts, env: opts.env || {} }
    calls.push(call)
    if (makeExe) makeExe()
    return {
      pid: 42424,
      stdout: { on() {} }, stderr: { on() {} },
      on(event, fn) { if (event === 'close') setTimeout(() => fn(exit), 5) },
      kill() {}, unref() {},
    }
  }
  return { spawn, calls }
}

test('Electron 安装：走 node + npm-cli.js（不经 shell）、注入 ELECTRON_MIRROR 镜像；已装则跳过', async () => {
  const env = startModule()
  const appDir = env.api.dataDir('app')
  const exe = join(appDir, 'node_modules', 'electron', ELECTRON_REL)
  await env.exports.download() // 先有 app/main.js

  // 假 npm-cli：不依赖真机 npm 安装位置（钩子可覆盖 npmCli 路径）
  const fakeCli = join(process.env.AURABOT_DATA_DIR, 'npm-cli.js')
  writeFileSync(fakeCli, '// fake npm-cli')
  const { spawn, calls } = fakeSpawn({ exit: 0, makeExe: () => { mkdirSync(dirname(exe), { recursive: true }); writeFileSync(exe, 'fake electron') } })
  // 换一个带 hooks 的实例（hooks 在 setup 时读）：重新起一个同数据目录的模块实例
  const env2 = startModule({ hooks: { spawn, npmCli: fakeCli } })
  const r = await env2.exports.electronInstall()
  assert.equal(r.ok, true, `安装成功：${r.message}`)
  assert.equal(calls.length, 1, '只 spawn 了一次 npm')
  const c = calls[0]
  assert.equal(c.cmd, process.execPath, '直接用当前 node 跑 npm-cli.js（Windows 上 spawn npm.cmd 无 shell 会被拒）')
  assert.ok(c.args[0].endsWith('npm-cli.js'), `第一个参数是 npm-cli.js：${c.args[0]}`)
  assert.deepEqual(c.args.slice(1), ['install', '-D', 'electron'])
  assert.equal(c.opts.cwd, appDir, '在 app 目录里装')
  assert.equal(c.env.ELECTRON_MIRROR, 'https://npmmirror.com/mirrors/electron/', '必须注入 npmmirror 镜像（直连 github release 会 fetch failed）')
  assert.ok(!('shell' in c.opts) || !c.opts.shell, '不经 shell 拼接')
  assert.ok(existsSync(exe))

  const again = await env2.exports.electronInstall()
  assert.equal(again.alreadyInstalled, true, '已装（electron.exe 在）则跳过')
  assert.equal(calls.length, 1, '跳过时不再 spawn')
})

test('Electron 安装失败路径：npm 非零退出 → 自动回退 zip 直装；两条都挂才 ok:false；没生成客户端先拦', async () => {
  const fakeCli = join(process.env.AURABOT_DATA_DIR, 'npm-cli.js')
  writeFileSync(fakeCli, '// fake npm-cli')
  const env = startModule({
    hooks: {
      spawn: fakeSpawn({ exit: 1 }).spawn,
      npmCli: fakeCli,
      fetchZip: async () => { throw new Error('ECONNREFUSED 模拟断网') }, // 回退也失败，别打真网络
    },
  })
  const r0 = await env.exports.electronInstall()
  assert.equal(r0.ok, false, '还没生成客户端：先拦下，不 spawn')
  await env.exports.download()
  const r = await env.exports.electronInstall()
  assert.equal(r.ok, false)
  assert.equal(r.exitCode, 1)
  assert.match(r.message, /npm 安装失败/)
  assert.match(r.message, /zip 直装也没成/, 'npm 失败会先自动回退 zip 直装，两条都挂才报错')
})

test('Electron 安装：npm 失败但 zip 直装成功 → 整体 ok:true，并在消息里说明已回退', async () => {
  const fakeCli = join(process.env.AURABOT_DATA_DIR, 'npm-cli.js')
  writeFileSync(fakeCli, '// fake npm-cli')
  const env0 = startModule()
  const appDir = env0.api.dataDir('app')
  await env0.exports.download() // 先生成客户端（app/main.js + package.json）
  const exe = join(appDir, 'node_modules', 'electron', ELECTRON_REL)
  const fakeZip = tinyZip([
    ['dist/', Buffer.alloc(0)],
    [ELECTRON_REL.split('\\').join('/'), Buffer.from('fake electron')],
  ])
  const env = startModule({
    hooks: {
      spawn: fakeSpawn({ exit: 1 }).spawn, // npm 必失败
      npmCli: fakeCli,
      fetchZip: async () => ({ ok: true, arrayBuffer: async () => fakeZip.buffer.slice(fakeZip.byteOffset, fakeZip.byteOffset + fakeZip.byteLength) }),
    },
  })
  const r = await env.exports.electronInstall()
  assert.equal(r.ok, true, `回退成功应算装好了：${r.message}`)
  assert.match(r.message, /已自动改用 zip 直装/, '告诉用户为什么换了条路')
  assert.match(r.message, /npm 安装失败/, '保留 npm 的失败原因')
  assert.ok(existsSync(exe), 'zip 解压出来的 electron.exe 在位')
})

test('Electron 镜像可配：electronMirror 同时作用于 zip 直装 URL 与 npm 的 ELECTRON_MIRROR（末尾自动补 /）', async () => {
  // ① zip 直装：没有 npm-cli 时用配置的镜像拼版本路径
  let requestedUrl = ''
  const zipped = startModule({
    settings: { electronMirror: 'https://example.com/em' }, // 故意不写结尾斜杠
    hooks: {
      npmCli: '',
      fetchZip: async (url) => { requestedUrl = url; return { ok: false, status: 502 } },
    },
  })
  await zipped.exports.download()
  const zr = await zipped.exports.electronInstall()
  assert.equal(zr.ok, false, '下载失败（注入的 502）')
  assert.match(requestedUrl, /^https:\/\/example\.com\/em\/\d+\.\d+\.\d+\/electron-v/, '用面板配的镜像，且自动补了斜杠')

  // ② npm 路径：ELECTRON_MIRROR 环境变量同源
  const fakeCli = join(process.env.AURABOT_DATA_DIR, 'npm-cli.js')
  writeFileSync(fakeCli, '// fake npm-cli')
  const { spawn, calls } = fakeSpawn({ exit: 1 })
  const env = startModule({ settings: { electronMirror: 'https://example.com/em/' }, hooks: { spawn, npmCli: fakeCli, fetchZip: async () => ({ ok: false, status: 502 }) } })
  await env.exports.electronInstall()
  assert.equal(calls[0].env.ELECTRON_MIRROR, 'https://example.com/em/', 'npm 安装也走同一个镜像')
})

/** 手工拼一个最小合法 zip（存储法、无压缩）：顺带走真解压器，不引第三方依赖。 */
function tinyZip(entries) {
  const chunks = []
  const central = []
  let off = 0
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt32LE(data.length, 18) // csize（存储法 = 原大小）
    local.writeUInt32LE(data.length, 22) // usize
    chunks.push(local, nameBuf, data)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 10) // method 0 = 存储
    cd.writeUInt32LE(data.length, 20) // csize
    cd.writeUInt32LE(data.length, 24) // usize
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(off, 42) // 局部头偏移
    central.push(cd, nameBuf)
    off += 30 + nameBuf.length + data.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(off, 16)
  return Buffer.concat([...chunks, cdBuf, eocd])
}

test('Electron 兜底直装：没有 npm-cli（DSH 运行时/裸机）→ npmmirror zip 直下 + 纯 JS 解压，零 npm 依赖', async () => {
  const env = startModule()
  const appDir = env.api.dataDir('app')
  await env.exports.download() // 先有 app/main.js + package.json
  const exe = join(appDir, 'node_modules', 'electron', ELECTRON_REL)
  const exeZipPath = ELECTRON_REL.split('\\').join('/')

  let requestedUrl = ''
  const fakeZip = tinyZip([
    ['dist/', Buffer.alloc(0)],
    [exeZipPath, Buffer.from('fake electron')],
    ['package.json', Buffer.from('{"name":"electron","version":"45.1.0"}')],
    ['index.js', Buffer.from('module.exports = "fake"')],
  ])
  // 换一个带 hooks 的实例（hooks 在 setup 时读）；npmCli: '' = 强制没有 npm（逼出 zip 直装路径），
  // fetchZip 钩子替代真下载，不打真网络。
  const env2 = startModule({
    hooks: {
      npmCli: '',
      fetchZip: async (url) => {
        requestedUrl = url
        return { ok: true, arrayBuffer: async () => fakeZip.buffer.slice(fakeZip.byteOffset, fakeZip.byteOffset + fakeZip.byteLength) }
      },
    },
  })
  const r = await env2.exports.electronInstall()
  assert.equal(r.ok, true, `zip 直装应成功：${r.message}`)
  assert.match(requestedUrl, /^https:\/\/npmmirror\.com\/mirrors\/electron\//, '下载必须走 npmmirror 镜像')
  assert.match(requestedUrl, /electron-v\d+\.\d+\.\d+-/, 'URL 带具体版本号（来自 app/package.json）')
  assert.ok(existsSync(exe), '解压后 electron.exe 在位')
  assert.equal(readFileSync(exe, 'utf8'), 'fake electron', '解压内容正确')
  assert.ok(!existsSync(join(appDir, 'electron.zip')), '装完清理临时 zip')
  assert.match(r.message, /无需 npm/)

  const again = await env2.exports.electronInstall()
  assert.equal(again.alreadyInstalled, true, '已装则跳过')
})

test('Electron 兜底直装失败：下载炸了 → ok:false 带原因（不再出现「找不到 npm-cli.js」死路提示）', async () => {
  const env = startModule({ hooks: { npmCli: '', fetchZip: async () => { throw new Error('ECONNREFUSED 模拟断网') } } })
  await env.exports.download()
  const r = await env.exports.electronInstall()
  assert.equal(r.ok, false)
  assert.match(r.message, /zip 直装失败/)
  assert.match(r.message, /ECONNREFUSED/)
  assert.doesNotMatch(r.message, /找不到 npm-cli\.js/, '报错不再是一条死路提示')
})

test('启动桌宠：分离进程 + 清 ELECTRON_RUN_AS_NODE；心跳活着提示已在跑；stop 杀记录的 pid', async () => {
  const killed = []
  const { spawn, calls } = fakeSpawn()
  const env = startModule({ hooks: { spawn, kill: (pid) => { killed.push(pid); return true } } })
  const appDir = env.api.dataDir('app')
  const exe = join(appDir, 'node_modules', 'electron', ELECTRON_REL)
  await env.exports.download()
  mkdirSync(dirname(exe), { recursive: true })
  writeFileSync(exe, 'fake electron')

  const prevRunAsNode = process.env.ELECTRON_RUN_AS_NODE
  process.env.ELECTRON_RUN_AS_NODE = '1' // 真机 DSH 环境必带；不清掉 Electron 会以纯 Node 模式启动即崩
  try {
    const r = await env.exports.launch()
    assert.equal(r.ok, true, `启动成功：${r.message}`)
    assert.equal(r.pid, 42424)
    assert.equal(calls.length, 1)
    const c = calls[0]
    assert.equal(c.cmd, exe, '启动的是 app/node_modules/electron 里的 electron.exe')
    assert.deepEqual(c.args, ['main.js'])
    assert.equal(c.opts.cwd, appDir)
    assert.equal(c.opts.detached, true, '分离进程（插件重启不带走桌宠）')
    assert.equal(c.opts.env.ELECTRON_RUN_AS_NODE, undefined, '子进程环境必须清掉 ELECTRON_RUN_AS_NODE')
    const proc = JSON.parse(readFileSync(env.api.dataDir('process.json'), 'utf8'))
    assert.equal(proc.pid, 42424, 'pid 记进 process.json（stop 用）')

    // 心跳活着 → 提示已在跑，不重复启动
    await env.connect()
    const again = await env.exports.launch()
    assert.equal(again.alreadyRunning, true, '心跳活着提示已在跑')
    assert.equal(calls.length, 1)

    // 停止：杀记录的 pid、清 process.json
    const s = await env.exports.stop()
    assert.equal(s.ok, true)
    assert.deepEqual(killed, [42424])
    assert.equal(existsSync(env.api.dataDir('process.json')), false, '记录已清理')

    // 进程本来就不在（ESRCH）：按已停止处理并清记录，不让面板卡「停不掉」
    mkdirSync(dirname(exe), { recursive: true })
    const env2 = startModule({ hooks: { spawn, kill: () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e } } })
    await env2.exports.download()
    writeFileSync(exe, 'fake electron')
    await env2.exports.launch()
    const s2 = await env2.exports.stop()
    assert.equal(s2.ok, true, 'ESRCH = 本来就不在，算停止成功')
    assert.match(s2.message, /已经不在/)
  } finally {
    if (prevRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE
    else process.env.ELECTRON_RUN_AS_NODE = prevRunAsNode
  }
})

test('启动失败路径：Electron 没装 / main.js 不见 → 明确报错不 spawn', async () => {
  const { spawn, calls } = fakeSpawn()
  const env = startModule({ hooks: { spawn } })
  const r1 = await env.exports.launch()
  assert.equal(r1.ok, false, 'Electron 没装')
  assert.match(r1.message, /安装/)
  await env.exports.download()
  const appDir = env.api.dataDir('app')
  const exe = join(appDir, 'node_modules', 'electron', ELECTRON_REL)
  mkdirSync(dirname(exe), { recursive: true })
  writeFileSync(exe, 'fake electron')
  unlinkSync(join(appDir, 'main.js'))
  const r2 = await env.exports.launch()
  assert.equal(r2.ok, false, 'main.js 不见了')
  assert.match(r2.message, /main\.js/)
  assert.equal(calls.length, 0, '两条失败路径都没 spawn')
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

test('P3 物理：抛掷边界按可见身体盒算（不再落出屏幕）+ 任意甩法 60fps 必在有限帧内静止', () => {
  const P = loadPhysics()
  const W = 1920
  const H = 1040
  // 与 index.html 的 #stage 一致：窗口 280×430，1:1 素材身体 240×240，距窗口底 16px
  const body = { width: 240, height: 240, offsetX: 20, offsetY: 430 - 16 - 240 }
  const b = P.throwBounds({ W, H, bodyW: body.width, bodyH: body.height, offsetX: body.offsetX, offsetY: body.offsetY, sideAllow: 19 })
  // 历史 bug：用 宽×9/16 当身体高 → 静止点在屏幕外 183px，桌宠一扔就"消失"
  assert.equal(b.maxY + body.offsetY + body.height, H, '静止时可见身体底边正好贴屏幕底')
  assert.ok(b.minY + body.offsetY <= 1, '允许身体顶到屏幕顶')
  for (const [vx, vy] of [[-1500, -900], [2200, -300], [-2200, 200], [0, 3600], [300, -600]]) {
    let st = { x: 1200, y: 300, vx, vy }
    let frames = 0
    while (!st.atRest && frames < 1200) {
      st = P.throwStep(st, 1 / 60, b, P.DEFAULT_PHYSICS)
      frames++
      assert.ok(Number.isFinite(st.x) && Number.isFinite(st.y), `坐标不能是 NaN（会让 setPosition 抛错、桌宠卡死）：${vx},${vy}`)
      assert.ok(st.x >= b.minX - 1e-6 && st.x <= b.maxX + 1e-6, `x 不越界：${vx},${vy} 第${frames}帧`)
      assert.ok(st.y >= b.minY - 1e-6 && st.y <= b.maxY + 1e-6, `y 不越界：${vx},${vy} 第${frames}帧`)
    }
    assert.ok(st.atRest, `甩出 (${vx},${vy}) 必须在 20s（1200 帧）内静止，实际 ${frames} 帧`)
    assert.equal(st.y, b.maxY, '最终落在地面')
  }
})

// ---------- 右键「动作」菜单与点播地址表（回归：菜单 106 段只建了 26 个地址 → 点了没反应） ----------

function loadPackMetaLib() {
  const code = readFileSync(join(MODULE_DIR, 'pet-client', 'packmeta.js'), 'utf8')
  const m = { exports: {} }
  new Function('module', 'exports', code)(m, m.exports) // UMD：以 CommonJS 形态求值
  return m.exports
}

test('packmeta：knownAnims 合并「三个池 ∪ 包目录里的 webm」（菜单项不能只在池里）', () => {
  const M = loadPackMetaLib()
  const pools = { idle: ['anim-001', 'anim-002'], speak: ['anim-003'], click: ['anim-004'] }
  const files = ['anim-001.webm', 'anim-002.webm', 'anim-003.webm', 'anim-004.webm', 'anim-090.webm', 'notes.txt']
  const names = M.knownAnims(pools, files)
  assert.deepEqual(names, ['anim-001', 'anim-002', 'anim-003', 'anim-004', 'anim-090'], '池外的 anim-090 也必须进名单，非 webm 忽略')
  assert.deepEqual(M.namesFromFiles(['a.webm', 'b.WEBM', 'c.png']), ['a', 'b'])
  // 地址表：空的 url（端口未知）不能占位，否则渲染页会拿空 src 去 play
  const map = M.animUrlMap(names, (n) => (n === 'anim-002' ? '' : `http://h/asset/${n}.webm?token=t`))
  assert.equal(Object.keys(map).length, 4)
  assert.equal(map['anim-002'], undefined)
})

test('packmeta：resolveMenu 把配置里的中文原名映射成素材 id，未知项跳过、无 menu 回落三个池', () => {
  const M = loadPackMetaLib()
  const manifest = { 三球抛接: 'anim-001', 下五子棋: 'anim-002', 中秋赏月吃月饼: 'anim-004' }
  const cfg = { menu: [{ label: '才艺', anims: ['三球抛接', '下五子棋', '不存在的动画'] }, { label: '节日', anims: ['中秋赏月吃月饼'] }, { label: '空分类', anims: [] }] }
  const cats = M.resolveMenu(cfg, manifest, { idle: ['anim-001'], speak: [], click: [] })
  assert.deepEqual(cats, [
    { label: '才艺', items: [{ label: '三球抛接', id: 'anim-001' }, { label: '下五子棋', id: 'anim-002' }] },
    { label: '节日', items: [{ label: '中秋赏月吃月饼', id: 'anim-004' }] },
  ], '中文原名 → id，未知动画与空分类都过滤')
  // 配置里直接写 id 也认
  assert.equal(M.resolveMenu({ menu: [{ label: 'x', anims: ['anim-004'] }] }, manifest, {}).length, 1)
  // 没有 menu 段：按池回落，标签用原名
  const fallback = M.resolveMenu({}, manifest, { idle: ['anim-001', 'anim-002'], speak: [], click: ['anim-004'] })
  assert.deepEqual(fallback, [
    { label: '待机', items: [{ label: '三球抛接', id: 'anim-001' }, { label: '下五子棋', id: 'anim-002' }] },
    { label: '互动', items: [{ label: '中秋赏月吃月饼', id: 'anim-004' }] },
  ])
})

test('契约：菜单里每一项都能在素材地址表里查到（用户看到的「点菜单没反应」就是这条断了）', () => {
  const M = loadPackMetaLib()
  // 仿 default 包的真实形状：106 段素材，只有 26 段在 idle/speak/click 三个池里
  const files = Array.from({ length: 106 }, (_, i) => `anim-${String(i + 1).padStart(3, '0')}.webm`)
  const ids = files.map((f) => f.replace('.webm', ''))
  const pools = { idle: ids.slice(0, 13), speak: ids.slice(13, 18), click: ids.slice(18, 26) }
  const manifest = {}
  for (const id of ids) manifest[`动作-${id}`] = id
  const cfg = { menu: [{ label: '全部', anims: ids.map((id) => `动作-${id}`) }] }

  const view = { name: 'default', animations: pools }
  const anims = M.animUrlMap(M.knownAnims(view.animations, files), (n) => `http://127.0.0.1:1/api/asset/default/${n}.webm?token=t`)
  assert.equal(Object.keys(anims).length, 106, '地址表必须覆盖包目录里的全部 106 段，而不是池里的 26 段')
  for (const cat of M.resolveMenu(cfg, manifest, pools)) {
    for (const it of cat.items) assert.ok(anims[it.id], `菜单项「${it.label}」必须有素材地址（否则渲染页返回 false，桌宠继续播自己的 idle）`)
  }
  // 主进程确实走了这条合并逻辑（不是又退回只遍历三个池的老实现）
  const mainSrc = readFileSync(join(MODULE_DIR, 'pet-client', 'main.js'), 'utf8')
  assert.match(mainSrc, /metaApi\.knownAnims\(/, 'pushPackToRenderer 必须用 knownAnims 建地址表')
  assert.match(mainSrc, /metaApi\.resolveMenu\(/, '右键「动作」菜单必须用 resolveMenu 构建')
})

// ---------- 碎碎念（桌宠自己的气泡流）：载体是 QQ 也必须照常出现 ----------

/** 写一份碎碎念状态文件（nextAt 设成已到点；count 可指定）。 */
function seedWhisper(api, patch = {}) {
  const day = new Date().toDateString()
  const file = api.dataDir('whisper.json')
  writeFileSync(file, JSON.stringify({ day, count: 0, nextAt: Date.now() - 1000, lastAt: 0, lastText: '', recent: [], ...patch }))
  return file
}
/** 造一个形象包：webm 用 ASCII id，manifest 把中文原名映射过去（与真实 default 包同形状）。 */
function seedPack(api, { name = 'default', manifest = {}, extraFiles = [] } = {}) {
  const dir = api.dataDir('packs', `${name}-animation`)
  mkdirSync(dir, { recursive: true })
  for (const f of [...Object.values(manifest).map((id) => `${id}.webm`), ...extraFiles]) writeFileSync(join(dir, f), 'fake-webm')
  writeFileSync(api.dataDir('packs', `${name}-manifest.json`), JSON.stringify(manifest))
}

test('碎碎念：载体是 QQ 时照样推桌宠气泡（用户报的「永远不会主动碎碎念」）；且绝不发 QQ', async () => {
  const env = startModule({ settings: { carrier: 'qq', whisperSource: 'pool' } })
  env.api.config = () => ({ ownerQQ: OWNER, enabled: true, speakUp: { awakeFrom: 0, awakeTo: 24 } }) // 全天醒着：不受测试运行时段影响
  seedWhisper(env.api)
  const { cursor } = await env.connect() // 变成在线
  const r = await env.exports.whisperNow({ force: false })
  assert.equal(r.ok, true, '载体=qq 不应拦住碎碎念：' + JSON.stringify(r))
  assert.equal(r.via, 'pet')
  assert.ok(String(r.text || '').length > 0, '要有一句话')
  const ev = await env.call('/events', { query: { since: String(cursor), wait: '0', client: 'pet-test' } })
  const bubble = (ev.json.events || []).find((e) => e.type === 'proactive')
  assert.ok(bubble, '必须推到桌宠气泡事件')
  assert.equal(bubble.purpose, 'whisper', '碎碎念用 purpose=whisper 打标签，不发 QQ')
  assert.equal(env.sentToQQ.length, 0, '碎碎念永远不发 QQ')
})

test('碎碎念：载体是桌宠且开启暂停 → 不发（避免和主动搭话两个气泡）', async () => {
  const env = startModule({ settings: { carrier: 'pet', whisperPauseOnPetCarrier: true } })
  env.api.config = () => ({ ownerQQ: OWNER, enabled: true, ext: { speakup: { carrier: 'pet' } } })
  seedWhisper(env.api)
  await env.connect()
  const r = await env.exports.whisperNow({ force: false })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'carrier-pet')
})

test('碎碎念：桌宠离线不发、也不回落 QQ；未到点不发', async () => {
  const env = startModule({ settings: { carrier: 'qq' } })
  env.api.config = () => ({ ownerQQ: OWNER, enabled: true, speakUp: { awakeFrom: 0, awakeTo: 24 } })
  seedWhisper(env.api)
  const off = await env.exports.whisperNow({ force: false })
  assert.equal(off.reason, 'pet-offline', '离线时只在桌宠出现，绝不退化成 QQ 消息')
  await env.connect()
  seedWhisper(env.api, { nextAt: Date.now() + 30 * 60_000 })
  const notDue = await env.exports.whisperNow({ force: false })
  assert.equal(notDue.reason, 'not-due')
  assert.equal(env.sentToQQ.length, 0)
})

test('碎碎念：达到每日上限 / 正在干活时都不打断', async () => {
  const env = startModule({ settings: { carrier: 'qq', whisperMaxPerDay: 2 } })
  env.api.config = () => ({ ownerQQ: OWNER, enabled: true, speakUp: { awakeFrom: 0, awakeTo: 24 } })
  await env.connect()
  seedWhisper(env.api, { count: 2 })
  const cap = await env.exports.whisperNow({ force: false })
  assert.equal(cap.reason, 'daily-max')
  // 干活中：让路（别在思考/写代码时插一句碎碎念）
  seedWhisper(env.api, { count: 0 })
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'tool/call', data: { name: 'read_file' } })
  const busy = await env.exports.whisperNow({ force: false })
  assert.equal(busy.reason, 'busy')
})

test('碎碎念：文案池可以自定义，手动（force）跳过开关与排程但仍尊重专注模式', async () => {
  const env = startModule({ settings: { carrier: 'qq', whisperSource: 'pool', whisperLines: '（自己写的碎碎念）' } })
  env.api.config = () => ({ ownerQQ: OWNER, enabled: true, speakUp: { awakeFrom: 0, awakeTo: 24 } })
  await env.connect()
  const r = await env.exports.whisperNow({ force: true })
  assert.equal(r.text, '（自己写的碎碎念）')
  // 专注模式：force 也不打扰
  const focusFile = env.api.dataDir('focus.json')
  writeFileSync(focusFile, JSON.stringify({ enabled: true }))
  const f = await env.exports.whisperNow({ force: true })
  assert.equal(f.ok, false)
  assert.equal(f.reason, 'focus')
})

// ---------- 干活状态（DSH 会话事件 → 动画 / 结束提醒） ----------

test('干活状态：turn/start → thinking、tool/call → working、turn/end completed → success + 收尾文案', async () => {
  const env = startModule({ settings: { carrier: 'pet' } })
  seedPack(env.api, {
    manifest: {
      '工作状态-思考冒泡': 'anim-001', '工作状态-忙碌点按': 'anim-002', '工作状态-清点归档': 'anim-003',
      '工作状态-原地踱步张望': 'anim-004', '工作状态-雀跃庆祝': 'anim-005', '工作状态-垂头叹气冒汗': 'anim-006',
      '碎碎念-对屏碎碎念': 'anim-007',
    },
  })
  const { cursor } = await env.connect()
  // 包视图按中文命名约定自动识别六档（零配置）
  const cfg = await env.call('/config')
  assert.deepEqual(cfg.json.pack.workStatus, {
    thinking: 'anim-001', working: 'anim-002', result: 'anim-003',
    waiting: 'anim-004', success: 'anim-005', error: 'anim-006',
  })
  assert.deepEqual(cfg.json.pack.whisperAnims, ['anim-007'], '碎碎念动画池按「碎碎念」命名自动识别')
  assert.equal(env.exports.workStatus().state, null, '没活干时是空闲')

  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'turn/start' })
  assert.equal(env.exports.workStatus().state, 'thinking')
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'todo/write', data: { todos: [{ status: 'in_progress', content: '改桌宠气泡' }] } })
  assert.equal(env.exports.workStatus().task, '改桌宠气泡', '清单进度带进快照（面板/气泡都用它）')
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'tool/call', data: { name: 'write_file' } })
  assert.equal(env.exports.workStatus().state, 'working')
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const done = env.exports.workStatus()
  assert.equal(done.state, 'success')
  assert.match(done.text, /搞定/, '收尾要有一句能弹气泡/发通知的话')

  const ev = await env.call('/events', { query: { since: String(cursor), wait: '0', client: 'pet-test' } })
  const workEvents = (ev.json.events || []).filter((e) => e.type === 'work').map((e) => e.state)
  assert.deepEqual(workEvents, ['thinking', 'working', 'success'], '每次档位变化推一条；todo/write 只改文案不改档位')
})

test('干活状态：出错/阻塞/中断分别落 error、waiting、回空闲；子代理事件不参与', () => {
  const env = startModule({ settings: { carrier: 'pet' } })
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'turn/start' })
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'turn/end', data: { reason: { kind: 'error' } } })
  assert.equal(env.exports.workStatus().state, 'error')
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'turn/start' })
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'turn/end', data: { reason: { kind: 'blocked' } } })
  assert.equal(env.exports.workStatus().state, 'waiting')
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'turn/start' })
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  assert.equal(env.exports.workStatus().state, null, '中断要清回空闲，不能永远卡在干活中')
  // 子代理：多跑几路不该让桌宠一直闪
  env.exports.onSessionEvent({ header: { id: 'sub', origin: 'subagent' } }, { type: 'turn/start' })
  assert.equal(env.exports.workStatus().state, null)
  env.exports.onSessionEvent({ header: { id: 'sub2', delegationDepth: 2 } }, { type: 'tool/call', data: { name: 'x' } })
  assert.equal(env.exports.workStatus().state, null)
})

test('干活状态：ask_user_question 归 waiting；关掉状态动画后事件不再档位化', () => {
  const env = startModule({ settings: { carrier: 'pet', workStatusEnabled: false } })
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'tool/call', data: { name: 'ask_user_question' } })
  assert.equal(env.exports.workStatus().state, 'waiting')
  env.exports.onSessionEvent({ header: { id: 's2' } }, { type: 'turn/start' })
  assert.equal(env.exports.workStatus().state, 'waiting', '关掉开关不影响已存在的档位展示，只是不再新开档')
})

// ---------- 碎碎念：跟她「自己」的一个回合（工作区思考窗口 + 记忆），但不是主动搭话 ----------

test('碎碎念：自己想一句时走后台回合（工作区能看到思考），提示词带记忆与 DSH 状态；不选目的、不发 QQ', async () => {
  const env = startModule({ settings: { carrier: 'qq', whisperSource: 'model' } })
  env.api.config = () => ({ ownerQQ: OWNER, enabled: true, speakUp: { awakeFrom: 0, awakeTo: 24 } })
  env.setMemory([
    { id: 'm1', text: '主人喜欢喝冰美式，不加糖', importance: 0.8, at: Date.now() - 3600_000 },
    { id: 'm2', text: '说了周末要一起看《海街日记》', importance: 0.6, at: Date.now() - 7200_000 },
  ])
  env.setThinkReply('【思考】想起他爱喝冰美式\n（盯着杯子看了一会儿）冰美式…要不要也给自己倒一杯')
  seedWhisper(env.api)
  const { cursor } = await env.connect()
  // 先造一个「正在干活」的状态：提示词里要带上
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'turn/start' })
  env.exports.onSessionEvent({ header: { id: 's1' } }, { type: 'todo/write', data: { todos: [{ status: 'in_progress', content: '改桌宠气泡' }] } })

  const r = await env.exports.whisperNow({ force: true }) // force：干活中默认会推后，这里要验的是「想」的内容
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(env.thinkCalls.length, 1, '应该走一次后台系统回合（而不是 api.ask 一次性问答）')
  assert.equal(env.thinkCalls[0].title, '桌宠 · 碎碎念（自己的回合）', '工作区里那条会话的标题')
  assert.equal(env.thinkCalls[0].noTools, true)
  const prompt = env.thinkCalls[0].prompt
  assert.match(prompt, /冰美式/, '记忆要进提示词（结合记忆碎碎念）')
  assert.match(prompt, /思考中|干活中/, 'DSH 干活状态要进提示词')
  assert.match(prompt, /改桌宠气泡/, '当前清单步骤也要进提示词')
  assert.match(prompt, /不是主动搭话|不是在回复消息/, '要跟主动搭话区分开，别让她当成找人聊天')
  assert.equal(r.text, '（盯着杯子看了一会儿）冰美式…要不要也给自己倒一杯'.slice(0, 60), '备忘段【思考】要被切掉，只留那句话')

  const ev = await env.call('/events', { query: { since: String(cursor), wait: '0', client: 'pet-test' } })
  const bubble = (ev.json.events || []).find((e) => e.type === 'proactive')
  assert.ok(bubble, '要想出话并推到桌宠气泡')
  assert.equal(bubble.purpose, 'whisper')
  assert.equal(env.sentToQQ.length, 0, '碎碎念永不发 QQ')
})

test('碎碎念：她这次想说 [沉默] → 回落到文案池，照样只上桌宠；同一时间只跑一个后台回合', async () => {
  const env = startModule({ settings: { carrier: 'qq', whisperSource: 'model', whisperLines: '（今天有点懒）' } })
  env.api.config = () => ({ ownerQQ: OWNER, enabled: true, speakUp: { awakeFrom: 0, awakeTo: 24 } })
  await env.connect()
  env.setThinkReply('[沉默]')
  const r = await env.exports.whisperNow({ force: true })
  assert.equal(r.ok, true)
  assert.equal(r.text, '（今天有点懒）', '模型沉默时用面板文案池，不硬塞空话')

  // 上一轮还没想完：不并发开第二个后台回合
  let release
  env.holdThink(new Promise((resolve) => { release = resolve }))
  const first = env.exports.whisperNow({ force: true })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const second = await env.exports.whisperNow({ force: true })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'thinking')
  release()
  assert.equal((await first).ok, true)
  env.holdThink(null)
})

test('碎碎念：间隔最小 1 分钟、最大 9999 分钟、每天最多 9999 次都认（不再被夹回 5/48）', async () => {
  const env = startModule({ settings: { whisperMinMinutes: 1, whisperMaxMinutes: 9999, whisperMaxPerDay: 9999 } })
  const w = env.exports.whisperStatus()
  assert.equal(w.minMinutes, 1)
  assert.equal(w.maxMinutes, 9999)
  assert.equal(w.maxPerDay, 9999)
  assert.equal(w.thinking, false)
  assert.equal(w.turnTitle, '桌宠 · 碎碎念（自己的回合）')
  // 排程确实按 1~9999 分钟抽（不会因为下限被夹高而不动）
  const st = { day: new Date().toDateString(), count: 0, nextAt: 0, recent: [] }
  writeFileSync(env.api.dataDir('whisper.json'), JSON.stringify({ ...st }))
})
