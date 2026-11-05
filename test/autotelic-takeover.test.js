// 浏览模块接管（docs/AUTOTELIC-TAKEOVER.md）：探测 / 备份压制 / 还原 / 重压 / 兜底。
// 全 fake 内存配置，不碰真文件系统、不碰真模块——纯逻辑单测。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  probeTakeovers, applyTakeover, restoreTakeover, findFlipped, repressTakeover, takeoverView,
  AUTONOMY_KEY, EXCEPTIONS,
} from '../src/autotelic/takeover.js'

/** 内存配置：getConfig 读它，setConfig 深合并写它（跟 modules.js 的 deepMerge 一个口径）。 */
function memConfig(initial = {}) {
  let cfg = structuredClone(initial)
  const deepMerge = (base, patch) => {
    const out = { ...base }
    for (const [k, v] of Object.entries(patch || {})) {
      out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object')
        ? deepMerge(base[k], v)
        : v
    }
    return out
  }
  return {
    get: () => cfg,
    set: (patch) => { cfg = deepMerge(cfg, patch) },
    raw: () => cfg,
  }
}

// 真机形状：douyin/bili 在顶层（旧写法），tophub/meme-wiki 在 ext（新写法）
const REAL_SHAPE = {
  douyin: { enabled: true, autoBrowse: true, intervalHours: 1, maxRunsPerDay: 11 },
  bili: { enabled: true, autoBrowse: true, intervalHours: 1, maxRunsPerDay: 11 },
  phone: { enabled: false, autoBrowse: false },
  ext: {
    tophub: { enabled: true, shareLimit: 2, nodes: ['微博热搜'] },
    'meme-wiki': { enabled: true }, // 没有 autoBrowse，不该被误报
    purpose: { enabled: true },
    autotelic: { enabled: true },
  },
}

test('探测：顶层与 ext 两种位置的 autoBrowse 都扫出来，没有的不误报', () => {
  const mc = memConfig(REAL_SHAPE)
  const r = probeTakeovers({ getConfig: mc.get, liveIds: ['douyin', 'bili', 'phone', 'tophub', 'meme-wiki', 'purpose'] })
  const ids = r.map((x) => `${x.id}|${x.scope}|${x.key}`)
  assert.ok(ids.includes('douyin||autoBrowse'), `douyin 在顶层：${ids}`)
  assert.ok(ids.includes('bili||autoBrowse'), 'bili 在顶层')
  assert.ok(ids.includes('phone||autoBrowse'), 'phone 也有 autoBrowse（虽然是 false，也是家族）')
  assert.ok(ids.includes('tophub|ext|shareLimit'), 'tophub 走例外表压 shareLimit')
  assert.ok(!ids.some((x) => /meme-wiki|purpose/.test(x)), '没有自动循环的模块不许误报')
})

test('探测只认「在跑」的模块：没跑的 id 不扫（不替没装的模块操心）', () => {
  const mc = memConfig(REAL_SHAPE)
  const r = probeTakeovers({ getConfig: mc.get, liveIds: ['douyin'] })
  assert.equal(r.length, 1)
  assert.equal(r[0].id, 'douyin')
})

test('探测带上原值：autoBrowse 原 true / tophub 原 shareLimit 2', () => {
  const mc = memConfig(REAL_SHAPE)
  const r = probeTakeovers({ getConfig: mc.get, liveIds: ['douyin', 'tophub'] })
  assert.equal(r.find((x) => x.id === 'douyin').from, true)
  assert.equal(r.find((x) => x.id === 'tophub').from, 2, '例外键的原值也要留着')
})

test('接管：备份原值 + 压制为 false/0，且不碰模块总开关 enabled', () => {
  const mc = memConfig(REAL_SHAPE)
  const probe = probeTakeovers({ getConfig: mc.get, liveIds: ['douyin', 'bili', 'tophub'] })
  const backup = applyTakeover({ getConfig: mc.get, setConfig: mc.set, probe })
  const after = mc.raw()
  assert.equal(after.douyin.autoBrowse, false, 'douyin 的自主循环被压')
  assert.equal(after.bili.autoBrowse, false, 'bili 同样')
  assert.equal(after.ext.tophub.shareLimit, 0, 'tophub 只压分享')
  assert.equal(after.ext.tophub.nodes.length, 1, 'tophub 巡游配置不动（保留素材源）')
  assert.equal(after.douyin.enabled, true, '铁律：不关模块总开关（关了 api.use 就拿不到，手断）')
  assert.deepEqual(backup, { douyin: { autoBrowse: true }, bili: { autoBrowse: true }, tophub: { shareLimit: 2 } }, '备份要留原值')
})

test('还原：精确写回原值，目标键恢复成 true/2', () => {
  const mc = memConfig(REAL_SHAPE)
  const probe = probeTakeovers({ getConfig: mc.get, liveIds: ['douyin', 'tophub'] })
  const backup = applyTakeover({ getConfig: mc.get, setConfig: mc.set, probe })
  assert.equal(mc.raw().douyin.autoBrowse, false)
  const done = restoreTakeover({ getConfig: mc.get, setConfig: mc.set, backup })
  assert.equal(mc.raw().douyin.autoBrowse, true, '原值回来')
  assert.equal(mc.raw().ext.tophub.shareLimit, 2, 'tophub 分享额度也回来')
  assert.equal(done.length, 2)
})

test('tick 兜底：主人手动改回 true → 被翻的键找得出来（调用方负责压回 + 审计）', () => {
  const mc = memConfig(REAL_SHAPE)
  const backup = { douyin: { autoBrowse: true } }
  applyTakeover({ getConfig: mc.get, setConfig: mc.set, probe: [{ id: 'douyin', scope: '', key: 'autoBrowse', from: true }] })
  // 模拟主人手动打开
  mc.set({ douyin: { autoBrowse: true } })
  const flipped = findFlipped({ getConfig: mc.get, backup })
  assert.equal(flipped.length, 1)
  assert.equal(flipped[0].id, 'douyin')
  assert.equal(flipped[0].got, true)
  assert.equal(flipped[0].want, false)
})

test('恢复接管：重启后重压——已压着的跳过，被翻的重新压回（幂等）', () => {
  const mc = memConfig(REAL_SHAPE)
  const backup = { douyin: { autoBrowse: true }, bili: { autoBrowse: true } }
  // 模拟「插件重启」：配置里主人把 douyin 的开关打开了（内存配置重置到真机初始形状）
  const mc2 = memConfig(REAL_SHAPE)
  const done = repressTakeover({ getConfig: mc2.get, setConfig: mc2.set, backup })
  assert.equal(done.length, 2, '重启后按备份全部重新压制')
  assert.equal(mc2.raw().douyin.autoBrowse, false)
  assert.equal(mc2.raw().bili.autoBrowse, false)
  // 再跑一次：已经是压制状态，不重复写
  const again = repressTakeover({ getConfig: mc2.get, setConfig: mc2.set, backup })
  assert.equal(again.length, 0, '幂等：已经压着就别重复写')
})

test('面板视图：接管中给「已压制（原 true）」，未接管为空', () => {
  const v = takeoverView({ douyin: { autoBrowse: true } })
  assert.equal(v.active, true)
  assert.equal(v.targets[0].text, '已压制（原 true）')
  assert.equal(takeoverView({}).active, false)
})

test('主人手动补条目：不守约定的怪模块也能接管', () => {
  const mc = memConfig({ weird: { enabled: true, tourTimes: '09:30' } })
  const r = probeTakeovers({ getConfig: mc.get, liveIds: ['weird'], extra: [{ id: 'weird', key: 'tourTimes' }] })
  const hit = r.find((x) => x.id === 'weird')
  assert.ok(hit, '手动补的键要扫出来')
  assert.equal(hit.key, 'tourTimes')
})
