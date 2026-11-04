// 自驱引擎 P0.2~0.4：后台会话点名 preset（chat.presetId）。
// 口径（docs/AUTOTELIC-PLAN.md §3 P0 / §4.2）：
// - 只有主人开了 ext.autotelic.presetIdOverride 才生效（默认关，行为完全不变）；
// - noTools 永远压过 presetId；
// - level 判定与 presetFor 都不动（system 会话不许拿到主人专属工具）；
// - preset 变了走重建（复用键 entry.preset 不匹配），连续同参调用不重建会话。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { normalize } from '../src/core/config.js'
import { createHub } from '../src/chat/hub.js'

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate) }

function setup(t, { presetIdOverride = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-autotelic-preset-'))
  const oldDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = join(root, 'data')
  const fake = createFakeDsh({ brain: async () => '' })
  const cfg = normalize({ enabled: true, dryRun: true, workspaceDir: join(root, 'workspace'), ext: { autotelic: { presetIdOverride } } })
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((k) => [k, (...v) => fake.logs.push(v.join(' '))]))
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg, log, onebot: {}, buildTools: () => [] })
  fake.ctx.effect(() => fake.ctx.on('session/event', hub.onSessionEvent))
  const creates = []
  const create = fake.ctx.services.sessionController.create
  fake.ctx.services.sessionController.create = async (args) => {
    creates.push(args.agentPreset)
    const r = await create(args)
    const agent = fake.agents.get(r.sessionId)
    agent.followup = (message) => { fake.lastMessage = message; return new Promise(() => {}) }
    agent.cancel = () => {}
    agent.whenIdle = async () => {}
    return r
  }
  t.after(() => {
    hub.dispose()
    fake.dispose()
    if (oldDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = oldDir
    rmSync(root, { recursive: true, force: true })
  })
  const run = (opts = {}) => hub.runSystemTurn('autotelic', '自驱测试', '想一想', { timeoutMs: 60_000, ...opts })
  const end = (agent, text = '好了') => {
    fake.emit('session/event', agent.session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text }] } } })
    fake.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  }
  const lastAgent = () => [...fake.agents.values()].at(-1)
  return { fake, hub, creates, run, end, lastAgent }
}

test('开关关着（默认）：presetId 被忽略，照旧用 aurabot-social——行为完全不变', async (t) => {
  const s = setup(t, { presetIdOverride: false })
  const work = s.run({ presetId: 'aurabot-autotelic' })
  await settle()
  assert.deepEqual(s.creates, ['aurabot-social'], '没开覆盖开关就绝不换 preset')
  s.end(s.lastAgent())
  assert.equal(await work, '好了')
})

test('noTools 永远压过 presetId：纯文本回合不许借机拿到工具', async (t) => {
  const s = setup(t, { presetIdOverride: true })
  const work = s.run({ presetId: 'aurabot-autotelic', noTools: true })
  await settle()
  assert.deepEqual(s.creates, ['aurabot-social'], 'noTools 时 presetId 不生效')
  s.end(s.lastAgent())
  await work
})

test('开关开了：system:autotelic 会话拿到 aurabot-autotelic preset；连续两轮不重建会话', async (t) => {
  const s = setup(t, { presetIdOverride: true })
  const first = s.run({ presetId: 'aurabot-autotelic' })
  await settle()
  assert.deepEqual(s.creates, ['aurabot-autotelic'])
  const agent1 = s.lastAgent()
  s.end(agent1)
  assert.equal(await first, '好了')
  // 第二轮同参：复用键（entry.preset）不匹配不了——必须复用同一个会话，只出现一次「新建了 DSH 会话」
  const second = s.run({ presetId: 'aurabot-autotelic' })
  await settle()
  assert.equal(s.creates.length, 1, '同一 chatId + 同 preset 不再新建会话')
  s.end(s.lastAgent())
  assert.equal(await second, '好了')
})

test('不带 presetId 的普通后台调用照旧拿 aurabot-social（回归：默认路径零变化）', async (t) => {
  const s = setup(t, { presetIdOverride: true })
  const work = s.run()
  await settle()
  assert.deepEqual(s.creates, ['aurabot-social'])
  s.end(s.lastAgent())
  await work
})
