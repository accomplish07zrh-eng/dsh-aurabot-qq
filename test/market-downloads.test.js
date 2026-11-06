// 模块市场的下载量：从模块库 Releases 聚合、按 tag 认模块、读不到时降级、缓存不重复读。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { crc32, deflateRawSync } from 'node:zlib'

let root, createCommunity, userDir

const zip = (files) => {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text)
    const path = Buffer.from(name)
    const body = deflateRawSync(data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0800, 6)
    head.writeUInt16LE(8, 8)
    head.writeUInt32LE(crc32(data), 14)
    head.writeUInt32LE(body.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(path.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    head.copy(central, 6, 4, 30)
    central.writeUInt32LE(offset, 42)
    locals.push(head, path, body)
    centrals.push(central, path)
    offset += head.length + path.length + body.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  const n = Object.keys(files).length
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(n, 8)
  end.writeUInt16LE(n, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

const pack = (id, version) => {
  const buf = zip({ 'module.json': JSON.stringify({ id, version }), 'index.mjs': 'export default {}' })
  return { buf, entry: { id, name: id, version, api: 1, minPluginVersion: '1.0.0', requires: [], capabilities: [], path: `${id}/${id}.zip`, sha256: createHash('sha256').update(buf).digest('hex') } }
}

/** releases 是按页返回的假 GitHub 列表。 */
function setup(packs, { releases = [], releasesFail = null, assetsBase = 'https://github.com/aureth-labs/dsh-aurabot-qq-mods/releases/download/' } = {}) {
  const asked = []
  const fetcher = async (url) => {
    asked.push(url)
    if (url.endsWith('index.json')) return { ok: true, json: async () => ({ schema: 1, assetsBase, modules: packs.map((p) => p.entry) }) }
    if (url.includes('api.github.com')) {
      if (releasesFail) return { ok: false, status: releasesFail }
      const page = Number(new URL(url).searchParams.get('page') || 1)
      return { ok: true, json: async () => releases[page - 1] || [] }
    }
    const p = packs.find((x) => url.endsWith(x.entry.path))
    return { ok: true, arrayBuffer: async () => p.buf }
  }
  const mods = { status: () => [], sync: async () => {}, stop: () => true }
  const c = createCommunity({ mods, getConfig: () => ({}), setConfig() {}, log: { info() {}, warn() {}, debug() {} }, version: '1.2.0', registryUrl: 'https://x/index.json', fetcher })
  return { c, asked, apiCalls: () => asked.filter((u) => u.includes('api.github.com')) }
}

const rel = (tag, counts) => ({ tag_name: tag, assets: counts.map((n) => ({ name: `x-${n}.zip`, download_count: n })) })

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'aurabot-community-dl-'))
  process.env.AURABOT_DATA_DIR = root
  ;({ createCommunity } = await import('../src/core/community.js'))
  ;({ userDir } = await import('../src/core/modules.js'))
  mkdirSync(userDir(), { recursive: true })
})
after(() => rmSync(root, { recursive: true, force: true }))

test('每个模块的下载量：按 tag 累加所有版本和资产', async () => {
  const packs = [pack('pet', '1.0.0'), pack('douyin', '2.0.0')]
  const s = setup(packs, {
    releases: [[
      rel('pet-v1.0.7', [3, 2]),
      rel('pet-v1.0.6', [12]),
      rel('douyin-v2.0.4', [0]),
      rel('phone-v0.1.0', [4]),
    ]],
  })
  const r = await s.c.list()
  const byId = Object.fromEntries(r.list.map((m) => [m.id, m]))
  assert.equal(byId.pet.downloads, 17, '同一模块多个版本要累加')
  assert.equal(byId.douyin.downloads, 0)
  assert.equal(r.downloads.source, 'aureth-labs/dsh-aurabot-qq-mods')
  assert.equal(r.downloads.failed, false)
  // 只在 GitHub 上有包的模块，索引里没有就不凭空冒出来
  assert.equal(byId.phone, undefined)
})

test('认识的 tag 才统计，翻页要翻完；没资产的版本记 0', async () => {
  const packs = [pack('pet', '1.0.0')]
  const first = Array.from({ length: 100 }, (_, i) => rel(`pet-v1.0.${i}`, [1]))
  const s = setup(packs, { releases: [first, [rel('pet-v1.1.0', [5]), rel('not-a-tag', [99]), { tag_name: 'pet-v9.9.9' }]] })
  const r = await s.c.list()
  assert.equal(r.list[0].downloads, 105, '第二页也要算进来，没资产的 tag 记 0')
})

test('索引里的仓库地址决定查哪个仓库；域名不对就不查', async () => {
  const packs = [pack('pet', '1.0.0')]
  const good = setup(packs, { releases: [[rel('pet-v1.0.0', [7])]] })
  await good.c.list()
  assert.match(good.apiCalls()[0], /^https:\/\/api\.github\.com\/repos\/aureth-labs\/dsh-aurabot-qq-mods\/releases\?/)
  const bad = setup(packs, { releases: [[rel('pet-v1.0.0', [7])]], assetsBase: 'https://example.com/dl/' })
  const r = await bad.c.list()
  assert.equal(bad.apiCalls().length, 0, '认不出仓库就不去问 GitHub')
  assert.equal(r.list[0].downloads, 0)
  assert.equal(r.downloads.source, '', 'registryUrl 也认不出 owner/repo')
})

test('读不到下载量时市场照常可用（403 / 500 / 断网都算）', async () => {
  for (const fail of [403, 500]) {
    const s = setup([pack('pet', '1.0.0')], { releasesFail: fail })
    const r = await s.c.list()
    assert.equal(r.list.length, 1, '市场列表不受影响：' + fail)
    assert.equal(r.list[0].downloads, 0)
    assert.equal(r.downloads.failed, true)
  }
  const broken = createCommunity({
    mods: { status: () => [], sync: async () => {}, stop: () => true },
    getConfig: () => ({}), setConfig() {}, log: { info() {}, warn() {}, debug() {} }, version: '1.2.0', registryUrl: 'https://x/index.json',
    fetcher: async (url) => {
      if (url.endsWith('index.json')) return { ok: true, json: async () => ({ schema: 1, assetsBase: 'https://github.com/o/r/releases/download/', modules: [pack('pet', '1.0.0').entry] }) }
      throw new TypeError('fetch failed')
    },
  })
  const r = await broken.list()
  assert.equal(r.list.length, 1)
  assert.equal(r.list[0].downloads, 0)
})

test('下载量有缓存：连着打开市场不重复打 GitHub 接口；刷新才重读', async () => {
  const s = setup([pack('pet', '1.0.0')], { releases: [[rel('pet-v1.0.0', [9])]] })
  await s.c.list()
  await s.c.list()
  assert.equal(s.apiCalls().length, 1, '一次市场列表只问一次')
  await s.c.list({ force: true })
  assert.equal(s.apiCalls().length, 2, '强制刷新才再问一次')
})

test('市场面板：卡片显示下载次数、可以按热度排', () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(src, /'下载 ' \+ num\(m\.downloads\) \+ ' 次'/)
  assert.match(src, /按热度/)
  assert.match(src, /byHot/)
})

test('市场面板：分页渲染，筛选变化回第一页', () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  // 只画当前页，不把整个市场一次全渲染出来
  assert.match(src, /pageShown\.map\(card\)/)
  assert.ok(!src.includes('shown.map(card)'), '不能整列表直接渲染')
  assert.match(src, /PAGE_SIZE = 12/)
  assert.match(src, /setPage\(1\)/, '筛选条件变化要回第一页')
  assert.match(src, /Math\.min\(page, pages\)/, '旧页码越界要夹回来')
  assert.match(src, /第 ' \+ cur \+ ' \/ ' \+ pages \+ ' 页/)
})

test('市场面板：标题跳仓库，只认 http(s) 的 homepage', () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  // 默认深入到模块库里该模块自己的目录（有的 homepage 指向别处仓库根，不准）
  assert.match(
    src,
    /stats\.source\s*\n\s*\? 'https:\/\/github\.com\/' \+ stats\.source \+ '\/tree\/main\/modules\/' \+ m\.id/,
  )
  // 认不出模块库仓库才退 homepage，且必须过 http(s) 校验
  assert.match(src, /m\.homepage/)
  assert.match(src, /\/i\.test\(String\(m\.homepage \|\| ''\)\)/, 'homepage 必须过 http(s) 正则校验')
  assert.match(src, /target: '_blank', rel: 'noreferrer', title: '打开仓库主页'/)
})
