// 极简二维码生成器（字节模式、单个纠错版本），输出 PNG dataURL。
//
// 为什么要自己写：整个环境里没有 qrcode 库，而且「不弹浏览器」是这次优化的重点，
// 扫码登录需要把二维码画成图发给主人，不能退化成「请复制这串链接」。
//
// 实现范围（够用就好，不做完整 QR 规范）：
//   · 字节模式（byte mode），UTF-8
//   · 版本按数据长度自动选（1..10 附近），纠错级别 M
//   · 完整 RS 纠错编码（GF(256) 上的多项式取模）
//   · 掩码按规范评估 8 种，取惩罚分最低的
//   · 格式信息 / 版本信息 / 数据放置 / 定时图案 / 定位图案 / 对齐图案
//
// 覆盖小黑盒二维码那种长度（几百字节以内）绰绰有余。

import zlib from 'node:zlib'

// ── GF(256) 与 RS 纠错 ─────────────────────────────────────────
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
;(() => {
  let x = 1
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d // 0x11d = x^8 + x^4 + x^3 + x^2 + 1
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]
})()

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])

/** 生成 generator 多项式（首项系数 1），长度 = degree + 1 */
function rsGenerator(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i += 1) {
    // poly = poly * (x - α^i)
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

/** 算 RS 余数（纠错码字） */
function rsRemainder(data, degree) {
  const gen = rsGenerator(degree)
  const rem = new Array(degree).fill(0)
  for (const byte of data) {
    const factor = byte ^ rem[0]
    rem.shift()
    rem.push(0)
    for (let i = 0; i < degree; i += 1) rem[i] ^= gfMul(gen[i + 1], factor)
  }
  return rem
}

// ── 版本参数表（纠错级别 M） ─────────────────────────────────────
// 每个版本：总码字数、每块数据码字、块数、每块纠错码字（M 级）
const VER_M = {
  1: { total: 26, eccPerBlock: 10, groups: [[1, 16]] },
  2: { total: 44, eccPerBlock: 16, groups: [[1, 28]] },
  3: { total: 70, eccPerBlock: 26, groups: [[1, 44]] },
  4: { total: 100, eccPerBlock: 18, groups: [[2, 32]] },
  5: { total: 134, eccPerBlock: 24, groups: [[2, 43]] },
  6: { total: 172, eccPerBlock: 16, groups: [[4, 27]] },
  7: { total: 196, eccPerBlock: 18, groups: [[4, 31]] },
  8: { total: 242, eccPerBlock: 22, groups: [[2, 38], [2, 39]] },
  9: { total: 292, eccPerBlock: 22, groups: [[3, 36], [2, 37]] },
  10: { total: 346, eccPerBlock: 26, groups: [[4, 43], [1, 44]] },
}

const ALIGN_POS = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
}

const verOf = (n) => {
  const v = VER_M[n]
  const dataCw = v.groups.reduce((s, [cnt, cw]) => s + cnt * cw, 0)
  return { ...v, dataCw, eccPerBlock: v.eccPerBlock }
}

/** 某版本能装多少数据字节（字节模式） */
function capacityBytes(n) {
  const { dataCw } = verOf(n)
  // 4 bit 模式 + 8/16 bit 长度(版本<10 用 8bit) + 数据 + 4bit 结束符
  const lenBits = n < 10 ? 8 : 16
  return Math.floor(((dataCw * 8) - 4 - lenBits - 4) / 8)
}

/** 从 1 起找能装下的最小版本 */
function pickVersion(bytes) {
  for (let n = 1; n <= 10; n += 1) if (bytes <= capacityBytes(n)) return n
  throw new Error(`内容太长（${bytes} 字节），超出这个极简实现的版本 10 上限`)
}

// ── 数据编码 ──────────────────────────────────────────────────
function bitsPush(out, value, len) {
  for (let i = len - 1; i >= 0; i -= 1) out.push((value >>> i) & 1)
}

function encodeData(text, version) {
  const data = Buffer.from(text, 'utf8')
  const { dataCw } = verOf(version)
  const bits = []
  bitsPush(bits, 0b0100, 4) // 字节模式
  bitsPush(bits, data.length, version < 10 ? 8 : 16)
  for (const byte of data) bitsPush(bits, byte, 8)
  // 结束符 + 补齐到字节
  const capBits = dataCw * 8
  const minBits = bits.length + 4
  if (minBits > capBits) throw new Error('数据超出该版本容量')
  bitsPush(bits, 0, 4)
  while (bits.length % 8 !== 0) bits.push(0)
  // 转成码字，再用 0xEC / 0x11 填充
  const cw = []
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let k = 0; k < 8; k += 1) b = (b << 1) | bits[i + k]
    cw.push(b)
  }
  const pad = [0xec, 0x11]
  let pi = 0
  while (cw.length < dataCw) { cw.push(pad[pi % 2]); pi += 1 }
  return cw
}

/** 分块 + 算纠错 + 交织成最终码字序列 */
function interleave(dataCw, version) {
  const { groups, eccPerBlock } = verOf(version)
  const blocks = []
  let off = 0
  for (const [cnt, cw] of groups) {
    for (let i = 0; i < cnt; i += 1) {
      blocks.push(dataCw.slice(off, off + cw))
      off += cw
    }
  }
  const eccs = blocks.map((b) => rsRemainder(b, eccPerBlock))
  const out = []
  const maxData = Math.max(...blocks.map((b) => b.length))
  for (let i = 0; i < maxData; i += 1) for (const b of blocks) if (i < b.length) out.push(b[i])
  for (let i = 0; i < eccPerBlock; i += 1) for (const e of eccs) out.push(e[i])
  return out
}

// ── 矩阵构建 ──────────────────────────────────────────────────
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

function buildMatrix(codewords, version, maskIdx) {
  const size = 17 + version * 4
  const m = Array.from({ length: size }, () => new Array(size).fill(null)) // null = 空

  const setF = (r, c, v) => { if (r >= 0 && c >= 0 && r < size && c < size) m[r][c] = v }

  // 定位图案（三个角）
  const finder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const r = r0 + dr; const c = c0 + dc
        if (r < 0 || c < 0 || r >= size || c >= size) continue
        const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6
        const dark = inRing && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4))
        m[r][c] = dark ? 1 : 0
      }
    }
  }
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0)

  // 定时图案
  for (let i = 8; i < size - 8; i += 1) {
    if (m[6][i] === null) m[6][i] = i % 2 === 0 ? 1 : 0
    if (m[i][6] === null) m[i][6] = i % 2 === 0 ? 1 : 0
  }

  // 对齐图案
  const ap = ALIGN_POS[version] || []
  for (const r0 of ap) {
    for (const c0 of ap) {
      // 跳过和定位图案重叠的
      if ((r0 <= 8 && c0 <= 8) || (r0 <= 8 && c0 >= size - 9) || (r0 >= size - 9 && c0 <= 8)) continue
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1
          setF(r0 + dr, c0 + dc, dark ? 1 : 0)
        }
      }
    }
  }

  // 格式信息占位（先填，后面统一写）
  // 预留位置：格式信息和版本信息都要先占住，免得数据写进去
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false))
  const markReserved = (r0, c0, h, w) => {
    for (let r = r0; r < r0 + h; r += 1) for (let c = c0; c < c0 + w; c += 1) if (r >= 0 && c >= 0 && r < size && c < size) reserved[r][c] = true
  }
  markReserved(0, 0, 9, 9)
  markReserved(0, size - 8, 9, 8)
  markReserved(size - 8, 0, 8, 9)
  for (let i = 0; i < 9; i += 1) { reserved[8][i] = true; reserved[i][8] = true }
  for (let i = 0; i < 8; i += 1) { reserved[8][size - 1 - i] = true; reserved[size - 1 - i][8] = true }
  reserved[8][8] = true // 深色模块
  if (version >= 7) { markReserved(0, size - 11, 6, 3); markReserved(size - 11, 0, 3, 6) }

  // 数据放置（之字形，从右下往上）
  const bits = []
  for (const cw of codewords) for (let i = 7; i >= 0; i -= 1) bits.push((cw >>> i) & 1)
  let bi = 0
  const maskFn = MASKS[maskIdx]
  let upward = true
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5 // 跳过定时图案那一列
    for (let k = 0; k < size; k += 1) {
      const row = upward ? size - 1 - k : k
      for (let d = 0; d < 2; d += 1) {
        const c = col - d
        if (m[row][c] !== null || reserved[row][c]) continue
        let bit = bi < bits.length ? bits[bi] : 0
        bi += 1
        if (maskFn(row, c)) bit ^= 1
        m[row][c] = bit
      }
    }
    upward = !upward
  }

  // 深色模块
  m[size - 8][8] = 1

  // 格式信息（纠错级别 M = 00，掩码 3bit）
  const fmtData = (0b00 << 3) | maskIdx
  let fmt = fmtData << 10
  for (let i = 14; i >= 10; i -= 1) if ((fmt >>> i) & 1) fmt ^= 0x537 << (i - 10)
  fmt = ((fmtData << 10) | (fmt & 0x3ff)) ^ 0x5412
  const fmtBits = []
  for (let i = 0; i < 15; i += 1) fmtBits.push((fmt >>> i) & 1)

  // 第一个副本：左上
  const f1 = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]]
  for (let i = 0; i < 15; i += 1) { const [r, c] = f1[i]; m[r][c] = fmtBits[i] }
  // 第二个副本：右上 + 左下
  for (let i = 0; i < 8; i += 1) m[8][size - 1 - i] = fmtBits[i]
  for (let i = 8; i < 15; i += 1) m[size - 15 + i][8] = fmtBits[i]

  // 版本信息（>=7）
  if (version >= 7) {
    let rem = version
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const vb = (version << 12) | rem
    for (let i = 0; i < 18; i += 1) {
      const bit = (vb >>> i) & 1
      const r = Math.floor(i / 3)
      const c = i % 3
      m[size - 11 + c][r] = bit
      m[r][size - 11 + c] = bit
    }
  }

  return m
}

/** 惩罚分（只要大致合理的排序即可，不做完整评估） */
function penalty(m) {
  const size = m.length
  let score = 0
  const runScore = (get) => {
    let s = 0
    for (let i = 0; i < size; i += 1) {
      let run = 1
      for (let j = 1; j < size; j += 1) {
        if (get(i, j) === get(i, j - 1)) run += 1
        else { if (run >= 5) s += 3 + (run - 5); run = 1 }
      }
      if (run >= 5) s += 3 + (run - 5)
    }
    return s
  }
  score += runScore((i, j) => m[i][j])
  score += runScore((j, i) => m[i][j])
  // 2x2 同色块
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = m[r][c]
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3
    }
  }
  return score
}

// ── PNG 输出 ──────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function matrixToPng(m, { scale = 5, quiet = 4 } = {}) {
  const n = m.length
  const dim = (n + quiet * 2) * scale
  const raw = Buffer.alloc((dim + 1) * dim) // 每行前面一个 filter byte

  for (let y = 0; y < dim; y += 1) {
    const rowStart = y * (dim + 1)
    raw[rowStart] = 0 // filter: none
    const my = Math.floor(y / scale) - quiet
    for (let x = 0; x < dim; x += 1) {
      const mx = Math.floor(x / scale) - quiet
      const dark = my >= 0 && my < n && mx >= 0 && mx < n && m[my][mx] === 1
      raw[rowStart + 1 + x] = dark ? 0x00 : 0xff
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(dim, 0)
  ihdr.writeUInt32BE(dim, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 0  // color type: grayscale
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return 'data:image/png;base64,' + png.toString('base64')
}

/**
 * 把文本编码成二维码 PNG dataURL。
 * @param {string} text
 * @param {{scale?:number}} [opt]
 */
export function encodeQrPng(text, { scale = 5 } = {}) {
  const version = pickVersion(Buffer.byteLength(String(text), 'utf8'))
  const dataCw = encodeData(String(text), version)
  const codewords = interleave(dataCw, version)

  let best = null
  let bestScore = Infinity
  for (let maskIdx = 0; maskIdx < 8; maskIdx += 1) {
    const m = buildMatrix(codewords, version, maskIdx)
    const score = penalty(m)
    if (score < bestScore) { bestScore = score; best = m }
  }
  return matrixToPng(best, { scale })
}
