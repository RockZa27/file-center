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
import { createReadStream } from 'node:fs'
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

const cache = new Map<string, { at: number; result: InsightResult }>()
let running: { key: string; promise: Promise<void> } | null = null

/** what is known about a folder: nothing yet, a scan under way, or the last result (while it is still young) */
export function insightState(key: string): InsightState {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at > INSIGHT_LIMITS.cacheMs) cache.delete(key)
  const fresh = cache.get(key)
  if (running?.key === key) return { state: 'running', result: fresh?.result }
  return fresh ? { state: 'done', result: fresh.result } : { state: 'none' }
}

export type StartOutcome = 'started' | 'running' | 'recent' | 'busy'

/** start a scan in the background. `busy`: another folder is being scanned; `recent`: this one was scanned a moment ago */
export function startInsight(key: string, root: string): StartOutcome {
  if (running) return running.key === key ? 'running' : 'busy'
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < INSIGHT_LIMITS.rescanMs) return 'recent'
  const promise = scanFolder(root).then(result => {
    if (cache.size >= INSIGHT_LIMITS.cacheEntries) cache.delete(cache.keys().next().value!)
    cache.delete(key)
    cache.set(key, { at: Date.now(), result })
  }).catch(err => log.warn('insight-failed', { error: err })).finally(() => { running = null })
  running = { key, promise }
  return 'started'
}

/** wait for the running scan (tests) */
export const insightIdle = async () => { await running?.promise }
export const forgetInsight = (key?: string) => { if (key) cache.delete(key); else cache.clear() }
