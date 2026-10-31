import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2), flag = args.indexOf('--modules-dir')
if (flag >= 0 && !args[flag + 1]) throw new Error('--modules-dir 需要目录参数')
const data = process.env.AURABOT_DATA_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugins-data', 'aurabot')
const target = resolve(flag >= 0 ? args[flag + 1] : join(data, 'modules'))
const source = join(dirname(fileURLToPath(import.meta.url)), 'modules')
const names = ['diary-rich', 'daily-images', 'diary']
const existing = names.filter(name => existsSync(join(target, name)))
if (args.includes('--dry-run')) {
  console.log(JSON.stringify({ target, modules: names, existing, wouldBackup: existing.length > 0 }, null, 2))
} else {
  if (existing.length && !args.includes('--replace')) throw new Error('目标模块已存在。先检查 --dry-run，再加 --replace 安装；会先备份源码，不改设置和运行数据。')
  const backup = join(target, '_backups', 'qzone-rich-' + new Date().toISOString().replace(/[:.]/g, '-'))
  function copyCode(from, to) {
    mkdirSync(to, { recursive: true })
    const entries = readdirSync(from, { withFileTypes: true }).sort((a,b) => Number(a.name === 'index.mjs') - Number(b.name === 'index.mjs'))
    for (const entry of entries) {
      if (entry.isSymbolicLink() || ['.aurabot-cache','node_modules','.git'].includes(entry.name)) continue
      if (entry.isDirectory()) copyCode(join(from,entry.name), join(to,entry.name))
      else if (entry.isFile()) copyFileSync(join(from,entry.name), join(to,entry.name))
    }
  }
  for (const name of existing) copyCode(join(target,name), join(backup,name))
  for (const name of names) copyCode(join(source,name), join(target,name))
  console.log(JSON.stringify({ installed: names, target, ...(existing.length ? { backup } : {}) }, null, 2))
}
