import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { config, paths } from './config'
import { bad, ensureDir, forbidden, HttpError, notFound, resolveIn, uniquePath, validName } from './fsx'

type Meta = {
  id: string
  owner: string
  /** destination folder, relative to the storage root so the data folder can be moved to another machine */
  destRel: string
  name: string
  size: number
  chunkSize: number
  total: number
  createdAt: number
}

const dirOf = (id: string) => join(paths.tmp, id)

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
  if (!Number.isFinite(size) || size < 0) throw bad('ขนาดไฟล์ไม่ถูกต้อง')
  if (size > config.uploadMaxSize) throw new HttpError(413, 'ไฟล์ใหญ่เกินกำหนด')

  const segments = args.relativeDir.map(validName)
  const destDir = resolveIn(args.root, [args.dir, ...segments].join('/').replace(/\/+/g, '/'))
  ensureDir(destDir)

  const id = randomBytes(12).toString('hex')
  const chunkSize = config.uploadChunkSize
  const total = Math.max(1, Math.ceil(size / chunkSize))
  ensureDir(dirOf(id))
  const meta: Meta = { id, owner: args.owner, destRel: relative(config.storageDir, destDir), name, size, chunkSize, total, createdAt: Date.now() }
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
  const part = join(dirOf(id), `${index}.part`)
  await Bun.write(part, data)
  renameSync(part, join(dirOf(id), String(index)))
  touch(id)
}

export async function completeUpload(id: string, owner: string) {
  const meta = loadMeta(id, owner)
  for (let i = 0; i < meta.total; i++) {
    if (!existsSync(join(dirOf(id), String(i)))) throw bad(`ยังขาดชิ้นส่วนที่ ${i + 1}`)
  }
  const assembled = join(dirOf(id), 'assembled')
  const sink = Bun.file(assembled).writer()
  for (let i = 0; i < meta.total; i++) {
    sink.write(await Bun.file(join(dirOf(id), String(i))).arrayBuffer())
    await sink.flush()
  }
  await sink.end()
  if (statSync(assembled).size !== meta.size) throw bad('ขนาดไฟล์หลังรวมไม่ตรงกับที่แจ้งไว้')

  const destDir = resolveIn(config.storageDir, '/' + meta.destRel.split(/[\\/]/).join('/'))
  ensureDir(destDir)
  const finalPath = uniquePath(join(destDir, meta.name))
  try {
    renameSync(assembled, finalPath)
  } catch (err: any) {
    if (err?.code !== 'EXDEV') throw err
    await Bun.write(finalPath, Bun.file(assembled))
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
