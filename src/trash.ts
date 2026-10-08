import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { config, paths } from './config'
import {
  conflict, ensureDir, moveSync, notFound, parentRel, resolveIn, treeStats, uniquePath,
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
}

const itemDir = (id: string) => join(paths.trash, id)

function safeId(id: unknown): string {
  if (typeof id !== 'string' || !/^[0-9]{13}_[a-f0-9]{8}$/.test(id)) throw notFound()
  return id
}

export function moveToTrash(abs: string, deletedBy: string): TrashMeta {
  const st = lstatSync(abs)
  const isDir = st.isDirectory() && !st.isSymbolicLink()
  const id = `${Date.now()}_${randomBytes(4).toString('hex')}`
  const meta: TrashMeta = {
    id,
    name: basename(abs),
    type: isDir ? 'dir' : 'file',
    size: isDir ? treeStats(abs, 200_000).size : st.size,
    originalPath: '/' + relative(config.storageDir, abs).split(/[\\/]/).join('/'),
    deletedAt: new Date().toISOString(),
    deletedBy,
  }
  ensureDir(itemDir(id))
  moveSync(abs, join(itemDir(id), 'item'))
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

export function restore(idRaw: unknown): { meta: TrashMeta; restoredTo: string } {
  const id = safeId(idRaw)
  const dir = itemDir(id)
  if (!existsSync(join(dir, 'meta.json'))) throw notFound()
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as TrashMeta
  const target = resolveIn(config.storageDir, meta.originalPath)
  ensureDir(dirname(target))
  const finalPath = uniquePath(target)
  if (existsSync(finalPath)) throw conflict('มีรายการชื่อเดียวกันอยู่แล้ว')
  moveSync(join(dir, 'item'), finalPath)
  rmSync(dir, { recursive: true, force: true })
  const rel = '/' + relative(config.storageDir, finalPath).split(/[\\/]/).join('/')
  return { meta, restoredTo: rel }
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
