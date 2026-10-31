import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'aurabot-diary-archive-'))
process.env.AURABOT_DATA_DIR = root
after(() => rmSync(root, { recursive: true, force: true }))
const { normalize } = await import('../src/core/config.js')
const { createDiaryArchive, archiveDate } = await import('../src/modules/diary/archive.js')
const { createDiaryAssets } = await import('../src/modules/diary/assets.js')
const { localPictures } = await import('../src/modules/diary/sources.js')
const { withCredits } = await import('../src/modules/diary/media.js')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64')
const now = Date.parse('2026-10-31T10:00:00+08:00')
let seq = 0

function fixture({ config = {}, download = async () => PNG } = {}) {
  const folder = join(root, 'output-' + seq++)
  const data = join(root, 'state-' + seq++)
  let cfg = normalize({ enabled: true, dryRun: false, diary: { archive: { enabled: true, folder } }, ...config })
  const api = {
    config: () => cfg, dataDir: (...parts) => join(data, ...parts),
    use: (id) => id === 'huashi6' ? { state: () => ({ history: [{
      kind: 'read', at: now - 1000, ok: true,
      item: { id: '123456', title: '云朵插画', author: '画师', cover: 'https://example.com/cover.png' },
    }] }) } : undefined,
  }
  const assets = createDiaryAssets(join(data, 'cache'), { download })
  const create = () => createDiaryArchive(api, { assets, now: () => now })
  return { api, folder, data, create, archive: create(), config: () => cfg, setConfig: (value) => { cfg = value } }
}

test('日期按上海时区的浏览时间计算，不用收集时间或机器时区', () => {
  assert.equal(archiveDate('2026-10-30T16:01:00Z'), '20261031')
  assert.equal(archiveDate('2026-10-30T15:59:00Z'), '20261030')
})

test('归档默认关闭且目录为空，空目录、试运行和总开关关闭均不创建文件', async () => {
  assert.deepEqual(normalize({}).diary.archive, { enabled: false, folder: '' })
  for (const config of [{ enabled: false }, { dryRun: true }, { diary: { archive: { enabled: false } } }, { diary: { archive: { enabled: true, folder: '' } } }]) {
    const f = fixture({ config, download: () => { throw new Error('不应下载') } })
    const result = await f.archive.collect()
    assert.equal(result.ok, false)
    assert.equal(existsSync(f.folder), false)
    assert.equal(existsSync(f.data), false)
  }
})

test('按日期保存浏览图及来源，重复收集和重启均不重复写入', async () => {
  let downloads = 0
  const f = fixture({ download: async () => { downloads++; return PNG } })
  const result = await f.archive.collect()
  assert.equal(result.ok, true)
  assert.equal(result.saved, 1)
  const dir = join(f.folder, '20261031')
  const name = readdirSync(dir).find((name) => name.endsWith('.png'))
  assert.deepEqual(readFileSync(join(dir, name)), PNG)
  const metadata = JSON.parse(readFileSync(join(dir, name + '.json'), 'utf8'))
  assert.equal(metadata.url, 'https://www.huashi6.com/draw/123456')
  assert.equal(metadata.author, '画师')
  assert.equal((await f.archive.collect()).saved, 0)
  assert.equal((await f.create().collect()).saved, 0)
  assert.equal(downloads, 1)
  assert.equal(f.archive.state().count, 1)
})

test('归档图再次用作本地日记配图时保留出处，不冒充生活照片', async () => {
  const f = fixture()
  await f.archive.collect()
  const pictures = localPictures(f.folder)
  assert.equal(pictures.length, 1)
  assert.equal(pictures[0].sourceKind, 'browsing')
  assert.match(withCredits('今天刷到一朵云。', pictures), /配图摘自触站《云朵插画》 · 画师/)
  const sidecar = pictures[0].src + '.json'
  const meta = JSON.parse(readFileSync(sidecar, 'utf8'))
  writeFileSync(sidecar, JSON.stringify({ ...meta, url: meta.url + '?token=private-login' }))
  assert.doesNotMatch(localPictures(f.folder)[0].url, /token|private-login/)
})

test('下载失败保留已有图片，错误可见且下一轮可重试', async () => {
  let fail = true
  const f = fixture({ download: async () => { if (fail) throw new Error('fetch failed'); return PNG } })
  assert.equal((await f.archive.collect()).failed, 1)
  assert.match(f.archive.state().error, /下次会重试/)
  fail = false
  assert.equal((await f.archive.collect()).saved, 1)
  assert.equal(f.archive.state().error, '')
})

test('下载过程中关闭归档、切换目录、开启试运行或停止模块，均不落盘', async () => {
  for (const action of ['disable', 'folder', 'dryRun', 'dispose']) {
    let f
    f = fixture({ download: async () => {
      const cfg = f.config()
      if (action === 'dispose') f.archive.dispose()
      else if (action === 'dryRun') f.setConfig({ ...cfg, dryRun: true })
      else f.setConfig({ ...cfg, diary: { ...cfg.diary, archive: { ...cfg.diary.archive, ...(action === 'folder' ? { folder: join(root, 'elsewhere') } : { enabled: false }) } } })
      return PNG
    } })
    assert.equal((await f.archive.collect()).ok, false)
    assert.equal(existsSync(f.folder), false)
    assert.equal(existsSync(join(f.data, 'archives')), false)
  }
})

test('日期目录被替换为链接时停止，不向外部目录写图片', async () => {
  const f = fixture()
  const outside = join(root, 'outside')
  mkdirSync(outside)
  mkdirSync(f.folder)
  symlinkSync(outside, join(f.folder, '20261031'), process.platform === 'win32' ? 'junction' : 'dir')
  const result = await f.archive.collect()
  assert.equal(result.saved, 0)
  assert.equal(result.failed, 1)
  assert.deepEqual(readdirSync(outside), [])
})

test('更换归档目录重新保存，切回旧目录保留去重记录', async () => {
  const f = fixture()
  assert.equal((await f.archive.collect()).saved, 1)
  const original = f.config()
  const other = join(root, 'new-output')
  f.setConfig({ ...original, diary: { ...original.diary, archive: { ...original.diary.archive, folder: other } } })
  assert.equal(f.archive.state().count, 0)
  assert.equal((await f.archive.collect()).saved, 1)
  assert.equal(existsSync(join(other, '20261031')), true)
  f.setConfig(original)
  assert.equal(f.archive.state().count, 1)
  assert.equal((await f.archive.collect()).saved, 0)
})
