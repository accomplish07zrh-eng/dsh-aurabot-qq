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

function fixture(t, { core = {}, builtins = [], onSetConfig } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-module-lifecycle-'))
  const previousDir = process.env.AURABOT_DATA_DIR
  const previousGlobal = globalThis.aurabot
  process.env.AURABOT_DATA_DIR = dir
  let cfg = { modules: {}, ext: {}, safeMode: false, debug: false }
  const warnings = []
  const modules = createModules({
    ctx: {}, core, getConfig: () => cfg, setConfig: (next) => { cfg = onSetConfig ? onSetConfig(next) : next },
    logger: { child: () => ({ ...silent, warn: (...args) => warnings.push(args.join(' ')) }) }, version: 'test', builtins,
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
    config: () => cfg,
    setConfig: (next) => { cfg = next },
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

test('异步 setup 停止后，迟到的写操作不能发送消息或修改配置', async (t) => {
  for (const action of ['stop', 'dispose']) await t.test(action, async (t) => {
    const writes = []
    const hub = Object.fromEntries(['deliver', 'sendText', 'sendImage', 'sendSegments', 'sendFile', 'sendVoiceFile', 'runSystemTurn']
      .map((name) => [name, (...args) => writes.push([name, ...args])]))
    const f = fixture(t, { core: { hub, ask: () => writes.push('ask'), onebot: { call: () => writes.push('onebot') } } })
    await f.modules.boot()
    const g = gate(t)
    f.write('late-write', `
      const gate = ${g.source}
      export default { id: 'late-write', async setup(api) {
        gate.enter()
        await gate.ready
        const actions = [
          () => api.send('private:1', 'a'), () => api.sendText('private:1', 'b'),
          () => api.reply({ chatId: 'private:1' }, 'c'), () => api.sendImage('private:1', 'image'),
          () => api.sendSegments('private:1', []), () => api.sendFile('private:1', 'file'),
          () => api.sendVoiceFile('private:1', 'voice'), () => api.setConfig({ ownerQQ: 'changed' }),
          () => api.saveSettings({ secret: 'changed' }), () => api.onebot('send_private_msg', {}),
          () => api.ask('question'), () => api.think('prompt'), () => api.emit('probe'),
        ]
        gate.errors = []
        for (const action of actions) {
          try { await action() } catch (error) { gate.errors.push(error.message) }
        }
        return { dispose() { gate.disposed++ } }
      } }
    `)
    const syncing = f.modules.sync()
    t.after(async () => { g.release(); await syncing })
    await bounded(g.entered)
    const before = structuredClone(f.config())
    if (action === 'stop') f.modules.stop('late-write')
    else f.modules.dispose()
    g.release()
    await bounded(syncing)
    assert.equal(g.state.errors.length, 13)
    assert.ok(g.state.errors.every((message) => message.includes('已停止')))
    assert.equal(f.warnings.filter((message) => message.includes('已停止')).length, 13)
    assert.deepEqual(writes, [])
    assert.deepEqual(f.config(), before)
    assert.equal(g.state.disposed, 1)
  })
})

test('导入途中关闭模块、开启安全模式或停止模块，导入结束后不执行 setup', async (t) => {
  for (const action of ['disable', 'safeMode', 'stop']) await t.test(action, async (t) => {
    const f = fixture(t)
    await f.modules.boot()
    const g = gate(t)
    f.write('slow-import', `
      const gate = ${g.source}
      gate.enter()
      await gate.ready
      export default { id: 'slow-import', setup() { gate.setups++; return {} } }
    `)
    const syncing = f.modules.sync()
    t.after(async () => { g.release(); await syncing })
    await bounded(g.entered)
    if (action === 'disable') f.setConfig({ ...f.config(), modules: { 'slow-import': { enabled: false } } })
    if (action === 'safeMode') f.setConfig({ ...f.config(), safeMode: true })
    if (action === 'stop') f.modules.stop('slow-import')
    // 模拟面板保存配置时触发的同步；直接 stop 不重新发起加载。
    const updated = action === 'stop' ? syncing : f.modules.sync()
    g.release()
    await bounded(Promise.all([syncing, updated]))
    assert.equal(g.state.setups, 0)
    assert.equal(f.modules.has('slow-import'), false)
  })
})

test('导入途中开启安全模式，恢复被替换的内置模块', async (t) => {
  let builtinStarts = 0
  const f = fixture(t, { builtins: [{ id: 'slow-import', setup() { builtinStarts++; return {} } }] })
  await f.modules.boot()
  const g = gate(t)
  f.write('slow-import', `
    const gate = ${g.source}
    gate.enter()
    await gate.ready
    export default { id: 'slow-import', setup() { gate.setups++; return {} } }
  `)
  const syncing = f.modules.sync()
  t.after(async () => { g.release(); await syncing })
  await bounded(g.entered)
  f.setConfig({ ...f.config(), safeMode: true })
  const updated = f.modules.sync()
  g.release()
  await bounded(Promise.all([syncing, updated]))
  assert.equal(g.state.setups, 0)
  assert.equal(builtinStarts, 2)
  assert.equal(f.modules.running('slow-import'), 'builtin')
})

test('记录替换版本时同步开启安全模式，不执行用户模块 setup', async (t) => {
  let builtinStarts = 0
  const f = fixture(t, { builtins: [{ id: 'safe-replace', setup() { builtinStarts++; return {} } }],
    onSetConfig: (cfg) => cfg.modules?.['safe-replace']?.forkedFrom ? { ...cfg, safeMode: true } : cfg })
  await f.modules.boot()
  const g = gate(t)
  f.write('safe-replace', `
    const gate = ${g.source}
    export default { id: 'safe-replace', setup() { gate.setups++; return {} } }
  `)
  await f.modules.sync()
  assert.equal(g.state.setups, 0)
  assert.equal(builtinStarts, 2)
  assert.equal(f.modules.running('safe-replace'), 'builtin')
})

test('导入途中配置变化，不按旧快照关闭后面的内置模块', async (t) => {
  const state = { setups: 0 }
  const f = fixture(t, { builtins: [{ id: 'builtin-late', setup() { state.setups++; return {} } }] })
  await f.modules.boot()
  const g = gate(t)
  f.write('slow-import', `
    const gate = ${g.source}
    gate.enter()
    await gate.ready
    export default { id: 'slow-import', setup() { return {} } }
  `)
  f.setConfig({ ...f.config(), modules: { 'builtin-late': { enabled: false } } })
  const syncing = f.modules.sync()
  t.after(async () => { g.release(); await syncing })
  await bounded(g.entered)
  f.setConfig({ ...f.config(), modules: {} })
  const updated = f.modules.sync()
  g.release()
  await bounded(Promise.all([syncing, updated]))
  assert.equal(state.setups, 2)
  assert.equal(f.modules.running('builtin-late'), 'builtin')
})

test('旧实例清理时启动同名新实例，路由和监听器仍属于新实例', async (t) => {
  let f
  let starts = 0
  const events = []
  const builtin = { id: 'same-id', setup(api) {
    const instance = ++starts
    api.route('/probe', () => ({ instance }))
    api.on('probe', () => events.push(instance))
    if (instance === 1) api.onDispose(() => { f.modules.sync() })
    return {}
  } }
  f = fixture(t, { builtins: [builtin] })
  await f.modules.boot()
  f.modules.stop('same-id')
  assert.equal(starts, 2)
  assert.deepEqual(await f.modules.handle('/aurabot/api/probe'), { instance: 2 })
  f.modules.emit('probe')
  assert.deepEqual(events, [2])
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
