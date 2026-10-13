/**
 * Logs for admins, so nobody has to log into the server to see what went wrong: the system log page by page,
 * every log as one zip, and the activity log as CSV for Excel.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Elysia, t } from 'elysia'
import { audit, auditEntries, auditMatcher, type AuditEntry } from '../audit'
import { paths } from '../config'
import { context, requireAdmin } from '../context'
import { bad } from '../fsx'
import { LOG_LEVELS, queryLogs, type LogLevel } from '../logger'
import { zipStream, type ZipItem } from '../zip'

const pad = (n: number) => String(n).padStart(2, '0')
/** local time, like the names of backups */
const stamp = (d = new Date()) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

// the system, launcher and activity logs with their rotated files; access.log stays out (big, and only traffic)
const ZIPPED = /^(system|launcher|audit)\.log(\.\d+)?$/

function logFiles(): ZipItem[] {
  const out: ZipItem[] = []
  for (const name of readdirSync(paths.logs).filter(n => ZIPPED.test(n)).sort()) {
    const abs = join(paths.logs, name)
    try {
      const st = statSync(abs)
      if (st.isFile()) out.push({ name, abs, dir: false, mtime: st.mtimeMs, size: st.size })
    } catch { /* rotated away just now */ }
  }
  return out
}

/** Excel runs a cell that starts with = + - @ (or a tab or CR) as a formula; a leading ' keeps it text */
function csvCell(v: unknown): string {
  let s = v === undefined || v === null ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return `"${s.replaceAll('"', '""')}"`
}
const csvLine = (cells: unknown[]) => cells.map(csvCell).join(',') + '\r\n'
const CSV_HEAD = ['เวลา', 'ผู้ใช้', 'IP', 'การกระทำ', 'รายการ', 'รายละเอียด']

/** the matching entries, newest first, a few hundred at a time so a big log does not sit in memory as text */
function csvStream(rows: Iterator<AuditEntry>, match: (r: AuditEntry) => boolean): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  // the BOM tells Excel the file is UTF-8, otherwise Thai comes out garbled
  let pending = '﻿' + csvLine(CSV_HEAD)
  return new ReadableStream({
    pull(ctrl) {
      for (let n = 0; n < 500; n++) {
        const r = rows.next()
        if (r.done) {
          if (pending) ctrl.enqueue(enc.encode(pending))
          ctrl.close()
          return
        }
        const e = r.value
        if (match(e)) pending += csvLine([e.ts, e.user, e.ip, e.action, e.target, e.detail])
      }
      ctrl.enqueue(enc.encode(pending))
      pending = ''
    },
  })
}

export const logRoutes = new Elysia({ prefix: '/api/admin' })
  .use(context)

  .get('/logs', {
    query: t.Object({
      level: t.Optional(t.String()), q: t.Optional(t.String()), page: t.Optional(t.String()), pageSize: t.Optional(t.String()),
    }),
  }, ({ user, ip, query }) => {
    requireAdmin({ user, ip })
    const level = query.level || undefined
    if (level && !LOG_LEVELS.includes(level as LogLevel)) throw bad('logs.bad-level')
    return queryLogs({
      level: level as LogLevel | undefined,
      q: query.q || undefined,
      page: Math.max(1, Number(query.page) || 1),
      pageSize: Math.min(200, Math.max(5, Number(query.pageSize) || 50)),
    })
  })

  .get('/logs/download', ({ user, ip }) => {
    const admin = requireAdmin({ user, ip })
    const name = `file-center-logs-${stamp()}.zip`
    audit({ user: admin.username, ip, action: 'logs-download', target: name })
    return new Response(zipStream(logFiles()), {
      headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' },
    })
  })

  // the same filters as the activity page
  .get('/activity/export', {
    query: t.Object({
      format: t.Optional(t.String()), user: t.Optional(t.String()), action: t.Optional(t.String()), q: t.Optional(t.String()),
    }),
  }, ({ user, ip, query }) => {
    const admin = requireAdmin({ user, ip })
    if ((query.format ?? 'csv') !== 'csv') throw bad('logs.csv-only')
    const filter = { user: query.user || undefined, action: query.action || undefined, q: query.q || undefined }
    const name = `file-center-activity-${stamp()}.csv`
    // the filters are left out: they came in the query string, and logs never keep those
    audit({ user: admin.username, ip, action: 'activity-export', target: name })
    return new Response(csvStream(auditEntries(), auditMatcher(filter)), {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' },
    })
  })
