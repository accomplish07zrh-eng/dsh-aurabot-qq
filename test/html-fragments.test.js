import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripHtmlFragments, stripLineTags, fenceRanges } from '../src/chat/html-fragments.js'
import { cleanOutboundText, parseReply } from '../src/chat/reply.js'

const clean = (text) => stripHtmlFragments(text).value

test('剥掉落单的块级收尾片段', () => {
  // 2026-11-06 群 644343678 实况：模型 reasoning 之后直接吐 HTML 收尾。
  assert.equal(clean('</p>\n\n\n\n\n\nB站那个是全本 3214集 中间不插广告'), 'B站那个是全本 3214集 中间不插广告')
  assert.equal(clean('你好</p>世界'), '你好世界')
  assert.equal(clean('就这样</div>'), '就这样')
  assert.equal(clean('前</section>后'), '前后')
  assert.equal(clean('</tfoot>正文'), '正文')
  assert.equal(clean('只写一半<div>的正文'), '只写一半的正文')
})

test('整行只剩标签时删掉整行，连换行一起', () => {
  assert.equal(clean('前\n</p>\n后'), '前\n后')
  assert.equal(clean('</p></p>\n正文'), '正文')
  assert.equal(clean('前\n<div><br></div>\n后'), '前\n后')
  // 原本就是空的行保留，那是段落分隔。
  assert.equal(clean('前\n\n后'), '前\n\n后')
})

test('成对的标签原样保留：模型真会聊 HTML', () => {
  assert.equal(clean('我喜欢 snake_case 和 <div>内容</div>'), '我喜欢 snake_case 和 <div>内容</div>')
  assert.equal(clean('<invoker>普通标签</invoker>'), '<invoker>普通标签</invoker>')
  assert.equal(clean('写 <p>段落</p> 这样就行'), '写 <p>段落</p> 这样就行')
})

test('br 是合法出站标记，永远不剥；</br> 照剥', () => {
  assert.equal(clean('第一行<br>'), '第一行<br>')
  assert.equal(clean('第一行<br/>'), '第一行<br/>')
  assert.equal(clean('前\n<br>\n后'), '前\n<br>\n后')
  assert.equal(clean('</br>正文'), '正文')
  assert.equal(clean('前</br>后'), '前后')
})

test('代码围栏内一字不动', () => {
  assert.equal(clean('看这个\n```html\n<div>hi</div>\n```\n完'), '看这个\n```html\n<div>hi</div>\n```\n完')
  assert.equal(clean('~~~\n</p>\n~~~'), '~~~\n</p>\n~~~')
  // 符号不同的不算收尾，围栏一直开到结尾。
  assert.equal(clean('~~~html\n</p>\n```\n</p>'), '~~~html\n</p>\n```\n</p>')
  // 更长的开符不能被更短的提前关掉。
  assert.equal(clean('````html\n</p>\n```\n</p>'), '````html\n</p>\n```\n</p>')
  // 收尾后面只剩空白才算收尾，```y 是代码行。
  assert.equal(clean('```html\nx\n```y\n</p>'), '```html\nx\n```y\n</p>')
  // 围栏外照常剥。
  assert.equal(clean('```html\n<div>x</div>\n```\n</p>尾巴'), '```html\n<div>x</div>\n```\n尾巴')
})

test('属性里的引号包住 > 时不能把标签切两半', () => {
  assert.equal(clean('<div title="1 > 0">正文'), '正文')
  assert.equal(clean("沿用 <p class='a>b'>内容</p> 的写法"), "沿用 <p class='a>b'>内容</p> 的写法")
})

test('行内标签不算噪音，不陪葬', () => {
  assert.equal(clean('</p><span></span>'), '<span></span>')
  assert.equal(clean('</p><b>粗体</b>'), '<b>粗体</b>')
})

test('返回值带原文坐标，供分段映射用', () => {
  const { value, cuts } = stripHtmlFragments('前</p>后')
  assert.equal(value, '前后')
  assert.deepEqual(cuts, [{ start: 1, end: 5 }])
  const whole = stripHtmlFragments('前\n</p>\n后')
  assert.equal(whole.value, '前\n后')
  assert.deepEqual(whole.cuts, [{ start: 2, end: 7 }])
})

test('非字符串和空串原样返回', () => {
  assert.equal(stripHtmlFragments('').value, '')
  assert.equal(stripHtmlFragments(null).value, '')
  assert.deepEqual(stripLineTags('普通一行'), { out: '普通一行', dropped: [] })
  assert.deepEqual(fenceRanges('没有围栏'), [])
})

test('接进出站清洗：整条回复里不残留落单标签', () => {
  assert.equal(cleanOutboundText('</p>\n\n\n\n\n\nB站那个是全本 3214集 中间不插广告'), 'B站那个是全本 3214集 中间不插广告')
  assert.equal(cleanOutboundText('你好</p>世界'), '你好世界')
  // 成对标签和 br 走完整条链路也不动。
  assert.equal(cleanOutboundText('我喜欢 <div>内容</div>'), '我喜欢 <div>内容</div>')
  assert.equal(cleanOutboundText('第一行<br>第二行'), '第一行<br>第二行')
  const parsed = parseReply('</p>你好|||</div>再见')
  assert.deepEqual(parsed.items, [{ kind: 'text', value: '你好' }, { kind: 'text', value: '再见' }])
})

test('整条只有残片时按沉默处理，不发出空气泡', () => {
  assert.equal(cleanOutboundText('</p>'), '')
  assert.equal(cleanOutboundText('</p></p>\n'), '')
  assert.equal(cleanOutboundText('<div><br></div>'), '')
})
