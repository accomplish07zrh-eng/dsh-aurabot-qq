// 一轮多段正文的两个补法：每段都发（chat.everyStep）、从思考里捞定稿（chat.rescueFromThinking）。
// 两个开关都默认关，所以这里只测「打开以后按什么规则工作」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { takeInterim, reasoningOf, rescueFromThinking } from '../src/chat/steps.js'

const blank = () => ({ interimTurn: -1, interimText: '', interimStep: -1 })

test('每段都发：第一段没有上一段可发', () => {
  const st = blank()
  assert.equal(takeInterim(st, { turn: 1, step: 1, text: '第一句' }), null)
  assert.equal(st.interimText, '第一句')
  assert.equal(st.interimStep, 1)
})

test('每段都发：第二步时把上一段交出来', () => {
  const st = blank()
  takeInterim(st, { turn: 125, step: 1, text: '能接，而且不用动 ASR 主体：librosa 只负责算特征…' })
  assert.equal(takeInterim(st, { turn: 125, step: 2, text: '哦，原来夸的是「两条语音都读对了」' }), '能接，而且不用动 ASR 主体：librosa 只负责算特征…')
})

test('每段都发：三个 step 依次把前两段发出去，最后一段留给 turn/end', () => {
  const st = blank()
  assert.equal(takeInterim(st, { turn: 7, step: 1, text: 'A' }), null)
  assert.equal(takeInterim(st, { turn: 7, step: 2, text: 'B' }), 'A')
  assert.equal(takeInterim(st, { turn: 7, step: 3, text: 'C' }), 'B')
  assert.equal(st.interimText, 'C', '最后一段留在状态里，由 turn/end 发')
})

test('每段都发：同样的话不重复发', () => {
  const st = blank()
  takeInterim(st, { turn: 3, step: 1, text: '一样的话' })
  assert.equal(takeInterim(st, { turn: 3, step: 2, text: '一样的话' }), null)
})

test('每段都发：跨轮不发（上一轮最后一段已经发过了）', () => {
  const st = blank()
  takeInterim(st, { turn: 3, step: 1, text: '上一轮的话' })
  assert.equal(takeInterim(st, { turn: 4, step: 1, text: '这一轮的话' }), null)
  assert.equal(st.interimText, '这一轮的话')
})

test('每段都发：step 没递增就不发（同一步重复事件、或事件乱序）', () => {
  const st = blank()
  takeInterim(st, { turn: 5, step: 2, text: '第二段' })
  assert.equal(takeInterim(st, { turn: 5, step: 2, text: '第二段改了口' }), null)
  assert.equal(takeInterim(st, { turn: 5, step: 1, text: '更早的一段' }), null)
})

test('每段都发：空正文不动状态', () => {
  const st = blank()
  takeInterim(st, { turn: 9, step: 1, text: '有内容' })
  assert.equal(takeInterim(st, { turn: 9, step: 2, text: '   ' }), null)
  assert.equal(st.interimText, '有内容', '空的一段不该把上一段顶掉')
  assert.equal(st.interimStep, 1)
})

test('每段都发：没有 step 号（老事件）不发', () => {
  const st = blank()
  takeInterim(st, { turn: 11, step: 1, text: 'A' })
  assert.equal(takeInterim(st, { turn: 11, step: undefined, text: 'B' }), null)
})

test('思考：只取 reasoning 块，不混正文', () => {
  const message = { content: [{ type: 'reasoning', text: '先想一下' }, { type: 'text', text: '要说的话' }] }
  assert.equal(reasoningOf(message), '先想一下')
  assert.equal(reasoningOf({ content: [{ type: 'text', text: '只有正文' }] }), '')
  assert.equal(reasoningOf(null), '')
})

test('捞回定稿：turn 131 那种「草稿 → 自检 → 定稿」', () => {
  const thinking = [
    'Devil: 鲸汐动态都是宝 — their dynamic posts are treasures (full of memes/stickers).',
    '',
    'Reply: 那我得常去翻——上回在她专栏评论区捞着两张会动的（鲸浪小姐卷成一团、结尾那张蛋糕图），这次又是白米饭<sticker:开心>',
    '要不我隔几天去扫一次，把会动的都收进来？你看合适吗。',
    '',
    "Careful: don't overpromise; she posts 动态 (opus), stickers in 评论区.",
    '',
    '3 lines:',
    '那可得常去翻——上一回在她专栏评论区捞到两张会动的（卷成一团的鲸浪小姐、结尾那张蛋糕），这回又是白米饭配我<sticker:开心>',
    '她的东西有个好处：梗都摆得明白，一看就知道在玩什么',
    '要不我隔几天去扫一遍她的动态和评论区，把会动的都收着，收的时候顺手记清出处',
  ].join('\n')
  const out = rescueFromThinking(thinking)
  assert.match(out, /^那可得常去翻/, '要的是定稿那版，不是 Reply 草稿')
  assert.match(out, /顺手记清出处$/)
  assert.ok(!out.includes('Careful'), '自检的英文旁白不该带出去')
  assert.ok(!out.includes('Reply:'), '草稿不该带出去')
  assert.ok(!out.includes('Devil:'), '对谁说的旁白不该带出去')
})

test('捞回定稿：没有定稿标记就不发（宁可不发也不发草稿）', () => {
  assert.equal(rescueFromThinking('Reply: 随便回一句\n\nCareful: 别乱说'), '')
  assert.equal(rescueFromThinking('只有内心独白，没有定稿'), '')
  assert.equal(rescueFromThinking(''), '')
  assert.equal(rescueFromThinking(null), '')
})

test('捞回定稿：中文行数标记也认', () => {
  const thinking = 'Reply: 草稿一版\n\n三行：\n第一句\n第二句\n第三句'
  assert.equal(rescueFromThinking(thinking), '第一句\n第二句\n第三句')
})

test('捞回定稿：定稿后面又跟了自检，要截掉', () => {
  const thinking = '2 lines:\n甲\n乙\n\nCareful: 别过头'
  assert.equal(rescueFromThinking(thinking), '甲\n乙')
})

test('捞回定稿：多个定稿标记时取最后一个', () => {
  const thinking = '3 lines:\n旧的一版\n\n后来改成：\n2 lines:\n新的一版上\n新的一版下'
  assert.equal(rescueFromThinking(thinking), '新的一版上\n新的一版下')
})
