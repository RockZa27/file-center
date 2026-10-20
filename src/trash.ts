import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { allUsers, type User } from './auth'
import { config, paths } from './config'
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

/** the plain user whose home holds `abs` (an admin's home is everything, so it never decides), or null */
export function homeOwnerOf(abs: string): User | null {
  let best: User | null = null
  let bestLen = -1
  for (const u of allUsers()) {
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
  try { return homeOwnerOf(join(config.storageDir, normRel(meta.originalPath)))?.username ?? null } catch { return null }
}

const itemDir = (id: string) => join(paths.trash, id)

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
  try {
    await moveTree(abs, join(itemDir(id), 'item'))
  } catch (err) {
    // e.g. another request moved or deleted it while we counted: leave no empty trash entry behind
    rmSync(itemDir(id), { recursive: true, force: true })
    throw err
  }
  // the earlier versions of the file(s) go along, so a restore brings them back
  try { stashVersions(abs, join(itemDir(id), 'versions')) } catch (err) { log.warn('versions-stash-failed', { id, error: err }) }
  indexTouched(abs)
  writeFileSync(join(itemDir(id), 'meta.json'), JSON.stringify(meta))
  return meta
}

export function listTrash(): TrashMeta[] {
  if (!existsSync(paths.trash)) return []
  const out: TrashMeta[] = []
  for (const id of readdirSync(paths.trash)) {
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
