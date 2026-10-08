import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, writeSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { Unzip, UnzipInflate, UnzipPassThrough, Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import { bad, uniquePath, within } from './fsx'

export type ZipItem = { name: string; abs: string; dir: boolean; mtime: number }

/** expand files and folders into a flat list of archive entries (symlinks are skipped) */
export function collectZipItems(baseAbs: string, names: string[]): ZipItem[] {
  const out: ZipItem[] = []
  const visit = (abs: string, arc: string) => {
    let st
    try { st = lstatSync(abs) } catch { return }
    if (st.isSymbolicLink()) return
    if (st.isDirectory()) {
      out.push({ name: arc + '/', abs, dir: true, mtime: st.mtimeMs })
      for (const n of readdirSync(abs)) visit(join(abs, n), `${arc}/${n}`)
    } else {
      out.push({ name: arc, abs, dir: false, mtime: st.mtimeMs })
    }
  }
  for (const n of names) visit(join(baseAbs, n), n)
  return out
}

const STORE_ONLY = new Set(['.zip', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mkv', '.mov', '.mp3', '.aac', '.gz', '.7z', '.rar', '.xz', '.pdf', '.docx', '.xlsx', '.pptx'])

/** Streams a zip archive. Pull-driven, so memory stays flat even for huge files. */
export function zipStream(items: ZipItem[]): ReadableStream<Uint8Array> {
  let zip: Zip
  let index = 0
  let emitted = 0
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let current: ZipDeflate | ZipPassThrough | null = null
  let finished = false

  return new ReadableStream<Uint8Array>({
    start(controller) {
      zip = new Zip((err, chunk, final) => {
        if (err) return controller.error(err)
        controller.enqueue(chunk)
        emitted++
        if (final) {
          finished = true
          controller.close()
        }
      })
    },
    async pull(controller) {
      emitted = 0
      try {
        while (emitted === 0 && !finished) {
          if (!current) {
            if (index >= items.length) {
              zip.end()
              continue
            }
            const item = items[index++]
            const opts = { mtime: item.mtime }
            const stored = item.dir || STORE_ONLY.has(extname(item.name).toLowerCase())
            current = stored ? new ZipPassThrough(item.name) : new ZipDeflate(item.name, { level: 3 })
            current.mtime = opts.mtime
            zip.add(current)
            if (item.dir) {
              current.push(new Uint8Array(0), true)
              current = null
            } else {
              reader = Bun.file(item.abs).stream().getReader() as ReadableStreamDefaultReader<Uint8Array>
            }
            continue
          }
          const { value, done } = await reader!.read()
          if (done) {
            current.push(new Uint8Array(0), true)
            current = null
            reader = null
          } else {
            current.push(value, false)
          }
        }
      } catch (err) {
        controller.error(err)
      }
    },
    cancel() {
      reader?.cancel().catch(() => {})
    },
  })
}

/** Extract a zip archive into destDir. Protects against zip-slip and zip bombs. */
export async function unzipTo(zipAbs: string, destDir: string, maxBytes: number): Promise<number> {
  let total = 0
  let count = 0
  let failure: Error | null = null
  const unzip = new Unzip()
  unzip.register(UnzipInflate)
  unzip.register(UnzipPassThrough)

  unzip.onfile = file => {
    if (failure) return
    const clean = file.name.replaceAll('\\', '/').split('/').filter(s => s && s !== '.')
    if (clean.some(s => s === '..') || file.name.startsWith('/') || /^[a-zA-Z]:/.test(file.name)) {
      failure = bad('ไฟล์ zip มีพาธที่ไม่ปลอดภัย')
      return
    }
    if (!clean.length) return
    const target = join(destDir, ...clean)
    if (!within(destDir, target)) {
      failure = bad('ไฟล์ zip มีพาธที่ไม่ปลอดภัย')
      return
    }
    if (file.name.endsWith('/')) {
      mkdirSync(target, { recursive: true })
      return
    }
    mkdirSync(dirname(target), { recursive: true })
    const out = uniquePath(target)
    const fd = openSync(out, 'wx')
    count++
    file.ondata = (err, chunk, final) => {
      if (err) { failure = err as Error; closeSync(fd); return }
      if (failure) { if (final) closeSync(fd); return }
      total += chunk.length
      if (total > maxBytes) failure = bad('ไฟล์ที่แตกออกมามีขนาดใหญ่เกินกำหนด')
      else if (chunk.length) writeSync(fd, chunk)
      if (final) closeSync(fd)
    }
    file.start()
  }

  const stream = Bun.file(zipAbs).stream()
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    unzip.push(chunk, false)
    if (failure) throw failure
  }
  unzip.push(new Uint8Array(0), true)
  if (failure) throw failure
  return count
}
