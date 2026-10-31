import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBili } from '../src/bili/duty.js'
import { readJson, writeJson } from '../src/core/store.js'

const root = mkdtempSync(join(tmpdir(), 'aurabot-bili-login-'))
process.env.AURABOT_DATA_DIR = root
after(() => rmSync(root, { recursive: true, force: true }))
const file = join(root, 'bili.json')
const d = new Date()
const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const paused = () => ({ day, pauseDay: day, pauseReason: 'B 站没登录或 Cookie 过期了', comments: 2, replies: 1, history: [] })
const log = { info() {}, warn() {}, debug() {} }

test('检查登录后解除旧登录暂停，刷新凭证不必等待缓存到期', async () => {
  writeJson(file, paused())
  let calls = 0
  const cfg = { bili: { cookie: 'SESSDATA=old; bili_jct=csrf', shotLibrary: 20 } }
  const b = createBili({ getConfig: () => cfg, log, api: { nav: async () => { calls++; return { isLogin: calls > 1 } } } })
  assert.equal((await b.account()).isLogin, false)
  assert.equal(b.state().canPost, false)
  cfg.bili.cookie = 'SESSDATA=new; bili_jct=csrf'
  assert.equal((await b.account()).isLogin, true)
  assert.equal(b.state().canPost, true)
  assert.equal(b.state().comments, 2)
  assert.equal(readJson(file).replies, 1)
  assert.equal(calls, 2)
})

test('核验时切换凭证或停止模块，不用过时结果解除暂停', async () => {
  for (const scenario of ['changed', 'disposed']) {
    writeJson(file, paused())
    const cfg = { bili: { cookie: 'SESSDATA=old; bili_jct=csrf', shotLibrary: 20 } }
    let finish
    const b = createBili({ getConfig: () => cfg, log, api: { nav: () => new Promise((resolve) => { finish = resolve }) } })
    const checking = b.account(true)
    if (scenario === 'changed') cfg.bili.cookie = 'SESSDATA=new; bili_jct=new'
    else b.dispose()
    finish({ isLogin: true })
    assert.equal((await checking).isLogin, false)
    assert.equal(readJson(file).pauseDay, day)
  }
})
