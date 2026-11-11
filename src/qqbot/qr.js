// 极简二维码编码器（字节模式，版本 1~15）。
// 目的只有一个：把官方给的「机器人分享链接」画成二维码塞进面板，让手机 QQ 扫一下就加好友 / 进群。
//
// 算法移植自 Kazuhiko Arase 的 qrcode-generator（MIT，http://www.d-project.com/qrcode/），
// 这里只留字节模式 + SVG 输出，去掉了 GIF/ASCII/汉字的编码器。第三方声明见 THIRD-PARTY-NOTICES.md。

// 每个版本每个纠错级别的分块表：[块数, 每块总码字数, 每块数据码字数, ...]（最多两组）
const RS_BLOCKS = {
  1: { L: [1, 26, 19], M: [1, 26, 16], Q: [1, 26, 13], H: [1, 26, 9] },
  2: { L: [1, 44, 34], M: [1, 44, 28], Q: [1, 44, 22], H: [1, 44, 16] },
  3: { L: [1, 70, 55], M: [1, 70, 44], Q: [2, 35, 17], H: [2, 35, 13] },
  4: { L: [1, 100, 80], M: [2, 50, 32], Q: [2, 50, 24], H: [4, 25, 9] },
  5: { L: [1, 134, 108], M: [2, 67, 43], Q: [2, 33, 15, 2, 34, 16], H: [2, 33, 11, 2, 34, 12] },
  6: { L: [2, 86, 68], M: [4, 43, 27], Q: [4, 43, 19], H: [4, 43, 15] },
  7: { L: [2, 98, 78], M: [4, 49, 31], Q: [2, 32, 14, 4, 33, 15], H: [4, 39, 13, 1, 40, 14] },
  8: { L: [2, 121, 97], M: [2, 60, 38, 2, 61, 39], Q: [4, 40, 18, 2, 41, 19], H: [4, 40, 14, 2, 41, 15] },
  9: { L: [2, 146, 116], M: [3, 58, 36, 2, 59, 37], Q: [4, 36, 16, 4, 37, 17], H: [4, 36, 12, 4, 37, 13] },
  10: { L: [2, 86, 68, 2, 87, 69], M: [4, 69, 43, 1, 70, 44], Q: [6, 43, 19, 2, 44, 20], H: [6, 43, 15, 2, 44, 16] },
  11: { L: [4, 101, 81], M: [1, 80, 50, 4, 81, 51], Q: [4, 50, 22, 4, 51, 23], H: [3, 36, 12, 8, 37, 13] },
  12: { L: [2, 116, 92, 2, 117, 93], M: [6, 58, 36, 2, 59, 37], Q: [4, 46, 20, 6, 47, 21], H: [7, 42, 14, 4, 43, 15] },
  13: { L: [4, 133, 107], M: [8, 59, 37, 1, 60, 38], Q: [8, 44, 20, 4, 45, 21], H: [12, 33, 11, 4, 34, 12] },
  14: { L: [3, 145, 115, 1, 146, 116], M: [4, 64, 40, 5, 65, 41], Q: [11, 36, 16, 5, 37, 17], H: [11, 36, 12, 5, 37, 13] },
  15: { L: [5, 109, 87, 1, 110, 88], M: [5, 65, 41, 5, 66, 42], Q: [5, 54, 24, 7, 55, 25], H: [11, 36, 12, 7, 37, 13] },
}

const ALIGN_POS = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42],
  9: [6, 26, 46], 10: [6, 28, 50], 11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66], 15: [6, 26, 48, 70],
}

// 纠错级别的两位编码（写进格式信息里的那两位）
const ECC_BITS = { L: 1, M: 0, Q: 3, H: 2 }

const EXP = new Array(256)
const LOG = new Array(256)
for (let i = 0; i < 8; i++) EXP[i] = 1 << i
for (let i = 8; i < 256; i++) EXP[i] = EXP[i - 4] ^ EXP[i - 5] ^ EXP[i - 6] ^ EXP[i - 8]
for (let i = 0; i < 255; i++) LOG[EXP[i]] = i

const gexp = (n) => {
  while (n < 0) n += 255
  while (n >= 256) n -= 255
  return EXP[n]
}
const glog = (n) => {
  if (n < 1) throw new Error(`glog(${n})`)
  return LOG[n]
}

/** 生成多项式 ∏(x - α^i)。 */
function eccPolynomial(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= poly[j] === 0 ? 0 : gexp(glog(poly[j]) + i)
    }
    poly = next
  }
  return poly
}

/** 对一块数据算纠错码字。 */
function rsEcc(data, degree) {
  const gen = eccPolynomial(degree)
  const buf = [...data, ...new Array(degree).fill(0)]
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i]
    if (!factor) continue
    const logFactor = glog(factor)
    for (let j = 0; j < gen.length; j++) {
      if (!gen[j]) continue
      buf[i + j] ^= gexp(logFactor + glog(gen[j]))
    }
  }
  return buf.slice(data.length)
}

const bchDigit = (n) => { let d = 0; while (n) { d++; n >>>= 1 } return d }
const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | 1
const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | 1
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1)

function bchTypeInfo(data) {
  let d = data << 10
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15))
  return ((data << 10) | d) ^ G15_MASK
}

function bchTypeNumber(data) {
  let d = data << 12
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18))
  return (data << 12) | d
}

const MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (_i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
]

/** 文本 → UTF-8 字节。 */
function utf8Bytes(text) {
  const out = []
  const s = String(text ?? '')
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else if (c < 0xd800 || c >= 0xe000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    else {
      i += 1
      c = 0x10000 + (((c & 0x3ff) << 10) | (s.charCodeAt(i) & 0x3ff))
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    }
  }
  return out
}

function rsBlocksOf(version, ecc) {
  const row = RS_BLOCKS[version]?.[ecc]
  if (!row) throw new Error(`不支持的二维码版本 / 级别：${version}/${ecc}`)
  const list = []
  for (let i = 0; i < row.length; i += 3) {
    const count = row[i]
    for (let j = 0; j < count; j++) list.push({ total: row[i + 1], data: row[i + 2] })
  }
  return list
}

const lenBitsFor = (version) => (version < 10 ? 8 : 16)

function buildCodewords(bytes, version, ecc) {
  const blocks = rsBlocksOf(version, ecc)
  const totalData = blocks.reduce((n, b) => n + b.data, 0)
  const bits = []
  const push = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1) }
  push(4, 4) // 字节模式
  push(bytes.length, lenBitsFor(version))
  for (const b of bytes) push(b, 8)
  if (bits.length > totalData * 8) throw new Error('二维码内容太长了')
  if (bits.length + 4 <= totalData * 8) push(0, 4)
  while (bits.length % 8 !== 0) bits.push(0)
  const dataWords = []
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]
    dataWords.push(v)
  }
  let pad = 0
  while (dataWords.length < totalData) {
    dataWords.push(pad % 2 === 0 ? 0xec : 0x11)
    pad++
  }
  // 分块 → 各自算纠错 → 交错排布
  const dc = []
  const ec = []
  let offset = 0
  for (const b of blocks) {
    const chunk = dataWords.slice(offset, offset + b.data)
    offset += b.data
    dc.push(chunk)
    ec.push(rsEcc(chunk, b.total - b.data))
  }
  const out = []
  const maxDc = Math.max(...dc.map((x) => x.length))
  const maxEc = Math.max(...ec.map((x) => x.length))
  for (let i = 0; i < maxDc; i++) for (const chunk of dc) if (i < chunk.length) out.push(chunk[i])
  for (let i = 0; i < maxEc; i++) for (const chunk of ec) if (i < chunk.length) out.push(chunk[i])
  return out
}

/** 选能装下的最小版本。 */
function pickVersion(byteLen, ecc) {
  for (let v = 1; v <= 15; v++) {
    const total = rsBlocksOf(v, ecc).reduce((n, b) => n + b.data, 0)
    const need = 4 + lenBitsFor(v) + byteLen * 8
    if (need <= total * 8) return v
  }
  throw new Error('二维码内容太长了（超过版本 15 的容量）')
}

/**
 * 生成二维码矩阵。
 * @returns {{size:number, dark:(r:number,c:number)=>boolean}}
 */
export function qrMatrix(text, { ecc = 'M' } = {}) {
  if (!ECC_BITS.hasOwnProperty(ecc)) throw new Error(`纠错级别只能是 L/M/Q/H：${ecc}`)
  const bytes = utf8Bytes(text)
  const version = pickVersion(bytes.length, ecc)
  const size = version * 4 + 17
  const data = buildCodewords(bytes, version, ecc)
  const mods = Array.from({ length: size }, () => new Array(size).fill(null))

  const probe = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      if (row + r < 0 || row + r >= size) continue
      for (let c = -1; c <= 7; c++) {
        if (col + c < 0 || col + c >= size) continue
        const on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4)
        mods[row + r][col + c] = on
      }
    }
  }
  probe(0, 0)
  probe(size - 7, 0)
  probe(0, size - 7)

  for (const row of ALIGN_POS[version]) {
    for (const col of ALIGN_POS[version]) {
      if (mods[row][col] !== null) continue
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          mods[row + r][col + c] = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0)
        }
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    if (mods[i][6] === null) mods[i][6] = i % 2 === 0
    if (mods[6][i] === null) mods[6][i] = i % 2 === 0
  }

  const writeFormat = (mask) => {
    const bits = bchTypeInfo((ECC_BITS[ecc] << 3) | mask)
    for (let i = 0; i < 15; i++) {
      const on = ((bits >> i) & 1) === 1
      if (i < 6) mods[i][8] = on
      else if (i < 8) mods[i + 1][8] = on
      else mods[size - 15 + i][8] = on
    }
    for (let i = 0; i < 15; i++) {
      const on = ((bits >> i) & 1) === 1
      if (i < 8) mods[8][size - i - 1] = on
      else if (i < 9) mods[8][15 - i - 1 + 1] = on
      else mods[8][15 - i - 1] = on
    }
    mods[size - 8][8] = true
  }

  const writeVersion = () => {
    if (version < 7) return
    const bits = bchTypeNumber(version)
    for (let i = 0; i < 18; i++) {
      const on = ((bits >> i) & 1) === 1
      mods[Math.floor(i / 3)][(i % 3) + size - 8 - 3] = on
      mods[(i % 3) + size - 8 - 3][Math.floor(i / 3)] = on
    }
  }

  // 数据区（含掩码）
  const mapData = (maskFn) => {
    let inc = -1
    let row = size - 1
    let bitIndex = 7
    let byteIndex = 0
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col -= 1
      for (;;) {
        for (let c = 0; c < 2; c++) {
          const cc = col - c
          if (mods[row][cc] !== null) continue
          let dark = false
          if (byteIndex < data.length) dark = ((data[byteIndex] >>> bitIndex) & 1) === 1
          if (maskFn(row, cc)) dark = !dark
          mods[row][cc] = dark
          bitIndex -= 1
          if (bitIndex === -1) { byteIndex += 1; bitIndex = 7 }
        }
        row += inc
        if (row < 0 || row >= size) { row -= inc; inc = -inc; break }
      }
    }
  }

  // 试 8 种掩码，取「罚分」最低的（保证扫得出来）
  const penalty = () => {
    let score = 0
    const at = (r, c) => mods[r][c] === true
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        let same = 0
        const dark = at(r, c)
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue
            if (r + dr < 0 || r + dr >= size || c + dc < 0 || c + dc >= size) continue
            if (dark === at(r + dr, c + dc)) same++
          }
        }
        if (same > 5) score += 3 + same - 5
      }
    }
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const n = [at(r, c), at(r + 1, c), at(r, c + 1), at(r + 1, c + 1)].filter(Boolean).length
        if (n === 0 || n === 4) score += 3
      }
    }
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size - 6; c++) {
        if (at(r, c) && !at(r, c + 1) && at(r, c + 2) && at(r, c + 3) && at(r, c + 4) && !at(r, c + 5) && at(r, c + 6)) score += 40
      }
    }
    for (let c = 0; c < size; c++) {
      for (let r = 0; r < size - 6; r++) {
        if (at(r, c) && !at(r + 1, c) && at(r + 2, c) && at(r + 3, c) && at(r + 4, c) && !at(r + 5, c) && at(r + 6, c)) score += 40
      }
    }
    let dark = 0
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (at(r, c)) dark++
    score += (Math.abs((100 * dark) / (size * size) - 50) / 5) * 10
    return score
  }

  writeVersion()
  let best = 0
  let bestScore = Infinity
  for (let m = 0; m < 8; m++) {
    // 每轮都从「只有功能图形」的状态重来：先把当前状态存下来，画完再还原
    const snapshot = mods.map((row2) => row2.map((v) => (v === null ? null : v)))
    writeFormat(m)
    mapData(MASKS[m])
    const score = penalty()
    if (score < bestScore) { bestScore = score; best = m }
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) mods[r][c] = snapshot[r][c]
  }
  writeFormat(best)
  // 数据区的 null 在上一轮已经全部填过（每轮都填满），这里再按最优掩码重画一次
  mapData(MASKS[best])

  return { size, dark: (r, c) => mods[r][c] === true, version }
}

/** 生成 SVG 字符串（黑块用一条 path，体积小）。 */
export function qrSvg(text, { ecc = 'M', size = 180, margin = 4 } = {}) {
  const { size: count, dark } = qrMatrix(text, { ecc })
  const total = count + margin * 2
  let d = ''
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (dark(r, c)) d += `M${c + margin},${r + margin}h1v1h-1z`
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`
    + `<rect width="${total}" height="${total}" fill="#ffffff"/><path d="${d}" fill="#000000"/></svg>`
}

/** 给面板直接塞进 <img src> 用。 */
export function qrSvgDataUrl(text, opts = {}) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(qrSvg(text, opts))
}
