import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { User } from './auth'
import { config, paths } from './config'
import { bad, ensureDir, ensureSpace, forbidden, HttpError, notFound, resolveIn, uniquePath, validName } from './fsx'
import { indexTouched } from './search-index'
import { commitBytes, limitOf, releaseBytes, reserveBytes, restoreReservation } from './quota'
import { JsonStore } from './store'

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
  /** set for a visitor's upload: the day its size was counted against the visitors' allowance */
  guestDay?: string
  /** set when the bytes count against this user's quota (quota.ts): the reservation is given back when the upload ends */
  quotaUser?: string
  /** set for an upload through an upload-request link, with the visitor's address (limits per link and per address) */
  shareId?: string
  ip?: string
}

// Every chunk is written straight to its offset in one "data" file, and an empty file named after the chunk
// index marks it as received. Completing is then just a rename: no second copy on disk, and it stays fast
// for huge files (a proxy such as Cloudflare gives up on requests that take longer than ~100 s).
const dirOf = (id: string) => join(paths.tmp, id)
const dataOf = (id: string) => join(dirOf(id), 'data')

function loadMeta(id: unknown, owner: string): Meta {
  if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) throw notFound('upload.not-found')
  try {
    const meta = JSON.parse(readFileSync(join(dirOf(id), 'meta.json'), 'utf8')) as Meta
    if (meta.owner !== owner) throw forbidden()
    return meta
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw notFound('upload.not-found')
  }
}

/** throws unless `owner` has this upload; lets a route refuse before it reads the request body */
export function checkUpload(id: string, owner: string) {
  loadMeta(id, owner)
}

// ───────────── visitors' daily allowance ─────────────

// All visitors share one allowance per day (machine time). An upload takes its whole size when it is announced,
// so uploads sent in parallel can not together go past it, and gives it back when it is cancelled or never completes.
const guestStore = new JsonStore<{ day: string; bytes: number }>(paths.guestUploads, () => ({ day: '', bytes: 0 }))
const pad = (n: number) => String(n).padStart(2, '0')
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function guestUploadUsage(): { day: string; used: number; limit: number } {
  const day = today()
  const s = guestStore.value
  return { day, used: s.day === day && Number.isFinite(s.bytes) ? s.bytes : 0, limit: config.guestUploadDailyBytes }
}

function reserveGuest(size: number): string {
  const { day, used, limit } = guestUploadUsage()
  if (limit <= 0) throw new HttpError(429, 'upload.guest-disabled')
  if (used + size > limit) throw new HttpError(429, 'upload.guest-quota')
  guestStore.replace({ day, bytes: used + size })
  return day
}

function releaseGuest(meta: Meta) {
  // bytes counted on an earlier day are not taken off today's count: that one started from zero
  if (!meta.guestDay || guestStore.value.day !== meta.guestDay) return
  guestStore.update(d => { d.bytes = Math.max(0, d.bytes - meta.size) })
}

// ───────────── quota reservations ─────────────

// Reservations live in memory. After a restart, the uploads still in tmp take their places again (once), so that
// giving one back later does not take away the place of a newer one.
let restored = false
function restoreReservations() {
  if (restored) return
  restored = true
  for (const meta of allMetas()) if (meta.quotaUser) restoreReservation(meta.quotaUser, meta.size)
}

function allMetas(): Meta[] {
  const out: Meta[] = []
  let ids: string[] = []
  try { ids = readdirSync(paths.tmp) } catch { return out }
  for (const id of ids) {
    try { out.push(JSON.parse(readFileSync(join(paths.tmp, id, 'meta.json'), 'utf8')) as Meta) } catch { /* not an upload */ }
  }
  return out
}

/** what an upload-request link has in progress, and what this address has in progress on any link */
export function shareUploadLoad(shareId: string, ip: string): { count: number; bytes: number; byIp: number } {
  let count = 0
  let bytes = 0
  let byIp = 0
  for (const m of allMetas()) {
    if (!m.shareId) continue
    if (m.shareId === shareId) { count++; bytes += m.size }
    if (m.ip === ip) byIp++
  }
  return { count, bytes, byIp }
}

function releaseQuota(meta: Meta) {
  if (meta.quotaUser) releaseBytes(meta.quotaUser, meta.size)
}

const touch = (id: string) => {
  const now = new Date()
  try { utimesSync(join(dirOf(id), 'meta.json'), now, now) } catch { /* ignore */ }
}

export function initUpload(args: {
  owner: string
  /** a visitor who is not signed in: counted against the visitors' daily allowance */
  guest?: boolean
  /** the user whose quota the bytes count against; the caller has awaited quota.ready() for them */
  quotaUser?: User
  shareId?: string
  ip?: string
  root: string
  dir: string
  relativeDir: string[]
  name: unknown
  size: unknown
}) {
  restoreReservations()
  const name = validName(args.name)
  const size = Number(args.size)
  if (!Number.isSafeInteger(size) || size < 0) throw bad('upload.bad-size')
  if (size > config.uploadMaxSize) throw new HttpError(413, 'upload.too-big')
  ensureSpace(paths.tmp, size)

  const segments = args.relativeDir.map(validName)
  const destDir = resolveIn(args.root, [args.dir, ...segments].join('/').replace(/\/+/g, '/'))
  ensureDir(destDir)

  const id = randomBytes(12).toString('hex')
  const chunkSize = config.uploadChunkSize
  const total = Math.max(1, Math.ceil(size / chunkSize))
  const meta: Meta = { id, owner: args.owner, destDir, name, size, chunkSize, total, createdAt: Date.now() }
  // counted before anything is written and in the same tick as the check: nothing can slip in between
  if (args.guest) meta.guestDay = reserveGuest(size)
  if (args.shareId) { meta.shareId = args.shareId; meta.ip = args.ip ?? '' }
  if (args.quotaUser) {
    try {
      reserveBytes(args.quotaUser, size)
    } catch (err) {
      releaseGuest(meta)
      throw err
    }
    if (size > 0 && limitOf(args.quotaUser)) meta.quotaUser = args.quotaUser.username
  }
  try {
    ensureDir(dirOf(id))
    writeFileSync(dataOf(id), '')
    writeFileSync(join(dirOf(id), 'meta.json'), JSON.stringify(meta))
  } catch (err) {
    releaseGuest(meta)
    releaseQuota(meta)
    rmSync(dirOf(id), { recursive: true, force: true })
    throw err
  }
  return { id, chunkSize, total }
}

export function receivedChunks(id: string, owner: string): { received: number[]; total: number } {
  const meta = loadMeta(id, owner)
  const received = readdirSync(dirOf(id)).filter(f => /^\d+$/.test(f)).map(Number).sort((a, b) => a - b)
  return { received, total: meta.total }
}

export async function saveChunk(id: string, owner: string, index: number, data: ArrayBuffer) {
  const meta = loadMeta(id, owner)
  if (!Number.isInteger(index) || index < 0 || index >= meta.total) throw bad('upload.bad-chunk-index')
  const expected = index === meta.total - 1 ? meta.size - meta.chunkSize * (meta.total - 1) : meta.chunkSize
  if (data.byteLength !== expected) throw bad('upload.bad-chunk-size', { bytes: expected })
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
  restoreReservations()
  const meta = loadMeta(id, owner)
  for (let i = 0; i < meta.total; i++) {
    if (!existsSync(join(dirOf(id), String(i)))) throw bad('upload.missing-chunk', { n: i + 1 })
  }
  const data = dataOf(id)
  if (statSync(data).size !== meta.size) throw bad('upload.size-mismatch')

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
  indexTouched(finalPath)
  rmSync(dirOf(id), { recursive: true, force: true })
  // the file is in the home now: the reservation turns into counted bytes
  if (meta.quotaUser) commitBytes(meta.quotaUser, meta.size)
  return { path: finalPath, size: meta.size }
}

export function cancelUpload(id: string, owner: string) {
  restoreReservations()
  const meta = loadMeta(id, owner)
  rmSync(dirOf(id), { recursive: true, force: true })
  releaseGuest(meta)
  releaseQuota(meta)
}

/** remove uploads that did not receive anything new for a few hours */
export function cleanStaleUploads(): number {
  restoreReservations()
  let n = 0
  if (!existsSync(paths.tmp)) return 0
  for (const id of readdirSync(paths.tmp)) {
    try {
      const stamp = statSync(join(paths.tmp, id, 'meta.json')).mtimeMs
      if (Date.now() - stamp > config.uploadStaleMs) {
        let meta: Meta | null = null
        try { meta = JSON.parse(readFileSync(join(paths.tmp, id, 'meta.json'), 'utf8')) as Meta } catch { /* unreadable: nothing to give back */ }
        rmSync(join(paths.tmp, id), { recursive: true, force: true })
        if (meta) { releaseGuest(meta); releaseQuota(meta) }
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
