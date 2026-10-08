import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { config, paths } from './config'
import { bad, ensureDir, ensureSpace, forbidden, HttpError, notFound, resolveIn, uniquePath, validName } from './fsx'

type Meta = {
  id: string
  owner: string
  /** absolute destination folder, already validated */
  destDir: string
  name: string
  size: number
  chunkSize: number
  total: number
  createdAt: number
}

// Every chunk is written straight to its offset in one "data" file, and an empty file named after the chunk
// index marks it as received. Completing is then just a rename: no second copy on disk, and it stays fast
// for huge files (a proxy such as Cloudflare gives up on requests that take longer than ~100 s).
const dirOf = (id: string) => join(paths.tmp, id)
const dataOf = (id: string) => join(dirOf(id), 'data')

function loadMeta(id: unknown, owner: string): Meta {
  if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) throw notFound('ไม่พบการอัปโหลดนี้')
  try {
    const meta = JSON.parse(readFileSync(join(dirOf(id), 'meta.json'), 'utf8')) as Meta
    if (meta.owner !== owner) throw forbidden()
    return meta
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw notFound('ไม่พบการอัปโหลดนี้')
  }
}

const touch = (id: string) => {
  const now = new Date()
  try { utimesSync(join(dirOf(id), 'meta.json'), now, now) } catch { /* ignore */ }
}

export function initUpload(args: {
  owner: string
  root: string
  dir: string
  relativeDir: string[]
  name: unknown
  size: unknown
}) {
  const name = validName(args.name)
  const size = Number(args.size)
  if (!Number.isSafeInteger(size) || size < 0) throw bad('ขนาดไฟล์ไม่ถูกต้อง')
  if (size > config.uploadMaxSize) throw new HttpError(413, 'ไฟล์ใหญ่เกินกำหนด')
  ensureSpace(paths.tmp, size)

  const segments = args.relativeDir.map(validName)
  const destDir = resolveIn(args.root, [args.dir, ...segments].join('/').replace(/\/+/g, '/'))
  ensureDir(destDir)

  const id = randomBytes(12).toString('hex')
  const chunkSize = config.uploadChunkSize
  const total = Math.max(1, Math.ceil(size / chunkSize))
  ensureDir(dirOf(id))
  const meta: Meta = { id, owner: args.owner, destDir, name, size, chunkSize, total, createdAt: Date.now() }
  writeFileSync(dataOf(id), '')
  writeFileSync(join(dirOf(id), 'meta.json'), JSON.stringify(meta))
  return { id, chunkSize, total }
}

export function receivedChunks(id: string, owner: string): { received: number[]; total: number } {
  const meta = loadMeta(id, owner)
  const received = readdirSync(dirOf(id)).filter(f => /^\d+$/.test(f)).map(Number).sort((a, b) => a - b)
  return { received, total: meta.total }
}

export async function saveChunk(id: string, owner: string, index: number, data: ArrayBuffer) {
  const meta = loadMeta(id, owner)
  if (!Number.isInteger(index) || index < 0 || index >= meta.total) throw bad('ลำดับชิ้นส่วนไม่ถูกต้อง')
  const expected = index === meta.total - 1 ? meta.size - meta.chunkSize * (meta.total - 1) : meta.chunkSize
  if (data.byteLength !== expected) throw bad(`ขนาดชิ้นส่วนไม่ถูกต้อง (ต้องเป็น ${expected} ไบต์)`)
  ensureSpace(paths.tmp, data.byteLength)
  const fh = await open(dataOf(id), 'r+')
  try {
    await fh.write(new Uint8Array(data), 0, data.byteLength, index * meta.chunkSize)
  } finally {
    await fh.close()
  }
  // the marker is written only after the bytes are in place
  writeFileSync(join(dirOf(id), String(index)), '')
  touch(id)
}

export async function completeUpload(id: string, owner: string) {
  const meta = loadMeta(id, owner)
  for (let i = 0; i < meta.total; i++) {
    if (!existsSync(join(dirOf(id), String(i)))) throw bad(`ยังขาดชิ้นส่วนที่ ${i + 1}`)
  }
  const data = dataOf(id)
  if (statSync(data).size !== meta.size) throw bad('ขนาดไฟล์หลังรวมไม่ตรงกับที่แจ้งไว้')

  ensureDir(meta.destDir)
  const finalPath = uniquePath(join(meta.destDir, meta.name))
  try {
    renameSync(data, finalPath)
  } catch (err: any) {
    // storage and data folders on different disks: copy instead (slow for big files)
    if (err?.code !== 'EXDEV') throw err
    ensureSpace(meta.destDir, meta.size)
    await Bun.write(finalPath, Bun.file(data))
  }
  rmSync(dirOf(id), { recursive: true, force: true })
  return { path: finalPath, size: meta.size }
}

export function cancelUpload(id: string, owner: string) {
  loadMeta(id, owner)
  rmSync(dirOf(id), { recursive: true, force: true })
}

/** remove uploads that did not receive anything new for a few hours */
export function cleanStaleUploads(): number {
  let n = 0
  if (!existsSync(paths.tmp)) return 0
  for (const id of readdirSync(paths.tmp)) {
    try {
      const stamp = statSync(join(paths.tmp, id, 'meta.json')).mtimeMs
      if (Date.now() - stamp > config.uploadStaleMs) {
        rmSync(join(paths.tmp, id), { recursive: true, force: true })
        n++
      }
    } catch {
      // folder without meta: remove when it is old
      try {
        if (Date.now() - statSync(join(paths.tmp, id)).mtimeMs > config.uploadStaleMs) {
          rmSync(join(paths.tmp, id), { recursive: true, force: true })
          n++
        }
      } catch { /* ignore */ }
    }
  }
  return n
}

export function uploadsInProgress(): number {
  try { return readdirSync(paths.tmp).length } catch { return 0 }
}
