// 只归档已经取得的公开浏览图；不会截取桌面、私人聊天，也不会替主人选择输出目录。

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { readJson, writeJson } from '../../core/store.js'
import { createDiaryAssets } from './assets.js'
import { collectSources, insideFolder, sourceId } from './sources.js'

export function archiveDate(at) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at)).replaceAll('-', '')
}

/** 路径的已有各层均不能是链接；输出目录只允许显式的绝对路径。 */
function outputFolder(value) {
  const folder = String(value || '').trim()
  if (!folder || !isAbsolute(folder) || resolve(folder) === parse(resolve(folder)).root) throw new Error('请先指定归档文件夹的完整路径，不能使用磁盘根目录')
  const root = resolve(folder)
  let current = root
  for (;;) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('归档路径不能包含目录链接')
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return root
}

export function createDiaryArchive(api, { assets = createDiaryAssets(api.dataDir('archive-cache')), now = Date.now } = {}) {
  const settings = () => api.config().diary.archive || {}
  // 换目录时单独记账，不因旧目录已保存过而跳过新目录；切回旧目录也保留去重记录。
  const file = () => api.dataDir('archives', sourceId(settings().folder || '') + '.json')
  const load = () => readJson(file(), () => ({ items: [], lastAt: 0, error: '' }))
  let busy = false
  let stopped = false
  function assertActive(folder) {
    const cfg = api.config()
    if (stopped || !cfg.enabled || cfg.dryRun || cfg.diary.archive?.enabled !== true || cfg.diary.archive.folder !== folder) throw new Error('归档已停止、试运行开启或目录设置已变化，本次停止保存')
    return outputFolder(folder)
  }
  function state() {
    const saved = load()
    return { ok: true, busy, count: new Set(saved.items.map((item) => item.hash)).size, lastAt: saved.lastAt, error: saved.error, folder: settings().folder || '', enabled: settings().enabled === true }
  }
  async function collect() {
    if (busy) return { ok: false, message: '上一轮图片还在归档' }
    const snapshot = { ...settings() }
    // 开关、试运行或空目录时不取素材、不创建目录，也不改归档记录。
    try { assertActive(snapshot.folder) }
    catch (error) { return { ok: false, message: error.message } }
    busy = true
    let saved = 0
    let failed = 0
    try {
      const initial = load()
      const seen = new Set(initial.items.map((item) => item.sourceId))
      const pictures = collectSources(api, { browsing: true }, [], now()).pictures
        .filter((picture) => picture.kind === 'browsing' && !seen.has(picture.id)).slice(0, 8)
      for (const picture of pictures) {
        try {
          const image = await assets.materialize(picture)
          const bytes = assets.read(image.id)
          const root = assertActive(snapshot.folder)
          const hash = createHash('sha256').update(bytes).digest('hex')
          const current = load()
          const duplicate = current.items.find((item) => item.hash === hash)
          if (duplicate) {
            current.items.unshift({ ...duplicate, sourceId: picture.id })
            current.items = current.items.slice(0, 3000)
            writeJson(file(), current)
            continue
          }
          const day = archiveDate(picture.at)
          const dir = join(root, day)
          // 下载期间路径可能被替换；落盘前再次检查每一层。
          outputFolder(dir)
          mkdirSync(dir, { recursive: true })
          if (!insideFolder(realpathSync(root), realpathSync(dir))) throw new Error('归档目录越界')
          const name = '浏览图-' + hash.slice(0, 20) + '.' + image.id.split('.').pop()
          const dest = join(dir, name)
          if (existsSync(dest) || existsSync(dest + '.json')) continue
          const metadata = {
            schema: 1, kind: 'browsing', platform: image.platform, title: image.title,
            author: image.author, url: image.url, at: picture.at, collectedAt: now(), hash,
          }
          // 先写来源说明；任何一步失败均不覆盖已有文件。
          writeFileSync(dest + '.json', JSON.stringify(metadata, null, 2), { flag: 'wx' })
          try { writeFileSync(dest, bytes, { flag: 'wx' }) }
          catch (error) { unlinkSync(dest + '.json'); throw error }
          current.items.unshift({ sourceId: picture.id, hash, day, name, at: now() })
          current.items = current.items.slice(0, 3000)
          current.lastAt = now()
          current.error = ''
          writeJson(file(), current)
          saved++
        } catch (error) {
          // 撤销权限后不再开始下一张，也不写错误状态到用户选定的目录。
          assertActive(snapshot.folder)
          failed++
        }
      }
      const current = load()
      current.lastAt = now()
      current.error = failed ? `${failed} 张浏览图未能保存，已保留已有图片；下次会重试。` : ''
      writeJson(file(), current)
      return { ok: true, saved, failed, message: `已归档 ${saved} 张浏览图` }
    } catch (error) {
      return { ok: false, saved, message: error.message }
    } finally { busy = false }
  }
  return { collect, state, dispose: () => { stopped = true } }
}
