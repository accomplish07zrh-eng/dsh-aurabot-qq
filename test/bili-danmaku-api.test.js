import test from 'node:test'
import assert from 'node:assert/strict'
import { createBiliApi } from '../src/bili/api.js'
import { videoPart, danmakuResponse } from '../src/bili/danmaku.js'

const video = 'BV1xx411c7mD'
const info = { bvid: video, aid: '1', cid: '22', duration: 90, part: 2 }
const nav = { data: { wbi_img: {
  img_url: 'https://i.example/7cd084941338484aae1ad9425b84077c.png',
  sub_url: 'https://i.example/4932caff0ff746eab6f01bf08b70ac45.png',
} } }

test('普通视频按分P取CID和时长，不把整个投稿的时长当作当前分P', () => {
  const data = { bvid: video, aid: 1, cid: 11, duration: 300, pages: [
    { page: 1, cid: 11, duration: 210 }, { page: 2, cid: 22, duration: 90 },
  ] }
  assert.equal(videoPart(data, 2).duration, 90)
  assert.equal(videoPart(data, 2).cid, '22')
  assert.throws(() => videoPart(data, 3), /分P/)
})

test('元数据只读：AV按aid查询，番剧解析result和单集毫秒时长', async () => {
  const urls = []
  const client = createBiliApi({ getCookie: () => 'buvid3=test', fetchImpl: async (url, options) => {
    urls.push(new URL(url))
    assert.notEqual(options.method, 'POST')
    if (url.includes('/nav')) return { json: async () => nav }
    return { json: async () => url.includes('/season')
      ? { code: 0, result: { title: '测试番剧', episodes: [{ id: 123, bvid: video, aid: 1, cid: 22, duration: 90000 }] } }
      : { code: 0, data: { ...info, pages: [{ page: 2, cid: 22, duration: 90 }] } } }
  } })
  assert.equal((await client.danmakuInfo('av170001', 2)).cid, '22')
  assert.equal(urls.at(-1).searchParams.get('aid'), '170001')
  const episode = await client.danmakuInfo('ep123', 1)
  assert.equal(episode.duration, 90)
  assert.equal(urls.at(-1).searchParams.get('ep_id'), '123')
})

test('发送一次：WBI与设备参数签名、CSRF、毫秒位置、平台原始结果均正确', async () => {
  let posts = 0
  let checked = false
  const client = createBiliApi({ getCookie: () => 'SESSDATA=fake; bili_jct=csrf', fetchImpl: async (url, options) => {
    if (url.includes('/nav')) return { json: async () => nav }
    posts++
    assert.equal(checked, true)
    assert.equal(options.method, 'POST')
    const query = new URL(url).searchParams
    assert.match(query.get('w_rid'), /^[a-f0-9]{32}$/)
    assert.equal(query.get('web_location'), '1315873')
    assert.equal(query.get('csrf'), 'csrf')
    for (const key of ['dm_img_list', 'dm_img_str', 'dm_cover_img_str', 'dm_img_inter']) assert.ok(query.has(key))
    const form = new URLSearchParams(options.body)
    assert.equal(form.get('oid'), '22')
    assert.equal(form.get('aid'), '1')
    assert.equal(form.get('progress'), '8250')
    assert.equal(form.get('mode'), '4')
    assert.equal(form.get('csrf'), 'csrf')
    assert.equal(form.get('msg'), '你好😀')
    return { json: async () => ({ code: 0, message: 'OK', ttl: 1, secret: 'omit', data: { dmid_str: '12345678901234567890', visible: true, cookie: 'omit' } }) }
  } })
  const result = await client.postDanmaku(info, '你好😀', 8250, 4, { beforePost() { checked = true } })
  assert.equal(posts, 1)
  assert.equal(result.dmid_str, '12345678901234567890')
  assert.equal(result.platformResponse.data.visible, true)
  assert.ok(!JSON.stringify(result).includes('omit'))
})

test('签名期间关闭功能、平台拒绝和网络超时都不重发', async () => {
  for (const scenario of ['closed', 'rejected', 'timeout']) {
    let posts = 0
    const client = createBiliApi({ getCookie: () => 'bili_jct=csrf', fetchImpl: async (url) => {
      if (url.includes('/nav')) return { json: async () => nav }
      posts++
      if (scenario === 'timeout') throw new Error('timeout')
      return { json: async () => ({ code: -352, message: 'risk' }) }
    } })
    await assert.rejects(client.postDanmaku(info, '测试', 0, 1, { beforePost() {
      if (scenario === 'closed') throw new Error('closed')
    } }))
    assert.equal(posts, scenario === 'closed' ? 0 : 1)
  }
})

test('大整数ID不从已丢失精度的数字推测；保留平台提供的字符串', () => {
  assert.equal(danmakuResponse({ code: 0, data: { dmid: 12345678901234567890 } }).data.dmid_str, undefined)
  assert.equal(danmakuResponse({ code: 0, data: { dmid: 12345678901234567890, dmid_str: '12345678901234567890' } }).data.dmid_str, '12345678901234567890')
})
