// 下载图片 / 语音：限大小、限协议、挡掉内网地址（防 SSRF）。也支持 base64:// 和本地文件。

import { readFileSync, statSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'

/** IPv4 地址是不是内网 / 本机 / 保留地址。 */
function isPrivateIpv4(ip) {
  const o = String(ip || '').split('.').map(Number)
  if (o.length !== 4 || o.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true
  const [a, b, c] = o
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127) // 100.64/10 运营商级 NAT
    || (a === 169 && b === 254) // 链路本地 / 云元数据
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2)) // 192.0.0/24、192.0.2/24
    || (a === 192 && b === 88 && c === 99) // 6to4 中继
    // 198.18.0.0/15 是基准测试段，但 Clash/fake-ip 也用它；不能当内网拦，否则代理用户图片全挂
    || (a === 198 && b === 51 && c === 100) // 文档
    || (a === 203 && b === 0 && c === 113) // 文档
    || a >= 224 // 组播 / 保留
}

const v4FromGroups = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`

/** 把 IPv6 文本拆成 8 个 16 位数字；不合法返回 null。 */
function v6Groups(ip) {
  const s = String(ip || '').toLowerCase().split('%')[0]
  const parts = s.split('::')
  if (parts.length > 2) return null
  const head = parts[0] ? parts[0].split(':') : []
  const tail = parts.length === 2 ? (parts[1] ? parts[1].split(':') : []) : null
  if (tail === null) {
    if (head.length !== 8) return null
    return head.map(parseGroup)
  }
  const fill = 8 - head.length - tail.length
  if (fill < 0) return null
  return [...head, ...Array(fill).fill('0'), ...tail].map(parseGroup)
}

function parseGroup(x) {
  if (!/^[0-9a-f]{1,4}$/.test(x)) return NaN
  return parseInt(x, 16)
}

/**
 * IPv6 里嵌的 IPv4（::ffff:a.b.c.d / ::ffff:xxxx:xxxx）已经在上层转成十六进制；
 * 这里统一按 16 位分组判断。IPv4-mapped、NAT64、6to4、Teredo 等能夹带内网 IPv4 的
 * 前缀在严格模式下整套拒绝，避免用一条公网 IPv6 骗过检查。
 */
function isPrivateIpv6(g) {
  if (!g || g.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffff)) return true
  // :: 和 ::1
  if (g.every((x) => x === 0)) return true
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true
  // ::ffff:0:0/96（IPv4-mapped）：按最后 32 位当 IPv4 检查
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return isPrivateIpv4(v4FromGroups(g[6], g[7]))
  }
  // ::/96（IPv4-compatible，已废弃、不可全局路由）
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return true
  // NAT64 64:ff9b::/96、64:ff9b:1::/48：可能映射到内网 IPv4，整段拒绝
  if (g[0] === 0x64 && g[1] === 0xff9b) return true
  // 6to4 2002::/16：内嵌任意 IPv4
  if (g[0] === 0x2002) return true
  // Teredo 2001:0000::/32
  if (g[0] === 0x2001 && g[1] === 0) return true
  // 文档 2001:db8::/32
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true
  // ULA fc00::/7
  if ((g[0] & 0xfe00) === 0xfc00) return true
  // 链路本地 fe80::/10
  if ((g[0] & 0xffc0) === 0xfe80) return true
  // 组播 ff00::/8
  if ((g[0] & 0xff00) === 0xff00) return true
  return false
}

export function isPrivateIp(ip) {
  if (!ip) return true
  let s = String(ip).trim().toLowerCase().split('%')[0]
  if (!s) return true
  if (isIP(s) === 4) return isPrivateIpv4(s)
  // URL 解析器会把 [::ffff:192.168.1.1] 正规化成 [::ffff:c0a8:101]；
  // 这里再兼容 DNS 直接返回带点分 IPv4 的形态，先转成十六进制分组。
  if (s.includes('.')) {
    const m = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
    if (!m) return true
    const v4 = m[1].split('.').map(Number)
    if (v4.length !== 4 || v4.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true
    s = s.slice(0, m.index) + (((v4[0] << 8) | v4[1]).toString(16)) + ':' + (((v4[2] << 8) | v4[3]).toString(16))
  }
  if (isIP(s) === 4) return isPrivateIpv4(s)
  return isPrivateIpv6(v6Groups(s))
}

// ---------- SSRF 防护强度 ----------
// 默认严格；setSsrpMode 保留给宿主/测试注入，未接面板时始终 strict。
let modeGetter = () => 'strict'
export function setSsrpMode (fn) { if (typeof fn === 'function') modeGetter = fn }
export const currentSsrpMode = () => (modeGetter() === 'loose' ? 'loose' : 'strict')

/** strict：只要有一个内网地址就拒绝；loose：全部都是内网才拒绝。 */
export function ssrfBlocked (ips, mode = currentSsrpMode()) {
  const list = (Array.isArray(ips) ? ips : []).filter((x) => typeof x === 'string' && x)
  if (!list.length) return true
  return mode === 'loose' ? list.every(isPrivateIp) : list.some(isPrivateIp)
}

export async function assertPublicUrl(url) {
  const u = new URL(url)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只允许 http / https')
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.localhost')) throw new Error('不允许访问本机地址')
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((x) => x.address)
  if (ssrfBlocked(ips)) throw new Error('不允许访问内网地址')
}

/**
 * 手动跟重定向：每一跳都重新做 SSRF 检查，避免「公网地址 302 到你内网」。
 * 默认最多 5 跳；fetchImpl 只给测试注入。
 */
export async function fetchGuarded(url, o = {}) {
  const fetchImpl = o.fetchImpl || fetch
  let current = String(url)
  for (let hop = 0; hop <= 5; hop++) {
    await assertPublicUrl(current)
    const r = await fetchImpl(current, { signal: AbortSignal.timeout(o.timeoutMs ?? 20000), redirect: 'manual' })
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const loc = r.headers.get('location')
      if (loc) {
        current = new URL(loc, current).href
        continue
      }
    }
    return r
  }
  throw new Error('重定向次数太多')
}

/**
 * 取一个 OneBot 图片 / 表情段的字节：先试 url，再试 file；都不行就问网关 get_image 换真实地址。
 * （SnowLuma 对内联来源的图片只给 `file: <md5>.png`，url 为空。）
 */
export async function segmentBytes(seg, onebot, o = {}) {
  const d = (seg && seg.data) || {}
  const tries = [d.url, d.file, d.path].filter((x) => typeof x === 'string' && x.trim())
  let lastErr = null
  for (const src of tries) {
    try {
      return await fetchImage(src, o)
    } catch (error) {
      lastErr = error
    }
  }
  if (onebot && d.file) {
    try {
      const info = await onebot.call('get_image', { file: d.file }, { timeoutMs: 15000 })
      for (const src of [info?.file, info?.url].filter(Boolean)) {
        try {
          return await fetchImage(src, o)
        } catch (error) {
          lastErr = error
        }
      }
    } catch (error) {
      lastErr = error
    }
  }
  throw lastErr || new Error('这个图片段没有可用的地址')
}

/**
 * @param {string} src http(s) 地址 / base64://… / file:// / 本地绝对路径
 * @param {{maxBytes?:number, timeoutMs?:number, allowLocal?:boolean, fetchImpl?:Function}} [o]
 */
export async function fetchImage(src, o = {}) {
  const maxBytes = o.maxBytes ?? 10 * 1024 * 1024
  const s = String(src || '').trim()
  if (!s) throw new Error('没有地址')
  if (s.startsWith('base64://')) {
    const buf = Buffer.from(s.slice(9), 'base64')
    if (buf.length > maxBytes) throw new Error('太大了')
    return buf
  }
  if (/^https?:\/\//i.test(s)) {
    const r = await fetchGuarded(s, o)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const len = Number(r.headers.get('content-length') || 0)
    if (len > maxBytes) throw new Error('太大了')
    const reader = r.body.getReader()
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) {
        try { reader.cancel() } catch (e) {}
        throw new Error('太大了')
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  }
  // 本地文件：只在调用方明确允许时读（QQ 网关在本机，给的可能是本地缓存路径）
  if (o.allowLocal !== false) {
    const p = s.startsWith('file://') ? fileURLToPath(s) : s
    if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/')) {
      if (statSync(p).size > maxBytes) throw new Error('太大了')
      return readFileSync(p)
    }
  }
  throw new Error('不认识的地址')
}
