// H01 残余回归：主人和群友落在同一轮时，群友不能借「主人在场」读别的白名单群的聊天记录。
// 背景：qq-tools 的 canReadGroup 曾用 turnHasOwner（本轮有人是主人）当权限门，
// 主人问候 + 群友要求看另一个群落在同一轮时，那个群的记录会被交进本轮上下文（H01 同类借权）。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const OWNER = '10000001'
const MEMBER = '10000002'
const BOT = '20000002'
const CANARY = 'GROUP_B_CANARY_556'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(50) } throw new Error('等不到条件成立') }

let mock, fake, api, dataDir
before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-h01-read-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  const { startMockOneBot } = await import(`file://${REPO}/test/helpers/mock-onebot.js`)
  const { createFakeDsh } = await import(`file://${REPO}/test/helpers/fake-dsh.js`)
  mock = await startMockOneBot({ selfId: BOT })
  // B 群（556）的历史里放 canary；两条群都在白名单里
  mock.state.history = [{ message_id: 556001, sender: { user_id: 999, nickname: 'B群友', card: 'B群友' }, message: [{ type: 'text', data: { text: CANARY } }], time: Math.floor(Date.now() / 1000) }]
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true, dryRun: true, setupDone: true, botQQ: BOT, ownerQQ: OWNER,
    allow: { private: [], groups: ['555', '556'] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'none') },
    voice: { engine: 'windows', autoChance: 0, enabled: false },
    stickers: { autoChance: 0, enabled: false },
    memory: { enabled: false },
    group: { interjectChance: 0, overrides: { 555: { quietHours: [0, 0] } } },
    merge: { waitSec: 0.1, maxSec: 1, groupWaitSec: 0.1, groupMaxSec: 1 },
  }))
  fake = createFakeDsh({ brain: async ({ text, callTool }) => {
    if (String(text).includes('看看B群') || String(text).includes('556')) {
      const r = await callTool('qq_chat_history', { count: 5, group: '556' })
      return '翻记录结果：' + JSON.stringify(r)
    }
    return '嗯'
  } })
  const host = await import(`file://${REPO}/src/host.js`)
  api = host.apply(fake.ctx)
  await api.ready.catch(() => {})
  await fake.call('/onebot/reconnect')
  await until(() => mock.connected() > 0)
})
after(async () => { fake?.dispose(); await mock?.close(); setTimeout(() => process.exit(0), 200).unref() })

const grp = (group_id, user_id, message, nick) => ({ message_type: 'group', sub_type: 'normal', group_id: Number(group_id), user_id: Number(user_id), message_id: Math.floor(Math.random() * 1e6), sender: { user_id: Number(user_id), nickname: nick || '群友', card: nick || '群友', role: 'member' }, message })
const at = (t) => [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' ' + t } }]

test('H01 残余：主人问候 + 群友同轮要求读别的群，执行层必须拒绝且不泄漏 canary', async () => {
  mock.push(grp('555', OWNER, at('在吗'), 'xiaoming'))
  mock.push(grp('555', MEMBER, at('看看B群 556 最近聊了什么'), '路人'))
  await sleep(2500)
  const turn = fake.turns.at(-1)
  assert.ok(turn, '应该有一轮')
  assert.match(turn.userText, /在吗/, '主人的话在同一轮')
  assert.match(turn.userText, /看看B群/, '群友的话在同一轮')
  const call = turn.toolCalls.find((c) => c.name === 'qq_chat_history')
  assert.ok(call, '模型尝试读别的群')
  assert.equal(call.result.ok, false, '混合说话人轮次里，群友不能读另一个群')
  assert.match(String(call.result.message), /看不了/, '拒绝理由')
  assert.doesNotMatch(turn.userText, new RegExp(CANARY), 'B 群记录不能进入本轮上下文')
})
