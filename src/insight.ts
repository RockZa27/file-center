/**
 * Storage insight: what takes the space (biggest files, size by file type) and which files are the same file twice.
 *
 * A scan is a background job, never part of a request: one runs at a time for the whole server (a second request
 * for another folder is told to wait), it stops at a file count, a hashing budget and a time limit, and its result is
 * kept for a few minutes. Duplicates are found cheaply: files are grouped by size first, and only files that share a
 * size with another are read, streamed through SHA-256. Symlinks are never followed. The result holds paths relative to
 * the scanned folder; who may see it is decided by the route on every request, not by the cache.
 */
import { createHash } from 'node:crypto'
import { createReadStream, lstatSync } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { normRel } from './fsx'
import { log } from './logger'

/** the limits; tests make them smaller */
export const INSIGHT_LIMITS = {
  /** files looked at; the scan stops there and says so */
  maxFiles: 200_000,
  /** bytes read for hashing, in total */
  maxHashBytes: 4 * 1024 ** 3,
  /** the whole scan, scanning and hashing */
  maxMs: 60_000,
  /** files read at the same time */
  hashParallel: 3,
  /** a file smaller than this is not worth listing as a duplicate (empty files all match) */
  minDuplicateSize: 1024,
  topFiles: 50,
  topTypes: 30,
  topGroups: 100,
  /** paths listed per group (the count is the real one) */
  perGroup: 20,
  /** a result is reused for this long; a rescan of the same folder is refused sooner than rescanMs */
  cacheMs: 10 * 60_000,
  rescanMs: 30_000,
  /** a user who is not an admin waits this long after their last scan finished before starting another */
  userCooldownMs: 2 * 60_000,
  cacheEntries: 20,
}

export type InsightFile = { path: string; size: number; mtime: number }
export type InsightType = { ext: string; files: number; size: number }
export type InsightGroup = { size: number; hash: string; count: number; wasted: number; files: InsightFile[] }
export type InsightResult = {
  scannedAt: string
  durationMs: number
  files: number
  size: number
  /** the scan stopped at a limit: the numbers are for what was seen */
  truncated: { files: boolean; time: boolean; hashBudget: boolean }
  largest: InsightFile[]
  types: InsightType[]
  duplicates: { groups: InsightGroup[]; totalGroups: number; wasted: number; hashedBytes: number }
}
export type InsightState = { state: 'none' | 'running' | 'done'; result?: InsightResult }

const BATCH = 1000
const sleep = () => new Promise<void>(r => setTimeout(r, 0))

function typeOf(name: string): string {
  const e = extname(name).slice(1).toLowerCase()
  return /^[a-z0-9_+-]{1,10}$/.test(e) ? e : e ? 'other' : ''
}

/** SHA-256 of a file, streamed; null when it changed size, vanished or was unreadable */
async function sha256(abs: string, size: number, deadline: number): Promise<string | null> {
  return new Promise(resolve => {
    const h = createHash('sha256')
    let read = 0
    const s = createReadStream(abs)
    const fail = () => { s.destroy(); resolve(null) }
    s.on('data', c => {
      read += c.length
      if (read > size || Date.now() > deadline) fail()
      else h.update(c)
    })
    s.on('error', () => resolve(null))
    s.on('end', () => resolve(read === size ? h.digest('hex') : null))
  })
}

export async function scanFolder(root: string): Promise<InsightResult> {
  const L = INSIGHT_LIMITS
  const started = Date.now()
  const deadline = started + L.maxMs
  const truncated = { files: false, time: false, hashBudget: false }
  let files = 0
  let total = 0
  let largest: InsightFile[] = []
  let smallestKept = 0
  const types = new Map<string, InsightType>()
  const sizes = new Map<number, InsightFile[]>()

  const stack = [root]
  scan: while (stack.length) {
    const dir = stack.pop()!
    let names: string[]
    try { names = await readdir(dir) } catch { continue }
    for (let i = 0; i < names.length; i += BATCH) {
      if (Date.now() > deadline) { truncated.time = true; break scan }
      const batch = names.slice(i, i + BATCH)
      const stats = await Promise.all(batch.map(n => lstat(join(dir, n)).catch(() => null)))
      for (let k = 0; k < stats.length; k++) {
        const st = stats[k]
        if (!st || st.isSymbolicLink()) continue
        const abs = join(dir, batch[k])
        if (st.isDirectory()) { stack.push(abs); continue }
        if (!st.isFile()) continue
        if (files >= L.maxFiles) { truncated.files = true; break scan }
        files++
        total += st.size
        const ext = typeOf(batch[k])
        const t = types.get(ext) ?? { ext, files: 0, size: 0 }
        t.files++; t.size += st.size
        types.set(ext, t)
        const entry: InsightFile = { path: normRel('/' + relative(root, abs).split(/[\\/]/).join('/')), size: st.size, mtime: Math.floor(st.mtimeMs) }
        if (largest.length < L.topFiles || st.size > smallestKept) {
          largest.push(entry)
          if (largest.length > L.topFiles * 2) { largest.sort((a, b) => b.size - a.size); largest = largest.slice(0, L.topFiles); smallestKept = largest[largest.length - 1].size }
        }
        if (st.size >= L.minDuplicateSize) {
          const g = sizes.get(st.size)
          if (g) g.push(entry); else sizes.set(st.size, [entry])
        }
      }
      await sleep()
    }
  }
  largest.sort((a, b) => b.size - a.size)
  largest = largest.slice(0, L.topFiles)

  // only files that share a size with another file can be the same file; the biggest sizes first (most to win)
  const candidates = [...sizes.entries()].filter(([, g]) => g.length > 1).sort((a, b) => b[0] - a[0])
  const byHash = new Map<string, InsightFile[]>()
  let hashed = 0
  const jobs: { size: number; file: InsightFile }[] = []
  for (const [size, g] of candidates) for (const f of g) jobs.push({ size, file: f })
  let next = 0
  const worker = async () => {
    while (next < jobs.length) {
      const j = jobs[next++]
      if (Date.now() > deadline) { truncated.time = true; return }
      if (hashed + j.size > L.maxHashBytes) { truncated.hashBudget = true; continue }
      hashed += j.size
      const digest = await sha256(join(root, j.file.path), j.size, deadline)
      if (!digest) continue
      const key = `${j.size}:${digest}`
      const g = byHash.get(key)
      if (g) g.push(j.file); else byHash.set(key, [j.file])
    }
  }
  await Promise.all(Array.from({ length: L.hashParallel }, worker))

  const all: InsightGroup[] = []
  for (const [key, list] of byHash) {
    if (list.length < 2) continue
    list.sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path))
    const [size, hash] = key.split(':')
    all.push({ size: Number(size), hash: hash.slice(0, 16), count: list.length, wasted: Number(size) * (list.length - 1), files: list.slice(0, L.perGroup) })
  }
  all.sort((a, b) => b.wasted - a.wasted)

  return {
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    files, size: total, truncated, largest,
    types: [...types.values()].sort((a, b) => b.size - a.size).slice(0, L.topTypes),
    duplicates: { groups: all.slice(0, L.topGroups), totalGroups: all.length, wasted: all.reduce((n, g) => n + g.wasted, 0), hashedBytes: hashed },
  }
}

// ───────────── the job: one at a time, results kept ─────────────

const cache = new Map<string, { at: number; root: string; result: InsightResult }>()
/** when a scan of a folder last started: kept apart from the cache so that forgetting a result (a delete) does not allow an earlier rescan */
const lastStart = new Map<string, number>()
/** when the last scan a (non-admin) user started finished */
const userDone = new Map<string, number>()
let running: { key: string; promise: Promise<void> } | null = null

const exists = (abs: string) => { try { lstatSync(abs); return true } catch { return false } }

/**
 * The cached result as it can be shown now: files that are gone since the scan (deleted, renamed or moved by any route,
 * WebDAV included) are left out of the lists, so a name that was removed is not served for ten minutes. The totals stay
 * as scanned. Bounded work: at most topFiles + topGroups * perGroup lstat calls (about 2,000 by default, a few ms).
 */
function current(root: string, r: InsightResult): InsightResult {
  const there = (f: InsightFile) => exists(join(root, f.path))
  const groups: InsightGroup[] = []
  for (const g of r.duplicates.groups) {
    const files = g.files.filter(there)
    const count = g.count - (g.files.length - files.length)
    if (count < 2 || !files.length) continue
    groups.push({ ...g, files, count, wasted: g.size * (count - 1) })
  }
  return { ...r, largest: r.largest.filter(there), duplicates: { ...r.duplicates, groups } }
}

/** what is known about a folder: nothing yet, a scan under way, or the last result (while it is still young) */
export function insightState(key: string): InsightState {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at > INSIGHT_LIMITS.cacheMs) cache.delete(key)
  const fresh = cache.get(key)
  const result = fresh && current(fresh.root, fresh.result)
  if (running?.key === key) return { state: 'running', result }
  return result ? { state: 'done', result } : { state: 'none' }
}

/** seconds a non-admin user still has to wait before their next scan (0: may start) */
export function cooldownLeft(user: string): number {
  const done = userDone.get(user)
  if (done === undefined) return 0
  const left = done + INSIGHT_LIMITS.userCooldownMs - Date.now()
  if (left <= 0) { userDone.delete(user); return 0 }
  return Math.ceil(left / 1000)
}

export type StartOutcome = 'started' | 'running' | 'recent' | 'busy' | 'cooldown'

/**
 * start a scan in the background. `busy`: another folder is being scanned; `recent`: this one was started a moment ago;
 * `cooldown`: `limitedUser` (pass the name of a user who is not an admin) finished a scan too recently
 */
export function startInsight(key: string, root: string, limitedUser?: string): StartOutcome {
  if (running) return running.key === key ? 'running' : 'busy'
  if (limitedUser && cooldownLeft(limitedUser) > 0) return 'cooldown'
  const prev = lastStart.get(key)
  if (prev !== undefined && Date.now() - prev < INSIGHT_LIMITS.rescanMs) return 'recent'
  if (lastStart.size >= 1000) for (const [k, v] of lastStart) if (Date.now() - v >= INSIGHT_LIMITS.rescanMs) lastStart.delete(k)
  lastStart.set(key, Date.now())
  const promise = scanFolder(root).then(result => {
    if (cache.size >= INSIGHT_LIMITS.cacheEntries) cache.delete(cache.keys().next().value!)
    cache.delete(key)
    cache.set(key, { at: Date.now(), root, result })
  }).catch(err => log.warn('insight-failed', { error: err })).finally(() => {
    if (limitedUser) userDone.set(limitedUser, Date.now())
    running = null
  })
  running = { key, promise }
  return 'started'
}

/** wait for the running scan (tests) */
export const insightIdle = async () => { await running?.promise }
/** drop cached results (all, or one folder); the rescan guard and the user cooldown stay */
export const forgetInsight = (key?: string) => { if (key) cache.delete(key); else cache.clear() }
