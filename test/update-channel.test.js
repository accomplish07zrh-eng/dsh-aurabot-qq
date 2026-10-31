import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, createUpdateChecker, updateCommand, wantsUnstable } from '../src/core/update.js'

const pkg = (version) => ({ version, repository: 'https://github.com/a/b' })
const fetchOf = (versions) => {
  const asked = []
  const fetchImpl = async (url) => {
    const branch = url.includes('/beta/') ? 'beta' : 'main'
    asked.push(branch)
    return { ok: true, json: async () => ({ version: versions[branch] }) }
  }
  return { fetchImpl, asked }
}

test('版本比较：beta < rc < 正式版', () => {
  assert.ok(compareVersions('1.2.0-rc.1', '1.2.0-beta.9') > 0)
  assert.ok(compareVersions('1.2.0-beta.2', '1.2.0-beta.1') > 0)
  assert.ok(compareVersions('1.2.0-rc.2', '1.2.0-rc.1') > 0)
  assert.ok(compareVersions('1.2.0', '1.2.0-rc.9') > 0)
  assert.equal(compareVersions('1.2.0-beta.1', '1.2.0-beta.1'), 0)
})

test('没选过：用测试版算订阅，用正式版不算；选过听主人的', () => {
  assert.equal(wantsUnstable(null, '1.2.0-beta.1'), true)
  assert.equal(wantsUnstable(null, '1.2.0'), false)
  assert.equal(wantsUnstable(false, '1.2.0-beta.1'), false)
  assert.equal(wantsUnstable(true, '1.2.0'), true)
})

test('没订阅只看 main，收不到 beta', async () => {
  const { fetchImpl, asked } = fetchOf({ main: '1.1.24', beta: '1.2.0-beta.2' })
  const r = await createUpdateChecker({ pkg: pkg('1.1.24'), fetchImpl, unstable: () => false })({ force: true })
  assert.equal(r.newer, false)
  assert.deepEqual(asked, ['main'])
})

test('订阅后收到 beta，命令走 beta 分支', async () => {
  const { fetchImpl } = fetchOf({ main: '1.1.24', beta: '1.2.0-beta.2' })
  const r = await createUpdateChecker({ pkg: pkg('1.1.24'), fetchImpl, unstable: () => true })({ force: true })
  assert.equal(r.newer, true)
  assert.equal(r.latest, '1.2.0-beta.2')
  assert.equal(r.channel, 'beta')
  assert.match(r.command, /#beta/)
})

test('订阅后 main 更新时走 main：转正不会卡在 beta', async () => {
  const { fetchImpl } = fetchOf({ main: '1.2.0', beta: '1.2.0-rc.3' })
  const r = await createUpdateChecker({ pkg: pkg('1.2.0-rc.3'), fetchImpl, unstable: () => true })({ force: true })
  assert.equal(r.latest, '1.2.0')
  assert.equal(r.channel, 'main')
  assert.doesNotMatch(r.command, /#beta/)
})

test('一个分支读不到，另一个还能用；开关一变缓存失效', async () => {
  let on = false
  const asked = []
  const fetchImpl = async (url) => {
    const branch = url.includes('/beta/') ? 'beta' : url.includes('@beta') ? 'beta' : 'main'
    asked.push(branch)
    if (branch === 'beta') throw new Error('断网')
    return { ok: true, json: async () => ({ version: '1.2.0' }) }
  }
  const check = createUpdateChecker({ pkg: pkg('1.1.24'), fetchImpl, unstable: () => on })
  assert.equal((await check()).latest, '1.2.0')
  const before = asked.length
  on = true
  assert.equal((await check()).latest, '1.2.0')
  assert.ok(asked.length > before, '换了订阅状态要重新查')
})

test('updateCommand 按分支给命令', () => {
  assert.match(updateCommand('a/b', 'beta'), /github:a\/b#beta/)
  assert.doesNotMatch(updateCommand('a/b', 'main'), /#/)
})
