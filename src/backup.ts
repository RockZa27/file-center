/**
 * Backups of the system data: accounts and passwords, settings, logo and the activity log. Without them a dead
 * disk loses every account. One backup is one zip in config.backupDir:
 *
 *   users.json  settings.json  groups.json  grants.json (and the other small data files)  branding/  logs/audit.log  logs/system.log  backup.json  [storage/ when files are included]
 *
 * Not in it: tmp/, trash/ and versions/ (temporary), app/ (installed updates), sessions.json (logins), rotated logs,
 * access.log and launcher.log, the backup folder itself, search.db (the search index, rebuilt from the disk), secret.key, office-links.key and app-passwords.json (credentials, kept out on purpose). Restoring puts back users.json, settings.json and branding/ only, never storage/ (groups.json is in the zip but is not restored: a group is its folder in storage/ plus its list of members, and the two must stay together).
 */
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
  writeFileSync, writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js'
import { audit } from './audit'
import { alert } from './alerts'
import { config, paths } from './config'
import { bad, cleanName, conflict, ensureSpace, freeSpace, fromFsError, HttpError, notFound, within } from './fsx'
import { restartSoon } from './lifecycle'
import { log } from './logger'
import { mirrorAlert } from './notify'
import { type Lang, MESSAGES, type MessageCode, type Params, sizeText, text } from './messages'
import { type BackupPrefs, settings } from './settings'
import { recountStorage, storageStats } from './stats'
import { JsonStore } from './store'
import { collectZipItems, zipStream, type ZipItem } from './zip'

export const BACKUP_NAME_RE = /^file-center-backup-\d{8}-\d{6}\.zip$/

/** sizes of one part of a backup: files in it, bytes before and after compression */
export type PartSizes = { files: number; size: number; compressed: number }
/** data = users, settings, logo and the rest; logs = the activity and system log; storage = the uploaded files (only with includeFiles) */
export type BackupParts = { data: PartSizes; logs: PartSizes; storage: PartSizes }
/** `parts` is null for a backup made before 1.10 (its backup.json has no sizes) */
export type BackupItem = { name: string; size: number; createdAt: string; parts: BackupParts | null }
export type BackupStatus = {
  status: 'ok' | 'failed'
  lastSuccess: string | null
  lastAttempt: string
  /** Thai, for whoever reads the file; the API answers with `code` + `params` in the reader's language */
  message: string
  /** missing in a status written before there were codes: then `message` is shown as it is */
  code?: MessageCode
  /** a failure's reason (`reason`, and `reasonCode` when it is a catalog message) */
  params?: Params
  file: string | null
  size: number | null
}

// top-level names in DATA_DIR that never go into a backup
// secret.key opens the sealed 2FA secrets in users.json: a backup with both would give them away, so it is kept apart;
// app-passwords.json holds the WebDAV credentials (argon2 hashes): on purpose not in a backup, so a copy of one can not
// be turned into a way in; after a restore users make new app passwords;
// office-links.key signs short-lived ONLYOFFICE links: a restored server simply makes a new one;
// thumbs is a cache made again on demand
const SKIP = new Set(['tmp', 'trash', 'versions', 'thumbs', 'app', 'sessions.json', 'backup-status.json', 'stats-cache.json', 'cli-changed', 'secret.key', 'office-links.key', 'app-passwords.json'])
// search.db* (the search index and its WAL files) is rebuilt from the disk
const SEARCH_DB = /^search\.db(?:-wal|-shm|-journal)?$/
// of the logs only the current activity and system log go in: rotated ones, access.log and launcher.log stay out
const LOGS_KEPT = new Set(['logs/', 'logs/audit.log', 'logs/system.log'])
// users, settings and a logo are small: anything bigger in a backup is not ours
const RESTORE_MAX_BYTES = 64 * 1024 * 1024

const pad = (n: number) => String(n).padStart(2, '0')
/**
 * UTC, so names sort and mean the same whatever the clock does (daylight saving makes one local hour twice a year).
 * Backups made before 1.12.1 carry the server's local time in the name; their real time is in backup.json.
 */
const nameFor = (d: Date) =>
  `file-center-backup-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}.zip`

/** the time in a name (read as local time, as older versions wrote it): only for a backup whose backup.json can not be read */
function createdAtOf(name: string): string {
  const [, y, mo, d, h, mi, s] = /(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name)!.map(Number)
  return new Date(y, mo - 1, d, h, mi, s).toISOString()
}

/** the zip of a backup by its name; names with anything else in them (paths) are refused */
export function backupPath(name: unknown): string {
  if (typeof name !== 'string' || !BACKUP_NAME_RE.test(name)) throw bad('backup.bad-name')
  const abs = join(config.backupDir, name)
  if (!existsSync(abs)) throw notFound('backup.not-found')
  return abs
}

type BackupFile = Omit<BackupItem, 'parts'>

// what backup.json says (when it was made, the sizes of each part) is read once from the end of each zip, then remembered while the file is unchanged
const metaCache = new Map<string, { size: number; mtimeMs: number; createdAt: string; parts: BackupParts | null }>()

async function readMeta(abs: string, name: string): Promise<{ createdAt: string; parts: BackupParts | null }> {
  // not readable (a zip from outside, cut off, no backup.json): the date in its name, never the file's mtime, which a copy of the folder resets
  let out: { createdAt: string; parts: BackupParts | null } = { createdAt: createdAtOf(name), parts: null }
  const reader = new ZipReader(new BlobReader(Bun.file(abs)))
  try {
    const entry = (await reader.getEntries()).find(e => e.filename === 'backup.json')
    if (!entry || entry.directory || entry.uncompressedSize > 1024 * 1024) return out
    const meta = JSON.parse(await entry.getData(new TextWriter()))
    const ok = (p: any): p is PartSizes => p && [p.files, p.size, p.compressed].every(n => typeof n === 'number')
    if (typeof meta?.createdAt === 'string' && Number.isFinite(Date.parse(meta.createdAt))) out = { ...out, createdAt: new Date(meta.createdAt).toISOString() }
    if (ok(meta?.parts?.data) && ok(meta.parts.logs) && ok(meta.parts.storage)) out = { ...out, parts: meta.parts }
    return out
  } catch {
    return out
  } finally {
    await reader.close().catch(() => {})
  }
}

/** newest first by the time in backup.json (the name only breaks a tie): the order never depends on the clock's zone or on how a name was written */
async function listAll(): Promise<BackupItem[]> {
  let names: string[]
  try { names = readdirSync(config.backupDir) } catch { return [] }
  const out: BackupItem[] = []
  const alive = new Set<string>()
  for (const name of names.filter(n => BACKUP_NAME_RE.test(n))) {
    let st
    try { st = statSync(join(config.backupDir, name)) } catch { continue } // just deleted
    alive.add(name)
    let cached = metaCache.get(name)
    if (!cached || cached.size !== st.size || cached.mtimeMs !== st.mtimeMs) {
      cached = { size: st.size, mtimeMs: st.mtimeMs, ...(await readMeta(join(config.backupDir, name), name)) }
      metaCache.set(name, cached)
    }
    out.push({ name, size: st.size, createdAt: cached.createdAt, parts: cached.parts })
  }
  for (const n of metaCache.keys()) if (!alive.has(n)) metaCache.delete(n)
  return out.sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt) || (x.name < y.name ? 1 : -1))
}

/** newest first */
export async function listBackups(): Promise<BackupFile[]> {
  return (await listAll()).map(({ parts: _, ...f }) => f)
}

/** newest first, with the per-part sizes (null for a backup that has none: made by an older version, or unreadable) */
export const listBackupsDetailed = listAll

export function readStatus(): BackupStatus | null {
  try { return JSON.parse(readFileSync(paths.backupStatus, 'utf8')) } catch { return null }
}

/** the status as the API answers it: `message` in `lang`; an old file without a code keeps its stored message */
export function statusIn(lang: Lang): BackupStatus | null {
  const s = readStatus()
  if (!s || typeof s.code !== 'string' || !(s.code in MESSAGES)) return s
  const params: Params = { ...(s.params && typeof s.params === 'object' ? s.params : {}) }
  if (typeof params.reasonCode === 'string' && params.reasonCode in MESSAGES) params.reason = text(lang, params.reasonCode as MessageCode)
  return { ...s, message: text(lang, s.code, params) }
}

function writeStatus(s: Omit<BackupStatus, 'message'> & { code: MessageCode; params: Params }) {
  try {
    writeFileSync(`${paths.backupStatus}.tmp`, JSON.stringify({ ...s, message: text('th', s.code, s.params) }, null, 2))
    renameSync(`${paths.backupStatus}.tmp`, paths.backupStatus)
  } catch (err) {
    log.error('backup-status-write-failed', err)
  }
}

/** device of a path, or of its nearest existing parent */
function device(abs: string): number | null {
  for (let p = abs; ; p = dirname(p)) {
    try { return statSync(p).dev } catch { if (dirname(p) === p) return null }
  }
}

export type Schedule = NonNullable<BackupPrefs['schedule']>
export const COMPRESSION_LEVELS = { fast: 1, balanced: 6, smallest: 9 } as const
export type Compression = keyof typeof COMPRESSION_LEVELS

const pad2 = (n: number) => String(n).padStart(2, '0')
const hhmm = (time: string) => { const [h, m] = time.split(':').map(Number); return { h, m } }

/**
 * What the backup uses now: what the admin saved on the backup page, and for anything not saved the BACKUP_* env
 * values (BACKUP_HOUR as a daily schedule). With files in the backup and no saved count, only 2 copies are kept: each
 * one is as big as the storage.
 */
export function effectiveBackup(): { compression: Compression; schedule: Schedule; keep: number; includeFiles: boolean } {
  const saved = settings.get().backup ?? {}
  const includeFiles = saved.includeFiles ?? config.backupIncludeFiles
  return {
    compression: saved.compression ?? 'smallest',
    schedule: saved.schedule ?? (config.backupHour === null ? { mode: 'off' } : { mode: 'daily', time: `${pad2(config.backupHour)}:00` }),
    keep: saved.keep ?? (includeFiles ? Math.min(2, config.backupKeep) : config.backupKeep),
    includeFiles,
  }
}

const serverTimezone = () => ({ name: Intl.DateTimeFormat().resolvedOptions().timeZone, offsetMinutes: -new Date().getTimezoneOffset() })

export function backupSettings() {
  const a = device(config.backupDir)
  const eff = effectiveBackup()
  const { scheduleChangedAt: _, ...saved } = settings.get().backup ?? {}
  return {
    dir: config.backupDir,
    keep: eff.keep,
    /** the hour of a daily schedule, null for any other (kept for older pages) */
    hour: eff.schedule.mode === 'daily' ? hhmm(eff.schedule.time).h : null,
    includeFiles: eff.includeFiles,
    /** the same as includeFiles (older pages) */
    includesFiles: eff.includeFiles,
    compression: eff.compression,
    schedule: eff.schedule,
    /** only what the admin saved: a missing key is using the default */
    saved,
    /** schedule times are in the server's time zone */
    timezone: serverTimezone(),
    serverTime: new Date().toISOString(),
    nextRun: nextRun(),
    // a dead disk takes the backups on it along: the page warns about this
    sameDisk: a !== null && a === device(config.dataDir),
  }
}

const HOUR = 3600_000
const DAY = 24 * HOUR
/** a scheduled time is run when it is at most this old: the server being off for longer skips it (the 2-day net below covers that) */
const SLOT_WINDOW = HOUR
/** two scheduled runs are never closer than this (a manual backup shortly before the slot counts as the day's backup) */
const MIN_GAP = 20 * HOUR

/** the scheduled moment of a daily or weekly schedule on `day` (local time), or null when that day has none */
function slotOn(schedule: Schedule, day: Date): Date | null {
  if (schedule.mode !== 'daily' && schedule.mode !== 'weekly') return null
  if (schedule.mode === 'weekly' && !schedule.days.includes(day.getDay())) return null
  const { h, m } = hhmm(schedule.time)
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0)
}

/** the latest scheduled moment at or before `now` (daily and weekly only) */
function lastSlot(schedule: Schedule, now: Date): Date | null {
  for (let i = 0; i <= 7; i++) {
    const slot = slotOn(schedule, new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12))
    if (slot && slot <= now) return slot
  }
  return null
}

/** the latest of: last success, last attempt, the last change of the schedule (ms), or null when none */
function lastActivity(): number | null {
  const s = readStatus()
  const t = [s?.lastSuccess, s?.lastAttempt, settings.get().backup?.scheduleChangedAt].map(v => (v ? Date.parse(v) : NaN)).filter(Number.isFinite)
  return t.length ? Math.max(...t) : null
}

/** the next scheduled time (ISO), or for an interval the end of the current one; null when off */
function nextRun(now = new Date()): string | null {
  const { schedule } = effectiveBackup()
  if (schedule.mode === 'off') return null
  if (schedule.mode === 'interval') {
    const last = lastActivity()
    return new Date(last === null ? now.getTime() : Math.max(now.getTime(), last + schedule.hours * HOUR)).toISOString()
  }
  for (let i = 0; i <= 8; i++) {
    const slot = slotOn(schedule, new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, 12))
    if (slot && slot > now) return slot.toISOString()
  }
  return null
}

/** the longest wait the schedule means between two backups */
function periodOf(schedule: Schedule): number {
  if (schedule.mode === 'interval') return schedule.hours * HOUR
  if (schedule.mode === 'weekly') {
    const days = [...schedule.days].sort((x, y) => x - y)
    return Math.max(...days.map((d, i) => ((days[(i + 1) % days.length] - d + 6) % 7 + 1) * DAY))
  }
  return DAY
}

/** no success for this long and a backup runs anyway (the dashboard warns at the same point) */
export function staleAfterMs(): number {
  const { schedule } = effectiveBackup()
  return schedule.mode === 'off' ? 2 * DAY : Math.max(2 * DAY, 2 * periodOf(schedule))
}

/**
 * Checked every minute (index.ts). Daily and weekly run in the hour after the chosen time (server local time) when the
 * last backup is over 20 hours old; an interval runs when that many hours passed since the last one; a schedule saved
 * after a time does not run it. Whatever the schedule, a last success older than 2 days (twice the period when that is
 * longer) runs one, at most once an hour. Off never runs. A failed attempt counts as the last one, so a failure is not
 * retried every minute.
 */
export function backupDue(now = new Date()): boolean {
  const { schedule } = effectiveBackup()
  if (schedule.mode === 'off') return false
  const s = readStatus()
  const attempt = Math.max(Date.parse(s?.lastAttempt ?? '') || 0, Date.parse(s?.lastSuccess ?? '') || 0)
  const success = Date.parse(s?.lastSuccess ?? '')
  const age = Number.isFinite(success) ? now.getTime() - success : Infinity
  if (age > staleAfterMs() && now.getTime() - attempt >= HOUR) return true
  const last = lastActivity()
  if (schedule.mode === 'interval') return last === null || now.getTime() - last >= schedule.hours * HOUR
  const slot = lastSlot(schedule, now)
  if (!slot || now.getTime() - slot.getTime() >= SLOT_WINDOW) return false
  const changed = Date.parse(settings.get().backup?.scheduleChangedAt ?? '')
  if (Number.isFinite(changed) && slot.getTime() <= changed) return false
  return attempt === 0 || (slot.getTime() > attempt && now.getTime() - attempt >= MIN_GAP)
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

/** a schedule from the request, checked and cut down to the keys that count */
export function parseSchedule(v: any): Schedule {
  if (!v || typeof v !== 'object') throw bad('backup.bad-schedule')
  if (v.mode === 'off') return { mode: 'off' }
  if (v.mode === 'daily' || v.mode === 'weekly') {
    if (typeof v.time !== 'string' || !TIME_RE.test(v.time)) throw bad('backup.bad-time')
    if (v.mode === 'daily') return { mode: 'daily', time: v.time }
    if (!Array.isArray(v.days) || !v.days.length || !v.days.every((d: unknown) => isInt(d, 0, 6))) throw bad('backup.bad-days')
    return { mode: 'weekly', days: [...new Set<number>(v.days)].sort((x, y) => x - y), time: v.time }
  }
  if (v.mode === 'interval') {
    if (!isInt(v.hours, 1, 168)) throw bad('backup.bad-interval')
    return { mode: 'interval', hours: v.hours }
  }
  throw bad('backup.bad-schedule')
}

/**
 * Save what the backup page sent: a key left out stays as it is, `null` goes back to the default (env). Everything is
 * checked before anything is saved. Returns the changes in words for the activity log.
 */
export function saveBackupSettings(body: { compression?: unknown; schedule?: unknown; keep?: unknown; includeFiles?: unknown }): string[] {
  const next: BackupPrefs = { ...(settings.get().backup ?? {}) }
  const changes: string[] = []
  if (body.compression !== undefined) {
    if (body.compression === null) delete next.compression
    else if (typeof body.compression === 'string' && Object.hasOwn(COMPRESSION_LEVELS, body.compression)) next.compression = body.compression as Compression
    else throw bad('backup.bad-compression')
    changes.push(`compression=${body.compression}`)
  }
  if (body.schedule !== undefined) {
    if (body.schedule === null) delete next.schedule
    else next.schedule = parseSchedule(body.schedule)
    next.scheduleChangedAt = new Date().toISOString()
    changes.push(`schedule=${JSON.stringify(next.schedule ?? null)}`)
  }
  if (body.keep !== undefined) {
    if (body.keep === null) delete next.keep
    else if (isInt(body.keep, 1, 30)) next.keep = body.keep
    else throw bad('backup.bad-keep')
    changes.push(`keep=${body.keep}`)
  }
  if (body.includeFiles !== undefined) {
    if (body.includeFiles === null) delete next.includeFiles
    else if (typeof body.includeFiles === 'boolean') next.includeFiles = body.includeFiles
    else throw bad('backup.bad-schedule')
    changes.push(`includeFiles=${body.includeFiles}`)
  }
  settings.update({ backup: next })
  return changes
}

/** would these changes put the uploaded files into the backup when they are not in it now? (then the password is asked) */
export function turnsOnFiles(body: { includeFiles?: unknown }): boolean {
  if (body.includeFiles === undefined || effectiveBackup().includeFiles) return false
  return body.includeFiles === true || (body.includeFiles === null && config.backupIncludeFiles)
}

// one backup or restore at a time
let busy = false
export const backupRunning = () => busy

async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (busy) throw conflict('backup.busy')
  busy = true
  try { return await fn() } finally { busy = false }
}

/** the data folder's part of a backup (everything but the storage) */
function collectDataItems(): ZipItem[] {
  const names = readdirSync(config.dataDir).filter(n => !SKIP.has(n) && !SEARCH_DB.test(n) && !n.endsWith('.tmp'))
  // the storage may sit inside the data folder: its files only go in with includeFiles, under storage/
  return collectZipItems(config.dataDir, names)
    .filter(i => (!i.name.startsWith('logs/') || LOGS_KEPT.has(i.name)) && !within(config.storageDir, i.abs))
    .filter(i => !within(config.backupDir, i.abs))
}

function collectItems(includeFiles: boolean): ZipItem[] {
  const items = collectDataItems()
  if (includeFiles) {
    items.push({ name: 'storage/', abs: config.storageDir, dir: true, mtime: statSync(config.storageDir).mtimeMs, size: 0 })
    for (const i of collectZipItems(config.storageDir, readdirSync(config.storageDir))) {
      // the data folder may sit inside the storage: it is already in the backup, without sessions
      if (!within(config.dataDir, i.abs)) items.push({ ...i, name: `storage/${i.name}` })
    }
  }
  return items.filter(i => !within(config.backupDir, i.abs))
}

const partOf = (name: string): keyof BackupParts => (name.startsWith('storage/') ? 'storage' : name.startsWith('logs/') ? 'logs' : 'data')
const emptyParts = (): BackupParts => ({ data: { files: 0, size: 0, compressed: 0 }, logs: { files: 0, size: 0, compressed: 0 }, storage: { files: 0, size: 0, compressed: 0 } })

/** what the free-space checks look at; tests replace them */
export const backupDeps = {
  /** free bytes where `abs` is, or null when that can not be read (then nothing is checked) */
  free: (abs: string): number | null => freeSpace(abs),
  /** size of the uploaded files, as counted for the dashboard; a count older than a minute is redone, waiting a little for it */
  async storageSize(): Promise<number> {
    const { storage, stale } = storageStats()
    if (storage && !stale) return storage.size
    await Promise.race([recountStorage(), Bun.sleep(15_000)])
    return storageStats().storage?.size ?? storage?.size ?? 0
  },
}

/** the margin kept free on top of the estimate, and how many bytes are read between two looks at the free space */
export const backupLimits = { margin: 1024 ** 3, safety: 1.05, checkEvery: 256 * 1024 ** 2 }

/**
 * How much room a backup needs: the data folder's files and (with includeFiles) the whole storage, counted as if
 * compression saved nothing (uploaded rar, zip and video do not shrink), 5% on top and 1 GB of margin.
 */
export async function estimateBackup(includeFiles = effectiveBackup().includeFiles) {
  const parts = { data: 0, logs: 0, storage: 0 }
  for (const i of collectDataItems()) parts[partOf(i.name) === 'logs' ? 'logs' : 'data'] += i.size
  if (includeFiles) parts.storage = await backupDeps.storageSize()
  const estimate = parts.data + parts.logs + parts.storage
  mkdirSync(config.backupDir, { recursive: true })
  const free = backupDeps.free(config.backupDir)
  const needed = Math.ceil(estimate * backupLimits.safety) + backupLimits.margin
  return { estimate, free, needed, ok: free === null || free >= needed, parts }
}

/**
 * Make room before a backup: delete the oldest backups one by one, and only while the estimate says the new one does
 * not fit. The newest one always stays (at least one complete backup must remain until the new one is finished), and
 * so does `protect`. Still too little: nothing is started. Returns the names removed, so a failure that follows can be
 * told to the admin (the old copies are gone and the new one is not there).
 */
async function makeRoom(includeFiles: boolean, protect: string | undefined, removed: string[]) {
  let est = await estimateBackup(includeFiles)
  while (!est.ok) {
    // newest first: the newest stays, the oldest of the rest goes
    const victim = (await listBackups()).slice(1).reverse().find(b => b.name !== protect)
    if (!victim) {
      throw new HttpError(507, 'backup.no-space', { needed: sizeText(est.needed), free: sizeText(est.free ?? 0), neededBytes: est.needed, freeBytes: est.free ?? 0 })
    }
    rmSync(join(config.backupDir, victim.name), { force: true })
    removed.push(victim.name)
    audit({ user: 'system', ip: '-', action: 'backup-delete', target: victim.name, detail: 'ลบอัตโนมัติ: พื้นที่ว่างไม่พอสำหรับไฟล์สำรองใหม่' })
    log.warn('backup-pruned-for-space', { name: victim.name, needed: est.needed, free: est.free })
    est = await estimateBackup(includeFiles)
  }
}

/** called as the zip reads files: every `checkEvery` bytes the free space is looked at, and a backup that would fill the disk stops */
function spaceWatch() {
  let read = 0
  let next = backupLimits.checkEvery
  return (n: number) => {
    read += n
    if (read < next) return
    next = read + backupLimits.checkEvery
    const free = backupDeps.free(config.backupDir)
    if (free !== null && free < backupLimits.margin) {
      throw new HttpError(507, 'backup.aborted-no-space', { free: sizeText(free), freeBytes: free })
    }
  }
}

/** prune keeps `protect` even when it is among the oldest (the backup a restore is about to read) */
async function writeBackup(protect?: string): Promise<BackupItem> {
  const attempt = new Date().toISOString()
  /** old backups deleted to make room for this one */
  const removed: string[] = []
  try {
    mkdirSync(config.backupDir, { recursive: true })
    // left over from a backup that was cut off (crash, power loss)
    for (const n of readdirSync(config.backupDir)) if (n.endsWith('.partial')) rmSync(join(config.backupDir, n), { force: true })
    // what the zip reads is the files on disk: changes still waiting in a store go in first
    await JsonStore.flushAll()
    const prefs = effectiveBackup()
    await makeRoom(prefs.includeFiles, protect, removed)
    // names have one-second precision: a taken name moves on to the next free second instead of waiting for it
    let at = Date.now()
    while (existsSync(join(config.backupDir, nameFor(new Date(at)))) || existsSync(join(config.backupDir, `${nameFor(new Date(at))}.partial`))) at += 1000
    const name = nameFor(new Date(at))
    const items = collectItems(prefs.includeFiles)
    if (prefs.includeFiles) ensureSpace(config.backupDir, items.reduce((sum, i) => sum + i.size, 0))
    // backup.json goes last and is made when the zip gets there, so it can tell the sizes of everything before it
    const parts = emptyParts()
    for (const i of items) if (!i.dir) { parts[partOf(i.name)].files++; parts[partOf(i.name)].size += i.size }
    const meta = () => new TextEncoder().encode(JSON.stringify({
      version: config.version, createdAt: attempt, includesFiles: prefs.includeFiles, compression: prefs.compression, level: COMPRESSION_LEVELS[prefs.compression], parts,
    }, null, 2))
    items.push({ name: 'backup.json', abs: '', dir: false, mtime: Date.now(), size: meta().length, bytes: meta })

    const target = join(config.backupDir, name)
    // a half-written backup must never look complete: only a finished one gets the .zip name
    const partial = `${target}.partial`
    try {
      await Bun.write(partial, new Response(zipStream(items, {
        level: COMPRESSION_LEVELS[prefs.compression],
        onRead: spaceWatch(),
        onEntry: (item, sizes) => {
          if (item.name === 'backup.json') return
          // the sizes read are what really went in: a file that grew or shrank while it was read is counted as it was
          parts[partOf(item.name)].compressed += sizes.compressed
        },
      })))
      renameSync(partial, target)
    } catch (err) {
      rmSync(partial, { force: true })
      throw err
    }

    // only now, with the new backup complete, do the oldest beyond `keep` go
    for (const old of (await listBackups()).slice(prefs.keep)) {
      if (old.name !== protect) rmSync(join(config.backupDir, old.name), { force: true })
    }
    const size = statSync(target).size
    writeStatus({ status: 'ok', lastSuccess: attempt, lastAttempt: attempt, code: 'backup.done', params: {}, file: name, size })
    return { name, size, createdAt: attempt, parts: JSON.parse(JSON.stringify(parts)) }
  } catch (err) {
    const known = fromFsError(err)
    const why = known?.message ?? (err as Error).message
    log.error('backup-failed', err instanceof HttpError ? why : err)
    // not enough room is its own status: the page says how much was needed and how much was free
    const noSpace = err instanceof HttpError && (err.code === 'backup.no-space' || err.code === 'backup.aborted-no-space') ? err : null
    // a known reason (disk full...) is shown in the reader's language too; anything else as it was said
    const params: Params = noSpace ? noSpace.params : known && !Object.keys(known.params).length ? { reason: why, reasonCode: known.code } : { reason: why }
    const code: MessageCode = noSpace ? noSpace.code : 'backup.failed'
    writeStatus({ status: 'failed', lastSuccess: readStatus()?.lastSuccess ?? null, lastAttempt: attempt, code, params, file: null, size: null })
    alert('backup-failed', code, params)
    // the old copies went to make room and the new one is not there: the admin must know there are fewer than before
    if (removed.length) {
      log.error('backup-failed-after-pruning', { removed })
      // the admins' bell (and LINE group), not a second webhook message: the failure alert above is already on its way
      mirrorAlert('backup-pruned', 'backup.pruned-then-failed', { count: removed.length, names: removed.join(', ') })
    }
    throw err
  }
}

export const runBackup = () => exclusive(() => writeBackup())

/** only users.json, settings.json and branding/<file> come out of the zip; everything else in it is ignored */
async function extractData(zipAbs: string, dest: string) {
  const reader = new ZipReader(new BlobReader(Bun.file(zipAbs)))
  try {
    let total = 0
    for (const entry of await reader.getEntries()) {
      if (entry.directory) continue
      const parts = entry.filename.split('/')
      const wanted = (parts.length === 1 && (parts[0] === 'users.json' || parts[0] === 'settings.json')) ||
        (parts.length === 2 && parts[0] === 'branding' && parts[1] !== '' && cleanName(parts[1]) === parts[1])
      if (!wanted) continue
      const target = join(dest, ...parts)
      mkdirSync(dirname(target), { recursive: true })
      const fd = openSync(target, 'wx')
      try {
        await entry.getData(new WritableStream<Uint8Array>({
          write(chunk) {
            total += chunk.length
            if (total > RESTORE_MAX_BYTES) throw bad('backup.too-big')
            for (let at = 0; at < chunk.length;) at += writeSync(fd, chunk, at)
          },
        }), { checkSignature: true })
      } finally {
        closeSync(fd)
      }
    }
  } catch (err) {
    throw fromFsError(err) ?? bad('backup.unreadable')
  } finally {
    await reader.close().catch(() => {})
  }
}

/** a restore that leaves nobody able to log in as admin would lock everyone out */
function checkData(dir: string) {
  const parse = (file: string) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined } }
  const users = parse(join(dir, 'users.json'))?.users
  const admins = Array.isArray(users) ? users.filter(u => u?.role === 'admin' && typeof u.username === 'string' && typeof u.passwordHash === 'string') : []
  if (!admins.length) throw bad('backup.no-admin')
  if (existsSync(join(dir, 'settings.json'))) {
    const s = parse(join(dir, 'settings.json'))
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw bad('backup.bad-settings')
  }
}

/**
 * Put back the users, settings and logo of a backup. The current state is backed up first, so a wrong restore
 * can itself be undone. The caller restarts the app afterwards: the stores in memory still hold the old data.
 */
export function restoreBackup(name: string): Promise<{ safety: BackupItem }> {
  return exclusive(async () => {
    const zipAbs = backupPath(name)
    const safety = await writeBackup(name)
    const work = mkdtempSync(join(paths.tmp, 'restore-'))
    try {
      await extractData(zipAbs, work)
      checkData(work)
      // let queued writes land first, then nothing in memory may overwrite the restored files before the restart
      await JsonStore.flushAll()
      JsonStore.freeze()
      try {
        renameSync(join(work, 'users.json'), paths.users)
        if (existsSync(join(work, 'settings.json'))) renameSync(join(work, 'settings.json'), paths.settings)
        const branding = join(work, 'branding')
        mkdirSync(branding, { recursive: true })
        if (existsSync(paths.branding)) renameSync(paths.branding, join(work, 'old-branding'))
        renameSync(branding, paths.branding)
      } catch (err) {
        // the stores no longer save: start again from whatever is on disk now (the safety backup has the rest)
        restartSoon()
        throw err
      }
    } catch (err) {
      // the admin sees the message once; the log keeps it for whoever looks into it later
      ;(err instanceof HttpError ? log.warn : log.error)('backup-restore-failed', { name, error: err })
      throw err
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
    return { safety }
  })
}
