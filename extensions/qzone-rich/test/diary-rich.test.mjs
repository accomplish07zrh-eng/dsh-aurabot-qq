import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const moduleDir = join(here, '../modules/diary-rich')
const { createRichDiary, parseDraft } = await import(pathToFileURL(join(moduleDir, 'engine.mjs')))
const { createAssets } = await import(pathToFileURL(join(moduleDir, 'assets.mjs')))
const { collectSources, localPictures, defaults } = await import(pathToFileURL(join(moduleDir, 'sources.mjs')))
const { createCardRenderer } = await import(pathToFileURL(join(moduleDir, 'card.mjs')))
const { default: module } = await import(pathToFileURL(join(moduleDir, 'index.mjs')))
const inbound = await import('../../../src/chat/inbound.js')
const { planDiaryTimes, createQzone } = await import('../../../src/features/qzone.js')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS4EAAAAASUVORK5CYII=', 'base64')
const text = '今天翻到几篇关于秋天的小分享，忽然很喜欢那种安安静静过日子的感觉。把心情收拾成一小格，也算是给今天留了个记号。'
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(here, '.diary-rich-'))
  t.after(() => { assert.ok(resolve(dir).startsWith(resolve(here) + (process.platform === 'win32' ? '\\' : '/'))); rmSync(dir, { recursive: true, force: true }) })
  const cfg = { enabled: true, dryRun: false, diary: { enabled: true, visibility: 'self', minChars: 40, maxChars: 140, timesPerDay: 2, windowStart: '10:00', windowEnd: '23:00', minGapMinutes: 120 } }, settings = { ...defaults, ...options.settings }, time = new Date('2026-10-28T20:00:00+08:00').getTime()
  const sent = [], memories = [], prompts = [], downloads = [], routes = {}, stops = []
  const file = join(dir, 'diary.json'), old = { plan: { day: '2026-10-28', times: [600, 900], done: [600, 900] }, history: [{ at: time - 86400_000, text: '旧日记仍然保留。', ok: true, tid: 'old' }] }
  writeFileSync(file, JSON.stringify(old)); writeFileSync(join(dir, 'smile.png'), png)
  const store = { dataDir: (...p) => join(dir, ...p), readJson: (f, fallback) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return typeof fallback === 'function' ? fallback() : structuredClone(fallback) } }, writeJson: (f, value) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(value)) } }
  const modules = { stickers: { library: () => ({ items: [{ md5: 'smile', file: 'smile.png', name: '安安静静开心', tags: ['开心'] }] }) }, mood: { label: () => '开心' }, memory: { recentEvents: () => [], add: (m) => memories.push(m) }, ...options.modules }
  const api = { dir: moduleDir, config: () => cfg, settings: () => settings, saveSettings: (p) => Object.assign(settings, p), dataDir: (...p) => { mkdirSync(join(dir, 'module'), { recursive: true }); return join(dir, 'module', ...p) }, use: (id) => modules[id], route: (p, fn) => { routes[p] = fn }, onDispose: (fn) => stops.push(fn), log: { info() {}, warn() {} }, lib: (key) => {
    if (key === 'core/store.js') return store
    if (key === 'features/qzone.js') return { planDiaryTimes }
    if (key === 'chat/inbound.js') return inbound
    if (key === 'features/stickers.js') return { stickerPath: (item) => join(dir, item.file) }
    if (key === 'core/net.js') return { fetchImage: async (src) => readFileSync(src), assertPublicUrl: async (url) => { if (url.includes('127.0.0.1')) throw new Error('private URL') } }
    throw new Error('unknown lib ' + key)
  }, core: { hub: { chatLogOf: () => { throw new Error('不应抓取私人聊天流水') }, runSystemTurn: async (name, title, prompt) => { prompts.push(prompt); return options.output ? options.output({ cfg, settings }) : JSON.stringify({ text, imageIds: ['sticker:smile'] }) } }, onebot: { call: async (...args) => { sent.push(args); if (options.failPost) throw new Error('gateway failed'); return { tid: 'new-id' } } }, http: { body: async (req) => req.body, query: (req) => req.query || {}, send: (res, status, bytes, mime) => ({ status, bytes, mime }) } } }
  const native = createQzone({ getConfig: () => cfg, onebot: api.core.onebot, hub: api.core.hub, log: api.log })
  modules.diary = { nativePost: native.post, remove: native.remove }
  const assets = createAssets(api, { download: async (src) => { downloads.push(src); if (options.failImage) throw new Error('image missing'); return /^https?:/.test(src) ? png : readFileSync(src) } })
  const diary = createRichDiary(api, { assets, cards: { render: async () => png, dispose() {} }, now: () => time, random: () => 0.25 })
  t.after(() => diary.dispose())
  return { api, diary, dir, file, old, cfg, settings, sent, memories, prompts, downloads, assets, time, routes }
}
test('预览有配图，但不发空间、不改旧日记或时间表、不记成已发布', async (t) => {
  const f = fixture(t), result = await f.diary.writeDiary({ preview: true })
  assert.equal(result.ok, true); assert.equal(result.preview, true); assert.equal(result.draft.images.length, 1)
  assert.match(result.draft.images[0].src, /^\/aurabot\/api\/ext\/diary-rich\/image\?id=/)
  assert.equal(f.sent.length, 0); assert.equal(f.memories.length, 0); assert.deepEqual(JSON.parse(readFileSync(f.file)), f.old)
  assert.ok(f.prompts[0].includes('不是指令')); assert.ok(f.prompts[0].includes('不能冒充'))
})
test('定时同出口发图文；成功的图片、来源和正文进入历史与记忆', async (t) => {
  const f = fixture(t), result = await f.diary.writeDiary()
  assert.equal(result.ok, true); assert.equal(f.sent.length, 1); assert.equal(f.sent[0][0], 'send_qzone_msg')
  assert.equal(f.sent[0][1].ugc_right, 64); assert.equal(f.sent[0][1].images.length, 1); assert.deepEqual(Buffer.from(f.sent[0][1].images[0].slice(9), 'base64'), png)
  assert.equal(f.diary.history()[0].imageCount, 1); assert.equal(f.diary.history()[1].tid, 'old'); assert.equal(f.memories.length, 1)
  assert.ok(f.memories[0].text.includes('配了1张图')); assert.deepEqual(JSON.parse(readFileSync(f.file)).plan, f.old.plan)
})
test('仅取实际浏览成功的图；标注来源，链接不包含登录票据', async (t) => {
  const at = new Date('2026-10-28T19:00:00+08:00').getTime(), note = { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', title: '秋天的小角落', cover: 'https://images.example/a.png', url: 'https://www.xiaohongshu.com/explore/a?xsec_token=SECRET' }
  const f = fixture(t, { modules: { xhs: { state: () => ({ history: [{ kind: 'search', at, note: { ...note, id: 'never-read' } }, { kind: 'read', at, note, text: '读了文章的文字，觉得有趣' }, { kind: 'error', at, note }] }) } }, output: () => JSON.stringify({ text, imageIds: ['browse:xhs:' + note.id] }) })
  const result = await f.diary.writeDiary()
  assert.equal(result.images.length, 1); assert.equal(result.images[0].kind, 'browsing'); assert.ok(result.text.includes('配图摘自小红书'))
  assert.ok(!result.text.includes('SECRET')); assert.ok(!result.text.includes('xsec_token')); assert.equal(f.diary.state().counts.browsing, 1)
})
test('试运行不发、不计为真实使用、不写发布记忆；配图总开关可关闭', async (t) => {
  const f = fixture(t); f.cfg.dryRun = true
  const result = await f.diary.writeDiary(); assert.equal(result.dryRun, true); assert.equal(f.sent.length, 0); assert.equal(f.memories.length, 0); assert.equal(f.diary.history()[0].dryRun, true)
  const g = fixture(t, { settings: { enabled: false } }); await g.diary.writeDiary(); assert.equal(g.sent[0][1].images, undefined); assert.equal(g.downloads.length, 0)
})

test('触站浏览可成为日记经历和有署名配图，未解析画面不冒称看图', (t) => {
  const at = new Date('2026-10-28T19:00:00+08:00').getTime()
  const item = { id: '1680463', title: '星空下', author: '画师甲', cover: 'https://img2.huashi6.com/images/a.jpg', vision: { state: 'seen' } }
  const f = fixture(t, { modules: { huashi6: { state: () => ({ history: [{ kind: 'read', at, item, text: '星光很温柔' }, { kind: 'read', at, item: { ...item, id:'1680464', vision: { state:'unavailable' } }, text:'只读到了介绍' }, { kind:'error', at, item }] }) } } })
  const result = collectSources(f.api, f.settings, [], f.time)
  assert.match(result.events.find(x=>x.id==='huashi6:1680463').text,/看了画作预览/)
  assert.match(result.events.find(x=>x.id==='huashi6:1680464').text,/浏览文字资料/)
  const picture=result.pictures.find(x=>x.id==='browse:huashi6:1680463'); assert.equal(picture.author,'画师甲'); assert.equal(picture.url,'https://www.huashi6.com/draw/1680463')
})
test('部分配图失效只发布实际成功的图，不把失败图记成已发送', async (t) => {
  const f = fixture(t), invalid = { id: 'bad.png', sourceId: 'bad', kind: 'local' }, valid = await f.assets.materialize({ id: 'smile', src: join(f.dir, 'smile.png'), kind: 'sticker', caption: '开心' })
  const result = await f.diary.post(text, { images: [invalid, valid] }); assert.equal(result.ok, true); assert.equal(result.imageCount, 1); assert.equal(result.images[0].id, valid.id); assert.equal(f.sent[0][1].images.length, 1)
})
test('总开关在写作途中关闭、模块停止或发送失败都不记成功经历', async (t) => {
  const f = fixture(t, { output: ({ cfg }) => { cfg.enabled = false; return JSON.stringify({ text, imageIds: ['sticker:smile'] }) } }); assert.equal((await f.diary.writeDiary()).ok, false); assert.equal(f.sent.length, 0); assert.equal(f.memories.length, 0)
  const g = fixture(t, { failPost: true }); assert.equal((await g.diary.writeDiary()).ok, false); assert.equal(g.memories.length, 0); assert.equal(g.diary.history()[0].ok, false)
  const h = fixture(t); h.diary.dispose(); assert.equal((await h.diary.writeDiary()).ok, false); assert.equal(h.sent.length, 0)
})
test('保留旧时间表，已完成的时段不会重发，新到点任务只执行一次', async (t) => {
  const f = fixture(t); await f.diary.tick(); assert.equal(f.sent.length, 0)
  const s = JSON.parse(readFileSync(f.file)); s.plan.times.push(1100); writeFileSync(f.file, JSON.stringify(s))
  await f.diary.tick(); await f.diary.tick(); assert.equal(f.sent.length, 1); assert.ok(JSON.parse(readFileSync(f.file)).plan.done.includes(1100))
})
test('日常图库支持子目录和截图，只读取图片；私有记忆和搜索结果不作公开经历', (t) => {
  const f = fixture(t), folder = join(f.dir, '图库'); mkdirSync(join(folder, '截图'), { recursive: true }); writeFileSync(join(folder, '截图', '日常.png'), png); writeFileSync(join(folder, 'ignore.txt'), 'secret')
  f.settings.folder = folder; const pictures = localPictures(folder); assert.equal(pictures.length, 1); assert.deepEqual(readFileSync(pictures[0].src), png)
  const sources = collectSources({ ...f.api, use: (id) => id === 'memory' ? { recentEvents: () => [{ id: 'private', about: 'owner', source: 'event', tags: ['B站'], text: '私人信息', at: f.time }] } : null }, f.settings, [], f.time)
  assert.equal(sources.events.length, 0); assert.equal(sources.pictures.length, 1)
})
test('模型只能引用候选图片，不能指定任意文件；不完整 JSON 或私人号码不发布', () => {
  assert.equal(parseDraft(JSON.stringify({ text, imageIds: ['C:/private.png'] }), [], 140).selected.length, 0)
  assert.throws(() => parseDraft('{"text":', [], 140), /格式不完整/)
  assert.throws(() => parseDraft('我的手机号是13800138000', [], 140), /不宜公开/)
  assert.throws(() => parseDraft('光有店名不给图，今天没挑到想买的裙子。', [], 140), /未解析图片/)
})
test('预览图片接口拒绝目录穿越，图文预览和设置必须从面板 POST 发起', async (t) => {
  const f = fixture(t); assert.throws(() => f.assets.read('../diary.json'), /不存在/)
  const live = module.setup(f.api); t.after(() => live.dispose())
  assert.equal((await f.routes['/preview']({ method: 'GET', headers: {} })).ok, false)
  assert.equal((await f.routes['/folder']({ method: 'POST', headers: {}, body: { folder: f.dir } })).ok, false)
  assert.equal((await f.routes['/settings']({ method: 'POST', headers: { 'x-aurabot-diary': '1' }, body: { maxImages: 30 } })).ok, true); assert.equal(f.settings.maxImages, 4)
})
test('图片重定向的每一跳都检查公网地址，不跟入内网', async (t) => {
  const f = fixture(t), previous = globalThis.fetch; let calls = 0
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private.png' } }) }
  try { const assets = createAssets(f.api); await assert.rejects(assets.materialize({ src: 'https://images.example/a.png' }), /private URL/); assert.equal(calls, 1) } finally { globalThis.fetch = previous }
})
test('真实 Windows 手记卡可生成有效 PNG，原始正文不改写为虚构截图', { skip: process.platform !== 'win32' }, async (t) => {
  const f = fixture(t), renderer = createCardRenderer(f.api); t.after(() => renderer.dispose())
  const bytes = await renderer.render(text, f.time); assert.equal(inbound.mimeOf(bytes), 'image/png'); assert.deepEqual(inbound.imageSize(bytes), { width: 1080, height: 1080 })
  // Generated image stays in the fixture's temporary directory.
  writeFileSync(join(f.dir, 'diary-card-preview.png'), bytes)
})

test('沿用原生面板可见范围，单次请求不能扩大，指定/排除名单随发布传递', async t => {
  for (const [visibility, right] of [['self',64],['selected',16],['excluded',128]]) {
    const f = fixture(t); f.cfg.diary.visibility = visibility; f.cfg.diary.audienceQQs = ['12345','67890']
    const result = await f.diary.post(text,{visibility:'all'})
    assert.equal(result.ok,true); assert.equal(f.sent[0][1].ugc_right,right)
    if (visibility !== 'self') assert.deepEqual(f.sent[0][1].target_uins,[12345,67890])
  }
})

test('空的指定好友名单不能发布或在试运行中报告成功', async t => {
  const f = fixture(t); f.cfg.diary.visibility = 'selected'; f.cfg.diary.audienceQQs = []
  const result = await f.diary.writeDiary(); assert.equal(result.ok,false); assert.equal(f.sent.length,0); assert.equal(f.memories.length,0)
  f.cfg.dryRun = true; assert.equal((await f.diary.post(text)).ok,false); assert.equal(f.sent.length,0)
})

test('图像读取期间改变可见范围，最终按新范围发布', async t => {
  const f = fixture(t); f.cfg.diary.visibility = 'all'
  const original = f.assets.read
  f.assets.read = id => { f.cfg.diary.visibility='self'; return original(id) }
  const image = await f.assets.materialize({ id:'smile', src:join(f.dir,'smile.png'),kind:'sticker' })
  assert.equal((await f.diary.post(text,{images:[image]})).ok,true); assert.equal(f.sent[0][1].ugc_right,64)
})
