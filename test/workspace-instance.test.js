import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 回归：默认账号必须沿用旧工作区，别的账号按实例名接后缀，
// 不能改用「人设名」分目录（老用户已有的会话会找不到）。
test('默认账号工作区不按人设改名，其他账号按实例名接后缀', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'aurabot-ws-'))
  const legacy = join(sandbox, 'qq-chats')
  mkdirSync(legacy, { recursive: true })
  const prevEnv = process.env.AURABOT_WORKSPACE
  process.env.AURABOT_WORKSPACE = legacy
  try {
    const hub = await import('../src/chat/hub.js')

    // 默认账号：不填 workspaceDir 时就是旧路径，跟人设名叫什么无关
    const dafeiyu = { persona: { current: 'dafeiyu' } }
    const ronova = { persona: { current: 'Ronova' } }
    assert.equal(hub.workspaceDirOf(dafeiyu), legacy)
    assert.equal(hub.workspaceDirOf(ronova), legacy)
    assert.equal(hub.workspaceDirOf({}), legacy)

    // 其他账号：按实例名接后缀，也不看人设
    assert.equal(hub.workspaceDirOf(dafeiyu, 'aurabot-2'), `${legacy}-aurabot-2`)
    assert.equal(hub.workspaceDirOf(ronova, 'aurabot-3'), `${legacy}-aurabot-3`)

    // 面板里填了就听填的
    assert.equal(hub.workspaceDirOf({ workspaceDir: join(sandbox, 'custom') }), join(sandbox, 'custom'))
    assert.equal(hub.workspaceDirOf({ workspaceDir: join(sandbox, 'custom') }, 'aurabot-2'), join(sandbox, 'custom'))

    // 标题仍然用中文名，不是 slug
    assert.equal(hub.workspaceTitleOf(dafeiyu), 'Aurabot · 大肥鱼')
    assert.equal(hub.workspaceTitleOf({ persona: { current: 'columbina' } }), 'Aurabot · 哥伦比娅')
    assert.equal(hub.workspaceTitleOf({ persona: { current: 'whatever' } }), 'Aurabot · whatever')
  } finally {
    if (prevEnv === undefined) delete process.env.AURABOT_WORKSPACE
    else process.env.AURABOT_WORKSPACE = prevEnv
    rmSync(sandbox, { recursive: true, force: true })
  }
})
