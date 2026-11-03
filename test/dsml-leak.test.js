import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanOutboundText, cleanOutboundSegments, stripToolText, parseReply } from '../src/chat/reply.js'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'
import { createBiliApi } from '../src/bili/api.js'
import { createQzone } from '../src/features/qzone.js'
import { cleanComment } from '../src/features/qzone-social.js'
import { cleanReply } from '../src/purpose/module.js'

const screenshot = ['@苏眠眠 </ | | DSML | | invoke>', '</ | | DSML | | calls>']
const closing = '</ | | DSML | | invoke>'
const block = '<｜DSML｜function_calls><｜DSML｜invoke name="qq_draw_image"><｜DSML｜parameter name="prompt">内部参数</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜function_calls>'

for (const input of [
  ...screenshot,
  '@苏眠眠 </ ｜ ｜ DSML ｜ ｜ invoke>', '＠苏眠眠 </｜DSML｜invoke>',
  '</｜DSML｜calls>', '</|DSML|invoke>', '</||DSML||calls>',
  '</ | ｜ dSmL ｜ | InVoKe >',
  '< \t/\n｜ \u3000|\u00a0dSmL\n|\t｜\nparameter\t>',
  '<|DSML|invoke>', '<｜DSML｜calls/>', '<｜DSML｜', '</|DSML|',
  '</ | | DSML | | invoke', '<｜DSML｜parameter name="prompt"',
  '<invoke>', '</invoke>', '<PARAMETER>', '</function_calls', '<tool_call/>',
  '< ANtml : invoke >', '</antml:function_calls>',
  block,
  '<function_calls><invoke name="x"><parameter name="p">内部参数</parameter></invoke></function_calls>',
  '< ANtMl : FUNCTION_CALLS ><antml:invoke name="x">内部参数</ antml : invoke ></ antml : function_calls >',
  '<tool_call>{"name":"qq_draw_image","arguments":{"prompt":"内部参数"}}</tool_call>',
  '< | tool ▁ calls ▁ begin | >内部参数< | tool ▁ calls ▁ end | >',
  '{"name":"qq_draw_image","arguments":{"prompt":"内部参数"}}',
  `<reply:7><voice>${block}</voice>|||${closing}`,
  `\`\`\`xml\n${block}\n\`\`\``,
]) {
  test(`工具文字按沉默处理：${JSON.stringify(input)}`, () => {
    const warnings = []
    assert.equal(cleanOutboundText(input, { warn: (line) => warnings.push(line) }), '')
    assert.deepEqual(parseReply(input), { silent: true, items: [] })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /整段都是工具调用/)
  })
}

test('半角/全角、空白和大小写的成对标签删除参数，前后正文保留', () => {
  const variants = [
    block,
    '< | | dSmL ｜ | InVoKe name="x">内部参数</ ｜ | DsMl | ｜ invoke >',
    '< FUNCTION_CALLS ><invoke name="x">内部参数</invoke></ function_calls >',
    '<antml:parameter name="x">内部参数</antml:parameter>',
  ]
  for (const input of variants) assert.equal(stripToolText(`前文${input}后文`), '前文后文', input)
  assert.equal(stripToolText(`前文${closing}后文`), '前文后文')
  assert.equal(stripToolText('前文<|DSML|invoke>后文'), '前文后文', '孤立开标签只去标记')
  assert.equal(stripToolText('前文</|DSML|invoke'), '前文', '没有 > 的尾片')
})

test('正常聊天的符号、HTML、JSON、@ 和回复控制标签保留', () => {
  for (const text of [
    'a | b ｜ c || d，1 < 2，3 > 2，<3',
    '我喜欢 snake_case 和 <div>内容</div>',
    'invoke、calls、parameter、function_calls、DSML 只是单词',
    '{"name":"小明"}', '<invoker>普通标签</invoker>',
    '@苏眠眠 你好', '<reply:7><voice>你好</voice>|||<sticker:开心><poke>',
  ]) assert.equal(cleanOutboundText(text), text)
  const warnings = []
  assert.equal(cleanOutboundText(`@苏眠眠 前文${closing}后文`, { warn: (m) => warnings.push(m) }), '@苏眠眠 前文后文')
  assert.equal(warnings.length, 0, '保留正文时不报整轮工具调用')
  const parsed = parseReply(`<reply:7>你好${closing}|||再见`)
  assert.deepEqual(parsed.items, [{ kind: 'text', value: '你好', replyTo: '7' }, { kind: 'text', value: '再见' }])
})

const text = (value) => ({ type: 'text', data: { text: value } })
const quote = { type: 'reply', data: { id: '42' } }
const at = { type: 'at', data: { qq: '22' } }

test('跨文字段的调用、参数和碎标签一起检查，@、引用及文字顺序保持', () => {
  const message = [quote, text('前文'), at, text('<|DS'), text('ML|invoke name="x">内部'), text('参数</|DSML|invoke>后文')]
  assert.deepEqual(cleanOutboundSegments(message), [quote, text('前文'), at, text('后文')])
  assert.deepEqual(cleanOutboundSegments([quote, at, text(' '), text(closing)]), [])
  const image = { type: 'image', data: { file: 'https://example.com/a.png' } }
  assert.deepEqual(cleanOutboundSegments([quote, at, text(block), image]), [quote, at, image])
})

function setup(t, { hooks, voice = false, ttsFailure = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-dsml-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const file = join(dir, 'voice.wav')
  writeFileSync(file, 'test voice')
  const sent = [], warnings = [], spoken = []
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '1', workspaceDir: dir,
    voice: { enabled: voice, autoChance: 0, emojiSeparate: true }, stickers: { enabled: false, faces: false } })
  const log = { info() {}, debug() {}, error() {}, warn: (...args) => warnings.push(args.join(' ')) }
  const hub = createHub({ dsh: {}, getConfig: () => cfg, log, hooks,
    onebot: { async call(action, params) {
      if (action === 'get_group_member_list') return [{ user_id: 22, nickname: '苏眠眠', card: '' }]
      sent.push({ action, ...params })
      return { message_id: sent.length }
    } },
    tts: { async speak(value) { spoken.push(value); if (ttsFailure) throw new Error('合成失败'); return { file, engine: 'test' } } },
  })
  t.after(() => {
    hub.dispose()
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { hub, cfg, sent, warnings, spoken, log }
}

for (const target of ['group:9', 'private:1', 'private:2']) {
  test(`统一出口：${target} 的正常投递、直接文字、消息段全都拦，纯标记不发`, async (t) => {
    const s = setup(t)
    for (const input of [...screenshot, block, `|||${closing}`]) {
      await s.hub.deliver(target, input, { simulate: true })
      await s.hub.sendText(target, input, '42', undefined, '22')
      await s.hub.sendSegments(target, [quote, at, text(input)], '测试')
    }
    assert.equal(s.sent.length, 0)
    assert.ok(s.warnings.some((line) => line.includes('整段都是工具调用')))
    await s.hub.sendText(target, `正常${closing}正文`, '42', undefined, '22')
    assert.deepEqual(s.sent[0].message, [quote, at, text(' '), text('正常正文')])
  })
}

test('正常群聊引用和真实 @ 保留，模型正文里的 @ 不受影响', async (t) => {
  const s = setup(t)
  await s.hub.deliver('group:9', `你好${closing}`, { autoReply: { mid: '42', uid: '22', direct: true }, simulate: true })
  assert.deepEqual(s.sent[0].message, [quote, at, text(' '), text('你好')])
  await s.hub.sendText('group:9', `@苏眠眠 你好${closing}`)
  assert.ok(s.sent[1].message.some((seg) => seg.type === 'at' && seg.data.qq === '22'))
  assert.ok(s.sent[1].message.some((seg) => seg.type === 'text' && seg.data.text.includes('你好')))
})

test('其他平台转发钩子拿到清洗后的段，只有标记的消息不交给钩子', async (t) => {
  const forwarded = []
  const s = setup(t, { hooks: { send(message) { forwarded.push(message); return null } } })
  await s.hub.sendText('group:9', screenshot[0])
  assert.equal(forwarded.length, 0)
  await s.hub.sendSegments('group:9', [quote, text(`前${block}后`)], '转发')
  assert.deepEqual(forwarded, [[quote, text('前后')]])
  assert.equal(s.sent.length, 0)
})

test('reply 转发钩子在拆气泡前也只能拿到清洗后的正文', async (t) => {
  const forwarded = []
  const s = setup(t, { hooks: { reply(value) { forwarded.push(value); return null } } })
  await s.hub.deliver('group:9', screenshot[0])
  assert.deepEqual(forwarded, [])
  await s.hub.deliver('group:9', `前${block}后`)
  assert.deepEqual(forwarded, ['前后'])
  assert.equal(s.sent.length, 0)
})

test('工具参数里的 @ 先被删掉，不能变成真正的提醒段', async (t) => {
  const s = setup(t)
  await s.hub.sendText('group:9', '前<invoke name="x">@苏眠眠</invoke>后')
  assert.deepEqual(s.sent[0].message, [text('前后')])
})

test('最终出口拦住 send 钩子新写的标记', async (t) => {
  const s = setup(t, { hooks: { send() { return [quote, at, text(closing)] } } })
  await s.hub.sendText('group:9', '正常正文')
  assert.equal(s.sent.length, 0)
  assert.ok(s.warnings.some((line) => line.includes('整段都是工具调用')))
})

for (const ttsFailure of [false, true]) {
  test(`直接语音在合成前清洗，${ttsFailure ? '失败回落文字' : '表情补发'}也经过出口`, async (t) => {
    const s = setup(t, { voice: true, ttsFailure })
    await s.hub.sendVoice('private:1', block)
    assert.deepEqual(s.spoken, [])
    assert.deepEqual(s.sent, [])
    await s.hub.sendVoice('private:1', `你好${closing}😀`)
    assert.equal(s.spoken.length, 1)
    assert.match(s.spoken[0], /你好/)
    assert.doesNotMatch(JSON.stringify(s.sent) + s.spoken.join(''), /DSML|invoke|内部参数/)
    assert.ok(s.sent.some((msg) => msg.message.some((seg) => seg.type === (ttsFailure ? 'text' : 'record'))))
    if (!ttsFailure) assert.ok(s.sent.some((msg) => msg.message.some((seg) => seg.type === 'text' && seg.data.text.includes('😀'))))
  })
}

test('items 钩子加入的工具文字不能进入 TTS 或文字回落', async (t) => {
  const s = setup(t, { voice: true, hooks: { items() { return [{ kind: 'voice', value: block }] } } })
  await s.hub.deliver('private:1', '你好')
  assert.equal(s.spoken.length, 0)
  assert.equal(s.sent.length, 0)
})

test('B 站评论出口复用清洗，纯调用不请求网络，正常正文保留', async () => {
  const requests = [], warnings = []
  const api = createBiliApi({ getCookie: () => 'bili_jct=test', log: { warn: (m) => warnings.push(m) },
    async fetchImpl(url, options) { requests.push({ url, options }); return { async json() { return { code: 0, data: { rpid: 42 } } } } },
  })
  assert.equal((await api.postComment(1, block)).silent, true)
  assert.equal((await api.postDanmaku({}, block, 0, 1)).silent, true)
  assert.equal(requests.length, 0)
  await api.postComment(1, `前文${block}后文`, { root: 2, parent: 3 })
  assert.equal(requests.length, 1)
  const form = new URLSearchParams(requests[0].options.body)
  assert.equal(form.get('message'), '前文后文')
  assert.equal(form.get('root'), '2')
  assert.equal(form.get('parent'), '3')
  assert.equal(warnings.length, 2)
})

test('空间和桌宠的独立路径复用同一清洗，截断及去 HTML 前先删除工具参数', async (t) => {
  const s = setup(t)
  const calls = []
  const qzone = createQzone({ getConfig: () => s.cfg, log: s.log, onebot: { async call(action, params) { calls.push({ action, params }); return { tid: '1' } } } })
  await qzone.post(block)
  assert.equal(calls.length, 0)
  assert.equal(cleanComment(block), '')
  assert.equal(cleanComment(`前${block}后`), '前后')
  assert.equal(cleanReply(`大肥鱼：${block}`), '')
  assert.equal(cleanReply(`前${block}后`), '前后')
})

test('零宽字符 / 全角空格 / 换行混入标签名也能识别并删参数', () => {
  const variants = [
    '<tool\u200b_call>内部参数</tool\u200b_call>',
    '<\u200binvoke name="x">内部参数</in\u200bvoke>',
    '<|DS\u200bML|invoke>内部参数</|DSML|invoke>',
    '<in\u3000voke>内部参数</in\u3000voke>',
    '<in\nvoke>内部参数</in\nvoke>',
  ]
  for (const input of variants) assert.equal(stripToolText(`前文${input}后文`), '前文后文', JSON.stringify(input))
})

test('DSML begin/end 带前缀成对删内容；开闭不配对只删标记', () => {
  const paired = '<|DSML|tool_calls_begin|>内部参数<|DSML|tool_calls_end|>'
  assert.equal(cleanOutboundText(paired), '')
  assert.equal(stripToolText(`前${paired}后`), '前后')
  assert.equal(stripToolText('前<|DSML|invoke name="x">内部参数<|DSML|/invoke>后'), '前后')
  assert.equal(stripToolText('前<|DSML|tool_calls_begin|>内部参数'), '前内部参数')
  assert.equal(stripToolText('前内部参数<|DSML|tool_calls_end|>后'), '前内部参数后')
})

test('单引号 / 非严格 JSON 调用文本也删，普通 JSON 保留', () => {
  for (const input of [
    "{'name':'search','arguments':{'q':'内部参数'}}",
    "{'tool_calls':[{'name':'search','arguments':{'q':'内部参数'}}]}",
    "{name:'search',arguments:{q:'内部参数'}}",
    "{'type':'tool_use','name':'search','input':{'q':'内部参数'}}",
  ]) assert.equal(cleanOutboundText(input), '', input)
  assert.equal(cleanOutboundText("好呀 {'name':'小明'}"), "好呀 {'name':'小明'}")
})

test('<|thinking|> / begin_of_thought 内容按内部推理删掉', () => {
  for (const input of [
    '<|begin_of_thought|>内部推理内容<|end_of_thought|>你好',
    '<|thinking|>内部推理内容<|/thinking|>你好',
    '<|begin_of_thought|>内部推理内容<|end_of_thought|>',
    '<|begin_of_thought|>内部推理内容<|end_of_thought|>你好',
  ]) {
    const out = cleanOutboundText(input)
    assert.doesNotMatch(out, /内部推理内容/, JSON.stringify(input))
  }
  assert.equal(cleanOutboundText('<|thinking|>只有内部推理没有结束'), '')
})
