import { config, paths } from './config'
import { forwardAudit } from './audit-forward'
import { appendLine, pageOf, readNewestFirst } from './logger'

export type AuditEntry = {
  ts: string
  user: string
  ip: string
  action: string
  target?: string
  detail?: string
  /** `createdAt` of the account named in `user` when it was written: a later account of the same name is another person */
  born?: string
}

let bornOf: (name: string) => string | undefined = () => undefined
/** auth.ts tells how to find an account's `createdAt` (audit.ts can not import it: auth.ts imports this file) */
export const setBornOf = (fn: (name: string) => string | undefined) => { bornOf = fn }

export function audit(entry: Omit<AuditEntry, 'ts' | 'born'>) {
  const born = entry.user && entry.user !== 'guest' && !entry.user.startsWith('?') ? bornOf(entry.user) : undefined
  const full: AuditEntry = { ts: new Date().toISOString(), ...entry, ...(born ? { born } : {}) }
  appendLine(paths.audit, JSON.stringify(full), config.auditMaxBytes, config.auditMaxFiles)
  // a copy for the syslog server / webhook the admin may have set: queued, sent in the background, never throws
  forwardAudit(full)
}

export type AuditFilter = { user?: string; action?: string; q?: string; /** a further test every entry must pass */ only?: (r: AuditEntry) => boolean }
export type AuditQuery = AuditFilter & { page: number; pageSize: number }

/** the filters of the activity page (and its CSV export) */
export function auditMatcher({ user, action, q, only }: AuditFilter) {
  const needle = q?.toLowerCase()
  return (r: AuditEntry) =>
    (!only || only(r)) &&
    (!user || r.user === user) &&
    (!action || r.action === action) &&
    (!needle || `${r.target ?? ''} ${r.detail ?? ''} ${r.user}`.toLowerCase().includes(needle))
}

/** every entry, newest first, across the current file and the rotated ones */
export const auditEntries = () => readNewestFirst<AuditEntry>(paths.audit, config.auditMaxFiles)

/** newest first, reads the current file and as many rotated files as needed */
export function queryAudit({ page, pageSize, ...filter }: AuditQuery) {
  return pageOf(auditEntries(), auditMatcher(filter), page, pageSize)
}

// One line per key and minute: browsing a managed user's folders must be on the trail without a click flooding it
const ONCE_MS = 60_000
const ONCE_MAX = 5000
const onceLog = new Map<string, number>()

/** like audit(), but a repeat of the same key within a minute writes nothing */
export function auditOnce(key: string, entry: Omit<AuditEntry, 'ts'>) {
  const now = Date.now()
  const prev = onceLog.get(key)
  if (prev !== undefined && now - prev < ONCE_MS) return
  if (onceLog.size >= ONCE_MAX) for (const [k, v] of onceLog) if (now - v >= ONCE_MS) onceLog.delete(k)
  if (onceLog.size >= ONCE_MAX) onceLog.clear()
  onceLog.set(key, now)
  audit(entry)
}

/**
 * a download: a signed-in account's is always written; a visitor's (no account) once a minute per address, kind and
 * file, so anonymous requests can not fill the trail and push older entries out of its rotation
 */
export function auditDownload(entry: Omit<AuditEntry, 'ts'>) {
  if (entry.user !== 'guest') return audit(entry)
  auditOnce(`dl|${entry.action}|${entry.ip}|${entry.target ?? ''}|${entry.detail ?? ''}`, entry)
}
