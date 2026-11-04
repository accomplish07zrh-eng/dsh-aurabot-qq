// 单独选「识图模型」：聊天模型看不见也能收到画面描述；不配时保持原来的行为。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const { visionModelOf, canUnderstandImages, askModel, clearVisionCache } = await import(`file:///${REPO}/src/core/llm.js`)
const { normalize, mergeFromPanel } = await import(`file:///${REPO}/src/core/config.js`)

// ---------- 纯函数 / askModel ----------

test('配置：识图模型只认完整的 {provider, model}', () => {
  assert.deepEqual(normalize({}).model.visionModel, { provider: '', model: '' })
  assert.deepEqual(normalize({ model: { visionModel: { provider: ' p ', model: ' m ' } } }).model.visionModel, { provider: 'p', model: 'm' })
  assert.deepEqual(normalize({ model: { visionModel: { provider: 'p' } } }).model.visionModel, { provider: '', model: '' }, '只填一半当没配')
  assert.deepEqual(normalize({ model: { visionModel: 'p::m' } }).model.visionModel, { provider: '', model: '' }, '字符串坏数据当没配')
  assert.deepEqual(visionModelOf({ model: { visionModel: { provider: 'p', model: 'm' } } }), { provider: 'p', model: 'm' })
  assert.equal(visionModelOf(normalize({})), null, '没配 = 跟随聊天模型')
})

test('配了识图模型就算「能看图」', async () => {
  const dsh = { llm: { resolveModelInfo: async () => ({ inputModalities: ['text'] }) } }
  assert.equal(await canUnderstandImages(dsh, { model: { provider: 'p', model: 'blind' } }), false)
  assert.equal(await canUnderstandImages(dsh, { model: { provider: 'p', model: 'blind', visionModel: { provider: 'p', model: 'see' } } }), true)
})

test('askModel 只在带图时改用识图模型', async () => {
  const calls = []
  const dsh = {
    attachments: { admitPromptContent: async (c) => c },
    llm: {
      resolveModelInfo: async () => ({ inputModalities: ['text'] }),
      async *stream (p) { calls.push(p); yield { type: 'text-delta', text: '看到了' }; yield { type: 'finish', reason: { kind: 'stop' } } },
    },
  }
  const cfg = { model: { provider: 'p', model: 'chat', visionModel: { provider: 'p', model: 'vision' } } }
  await askModel(dsh, { cfg, text: '在吗' })
  assert.equal(calls[0].model, 'chat', '不带图还是走聊天模型')
  await askModel(dsh, { cfg, text: '看图', images: [{ data: 'AA==', mediaType: 'image/png' }] })
  assert.equal(calls[1].provider, 'p')
  assert.equal(calls[1].model, 'vision', '带图交给识图模型')
  assert.ok(calls[1].messages[0].content.some((c) => c.type === 'image'), '识图模型要真的收到图片')
})

test('面板保存：识图模型写进去、没动它时保留', () => {
  const base = normalize({})
  const saved = mergeFromPanel(base, { model: { visionModel: { provider: 'fake', model: 'm-see' } } })
  assert.deepEqual(saved.model.visionModel, { provider: 'fake', model: 'm-see' })
  const again = mergeFromPanel(saved, { model: { provider: 'p', model: 'chat' } })
  assert.deepEqual(again.model.visionModel, { provider: 'fake', model: 'm-see' }, '改聊天模型不该把识图模型弄丢')
  assert.deepEqual(mergeFromPanel(saved, { model: { visionModel: { provider: '', model: '' } } }).model.visionModel, { provider: '', model: '' }, '能改回跟随聊天模型')
})

// ---------- 真跑一遍 hub ----------

const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-vision-model-'))
process.env.AURABOT_DATA_DIR = dataDir
process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
mkdirSync(dataDir, { recursive: true })

const OWNER = '10000001'
const BOT = '20000002'
const PROXY = 'm-see'
writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
  enabled: true, dryRun: true, setupDone: true, botQQ: BOT, ownerQQ: OWNER,
  model: { provider: 'p', model: 'blind', reasoningEffort: '', visionModel: { provider: 'fake', model: PROXY } },
  allow: { private: [], groups: [] },
  snowluma: { autoStart: false, autoAttach: false, dir: join(dataDir, 'none') },
  voice: { enabled: false }, merge: { enabled: false },
}))

const PNG = (() => {
  const b = Buffer.alloc(64)
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47; b[7] = 0x0a
  b.writeUInt32BE(64, 16); b.writeUInt32BE(64, 20)
  return b
})()

const { createFakeDsh } = await import(`file:///${REPO}/test/helpers/fake-dsh.js`)
const fake = createFakeDsh({ brain: async () => '我看见啦' })
// 让宿主能回答「这个模型支不支持图片」：识图模型会看，聊天模型不会
fake.ctx.llm.resolveModelInfo = async (p, m) => ({ inputModalities: m === PROXY ? ['text', 'image'] : ['text'] })
const host = await import(`file:///${REPO}/src/host.js`)
const api = host.apply(fake.ctx)
await api.ready
await new Promise((r) => setTimeout(r, 400))

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const sendImage = async () => {
  await api.hub.onMessage({
    post_type: 'message', message_type: 'private', sub_type: 'friend',
    self_id: Number(BOT), user_id: Number(OWNER), time: Math.floor(Date.now() / 1000),
    message_id: Math.floor(Math.random() * 1e6),
    message: [{ type: 'image', data: { sub_type: 0, file: 'base64://' + PNG.toString('base64') } }],
    sender: { user_id: Number(OWNER), nickname: '主人' },
  })
  await wait(1500)
}

test('识图模型看图，聊天模型只收文字描述', async () => {
  clearVisionCache()
  await sendImage()
  const t = fake.turns.at(-1)
  assert.ok(t, '应该跑了一轮')
  assert.equal(t.images, 0, '聊天模型不该收到图片块')
  assert.match(t.userText, /识图模型看到的/, '要带上识图结果: ' + t.userText)
  assert.match(t.userText, /小鲸鱼/, '识图模型真的看了图')
  const call = fake.llmCalls.filter((c) => c.model === PROXY).at(-1)
  assert.ok(call, '识图模型要被调用')
  assert.equal(call.provider, 'fake')
  assert.ok(call.messages[0].content.some((c) => c.type === 'image'), '识图模型要真的收到图片')
})

test('群聊里也一样：识图模型看，聊天模型只收描述', async () => {
  const GROUP = '70000007'
  api.setConfig({ ...api.getConfig(), allow: { private: [], groups: [GROUP] } })
  const before = fake.turns.length
  await api.hub.onMessage({
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    self_id: Number(BOT), group_id: Number(GROUP), user_id: 123456, time: Math.floor(Date.now() / 1000),
    message_id: Math.floor(Math.random() * 1e6),
    sender: { user_id: 123456, nickname: '群友', card: '群友', role: 'member' },
    message: [
      { type: 'at', data: { qq: String(BOT) } },
      { type: 'image', data: { sub_type: 0, file: 'base64://' + PNG.toString('base64') } },
    ],
  })
  await wait(1500)
  const t = fake.turns.slice(before).at(-1) || fake.turns.at(-1)
  assert.equal(t.images, 0, '群里也不该把图塞给看不了图的聊天模型')
  assert.match(t.userText, /识图模型看到的/, '群聊正文里要带上识图结果: ' + t.userText)
  assert.match(t.userText, /小鲸鱼/)
})

test('识图模型和聊天模型是同一个：照旧直接看图，不重复调用', async () => {
  api.setConfig({ ...api.getConfig(), model: { provider: 'fake', model: PROXY, reasoningEffort: '', vision: 'auto', visionModel: { provider: 'fake', model: PROXY } } })
  clearVisionCache()
  const before = fake.llmCalls.length
  await sendImage()
  assert.equal(fake.turns.at(-1).images, 1, '同一个模型就直接把图交给她')
  assert.equal(fake.llmCalls.length, before, '不用为了描述多跑一次模型')
})

test('识图模型挂了：退回文字提示，这一轮照常进行', async () => {
  api.setConfig({ ...api.getConfig(), model: { provider: 'p', model: 'blind', reasoningEffort: '', vision: 'auto', visionModel: { provider: 'fake', model: 'm-broken' } } })
  const original = fake.ctx.llm.stream
  fake.ctx.llm.stream = async function * () { throw new Error('boom') }
  try {
    clearVisionCache()
    await sendImage()
    const t = fake.turns.at(-1)
    assert.equal(t.images, 0)
    assert.match(t.userText, /没看成/, '要如实说没看成: ' + t.userText)
  } finally {
    fake.ctx.llm.stream = original
  }
})

after(() => fake.dispose())
