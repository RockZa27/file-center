import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { accessFor, type User } from './auth'
import { config, paths } from './config'
import * as policy from './policy'
import { bad, conflict, copyTree, ensureDir, ensureSpace, forbidden, HttpError, isDir, normRel, notFound, renameNoReplace, resolveIn, uniquePath, validName, within } from './fsx'
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
  /** the space the upload was announced in (not for an upload-request link): its rights are checked again on every chunk and at the end */
  space?: string
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

/**
 * The upload right of a space can end while a file is on its way (a grant taken back or set to view, the permission
 * removed, the folder moved or replaced by a link): whoever started it must still have `upload` there, and the
 * folder must still be inside the space. If not, the upload is thrown away (its quota hold is given back) and refused.
 */
function stillAllowed(id: string, meta: Meta, user: User | null | undefined) {
  if (!meta.space) return
  let ok = false
  try {
    const a = accessFor(user ?? null, meta.space)
    if (a && a.perms.has('upload') && within(a.root, meta.destDir)) {
      resolveIn(a.root, normRel(relative(a.root, meta.destDir)))
      ok = true
    }
  } catch { /* outside the space now */ }
  if (!ok) {
    restoreReservations()
    dropUpload(id, meta)
    throw forbidden()
  }
}

/**
 * The folder the file was announced for can be renamed, moved, deleted or replaced by a file while the chunks are on
 * their way. Putting the file there anyway would quietly make the old folder again (outside the trash, without its
 * owner's rights, in a place nobody looks): the upload is thrown away and its quota hold given back instead.
 */
function stillThere(id: string, meta: Meta) {
  if (isDir(meta.destDir)) return
  restoreReservations()
  dropUpload(id, meta)
  throw conflict('upload.dest-gone')
}

/** throws unless `owner` has this upload and may still add to it; lets a route refuse before it reads the request body */
export function checkUpload(id: string, owner: string, user?: User | null) {
  const meta = loadMeta(id, owner)
  stillAllowed(id, meta, user)
  stillThere(id, meta)
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

// One address may hold at most this part of the day's allowance in uploads it has announced but not finished: one
// visitor announcing a big file and sending nothing would otherwise stop every other visitor's uploads for the day.
const GUEST_PENDING_SHARE = 4
const guestPending = new Map<string, number>()
const pendingKey = (meta: Pick<Meta, 'ip'>) => meta.ip ?? ''

function reserveGuest(size: number, ip: string): string {
  const { day, used, limit } = guestUploadUsage()
  if (limit <= 0) throw new HttpError(429, 'upload.guest-disabled')
  if (used + size > limit) throw new HttpError(429, 'upload.guest-quota')
  const pending = guestPending.get(ip) ?? 0
  if (pending + size > Math.floor(limit / GUEST_PENDING_SHARE)) throw new HttpError(429, 'upload.guest-quota')
  guestPending.set(ip, pending + size)
  guestStore.replace({ day, bytes: used + size })
  return day
}

/** the upload is no longer waiting (finished, cancelled or dropped): its address may announce again */
function settleGuest(meta: Meta) {
  if (!meta.guestDay) return
  const left = (guestPending.get(pendingKey(meta)) ?? 0) - meta.size
  if (left > 0) guestPending.set(pendingKey(meta), left)
  else guestPending.delete(pendingKey(meta))
}

function releaseGuest(meta: Meta) {
  settleGuest(meta)
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
  for (const meta of allMetas()) {
    if (meta.quotaUser) restoreReservation(meta.quotaUser, meta.size)
    if (meta.guestDay) guestPending.set(pendingKey(meta), (guestPending.get(pendingKey(meta)) ?? 0) + meta.size)
    let at = Date.now()
    try { at = statSync(join(dirOf(meta.id), 'meta.json')).mtimeMs } catch { /* gone meanwhile: counts as new */ }
    track(meta, at)
  }
}

// ───────────── uploads in progress, counted in memory ─────────────

// What announce needs to know (how many uploads an owner, a link or an address has in progress) is kept as counters,
// built once from the disk in restoreReservations and changed where an upload starts or ends. Reading every meta.json
// on every announce would let one visitor make the server do that work again and again.
type Live = { owner: string; shareId?: string; ip?: string; size: number; at: number; idle: number }
const live = new Map<string, Live>()
const byOwner = new Map<string, number>()
const byShare = new Map<string, { count: number; bytes: number }>()
const byIp = new Map<string, number>()
const bump = <K>(m: Map<K, number>, k: K, by: number) => { const n = (m.get(k) ?? 0) + by; if (n > 0) m.set(k, n); else m.delete(k) }

function track(meta: Meta, at: number) {
  if (live.has(meta.id)) return
  live.set(meta.id, { owner: meta.owner, shareId: meta.shareId, ip: meta.ip, size: meta.size, at, idle: idleLimit(meta) })
  bump(byOwner, meta.owner, 1)
  if (!meta.shareId) return
  const c = byShare.get(meta.shareId) ?? { count: 0, bytes: 0 }
  byShare.set(meta.shareId, { count: c.count + 1, bytes: c.bytes + meta.size })
  bump(byIp, meta.ip ?? '', 1)
}

/** the upload is over (finished, cancelled, dropped or cleaned): it stops counting */
function untrack(id: string) {
  const l = live.get(id)
  if (!l) return
  live.delete(id)
  bump(byOwner, l.owner, -1)
  if (!l.shareId) return
  const c = byShare.get(l.shareId)
  if (c && c.count > 1) byShare.set(l.shareId, { count: c.count - 1, bytes: Math.max(0, c.bytes - l.size) })
  else byShare.delete(l.shareId)
  bump(byIp, l.ip ?? '', -1)
}

/** announced and then left alone: it does not keep a place (removed here, not only by the hourly cleaning) */
function sweepIdle() {
  const now = Date.now()
  for (const [id, l] of live) if (now - l.at > l.idle) dropUpload(id, readMeta(id))
}

function readMeta(id: string): Meta | null {
  try { return JSON.parse(readFileSync(join(dirOf(id), 'meta.json'), 'utf8')) as Meta } catch { return null }
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

/** how long an upload may sit without a new chunk: upload-request links (strangers) get far less than the others */
const idleLimit = (meta: Pick<Meta, 'shareId'>) => meta.shareId ? Math.min(config.uploadStaleMs, config.uploadRequestIdleMs) : config.uploadStaleMs

/** the upload is gone (idle, or never finished): its folder, the visitors' allowance and the quota are given back */
function dropUpload(id: string, meta: Meta | null) {
  untrack(id)
  rmSync(dirOf(id), { recursive: true, force: true })
  if (meta) { releaseGuest(meta); releaseQuota(meta) }
}

/** what an upload-request link has in progress, and what this address has in progress on any link */
export function shareUploadLoad(shareId: string, ip: string): { count: number; bytes: number; byIp: number } {
  restoreReservations()
  // the few uploads of this link and address are checked against their meta.json time (the clock of the chunks); the
  // others only against the time kept in memory. The disk is never scanned for the rest.
  for (const [id, l] of live) {
    if (l.shareId !== shareId && !(l.shareId && l.ip === ip)) continue
    try { l.at = statSync(join(dirOf(id), 'meta.json')).mtimeMs } catch { /* keep the time in memory */ }
  }
  sweepIdle()
  const c = byShare.get(shareId)
  return { count: c?.count ?? 0, bytes: c?.bytes ?? 0, byIp: byIp.get(ip) ?? 0 }
}

function releaseQuota(meta: Meta) {
  if (meta.quotaUser) releaseBytes(meta.quotaUser, meta.size)
}

const touch = (id: string) => {
  const now = new Date()
  const l = live.get(id)
  if (l) l.at = now.getTime()
  try { utimesSync(join(dirOf(id), 'meta.json'), now, now) } catch { /* ignore */ }
}

export function initUpload(args: {
  owner: string
  /** a visitor who is not signed in: counted against the visitors' daily allowance */
  guest?: boolean
  /** the user whose quota the bytes count against; the caller has awaited quota.ready() for them */
  quotaUser?: User
  /** the space the user announced it in (rights are checked again later) */
  space?: string
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
  if (size > policy.uploadMaxSize()) throw new HttpError(413, 'upload.too-big')
  ensureSpace(paths.tmp, size)
  // announced and never finished: one owner can not fill tmp with them (idle ones go first)
  sweepIdle()
  if (config.uploadMaxPending > 0 && (byOwner.get(args.owner) ?? 0) >= config.uploadMaxPending) throw new HttpError(429, 'upload.too-many-pending')

  const segments = args.relativeDir.map(validName)
  const destDir = resolveIn(args.root, [args.dir, ...segments].join('/').replace(/\/+/g, '/'))
  ensureDir(destDir)

  const id = randomBytes(12).toString('hex')
  const chunkSize = config.uploadChunkSize
  const total = Math.max(1, Math.ceil(size / chunkSize))
  const meta: Meta = { id, owner: args.owner, destDir, name, size, chunkSize, total, createdAt: Date.now() }
  // counted before anything is written and in the same tick as the check: nothing can slip in between
  if (args.guest || args.shareId) meta.ip = args.ip ?? ''
  if (args.guest) meta.guestDay = reserveGuest(size, meta.ip ?? '')
  if (args.space) meta.space = args.space
  if (args.shareId) meta.shareId = args.shareId
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
  track(meta, meta.createdAt)
  return { id, chunkSize, total }
}

export function receivedChunks(id: string, owner: string): { received: number[]; total: number } {
  const meta = loadMeta(id, owner)
  const received = readdirSync(dirOf(id)).filter(f => /^\d+$/.test(f)).map(Number).sort((a, b) => a - b)
  return { received, total: meta.total }
}

export async function saveChunk(id: string, owner: string, index: number, data: ArrayBuffer, user?: User | null) {
  const meta = loadMeta(id, owner)
  stillAllowed(id, meta, user)
  stillThere(id, meta)
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

// A client that lost the answer to "complete" asks again. The file has landed and the upload folder is gone by then, so
// the answer is kept for a few minutes (in memory, per user and upload): the retry gets the same success, and no second
// copy called "name (1)". A retry that comes while the first is still copying (a slow cross-disk copy) waits for it.
const COMPLETED_MS = 5 * 60_000
const COMPLETED_MAX = 1000
const completed = new Map<string, { path: string; size: number; at: number }>()
const completing = new Map<string, Promise<{ path: string; size: number }>>()

export type Completed = { path: string; size: number; /** true when this answer repeats an earlier one (nothing new happened) */ again: boolean }

export async function completeUpload(id: string, owner: string, user?: User | null): Promise<Completed> {
  const key = `${owner}\0${id}`
  const now = Date.now()
  // oldest first (Map keeps insertion order): drop what is too old, and the oldest when there are too many
  for (const [k, v] of completed) { if (now - v.at > COMPLETED_MS || completed.size > COMPLETED_MAX) completed.delete(k); else break }
  const earlier = completed.get(key)
  if (earlier) return { path: earlier.path, size: earlier.size, again: true }
  const running = completing.get(key)
  if (running) return { ...(await running), again: true }
  const p = finishUpload(id, owner, user)
  completing.set(key, p)
  try {
    const done = await p
    completed.set(key, { ...done, at: Date.now() })
    return { ...done, again: false }
  } finally {
    completing.delete(key)
  }
}

async function finishUpload(id: string, owner: string, user?: User | null) {
  restoreReservations()
  const meta = loadMeta(id, owner)
  stillAllowed(id, meta, user)
  stillThere(id, meta)
  for (let i = 0; i < meta.total; i++) {
    if (!existsSync(join(dirOf(id), String(i)))) throw bad('upload.missing-chunk', { n: i + 1 })
  }
  const data = dataOf(id)
  if (statSync(data).size !== meta.size) throw bad('upload.size-mismatch')

  // uniquePath only looks: a file of that name can appear before the move, and a plain rename would replace it
  let finalPath = uniquePath(join(meta.destDir, meta.name))
  for (let tries = 0; ; tries++) {
    try {
      await putInPlace(data, finalPath, meta)
      break
    } catch (err: any) {
      if (err?.code !== 'EEXIST' || tries >= 5) throw err
      finalPath = uniquePath(join(meta.destDir, meta.name))
    }
  }
  indexTouched(finalPath)
  untrack(id)
  rmSync(dirOf(id), { recursive: true, force: true })
  // the file is in the home now: the reservation turns into counted bytes
  if (meta.quotaUser) commitBytes(meta.quotaUser, meta.size)
  settleGuest(meta)
  return { path: finalPath, size: meta.size }
}

/**
 * One move when tmp and the storage are on the same disk (the default layout: DATA_DIR and STORAGE_DIR sit side by
 * side, and in Docker both are in the one /data volume). On different disks the file is copied (slow for big files)
 * beside its place and moved in, so nobody sees half a file under its real name. Never replaces a file.
 */
async function putInPlace(data: string, finalPath: string, meta: Meta) {
  try {
    await renameNoReplace(data, finalPath)
  } catch (err: any) {
    if (err?.code !== 'EXDEV') throw err
    ensureSpace(meta.destDir, meta.size)
    const part = join(meta.destDir, `.fc-up-${randomBytes(8).toString('hex')}`)
    try {
      await copyTree(data, part)
      await renameNoReplace(part, finalPath)
    } catch (e) {
      await rm(part, { force: true })
      throw e
    }
  }
}

export function cancelUpload(id: string, owner: string) {
  restoreReservations()
  const meta = loadMeta(id, owner)
  untrack(id)
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
      let meta: Meta | null = null
      try { meta = JSON.parse(readFileSync(join(paths.tmp, id, 'meta.json'), 'utf8')) as Meta } catch { /* unreadable: nothing to give back */ }
      if (Date.now() - stamp > (meta ? idleLimit(meta) : config.uploadStaleMs)) {
        untrack(id)
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
