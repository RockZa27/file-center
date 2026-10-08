import { appendFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { config, paths } from './config'

export type AuditEntry = {
  ts: string
  user: string
  ip: string
  action: string
  target?: string
  detail?: string
}

function rotateIfNeeded() {
  try {
    if (!existsSync(paths.audit) || statSync(paths.audit).size < config.auditMaxBytes) return
    const oldest = `${paths.audit}.${config.auditMaxFiles - 1}`
    if (existsSync(oldest)) unlinkSync(oldest)
    for (let i = config.auditMaxFiles - 2; i >= 1; i--) {
      const from = `${paths.audit}.${i}`
      if (existsSync(from)) renameSync(from, `${paths.audit}.${i + 1}`)
    }
    renameSync(paths.audit, `${paths.audit}.1`)
  } catch (err) {
    console.error('[audit] rotate failed', err)
  }
}

export function audit(entry: Omit<AuditEntry, 'ts'>) {
  try {
    rotateIfNeeded()
    appendFileSync(paths.audit, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch (err) {
    console.error('[audit] write failed', err)
  }
}

function readFileLines(file: string): AuditEntry[] {
  if (!existsSync(file)) return []
  const out: AuditEntry[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch { /* skip broken line */ }
  }
  return out
}

export type AuditQuery = { user?: string; action?: string; q?: string; page: number; pageSize: number }

/** newest first, reads the current file and as many rotated files as needed */
export function queryAudit({ user, action, q, page, pageSize }: AuditQuery) {
  const need = page * pageSize + 1
  let matched: AuditEntry[] = []
  const files = [paths.audit, ...Array.from({ length: config.auditMaxFiles - 1 }, (_, i) => `${paths.audit}.${i + 1}`)]
  const needle = q?.toLowerCase()
  for (const f of files) {
    const rows = readFileLines(f).reverse()
    for (const r of rows) {
      if (user && r.user !== user) continue
      if (action && r.action !== action) continue
      if (needle && !`${r.target ?? ''} ${r.detail ?? ''} ${r.user}`.toLowerCase().includes(needle)) continue
      matched.push(r)
    }
    if (matched.length >= need) break
  }
  const start = (page - 1) * pageSize
  return {
    items: matched.slice(start, start + pageSize),
    hasMore: matched.length > start + pageSize,
  }
}
