import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, writeSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { configure, ZipWriter } from '@zip.js/zip.js'
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate'
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
      const stored = STORE_ONLY.has(extname(item.name).toLowerCase())
      await zip.add(item.name, Bun.file(item.abs).stream(), { lastModDate, level: stored ? 0 : 3, zip64: item.size >= ZIP64_FROM })
    }
    await zip.close()
  })().catch(err => writable.abort(err).catch(() => {}))
  return readable
}

/**
 * Extract a zip archive into destDir. Protects against zip-slip and zip bombs, caps the number of files,
 * and turns names this system would refuse (":", "?", control characters...) into safe ones.
 */
export async function unzipTo(zipAbs: string, destDir: string, limits: { maxBytes: number; maxFiles: number }): Promise<number> {
  let total = 0
  let count = 0
  let failure: Error | null = null
  const open = new Set<number>()
  const close = (fd: number) => { if (open.delete(fd)) closeSync(fd) }
  const unzip = new Unzip()
  unzip.register(UnzipInflate)
  unzip.register(UnzipPassThrough)

  unzip.onfile = file => {
    if (failure) return
    const parts = file.name.replaceAll('\\', '/').split('/').filter(s => s && s !== '.')
    if (parts.some(s => s === '..') || file.name.startsWith('/') || /^[a-zA-Z]:/.test(file.name)) {
      failure = bad('ไฟล์ zip มีพาธที่ไม่ปลอดภัย')
      return
    }
    if (!parts.length) return
    const target = join(destDir, ...parts.map(cleanName))
    if (!within(destDir, target)) {
      failure = bad('ไฟล์ zip มีพาธที่ไม่ปลอดภัย')
      return
    }
    if (file.name.endsWith('/')) {
      mkdirSync(target, { recursive: true })
      return
    }
    if (++count > limits.maxFiles) {
      failure = bad(`ไฟล์ zip มีไฟล์มากกว่า ${limits.maxFiles.toLocaleString()} ไฟล์`)
      return
    }
    mkdirSync(dirname(target), { recursive: true })
    const fd = openSync(uniquePath(target), 'wx')
    open.add(fd)
    file.ondata = (err, chunk, final) => {
      if (err) failure = err as Error
      else if (!failure) {
        total += chunk.length
        if (total > limits.maxBytes) failure = bad('ไฟล์ที่แตกออกมามีขนาดใหญ่เกินกำหนด หรือพื้นที่จัดเก็บไม่พอ')
        else if (chunk.length) writeSync(fd, chunk)
      }
      if (final || failure) close(fd)
    }
    file.start()
  }

  try {
    const stream = Bun.file(zipAbs).stream()
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      unzip.push(chunk, false)
      if (failure) throw failure
    }
    unzip.push(new Uint8Array(0), true)
    if (failure) throw failure
    return count
  } finally {
    for (const fd of [...open]) close(fd)
  }
}
