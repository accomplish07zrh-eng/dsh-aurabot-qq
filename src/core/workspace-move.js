// 工作区搬家：DSH 把会话路径写在日志头、工作区表和缓存里，没有改路径的接口，运行中也不能动这些文件。
// 所以文件搬到新位置，原路径留一个目录联接：DSH 和已有会话照常用原路径，东西实际在新位置。

import { execFile } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const granted = new Set()

/**
 * Windows 上 DSH 的沙箱要给工作区改权限和完整性标记，普通权限的账号在盘根下的文件夹里只有「修改」，
 * 缺 WRITE_OWNER，pwsh 一条命令都跑不了。给自己的账号完全控制，每个目录每次启动只做一次。
 */
export async function grantOwner(dir, log) {
  if (process.platform !== 'win32' || granted.has(dir)) return
  granted.add(dir)
  await new Promise((done) => execFile('icacls', [dir, '/grant', `${userInfo().username}:(OI)(CI)F`], { windowsHide: true }, (error) => {
    if (error) log?.warn?.('给工作区授权失败，她可能跑不了命令：', error.message)
    done()
  }))
}

function tally(dir) {
  let files = 0
  let bytes = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const sub = tally(p)
      files += sub.files
      bytes += sub.bytes
    } else {
      files++
      bytes += lstatSync(p).size
    }
  }
  return { files, bytes }
}

const isLink = (p) => { try { return lstatSync(p).isSymbolicLink() } catch (error) { return false } }
const inside = (parent, child) => { const r = relative(parent, child); return r === '' || (!r.startsWith('..') && !isAbsolute(r)) }

/** 现在文件实际在哪（搬过就是新位置）。 */
export function realWorkspace(dir) {
  try { return realpathSync(dir) } catch (error) { return dir }
}

/** 把工作区搬到 to，原路径 from 留联接。失败时一切恢复原样。 */
export function moveWorkspace(from, to) {
  const target = resolve(String(to || '').trim())
  if (!String(to || '').trim() || !isAbsolute(String(to).trim())) return { ok: false, message: '要填完整路径，比如 D:\\Aurabot\\qq-chats' }
  mkdirSync(from, { recursive: true })
  const real = realpathSync(from)
  if (inside(real, target) || inside(target, real)) return { ok: false, message: '新位置不能和现在的位置重叠' }
  if (existsSync(target) && (!statSync(target).isDirectory() || readdirSync(target).length)) return { ok: false, message: '新位置已经有东西了，换一个空文件夹' }
  const linked = isLink(from)
  const hold = `${from}.moving`
  if (existsSync(hold)) return { ok: false, message: `${hold} 已存在，上次搬家可能没做完，先看看里面的东西` }
  const undoCopy = () => rmSync(target, { recursive: true, force: true })
  try {
    mkdirSync(dirname(target), { recursive: true })
    cpSync(real, target, { recursive: true, verbatimSymlinks: true })
    const a = tally(real)
    const b = tally(target)
    if (a.files !== b.files || a.bytes !== b.bytes) throw new Error(`复制不完整（${b.files}/${a.files} 个文件）`)
  } catch (error) {
    undoCopy()
    return { ok: false, message: '复制失败，什么都没动：' + error.message }
  }
  try {
    renameSync(from, hold)
  } catch (error) {
    undoCopy()
    return { ok: false, message: '有文件正在被使用，等她忙完再搬：' + error.message }
  }
  try {
    symlinkSync(target, from, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    renameSync(hold, from)
    undoCopy()
    return { ok: false, message: '建不了联接，什么都没动：' + error.message }
  }
  let leftover = ''
  try {
    if (linked) {
      process.platform === 'win32' ? rmdirSync(hold) : unlinkSync(hold)
      rmSync(real, { recursive: true, force: true })
    } else rmSync(hold, { recursive: true, force: true })
  } catch (error) {
    leftover = linked ? real : hold
  }
  return { ok: true, target, message: `搬好了，文件现在在 ${target}` + (leftover ? `。旧文件没删干净，可以手动删掉 ${leftover}` : '') }
}
