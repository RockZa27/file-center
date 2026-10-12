/**
 * The pure parts of the in-page viewers: CSV read/write for the table editor and the spreadsheet readers
 * (xlsx, ods, xls) with their number and date formats. No browser needed.
 */
import { describe, expect, test } from 'bun:test'
import { strToU8, zipSync } from 'fflate'
import { columnName, detectDelimiter, parseCsv, squareUp, toCsv } from './csv'
import { formatNumber, isDateFormat, MAX_ROWS, readWorkbook, SheetError } from './sheet'

describe('csv', () => {
  test('finds the delimiter the file uses, not the one inside quotes', () => {
    expect(detectDelimiter('a,b,c\n1,2,3\n')).toBe(',')
    expect(detectDelimiter('a;b;c\n"1,5";2;3\n')).toBe(';')
    expect(detectDelimiter('a\tb\n1\t2\n')).toBe('\t')
    expect(detectDelimiter('only one column\n')).toBe(',')
  })

  test('reads quoted fields with commas, doubled quotes and line breaks', () => {
    const text = '﻿ชื่อ,ที่อยู่\r\nสมชาย,"123 ถนนสุขุมวิท, กรุงเทพฯ"\r\nJohn,"say ""hi""\nthere"\r\n'
    const r = parseCsv(text)
    expect(r.bom).toBe(true)
    expect(r.eol).toBe('\r\n')
    expect(r.delimiter).toBe(',')
    expect(r.trailingNewline).toBe(true)
    expect(r.rows).toEqual([['ชื่อ', 'ที่อยู่'], ['สมชาย', '123 ถนนสุขุมวิท, กรุงเทพฯ'], ['John', 'say "hi"\nthere']])
    // written back the same way: delimiter, line ending, byte-order mark
    expect(toCsv(r.rows, r)).toBe(text)
  })

  test('a last line without a line break, empty fields and an empty file', () => {
    expect(parseCsv('a,,c\n,b,').rows).toEqual([['a', '', 'c'], ['', 'b', '']])
    expect(parseCsv('a,,c\n,b,').trailingNewline).toBe(false)
    expect(parseCsv('"",x').rows).toEqual([['', 'x']])
    expect(parseCsv('').rows).toEqual([])
    expect(toCsv([], { trailingNewline: true })).toBe('')
  })

  test('quotes only the fields that need it, with the file delimiter', () => {
    expect(toCsv([['a;b', 'c,d', 'e"f', 'g']], { delimiter: ';', eol: '\n', trailingNewline: false })).toBe('"a;b";c,d;"e""f";g')
    expect(toCsv([['1', '2']], { delimiter: '\t', eol: '\n' })).toBe('1\t2\n')
  })

  test('rows padded to the same length; column letters', () => {
    expect(squareUp([['a'], ['b', 'c', 'd'], []])).toEqual([['a', '', ''], ['b', 'c', 'd'], ['', '', '']])
    expect([0, 25, 26, 51, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA'])
  })
})

describe('number formats', () => {
  test('numbers, percent, currency, negatives in brackets', () => {
    expect(formatNumber(1234.5, '#,##0.00')).toBe('1,234.50')
    expect(formatNumber(0.05, '0.0%')).toBe('5.0%')
    expect(formatNumber(1500, '"฿"#,##0')).toBe('฿1,500')
    expect(formatNumber(1500, '[$฿-41E]#,##0.00')).toBe('฿1,500.00')
    expect(formatNumber(1500, '#,##0 "บาท"')).toBe('1,500 บาท')
    expect(formatNumber(-1234, '#,##0;(#,##0)')).toBe('(1,234)')
    expect(formatNumber(-1234, '#,##0')).toBe('-1,234')
    expect(formatNumber(12345.678, '0.00E+00')).toBe('1.23E+04')
    expect(formatNumber(0.1 + 0.2, 'General')).toBe('0.3')
    expect(formatNumber(42, '@')).toBe('42')
  })

  test('dates and times from serial day numbers', () => {
    expect(isDateFormat('dd/mm/yyyy')).toBe(true)
    expect(isDateFormat('#,##0.00 "dd"')).toBe(false)
    expect(isDateFormat('[Red]0.00')).toBe(false)
    expect(formatNumber(46037, 'dd/mm/yyyy')).toBe('15/01/2026')
    expect(formatNumber(46037.75, 'dd/mm/yyyy hh:mm')).toBe('15/01/2026 18:00')
    expect(formatNumber(0.5, 'h:mm')).toBe('12:00')
    expect(formatNumber(0.5, 'h:mm:ss')).toBe('12:00:00')
    // the Buddhist year Thai documents use
    expect(formatNumber(46037, 'd/m/bbbb')).toBe('15/01/2569')
    // 1904 date system (old Mac workbooks)
    expect(formatNumber(44575, 'dd/mm/yyyy', true)).toBe('15/01/2026')
    // before 1 March 1900 (the leap day that never was)
    expect(formatNumber(1, 'dd/mm/yyyy')).toBe('01/01/1900')
  })
})

const xlsxOf = parts => zipSync(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, strToU8(v)])))
const WORKBOOK = `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<workbookPr/><sheets><sheet name="ยอดขาย" sheetId="1" r:id="rId1"/><sheet name="ซ่อน" sheetId="2" state="hidden" r:id="rId2"/>
<sheet name="กราฟ" sheetId="3" r:id="rId3"/></sheets></workbook>`
const RELS = `<Relationships>
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet" Target="chartsheets/sheet3.xml"/>
</Relationships>`
const STYLES = `<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>
<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="4"/><xf numFmtId="10"/></cellXfs></styleSheet>`
const STRINGS = `<sst><si><t>วันที่</t></si><si><r><t>ราคา</t></r><r><t xml:space="preserve"> (บาท)</t></r></si><si><t>ปากกา &amp; ดินสอ</t><rPh><t>x</t></rPh></si></sst>`

describe('xlsx', () => {
  test('sheets in order, shared and inline strings, formats, gaps kept, chart sheets left out', () => {
    const sheet1 = `<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" s="1"><v>46037</v></c><c r="B2" s="2"><v>1234.5</v></c><c r="C2" t="s"><v>2</v></c></row>
<row r="4"><c r="A4" t="b"><v>1</v></c><c r="B4" t="str"><v>คำนวณ</v></c><c r="D4" t="inlineStr"><is><t>ข้อความ</t></is></c><c r="E4" t="e"><v>#DIV/0!</v></c><c r="F4" s="3"><v>0.125</v></c></row>
</sheetData></worksheet>`
    const sheet2 = '<x:worksheet xmlns:x="ns"><x:sheetData><x:row><x:c><x:v>7</x:v></x:c></x:row></x:sheetData></x:worksheet>'
    const bytes = xlsxOf({
      'xl/workbook.xml': WORKBOOK, 'xl/_rels/workbook.xml.rels': RELS, 'xl/styles.xml': STYLES, 'xl/sharedStrings.xml': STRINGS,
      'xl/worksheets/sheet1.xml': sheet1, 'xl/worksheets/sheet2.xml': sheet2, 'xl/vbaProject.bin': 'not read',
    })
    const sheets = readWorkbook(bytes, 'xlsx')
    expect(sheets.map(s => [s.name, s.hidden])).toEqual([['ยอดขาย', false], ['ซ่อน', true]])
    expect(sheets[0].rows).toEqual([
      ['วันที่', 'ราคา (บาท)', '', '', '', ''],
      ['15/01/2026', '1,234.50', 'ปากกา & ดินสอ', '', '', ''],
      ['', '', '', '', '', ''],
      ['TRUE', 'คำนวณ', '', 'ข้อความ', '#DIV/0!', '12.50%'],
    ])
    expect(sheets[0].truncated).toBe(false)
    // a namespace prefix and no cell references
    expect(sheets[1].rows).toEqual([['7']])
  })

  test('long sheets: the first MAX_ROWS rows and the real total', () => {
    const rows = Array.from({ length: MAX_ROWS + 5 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('')
    const sheets = readWorkbook(xlsxOf({
      'xl/workbook.xml': WORKBOOK, 'xl/_rels/workbook.xml.rels': RELS, 'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rows}</sheetData></worksheet>`,
    }), 'xlsx')
    expect(sheets[0].rows.length).toBe(MAX_ROWS)
    expect(sheets[0].totalRows).toBe(MAX_ROWS + 5)
    expect(sheets[0].truncated).toBe(true)
  })

  test('a file that is not a spreadsheet is refused with a code the page can explain', () => {
    const fail = (bytes, ext) => { try { readWorkbook(bytes, ext); return null } catch (e) { return e instanceof SheetError ? e.code : 'other' } }
    expect(fail(new Uint8Array([1, 2, 3, 4]), 'xlsx')).toBe('unreadable')
    expect(fail(xlsxOf({ 'word/document.xml': '<w/>' }), 'xlsx')).toBe('unreadable')
    expect(fail(new Uint8Array(600), 'xls')).toBe('unreadable')
    expect(fail(new Uint8Array(10), 'numbers')).toBe('unsupported')
  })
})

describe('ods', () => {
  test('repeated rows and cells, spaces, covered cells, the shown text of each cell', () => {
    const content = `<office:document-content><office:body><office:spreadsheet>
<table:table table:name="แผ่น1">
<table:table-row><table:table-cell office:value-type="string"><text:p>ชื่อ<text:s text:c="2"/>สกุล</text:p></table:table-cell><table:covered-table-cell/><table:table-cell office:value-type="float" office:value="1500"><text:p>1,500.00</text:p></table:table-cell></table:table-row>
<table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="2"><text:p>ซ้ำ</text:p></table:table-cell></table:table-row>
<table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>
</table:table>
<table:table table:name="ว่าง"><table:table-row><table:table-cell/></table:table-row></table:table>
</office:spreadsheet></office:body></office:document-content>`
    const sheets = readWorkbook(zipSync({ 'content.xml': strToU8(content), mimetype: strToU8('application/vnd.oasis.opendocument.spreadsheet') }), 'ods')
    expect(sheets.map(s => s.name)).toEqual(['แผ่น1', 'ว่าง'])
    expect(sheets[0].rows).toEqual([['ชื่อ  สกุล', '', '1,500.00'], ['ซ้ำ', 'ซ้ำ', ''], ['ซ้ำ', 'ซ้ำ', '']])
    expect(sheets[0].totalRows).toBe(3)
    expect(sheets[1].rows).toEqual([])
  })
})

describe('xls', () => {
  // made by LibreOffice from a sheet with: สวัสดี | 1.5 | =A1&"!" | TRUE | =1/0
  const XLS = [
  '0M8R4KGxGuEAAAAAAAAAAAAAAAAAAAAAOwADAP7/CQAGAAAAAAAAAAAAAAABAAAACAAAAAAAAAAAEAAAAgAAAAEAAAD+////AAAAAAAAAAD/////////////',
  '////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
  '////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
  '////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
  '////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
  '///////////////////////////////////////////////////////////////////////////////////9//////////7///8EAAAABQAAAAYAAAAHAAAA',
  '/v///wkAAAD+////////////////////////////////////////////////////////////////////////////////////////////////////////////',
  '////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
  '////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
  '////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
  '////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
  '/////////////////////////////////////////////1IAbwBvAHQAIABFAG4AdAByAHkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAWAAUA////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/v///wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD///////////////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAD+////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//',
  '/////////////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP7///8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/v///wAA',
  'AAAAAAAAAQAAAAIAAAADAAAABAAAAAUAAAAGAAAABwAAAAgAAAAJAAAACgAAAAsAAAAMAAAADQAAAA4AAAAPAAAAEAAAABEAAAASAAAAEwAAABQAAAAVAAAA',
  'FgAAABcAAAAYAAAAGQAAABoAAAAbAAAAHAAAAP7///8eAAAA/v////7///8hAAAAIgAAACMAAAD+////JQAAACYAAAD+////////////////////////////',
  '////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
  '////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
  '////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////',
  '//////////////////////////////////////////////////////////////////////////////////////////8JCBAAAAYFALsNzAcAAAAABgAAAOEA',
  'AgCwBMEAAgAAAOIAAABcAHAABAAAQ2FsYyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg',
  'ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIEIAAgCwBGEBAgAAAMABAAA9AQIAAQCcAAIADgCvAQIAAAC8AQIAAAA9ABIAAAAAAABA',
  'ACA4AAAAAAABAFgCQAACAAAAjQACAAAAIgACAAAADgACAAEAtwECAAAA2gACAAAAMQAeANwAAAAIAJABAAAAAgEABwFDAGEAbABpAGIAcgBpADEAGgDIAAAA',
  '/3+QAQAAAAAAAAUBQQByAGkAYQBsADEAGgDIAAAA/3+QAQAAAAAAAAUBQQByAGkAYQBsADEAGgDIAAAA/3+QAQAAAAAAAAUBQQByAGkAYQBsADEAIADcAAAA',
  'CACQAQAAAAIAAAgBRgByAGUAZQBTAGEAbgBzAB4EDACkAAcAAEdlbmVyYWweBAwApQAHAABHZW5lcmFs4AAUAAAApAD1/yAAAAAAAAAAAAAAAMAg4AAUAAEA',
  'AAD1/yAAAPQAAAAAAAAAAMAg4AAUAAEAAAD1/yAAAPQAAAAAAAAAAMAg4AAUAAIAAAD1/yAAAPQAAAAAAAAAAMAg4AAUAAIAAAD1/yAAAPQAAAAAAAAAAMAg',
  '4AAUAAAAAAD1/yAAAPQAAAAAAAAAAMAg4AAUAAAAAAD1/yAAAPQAAAAAAAAAAMAg4AAUAAAAAAD1/yAAAPQAAAAAAAAAAMAg4AAUAAAAAAD1/yAAAPQAAAAA',
  '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',
  ].join('')

  test('BIFF8 cells: shared strings, numbers, formula results', () => {
    const sheets = readWorkbook(Uint8Array.from(atob(XLS), c => c.charCodeAt(0)), 'xls')
    expect(sheets.length).toBe(1)
    expect(sheets[0].rows).toEqual([['สวัสดี', '1.5', 'สวัสดี!', 'TRUE', '#DIV/0!']])
  })
})
