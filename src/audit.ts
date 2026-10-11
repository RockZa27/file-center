import { config, paths } from './config'
import { appendLine, pageOf, readNewestFirst } from './logger'

export type AuditEntry = {
  ts: string
  user: string
  ip: string
  action: string
  target?: string
  detail?: string
}

export function audit(entry: Omit<AuditEntry, 'ts'>) {
  appendLine(paths.audit, JSON.stringify({ ts: new Date().toISOString(), ...entry }), config.auditMaxBytes, config.auditMaxFiles)
}

export type AuditFilter = { user?: string; action?: string; q?: string }
export type AuditQuery = AuditFilter & { page: number; pageSize: number }

/** the filters of the activity page (and its CSV export) */
export function auditMatcher({ user, action, q }: AuditFilter) {
  const needle = q?.toLowerCase()
  return (r: AuditEntry) =>
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
