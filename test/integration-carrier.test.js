// 载体分发集成测试（purpose → pet，PROJECT_MAP §14 / PET_MODULE_API §4）：
//   · carrier=pet 且桌宠在线 → 只推气泡（pet.dispatch 一次），本轮不发 QQ
//   · carrier=pet 离线 + petFallbackToQQ=true → 回落走原 hub.deliver 发 QQ
//   · carrier=pet 离线 + petFallbackToQQ=false → 本轮静默（不硬补）
//   · carrier=qq（默认）→ 行为与从前完全一致（QQ 投递，不碰 pet）
//   · pet 模块没在跑（api.use('pet')=null）按离线处理；专注模式（dispatch 返回 focus）静默不回落
//   · 互斥铁律：任何情形一轮只发一处
// 落盘测试：AURABOT_DATA_DIR 隔离（R14），每个用例独立目录。
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let createPurpose
const OWNER = '10000001'

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-carrier-'))
  ;({ createPurpose } = await import('../src/purpose/module.js'))
})

beforeEach(() => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-carrier-'))
})

// 假 hub：deliver 记录投递（成功返回 {missedAt:[]}，同 hub.deliver 契约）
function makeHub() {
  return {
    lastOwnerChatAt: 0,
    lastBotToOwner: { at: 0, text: '' },
    chatLogDays: () => [],
    chatLogOf: () => [],
    delivered: [],
    async runSystemTurn() { return '主人，想到一件事想跟你说' },
    async deliver(chatId, text) { this.delivered.push({ chatId, text }); return { missedAt: [] } },
  }
}

// 假 pet：online()/dispatch() 可脚本化（同 pet 模块导出契约）
function makePet({ online = true, dispatchResult = null, throwOnDispatch = false } = {}) {
  const calls = []
  return {
    calls,
    online: () => ({ online, lastSeenAt: online ? Date.now() : 0, clients: online ? 1 : 0 }),
    focus: () => false,
    async dispatch(args) {
      calls.push(args)
      if (throwOnDispatch) throw new Error('dispatch 炸了')
      return dispatchResult ?? { ok: true, via: 'pet', message: { type: 'proactive', text: args.text } }
    },
  }
}

function runPurpose(hub, pet, extSpeakup = {}, extOverrides = {}) {
  const cfg = {
    enabled: true, ownerQQ: OWNER, ownerName: '主人',
    speakUp: { enabled: true, awakeFrom: 0, awakeTo: 24, idleMinutes: 30, maxPerDay: 10 },
    ext: { speakup: { minMaterials: 0, ...extSpeakup }, pet: { ...extOverrides } },
  }
  const p = createPurpose({
    getConfig: () => cfg,
    setConfig: (patch) => { Object.assign(cfg, patch) },
    hub,
    log: { info() {}, warn() {}, debug() {} },
    isMuted: () => false,
    mood: () => null,
    memory: () => ({ list: () => [{ id: 'm1', text: '主人喜欢打两把游戏', importance: 0.8, at: Date.now() }] }),
    personaText: () => '',
    pet: () => pet,
  })
  return p.fire('集成测试').then((r) => ({ r, cfg, p }))
}

test('carrier=pet 且桌宠在线：只推气泡（dispatch 一次、带 purpose 标签），本轮不发 QQ，结算 sent', async () => {
  const hub = makeHub()
  const pet = makePet({ online: true })
  const { r, cfg, p } = await runPurpose(hub, pet, { carrier: 'pet', petFallbackToQQ: true })
  assert.equal(r.outcome, 'sent')
  assert.equal(pet.calls.length, 1, 'pet.dispatch 恰好一次')
  assert.equal(pet.calls[0].text, '主人，想到一件事想跟你说', '气泡推的是本轮生成的发言')
  assert.ok(pet.calls[0].purpose, '事件带 purpose 字段（PET_MODULE_API 契约）')
  assert.equal(hub.delivered.length, 0, '互斥：本轮不发 QQ')
  assert.equal(p.state().lastOutcome, 'sent')
  assert.equal(p.state().countToday, 1)
  assert.equal(cfg.ext.pet.carrier, 'pet', '投递前对齐 pet 侧镜像设置')
})

test('carrier=pet 桌宠离线 + petFallbackToQQ=true：回落走原 hub.deliver 发 QQ，不碰 dispatch', async () => {
  const hub = makeHub()
  const pet = makePet({ online: false })
  const { r } = await runPurpose(hub, pet, { carrier: 'pet', petFallbackToQQ: true })
  assert.equal(r.outcome, 'sent')
  assert.equal(pet.calls.length, 0, '离线不调 dispatch（回落由 purpose 自己发，保住 own/userText 链路）')
  assert.equal(hub.delivered.length, 1)
  assert.equal(hub.delivered[0].chatId, `private:${OWNER}`)
})

test('carrier=pet 桌宠离线 + petFallbackToQQ=false：本轮静默，QQ 与桌宠都不发', async () => {
  const hub = makeHub()
  const pet = makePet({ online: false })
  const { r, p } = await runPurpose(hub, pet, { carrier: 'pet', petFallbackToQQ: false })
  assert.equal(r.outcome, 'silent')
  assert.equal(pet.calls.length, 0)
  assert.equal(hub.delivered.length, 0)
  assert.equal(p.state().lastOutcome, 'silent')
})

test('carrier=qq（默认）：行为与从前完全一致——QQ 投递，完全不碰 pet、不写 ext.pet 镜像', async () => {
  const hub = makeHub()
  const pet = makePet({ online: true })
  const before = { carrier: 'qq', petFallbackToQQ: true }
  const { r, cfg } = await runPurpose(hub, pet, {}, before)
  assert.equal(r.outcome, 'sent')
  assert.equal(hub.delivered.length, 1)
  assert.equal(hub.delivered[0].chatId, `private:${OWNER}`)
  assert.equal(pet.calls.length, 0, 'carrier=qq 不碰 pet')
  assert.deepEqual(cfg.ext.pet, before, 'ext.pet 镜像未被改动')
})

test('carrier=pet 但 pet 模块没在跑（use 返回 null）+ 回落开：按离线处理，发 QQ', async () => {
  const hub = makeHub()
  const { r } = await runPurpose(hub, null, { carrier: 'pet', petFallbackToQQ: true })
  assert.equal(r.outcome, 'sent')
  assert.equal(hub.delivered.length, 1, '没跑 + 回落开 → 发 QQ')
})

test('carrier=pet 但 pet 模块没在跑（use 返回 null）+ 回落关：静默不硬补', async () => {
  const hub2 = makeHub()
  const { r, p } = await runPurpose(hub2, null, { carrier: 'pet', petFallbackToQQ: false })
  assert.equal(r.outcome, 'silent', '没跑 + 回落关 → 静默')
  assert.equal(hub2.delivered.length, 0)
  assert.equal(p.state().lastOutcome, 'silent')
})

test('carrier=pet 在线但专注模式开着（dispatch 返回 focus）：不发也不回落，记 silent', async () => {
  const hub = makeHub()
  const pet = makePet({ online: true, dispatchResult: { ok: false, reason: 'focus' } })
  const { r } = await runPurpose(hub, pet, { carrier: 'pet', petFallbackToQQ: true })
  assert.equal(r.outcome, 'silent')
  assert.equal(pet.calls.length, 1, 'dispatch 被询问了一次')
  assert.equal(hub.delivered.length, 0, '专注模式：QQ 也不回落')
})
