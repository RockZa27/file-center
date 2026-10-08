import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, writeSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { BlobReader, configure, ZipReader, ZipWriter } from '@zip.js/zip.js'
import { bad, cleanName, uniquePath, within } from './fsx'

configure({ useWebWorkers: false })

export type ZipItem = { name: string; abs: string; dir: boolean; mtime: number; size: number }

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
export function zipStream(items: ZipItem[]): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const zip = new ZipWriter(writable)
  ;(async () => {
    for (const item of items) {
      const lastModDate = new Date(item.mtime)
      if (item.dir) {
        await zip.add(item.name, undefined, { directory: true, lastModDate })
        continue
      }
      await zip.add(item.name, Bun.file(item.abs).stream(), { lastModDate, level: worthCompressing(item) ? 3 : 0, zip64: item.size >= ZIP64_FROM })
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
  const tooBig = () => bad('ไฟล์ที่แตกออกมามีขนาดใหญ่เกินกำหนด หรือพื้นที่จัดเก็บไม่พอ')
  const unsafe = () => bad('ไฟล์ zip มีพาธที่ไม่ปลอดภัย')
  const reader = new ZipReader(new BlobReader(Bun.file(zipAbs)))
  try {
    const entries = await reader.getEntries()
    const files = entries.filter(e => !e.directory)
    if (files.length > limits.maxFiles) throw bad(`ไฟล์ zip มีไฟล์มากกว่า ${limits.maxFiles.toLocaleString()} ไฟล์`)
    if (files.reduce((sum, e) => sum + e.uncompressedSize, 0) > limits.maxBytes) throw tooBig()

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
