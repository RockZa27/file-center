/**
 * Look inside a zip file without extracting it: list the entries from the central directory, and stream one entry out.
 * Nothing is written to disk and nothing is taken from the entry's name except the comparison with the names in the
 * archive itself. Only .zip (ZIP64 included); .rar and .7z are not supported.
 */
import { extname } from 'node:path'
import { BlobReader, type Entry, ZipReader } from '@zip.js/zip.js'
import { config } from './config'
import { bad, HttpError, notFound } from './fsx'
import './zip' // zip.js is configured there (no web workers)

/** more entries than this are not listed */
export const ARCHIVE_MAX_ENTRIES = 10_000
/** an entry this big and packed tighter than the ratio is a bomb, whatever the upload limit says */
export const BOMB_MIN_BYTES = 100 * 1024 ** 2
export const BOMB_RATIO = 100

/**
 * zip.js refuses a whole archive when one entry is called "../x"; here the names are only shown and compared, never used
 * as a path, so such an archive can still be looked into (entryName() refuses to take out an entry of that kind)
 */
const NAMES = { filenameValidation: 'tolerant' } as const

/** zip.js reads the whole central directory into memory before it yields one entry: a bigger one is refused unread */
export const DIRECTORY_MAX_BYTES = 64 * 1024 ** 2
export const DIRECTORY_MAX_ENTRIES = 100_000
/** how many archives are looked into at the same time; the next one waits outside (503 + Retry-After) */
export const ARCHIVE_MAX_CONCURRENT = 4
let active = 0

/** a place for one archive operation; the function it returns gives the place back (and may be called twice) */
function takeSlot(): () => void {
  if (active >= ARCHIVE_MAX_CONCURRENT) throw new HttpError(503, 'archive.busy')
  active++
  let released = false
  return () => { if (!released) { released = true; active-- } }
}
export const archiveBusy = () => active

/**
 * What the end of the file says about the central directory (EOCD, and the ZIP64 record when the 32-bit fields are
 * full), read before zip.js is let near the file. Refuses with 413 `archive.directory-too-big`. A file with no EOCD is
 * left to zip.js, which refuses it as not-zip.
 */
export async function checkDirectory(abs: string): Promise<void> {
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
  if (bytes > BigInt(DIRECTORY_MAX_BYTES) || entries > BigInt(DIRECTORY_MAX_ENTRIES)) throw new HttpError(413, 'archive.directory-too-big')
}

export type ArchiveEntry = { name: string; dir: boolean; size: number; compressed: number; modified: number; encrypted: boolean }

/** PK\3\4 (a first entry), PK\5\6 (an empty archive), PK\7\8 (a split archive's marker) */
async function looksLikeZip(abs: string): Promise<boolean> {
  const head = new Uint8Array(await Bun.file(abs).slice(0, 4).arrayBuffer())
  return head[0] === 0x50 && head[1] === 0x4b && ((head[2] === 3 && head[3] === 4) || (head[2] === 5 && head[3] === 6) || (head[2] === 7 && head[3] === 8))
}

async function open(abs: string): Promise<ZipReader<Blob>> {
  if (!(await looksLikeZip(abs))) throw bad('archive.not-zip')
  await checkDirectory(abs)
  return new ZipReader(new BlobReader(Bun.file(abs)))
}

/** the entries of the central directory (not the data), at most ARCHIVE_MAX_ENTRIES */
export async function listArchive(abs: string): Promise<{ entries: ArchiveEntry[]; truncated: boolean }> {
  const release = takeSlot()
  let reader: ZipReader<Blob>
  try { reader = await open(abs) } catch (err) { release(); throw err }
  try {
    const entries: ArchiveEntry[] = []
    let truncated = false
    for await (const e of reader.getEntriesGenerator(NAMES)) {
      if (entries.length >= ARCHIVE_MAX_ENTRIES) { truncated = true; break }
      entries.push({
        name: e.filename, dir: e.directory, size: e.uncompressedSize, compressed: e.compressedSize,
        modified: e.lastModDate.getTime(), encrypted: e.encrypted,
      })
    }
    return { entries, truncated }
  } catch (err) {
    // a damaged central directory is a file that is not a zip as far as anyone can tell
    if (err instanceof HttpError) throw err
    throw bad('archive.not-zip')
  } finally {
    await reader.close().catch(() => {})
    release()
  }
}

/** a name from the request: no "..", no absolute path, no backslash, no NUL (it is only compared with the archive's names, but a name like that is never one to open) */
export function entryName(input: unknown): string {
  if (typeof input !== 'string' || !input || input.includes('\0') || input.includes('\\') || input.startsWith('/') || /^[a-zA-Z]:/.test(input)) {
    throw bad('archive.bad-entry')
  }
  if (input.split('/').some(s => s === '..')) throw bad('archive.bad-entry')
  return input
}

// only these may open in the browser's tab; the rest is always a download (script, html, svg and the like never run on our origin)
const INLINE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.pdf', '.txt'])

/**
 * One entry as a response. `wantInline` is honoured for images, PDF and plain text only. Refused before any byte is
 * sent: an encrypted entry (422), one that claims more than UPLOAD_MAX_SIZE or is packed more than 100:1 and bigger
 * than 100 MB (413). While streaming, the bytes are counted and the answer is cut off if they pass the declared size.
 */
export async function archiveEntryResponse(abs: string, input: unknown, wantInline: boolean, contentDisposition: (kind: 'inline' | 'attachment', name: string) => string): Promise<Response> {
  const wanted = entryName(input)
  const release = takeSlot()
  let reader: ZipReader<Blob>
  try { reader = await open(abs) } catch (err) { release(); throw err }
  const done = async () => { await reader.close().catch(() => {}); release() }
  let entry: Entry | null = null
  try {
    let seen = 0
    for await (const e of reader.getEntriesGenerator(NAMES)) {
      if (e.filename === wanted) { entry = e; break }
      if (++seen >= DIRECTORY_MAX_ENTRIES) break
    }
  } catch {
    await done()
    throw bad('archive.not-zip')
  }
  try {
    if (!entry || entry.directory || !('getData' in entry)) throw notFound('archive.entry-not-found')
    if (entry.encrypted) throw new HttpError(422, 'archive.encrypted')
    const declared = entry.uncompressedSize
    const ratio = entry.compressedSize > 0 ? declared / entry.compressedSize : declared > 0 ? Infinity : 0
    if (declared > config.uploadMaxSize || (declared > BOMB_MIN_BYTES && ratio > BOMB_RATIO)) throw new HttpError(413, 'archive.too-big')

    // counted on the way out: the header may lie about the size
    let total = 0
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.length
        if (total > declared) throw new HttpError(413, 'archive.too-big')
        controller.enqueue(chunk)
      },
    })
    void entry.getData(writable, { checkSignature: true }).then(() => {}, err => { writable.abort(err).catch(() => {}) }).finally(done)

    // the first piece is read before answering: a method this build can not unpack fails here, as a 422, not as a cut-off 200
    const stream = readable.getReader()
    let first
    try { first = await stream.read() } catch (err) {
      throw err instanceof HttpError ? err : new HttpError(422, 'archive.damaged')
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) { if (first.done) controller.close(); else controller.enqueue(first.value) },
      async pull(controller) {
        if (first.done) return
        const r = await stream.read()
        if (r.done) controller.close()
        else controller.enqueue(r.value)
      },
      cancel(reason) { return stream.cancel(reason) },
    })

    const name = wanted.split('/').filter(Boolean).at(-1) ?? 'file'
    const ext = extname(name).toLowerCase()
    const inline = wantInline && INLINE.has(ext)
    const type = Bun.file(name).type
    const headers: Record<string, string> = {
      'Content-Type': inline ? type : type.startsWith('text/') ? 'application/octet-stream' : type || 'application/octet-stream',
      'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', name),
      'Content-Length': String(declared),
      'Accept-Ranges': 'none',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    }
    // the browser's PDF viewer does not work inside a CSP sandbox (the normal download route does the same)
    if (!(inline && ext === '.pdf')) headers['Content-Security-Policy'] = "default-src 'none'; sandbox"
    return new Response(body, { headers })
  } catch (err) {
    await done()
    throw err
  }
}
