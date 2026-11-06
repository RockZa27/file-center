/**
 * Retention for the logs that hold IP addresses and user names (audit.log, system.log, access.log, launcher.log).
 * Off by default (AUDIT_RETENTION_DAYS / LOG_RETENTION_DAYS = 0). A daily sweep, started from housekeeping(), deletes rotated
 * files with nothing newer than the cutoff and rewrites the files that straddle it.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, unlinkSync } from 'node:fs'
import { config, paths } from './config'
import { writeFileAtomic } from './fsx'
import { log } from './logger'

const DAY_MS = 24 * 60 * 60 * 1000

export type LogFamily = { name: string; file: string; maxFiles: number; days: number }
export type SweepCount = { name: string; lines: number; files: number }

/**
 * One file. A line is dropped only when it parses and its `ts` is a valid time before the cutoff. A line that does not
 * parse, or has no valid ts, is KEPT: what can not be dated is never deleted.
 * Returns the number of lines dropped and whether the file was deleted (every line gone, and it is not the current file).
 *
 * The current file is rewritten with no await between the read and the rename (writeFileAtomic is synchronous too) and
 * appendLine is synchronous, so in this process no line can be appended in between: nothing is lost. (We chose this over
 * rotating first, which would push still-valid history out of the last file.) launcher.log is also written by the launcher
 * process; there the window is the few milliseconds between the read and the rename.
 */
/** the time of a log line, or null when it can not be dated */
function lineTs(line: string): number | null {
  try {
    const ts = Date.parse((JSON.parse(line) as { ts?: unknown }).ts as string)
    return Number.isFinite(ts) ? ts : null
  } catch { return null }
}

/**
 * Lines are appended in time order, so a file whose FIRST line is dated inside the window has nothing to drop: it is
 * left alone after reading its head only. The daily sweep then parses just the one file that straddles the cutoff (and
 * deletes the old ones), not 100 MB of history each day.
 */
function firstLineNewer(file: string, cutoff: number): boolean {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(64 * 1024)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const text = buf.subarray(0, n).toString('utf8')
    const end = text.indexOf('\n')
    if (end < 0) return false
    const ts = lineTs(text.slice(0, end))
    return ts !== null && ts >= cutoff
  } finally { closeSync(fd) }
}

function sweepFile(file: string, cutoff: number, current: boolean): { lines: number; deleted: boolean } {
  if (firstLineNewer(file, cutoff)) return { lines: 0, deleted: false }
  const lines = readFileSync(file, 'utf8').split('\n')
  const kept: string[] = []
  let dropped = 0
  for (const line of lines) {
    if (!line) continue
    const ts = lineTs(line)
    // not JSON or no valid ts: kept
    if (ts !== null && ts < cutoff) dropped++
    else kept.push(line)
  }
  if (!dropped) return { lines: 0, deleted: false }
  if (!kept.length && !current) { unlinkSync(file); return { lines: dropped, deleted: true } }
  writeFileAtomic(file, kept.length ? kept.join('\n') + '\n' : '') // temp file next to it, same mode, renamed over
  return { lines: dropped, deleted: false }
}

/**
 * Every family: the file and its rotated .1 … .N-1. Gaps in the numbering after a delete are fine: readNewestFirst skips
 * missing files and rotateFile only renames the ones that exist. A family with days <= 0 is left alone.
 * Never throws: a failure is a log.warn and the next file goes on.
 */
export function sweepFamilies(families: LogFamily[], now = Date.now()): SweepCount[] {
  const out: SweepCount[] = []
  for (const f of families) {
    if (!(f.days > 0)) continue
    const cutoff = now - f.days * DAY_MS
    const c: SweepCount = { name: f.name, lines: 0, files: 0 }
    for (let i = 0; i < f.maxFiles; i++) {
      const file = i === 0 ? f.file : `${f.file}.${i}`
      try {
        if (!existsSync(file)) continue
        const r = sweepFile(file, cutoff, i === 0)
        c.lines += r.lines
        if (r.deleted) c.files++
      } catch (err) {
        log.warn('log-retention-failed', { family: f.name, file: i === 0 ? 'current' : `.${i}`, error: (err as Error).message })
      }
    }
    if (c.lines || c.files) out.push(c)
  }
  return out
}

export const realFamilies = (): LogFamily[] => [
  { name: 'audit', file: paths.audit, maxFiles: config.auditMaxFiles, days: config.auditRetentionDays },
  { name: 'system', file: paths.systemLog, maxFiles: config.logMaxFiles, days: config.logRetentionDays },
  { name: 'access', file: paths.accessLog, maxFiles: config.logMaxFiles, days: config.logRetentionDays },
  { name: 'launcher', file: paths.launcherLog, maxFiles: config.logMaxFiles, days: config.logRetentionDays },
]

let lastRun = 0

/** for tests */
export function resetLogRetentionClock() { lastRun = 0 }

/**
 * Called from housekeeping() every hour; sweeps at most once a day (the first call, at start, runs). Returns null when it
 * did nothing because the last run was less than a day ago. Never throws. One log.info with the counts (no content).
 */
export function runLogRetention(now = Date.now(), families: LogFamily[] = realFamilies()): SweepCount[] | null {
  if (lastRun && now - lastRun < DAY_MS) return null
  lastRun = now
  try {
    const counts = sweepFamilies(families, now)
    if (counts.length) log.info('log-retention', counts.map(c => `${c.name}: ลบ ${c.lines} บรรทัด, ${c.files} ไฟล์`).join('; '))
    return counts
  } catch (err) {
    log.warn('log-retention-failed', err)
    return []
  }
}
