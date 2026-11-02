import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 数据目录不可写时（DSH ACL 沙盒 / 只读 profile），插件仍应挂载并回退到自带人格，
// 不能把“人格播种失败”变成整个插件目录树加载失败。
test('persona 数据目录不可写时 seed/list 不抛错，当前人格有兜底文本', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aurabot-persona-ro-'))
  const blocker = join(home, 'not-a-directory')
  writeFileSync(blocker, 'x')
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = blocker
  try {
    const { seedPersonas, listPersonas, currentPersonaText } = await import('../src/persona/personas.js')
    assert.doesNotThrow(() => seedPersonas())
    assert.deepEqual(listPersonas(), [])
    assert.equal(typeof currentPersonaText('default'), 'string')
    assert.ok(currentPersonaText('default').length > 0)
  } finally {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(home, { recursive: true, force: true })
  }
})
