import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanContent, cleanText, clipText } from '../src/core/text.js'

const thinking = '🤔'
const half = thinking[0]

test('cleanText 去掉孤立代理字符，完整的 emoji 不动', () => {
  assert.equal(cleanText(`前${half}后`), '前后')
  assert.equal(cleanText(`前${thinking[1]}后`), '前后')
  assert.equal(cleanText(`一${thinking}二`), `一${thinking}二`)
  assert.equal(cleanText(null), '')
  assert.equal(cleanText(`${half}${half}${thinking}`).isWellFormed(), true)
})

test('clipText 按字符截断，不切开 emoji', () => {
  const text = 'a'.repeat(19) + thinking + '后面'
  assert.equal(text.slice(0, 20).isWellFormed(), false)
  assert.equal(clipText(text, 20), 'a'.repeat(19) + thinking)
})

test('cleanContent 只改文字块', () => {
  const image = { type: 'image', data: 'x' }
  assert.deepEqual(cleanContent([{ type: 'text', text: `a${half}` }, image]), [{ type: 'text', text: 'a' }, image])
})

test('心情：半个 emoji 不进上下文，旧数据里的坏字符也不会', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createMood } = await import('../src/features/companion.js')
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-text-'))
  process.env.AURABOT_DATA_DIR = dir
  const m = createMood({ getConfig: () => ({ mood: { enabled: true, judge: false, base: 60 } }), log: {} })
  m.nudge(-10, `有人说「一${half}」`)
  assert.equal(m.contextLine().isWellFormed(), true)
  assert.equal(m.state().reason.isWellFormed(), true)
})
