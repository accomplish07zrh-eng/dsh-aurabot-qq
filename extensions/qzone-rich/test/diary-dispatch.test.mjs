import test from 'node:test'
import assert from 'node:assert/strict'
import definition from '../modules/diary/index.mjs'

test('沿用内置路由和唯一计时器，动态切换图文模块，发布使用未包装的原生方法', () => {
  let rich = null, ticks = 0, nativePosts = 0, richPosts = 0, nativeTicks = 0, nativeDeletes = 0
  const timers = [], native = {
    post() { nativePosts++; return { ok:true } }, writeDiary() { return 'native' },
    tick() { nativeTicks++ }, history() { return ['native'] }, nextTime() { return '12:00' },
    remove() { nativeDeletes++ }, syncHistory() { return 'synced' },
  }
  const api = { use: () => rich, lib: () => ({ default: { setup(api) { timers.push(() => native.tick()); return native } } }) }
  const output = definition.setup(api)
  output.post(); assert.equal(nativePosts,1)
  rich = { post() { richPosts++ }, tick() { ticks++ }, history() { return ['rich'] } }
  output.post(); output.nativePost(); timers[0](); output.remove()
  assert.equal(richPosts,1); assert.equal(nativePosts,2); assert.equal(ticks,1); assert.equal(nativeDeletes,1)
  assert.equal(output.syncHistory(),'synced'); assert.equal(timers.length,1); assert.deepEqual(output.history(),['rich'])
  rich = null; timers[0](); assert.equal(nativeTicks,1); assert.deepEqual(output.history(),['native'])
})
