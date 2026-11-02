// QQ 系统表情（小黄脸）：<face:名字> 换成消息段、认不出的去掉；网关目录只要数字编号、同名优先普通表情；收到的按名字给她看；提示词按开关教她。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { textToSegments, stripFaceTags, buildFaceIndex, createFaces, COMMON_FACES, splitSpeakable, speakableText } from '../src/chat/faces.js'
import { parseMessageEvent } from '../src/chat/inbound.js'
import { rulesText } from '../src/persona/personas.js'
import { normalize } from '../src/core/config.js'

const idOf = (n) => COMMON_FACES[n]

test('文字里的 <face:名字> 换成系统表情段，和文字在同一条消息里；认不出的名字去掉', () => {
  assert.deepEqual(textToSegments('哈哈<face:捂脸> 你又来了', idOf), [
    { type: 'text', data: { text: '哈哈' } },
    { type: 'face', data: { id: '264' } },
    { type: 'text', data: { text: ' 你又来了' } },
  ])
  assert.deepEqual(textToSegments('<face:斜眼笑>', idOf), [{ type: 'face', data: { id: '178' } }])
  assert.deepEqual(textToSegments('好<face:不存在的表情>呀', idOf), [{ type: 'text', data: { text: '好呀' } }])
  assert.deepEqual(textToSegments('<face:不存在>', idOf), [])
  assert.deepEqual(textToSegments('普通的话', idOf), [{ type: 'text', data: { text: '普通的话' } }])
  assert.equal(stripFaceTags('好<face:捂脸> 呀'), '好 呀')
})

test('网关目录：只认数字编号（emoji 分组不算），同名优先普通表情，别名也认', () => {
  const idx = buildFaceIndex({ packs: [
    { pack_name: '超级表情', emojis: [{ q_sid: '5', q_des: '/流泪', is_super: true }, { q_sid: '319', q_des: '/比心', is_super: true }] },
    { pack_name: '小黄脸表情', emojis: [{ q_sid: '5', q_des: '/流泪' }, { q_sid: '264', q_des: '/捂脸', emoji_name_alias: ['/捂脸笑'] }] },
    { pack_name: 'emoji 表情', emojis: [{ q_sid: '😚', q_des: '/亲亲' }] },
  ] })
  assert.equal(idx.byName.get('流泪'), 5)
  assert.equal(idx.byName.get('比心'), 319, '只有超级表情的也能用')
  assert.equal(idx.byName.get('捂脸笑'), 264)
  assert.equal(idx.byName.has('亲亲'), false)
  assert.equal(idx.byId.get('264'), '捂脸')
})

test('对照表：先用内置常用的；拉到网关目录后合并；网关取不到也照常能用', async () => {
  const f = createFaces({ onebot: { call: async () => ({ packs: [{ pack_name: 'x', emojis: [{ q_sid: '424', q_des: '/续标识' }] }] }) } })
  assert.equal(f.idOf('捂脸'), 264)
  await f.refresh()
  assert.equal(f.idOf('/续标识'), 424)
  assert.equal(f.nameOf(424), '续标识')
  assert.equal(f.idOf('微笑'), 14, '内置的还在')
  const broken = createFaces({ onebot: { call: async () => { throw new Error('不支持') } }, log: { debug() {} } })
  await broken.refresh()
  assert.equal(broken.idOf('斜眼笑'), 178)
})

test('收到的系统表情按名字给她看，认不出才写 [表情]', () => {
  const e = { message_type: 'private', user_id: 1, message: [{ type: 'text', data: { text: '笑死' } }, { type: 'face', data: { id: '178' } }, { type: 'face', data: { id: '99999' } }] }
  const m = parseMessageEvent(e, '9', { faceName: (id) => ({ 178: '斜眼笑' })[id] })
  assert.match(m.text, /笑死\[斜眼笑\]\[表情\]/)
  assert.match(parseMessageEvent(e, '9').text, /\[表情\]\[表情\]/, '不给对照也不出错')
})

test('提示词：开着就教她写 <face:名字>，关了就不提', () => {
  assert.match(rulesText('private', normalize({ ownerQQ: '1' })), /<face:捂脸>/)
  assert.doesNotMatch(rulesText('private', normalize({ ownerQQ: '1', stickers: { faces: false } })), /<face:/)
})
test('语音文本拆分：表情不念出来，但要留着补发（<face:名字> 原文保留）', () => {
  assert.deepEqual(splitSpeakable('<face:呲牙>晚安😁'), { spoken: '晚安', extras: '<face:呲牙>😁' })
  assert.deepEqual(splitSpeakable('晚安啦<face:捂脸></face>'), { spoken: '晚安啦', extras: '<face:捂脸>' })
  assert.deepEqual(splitSpeakable('晚安 👨‍👩‍👧 做个好梦'), { spoken: '晚安 做个好梦', extras: '👨‍👩‍👧' })
  assert.deepEqual(splitSpeakable('晚安🇨🇳'), { spoken: '晚安', extras: '🇨🇳' }, '国旗是区域指示符，不在 Extended_Pictographic 里，不能留在要念的字里')
  assert.deepEqual(splitSpeakable('第1️⃣名'), { spoken: '第名', extras: '1️⃣' }, '键帽连前面的数字一起拆走')
  assert.deepEqual(splitSpeakable('苏格兰🏴󠁧󠁢󠁳󠁣󠁴󠁿好'), { spoken: '苏格兰好', extras: '🏴󠁧󠁢󠁳󠁣󠁴󠁿' }, '标签字符序列也要拆干净')
  assert.deepEqual(splitSpeakable('你好 👋🏽'), { spoken: '你好', extras: '👋🏽' }, '肤色修饰符不能留在要念的字里')
  assert.deepEqual(splitSpeakable('😭<face:大哭>'), { spoken: '', extras: '😭<face:大哭>' })
  assert.deepEqual(splitSpeakable('<sticker:委屈><poke>晚安'), { spoken: '晚安', extras: '' }, '表情包/戳一戳没有单独补发的说法')
  assert.deepEqual(splitSpeakable('好<face:这是一个特别特别长的表情名字>呀'), { spoken: '好<face:这是一个特别特别长的表情名字>呀', extras: '' }, '超长名字不算 face 标签，和以前一样留在要念的字里')
  assert.deepEqual(splitSpeakable('普通的话'), { spoken: '普通的话', extras: '' })
  assert.equal(speakableText('<face:呲牙>晚安😁'), '晚安', '老接口行为不变')
})
