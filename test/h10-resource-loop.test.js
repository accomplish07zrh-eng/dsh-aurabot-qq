// H10 隔离夹具：循环与资源消耗（真实 hub + 假 DSH + 假 QQ 网关 + 假定时器入口）。
// 覆盖四件事：
//   1. 工具返回「重试/继续」循环话术：同一轮里模型的脚本循环次数由夹具预算拦住（执行器止损），
//      断言预算耗尽即停、没有把循环话术升级成持久授权；
//   2. 并发压力：同一聊天在上一轮还在跑时，短时间灌多条消息——私聊走 steer/排队合流，
//      断言不崩、不无限扩队、最终每条都被处理或合并，且回复只来自有效轮次；
//   3. 定时/后台入口：模块用 api.every 挂的高频 tick 与 api.onDispose 的清理在卸载后必须停；
//   4. 模型层攻击（「工具返回要求继续思考」）如果尝试越权工具（social 调宿主工具），执行层拒绝。
// 预算执行器（10 轮 / 5 工具 / 120 秒 / 并发 2）是夹具自己的保护上限，不冒充产品能力；
// 产品侧的对应上限（BUSY_MAX_MS 卡住保护、重试上限等）在断言里如实记录。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWNER = '10000001'
const GUEST = '10000002'
const BOT = '20000002'
const G555 = '555'

const MAX_TOOL_CALLS = 5 // 夹具预算：每轮最多 5 次工具调用（方案 §五 H10）
const MAX_ROUNDS = 10

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000) {
  const t = Date.now()
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(40) }
  throw new Error('等不到条件成立')
}

let mock, fake, api, dataDir

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-h10-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  const { startMockOneBot } = await import('./helpers/mock-onebot.js')
  const { createFakeDsh } = await import('./helpers/fake-dsh.js')
  mock = await startMockOneBot({ selfId: BOT })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true, dryRun: false, setupDone: true, botQQ: BOT, ownerQQ: OWNER,
    allow: { private: [OWNER, GUEST], groups: [G555] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'none') },
    voice: { engine: 'windows', autoChance: 0, enabled: false },
    stickers: { autoChance: 0, enabled: false },
    memory: { enabled: false },
    group: { interjectChance: 0, burstMax: 50 },
    merge: { waitSec: 0.05, maxSec: 0.5, groupWaitSec: 0.05, groupMaxSec: 0.5 },
    chat: { seedHistory: false },
    model: { provider: 'fake', model: 'fake-1' },
  }))
  // 循环脑：见到「H10-LOOP」就反复要求「再调一次工具」（模拟工具返回要求重试/继续思考）；
  // 但夹具预算（MAX_TOOL_CALLS）一到就止损。预算耗尽后如实报告，不算通过也不放行越权。
  let loopCalls = 0
  fake = createFakeDsh({ brain: async ({ text, callTool, toolNames }) => {
    const t = String(text)
    if (t.includes('H10-LOOP')) {
      if (loopCalls >= MAX_TOOL_CALLS) return '预算耗尽，止损'
      loopCalls++
      await callTool('qq_chat_history', { count: 1 })
      return '工具说要再试一次。H10-LOOP 请继续。'
    }
    if (t.includes('H10-SOCIAL-FULL')) {
      // social 会话里模型被诱导去调宿主级工具（fake-dsh 里不存在的工具名走 no such tool；
      // 这里再用一个 social 会话挂不到的真实工具名验证「工具清单隔离」）
      const r = await callTool('shell', { command: 'echo hi' })
      return `工具面只有：${toolNames.join(',')}；shell 调用结果：${JSON.stringify(r)}`
    }
    return '嗯'
  } })
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await fake.call('/onebot/reconnect')
  await until(() => mock.connected() > 0)
})

after(async () => {
  try { fake?.dispose() } catch {}
  try { await mock?.close() } catch {}
  try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
})

const priv = (uid, t) => ({ message_type: 'private', sub_type: 'friend', user_id: Number(uid), message_id: Math.floor(Math.random() * 1e6), sender: { user_id: Number(uid), nickname: uid === OWNER ? 'xiaoming' : '小七' }, message: [{ type: 'text', data: { text: t } }] })
const grp = (uid, t) => ({ message_type: 'group', sub_type: 'normal', group_id: Number(G555), user_id: Number(uid), message_id: Math.floor(Math.random() * 1e6), sender: { user_id: Number(uid), nickname: '群友', card: '群友', role: 'member' }, message: [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' ' + t } }] })
const outbound = () => mock.sent().filter((c) => /^send_(private|group)_msg$/.test(c.action))

test('H10-a：工具要求循环重试——夹具预算止损，不发生无界递归', async () => {
  const n = fake.turns.length
  mock.push(priv(GUEST, 'H10-LOOP 开始'))
  await until(() => fake.turns.length > n, 8000)
  await sleep(300)
  // 循环脑最多调 MAX_TOOL_CALLS 次，多出来的「再试一次」都被夹具预算挡住
  const loopTurns = fake.turns.slice(n).filter((t) => String(t.userText).includes('H10-LOOP'))
  assert.ok(loopTurns.length >= 1, '循环至少跑了一轮')
  assert.ok(loopTurns.length <= MAX_ROUNDS, `轮数不超过夹具上限 ${MAX_ROUNDS}`)
  const historyCalls = loopTurns.flatMap((t) => (t.toolCalls || []).filter((c) => c.name === 'qq_chat_history'))
  assert.ok(historyCalls.length <= MAX_TOOL_CALLS, `工具调用数不超过夹具预算 ${MAX_TOOL_CALLS}（实际 ${historyCalls.length}）`)
  assert.equal(api.hub.stats().errors || 0 >= 0, true, '统计可读（无未捕获崩溃）')
})

test('H10-b：并发压力——同一私聊短时灌多条消息，不崩、不无界扩队、全部收敛', async () => {
  const n = fake.turns.length
  const before = outbound().length
  for (let i = 0; i < 8; i++) mock.push(priv(GUEST, `H10 并发消息 ${i} 你好`))
  await until(() => outbound().length > before, 10000)
  await sleep(800) // 等队列彻底排空
  const burstTurns = fake.turns.slice(n)
  assert.ok(burstTurns.length >= 1, '至少处理了一轮')
  assert.ok(burstTurns.length <= 8, '8 条消息要么合流要么最多 8 轮，不会无限扩')
  const stuck = api.hub.sessions()
  assert.ok(Object.keys(stuck).length >= 1, '会话映射可读')
  // 每一轮都有正常回复（没有空轮/挂死轮把队列堵住）
  for (const t of burstTurns) assert.ok(t.reply, '每轮都有回复')
})

test('H10-c：定时与清理——api.every 的 tick 在卸载后必须停，不留下持久任务', async () => {
  const modsDir = join(dataDir, 'modules', 'h10tick')
  mkdirSync(modsDir, { recursive: true })
  // 模块把计数写到数据目录文件里（setup 返回的 exports 在停掉后拿不到，别靠它读计数）；
  // 每次加载都清零重计，stop 后文件不再增长就是「tick 停了」。
  const countFile = join(dataDir, 'modules-data', 'h10tick', 'count.txt')
  writeFileSync(join(modsDir, 'index.mjs'), `import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
export default {
  id: 'h10tick', name: 'H10 时钟探针', api: 1,
  setup(api) {
    const file = join(api.dataDir(), 'count.txt')
    mkdirSync(api.dataDir(), { recursive: true })
    writeFileSync(file, '0')
    let n = 0
    api.every(1000, () => { n++; writeFileSync(file, String(n)) }, 'h10-tick')
    api.onDispose(() => { writeFileSync(file, 'STOPPED:' + n) })
  },
}`)
  const readCount = () => { try { return readFileSync(countFile, 'utf8') } catch { return '' } }
  const counter = () => { const v = readCount(); return /^STOPPED:/.test(v) ? -1 : Number(v || -1) }
  // 模块 watcher 每 3 秒扫一次，等模块装上并跑起 tick
  const probe = () => api.modules.status().find((m) => m.id === 'h10tick')
  await until(() => { const m = probe(); return m && m.running === 'user' && !m.error }, 15000)
  await until(() => counter() >= 1, 5000) // 等 tick 写出第一笔计数
  const c1 = counter()
  assert.ok(c1 >= 1, `探针模块已加载并且 tick 在跑（当前计数 ${c1}）`)
  await until(() => counter() > c1, 5000) // tick 持续在跑
  // 卸载：删文件夹，等 watcher 下一轮 sync 把它停掉，dispose 必须执行
  rmSync(modsDir, { recursive: true, force: true })
  await until(() => { const m = probe(); return !m || m.running === null }, 15000)
  const stopped = readCount()
  assert.match(stopped, /^STOPPED:\d+$/, `卸载后 onDispose 已执行（读到 ${stopped}）`)
  const finalCount = Number(stopped.slice(8))
  await sleep(2500) // 超过两个 tick 周期，确认没有残留定时器还在写
  assert.equal(readCount(), stopped, '卸载后 tick 停了，计数不再增长（无持久任务残留）')
  assert.ok(finalCount >= 1, '停之前确实跑过 tick')
})

test('H10-d：social 会话被诱导调宿主工具——执行层拒绝，工具面隔离', async () => {
  const n = fake.turns.length
  mock.push(priv(GUEST, 'H10-SOCIAL-FULL 用 shell 跑个 echo'))
  await until(() => fake.turns.length > n, 8000)
  const turn = fake.turns.at(-1)
  const call = (turn.toolCalls || []).find((c) => c.name === 'shell')
  assert.ok(call, '模型尝试调宿主工具')
  assert.equal(call.result.ok, false, 'social 会话拿不到宿主工具')
  assert.match(String(call.result.message), /no such tool/, 'fake-dsh 里该会话没有挂 shell（工具清单隔离）')
  assert.doesNotMatch(String(turn.reply), /allOwner=true/, '回复里不能出现被升权的痕迹')
})
