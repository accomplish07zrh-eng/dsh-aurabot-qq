// 她的画作：生图时顺手存下来的图（data/imagegen/）。
// 跟 B 站截图库不一样，这里不维护索引 —— 直接按文件算，文件名里本来就有时间和提示词。
//
// 存多久：**一直存着**，插件不会自动删；面板里可以一张张删，也可以直接开文件夹清理。

import { readdirSync, statSync, unlinkSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, extname, isAbsolute, join, normalize, relative } from 'node:path'
import { dataDir, ensureDir } from '../core/store.js'
import { mimeOf } from '../chat/inbound.js'

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const dir = () => dataDir('imagegen')

/**
 * 把画好的图存一份，返回文件路径；存失败返回 ''。
 * 文件名里带时间和提示词：图库列表直接用它当说明，不用另存元数据。
 */
export function savePainting (buf, prompt, { now = new Date() } = {}) {
  try {
    const d = dir()
    mkdirSync(d, { recursive: true })
    const p = (n) => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
    const slug = String(prompt || '图').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 20)
    const ext = mimeOf(buf) === 'image/jpeg' ? 'jpg' : 'png'
    const file = join(d, `${stamp}-${slug}.${ext}`)
    writeFileSync(file, buf)
    return file
  } catch (error) {
    return ''
  }
}

/** 文件名安全：只接受本目录下的纯文件名，挡住 ../ 之类。 */
export function safeName (file) {
  const name = String(file || '').trim()
  if (!name || name !== basename(name)) return ''
  if (isAbsolute(name) || name.includes('\0')) return ''
  const full = normalize(join(dir(), name))
  if (relative(dir(), full).startsWith('..')) return ''
  return IMG_EXT.has(extname(name).toLowerCase()) ? name : ''
}

/** 文件名形如 20261028-014501-一只橘猫.png → 时间和提示词。 */
export function metaOf (file) {
  const base = String(file || '').replace(/\.[^.]+$/, '')
  const m = /^(\d{8})-(\d{6})-(.*)$/.exec(base)
  if (!m) return { at: 0, prompt: base }
  const [, ymd, hms] = m
  const at = new Date(
    Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)),
    Number(hms.slice(0, 2)), Number(hms.slice(2, 4)), Number(hms.slice(4, 6)),
  ).getTime()
  return { at: Number.isFinite(at) ? at : 0, prompt: m[3] || '' }
}

/**
 * 最近画的那几张。
 * @param {{limit?:number}} opts limit 是面板显示数量（1~50 之外会被夹回来）
 */
export function listPaintings ({ limit = 20 } = {}) {
  const raw = Number(limit)
  const base = Number.isFinite(raw) ? raw : 20
  const n = Math.min(50, Math.max(1, Math.round(base)))
  let names = []
  try {
    names = readdirSync(dir()).filter((f) => IMG_EXT.has(extname(f).toLowerCase()))
  } catch (error) {
    return { items: [], total: 0, limit: n }
  }
  const all = []
  for (const file of names) {
    try {
      const st = statSync(join(dir(), file))
      const m = metaOf(file)
      all.push({ file, bytes: st.size, at: m.at || st.mtimeMs, prompt: m.prompt })
    } catch (error) {}
  }
  all.sort((a, b) => b.at - a.at)
  return { items: all.slice(0, n), total: all.length, limit: n }
}

/** 这张图在本机的绝对路径；不合法或不存在返回 ''。 */
export function paintingPath (file) {
  const name = safeName(file)
  if (!name) return ''
  const full = join(dir(), name)
  return existsSync(full) ? full : ''
}

/** 删掉一张。 */
export function removePainting (file) {
  const name = safeName(file)
  if (!name) return { ok: false, message: '文件名不对' }
  const full = join(dir(), name)
  if (!existsSync(full)) return { ok: false, message: '这张已经不在了' }
  try {
    unlinkSync(full)
    return { ok: true, message: '删掉了', file: name }
  } catch (error) {
    return { ok: false, message: '删不掉：' + error.message }
  }
}

/** 用系统文件管理器打开存图目录。 */
export function openPaintFolder ({ run = spawn, platform = process.platform } = {}) {
  const d = dir()
  ensureDir(d)
  try {
    const opts = { detached: true, stdio: 'ignore' }
    if (platform === 'win32') run('explorer.exe', [d], opts).unref()
    else if (platform === 'darwin') run('open', [d], opts).unref()
    else run('xdg-open', [d], opts).unref()
    return { ok: true, message: '打开了：' + d, path: d }
  } catch (error) {
    return { ok: false, message: '打不开文件夹：' + error.message, path: d }
  }
}

export const paintDir = dir
