import { statfsSync } from 'node:fs'
import { join } from 'node:path'
import { config, paths } from './config'
import { treeStats } from './fsx'
import { JsonStore } from './store'

/** file count and size of the whole storage and of the visitor folder, as shown on the dashboard */
export type StorageStats = {
  size: number
  files: number
  truncated: boolean
  public: { size: number; files: number }
  /** ISO time the count finished */
  countedAt: string
}

/** numbers younger than this are shown as they are; older ones are shown too, while a recount runs */
const MAX_AGE_MS = 60_000
const LIMIT = 1_000_000

// on disk so the dashboard has numbers right after a restart, without waiting for a count
const cache = new JsonStore<StorageStats | null>(join(config.dataDir, 'stats-cache.json'), () => null)
let counting: Promise<void> | null = null

/** count again in the background; while one count runs, every caller gets that same one */
export function recountStorage(): Promise<void> {
  counting ??= (async () => {
    const all = await treeStats(config.storageDir, LIMIT)
    const pub = await treeStats(paths.publicDir, LIMIT)
    cache.replace({
      size: all.size, files: all.files, truncated: all.truncated || pub.truncated,
      public: { size: pub.size, files: pub.files }, countedAt: new Date().toISOString(),
    })
  })().catch(() => { /* nothing saved: the next dashboard call tries again */ }).finally(() => { counting = null })
  return counting
}

/**
 * Never waits for a count: answers with the last numbers (null before the very first count ends)
 * and `stale: true` when they are older than a minute, starting a recount in the background.
 */
export function storageStats(): { storage: StorageStats | null; stale: boolean } {
  const last = typeof cache.value?.files === 'number' ? cache.value : null
  const age = last ? Date.now() - Date.parse(last.countedAt) : NaN
  const fresh = age >= 0 && age < MAX_AGE_MS
  if (!fresh) void recountStorage()
  return { storage: last, stale: !fresh || counting !== null }
}

/** below this much free disk (percent) the dashboard warns as critical and an alert goes out (alerts.ts) */
export const DISK_CRITICAL_PERCENT = 5
/** below this the dashboard warns */
export const DISK_LOW_PERCENT = 10

/** size and free space of the disk the storage is on, or null when it can not be read */
export function diskInfo(): { total: number; free: number; used: number } | null {
  try {
    const s = statfsSync(config.storageDir)
    const total = Number(s.blocks) * Number(s.bsize)
    const free = Number(s.bavail) * Number(s.bsize)
    return { total, free, used: total - free }
  } catch {
    return null
  }
}
