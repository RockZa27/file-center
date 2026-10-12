/**
 * CSV for the table editor: read a file into rows and write the rows back the way the file was written
 * (same delimiter, same line ending, byte-order mark kept), so saving one changed cell changes only that cell.
 */

const CANDIDATES = [',', ';', '\t', '|']

/** the delimiter the file uses: the candidate that appears most, the same number of times, on the first lines */
export function detectDelimiter(text, fallback = ',') {
  const lines = []
  let cur = ''
  let quoted = false
  const counts = () => Object.fromEntries(CANDIDATES.map(d => [d, 0]))
  let c = counts()
  for (let i = 0; i < text.length && lines.length < 20; i++) {
    const ch = text[i]
    if (ch === '"') quoted = !quoted
    else if (!quoted && (ch === '\n' || ch === '\r')) {
      if (cur.length) lines.push(c)
      c = counts()
      cur = ''
      continue
    } else if (!quoted && ch in c) c[ch]++
    cur += ch
  }
  if (cur.length) lines.push(c)
  let best = fallback
  let bestScore = 0
  for (const d of CANDIDATES) {
    const n = lines.map(l => l[d])
    if (!n.length || n[0] === 0) continue
    // a delimiter splits every line into the same number of fields; the most consistent and frequent one wins
    const same = n.filter(v => v === n[0]).length / n.length
    const score = same * n[0]
    if (score > bestScore) { best = d; bestScore = score }
  }
  return best
}

/** { rows, delimiter, eol, bom, trailingNewline } */
export function parseCsv(text, delimiter) {
  const bom = text.startsWith('﻿')
  if (bom) text = text.slice(1)
  const delim = delimiter || detectDelimiter(text)
  const eol = /\r\n/.test(text) ? '\r\n' : (/\r(?!\n)/.test(text) && !/\n/.test(text) ? '\r' : '\n')
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  // something read since the last line break: the last line has no line break after it
  let open = false
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    open = true
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        quoted = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue }
    if (ch === delim) { row.push(field); field = ''; i++; continue }
    if (ch === '\r' || ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      open = false
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += ch
    i++
  }
  if (open) { row.push(field); rows.push(row) }
  const trailingNewline = n > 0 && !open
  return { rows, delimiter: delim, eol, bom, trailingNewline }
}

const needsQuotes = (v, delim) => v.includes(delim) || v.includes('"') || v.includes('\n') || v.includes('\r')

/** rows back to text with the file's own delimiter, line ending and byte-order mark */
export function toCsv(rows, { delimiter = ',', eol = '\n', bom = false, trailingNewline = true } = {}) {
  const out = rows.map(r => r.map(v => {
    const s = v == null ? '' : String(v)
    return needsQuotes(s, delimiter) ? `"${s.replaceAll('"', '""')}"` : s
  }).join(delimiter)).join(eol)
  return (bom ? '﻿' : '') + out + (trailingNewline && rows.length ? eol : '')
}

/** every row as long as the longest, so the table has straight columns */
export function squareUp(rows) {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0)
  return rows.map(r => (r.length < width ? [...r, ...Array(width - r.length).fill('')] : r))
}

/** A, B, ... Z, AA, AB ... */
export function columnName(i) {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}
