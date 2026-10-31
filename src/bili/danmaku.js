// 弹幕用的分P / 番剧元数据与响应。接口参数参考 catbus 的网页端实现，见 docs/BILI-DANMAKU.md。
import { randomInt } from 'node:crypto'

export function bangumiEpisode(body, video, part) {
  if (body.code !== 0) throw Object.assign(new Error('番剧信息接口未成功'), { code: body.code })
  const season = body.result || body.data || {}
  const episodes = [...(season.episodes || []), ...(season.section || []).flatMap((section) => section.episodes || [])]
  const episode = video.startsWith('ep')
    ? episodes.find((item) => String(item.id) === video.slice(2))
    : (season.episodes || [])[part - 1]
  if (!episode?.aid || !episode.cid || !episode.bvid) throw new Error('没有找到这集番剧；ss链接的选集序号从1开始')
  return {
    bvid: String(episode.bvid), aid: String(episode.aid), cid: String(episode.cid),
    title: [season.title, `第${episode.title || part}集`, episode.long_title].filter(Boolean).join(' · '),
    duration: Number(episode.duration) / 1000, part, kind: 'bangumi',
    url: `https://www.bilibili.com/bangumi/play/ep${episode.id}`,
  }
}

export function videoPart(data, part) {
  const page = (data.pages || []).find((item) => Number(item.page) === part)
    || (part === 1 && !data.pages?.length ? { cid: data.cid, duration: data.duration } : null)
  if (!page?.cid) throw new Error('没有找到当前分P，请检查分P序号')
  return {
    bvid: String(data.bvid), aid: String(data.aid), cid: String(page.cid),
    title: String(data.title || ''), duration: Number(page.duration), part,
  }
}

// 使用无鼠标采样的初始参数；这不是验证码解算，也不会在风控失败后重试。
export function danmakuParams() {
  const b64 = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '')
  const offset = randomInt(1, 351)
  return {
    dm_img_list: '[]',
    dm_img_str: b64('WebGL 1.0 (OpenGL ES 2.0 Chromium)'),
    dm_cover_img_str: b64('ANGLE (NVIDIA, NVIDIA GeForce RTX 5060 Ti (0x00002D04) Direct3D11 vs_5_0 ps_5_0, D3D11)Google Inc. (NVIDIA'),
    dm_img_inter: JSON.stringify({ ds: [], wh: [randomInt(7500, 7901), randomInt(9000, 9201), randomInt(0, 121)], of: [offset, offset * 2, offset] }),
  }
}

/** 面板只返回平台的公开结果字段，不返回请求头、Cookie 或任意响应字段。 */
export function danmakuResponse(body) {
  const data = body.data || {}
  const result = { code: body.code, message: String(body.message || body.msg || ''), ttl: body.ttl, data: {} }
  for (const key of ['action', 'animation', 'colorful_src', 'dm_content', 'visible']) {
    if (Object.hasOwn(data, key)) result.data[key] = data[key]
  }
  // 大整数只能信字符串，拒绝已经丢失精度的 JSON 数字。
  const id = data.dmid_str ?? (Number.isSafeInteger(data.dmid) ? String(data.dmid) : '')
  if (id) result.data.dmid_str = String(id)
  return result
}
