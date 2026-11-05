import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moveWorkspace, realWorkspace } from '../src/core/workspace-move.js'

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-ws-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const from = join(root, 'old', 'qq-chats')
  mkdirSync(join(from, 'sub'), { recursive: true })
  writeFileSync(join(from, 'sub', 'a.txt'), '文件')
  return { root, from }
}

test('搬到新位置：文件过去，原路径还能用', (t) => {
  const { root, from } = setup(t)
  const to = join(root, 'new', 'chats')
  const r = moveWorkspace(from, to)
  assert.equal(r.ok, true, r.message)
  assert.equal(readFileSync(join(to, 'sub', 'a.txt'), 'utf8'), '文件')
  assert.equal(readFileSync(join(from, 'sub', 'a.txt'), 'utf8'), '文件')
  assert.ok(lstatSync(from).isSymbolicLink())
  assert.equal(realWorkspace(from), realpathSync(to))
  writeFileSync(join(from, 'b.txt'), '新')
  assert.ok(existsSync(join(to, 'b.txt')), '写原路径落到新位置')
  assert.equal(existsSync(`${from}.moving`), false)
})

test('再搬一次：旧的新位置清掉，联接指向最新的', (t) => {
  const { root, from } = setup(t)
  const first = join(root, 'first')
  const second = join(root, 'second')
  assert.equal(moveWorkspace(from, first).ok, true)
  const r = moveWorkspace(from, second)
  assert.equal(r.ok, true, r.message)
  assert.equal(existsSync(first), false)
  assert.equal(readFileSync(join(from, 'sub', 'a.txt'), 'utf8'), '文件')
  assert.equal(realWorkspace(from), realpathSync(second))
})

test('不能搬的情况什么都不动', (t) => {
  const { root, from } = setup(t)
  const full = join(root, 'full')
  mkdirSync(full)
  writeFileSync(join(full, 'x'), '1')
  assert.equal(moveWorkspace(from, full).ok, false)
  assert.equal(moveWorkspace(from, join(from, 'sub', 'in')).ok, false)
  assert.equal(moveWorkspace(from, 'relative\\path').ok, false)
  assert.equal(moveWorkspace(from, '').ok, false)
  assert.equal(lstatSync(from).isSymbolicLink(), false)
  assert.equal(readFileSync(join(from, 'sub', 'a.txt'), 'utf8'), '文件')
  assert.equal(readFileSync(join(full, 'x'), 'utf8'), '1')
})
