/**
 * Reads spreadsheets for the preview: .xlsx / .xlsm (Office Open XML), .ods (OpenDocument) and .xls (xls.js), cell
 * values as the text a spreadsheet program shows (numbers and dates formatted), the first MAX_ROWS rows of each sheet.
 * Only the XML parts with cell values are read; formulas show their last computed value; macros are never read.
 * Plain string scanning, no DOM: nothing in the file is ever turned into HTML.
 */
import { unzipSync } from 'fflate'
import { readXls } from './xls'

export const MAX_ROWS = 1000
export const MAX_COLS = 200
// a file whose parts unpack to more than this is refused (a small zip can expand to gigabytes)
const MAX_UNZIPPED = 256 * 1024 * 1024

export class SheetError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function unzip(bytes, wanted) {
  let total = 0
  let files
  try {
    files = unzipSync(bytes, {
      filter: f => {
        if (!wanted(f.name)) return false
        total += f.originalSize
        if (total > MAX_UNZIPPED) throw new SheetError('too-big')
        return true
      },
    })
  } catch (e) {
    if (e instanceof SheetError) throw e
    throw new SheetError('unreadable')
  }
  const dec = new TextDecoder()
  return name => (files[name] ? dec.decode(files[name]) : null)
}

// ───── tiny XML helpers (the parts are machine-written, one element per tag) ─────

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
export const unescapeXml = s => s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e) => {
  if (e[0] !== '#') return ENT[e.toLowerCase()]
  const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
  try { return String.fromCodePoint(code) } catch { return '' }
})

export function attrs(tag) {
  const out = {}
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    out[m[1]] = unescapeXml(m[3] ?? m[4] ?? '')
  }
  return out
}
/** attribute by local name, whatever the namespace prefix */
const attr = (a, local) => {
  if (local in a) return a[local]
  for (const k in a) if (k.endsWith(`:${local}`)) return a[k]
  return undefined
}

/** every `<prefix:name ...>...</prefix:name>` or `<prefix:name .../>`: [openTag, inner, start, end] */
function* elements(xml, name, from = 0, to = xml.length) {
  const open = new RegExp(`<(?:[\\w.-]+:)?${name}(?=[\\s/>])[^>]*>`, 'g')
  open.lastIndex = from
  for (;;) {
    const m = open.exec(xml)
    if (!m || m.index >= to) return
    const tag = m[0]
    if (tag.endsWith('/>')) { yield [tag, '', m.index, open.lastIndex]; continue }
    const prefix = /^<([\w.-]+:)?/.exec(tag)[1] ?? ''
    const close = `</${prefix}${name}>`
    const end = xml.indexOf(close, open.lastIndex)
    if (end < 0) return
    yield [tag, xml.slice(open.lastIndex, end), m.index, end + close.length]
    open.lastIndex = end + close.length
  }
}
const first = (xml, name) => elements(xml, name).next().value ?? null
const textOf = (xml, name) => [...elements(xml, name)].map(([, inner]) => unescapeXml(inner.replace(/<[^>]*>/g, ''))).join('')

// ───── number formats ─────

export const BUILTIN_FORMATS = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?',
  13: '# ??/??', 14: 'dd/mm/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM',
  20: 'h:mm', 21: 'h:mm:ss', 22: 'dd/mm/yyyy h:mm', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;(#,##0)', 39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;(#,##0.00)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0', 48: '##0.0E+0', 49: '@',
  // Thai locale built-ins (Excel th-TH)
  59: 't0', 60: 't0.00', 61: 't#,##0', 62: 't#,##0.00', 67: 't0%', 68: 't0.00%', 69: 't# ?/?', 70: 't# ??/??',
  71: 'd/m/yyyy', 72: 'd-mmm-yy', 73: 'd-mmm', 74: 'mmm-yy', 75: 'h:mm', 76: 'h:mm:ss', 77: 'd/m/yyyy h:mm', 78: 'mm:ss',
  79: '[h]:mm:ss', 80: 'mm:ss.0', 81: 'd/m/bb',
}

/** the parts of a format that are not placeholders: quoted text, [colours], escapes, padding */
const stripLiterals = f => f.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').replace(/[_*]./g, '')

export function isDateFormat(f) {
  if (!f || f === 'General' || f === '@') return false
  const s = stripLiterals(f.split(';')[0])
  return /[dmyhsb]/i.test(s) && !/[0#?]/.test(s.replace(/s\.0+/i, ''))
}

const pad2 = n => String(n).padStart(2, '0')

/** an Excel serial day number as the date (and time) it stands for, in the order day/month/year */
export function formatSerialDate(serial, format, date1904 = false) {
  if (!Number.isFinite(serial)) return String(serial)
  let days = Math.floor(serial)
  const frac = serial - days
  // 1900 system: day 60 is the 29 February 1900 that never was (kept for Lotus 1-2-3)
  if (!date1904 && days < 61) days += 1
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
  const d = new Date(epoch + days * 86400000 + Math.round(frac * 86400) * 1000)
  const f = stripLiterals((format || '').split(';')[0]).toLowerCase()
  const hasDate = /[dyb]/.test(f) || /m{3,}/.test(f) || (/m/.test(f) && !/[hs]/.test(f))
  const hasTime = /[hs]/.test(f)
  // bb / bbbb: the Buddhist year Thai documents use
  const year = d.getUTCFullYear() + (/b/.test(f) ? 543 : 0)
  const date = `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${year}`
  const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}${/s/.test(f) ? `:${pad2(d.getUTCSeconds())}` : ''}`
  if (hasDate && hasTime) return `${date} ${time}`
  if (hasTime) return time
  return date
}

const numberFormatters = new Map()
function numberFormatter(decimals, grouping) {
  const key = `${decimals}|${grouping}`
  if (!numberFormatters.has(key)) {
    numberFormatters.set(key, new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: grouping }))
  }
  return numberFormatters.get(key)
}

/** "General": what a spreadsheet shows in a cell of normal width */
export function formatGeneral(v) {
  if (!Number.isFinite(v)) return String(v)
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v)
  const abs = Math.abs(v)
  if (abs !== 0 && (abs < 1e-9 || abs >= 1e15)) return v.toExponential(5).replace(/\.?0+e/, 'e').toUpperCase()
  return String(Number(v.toPrecision(11)))
}

/** a number in a number format: decimals, thousands separators, percent, currency text around it */
export function formatNumber(v, format, date1904 = false) {
  if (!format || format === 'General' || format === '@') return formatGeneral(v)
  if (isDateFormat(format)) return formatSerialDate(v, format, date1904)
  const sections = format.split(';')
  let f = sections[0]
  let value = v
  if (v < 0 && sections[1] !== undefined) { f = sections[1]; value = -v } else if (v === 0 && sections[2] !== undefined) f = sections[2]
  f = f.replace(/^t/, '')
  // currency and other text: [$฿-41E] → "฿"; colours and conditions ([Red], [>100]) are left out
  const plain = f.replace(/\[\$([^\]-]*)[^\]]*\]/g, '"$1"').replace(/\[[^\]]*\]/g, '')
  const core = stripLiterals(plain)
  if (/E[+-]/i.test(core)) {
    const decimals = (/\.([0#]+)E/i.exec(core)?.[1] ?? '').length
    return value.toExponential(decimals).toUpperCase().replace(/E([+-])(\d)$/, 'E$10$2')
  }
  if (!/[0#?]/.test(core)) return formatGeneral(v)
  const percent = core.includes('%')
  const decimals = (/\.([0#?]+)/.exec(core)?.[1] ?? '').length
  const grouping = /[0#?],[0#?]/.test(core)
  const n = numberFormatter(decimals, grouping).format(percent ? value * 100 : value)
  // text before and after the digits stays where the format put it: "฿"#,##0 → ฿1,234; (#,##0) → (1,234)
  const lit = s => s.replace(/"([^"]*)"|\\(.)|_.|\*.|[0#?.,%]/g, (m, q, e) => q ?? e ?? (m[0] === '_' ? ' ' : ''))
  const firstDigit = plain.search(/[0#?]/)
  const lastDigit = Math.max(plain.lastIndexOf('0'), plain.lastIndexOf('#'), plain.lastIndexOf('?'))
  return `${lit(plain.slice(0, firstDigit))}${n}${percent ? '%' : ''}${lit(plain.slice(lastDigit + 1))}`
}

// ───── xlsx ─────

/** "B12" → 1 (zero-based column) */
export function columnIndex(ref) {
  let c = 0
  for (const ch of ref) {
    const code = ch.charCodeAt(0)
    if (code < 65 || code > 90) break
    c = c * 26 + (code - 64)
  }
  return c - 1
}

function resolveTarget(target) {
  if (target.startsWith('/')) return target.slice(1)
  const parts = ['xl']
  for (const p of target.split('/')) {
    if (p === '..') parts.pop()
    else if (p && p !== '.') parts.push(p)
  }
  return parts.join('/')
}

function readXlsx(bytes) {
  const read = unzip(bytes, n => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedStrings.xml' ||
    n === 'xl/styles.xml' || /^xl\/worksheets\/[^/]+\.xml$/.test(n))
  const workbook = read('xl/workbook.xml')
  if (!workbook) throw new SheetError('unreadable')
  const rels = {}
  for (const [tag] of elements(read('xl/_rels/workbook.xml.rels') ?? '', 'Relationship')) {
    const a = attrs(tag)
    rels[a.Id] = { target: resolveTarget(a.Target ?? ''), type: a.Type ?? '' }
  }
  const pr = first(workbook, 'workbookPr')
  const date1904 = pr ? ['1', 'true'].includes(attr(attrs(pr[0]), 'date1904')) : false

  const strings = [...elements(read('xl/sharedStrings.xml') ?? '', 'si')].map(([, inner]) => {
    // phonetic guides (<rPh>) are not part of the text
    const clean = inner.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '')
    return textOf(clean, 't')
  })

  const styles = read('xl/styles.xml') ?? ''
  const custom = {}
  for (const [tag] of elements(styles, 'numFmt')) {
    const a = attrs(tag)
    custom[a.numFmtId] = a.formatCode
  }
  const xfs = []
  const cellXfs = first(styles, 'cellXfs')
  if (cellXfs) for (const [tag] of elements(cellXfs[1], 'xf')) {
    const id = attr(attrs(tag), 'numFmtId') ?? '0'
    xfs.push(custom[id] ?? BUILTIN_FORMATS[id] ?? 'General')
  }

  const sheets = []
  for (const [tag] of elements(workbook, 'sheet')) {
    const a = attrs(tag)
    const rel = rels[attr(a, 'id')]
    // chart sheets and dialog sheets hold no cells
    if (!rel || !/worksheet$/.test(rel.type)) continue
    const xml = read(rel.target)
    if (xml === null) continue
    sheets.push({ name: a.name ?? '', hidden: (a.state ?? 'visible') !== 'visible', ...readWorksheet(xml, strings, xfs, date1904) })
  }
  return sheets
}

function cellText(tag, inner, strings, xfs, date1904) {
  const a = attrs(tag)
  const type = a.t ?? 'n'
  if (type === 'inlineStr') return textOf(inner, 't')
  const vEl = first(inner, 'v')
  const raw = vEl ? unescapeXml(vEl[1]) : ''
  if (raw === '') return ''
  if (type === 's') return strings[Number(raw)] ?? ''
  if (type === 'str' || type === 'e') return raw
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE'
  if (type === 'd') return raw.replace('T', ' ').replace(/(\.\d+)?Z?$/, '')
  return formatNumber(Number(raw), xfs[Number(a.s ?? 0)] ?? 'General', date1904)
}

function readWorksheet(xml, strings, xfs, date1904) {
  const rows = []
  let totalRows = 0
  let totalCols = 0
  const data = first(xml, 'sheetData')
  if (!data) return { rows, totalRows, totalCols, truncated: false }
  const start = data[2]
  const end = data[3]
  let next = 0
  for (const [tag, inner] of elements(xml, 'row', start, end)) {
    const a = attrs(tag)
    const r = a.r ? Number(a.r) - 1 : next
    next = r + 1
    let col = 0
    const cells = []
    let lastFilled = -1
    for (const [ctag, cinner] of elements(inner, 'c')) {
      const ref = attrs(ctag).r
      const c = ref ? columnIndex(ref) : col
      col = c + 1
      const text = cellText(ctag, cinner, strings, xfs, date1904)
      if (text === '') continue
      lastFilled = Math.max(lastFilled, c)
      if (c < MAX_COLS) cells[c] = text
    }
    if (lastFilled < 0) continue
    totalRows = r + 1
    totalCols = Math.max(totalCols, lastFilled + 1)
    if (r < MAX_ROWS) rows[r] = cells
  }
  return finish(rows, totalRows, totalCols)
}

/** fill the holes (empty rows and cells) and record how much was left out */
export function finish(sparse, totalRows, totalCols) {
  const width = Math.min(totalCols, MAX_COLS)
  const shown = Math.min(totalRows, MAX_ROWS)
  const rows = []
  for (let r = 0; r < shown; r++) {
    const src = sparse[r] ?? []
    const row = new Array(width)
    for (let c = 0; c < width; c++) row[c] = src[c] ?? ''
    rows.push(row)
  }
  return { rows, totalRows, totalCols, truncated: totalRows > MAX_ROWS || totalCols > MAX_COLS }
}

// ───── ods ─────

function odsCellText(inner) {
  const paras = [...elements(inner, 'p')].map(([, p]) => unescapeXml(
    p.replace(/<text:s\b([^>]*)\/>/g, (_, a) => ' '.repeat(Math.min(1000, Number(/text:c="(\d+)"/.exec(a)?.[1] ?? 1))))
      .replace(/<text:tab\b[^>]*\/>/g, '\t')
      .replace(/<text:line-break\b[^>]*\/>/g, '\n')
      .replace(/<[^>]*>/g, ''),
  ))
  return paras.join('\n')
}

function readOds(bytes) {
  const read = unzip(bytes, n => n === 'content.xml')
  const xml = read('content.xml')
  if (!xml) throw new SheetError('unreadable')
  const sheets = []
  for (const [tag, inner] of elements(xml, 'table')) {
    const sparse = []
    let r = 0
    let totalRows = 0
    let totalCols = 0
    for (const [rtag, rinner] of elements(inner, 'table-row')) {
      const rowRepeat = Math.max(1, Number(attr(attrs(rtag), 'number-rows-repeated') ?? 1))
      const cells = []
      let c = 0
      let lastFilled = -1
      // both kinds of cell in document order: covered cells (under a merged one) still take a column
      for (const m of rinner.matchAll(/<table:(covered-)?table-cell\b([^>]*?)(\/>|>([\s\S]*?)<\/table:\1?table-cell>)/g)) {
        const a = attrs(m[2])
        const repeat = Math.max(1, Number(attr(a, 'number-columns-repeated') ?? 1))
        const text = m[4] ? odsCellText(m[4]) : ''
        if (text !== '') {
          // a repeated filled cell is rare, but a sheet may repeat one across the whole row: cap it
          for (let k = 0; k < Math.min(repeat, MAX_COLS); k++) if (c + k < MAX_COLS) cells[c + k] = text
          lastFilled = c + repeat - 1
        }
        c += repeat
      }
      if (lastFilled >= 0) {
        // empty rows at the end of a sheet are usually one row repeated a million times: only filled rows count
        const shownRepeat = Math.min(rowRepeat, MAX_ROWS)
        for (let k = 0; k < shownRepeat && r + k < MAX_ROWS; k++) sparse[r + k] = cells
        totalRows = r + rowRepeat
        totalCols = Math.max(totalCols, lastFilled + 1)
      }
      r += rowRepeat
    }
    sheets.push({ name: attr(attrs(tag), 'name') ?? '', hidden: false, ...finish(sparse, totalRows, totalCols) })
  }
  return sheets
}

/** the sheets of a spreadsheet file: [{ name, hidden, rows: string[][], totalRows, totalCols, truncated }] */
export function readWorkbook(bytes, ext) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (ext === 'ods') return readOds(data)
  if (ext === 'xlsx' || ext === 'xlsm') return readXlsx(data)
  if (ext === 'xls') return readXls(data)
  throw new SheetError('unsupported')
}
