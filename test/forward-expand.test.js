// 合并转发展开（PR #241）的回归：占位符替换、超时口径、开关、以及「别把同一条转发拉两次」。
// 面板与接线用源码契约断言（这个仓库的客户端没有构建产物，只能在源码上钉住）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyForwardBodies, readForward, FORWARD_PLACEHOLDER } from '../src/chat/forward.js'
import { normalize } from '../src/core/config.js'

const hubSrc = readFileSync(new URL('../src/chat/hub.js', import.meta.url), 'utf8')
const clientSrc = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

const node = (name, message) => ({ sender: { nickname: name, user_id: 2 }, message })
const text = (t) => ({ type: 'text', data: { text: t } })
const forward = (id) => ({ type: 'forward', data: { id } })

test('占位符按顺序换成内容，内容里再出现占位符也不错位', () => {
  // 第二个 body 里本身就带占位符（嵌套转发没展开时的样子）：不能被后一条替换吃掉
  const body1 = '[合并转发的聊天记录（1 条）]\n甲：第一段 ' + FORWARD_PLACEHOLDER + '\n[转发结束]'
  const out = applyForwardBodies(`${FORWARD_PLACEHOLDER} 和 ${FORWARD_PLACEHOLDER}`, [body1, '第二个'])
  assert.ok(out.startsWith(body1), '第一段要原样落位')
  assert.ok(out.endsWith(' 和 第二个'), '第二段接在后面')
})

test('内容比占位符少时，剩下的占位符留着，不吞文案', () => {
  const out = applyForwardBodies(`A${FORWARD_PLACEHOLDER}B${FORWARD_PLACEHOLDER}C`, ['X'])
  assert.equal(out, `AXB${FORWARD_PLACEHOLDER}C`)
})

test('没有占位符时原样返回', () => {
  assert.equal(applyForwardBodies('就是一句普通的话', ['X']), '就是一句普通的话')
  assert.equal(applyForwardBodies(undefined, []), '')
})

test('拉转发的超时可以传下去，嵌套那一层也跟着走', async () => {
  const seen = []
  const onebot = {
    async call(action, params, opts) {
      seen.push(opts?.timeoutMs)
      return { messages: params.id === 'a' ? [node('甲', [text('第一层'), forward('b')])] : [node('乙', [text('第二层')])] }
    },
  }
  await readForward(onebot, 'a', { selfId: 9, timeoutMs: 5000 })
  assert.deepEqual(seen, [5000, 5000], '外层与嵌套都该用传进来的超时')
  seen.length = 0
  await readForward(onebot, 'a', { selfId: 9 })
  assert.deepEqual(seen, [15000, 15000], '不传时仍是 15000')
})

test('两个开关默认关，单开互不影响，老配置自动补段', () => {
  const base = normalize({})
  assert.equal(base.forward.expandEarly, false)
  assert.equal(base.forward.expandHistory, false)
  assert.equal(normalize({ forward: { expandEarly: true } }).forward.expandHistory, false)
  assert.equal(normalize({ forward: { expandHistory: true } }).forward.expandEarly, false)
  // 老配置里没有 forward 这一段，别的字段不能因此丢
  const old = normalize({ merge: { groupMaxSec: 20 } })
  assert.equal(old.merge.groupMaxSec, 20)
  assert.equal(old.forward.expandEarly, false)
})

// ---------- 走一遍真实消息管线：开关到底有没有接上 ----------
function setup(t, { forward: fwd, allowed = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-fwd-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const calls = []
  const cfg = normalize({ enabled: true, dryRun: true, ownerQQ: '1', botQQ: '9', workspaceDir: dir,
    allow: { groups: allowed ? ['777'] : [] }, forward: fwd })
  const log = { info() {}, debug() {}, error() {}, warn() {} }
  const onebot = {
    async call(action, params) {
      if (action === 'get_forward_msg') {
        calls.push(params.id)
        return { messages: [node('甲', [text('转发里的原话')])] }
      }
      return []
    },
  }
  const hub = createHubRef({ dsh: {}, getConfig: () => cfg, log, onebot })
  t.after(() => {
    hub.dispose()
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { hub, calls }
}

const groupEvent = (extra = []) => ({
  post_type: 'message', message_type: 'group', sub_type: 'normal',
  self_id: 9, group_id: 777, user_id: 2, message_id: 11,
  sender: { user_id: 2, nickname: '甲' },
  message: [{ type: 'text', data: { text: '看这个' } }, forward('fw1'), ...extra],
})

let createHubRef = null
test('早展开开着：消息一进来就拉一次（哪怕这条不回她）', async (t) => {
  const { createHub } = await import('../src/chat/hub.js')
  createHubRef = createHub
  const { hub, calls } = setup(t, { forward: { expandEarly: true } })
  await hub.onMessage(groupEvent())
  assert.deepEqual(calls, ['fw1'], '没叫她也要展开，否则之后问她看不见')
})

test('早展开关着：不叫她的时候一次都不拉', async (t) => {
  const { createHub } = await import('../src/chat/hub.js')
  createHubRef = createHub
  const { hub, calls } = setup(t, { forward: { expandHistory: true } })
  await hub.onMessage(groupEvent())
  assert.deepEqual(calls, [], '只开补展开时，别在入缓冲时就消耗接口')
})

// ---------- 源码契约 ----------
test('契约：缓冲条目记得转发 id，早展开后打上已展开标记', () => {
  assert.match(hubSrc, /forwards: msg\.forwards\?\.length \? \[\.\.\.msg\.forwards\] : undefined/, 'groupEntry 要带 forwards，补展开才有 id 可用')
  assert.match(hubSrc, /groupEntry\.forwardExpanded = true/, '早展开要写到缓冲条目上，不然拼提示词时会再拉一次')
})

test('契约：原来的展开路径给已展开的让路，补展开先标记再拉', () => {
  assert.match(hubSrc, /if \(msg\.forwards\?\.length && !msg\.forwardExpanded\)/, '交给她时不能重复展开')
  assert.match(hubSrc, /x\.forwardExpanded = true \/\/ 先标记再拉/, '补展开要先置位，避免重触发时二次消耗')
})

test('契约：引用里套的合并转发也展开，字数上限单独放宽', () => {
  assert.match(hubSrc, /parsed\.forwards\?\.length && getConfig\(\)\.forward\?\.expandEarly/, '引用路径要受开关控制')
  assert.match(hubSrc, /const QUOTE_FORWARD_MAX_CHARS = 1200/, '转发正文放宽到 1200，普通引用仍 300')
  assert.match(hubSrc, /out\.text = String\(parsed\.text \|\| ''\)\.trim\(\)\.slice\(0, 300\)/, '普通引用的 300 别动')
})

test('契约：面板上有这两个开关', () => {
  assert.ok(clientSrc.includes("title: '合并转发'"), '面板缺「合并转发」卡')
  assert.ok(clientSrc.includes("f.sw('forward.expandEarly')"), '缺早展开开关')
  assert.ok(clientSrc.includes("f.sw('forward.expandHistory')"), '缺补展开开关')
})
