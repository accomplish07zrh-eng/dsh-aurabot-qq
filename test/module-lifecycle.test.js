// 模块 import / setup 跨过插件卸载时，不能复活旧模块或留下定时任务。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModules } from '../src/core/modules.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const silent = { info() {}, debug() {}, warn() {}, error() {} }

async function bounded(promise) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('等待测试模块超时')), 3000)
    })])
  } finally { clearTimeout(timer) }
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-module-lifecycle-'))
  const previousDir = process.env.AURABOT_DATA_DIR
  const previousGlobal = globalThis.aurabot
  process.env.AURABOT_DATA_DIR = dir
  let cfg = { modules: {}, ext: {}, safeMode: false, debug: false }
  const warnings = []
  const modules = createModules({
    ctx: {}, core: {}, getConfig: () => cfg, setConfig: (next) => { cfg = next },
    logger: { child: () => ({ ...silent, warn: (...args) => warnings.push(args.join(' ')) }) }, version: 'test', builtins: [],
  })
  t.after(() => {
    modules.dispose()
    if (previousDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previousDir
    if (previousGlobal === undefined) delete globalThis.aurabot
    else globalThis.aurabot = previousGlobal
  })
  return {
    modules,
    warnings,
    write(id, code) {
      const path = join(dir, 'modules', id)
      mkdirSync(path, { recursive: true })
      writeFileSync(join(path, 'index.mjs'), code)
    },
  }
}

function gate(t) {
  const key = '__aurabot_module_lifecycle_' + randomUUID()
  let enter, release
  const entered = new Promise((resolve) => { enter = resolve })
  const ready = new Promise((resolve) => { release = resolve })
  const state = { enter, ready, setups: 0, disposed: 0, cleanups: 0, events: 0, delayed: 0, ticks: 0 }
  globalThis[key] = state
  // 断言失败时也释放动态 import / setup，避免未完成的模块评估挂住进程。
  t.after(() => { release(); delete globalThis[key] })
  return { state, entered, release, source: 'globalThis[' + JSON.stringify(key) + ']' }
}

test('boot 已完成后，在途用户模块 import 不会在卸载后启动', async (t) => {
  const f = fixture(t)
  await f.modules.boot()
  const g = gate(t)
  f.write('slow-import', `
    const gate = ${g.source}
    gate.enter()
    await gate.ready
    export default { id: 'slow-import', api: 1, setup(api) {
      gate.setups++
      api.later(0, () => gate.delayed++)
      api.route('/late', () => ({ ok: true }))
      return {}
    } }
  `)
  const syncing = f.modules.sync()
  t.after(async () => { g.release(); await syncing })
  await bounded(g.entered)
  f.modules.dispose()
  g.release()
  await bounded(syncing)
  await f.modules.sync()
  await sleep(15)
  assert.equal(g.state.setups, 0)
  assert.equal(g.state.delayed, 0)
  assert.equal(f.modules.has('slow-import'), false)
  assert.equal(f.modules.hasRoute('/aurabot/api/ext/slow-import/late'), false)
})

test('异步 setup 跨过停止或卸载后，迟到资源和 exports 都会被清理', async (t) => {
  for (const action of ['stop', 'dispose']) await t.test(action, async (t) => {
    const f = fixture(t)
    await f.modules.boot()
    const g = gate(t)
    f.write('slow-setup', `
      const gate = ${g.source}
      export default { id: 'slow-setup', api: 1, async setup(api) {
        gate.enter()
        await gate.ready
        api.onDispose(() => gate.cleanups++)
        api.later(0, () => gate.delayed++)
        api.every(1000, () => gate.ticks++)
        api.route('/late', () => ({ ok: true }))
        api.on('late-event', () => gate.events++)
        return { dispose() { gate.disposed++ } }
      } }
    `)
    const interval = t.mock.method(globalThis, 'setInterval')
    const clear = t.mock.method(globalThis, 'clearInterval')
    const syncing = f.modules.sync()
    t.after(async () => { g.release(); await syncing })
    await bounded(g.entered)
    if (action === 'dispose') f.modules.dispose()
    else f.modules.stop('slow-setup', { quiet: true })
    g.release()
    await bounded(syncing)
    f.modules.emit('late-event')
    await sleep(20)
    assert.equal(g.state.cleanups, 1, '迟到 onDispose 立即清理')
    assert.equal(g.state.disposed, 1, '迟到 setup 返回的导出也要 dispose')
    assert.equal(g.state.delayed, 0)
    assert.equal(g.state.ticks, 0)
    assert.equal(g.state.events, 0)
    assert.equal(f.modules.has('slow-setup'), false)
    assert.equal(f.modules.hasRoute('/aurabot/api/ext/slow-setup/late'), false)
    assert.equal(interval.mock.calls.length, 1)
    const timer = interval.mock.calls[0].result
    assert.ok(clear.mock.calls.some((call) => call.arguments[0] === timer), '迟到 interval 已撤销')
    f.modules.dispose()
    assert.equal(g.state.disposed, 1, '重复卸载不会重复销毁导出')
  })
})

test('boot 等待 loadLib 时卸载，不覆盖新实例全局对象、不启动 watcher', async (t) => {
  const f = fixture(t)
  const interval = t.mock.method(globalThis, 'setInterval')
  const booting = f.modules.boot()
  f.modules.dispose()
  const newer = { modules: {}, marker: 'newer-instance' }
  globalThis.aurabot = newer
  await bounded(booting)
  assert.equal(globalThis.aurabot, newer)
  assert.equal(interval.mock.calls.length, 0)
})

test('boot 等待用户 import 时卸载，完成后不启动 watcher、不覆盖新实例', async (t) => {
  const f = fixture(t)
  const g = gate(t)
  f.write('slow-boot', `
    const gate = ${g.source}
    gate.enter()
    await gate.ready
    export default { id: 'slow-boot', api: 1, setup() { gate.setups++; return {} } }
  `)
  const interval = t.mock.method(globalThis, 'setInterval')
  const booting = f.modules.boot()
  t.after(async () => { g.release(); await booting })
  await bounded(g.entered)
  f.modules.dispose()
  const newer = { modules: {}, marker: 'newer-instance' }
  globalThis.aurabot = newer
  g.release()
  await bounded(booting)
  assert.equal(globalThis.aurabot, newer)
  assert.equal(g.state.setups, 0)
  assert.equal(interval.mock.calls.length, 0)
  assert.equal(f.modules.has('slow-boot'), false)
})

test('异步清理拒绝被处理，正常和迟到清理均不影响其他资源', async (t) => {
  for (const late of [false, true]) await t.test(late ? '迟到导出' : '正常导出', async (t) => {
    const f = fixture(t)
    await f.modules.boot()
    const g = gate(t)
    const unhandled = []
    const onUnhandled = (error) => unhandled.push(error)
    process.on('unhandledRejection', onUnhandled)
    t.after(() => process.off('unhandledRejection', onUnhandled))
    f.write('async-cleanup', `
      const gate = ${g.source}
      export default { id: 'async-cleanup', api: 1, async setup(api) {
        ${late ? 'gate.enter(); await gate.ready' : ''}
        api.onDispose(() => gate.events++)
        api.onDispose(async () => {
          gate.cleanups++
          await Promise.resolve()
          throw new Error('expected async callback rejection')
        })
        api.route('/cleanup', () => ({ ok: true }))
        return { async dispose() {
          gate.disposed++
          await Promise.resolve()
          throw new Error('expected async cleanup rejection')
        } }
      } }
    `)
    const syncing = f.modules.sync()
    t.after(async () => { g.release(); await syncing })
    if (late) await bounded(g.entered)
    else await bounded(syncing)
    assert.equal(f.modules.dispose(), undefined, '卸载接口保持同步')
    g.release()
    await bounded(syncing)
    await sleep(20)
    assert.equal(g.state.disposed, 1)
    assert.equal(g.state.cleanups, 1, '其他清理函数照常执行')
    assert.equal(g.state.events, 1, '单项失败不影响其余清理')
    assert.equal(f.modules.hasRoute('/aurabot/api/ext/async-cleanup/cleanup'), false)
    assert.equal(f.modules.has('async-cleanup'), false)
    assert.deepEqual(unhandled, [], '异步 dispose 错误不会成为未处理拒绝')
    assert.equal(f.warnings.filter((text) => text.includes('expected async callback rejection')).length, 1)
    assert.equal(f.warnings.filter((text) => text.includes('expected async cleanup rejection')).length, 1)
  })
})
