/**
 * The search index: every file and folder under the storage (the public folder lies inside it) as one row in
 * DATA_DIR/search.db, so a search is one indexed query instead of a walk of the disk. The disk stays the truth:
 * the file is only a cache. It is built in the background at start, built again every SEARCH_RESCAN_MINUTES, and
 * kept current in between by indexTouched() after each write. Missing, damaged or of an old schema: it is deleted
 * and built again (never in backups). Until the first build ends, /api/search walks the disk (`indexed: false`).
 * Links are never followed or listed, as in searchTree.
 */
import { Database } from 'bun:sqlite'
import { lstatSync, realpathSync, rmSync } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'
import { config, paths } from './config'
import { bad, type Entry, joinRel, searchTree, within } from './fsx'
import { log } from './logger'

/** bump when the table changes: an older file is dropped and built again */
const SCHEMA_VERSION = 1
/** entries read between two breaks, and rows written per transaction */
const BATCH = 250
export const MAX_LIMIT = 500
export const DEFAULT_LIMIT = 200

export type SearchFilters = {
  type?: 'file' | 'dir'
  /** lower case, no dot */
  ext?: string[]
  from?: number
  to?: number
  minSize?: number
  maxSize?: number
  sort: 'name' | 'mtime' | 'size'
  order: 'asc' | 'desc'
  limit: number
}
export type SearchQuery = Partial<Record<'type' | 'ext' | 'from' | 'to' | 'minSize' | 'maxSize' | 'sort' | 'order' | 'limit', string>>

let db: Database | null = null
let ready = false
let gen = 1
let scanning: Promise<void> | null = null
let timer: ReturnType<typeof setInterval> | null = null
let pending = 0
const idleWaiters: (() => void)[] = []

/** the folders the index covers: the storage, and the public folder when it lies elsewhere */
const roots = () => (within(config.storageDir, paths.publicDir) ? [config.storageDir] : [config.storageDir, paths.publicDir])

const extOf = (name: string, isDir: boolean) => (isDir ? '' : extname(name).slice(1).toLowerCase())

function removeFiles() {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(paths.searchDb + suffix, { force: true })
}

function openDb(fresh = false): Database {
  const open = () => {
    const d = new Database(paths.searchDb, { create: true })
    try {
      d.exec('PRAGMA journal_mode = WAL')
      d.exec('PRAGMA synchronous = NORMAL')
      const version = d.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version
      if (version === 0) {
        d.exec(`CREATE TABLE IF NOT EXISTS entries (
          root TEXT NOT NULL, rel TEXT NOT NULL, name_lower TEXT NOT NULL, ext TEXT NOT NULL, type TEXT NOT NULL,
          size INTEGER NOT NULL, mtime INTEGER NOT NULL, gen INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (root, rel)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS entries_name ON entries (root, name_lower);
        CREATE INDEX IF NOT EXISTS entries_ext ON entries (root, ext);
        CREATE INDEX IF NOT EXISTS entries_mtime ON entries (root, mtime);
        CREATE INDEX IF NOT EXISTS entries_size ON entries (root, size);
        PRAGMA user_version = ${SCHEMA_VERSION};`)
      } else if (version !== SCHEMA_VERSION) {
        throw new Error('old schema')
      } else if (d.query<{ quick_check: string }, []>('PRAGMA quick_check(1)').get()?.quick_check !== 'ok') {
        throw new Error('damaged')
      } else {
        d.query('SELECT 1 FROM entries LIMIT 1').get() // a missing table throws: damaged as well
      }
      return d
    } catch (err) {
      try { d.close() } catch { /* already unusable */ }
      throw err
    }
  }
  try {
    if (fresh) removeFiles()
    return open()
  } catch (err) {
    log.warn('search-index-rebuild', `search.db ใช้ไม่ได้ (${(err as Error).message}) สร้างใหม่`)
    removeFiles()
    return open()
  }
}

/** drop the file and start over (a query failed: the file is damaged) */
function reset() {
  ready = false
  try { db?.close() } catch { /* gone anyway */ }
  db = null
  scanning = null
  db = openDb(true)
  void scanIndex()
}

/** true once the first build of this run has ended: only then are answers taken from the index */
export const indexReady = () => ready && db !== null

/** open the index and build it in the background; again every SEARCH_RESCAN_MINUTES */
export function startSearchIndex(): void {
  if (db || !config.searchIndex) return
  db = openDb()
  void scanIndex()
  if (config.searchRescanMinutes > 0) {
    timer = setInterval(() => void scanIndex(), config.searchRescanMinutes * 60_000)
    timer.unref()
  }
}

export function stopSearchIndex(): void {
  if (timer) clearInterval(timer)
  timer = null
  ready = false
  scanning = null
  try { db?.close() } catch { /* already closed */ }
  db = null
}

type Row = [root: string, rel: string, nameLower: string, ext: string, type: string, size: number, mtime: number, gen: number]

function rowOf(root: string, rel: string, name: string, st: { isDirectory(): boolean; size: number; mtimeMs: number }): Row {
  const isDir = st.isDirectory()
  return [root, rel, name.toLowerCase(), extOf(name, isDir), isDir ? 'dir' : 'file', isDir ? 0 : st.size, Math.round(st.mtimeMs), gen]
}

const UPSERT = 'INSERT OR REPLACE INTO entries (root, rel, name_lower, ext, type, size, mtime, gen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'

/** walk `abs` (whose index path is `rel` under `root`) and write what is found, a batch at a time */
async function walk(d: Database, root: string, abs: string, rel: string) {
  const insert = d.prepare(UPSERT)
  const write = d.transaction((rows: Row[]) => { for (const r of rows) insert.run(...r) })
  const stack: [string, string][] = [[abs, rel]]
  while (stack.length) {
    const [dir, dirRel] = stack.pop()!
    let names: string[]
    try { names = await readdir(dir) } catch { continue }
    for (let i = 0; i < names.length; i += BATCH) {
      const batch = names.slice(i, i + BATCH)
      const stats = await Promise.all(batch.map(n => lstat(join(dir, n)).catch(() => null)))
      const rows: Row[] = []
      for (let k = 0; k < batch.length; k++) {
        const st = stats[k]
        if (!st || st.isSymbolicLink()) continue
        const childRel = joinRel(dirRel, batch[k])
        rows.push(rowOf(root, childRel, batch[k], st))
        if (st.isDirectory()) stack.push([join(dir, batch[k]), childRel])
      }
      if (db !== d) return // stopped or reset meanwhile
      write(rows)
      // a break after each write, so requests are answered between two batches
      await new Promise<void>(r => setImmediate(r))
    }
  }
}

/** build the index again from the disk; while one build runs, every caller gets that same one */
export function scanIndex(): Promise<void> {
  const d = db
  if (!d) return Promise.resolve()
  scanning ??= (async () => {
    const mine = ++gen
    const list = roots()
    for (const root of list) {
      await walk(d, root, root, '/')
      if (db !== d) return
      d.query('DELETE FROM entries WHERE root = ? AND gen <> ?').run(root, mine)
    }
    d.query(`DELETE FROM entries WHERE root NOT IN (${list.map(() => '?').join(',')})`).run(...list)
    ready = true
  })().catch(err => {
    log.error('search-index-scan', err)
  }).finally(() => { scanning = null })
  return scanning
}

/** resolves when the folder walks started by indexTouched have finished (tests, and anything that must see them) */
export function indexIdle(): Promise<void> {
  return pending === 0 ? Promise.resolve() : new Promise(r => idleWaiters.push(r))
}

/** where `abs` sits in the index: its root and the path under it, or null when it is outside every root */
function locate(abs: string): { root: string; rel: string } | null {
  for (const root of roots()) {
    if (!within(root, abs)) continue
    return { root, rel: '/' + relative(root, abs).split(sep).filter(Boolean).join('/') }
  }
  return null
}

/** rows of `rel` and everything under it, by whole path segments ('/' sorts just before '0') */
function removeRows(d: Database, root: string, rel: string) {
  d.query('DELETE FROM entries WHERE root = ? AND (rel = ? OR (rel >= ? AND rel < ?))').run(root, rel, rel + '/', rel + '0')
}

/**
 * Called after a write at `abs`: re-read that path. Gone (or a link): it and everything under it leave the index.
 * A folder: the folder itself is updated now, what is inside it is read in the background.
 * Never throws and never waits: a failed update is put right by the next build.
 */
export function indexTouched(abs: string): void {
  const d = db
  if (!d) return
  try {
    const at = locate(abs)
    if (!at || at.rel === '/') return
    let st: ReturnType<typeof lstatSync> | null = null
    try { st = lstatSync(abs) } catch { /* gone */ }
    removeRows(d, at.root, at.rel)
    if (!st || st.isSymbolicLink()) return
    d.query(UPSERT).run(...rowOf(at.root, at.rel, basename(abs), st))
    if (st.isDirectory()) {
      pending++
      void walk(d, at.root, abs, at.rel).catch(() => {}).finally(() => {
        if (--pending === 0) for (const w of idleWaiters.splice(0)) w()
      })
    }
  } catch (err) {
    log.warn('search-index-touch', { error: (err as Error).message })
  }
}

// ───────────── query ─────────────

function number(name: string, v: string | undefined, min = 0): number | undefined {
  if (v === undefined || v === '') return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || n < min) throw bad('files.bad-filter', { name })
  return n
}

function when(name: string, v: string | undefined, end: boolean): number | undefined {
  if (v === undefined || v === '') return undefined
  const ms = Date.parse(v)
  if (Number.isNaN(ms)) throw bad('files.bad-filter', { name })
  // "2024-05-31" as `to` means the whole day
  return end && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? ms + 86_400_000 - 1 : ms
}

/** the filters of a request, checked */
export function parseFilters(q: SearchQuery): SearchFilters {
  if (q.type !== undefined && q.type !== '' && q.type !== 'file' && q.type !== 'dir') throw bad('files.bad-filter', { name: 'type' })
  const sort = q.sort || 'name'
  if (sort !== 'name' && sort !== 'mtime' && sort !== 'size') throw bad('files.bad-filter', { name: 'sort' })
  const order = q.order || 'asc'
  if (order !== 'asc' && order !== 'desc') throw bad('files.bad-filter', { name: 'order' })
  const ext = (q.ext ?? '').split(',').map(e => e.trim().replace(/^\./, '').toLowerCase()).filter(Boolean)
  const limit = number('limit', q.limit, 1)
  return {
    type: q.type ? q.type : undefined,
    ext: ext.length ? ext : undefined,
    from: when('from', q.from, false),
    to: when('to', q.to, true),
    minSize: number('minSize', q.minSize),
    maxSize: number('maxSize', q.maxSize),
    sort, order,
    limit: Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit ?? DEFAULT_LIMIT))),
  }
}

/** does an entry pass the filters (the walk of the disk uses this; the index asks SQL the same) */
export function accepts(f: SearchFilters, e: Entry): boolean {
  return (!f.type || e.type === f.type)
    && (!f.ext || f.ext.includes(extOf(e.name, e.type === 'dir')))
    && (f.from === undefined || e.mtime >= f.from)
    && (f.to === undefined || e.mtime <= f.to)
    && (f.minSize === undefined || e.size >= f.minSize)
    && (f.maxSize === undefined || e.size <= f.maxSize)
}

/** the order of the index: binary on the lower case name (as SQLite sorts), then the path */
function compare(f: SearchFilters, a: Entry, b: Entry): number {
  const sign = f.order === 'desc' ? -1 : 1
  let c = 0
  if (f.sort === 'mtime') c = a.mtime - b.mtime
  else if (f.sort === 'size') c = a.size - b.size
  if (c === 0) c = Buffer.compare(Buffer.from(a.name.toLowerCase()), Buffer.from(b.name.toLowerCase()))
  if (c === 0) c = Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))
  return c * sign
}

export type SearchAnswer = { results: Entry[]; truncated: boolean; indexed: boolean }

/**
 * Where the start folder sits in the index, or null when the index can not answer for it: not built yet, outside
 * the roots, or reached through a link (the index never follows links, a walk of the disk does).
 */
function startInIndex(startAbs: string): { root: string; rel: string } | null {
  if (!indexReady()) return null
  const at = locate(startAbs)
  if (!at) return null
  try {
    return realpathSync(startAbs) === join(realpathSync(at.root), at.rel) ? at : null
  } catch {
    return null
  }
}

/**
 * Entries below the start folder (`startAbs`, which is `startRel` in the caller's space; the caller has checked it
 * lies inside the space) with `needle` (lower case) in the name. Only what lies below it is ever returned:
 * the start path is a prefix of whole segments, never of a part of a name.
 */
export async function searchEntries(startAbs: string, startRel: string, needle: string, f: SearchFilters): Promise<SearchAnswer> {
  const at = startInIndex(startAbs)
  if (at && db) {
    try {
      const where = ['root = ?', 'instr(name_lower, ?) > 0']
      const args: (string | number)[] = [at.root, needle]
      if (at.rel !== '/') { where.push('rel >= ?', 'rel < ?'); args.push(at.rel + '/', at.rel + '0') }
      if (f.type) { where.push('type = ?'); args.push(f.type) }
      if (f.ext) { where.push(`ext IN (${f.ext.map(() => '?').join(',')})`); args.push(...f.ext) }
      if (f.from !== undefined) { where.push('mtime >= ?'); args.push(f.from) }
      if (f.to !== undefined) { where.push('mtime <= ?'); args.push(f.to) }
      if (f.minSize !== undefined) { where.push('size >= ?'); args.push(f.minSize) }
      if (f.maxSize !== undefined) { where.push('size <= ?'); args.push(f.maxSize) }
      const dir = f.order === 'desc' ? 'DESC' : 'ASC'
      const order = f.sort === 'name' ? `name_lower ${dir}, rel ${dir}` : `${f.sort} ${dir}, name_lower ${dir}, rel ${dir}`
      const rows = db.query<{ rel: string; type: string; size: number; mtime: number }, (string | number)[]>(
        `SELECT rel, type, size, mtime FROM entries WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${f.limit + 1}`,
      ).all(...args)
      // the path in the space: the start folder, then what lies under it
      const prefix = startRel === '/' ? '' : startRel
      const cut = at.rel === '/' ? 0 : at.rel.length
      const results: Entry[] = rows.slice(0, f.limit).map(r => ({
        name: r.rel.slice(r.rel.lastIndexOf('/') + 1), path: prefix + r.rel.slice(cut),
        type: r.type as 'file' | 'dir', size: r.size, mtime: r.mtime,
      }))
      return { results, truncated: rows.length > f.limit, indexed: true }
    } catch (err) {
      log.error('search-index-query', err)
      try { reset() } catch (e) { log.error('search-index-reset', e) }
    }
  }
  const walked = await searchTree(startAbs, startRel, needle, 50_000, f.limit, e => accepts(f, e))
  return { results: walked.results.sort((a, b) => compare(f, a, b)), truncated: walked.truncated, indexed: false }
}
