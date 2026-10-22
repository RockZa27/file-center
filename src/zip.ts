import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, writeSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { BlobReader, configure, ZipReader, ZipWriter } from '@zip.js/zip.js'
import { config } from './config'
import { bad, cleanName, HttpError, uniquePath, within } from './fsx'

configure({ useWebWorkers: false })

/** zip.js reads the whole central directory into memory before it yields one entry: a bigger one is refused unread */
export const DIRECTORY_MAX_BYTES = 64 * 1024 ** 2
export const DIRECTORY_MAX_ENTRIES = 100_000
/**
 * What the end of the file says about the central directory (EOCD, and the ZIP64 record when the 32-bit fields are
 * full), read before zip.js is let near the file. Refuses with 413 `archive.directory-too-big`. A file with no EOCD is
 * left to zip.js, which refuses it as not-zip. `maxEntries` is a lower limit still (the extractor's file cap); passing
 * it refuses with `tooMany()` instead.
 */
export async function checkDirectory(abs: string, { maxEntries = DIRECTORY_MAX_ENTRIES, tooMany }: { maxEntries?: number; tooMany?: () => HttpError } = {}): Promise<void> {
  const file = Bun.file(abs)
  const size = file.size
  const tailLen = Math.min(size, 22 + 0xffff)
  const tail = new Uint8Array(await file.slice(size - tailLen, size).arrayBuffer())
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let at = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { at = i; break }
  }
  if (at < 0) return
  let entries = BigInt(dv.getUint16(at + 10, true))
  let bytes = BigInt(dv.getUint32(at + 12, true))
  if (entries === 0xffffn || bytes === 0xffffffffn || dv.getUint32(at + 16, true) === 0xffffffff) {
    // the ZIP64 locator is the 20 bytes before the EOCD and points at the ZIP64 record
    const locAt = size - tailLen + at - 20
    if (locAt >= 0) {
      const loc = new DataView(await file.slice(locAt, locAt + 20).arrayBuffer())
      if (loc.getUint32(0, true) === 0x07064b50) {
        const recAt = Number(loc.getBigUint64(8, true))
        if (recAt >= 0 && recAt + 56 <= size) {
          const rec = new DataView(await file.slice(recAt, recAt + 56).arrayBuffer())
          if (rec.getUint32(0, true) === 0x06064b50) {
            entries = rec.getBigUint64(32, true)
            bytes = rec.getBigUint64(40, true)
          }
        }
      }
    }
  }
  if (bytes > BigInt(DIRECTORY_MAX_BYTES)) throw new HttpError(413, 'archive.directory-too-big')
  if (entries > BigInt(Math.min(maxEntries, DIRECTORY_MAX_ENTRIES))) throw tooMany ? tooMany() : new HttpError(413, 'archive.directory-too-big')
}


// Names without the UTF-8 flag: zip.js takes valid UTF-8 as it is (macOS and many tools never set the flag) and decodes
// the rest as CP437, which turns a Thai or CJK name from Windows into mojibake. That "the rest" is decoded with the
// code page the zips of this site come from (ZIP_LEGACY_ENCODING, default cp874 = Thai Windows) instead.
const LEGACY_ALIASES: Record<string, string> = { cp874: 'windows-874', ibm874: 'windows-874', cp932: 'shift_jis', cp936: 'gbk', cp949: 'euc-kr', cp950: 'big5' }
function legacyDecoder(name: string): TextDecoder | null {
  const key = name.trim().toLowerCase()
  if (key === 'cp437' || key === '') return null // zip.js's own default
  const label = LEGACY_ALIASES[key] ?? key.replace(/^cp(125\d)$/, 'windows-$1')
  try { return new TextDecoder(label as ConstructorParameters<typeof TextDecoder>[0]) } catch { return legacyDecoder('cp874') }
}

/** pass to ZipReader / getEntries: the file names and comments that are not UTF-8 are read as the legacy code page */
export const legacyNames = {
  decodeText(value: Uint8Array, encoding: string): string | undefined {
    // zip.js asks for cp437 only when the flag is off and the bytes are not valid UTF-8
    if (encoding.trim().toLowerCase() !== 'cp437') return undefined
    return legacyDecoder(config.zipLegacyEncoding)?.decode(value)
  },
}

export type ZipItem = {
  name: string; abs: string; dir: boolean; mtime: number; size: number
  /** contents made when the entry is reached, instead of reading `abs` (a backup's backup.json knows the sizes of the entries before it) */
  bytes?: () => Uint8Array
}

/** how hard deflate works: user downloads and zips stay at 1 (fast); backups pick their own (settings page) */
export type ZipOptions = {
  level?: number
  /** called with the bytes read from every file as they go; throwing stops the zip with that error */
  onRead?: (bytes: number) => void
  /** called after each file entry is written, with its sizes in the archive */
  onEntry?: (item: ZipItem, sizes: { uncompressed: number; compressed: number }) => void
}

/** expand files and folders into a flat list of archive entries (symlinks are skipped) */
export function collectZipItems(baseAbs: string, names: string[]): ZipItem[] {
  const out: ZipItem[] = []
  const visit = (abs: string, arc: string) => {
    let st
    try { st = lstatSync(abs) } catch { return }
    if (st.isSymbolicLink()) return
    if (st.isDirectory()) {
      out.push({ name: arc + '/', abs, dir: true, mtime: st.mtimeMs, size: 0 })
      for (const n of readdirSync(abs)) visit(join(abs, n), `${arc}/${n}`)
    } else {
      out.push({ name: arc, abs, dir: false, mtime: st.mtimeMs, size: st.size })
    }
  }
  for (const n of names) visit(join(baseAbs, n), n)
  return out
}

const STORE_ONLY = new Set(['.zip', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mkv', '.mov', '.mp3', '.aac', '.gz', '.7z', '.rar', '.xz', '.pdf', '.docx', '.xlsx', '.pptx'])

// entries this big get ZIP64 headers up front; deflate can grow incompressible data a little past its size
const ZIP64_FROM = 0xf000_0000
const SAMPLE = 256 * 1024
// zip.js has no native deflate for any level but 6, so it runs its own: level 1 is about 1.6x (text) to 2x faster than
// 3, and its archives were 0.3% to 1.6% bigger when measured (docs/development.md, "วัดความเร็ว (benchmark)")
export const DEFLATE_LEVEL = 1

/**
 * Deflate runs on one core at roughly 40 MB/s, so a 5 GB video would take two minutes and save nothing.
 * Files over 1 MB are compressed only when their first 256 KB shrink by at least 10%.
 */
function worthCompressing(item: ZipItem): boolean {
  if (STORE_ONLY.has(extname(item.name).toLowerCase())) return false
  if (item.size <= 1024 * 1024) return true
  try {
    const fd = openSync(item.abs, 'r')
    const sample = new Uint8Array(SAMPLE)
    let n = 0
    try { n = readSync(fd, sample, 0, SAMPLE, 0) } finally { closeSync(fd) }
    return Bun.deflateSync(sample.subarray(0, n), { level: 1 }).length < n * 0.9
  } catch {
    return true
  }
}

/**
 * Streams a zip archive. Writes ZIP64 records when an entry or the archive passes 4 GB, and the writer
 * waits for the reader, so memory stays flat even for huge files.
 */
export function zipStream(items: ZipItem[], options: ZipOptions = {}): ReadableStream<Uint8Array> {
  const level = options.level ?? DEFLATE_LEVEL
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const zip = new ZipWriter(writable)
  ;(async () => {
    for (const item of items) {
      const lastModDate = new Date(item.mtime)
      if (item.dir) {
        await zip.add(item.name, undefined, { directory: true, lastModDate })
        continue
      }
      let source: ReadableStream<Uint8Array> = item.bytes ? new Blob([item.bytes()]).stream() : Bun.file(item.abs).stream()
      if (options.onRead) {
        const onRead = options.onRead
        source = source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            onRead(chunk.length)
            controller.enqueue(chunk)
          },
        }))
      }
      const entry = await zip.add(item.name, source, { lastModDate, level: item.bytes || worthCompressing(item) ? level : 0, zip64: item.size >= ZIP64_FROM })
      options.onEntry?.(item, { uncompressed: entry.uncompressedSize ?? 0, compressed: entry.compressedSize ?? 0 })
    }
    await zip.close()
  })().catch(err => writable.abort(err).catch(() => {}))
  return readable
}

/**
 * Extract a zip archive into destDir. Reads the central directory, so ZIP64 archives over 4 GB work, and
 * checks every file's CRC. Protects against zip-slip and zip bombs (the declared sizes are checked first,
 * the bytes really written are counted too), caps the number of files, and turns names this system would
 * refuse (":", "?", control characters...) into safe ones.
 */
export async function unzipTo(zipAbs: string, destDir: string, limits: { maxBytes: number; maxFiles: number }): Promise<number> {
  const tooBig = () => bad('zip.too-big')
  const unsafe = () => bad('zip.unsafe-path')
  // the end of the file says how many entries there are: a zip that claims more than we would extract is refused before
  // zip.js reads (and keeps in memory) the whole directory
  await checkDirectory(zipAbs, { maxEntries: limits.maxFiles, tooMany: () => bad('zip.too-many-files', { max: limits.maxFiles.toLocaleString() }) })
  const reader = new ZipReader(new BlobReader(Bun.file(zipAbs)), legacyNames)
  try {
    const entries = await reader.getEntries()
    const files = entries.filter(e => !e.directory)
    if (files.length > limits.maxFiles) throw bad('zip.too-many-files', { max: limits.maxFiles.toLocaleString() })
    if (files.reduce((sum, e) => sum + e.uncompressedSize, 0) > limits.maxBytes) throw tooBig()
    // a password-protected entry can not be taken out here: say so, before anything is written
    const locked = files.filter(e => e.encrypted)
    if (locked.length) throw bad('zip.encrypted', { n: locked.length, name: locked[0].filename })

    let total = 0
    let count = 0
    for (const entry of entries) {
      const name = entry.filename
      const parts = name.replaceAll('\\', '/').split('/').filter(s => s && s !== '.')
      if (parts.some(s => s === '..') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw unsafe()
      if (!parts.length) continue
      const target = join(destDir, ...parts.map(cleanName))
      if (!within(destDir, target)) throw unsafe()
      if (entry.directory) {
        mkdirSync(target, { recursive: true })
        continue
      }
      mkdirSync(dirname(target), { recursive: true })
      const fd = openSync(uniquePath(target), 'wx')
      let failure: Error | null = null
      try {
        await entry.getData(new WritableStream<Uint8Array>({
          write(chunk) {
            total += chunk.length
            // the header may lie about the size: count what really comes out
            if (total > limits.maxBytes) throw (failure = tooBig())
            for (let at = 0; at < chunk.length;) at += writeSync(fd, chunk, at)
          },
        }), { checkSignature: true })
      } catch (err) {
        throw failure ?? err
      } finally {
        closeSync(fd)
      }
      count++
    }
    return count
  } finally {
    await reader.close()
  }
}
