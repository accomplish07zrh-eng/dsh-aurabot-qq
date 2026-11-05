// 分条发出的中间段（chat.everyStep）记账：只记一次、失败不记、多段按顺序发（#214 review）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'

const SID = 'session-test-1'
const CHAT = 'private:1'

function setup(t, { fails = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-interim-log-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  // 会话 → 聊天 的持久化映射：重启后内存映射为空时靠它兜底（#159）
  writeFileSync(join(dir, 'sessions.json'), JSON.stringify({ chats: { [CHAT]: { sessionId: SID } } }))
  const calls = []
  const cfg = normalize({
    enabled: true,
    dryRun: false,
    workspaceDir: dir,
    chat: { everyStep: true },
    voice: { enabled: false },
    stickers: { enabled: false },
  })
  const hub = createHub({
    dsh: {},
    stickers: { match: () => null, segmentFor: () => null, pickForReply: () => null, markUsed: () => {} },
    getConfig: () => cfg,
    log: Object.fromEntries(['info', 'warn', 'debug', 'error'].map((k) => [k, () => {}])),
    onebot: {
      async call(action, params) {
        if (fails) throw new Error('网关没连上')
        calls.push({ action, params })
        return { message_id: 1, status: 'ok' }
      },
    },
  })
  t.after(() => {
    hub.dispose()
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
    rmSync(dir, { recursive: true, force: true })
  })
  return { hub, calls, dir }
}

const textOf = (message) => ({ content: [{ type: 'text', text: message }] })
const step = (turn, s, text) => ({ type: 'assistant/message', data: { turn, step: s, message: textOf(text) } })
const end = (turn) => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })

/** 等到 chatlog 里出现某段文字（或超时）。中间段是不 await 的，得给点时间。 */
async function waitFor(fn, ms = 1500) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return false
}

function chatlogTexts(dir) {
  const dir2 = join(dir, 'chatlog')
  try {
    return readdirSync(dir2)
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => readFileSync(join(dir2, f), 'utf8').split('\n').filter(Boolean))
      .map((line) => { try { return JSON.parse(line) } catch { return null } })
      .filter((x) => x && x.who === 'bot')
      .map((x) => String(x.text || ''))
  } catch { return [] }
}

test('中间段只记一次：deliver 记账后不再重复记', async (t) => {
  const s = setup(t)
  const session = { id: SID }
  s.hub.onSessionEvent(session, step(1, 1, '第一段话'))
  s.hub.onSessionEvent(session, step(1, 2, '第二段话'))
  s.hub.onSessionEvent(session, end(1))
  assert.ok(await waitFor(() => chatlogTexts(s.dir).some((x) => x.includes('第二段话'))), '最后一段要发出来')
  const texts = chatlogTexts(s.dir)
  assert.equal(texts.filter((x) => x.includes('第一段话')).length, 1, '中间段在流水里只该有一条：' + JSON.stringify(texts))
  assert.equal(texts.filter((x) => x.includes('第二段话')).length, 1, '最后一段也只该有一条：' + JSON.stringify(texts))
})

test('中间段发送失败就不记流水：没发出去的话不算说过', async (t) => {
  const s = setup(t, { fails: true })
  const session = { id: SID }
  s.hub.onSessionEvent(session, step(1, 1, '这段发不出去'))
  s.hub.onSessionEvent(session, step(1, 2, '这段也发不出去'))
  s.hub.onSessionEvent(session, end(1))
  await new Promise((r) => setTimeout(r, 300))
  const texts = chatlogTexts(s.dir)
  assert.ok(!texts.some((x) => x.includes('这段发不出去')), '发失败不该记：' + JSON.stringify(texts))
})

test('多段按顺序发：前一段发完才发下一段', async (t) => {
  const s = setup(t)
  const session = { id: SID }
  s.hub.onSessionEvent(session, step(1, 1, '甲段'))
  s.hub.onSessionEvent(session, step(1, 2, '乙段'))
  s.hub.onSessionEvent(session, step(1, 3, '丙段'))
  s.hub.onSessionEvent(session, end(1))
  assert.ok(await waitFor(() => chatlogTexts(s.dir).filter((x) => /甲段|乙段|丙段/.test(x)).length >= 3), '三段都要发出去')
  const order = s.calls
    .map((c) => (c.params && c.params.message ? c.params.message.map((x) => x.data?.text || '').join('') : ''))
    .filter((x) => /甲段|乙段|丙段/.test(x))
    .map((x) => (x.includes('甲段') ? '甲' : x.includes('乙段') ? '乙' : '丙'))
  assert.deepEqual(order, ['甲', '乙', '丙'], '发出顺序要和生成顺序一致：' + JSON.stringify(order))
})
