/**
 * Backups of the system data: accounts and passwords, settings, logo and the activity log. Without them a dead
 * disk loses every account. One backup is one zip in config.backupDir:
 *
 *   users.json  settings.json  branding/  logs/audit.log  logs/system.log  backup.json  [storage/ with BACKUP_INCLUDE_FILES=true]
 *
 * Not in it: tmp/ and trash/ (temporary), app/ (installed updates), sessions.json (logins), rotated logs,
 * access.log and launcher.log, and the backup folder itself. Restoring puts back users.json, settings.json and branding/ only, never storage/.
 */
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
  writeFileSync, writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { BlobReader, ZipReader } from '@zip.js/zip.js'
import { config, paths } from './config'
import { bad, cleanName, conflict, ensureSpace, fromFsError, HttpError, notFound, within } from './fsx'
import { restartSoon } from './lifecycle'
import { log } from './logger'
import { type Lang, MESSAGES, type MessageCode, type Params, text } from './messages'
import { JsonStore } from './store'
import { collectZipItems, zipStream, type ZipItem } from './zip'

export const BACKUP_NAME_RE = /^file-center-backup-\d{8}-\d{6}\.zip$/

export type BackupItem = { name: string; size: number; createdAt: string }
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
const SKIP = new Set(['tmp', 'trash', 'app', 'sessions.json', 'backup-status.json', 'stats-cache.json'])
// of the logs only the current activity and system log go in: rotated ones, access.log and launcher.log stay out
const LOGS_KEPT = new Set(['logs/', 'logs/audit.log', 'logs/system.log'])
// users, settings and a logo are small: anything bigger in a backup is not ours
const RESTORE_MAX_BYTES = 64 * 1024 * 1024

const pad = (n: number) => String(n).padStart(2, '0')
/** local time, so the name matches the clock of the person reading it */
const nameFor = (d: Date) =>
  `file-center-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.zip`

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

/** newest first */
export function listBackups(): BackupItem[] {
  let names: string[]
  try { names = readdirSync(config.backupDir) } catch { return [] }
  const out: BackupItem[] = []
  for (const name of names.filter(n => BACKUP_NAME_RE.test(n)).sort().reverse()) {
    try { out.push({ name, size: statSync(join(config.backupDir, name)).size, createdAt: createdAtOf(name) }) } catch { /* just deleted */ }
  }
  return out
}

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

export function backupSettings() {
  const a = device(config.backupDir)
  return {
    dir: config.backupDir,
    keep: config.backupKeep,
    hour: config.backupHour,
    includesFiles: config.backupIncludeFiles,
    // a dead disk takes the backups on it along: the page warns about this
    sameDisk: a !== null && a === device(config.dataDir),
  }
}

/** the hourly housekeeping runs a backup once a day at BACKUP_HOUR, or whenever the last one is over 2 days old */
export function backupDue(now = new Date()): boolean {
  if (config.backupHour === null) return false
  const last = readStatus()?.lastSuccess
  const age = last ? now.getTime() - Date.parse(last) : Infinity
  return age > 48 * 3600_000 || (age > 20 * 3600_000 && now.getHours() === config.backupHour)
}

// one backup or restore at a time
let busy = false
export const backupRunning = () => busy

async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (busy) throw conflict('backup.busy')
  busy = true
  try { return await fn() } finally { busy = false }
}

function collectItems(): ZipItem[] {
  const names = readdirSync(config.dataDir).filter(n => !SKIP.has(n) && !n.endsWith('.tmp'))
  // the storage may sit inside the data folder: its files only go in with BACKUP_INCLUDE_FILES, under storage/
  const items = collectZipItems(config.dataDir, names)
    .filter(i => (!i.name.startsWith('logs/') || LOGS_KEPT.has(i.name)) && !within(config.storageDir, i.abs))
  if (config.backupIncludeFiles) {
    items.push({ name: 'storage/', abs: config.storageDir, dir: true, mtime: statSync(config.storageDir).mtimeMs, size: 0 })
    for (const i of collectZipItems(config.storageDir, readdirSync(config.storageDir))) {
      // the data folder may sit inside the storage: it is already in the backup, without sessions
      if (!within(config.dataDir, i.abs)) items.push({ ...i, name: `storage/${i.name}` })
    }
  }
  return items.filter(i => !within(config.backupDir, i.abs))
}

/** prune keeps `protect` even when it is among the oldest (the backup a restore is about to read) */
async function writeBackup(protect?: string): Promise<BackupItem> {
  const attempt = new Date().toISOString()
  try {
    mkdirSync(config.backupDir, { recursive: true })
    // left over from a backup that was cut off (crash, power loss)
    for (const n of readdirSync(config.backupDir)) if (n.endsWith('.partial')) rmSync(join(config.backupDir, n), { force: true })
    let name = nameFor(new Date())
    while (existsSync(join(config.backupDir, name))) {
      await Bun.sleep(200) // names have one-second precision
      name = nameFor(new Date())
    }
    const items = collectItems()
    if (config.backupIncludeFiles) ensureSpace(config.backupDir, items.reduce((sum, i) => sum + i.size, 0))
    const meta = join(paths.tmp, `${name}.json`)
    writeFileSync(meta, JSON.stringify({ version: config.version, createdAt: attempt, includesFiles: config.backupIncludeFiles }, null, 2))
    items.push({ name: 'backup.json', abs: meta, dir: false, mtime: Date.now(), size: statSync(meta).size })

    const target = join(config.backupDir, name)
    // a half-written backup must never look complete: only a finished one gets the .zip name
    const partial = `${target}.partial`
    try {
      await Bun.write(partial, new Response(zipStream(items)))
      renameSync(partial, target)
    } catch (err) {
      rmSync(partial, { force: true })
      throw err
    } finally {
      rmSync(meta, { force: true })
    }

    for (const old of listBackups().slice(config.backupKeep)) {
      if (old.name !== protect) rmSync(join(config.backupDir, old.name), { force: true })
    }
    const size = statSync(target).size
    writeStatus({ status: 'ok', lastSuccess: attempt, lastAttempt: attempt, code: 'backup.done', params: {}, file: name, size })
    return { name, size, createdAt: createdAtOf(name) }
  } catch (err) {
    const known = fromFsError(err)
    const why = known?.message ?? (err as Error).message
    log.error('backup-failed', err instanceof HttpError ? why : err)
    // a known reason (disk full...) is shown in the reader's language too; anything else as it was said
    const params: Params = known && !Object.keys(known.params).length ? { reason: why, reasonCode: known.code } : { reason: why }
    writeStatus({ status: 'failed', lastSuccess: readStatus()?.lastSuccess ?? null, lastAttempt: attempt, code: 'backup.failed', params, file: null, size: null })
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
