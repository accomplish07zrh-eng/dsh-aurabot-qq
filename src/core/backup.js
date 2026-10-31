// 一键备份：把数据目录打成一个 zip，换电脑时导入，下次启动替换。
//
// 恢复不能在运行中做：插件内存里的配置和状态随时会写回去，把刚恢复的文件盖掉。所以导入只解到
// .restore/，启动时在读配置之前才换上去，被换掉的文件挪到 backups/pre-restore-*/，随时能找回。

import { open, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'
import { homedir } from 'node:os'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'
import { dataDir, dshHome } from './store.js'

const MANIFEST = 'aurabot-backup.json'
const SCHEMA = 1
const MAX_ZIP = 0xfffffff0 // 没做 zip64：超过 4GB 明确报错，不生成坏文件
const MAX_FILE = 2 ** 31 - 1 // Buffer 和 readFile 的边界
const DEFLATE_MAX = 64 * 1024 * 1024
const STORE_EXT = /\.(png|jpe?g|gif|webp|mp3|mp4|m4a|ogg|opus|webm|zip|7z|rar|pth|index|onnx|safetensors)$/i

/**
 * 不进备份的东西。logs、缓存没有价值；edge-profile 是浏览器资料，登录态绑定这台电脑，
 * 带过去也用不了。市场模块不打包，恢复后按名单重新下载。
 */
const SKIP = ['backups', '.restore', '.restore-sessions', '.restore-pending.json', '.restore-modules.json', 'logs', 'tmp', 'voice-cache', 'archive-cache', 'douyin/edge-profile']
const skipped = (rel) => SKIP.some((s) => rel === s || rel.startsWith(s + '/')) || rel.split('/').includes('node_modules') || rel.endsWith('.tmp')

const backupsDir = () => dataDir('backups')
const stageDir = () => dataDir('.restore')
const sessionStage = () => dataDir('.restore-sessions')
const pendingFile = () => dataDir('.restore-pending.json')
const modulesFile = () => dataDir('.restore-modules.json')
const SOURCE_FILE = '.aurabot-source.json'

/** DSH 存会话的目录名：工作区路径里的分隔符换成 -，其余特殊字符写成 ~十六进制。 */
export function sessionDirName(cwd) {
  const body = [...String(cwd).replace(/[\\/]+$/, '')].map((ch) => {
    if (/[\\/:]/.test(ch)) return '-'
    return /[A-Za-z0-9._-]/.test(ch) ? ch : '~' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
  }).join('').replace(/-{2,}/g, '-')
  return `--${body}--`
}

function safeName(name) {
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false
  return name.split('/').every((seg) => seg && seg !== '.' && seg !== '..')
}

async function walk(root, rel = '', out = [], market = []) {
  for (const item of await readdir(join(root, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${item.name}` : item.name
    if (skipped(path) || item.isSymbolicLink()) continue
    // 从市场装的模块：只记名字，恢复时下载最新版
    if (item.isDirectory() && /^modules\/[^/]+$/.test(path) && existsSync(join(root, path, SOURCE_FILE))) {
      market.push(item.name)
      continue
    }
    if (item.isDirectory()) await walk(root, path, out, market)
    else if (item.isFile()) out.push(path)
  }
  return out
}

const dosTime = (d) => ({ time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() })

function localHeader(entry) {
  const name = Buffer.from(entry.name)
  const h = Buffer.alloc(30)
  h.writeUInt32LE(0x04034b50, 0)
  h.writeUInt16LE(20, 4)
  h.writeUInt16LE(0x0800, 6) // 文件名是 UTF-8
  h.writeUInt16LE(entry.method, 8)
  h.writeUInt16LE(entry.time, 10)
  h.writeUInt16LE(entry.date, 12)
  h.writeUInt32LE(entry.crc, 14)
  h.writeUInt32LE(entry.packed, 18)
  h.writeUInt32LE(entry.size, 22)
  h.writeUInt16LE(name.length, 26)
  return Buffer.concat([h, name])
}

function centralHeader(entry) {
  const name = Buffer.from(entry.name)
  const h = Buffer.alloc(46)
  h.writeUInt32LE(0x02014b50, 0)
  h.writeUInt16LE(20, 4)
  h.writeUInt16LE(20, 6)
  h.writeUInt16LE(0x0800, 8)
  h.writeUInt16LE(entry.method, 10)
  h.writeUInt16LE(entry.time, 12)
  h.writeUInt16LE(entry.date, 14)
  h.writeUInt32LE(entry.crc, 16)
  h.writeUInt32LE(entry.packed, 20)
  h.writeUInt32LE(entry.size, 24)
  h.writeUInt16LE(name.length, 28)
  h.writeUInt32LE(entry.offset, 42)
  return Buffer.concat([h, name])
}

/** 打包数据目录，返回 { file, name, files, bytes, skipped }。 */
export async function createBackup({ version = '', workspaceDir = '', now = new Date(), onProgress = () => {} } = {}) {
  const root = dataDir()
  await mkdir(backupsDir(), { recursive: true })
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13)
  const name = `aurabot-backup-${stamp}.zip`
  const final = join(backupsDir(), name)
  const tmp = final + '.tmp'
  const market = []
  const files = await walk(root, '', [], market)
  const sessionsRoot = workspaceDir ? join(dshHome(), 'sessions', sessionDirName(workspaceDir)) : ''
  const sessionFiles = sessionsRoot && existsSync(sessionsRoot) ? await walk(sessionsRoot) : []
  const total = files.length + sessionFiles.length
  const tooBig = []
  const fh = await open(tmp, 'w')
  const entries = []
  let offset = 0
  const put = async (entryName, data, at) => {
    const method = data.length <= DEFLATE_MAX && !STORE_EXT.test(entryName) ? 8 : 0
    const body = method === 8 ? deflateRawSync(data) : data
    const { time, date } = dosTime(at)
    const entry = { name: entryName, method, time, date, crc: crc32(data), packed: body.length, size: data.length, offset }
    const head = localHeader(entry)
    if (offset + head.length + body.length > MAX_ZIP) throw new Error('数据超过 4GB，一个备份放不下')
    await fh.write(head)
    await fh.write(body)
    offset += head.length + body.length
    entries.push(entry)
  }
  try {
    let done = 0
    let bytes = 0
    const queue = [...files.map((rel) => [root, rel, 'data/']), ...sessionFiles.map((rel) => [sessionsRoot, rel, 'dsh-sessions/'])]
    for (const [base, rel, prefix] of queue) {
      const path = join(base, ...rel.split('/'))
      try {
        const st = await stat(path)
        if (st.size > MAX_FILE) { tooBig.push(rel); continue }
        const data = await readFile(path)
        await put(prefix + rel, data, st.mtime)
        bytes += data.length
      } catch (error) {
        if (error.message.includes('4GB')) throw error
        tooBig.push(rel) // 文件正好被占用或删掉：记下来告诉主人，不让整个备份失败
      }
      onProgress({ done: ++done, total })
      await new Promise((r) => setImmediate(r))
    }
    const manifest = { schema: SCHEMA, app: 'aurabot', version, createdAt: now.toISOString(), dataDir: root, home: homedir(), workspaceDir, market, sessions: sessionFiles.length, platform: process.platform, files: entries.length, bytes, skipped: tooBig }
    await put(MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2)), now)
    if (entries.length > 0xffff) throw new Error('文件太多，一个备份放不下')
    const central = Buffer.concat(entries.map(centralHeader))
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(entries.length, 8)
    end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(central.length, 12)
    end.writeUInt32LE(offset, 16)
    await fh.write(Buffer.concat([central, end]))
    await fh.close()
    await rename(tmp, final)
    return { file: final, name, files: entries.length - 1, bytes, skipped: tooBig, market, sessions: sessionFiles.length }
  } catch (error) {
    await fh.close().catch(() => {})
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/** 读 zip 的目录：只读文件尾，不把整个备份读进内存。 */
async function readEntries(fh, size) {
  const tailLen = Math.min(size, 22 + 65535)
  const tail = Buffer.alloc(tailLen)
  await fh.read(tail, 0, tailLen, size - tailLen)
  let end = -1
  for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { end = i; break }
  if (end < 0) throw new Error('不是有效的备份文件')
  const count = tail.readUInt16LE(end + 10)
  const dirSize = tail.readUInt32LE(end + 12)
  const dirOffset = tail.readUInt32LE(end + 16)
  const dir = Buffer.alloc(dirSize)
  await fh.read(dir, 0, dirSize, dirOffset)
  const entries = []
  let p = 0
  for (let i = 0; i < count; i++) {
    if (p + 46 > dir.length || dir.readUInt32LE(p) !== 0x02014b50) throw new Error('备份文件的目录损坏')
    const nameLen = dir.readUInt16LE(p + 28)
    const extraLen = dir.readUInt16LE(p + 30)
    const commentLen = dir.readUInt16LE(p + 32)
    entries.push({
      method: dir.readUInt16LE(p + 10), crc: dir.readUInt32LE(p + 16), packed: dir.readUInt32LE(p + 20), size: dir.readUInt32LE(p + 24),
      offset: dir.readUInt32LE(p + 42), name: dir.toString('utf8', p + 46, p + 46 + nameLen),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

async function readEntry(fh, e) {
  const head = Buffer.alloc(30)
  await fh.read(head, 0, 30, e.offset)
  if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`备份文件损坏：${e.name}`)
  const start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
  const raw = Buffer.alloc(e.packed)
  await fh.read(raw, 0, e.packed, start)
  if (e.method !== 0 && e.method !== 8) throw new Error(`备份文件损坏：${e.name}`)
  const data = e.method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) }) : raw
  if (data.length !== e.size || crc32(data) !== e.crc) throw new Error(`备份文件校验失败：${e.name}`)
  return data
}

/** 校验备份并解到 .restore/，下次启动才换上去。 */
export async function stageRestore(path) {
  const size = (await stat(path)).size
  const fh = await open(path, 'r')
  const stage = stageDir()
  try {
    const entries = await readEntries(fh, size)
    const head = entries.find((e) => e.name === MANIFEST)
    if (!head) throw new Error('这不是 Aurabot 的备份文件')
    const manifest = JSON.parse((await readEntry(fh, head)).toString('utf8'))
    if (manifest.schema !== SCHEMA || manifest.app !== 'aurabot') throw new Error('这个备份的格式认不出来，先更新插件')
    await rm(stage, { recursive: true, force: true })
    await rm(sessionStage(), { recursive: true, force: true })
    await rm(pendingFile(), { force: true })
    let files = 0
    for (const e of entries) {
      if (e.name === MANIFEST) continue
      const isSession = e.name.startsWith('dsh-sessions/')
      if ((!isSession && !e.name.startsWith('data/')) || !safeName(e.name)) throw new Error(`备份里有不安全的路径：${e.name}`)
      const rel = e.name.slice(isSession ? 13 : 5)
      const into = isSession ? sessionStage() : stage
      const dest = resolve(into, ...rel.split('/'))
      if (!dest.startsWith(resolve(into) + sep) || (!isSession && skipped(rel))) throw new Error(`备份里有不安全的路径：${e.name}`)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, await readEntry(fh, e))
      files++
    }
    if (!existsSync(join(stage, 'config.json'))) throw new Error('备份里没有配置文件')
    const { createdAt, version, dataDir: oldData, home, workspaceDir, platform, market = [], sessions = 0 } = manifest
    await writeFile(pendingFile(), JSON.stringify({ at: Date.now(), files, createdAt, version, dataDir: oldData, home, workspaceDir, platform, market, sessions }, null, 2))
    return { ok: true, files, createdAt, version, platform, market, sessions, skipped: manifest.skipped || [] }
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => {})
    await rm(sessionStage(), { recursive: true, force: true }).catch(() => {})
    throw error
  } finally {
    await fh.close()
  }
}

function listFiles(dir, out = []) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name)
    if (item.isDirectory()) listFiles(path, out)
    else out.push(path)
  }
  return out
}

function move(from, to) {
  mkdirSync(dirname(to), { recursive: true })
  try { renameSync(from, to) } catch (error) {
    copyFileSync(from, to)
    rmSync(from, { force: true })
  }
}

/** 启动时、读配置之前调用：把暂存的备份换上去。返回换上的文件数，没有待恢复返回 0。 */
export function applyPendingRestore(now = Date.now()) {
  const pending = pendingFile()
  if (!existsSync(pending)) return 0
  const info = JSON.parse(readFileSync(pending, 'utf8'))
  const stage = stageDir()
  const root = dataDir()
  const keep = join(backupsDir(), `pre-restore-${now}`)
  const files = listFiles(stage)
  for (const from of files) {
    const rel = relative(stage, from)
    const to = join(root, rel)
    if (existsSync(to) && statSync(to).isFile()) move(to, join(keep, rel))
    move(from, to)
  }
  // 配置里指向旧数据目录的路径换成这台电脑的
  const config = join(root, 'config.json')
  if (info.dataDir && info.dataDir !== root && existsSync(config)) {
    const esc = (s) => JSON.stringify(s).slice(1, -1)
    writeFileSync(config, readFileSync(config, 'utf8').replaceAll(esc(info.dataDir), esc(root)))
  }
  restoreSessions(info, config)
  if (info.market?.length) writeFileSync(modulesFile(), JSON.stringify(info.market))
  rmSync(stage, { recursive: true, force: true })
  rmSync(pending, { force: true })
  return files.length
}

/**
 * 会话放回 DSH 按工作区路径分的目录。路径一样 DSH 才认得这些会话，所以尽量沿用原来的工作区路径：
 * 在旧用户目录下的换成这台电脑的用户目录，盘符不存在才退回默认工作区。恢复不了的会话，hub 会新开一个。
 */
function restoreSessions(info, config) {
  const stage = sessionStage()
  if (!info.workspaceDir || !existsSync(stage)) return
  let target = info.workspaceDir
  if (info.home && target.toLowerCase().startsWith(info.home.toLowerCase())) target = homedir() + target.slice(info.home.length)
  if (!existsSync(parse(target).root)) {
    rmSync(stage, { recursive: true, force: true })
    return
  }
  mkdirSync(target, { recursive: true })
  if (existsSync(config)) writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), workspaceDir: target }, null, 2))
  const dir = join(dshHome(), 'sessions', sessionDirName(target))
  for (const from of listFiles(stage)) {
    const to = join(dir, relative(stage, from))
    if (!existsSync(to)) move(from, to) // 这台电脑上已有的同名会话不碰
  }
  rmSync(stage, { recursive: true, force: true })
}

/** 恢复后还没下载的市场模块。 */
export function pendingModules() {
  try { return JSON.parse(readFileSync(modulesFile(), 'utf8')) } catch (error) { return [] }
}

export function setPendingModules(list) {
  if (list.length) writeFileSync(modulesFile(), JSON.stringify(list))
  else rmSync(modulesFile(), { force: true })
}

export function cancelRestore() {
  rmSync(stageDir(), { recursive: true, force: true })
  rmSync(sessionStage(), { recursive: true, force: true })
  rmSync(pendingFile(), { force: true })
}

export function pendingRestore() {
  try { return JSON.parse(readFileSync(pendingFile(), 'utf8')) } catch (error) { return null }
}

export function listBackups() {
  try {
    return readdirSync(backupsDir()).filter((n) => n.endsWith('.zip') && n !== 'incoming.zip').map((name) => {
      const st = statSync(join(backupsDir(), name))
      return { name, bytes: st.size, at: st.mtimeMs }
    }).sort((a, b) => b.at - a.at)
  } catch (error) { return [] }
}

/** 面板上传的备份先落盘，再走 stageRestore。 */
export async function saveUpload(buf) {
  await mkdir(backupsDir(), { recursive: true })
  const file = join(backupsDir(), 'incoming.zip')
  await writeFile(file, buf)
  return file
}
