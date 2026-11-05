// 上下文插件给历史消息带的消息编号（m00896b 这种）偶尔会被模型抄进正文，
// 得在解析入口剥掉，不然编号会当成正文发到 QQ。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReply } from '../src/chat/reply.js'

const texts = (r) => r.items.filter((i) => i.kind === 'text').map((i) => i.value)

test('整段只有一个消息编号：剥完是空的，按沉默处理，不发', () => {
  assert.deepEqual(parseReply('m00896b'), { silent: true, items: [] })
})

test('编号 + [沉默]：只留下沉默判定，一条都不发', () => {
  assert.deepEqual(parseReply('m00896b\n\n\n[沉默]'), { silent: true, items: [] })
})

test('编号在行首：剥掉编号，正文照发', () => {
  assert.deepEqual(texts(parseReply('m00879b，两个 512 加起来本来就 1T')), ['两个 512 加起来本来就 1T'])
  assert.deepEqual(texts(parseReply('m00884b 1T 玩游戏确实紧')), ['1T 玩游戏确实紧'])
})

test('编号在第二行：只剥那一行', () => {
  assert.deepEqual(texts(parseReply('先说一句\nm00795b 这话有理')), ['先说一句', '这话有理'])
})

test('编号在行中 / 行尾：也要剥', () => {
  assert.deepEqual(texts(parseReply('他说 m00896b 那条不算')), ['他说 那条不算'])
  assert.deepEqual(texts(parseReply('这话有理 m00879b')), ['这话有理'])
})

test('同一行好几个编号：全剥', () => {
  assert.deepEqual(texts(parseReply('m00879b m00884b 两条都看了')), ['两条都看了'])
})

test('多粘了字母的编号（m00879bb）整个吃掉，不留残字', () => {
  assert.deepEqual(texts(parseReply('m00879bb 双后缀')), ['双后缀'])
})

test('4 位的打印机型号不是编号，不能误伤', () => {
  assert.deepEqual(texts(parseReply('m1005 又卡纸了')), ['m1005 又卡纸了'])
  assert.deepEqual(texts(parseReply('M1005 又卡纸了')), ['M1005 又卡纸了'])
})

test('普通英文词不能误伤', () => {
  assert.deepEqual(texts(parseReply('markdown 和 mysql 还有 m416')), ['markdown 和 mysql 还有 m416'])
})

test('写坏的 <reply:编号> 引用标签本来就会被去掉，别把后面的正文一起吃掉', () => {
  assert.deepEqual(texts(parseReply('<reply:m00896b>这句是引用')), ['这句是引用'])
})

test('合法的 <reply:4> 引用编号照旧生效', () => {
  const r = parseReply('<reply:4>这脸 谁惹你了')
  assert.equal(r.items[0].replyTo, '4')
  assert.equal(r.items[0].value, '这脸 谁惹你了')
})

test('模型漏出工具调用的收尾标记：整段只有标记时不发', () => {
  assert.deepEqual(parseReply('</｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>'), { silent: true, items: [] })
})

test('收尾标记跟着正文一起漏出来：只留正文', () => {
  assert.deepEqual(
    texts(parseReply('炒菜可以 但我要先吃口饭\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>')),
    ['炒菜可以 但我要先吃口饭'],
  )
})

test('半角竖线的特殊 token 也认，普通尖括号文本不能误伤', () => {
  assert.deepEqual(texts(parseReply('<|endoftext|>好')), ['好'])
  assert.deepEqual(texts(parseReply('a > b 和 <b>粗体</b>')), ['a > b 和 <b>粗体</b>'])
})
