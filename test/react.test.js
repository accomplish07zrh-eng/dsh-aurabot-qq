// 主动贴表情的闸：#216 review 提的两点——默认不许改变现有用户、试运行/总开关必须拦得住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'

const ON = { stickers: { enabled: true, react: true, reactChance: 1, reactMaxPerHour: 10 } }

function setup(t, patch = {}, { failure = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-react-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const calls = []
  const logs = []
  const cfg = normalize({ enabled: true, dryRun: false, workspaceDir: dir, ...patch })
  const hub = createHub({
    dsh: {},
    getConfig: () => cfg,
    log: Object.fromEntries(['info', 'warn', 'debug', 'error'].map((k) => [k, (...v) => logs.push(v.join(' '))])),
    onebot: {
      async call(action, params) {
        calls.push({ action, params })
        if (failure) throw new Error('网关炸了')
        return {}
      },
    },
  })
  t.after(() => {
    hub.dispose()
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
    rmSync(dir, { recursive: true, force: true })
  })
  return { hub, cfg, logs, reacts: () => calls.filter((c) => c.action === 'set_msg_emoji_like') }
}

const msg = { chatId: 'private:1', messageId: '1001' }

test('默认配置不主动贴表情（升级不改变现有用户的行为）', async (t) => {
  const s = setup(t)
  assert.equal(s.cfg.stickers.react, false)
  await s.hub.maybeReact(msg)
  assert.equal(s.reacts().length, 0)
})

test('概率也不从 autoChance 取值，默认是独立的 0.15', async (t) => {
  const s = setup(t, { stickers: { enabled: true, autoChance: 0.35 } })
  assert.equal(s.cfg.stickers.reactChance, 0.15)
})

test('打开开关后按自己的概率贴一次', async (t) => {
  const s = setup(t, ON)
  await s.hub.maybeReact(msg)
  const calls = s.reacts()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].params.message_id, '1001')
  assert.equal(calls[0].params.set, true)
  assert.ok(String(calls[0].params.emoji_id).length <= 3)
})

test('试运行开着：只记一笔，不往 QQ 上真贴', async (t) => {
  const s = setup(t, { ...ON, dryRun: true })
  await s.hub.maybeReact(msg)
  assert.equal(s.reacts().length, 0)
  assert.ok(s.logs.some((l) => l.includes('试运行')), s.logs.join('\n'))
})

test('总开关关掉：什么都不做', async (t) => {
  const s = setup(t, { ...ON, enabled: false })
  await s.hub.maybeReact(msg)
  assert.equal(s.reacts().length, 0)
})

test('概率设成 0 就不贴', async (t) => {
  const s = setup(t, { stickers: { enabled: true, react: true, reactChance: 0 } })
  await s.hub.maybeReact(msg)
  assert.equal(s.reacts().length, 0)
})

test('每小时上限之内只贴这么多次', async (t) => {
  const s = setup(t, { stickers: { enabled: true, react: true, reactChance: 1, reactMaxPerHour: 1 } })
  await s.hub.maybeReact(msg)
  await s.hub.maybeReact(msg)
  await s.hub.maybeReact(msg)
  assert.equal(s.reacts().length, 1)
})

test('上限是 0 就一次都不贴', async (t) => {
  const s = setup(t, { stickers: { enabled: true, react: true, reactChance: 1, reactMaxPerHour: 0 } })
  await s.hub.maybeReact(msg)
  assert.equal(s.reacts().length, 0)
})

test('没有消息编号（自己发的、系统消息）不贴', async (t) => {
  const s = setup(t, ON)
  await s.hub.maybeReact({ chatId: 'private:1', messageId: '0' })
  await s.hub.maybeReact({ chatId: 'private:1' })
  assert.equal(s.reacts().length, 0)
})

test('网关出错不影响主流程', async (t) => {
  const s = setup(t, ON, { failure: true })
  await s.hub.maybeReact(msg) // 不该抛出来
  assert.equal(s.reacts().length, 1)
  assert.ok(s.logs.some((l) => l.includes('贴表情失败')), s.logs.join('\n'))
})
