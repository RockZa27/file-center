/**
 * Earlier contents of a file, kept before a save replaces them (a text edit, an ONLYOFFICE save, a restore).
 * DATA_DIR/versions/<sha1 of the storage path>/<id>/{item, meta.json}: the folder is found from the path alone, and
 * a version is only ever opened through the file it belongs to (its meta names that path, and the routes compare).
 *
 * Versions of a file in a user's home count against that user's quota (quota.ts counts them with the home).
 * Renaming or moving a file moves its versions; deleting it moves them into the trash entry, restoring puts them back.
 */
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { User } from './auth'
import { config, paths } from './config'
import * as policy from './policy'
import { ensureDir, isDir, notFound, resolveIn, storagePath, within } from './fsx'
import { commitBytes, holdNow, markStale, ownerOfPath, type Hold } from './quota'

export type VersionMeta = {
  id: string
  /** the file this is a version of, relative to the storage root */
  storagePath: string
  size: number
  /** modification time of the content that was replaced */
  mtime: number
  savedAt: string
  savedBy: string
  reason: 'edit' | 'office' | 'restore'
}

const ID_RE = /^[0-9]{13}_[a-f0-9]{8}$/

// ids sort as "newest first": two saves in the same millisecond (a fast machine) must still get increasing stamps
let lastStamp = 0
function nextStamp(): number {
  lastStamp = Math.max(Date.now(), lastStamp + 1)
  return lastStamp
}
const bucketOf = (sp: string, root = paths.versions) => join(root, createHash('sha1').update(sp).digest('hex'))

export function safeId(id: unknown): string {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw notFound('versions.not-found')
  return id
}

function readMeta(dir: string): VersionMeta | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as VersionMeta
    return typeof m?.id === 'string' && typeof m.storagePath === 'string' ? m : null
  } catch { return null /* half-written */ }
}

/** [folder, meta] of every version inside `root` (versions/ or the versions of a trash entry), or of one bucket */
function scan(root: string, bucket?: string): [string, VersionMeta][] {
  const out: [string, VersionMeta][] = []
  let buckets: string[]
  try { buckets = bucket ? [bucket] : readdirSync(root).map(n => join(root, n)) } catch { return out }
  for (const b of buckets) {
    let ids: string[]
    try { ids = readdirSync(b) } catch { continue }
    for (const id of ids) {
      const dir = join(b, id)
      const m = ID_RE.test(id) ? readMeta(dir) : null
      if (m && m.id === id) out.push([dir, m])
    }
  }
  return out
}

/** the versions directly inside a trash entry's versions folder (no buckets there) */
function scanFlat(dir: string): [string, VersionMeta][] {
  let ids: string[]
  try { ids = readdirSync(dir) } catch { return [] }
  return ids.flatMap(id => {
    const m = ID_RE.test(id) ? readMeta(join(dir, id)) : null
    return m && m.id === id ? [[join(dir, id), m] as [string, VersionMeta]] : []
  })
}

const byNewest = (a: VersionMeta, b: VersionMeta) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

/** the versions of one file, newest first */
export function listVersions(abs: string): VersionMeta[] {
  const sp = storagePath(abs)
  return scan(paths.versions, bucketOf(sp)).map(([, m]) => m).filter(m => m.storagePath === sp).sort(byNewest)
}

/** one version of this exact file: an id from another file (or none) is simply not found */
export function getVersion(abs: string, idRaw: unknown): { meta: VersionMeta; dir: string; item: string } {
  const id = safeId(idRaw)
  const sp = storagePath(abs)
  const dir = join(bucketOf(sp), id)
  const meta = readMeta(dir)
  if (!meta || meta.id !== id || meta.storagePath !== sp || !existsSync(join(dir, 'item'))) throw notFound('versions.not-found')
  return { meta, dir, item: join(dir, 'item') }
}

const absOf = (sp: string) => resolveIn(config.storageDir, sp)

function removeDir(dir: string) {
  rmSync(dir, { recursive: true, force: true })
  try { rmdirSync(join(dir, '..')) } catch { /* the bucket still holds other versions */ }
}

/** delete one version and give its bytes back to the home it counted against */
export function dropVersion(meta: VersionMeta, dir: string) {
  removeDir(dir)
  const owner = ownerOfPath(absOf(meta.storagePath))
  if (owner) commitBytes(owner.username, 0, -meta.size)
}

/** bytes of the versions of files under `root` (an absolute folder): what a home's quota count adds */
export function versionBytesUnder(root: string): number {
  if (!existsSync(paths.versions)) return 0
  let sum = 0
  for (const [, m] of scan(paths.versions)) {
    try { if (within(root, absOf(m.storagePath))) sum += m.size } catch { /* a path that can not be resolved counts for nobody */ }
  }
  return sum
}

/** keep at most VERSIONS_KEEP of this file: the oldest go first */
function prune(abs: string) {
  const list = listVersions(abs)
  for (const m of list.slice(Math.max(0, policy.versionsKeep()))) dropVersion(m, join(bucketOf(m.storagePath), m.id))
}

export type VersionTicket = {
  /** copy the current content away (sync: nothing can change in between) */
  keep(reason: VersionMeta['reason'], by: string): VersionMeta
  keepAsync(reason: VersionMeta['reason'], by: string): Promise<VersionMeta>
  release(): void
}

/**
 * Make room for a version of the file as it is now, or null when versions are off or there is no file to keep.
 * Synchronous after the owner's count is ready (quota.ready), like the other reservations. Over the owner's quota,
 * the oldest versions of this file go first; when that is not enough it throws quota.exceeded, so the caller
 * refuses the save and the current content stays untouched.
 */
export function reserveVersion(owner: User | null, abs: string): VersionTicket | null {
  if (!policy.versionsKeep()) return null
  let st
  try { st = lstatSync(abs) } catch { return null }
  if (!st.isFile()) return null
  let hold: Hold | undefined
  for (const m of [...listVersions(abs).reverse(), null]) {
    try { hold = holdNow(owner, st.size); break } catch (err) {
      if (!m) throw err
      dropVersion(m, join(bucketOf(m.storagePath), m.id))
    }
  }
  const sp = storagePath(abs)
  const start = (reason: VersionMeta['reason'], by: string) => {
    const id = `${nextStamp()}_${randomBytes(4).toString('hex')}`
    const meta: VersionMeta = { id, storagePath: sp, size: st.size, mtime: Math.round(st.mtimeMs), savedAt: new Date().toISOString(), savedBy: by, reason }
    const dir = join(bucketOf(sp), id)
    ensureDir(dir)
    return { meta, dir }
  }
  const finish = (meta: VersionMeta, dir: string) => {
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta))
    hold!.commit()
    prune(abs)
    return meta
  }
  const fail = (dir: string, err: unknown) => {
    removeDir(dir)
    hold!.release()
    throw err
  }
  return {
    keep(reason, by) {
      const { meta, dir } = start(reason, by)
      try { copyFileSync(abs, join(dir, 'item')) } catch (err) { fail(dir, err) }
      return finish(meta, dir)
    },
    async keepAsync(reason, by) {
      const { meta, dir } = start(reason, by)
      try { await copyFile(abs, join(dir, 'item')) } catch (err) { fail(dir, err) }
      return finish(meta, dir)
    },
    release() { hold!.release() },
  }
}

/** a file or folder was renamed or moved: its versions follow (and anything counted by quota is counted again) */
export function moveVersions(fromAbs: string, toAbs: string) {
  if (!existsSync(paths.versions)) return
  const fromSp = storagePath(fromAbs)
  const toSp = storagePath(toAbs)
  const found = isDir(toAbs)
    ? scan(paths.versions).filter(([, m]) => m.storagePath === fromSp || m.storagePath.startsWith(fromSp + '/'))
    : scan(paths.versions, bucketOf(fromSp)).filter(([, m]) => m.storagePath === fromSp)
  for (const [dir, m] of found) {
    const next: VersionMeta = { ...m, storagePath: toSp + m.storagePath.slice(fromSp.length) }
    const target = join(bucketOf(next.storagePath), m.id)
    ensureDir(join(target, '..'))
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(next))
    renameSync(dir, target)
    try { rmdirSync(join(dir, '..')) } catch { /* not empty */ }
  }
  if (found.length) markStale()
}

/** the file or folder goes to the trash: its versions go into the trash entry (`into`) with it */
export function stashVersions(fromAbs: string, into: string): number {
  if (!existsSync(paths.versions)) return 0
  const sp = storagePath(fromAbs)
  const found = scan(paths.versions).filter(([, m]) => m.storagePath === sp || m.storagePath.startsWith(sp + '/'))
  for (const [dir, m] of found) {
    ensureDir(into)
    renameSync(dir, join(into, m.id))
    try { rmdirSync(join(dir, '..')) } catch { /* not empty */ }
  }
  if (found.length) markStale()
  return found.length
}

/** bytes of the versions in a trash entry */
export function stashedBytes(from: string): number {
  return scanFlat(from).reduce((s, [, m]) => s + m.size, 0)
}

/** a trash entry came back as `toAbs` (it may have got another name): its versions come back to that path */
export function unstashVersions(from: string, originalSp: string, toAbs: string) {
  const toSp = storagePath(toAbs)
  for (const [dir, m] of scanFlat(from)) {
    const next: VersionMeta = { ...m, storagePath: toSp + m.storagePath.slice(originalSp.length) }
    const target = join(bucketOf(next.storagePath), m.id)
    ensureDir(join(target, '..'))
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(next))
    renameSync(dir, target)
  }
  markStale()
}

/** versions older than VERSIONS_DAYS (0 = no limit by age) leave; run by housekeeping */
export function purgeExpiredVersions(): number {
  if (!policy.versionsDays() || !existsSync(paths.versions)) return 0
  const cutoff = Date.now() - policy.versionsDays() * 86_400_000
  let n = 0
  for (const [dir, m] of scan(paths.versions)) {
    if (Date.parse(m.savedAt) < cutoff) { removeDir(dir); n++ }
  }
  if (n) markStale()
  return n
}
