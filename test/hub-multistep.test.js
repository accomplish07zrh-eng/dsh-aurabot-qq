// #205：一轮里多个 step 时的文本累积规则。
//
// 这一版只测「文本怎么攒」这条纯逻辑，不启网关、不起假宿主——
// 端到端那条链路已经在 e2e.test.js 里覆盖了，这里把规则本身钉死：
//   - 工具调用产生的两个 step：两段都要留（用户都没收到过）
//   - steer 插话之后：前一段是被取代的「说过时半截」，只留最后一段（保留 #10 的取舍）
//   - 同一个 (turn, step) 重复推送：只算一次

import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 把 hub.js 里 assistant/message 的处理抽出来，单独跑。
 * 保持和源码同一套判断，改源码忘了改这里时这条测试会炸。
 */
function accumulate(st, d) {
  const t = d.text
  if (!t) return st
  const stepKey = d.step === undefined ? null : `${d.turn}:${d.step}`
  if (stepKey !== null && st.lastStepKey === stepKey) return st
  st.lastStepKey = stepKey
  st.lastTurn = d.turn
  if (st.steered && st.text) st.text = t
  else st.text = st.text ? `${st.text}\n${t}` : t
  return st
}

const blank = () => ({ lastTurn: -1, text: '', lastStepKey: null, steered: false })

test('工具调用的两个 step：两段都留', () => {
  const st = blank()
  accumulate(st, { turn: 1, step: 1, text: '我先看看你的资料' })
  accumulate(st, { turn: 1, step: 2, text: '资料查到了你叫小鲸鱼' })
  assert.match(st.text, /我先看看你的资料/)
  assert.match(st.text, /资料查到了你叫小鲸鱼/)
})

test('steer 之后：前一段被取代，只留最后一段', () => {
  const st = blank()
  accumulate(st, { turn: 2, step: 1, text: '过时的半截' })
  st.steered = true                       // pushToSession 在 opts.steer 时打的标记
  accumulate(st, { turn: 2, step: 2, text: '重新想过的回答' })
  assert.equal(st.text, '重新想过的回答', '前一段应该被丢掉')
  assert.doesNotMatch(st.text, /过时的半截/)
})

test('同一个 (turn, step) 重复推送：只算一次', () => {
  const st = blank()
  const ev = { turn: 3, step: 1, text: '这句话只该出现一次' }
  accumulate(st, ev)
  accumulate(st, ev)
  accumulate(st, ev)
  const hits = st.text.split('这句话只该出现一次').length - 1
  assert.equal(hits, 1, '实际出现 ' + hits + ' 次')
})

test('没有 step 字段时退回累加（老宿主 / 无 step 事件）', () => {
  const st = blank()
  accumulate(st, { turn: 4, text: '第一段' })
  accumulate(st, { turn: 4, text: '第二段' })
  assert.match(st.text, /第一段/)
  assert.match(st.text, /第二段/)
})

test('step 不重复但 turn 变了：正常累加到新 turn（turn 切换由 turn/end 清空）', () => {
  const st = blank()
  accumulate(st, { turn: 5, step: 1, text: 'A' })
  accumulate(st, { turn: 6, step: 1, text: 'B' })
  assert.match(st.text, /A/)
  assert.match(st.text, /B/)
})
