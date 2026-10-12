/**
 * Excel 97-2003 workbooks (.xls, BIFF8 inside a compound file) for the preview: sheet names, cell values (shared
 * strings, numbers, last computed formula results) and number formats. Only the Workbook stream is read: macros
 * (VBA storage) and embedded objects are never looked at. Older BIFF5 files and password-protected ones are refused.
 */
import { BUILTIN_FORMATS, finish, formatNumber, MAX_COLS, MAX_ROWS, SheetError } from './sheet'

const END = 0xfffffffe
const FREE = 0xffffffff

/** the named stream of a compound file (CFB), as bytes */
function cfbStream(bytes, wanted) {
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
  if (bytes.length < 512 || sig.some((b, i) => bytes[i] !== b)) throw new SheetError('unreadable')
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sectorSize = 1 << v.getUint16(0x1e, true)
  const miniSize = 1 << v.getUint16(0x20, true)
  if (sectorSize !== 512 && sectorSize !== 4096) throw new SheetError('unreadable')
  const sectors = Math.floor((bytes.length - sectorSize) / sectorSize)
  const at = id => sectorSize + id * sectorSize
  const u32 = off => (off + 4 <= bytes.length ? v.getUint32(off, true) : END)

  // the FAT: its sector numbers are in the header (109) and then in a chain of DIFAT sectors
  const fatSectors = []
  for (let i = 0; i < 109; i++) fatSectors.push(u32(0x4c + i * 4))
  let difat = u32(0x44)
  for (let guard = 0; difat < sectors && guard < sectors; guard++) {
    const per = sectorSize / 4 - 1
    for (let i = 0; i < per; i++) fatSectors.push(u32(at(difat) + i * 4))
    difat = u32(at(difat) + per * 4)
  }
  const fat = []
  for (const s of fatSectors) {
    if (s >= sectors) continue
    for (let i = 0; i < sectorSize / 4; i++) fat.push(u32(at(s) + i * 4))
  }
  const chain = (start, table) => {
    const out = []
    for (let s = start; s !== END && s !== FREE && s < table.length; s = table[s]) {
      out.push(s)
      if (out.length > table.length) throw new SheetError('unreadable')
    }
    return out
  }
  const read = (start, size) => {
    const out = new Uint8Array(size)
    let n = 0
    for (const s of chain(start, fat)) {
      if (n >= size) break
      const part = bytes.subarray(at(s), Math.min(at(s) + sectorSize, bytes.length)).subarray(0, size - n)
      out.set(part, n)
      n += part.length
    }
    return out.subarray(0, n)
  }

  // directory entries: 128 bytes each, the name in UTF-16
  const dir = read(v.getUint32(0x30, true), sectors * sectorSize)
  const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength)
  const entries = []
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const len = Math.min(64, dv.getUint16(off + 0x40, true))
    let name = ''
    for (let i = 0; i + 2 < len; i += 2) name += String.fromCharCode(dv.getUint16(off + i, true))
    entries.push({ name, type: dir[off + 0x42], start: dv.getUint32(off + 0x74, true), size: dv.getUint32(off + 0x78, true) })
  }
  const root = entries.find(e => e.type === 5)
  const entry = entries.find(e => e.type === 2 && wanted.includes(e.name))
  if (!root || !entry) return null
  if (entry.size >= v.getUint32(0x38, true)) return read(entry.start, entry.size)
  // small streams live in the mini stream, 64-byte pieces chained by the mini FAT
  const miniFat = []
  for (const s of chain(v.getUint32(0x3c, true), fat)) for (let i = 0; i < sectorSize / 4; i++) miniFat.push(u32(at(s) + i * 4))
  const mini = read(root.start, root.size)
  const out = new Uint8Array(entry.size)
  let n = 0
  for (const s of chain(entry.start, miniFat)) {
    if (n >= entry.size) break
    const part = mini.subarray(s * miniSize, s * miniSize + miniSize).subarray(0, entry.size - n)
    out.set(part, n)
    n += part.length
  }
  return out.subarray(0, n)
}

/** reads across a record and its CONTINUE records; text split between them restarts with a new flags byte */
class Reader {
  constructor(chunks) { this.chunks = chunks; this.c = 0; this.p = 0 }
  get chunk() { return this.chunks[this.c] }
  next() { this.c++; this.p = 0; if (this.c >= this.chunks.length) throw new SheetError('unreadable') }
  u8() { if (this.p >= this.chunk.length) this.next(); return this.chunk[this.p++] }
  u16() { return this.u8() | (this.u8() << 8) }
  u32() { return (this.u16() | (this.u16() << 16)) >>> 0 }
  skip(n) { while (n > 0) { if (this.p >= this.chunk.length) this.next(); const k = Math.min(n, this.chunk.length - this.p); this.p += k; n -= k } }
  chars(count, high) {
    let s = ''
    while (count > 0) {
      if (this.p >= this.chunk.length) { this.next(); high = (this.u8() & 1) === 1 }
      const per = high ? 2 : 1
      const k = Math.min(count, Math.floor((this.chunk.length - this.p) / per))
      for (let i = 0; i < k; i++) {
        s += String.fromCharCode(high ? this.chunk[this.p] | (this.chunk[this.p + 1] << 8) : this.chunk[this.p])
        this.p += per
      }
      count -= k
      if (k === 0 && count > 0) this.p = this.chunk.length
    }
    return s
  }
  /** XLUnicodeString: length (16 or 8 bits), flags, characters, then formatting runs and phonetic data skipped */
  string(shortLength = false) {
    const cch = shortLength ? this.u8() : this.u16()
    const flags = this.u8()
    const runs = flags & 8 ? this.u16() : 0
    const ext = flags & 4 ? this.u32() : 0
    const s = this.chars(cch, (flags & 1) === 1)
    this.skip(runs * 4 + ext)
    return s
  }
}

const ERRORS = { 0x00: '#NULL!', 0x07: '#DIV/0!', 0x0f: '#VALUE!', 0x17: '#REF!', 0x1d: '#NAME?', 0x24: '#NUM!', 0x2a: '#N/A' }

function rk(value) {
  let n
  if (value & 2) n = value >> 2
  else {
    const b = new DataView(new ArrayBuffer(8))
    b.setUint32(4, value & 0xfffffffc, true)
    n = b.getFloat64(0, true)
  }
  return value & 1 ? n / 100 : n
}

export function readXls(bytes) {
  const stream = cfbStream(bytes, ['Workbook', 'Book'])
  if (!stream) throw new SheetError('unreadable')
  const v = new DataView(stream.buffer, stream.byteOffset, stream.byteLength)
  const records = []
  for (let off = 0; off + 4 <= stream.length;) {
    const type = v.getUint16(off, true)
    const len = v.getUint16(off + 2, true)
    records.push({ type, off, data: stream.subarray(off + 4, Math.min(off + 4 + len, stream.length)) })
    off += 4 + len
  }
  const first = records[0]
  if (!first || first.type !== 0x809 || first.data.length < 4 || (first.data[0] | (first.data[1] << 8)) !== 0x600) throw new SheetError('unreadable')

  const sheets = []
  const strings = []
  const formats = { ...BUILTIN_FORMATS }
  const xfs = []
  let date1904 = false
  // workbook globals: up to the first EOF
  let i = 1
  for (; i < records.length && records[i].type !== 0x0a; i++) {
    const { type, data } = records[i]
    const r = new Reader([data])
    if (type === 0x2f) throw new SheetError('encrypted')
    else if (type === 0x22) date1904 = data[0] === 1
    else if (type === 0x41e) { const id = r.u16(); formats[id] = r.string() }
    else if (type === 0xe0) { r.u16(); xfs.push(r.u16()) }
    else if (type === 0x85) {
      const pos = r.u32()
      const hidden = r.u8() & 3
      const kind = r.u8()
      if (kind === 0) sheets.push({ name: r.string(true), hidden: hidden !== 0, pos })
    } else if (type === 0xfc) {
      const chunks = [data]
      for (let k = i + 1; k < records.length && records[k].type === 0x3c; k++) chunks.push(records[k].data)
      const sr = new Reader(chunks)
      sr.u32()
      const unique = sr.u32()
      try { for (let k = 0; k < unique; k++) strings.push(sr.string()) } catch { /* a cut-off table: keep what was read */ }
    }
  }
  const byOffset = new Map(records.map((rec, k) => [rec.off, k]))
  const fmt = ixfe => formats[xfs[ixfe] ?? 0] ?? 'General'

  return sheets.map(sheet => {
    const sparse = []
    let totalRows = 0
    let totalCols = 0
    const put = (row, col, text) => {
      if (text === '') return
      totalRows = Math.max(totalRows, row + 1)
      totalCols = Math.max(totalCols, col + 1)
      if (row < MAX_ROWS && col < MAX_COLS) (sparse[row] ??= [])[col] = text
    }
    let k = byOffset.get(sheet.pos)
    if (k === undefined) return { name: sheet.name, hidden: sheet.hidden, ...finish([], 0, 0) }
    let pending = null
    for (k++; k < records.length && records[k].type !== 0x0a; k++) {
      const { type, data } = records[k]
      if (type === 0x207) {
        // the text result of the formula just before
        if (pending) try { put(pending.row, pending.col, new Reader([data]).string()) } catch { /* left empty */ }
        pending = null
        continue
      }
      if (data.length < 6) continue
      const r = new Reader([data])
      const row = r.u16()
      const col = r.u16()
      try {
        if (type === 0xfd) { r.u16(); put(row, col, strings[r.u32()] ?? '') }
        else if (type === 0x204 || type === 0xd6) { r.u16(); put(row, col, r.string()) }
        else if (type === 0x203) { const x = r.u16(); put(row, col, formatNumber(new DataView(data.buffer, data.byteOffset + 6, 8).getFloat64(0, true), fmt(x), date1904)) }
        else if (type === 0x27e) { const x = r.u16(); put(row, col, formatNumber(rk(r.u32()), fmt(x), date1904)) }
        else if (type === 0xbd) {
          const last = data[data.length - 2] | (data[data.length - 1] << 8)
          for (let c = col; c <= last; c++) { const x = r.u16(); put(row, c, formatNumber(rk(r.u32()), fmt(x), date1904)) }
        } else if (type === 0x205) { r.u16(); const val = r.u8(); put(row, col, r.u8() ? (ERRORS[val] ?? '#ERR') : val ? 'TRUE' : 'FALSE') }
        else if (type === 0x06) {
          const x = r.u16()
          const res = data.subarray(6, 14)
          if (res[6] === 0xff && res[7] === 0xff) {
            if (res[0] === 0) pending = { row, col }
            else if (res[0] === 1) put(row, col, res[2] ? 'TRUE' : 'FALSE')
            else if (res[0] === 2) put(row, col, ERRORS[res[2]] ?? '#ERR')
          } else put(row, col, formatNumber(new DataView(res.buffer, res.byteOffset, 8).getFloat64(0, true), fmt(x), date1904))
        }
      } catch { /* one damaged cell does not hide the others */ }
    }
    return { name: sheet.name, hidden: sheet.hidden, ...finish(sparse, totalRows, totalCols) }
  })
}
