import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { allUsers, type User } from './auth'
import { config, paths } from './config'
import { groupOwners } from './groups'
import { holdNow, ownerOfPath, ready } from './quota'
import { stashedBytes, stashVersions, unstashVersions } from './versions'
import { log } from './logger'
import { indexTouched } from './search-index'
import {
  conflict, ensureDir, moveTree, normRel, notFound, parentRel, resolveIn, storagePath, treeStats, uniquePath, within,
} from './fsx'

export type TrashMeta = {
  id: string
  name: string
  type: 'file' | 'dir'
  size: number
  /** path relative to the storage root */
  originalPath: string
  deletedAt: string
  deletedBy: string
  /** username whose home held the item (null: the public folder or somewhere outside every home); absent in entries from before 1.10 */
  owner?: string | null
  /** 'home' (in a user's home), 'public' or 'other'; absent in entries from before 1.10 */
  space?: 'home' | 'public' | 'other'
}

/** the plain user (or the group, as its pseudo account `group:<id>`) whose home holds `abs` (an admin's home is everything, so it never decides), or null */
export function homeOwnerOf(abs: string): User | null {
  let best: User | null = null
  let bestLen = -1
  for (const u of [...allUsers(), ...groupOwners()]) {
    if (u.role === 'admin') continue
    let root: string
    try { root = resolveIn(config.storageDir, normRel(u.homedir)) } catch { continue }
    // the deepest home wins when one sits inside another
    if (within(root, abs) && root.length > bestLen) { best = u; bestLen = root.length }
  }
  return best
}

function spaceOf(abs: string, owner: User | null): NonNullable<TrashMeta['space']> {
  if (owner) return 'home'
  return within(paths.publicDir, abs) ? 'public' : 'other'
}

/** the owner of an entry: as recorded, or (entries from before 1.10) from where it was */
export function trashOwner(meta: TrashMeta): string | null {
  if (meta.owner !== undefined) return meta.owner
  try {
    const u = homeOwnerOf(join(config.storageDir, normRel(meta.originalPath)))
    // an account made after the item was deleted is not its owner (the old account of that name was deleted)
    if (u && Date.parse(u.createdAt) > Date.parse(meta.deletedAt)) return null
    return u?.username ?? null
  } catch { return null }
}

/** the name an account's trash entries get when the account is deleted; "~" is not allowed in a username, so no account ever matches it */
const tombstone = (username: string) => `~${username}@${Date.now()}`

/**
 * An account that is deleted must not pass its trash to a new account of the same name: its entries (owner and deleter)
 * get a name nobody can have, so only the admin's trash shows them. Call it before the account leaves the list (an entry
 * from before 1.10 finds its owner from where it was).
 */
export function tombstoneTrashOf(username: string): number {
  const same = (a: string | null | undefined) => !!a && a.toLowerCase() === username.toLowerCase()
  const mark = tombstone(username)
  let n = 0
  for (const meta of listTrash()) {
    const owner = same(trashOwner(meta))
    const by = same(meta.deletedBy)
    if (!owner && !by) continue
    if (owner) meta.owner = mark
    if (by) meta.deletedBy = mark
    try { writeFileSync(join(itemDir(meta.id), 'meta.json'), JSON.stringify(meta)); n++ } catch (err) { log.warn('trash-tombstone-failed', { id: meta.id, error: err }) }
  }
  return n
}

const itemDir = (id: string) => join(paths.trash, id)

/** the move itself; tests replace it to stop the process half way */
export const trashDeps = { move: moveTree }
/** entries being made or restored right now: repairTrash leaves them alone (they look unfinished on purpose) */
const busyIds = new Set<string>()

/** meta.json is written whole or not at all: a crash must not leave half of it */
function writeMeta(id: string, meta: TrashMeta) {
  const file = join(itemDir(id), 'meta.json')
  writeFileSync(`${file}.tmp`, JSON.stringify(meta))
  renameSync(`${file}.tmp`, file)
}

function safeId(id: unknown): string {
  if (typeof id !== 'string' || !/^[0-9]{13}_[a-f0-9]{8}$/.test(id)) throw notFound()
  return id
}

export async function moveToTrash(abs: string, deletedBy: string): Promise<TrashMeta> {
  const st = lstatSync(abs)
  const isDir = st.isDirectory() && !st.isSymbolicLink()
  const owner = homeOwnerOf(abs)
  const id = `${Date.now()}_${randomBytes(4).toString('hex')}`
  const meta: TrashMeta = {
    id,
    name: basename(abs),
    type: isDir ? 'dir' : 'file',
    // a big folder takes a while to count: other requests are answered meanwhile
    size: isDir ? (await treeStats(abs, 200_000)).size : st.size,
    originalPath: storagePath(abs),
    deletedAt: new Date().toISOString(),
    deletedBy,
    owner: owner?.username ?? null,
    space: spaceOf(abs, owner),
  }
  ensureDir(itemDir(id))
  busyIds.add(id)
  try {
    // the entry is described before the item moves in: a crash in between leaves a record without an item (repairTrash
    // removes it), never an item nobody can see
    writeMeta(id, meta)
    try {
      await trashDeps.move(abs, join(itemDir(id), 'item'))
    } catch (err) {
      // e.g. another request moved or deleted it while we counted: leave no empty trash entry behind
      rmSync(itemDir(id), { recursive: true, force: true })
      throw err
    }
    // the earlier versions of the file(s) go along, so a restore brings them back
    try { stashVersions(abs, join(itemDir(id), 'versions')) } catch (err) { log.warn('versions-stash-failed', { id, error: err }) }
    indexTouched(abs)
    return meta
  } finally {
    busyIds.delete(id)
  }
}

export function listTrash(): TrashMeta[] {
  if (!existsSync(paths.trash)) return []
  const out: TrashMeta[] = []
  for (const id of readdirSync(paths.trash)) {
    // its record exists before the item is in place: it is not in the trash yet
    if (busyIds.has(id)) continue
    try {
      out.push(JSON.parse(readFileSync(join(paths.trash, id, 'meta.json'), 'utf8')))
    } catch { /* half-written entry, ignore */ }
  }
  return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
}

export function trashSummary() {
  const items = listTrash()
  return { count: items.length, size: items.reduce((s, i) => s + i.size, 0) }
}

/** one entry as stored, or 404 */
export function readTrash(idRaw: unknown): TrashMeta {
  const id = safeId(idRaw)
  if (!existsSync(join(itemDir(id), 'meta.json'))) throw notFound()
  try {
    return JSON.parse(readFileSync(join(itemDir(id), 'meta.json'), 'utf8')) as TrashMeta
  } catch {
    throw notFound()
  }
}

/**
 * `check` (a user restoring their own item) runs before anything moves and throws to refuse; the admin restore has none.
 */
export async function restore(
  idRaw: unknown, check?: (meta: TrashMeta, target: string) => void,
): Promise<{ meta: TrashMeta; restoredTo: string }> {
  const meta = readTrash(idRaw)
  const id = safeId(idRaw)
  const dir = itemDir(id)
  const target = resolveIn(config.storageDir, meta.originalPath)
  check?.(meta, target)
  ensureDir(dirname(target))
  // the item goes back into a home that may have a quota: it counts again (counted first, so nothing awaits between
  // choosing the name and moving)
  const owner = ownerOfPath(target)
  await ready(owner)
  const finalPath = uniquePath(target)
  if (existsSync(finalPath)) throw conflict('admin.trash-name-taken')
  const vdir = join(dir, 'versions')
  const hold = holdNow(owner, meta.size + stashedBytes(vdir))
  // between the move and the removal of the entry it has a record and no item: not an orphan
  busyIds.add(id)
  try {
    try {
      await moveTree(join(dir, 'item'), finalPath)
    } catch (err) {
      hold.release()
      throw err
    }
    try { unstashVersions(vdir, meta.originalPath, finalPath) } catch (err) { log.warn('versions-restore-failed', { id, error: err }) }
    hold.commit()
    indexTouched(finalPath)
    rmSync(dir, { recursive: true, force: true })
  } finally {
    busyIds.delete(id)
  }
  return { meta, restoredTo: storagePath(finalPath) }
}

export function purge(idRaw?: unknown): number {
  if (idRaw === undefined || idRaw === null) {
    const all = listTrash()
    for (const m of all) rmSync(itemDir(m.id), { recursive: true, force: true })
    return all.length
  }
  const id = safeId(idRaw)
  if (!existsSync(itemDir(id))) throw notFound()
  rmSync(itemDir(id), { recursive: true, force: true })
  return 1
}

/**
 * Entries that a crash left half made, found at start and in the hourly housekeeping:
 *   an item without a record (made by a version before 1.12.1, which wrote meta.json last): adopted. Who deleted it, from
 *   where and under which name died with the process, so it gets a record of its own: owner nobody (only the admin's
 *   trash shows it), deleted now, to be restored into recovered-from-trash/ and sorted out by hand.
 *   a record without an item (the process stopped before the move): removed, there is nothing to restore.
 */
export function repairTrash(): { adopted: number; purged: number } {
  const out = { adopted: 0, purged: 0 }
  if (!existsSync(paths.trash)) return out
  for (const id of readdirSync(paths.trash)) {
    if (!/^[0-9]{13}_[a-f0-9]{8}$/.test(id) || busyIds.has(id)) continue
    const dir = itemDir(id)
    try {
      const item = join(dir, 'item')
      const hasItem = !!lstatOrNull(item)
      let meta: TrashMeta | null = null
      try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) } catch { /* none, or half written */ }
      if (hasItem && !meta) {
        const st = lstatSync(item)
        const isDir = st.isDirectory() && !st.isSymbolicLink()
        writeMeta(id, {
          id, name: `recovered-${id}`, type: isDir ? 'dir' : 'file', size: isDir ? treeSizeSync(item) : st.size,
          originalPath: `/recovered-from-trash/${id}`, deletedAt: new Date().toISOString(), deletedBy: 'system', owner: null, space: 'other',
        })
        out.adopted++
        log.warn('trash-adopted', { id })
      } else if (!hasItem && meta) {
        rmSync(dir, { recursive: true, force: true })
        out.purged++
        log.warn('trash-record-without-item', { id, name: meta.name })
      } else if (!hasItem && !meta && !existsSync(join(dir, 'versions'))) {
        rmSync(dir, { recursive: true, force: true })
      }
    } catch (err) {
      log.warn('trash-repair-failed', { id, error: err })
    }
  }
  return out
}

const lstatOrNull = (p: string) => { try { return lstatSync(p) } catch { return null } }

/** bytes of a tree, counted synchronously (an adopted entry is rare, and only its size is wanted) */
function treeSizeSync(abs: string): number {
  let total = 0
  const stack = [abs]
  while (stack.length) {
    const p = stack.pop()!
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const q = join(p, e.name)
      if (e.isDirectory()) stack.push(q)
      else if (e.isFile()) total += lstatSync(q).size
    }
  }
  return total
}

export function purgeExpired(): number {
  const cutoff = Date.now() - config.trashRetentionDays * 86_400_000
  let n = 0
  for (const m of listTrash()) {
    if (Date.parse(m.deletedAt) < cutoff) {
      rmSync(itemDir(m.id), { recursive: true, force: true })
      n++
    }
  }
  return n
}

export { parentRel }
