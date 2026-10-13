/**
 * Updates published on the web (UPDATE_SOURCE): "bun run release --push" puts each package with a latest.json in
 * the `updates` branch. The update page asks for it when an admin presses the button; in the background only
 * latest.json is read, once a day (lookForNewVersion), to tell the admin a newer version exists. Nothing is
 * downloaded or installed without an admin.
 *
 * A fetched package is only downloaded here: it then goes through exactly the staging of an uploaded one
 * (updater.ts), and installing it still needs the password and a valid signature.
 * The SHA-256 in latest.json catches a broken download; it can not tell who made the package, the signature does.
 */
import { randomBytes } from 'node:crypto'
import { open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { config, paths } from './config'
import { log } from './logger'
import { bad, conflict, ensureDir, ensureSpace, HttpError } from './fsx'
import { compareVersions, isBeta, isVersion, VERSION_PATTERN } from './release'
import { runningVersion, signatureRequired } from './updater'

/** how long and how much; tests make the timeouts shorter */
export const SOURCE_LIMITS = {
  latestBytes: 64 * 1024,
  latestTimeoutMs: 10_000,
  /** the package: no byte for this long, or the whole download longer than packageTimeoutMs, gives up */
  idleTimeoutMs: 30_000,
  packageTimeoutMs: 15 * 60_000,
}

/** plain name, no folders: it is appended to the source URL */
const PACKAGE_FILE = new RegExp(`^file-center-${VERSION_PATTERN}\\.zip$`)
const SHA256 = /^[a-f0-9]{64}$/
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export type Latest = { version: string; file: string; sha256: string; size: number; builtAt: string; notes: string; signed: boolean }

type Parsed = { value: string; base: string | null; shown: string | null; error: string | null }
let parsed: Parsed | undefined

/** the URL without user name and password, for the page and the log */
function withoutCredentials(u: URL): string {
  const copy = new URL(u.href)
  copy.username = ''
  copy.password = ''
  return copy.href.replace(/\/+$/, '')
}

/** UPDATE_SOURCE, checked once per value; `error` says why it is refused (for the startup log) */
export function sourceConfig(): Omit<Parsed, 'value'> {
  const value = config.updateSource
  if (parsed?.value !== value) {
    parsed = { value, base: null, shown: null, error: null }
    if (value) {
      let u: URL | null = null
      try { u = new URL(value) } catch { /* reported below */ }
      if (!u) parsed.error = 'อ่าน URL ไม่ได้'
      else if (!(u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname)))) {
        parsed.error = 'ต้องเป็น https:// (http:// ได้เฉพาะ 127.0.0.1 หรือ localhost)'
      } else if (u.search || u.hash) parsed.error = 'ต้องไม่มี ? หรือ #'
      else {
        parsed.base = u.href.replace(/\/+$/, '')
        parsed.shown = withoutCredentials(u)
      }
      // what the admin typed, minus a password, so the log says which value is wrong
      if (parsed.error) parsed.shown = u ? withoutCredentials(u) : null
    }
  }
  return { base: parsed.base, shown: parsed.shown, error: parsed.error }
}

/** a usable source and updates from the web turned on */
const activeBase = () => (config.webUpdate ? sourceConfig().base : null)

/** for GET /api/admin/update: whether the page shows the button, and where it fetches from */
export function sourceStatus() {
  const base = activeBase()
  return { enabled: base !== null, url: base ? sourceConfig().shown : null }
}

/**
 * GET with no redirects (a redirect could lead off https), cancelled after `timeoutMs`, or when no byte arrives for
 * `idleMs`. The body is handed over chunk by chunk and stops at `maxBytes` with `tooBig`.
 */
async function download(url: string, o: {
  timeoutMs: number; idleMs?: number; maxBytes: number; tooBig: HttpError; onChunk: (chunk: Uint8Array) => Promise<void> | void
}): Promise<number> {
  const abort = new AbortController()
  let timedOut = false
  let writeFailed = false
  const stop = () => { timedOut = true; abort.abort() }
  const total = setTimeout(stop, o.timeoutMs)
  let idle: ReturnType<typeof setTimeout> | undefined
  const awake = () => {
    if (!o.idleMs) return
    clearTimeout(idle)
    idle = setTimeout(stop, o.idleMs)
  }
  try {
    awake()
    const res = await fetch(url, { redirect: 'error', signal: abort.signal, headers: { accept: '*/*' } })
    if (!res.ok) {
      void res.body?.cancel().catch(() => {})
      throw new HttpError(502, 'update.source-status', { status: res.status })
    }
    if (Number(res.headers.get('content-length')) > o.maxBytes) {
      void res.body?.cancel().catch(() => {})
      throw o.tooBig
    }
    let bytes = 0
    if (res.body) {
      const reader = res.body.getReader()
      try {
        for (;;) {
          awake()
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.length
          if (bytes > o.maxBytes) throw o.tooBig
          try { await o.onChunk(value) } catch (e) { writeFailed = true; throw e }
        }
      } finally {
        reader.cancel().catch(() => {})
      }
    }
    return bytes
  } catch (e) {
    // our own disk (full, read-only) is not the source's fault: the error handler names it
    if (e instanceof HttpError || writeFailed) throw e
    if (timedOut) throw new HttpError(504, 'update.source-timeout')
    throw new HttpError(502, 'update.source-unreachable')
  } finally {
    clearTimeout(total)
    clearTimeout(idle)
  }
}

export type Channel = 'stable' | 'beta'
const CHANNEL_FILE: Record<Channel, string> = { stable: 'latest.json', beta: 'latest-beta.json' }

/**
 * <source>/latest.json (or latest-beta.json for the beta channel), checked field by field. latest.json must name a
 * stable version and latest-beta.json a -beta.N one: a file in the wrong place is not trusted.
 */
async function fetchLatest(base: string, channel: Channel = 'stable'): Promise<Latest> {
  const chunks: Uint8Array[] = []
  await download(`${base}/${CHANNEL_FILE[channel]}`, {
    timeoutMs: SOURCE_LIMITS.latestTimeoutMs,
    maxBytes: SOURCE_LIMITS.latestBytes,
    tooBig: new HttpError(502, 'update.source-latest-too-big'),
    onChunk: c => { chunks.push(c) },
  })
  let j: any
  try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { j = null }
  const optional = (v: unknown, type: string) => v === undefined || typeof v === type
  if (
    !j || typeof j !== 'object' || Array.isArray(j) || !isVersion(j.version) || typeof j.file !== 'string' ||
    typeof j.sha256 !== 'string' || !SHA256.test(j.sha256) || !Number.isSafeInteger(j.size) || j.size <= 0 ||
    (channel === 'beta') !== isBeta(j.version) ||
    !optional(j.builtAt, 'string') || !optional(j.notes, 'string') || !optional(j.signed, 'boolean')
  ) throw new HttpError(502, 'update.source-latest-invalid')
  return {
    version: j.version, file: j.file, sha256: j.sha256, size: j.size,
    builtAt: (j.builtAt ?? '').slice(0, 64), notes: (j.notes ?? '').slice(0, 2000), signed: j.signed === true,
  }
}

/**
 * The newest beta, or null when there is none worth offering: no latest-beta.json (a plain 404), one that can not be
 * read (logged, the stable answer must not fail because of it), or one not newer than `current` and `stable`.
 */
async function fetchOfferedBeta(base: string, current: string, stable: string): Promise<Latest | null> {
  try {
    const b = await fetchLatest(base, 'beta')
    return compareVersions(b.version, current) > 0 && compareVersions(b.version, stable) > 0 ? b : null
  } catch (e) {
    const missing = e instanceof HttpError && e.code === 'update.source-status' && e.params.status === 404
    if (!missing) log.warn('update-beta-check-failed', e instanceof HttpError ? e.message : e)
    return null
  }
}

/** GET /api/admin/update/check. `beta: false` (the daily look) leaves the beta channel alone: not even asked. */
export async function checkSource({ beta = true }: { beta?: boolean } = {}) {
  const base = activeBase()
  const current = runningVersion()
  if (!base) return { enabled: false, current, latest: null, newer: false, refused: false, beta: null }
  const l = await fetchLatest(base)
  const b = beta ? await fetchOfferedBeta(base, current, l.version) : null
  return {
    enabled: true,
    current,
    // a version latest.json calls unsigned would be refused (fetchPackage), so the page can say so before downloading
    latest: { version: l.version, notes: l.notes, size: l.size, signed: l.signed, builtAt: l.builtAt },
    refused: !l.signed && signatureRequired(),
    newer: compareVersions(l.version, current) > 0,
    // newer than the running version AND than the newest stable; only for an admin who asked (never announced)
    beta: b && { version: b.version, notes: b.notes, size: b.size, signed: b.signed, builtAt: b.builtAt },
  }
}

/** the newer version the last background look at latest.json found (memory only: the next start looks again) */
let announced: string | null = null

/**
 * The daily look at latest.json (alerts.ts schedules it): remembers a newer version for the dashboard and returns it,
 * or null. Only latest.json is read; nothing is downloaded. Throws like /check when the source can not be read.
 */
export async function lookForNewVersion(): Promise<string | null> {
  const c = await checkSource({ beta: false })
  announced = c.newer && c.latest ? c.latest.version : null
  return announced
}

/** a newer version than the running one, as the last background look found it (null once installed or with the source off) */
export const availableVersion = (): string | null =>
  announced && activeBase() && compareVersions(announced, runningVersion()) > 0 ? announced : null

/** one download at a time: a second click must not fetch the same 100 MB again */
let fetching = false

/**
 * Download the package latest.json names into the incoming folder and check it against its SHA-256 and size.
 * The caller stages it (the same path as an uploaded package) and deletes the file afterwards.
 */
export async function fetchPackage(channel: Channel = 'stable'): Promise<{ path: string; size: number; version: string }> {
  const base = activeBase()
  if (!base) throw conflict('update.source-off')
  if (fetching) throw conflict('update.busy')
  fetching = true
  try {
    const latest = await fetchLatest(base, channel).catch(e => {
      if (channel === 'beta' && e instanceof HttpError && e.code === 'update.source-status' && e.params.status === 404) throw bad('update.beta-none')
      throw e
    })
    if (!PACKAGE_FILE.test(latest.file)) throw new HttpError(502, 'update.source-bad-file')
    if (compareVersions(latest.version, runningVersion()) <= 0) {
      throw bad('update.source-not-newer', { version: latest.version, running: runningVersion() })
    }
    // a beta is only worth installing while it is ahead of the stable release too
    if (channel === 'beta') {
      const stable = await fetchLatest(base)
      if (compareVersions(latest.version, stable.version) <= 0) throw bad('update.source-not-newer', { version: latest.version, running: stable.version })
    }
    // latest.json says it is unsigned: do not download 100 MB to refuse it (the signature is checked again when staging)
    if (!latest.signed && signatureRequired()) throw bad('update.unsigned')
    const tooBig = new HttpError(413, 'update.too-big')
    if (latest.size > config.updateMaxSize) throw tooBig

    const dir = join(paths.app, 'incoming')
    ensureDir(dir)
    ensureSpace(dir, latest.size)
    const file = join(dir, `fetch-${randomBytes(8).toString('hex')}.zip`)
    const out = await open(file, 'wx', 0o600)
    const hash = new Bun.CryptoHasher('sha256')
    let ok = false
    try {
      // one byte over the size latest.json promised is enough to know it is the wrong file
      const mismatch = new HttpError(502, 'update.source-mismatch')
      const size = await download(`${base}/${latest.file}`, {
        timeoutMs: SOURCE_LIMITS.packageTimeoutMs,
        idleMs: SOURCE_LIMITS.idleTimeoutMs,
        maxBytes: latest.size,
        tooBig: mismatch,
        onChunk: async c => {
          hash.update(c)
          await out.write(c)
        },
      })
      if (size !== latest.size || hash.digest('hex') !== latest.sha256) throw mismatch
      ok = true
      return { path: file, size, version: latest.version }
    } finally {
      await out.close()
      if (!ok) await rm(file, { force: true })
    }
  } finally {
    fetching = false
  }
}
