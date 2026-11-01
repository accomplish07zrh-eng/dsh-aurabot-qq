// 把本扩展安装到 Aurabot 的用户模块目录。遵守 DSH_HOME / AURABOT_DATA_DIR。
import { mkdirSync, copyFileSync, renameSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const source = fileURLToPath(new URL('../', import.meta.url))
const dataRoot = process.env.AURABOT_DATA_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugins-data', 'aurabot')
const target = resolve(process.argv[2] || join(dataRoot, 'modules', 'weibo'))

if (resolve(source).toLowerCase() === target.toLowerCase()) {
  throw new Error('当前目录就是安装目录；更新请从仓库目录运行 npm run install:module')
}
if (!existsSync(join(source, 'index.mjs'))) throw new Error(`找不到 index.mjs：${source}`)

mkdirSync(target, { recursive: true })
for (const name of ['panel.js', 'package.json', 'README.md', 'LICENSE']) {
  const from = join(source, name)
  if (existsSync(from)) copyFileSync(from, join(target, name))
}
// 入口最后原子替换，避免运行中的模块读到半份文件
copyFileSync(join(source, 'index.mjs'), join(target, 'index.mjs.next'))
renameSync(join(target, 'index.mjs.next'), join(target, 'index.mjs'))
console.log(`微博扩展已安装到 ${target}`)
console.log('去 Aurabot 面板「扩展」里重新加载 weibo 即可；登录态和设置保存在 modules-data/weibo，更新不会清空。')
