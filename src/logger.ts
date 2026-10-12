/**
 * The system log: what went wrong (and a few things that went right) while the app ran. Before it, errors only
 * went to stdout and were gone when the container was recreated; now each entry is also one JSON line in
 * logs/system.log, which admins read on the logs page and download as a zip.
 *
 * Nothing secret may end up here: passwords, cookies, CSRF tokens, download and share tokens in URLs and query strings are
 * cut out of every entry (scrub / clean below), on stdout too.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { config, paths } from './config'

export type LogLevel = 'info' | 'warn' | 'error'
export type LogEntry = { ts: string; level: LogLevel; event: string; detail?: unknown }
export const LOG_LEVELS: LogLevel[] = ['info', 'warn', 'error']

/**
 * file → file.1 → file.2 ... once `file` reaches maxBytes; maxFiles counts the current file, the oldest is
 * deleted. Shared by the audit, system, access and launcher logs. Throws; the caller decides what a failure means.
 */
export function rotateFile(file: string, maxBytes: number, maxFiles: number) {
  if (!existsSync(file) || statSync(file).size < maxBytes) return
  const oldest = `${file}.${maxFiles - 1}`
  if (existsSync(oldest)) unlinkSync(oldest)
  for (let i = maxFiles - 2; i >= 1; i--) {
    const from = `${file}.${i}`
    if (existsSync(from)) renameSync(from, `${file}.${i + 1}`)
  }
  renameSync(file, `${file}.1`)
}

/** rotate if needed, then append one line; never throws (a log must not take a request down with it) */
export function appendLine(file: string, line: string, maxBytes = config.logMaxBytes, maxFiles = config.logMaxFiles) {
  // not through log.error: a full disk would loop
  try { rotateFile(file, maxBytes, maxFiles) } catch (err) { console.error(`[log] rotate failed ${file}`, (err as Error).message) }
  try { appendFileSync(file, line + '\n') } catch (err) { console.error(`[log] write failed ${file}`, (err as Error).message) }
}

/** every JSON line of a log and its rotated files, newest first; reads a file only when the one before is used up */
export function* readNewestFirst<T>(file: string, maxFiles: number): Generator<T> {
  for (const f of [file, ...Array.from({ length: maxFiles - 1 }, (_, i) => `${file}.${i + 1}`)]) {
    if (!existsSync(f)) continue
    const lines = readFileSync(f, 'utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]) continue
      try { yield JSON.parse(lines[i]) as T } catch { /* skip broken line */ }
    }
  }
}

/** one page of the rows that match, and whether there is another */
export function pageOf<T>(rows: Iterable<T>, match: (r: T) => boolean, page: number, pageSize: number) {
  const start = (page - 1) * pageSize
  const items: T[] = []
  let seen = 0
  for (const r of rows) {
    if (!match(r)) continue
    if (seen++ < start) continue
    if (items.length === pageSize) return { items, hasMore: true }
    items.push(r)
  }
  return { items, hasMore: false }
}

// ───────────── keeping secrets out ─────────────

const SECRET_KEY = /pass|pwd|cookie|csrf|token|secret|authorization|^sid$|session_?id/i
const HIDDEN = '***'

/** remove what must never be written down from a piece of text */
export function scrub(s: string): string {
  return s
    // download links of a batch and upload ids work for whoever holds them
    .replace(/(\/api\/batch\/)[^/\s?#"'`]+/g, `$1${HIDDEN}`)
    .replace(/(\/api\/upload\/)[a-f0-9]{24}/g, `$1${HIDDEN}`)
    // share links too: the API (/api/s/<token>/...) and the page (/s/<token>, a 43-character token)
    .replace(/(\/api\/s\/)[^/\s?#"'`]+/g, `$1${HIDDEN}`)
    .replace(/(\/s\/)[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, `$1${HIDDEN}`)
    // query strings (paths, searches, names of files)
    .replace(/(\/[^\s?#"'`]*)\?[^\s#"'`]*/g, '$1')
    // "password": "...", x-csrf-token: ..., cookie: fc_sid=...
    .replace(/((?:pass\w*|pwd|csrf\w*|token|cookie|secret|authorization|fc_sid)["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi, `$1${HIDDEN}`)
}

/** the path of a request as it may be logged: no query string, no tokens */
export function safePath(url: string): string {
  let pathname: string
  try { pathname = new URL(url).pathname } catch { pathname = url.split(/[?#]/)[0] }
  return scrub(pathname)
}

/** a copy of `v` that is safe to write: secret-looking keys hidden, text scrubbed, errors turned into text */
export function clean(v: unknown, depth = 0): unknown {
  if (v instanceof Error) {
    const code = (v as NodeJS.ErrnoException).code
    return { message: scrub(v.message).slice(0, 2000), ...(code ? { code } : {}), stack: v.stack ? scrub(v.stack).slice(0, 4000) : undefined }
  }
  if (typeof v === 'string') return scrub(v).slice(0, 4000)
  if (v === null || typeof v !== 'object') return typeof v === 'bigint' || typeof v === 'function' || typeof v === 'symbol' ? String(v) : v
  if (depth > 4) return '[…]'
  if (Array.isArray(v)) return v.slice(0, 50).map(x => clean(x, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v).slice(0, 50)) out[k] = SECRET_KEY.test(k) ? HIDDEN : clean(x, depth + 1)
  return out
}

// ───────────── the logger ─────────────

function write(level: LogLevel, event: string, detail?: unknown) {
  const entry: LogEntry = { ts: new Date().toISOString(), level, event }
  if (detail !== undefined) entry.detail = clean(detail)
  const d = entry.detail as any
  const text = d === undefined ? '' : typeof d === 'string' ? d : d?.stack ?? JSON.stringify(d)
  ;(level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[${event}]`, text)
  appendLine(paths.systemLog, JSON.stringify(entry))
}

export const log = {
  info: (event: string, detail?: unknown) => write('info', event, detail),
  warn: (event: string, detail?: unknown) => write('warn', event, detail),
  error: (event: string, detail?: unknown) => write('error', event, detail),
}

export type LogQuery = { level?: LogLevel; q?: string; page: number; pageSize: number }

/** newest first, across the rotated files */
export function queryLogs({ level, q, page, pageSize }: LogQuery) {
  const needle = q?.toLowerCase()
  return pageOf(readNewestFirst<LogEntry>(paths.systemLog, config.logMaxFiles), e =>
    (!level || e.level === level) &&
    (!needle || `${e.event} ${typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail ?? '')}`.toLowerCase().includes(needle)),
  page, pageSize)
}

/** errors logged since `since` (ms); stops at the first older entry, the file is in time order */
export function errorsSince(since: number): number {
  let n = 0
  for (const e of readNewestFirst<LogEntry>(paths.systemLog, config.logMaxFiles)) {
    if (Date.parse(e.ts) < since) break
    if (e.level === 'error') n++
  }
  return n
}

/** one line per request in logs/access.log when ACCESS_LOG=true */
export function accessLine(r: { method: string; url: string; status: number; ms: number; ip: string; user: string | null }) {
  appendLine(paths.accessLog, JSON.stringify({
    ts: new Date().toISOString(), method: r.method, path: safePath(r.url), status: r.status, ms: Math.round(r.ms), ip: r.ip, user: r.user,
  }))
}
