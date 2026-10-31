import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

test('安装先预览和备份，源码替换不覆盖配置、历史或加载快照', t => {
  const here = dirname(fileURLToPath(import.meta.url)), dir = mkdtempSync(join(here,'.install-')), target = join(dir,'modules')
  t.after(() => rmSync(dir,{recursive:true,force:true}))
  mkdirSync(join(target,'diary','.aurabot-cache'),{recursive:true})
  writeFileSync(join(target,'diary','index.mjs'),'original diary source')
  writeFileSync(join(target,'diary','.aurabot-cache','old'),'loader-owned')
  writeFileSync(join(dir,'config.json'),'private config')
  writeFileSync(join(dir,'diary.json'),'existing history')
  const run = flags => spawnSync(process.execPath,[join(here,'../install.mjs'),'--modules-dir',target,...flags],{encoding:'utf8'})
  const dry = run(['--dry-run']); assert.equal(dry.status,0); assert.equal(JSON.parse(dry.stdout).wouldBackup,true); assert.equal(existsSync(join(target,'diary-rich')),false)
  assert.notEqual(run([]).status,0)
  const installed = run(['--replace']); assert.equal(installed.status,0,installed.stderr)
  const report = JSON.parse(installed.stdout)
  assert.equal(readFileSync(join(report.backup,'diary','index.mjs'),'utf8'),'original diary source')
  assert.equal(existsSync(join(report.backup,'diary','.aurabot-cache')),false)
  assert.equal(readFileSync(join(target,'diary','.aurabot-cache','old'),'utf8'),'loader-owned')
  assert.equal(readFileSync(join(dir,'config.json'),'utf8'),'private config'); assert.equal(readFileSync(join(dir,'diary.json'),'utf8'),'existing history')
  assert.ok(existsSync(join(target,'diary-rich','engine.mjs'))); assert.ok(existsSync(join(target,'daily-images','archive.mjs')))
})
