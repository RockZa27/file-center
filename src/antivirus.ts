/**
 * Optional virus scanning with ClamAV, off by default (settings page or CLAMAV_*; see policy.antivirusValues).
 *
 * The scanner is clamd, reached over TCP with the INSTREAM command, written here directly (no library): the file is
 * streamed in chunks of at most CHUNK bytes, each prefixed by its length (4 bytes, big endian), ended by a zero
 * length, and clamd answers one line: "stream: OK", "stream: <Signature> FOUND" or "... ERROR". Every upload is scanned
 * once it is complete and before it becomes visible (uploads.ts, WebDAV PUT): a clean or allowed file goes on to the
 * storage, an infected one goes to the quarantine folder (paths.quarantine, under the system data, in no route's reach
 * except the admin's list) and never to the storage.
 *
 * Two separate decisions when a file is not scanned, each per sender. A file over the scan size: `onTooBigLinks` (default
 * reject: an anonymous sender must not get past the scan by padding a file) and `onTooBigUsers` (default allow, with a
 * `virus-scan-skipped` audit line). A scan that failed (clamd unreachable, a timeout, an ERROR answer): `onErrorLinks`
 * and `onErrorUsers`, both `reject` by default.
 * What clamd answers is never shown to the uploader; only the catalog message is. The signature name goes to the audit
 * trail and the admin alert.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, constants, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { basename, join } from 'node:path'
import { alert } from './alerts'
import { audit } from './audit'
import { config, paths } from './config'
import { bad, HttpError, notFound, renameNoReplace, storagePath, uniquePath, within } from './fsx'
import { indexTouched } from './search-index'
import { log } from './logger'
import * as policy from './policy'

/** bytes sent to clamd per INSTREAM chunk (clamd's own StreamMaxLength is the cap on the sum) */
const CHUNK = 64 * 1024

/** the EICAR test string: harmless, but every scanner reports it as a virus. Built from two parts so this source file is not itself flagged. */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'

export type ScanResult =
  | { status: 'clean' }
  | { status: 'infected'; signature: string }
  | { status: 'error'; reason: 'unreachable' | 'timeout' | 'too-big' | 'clamd-error' }
  | { status: 'off' }

/** where the file came from: decides the policy when it can not be scanned */
export type Audience = 'link' | 'user'

type Target = { host: string; port: number; timeoutMs: number }
const target = (): Target => {
  const v = policy.antivirusValues()
  return { host: v.host, port: v.port, timeoutMs: v.timeoutMs }
}

/** what clamd said last (memory only): the config warning and the admin page read it */
export const lastCheck: { at: string | null; ok: boolean | null; reason: string | null } = { at: null, ok: null, reason: null }
function remember(ok: boolean, reason: string | null) {
  lastCheck.at = new Date().toISOString()
  lastCheck.ok = ok
  lastCheck.reason = reason
}

/**
 * Talk to clamd: send `commands` then, when a `source` is given, the INSTREAM body; resolve with clamd's one-line answer.
 * The whole exchange (connect included) has one deadline.
 */
function exchange(t: Target, command: string, source?: AsyncIterable<Uint8Array>): Promise<string> {
  return new Promise((resolve, reject) => {
    let done = false
    let socket: Socket | undefined
    const finish = (err: Error | null, answer = '') => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket?.destroy()
      if (err) reject(err); else resolve(answer)
    }
    const timer = setTimeout(() => finish(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), Math.max(1, t.timeoutMs))
    try {
      socket = connect({ host: t.host, port: t.port })
    } catch (e) {
      return finish(e as Error)
    }
    const chunks: Buffer[] = []
    socket.on('error', e => finish(e))
    socket.on('data', (d: Buffer) => {
      chunks.push(d)
      // an answer ends with a NUL (command prefixed with z); a runaway answer is cut
      if (d.includes(0) || Buffer.concat(chunks).length > 4096) finish(null, Buffer.concat(chunks).toString('utf8').replace(/\0.*$/s, '').trim().slice(0, 1000))
    })
    socket.on('close', () => finish(chunks.length ? null : Object.assign(new Error('closed'), { code: 'ECONNRESET' }), Buffer.concat(chunks).toString('utf8').replace(/\0.*$/s, '').trim().slice(0, 1000)))
    socket.on('connect', () => {
      void (async () => {
        try {
          await write(socket!, Buffer.from(`z${command}\0`))
          if (source) {
            for await (const part of source) {
              for (let off = 0; off < part.byteLength; off += CHUNK) {
                const piece = part.subarray(off, Math.min(part.byteLength, off + CHUNK))
                const head = Buffer.alloc(4)
                head.writeUInt32BE(piece.byteLength)
                await write(socket!, head)
                await write(socket!, piece)
              }
            }
            await write(socket!, Buffer.alloc(4))
          }
        } catch (e) {
          // clamd closes the connection when it has seen enough (size limit): its answer, if any, is read from 'data'
          if (!done && !chunks.length) finish(e as Error)
        }
      })()
    })
  })
}

const write = (s: Socket, b: Uint8Array) =>
  new Promise<void>((resolve, reject) => {
    if (s.destroyed) return reject(new Error('closed'))
    s.write(b, e => (e ? reject(e) : resolve()))
  })

async function* fileChunks(file: string): AsyncGenerator<Uint8Array> {
  for await (const c of createReadStream(file, { highWaterMark: CHUNK * 4 })) yield c as Buffer
}

/** one answer line of clamd as a result */
export function parseAnswer(answer: string): ScanResult {
  const line = answer.trim()
  if (/^stream: OK$/i.test(line)) return { status: 'clean' }
  const found = line.match(/^stream: (.{1,200}) FOUND$/i)
  if (found) return { status: 'infected', signature: found[1].replace(/[^\w.\-/ ]/g, '?') }
  return { status: 'error', reason: 'clamd-error' }
}

export const antivirusOn = () => policy.antivirusValues().enabled

/** scan a file on disk; never throws */
export async function scanFile(file: string): Promise<ScanResult> {
  const v = policy.antivirusValues()
  if (!v.enabled) return { status: 'off' }
  let size = 0
  try { size = statSync(file).size } catch { return { status: 'error', reason: 'clamd-error' } }
  if (size > v.maxScanBytes) return { status: 'error', reason: 'too-big' }
  try {
    const answer = await exchange(target(), 'INSTREAM', fileChunks(file))
    const r = parseAnswer(answer)
    remember(true, null)
    if (r.status === 'error') log.warn('antivirus-error', { answer: answer.slice(0, 200) })
    return r
  } catch (e: any) {
    const timeout = e?.code === 'TIMEOUT'
    remember(false, timeout ? 'timeout' : 'unreachable')
    log.warn('antivirus-unreachable', { reason: timeout ? 'timeout' : String(e?.code ?? e?.message ?? e).slice(0, 100) })
    return { status: 'error', reason: timeout ? 'timeout' : 'unreachable' }
  }
}

/** PING: is clamd answering? (used by the test button and the background check) */
export async function pingClamd(): Promise<{ ok: boolean; reason?: 'unreachable' | 'timeout' | 'clamd-error' }> {
  try {
    const answer = await exchange(target(), 'PING')
    const ok = answer === 'PONG'
    remember(ok, ok ? null : 'clamd-error')
    return ok ? { ok } : { ok, reason: 'clamd-error' }
  } catch (e: any) {
    const reason = e?.code === 'TIMEOUT' ? 'timeout' : 'unreachable'
    remember(false, reason)
    return { ok: false, reason }
  }
}

/**
 * The admin's "test connection": the EICAR string through the same INSTREAM path a real upload takes. `detected` says
 * clamd found it, which proves the scanner is reached and has signatures loaded.
 */
export async function testConnection(): Promise<{ ok: boolean; detected: boolean; signature?: string; reason?: string }> {
  const t = target()
  try {
    const answer = await exchange(t, 'INSTREAM', (async function* () { yield Buffer.from(EICAR) })())
    const r = parseAnswer(answer)
    remember(true, null)
    if (r.status === 'infected') return { ok: true, detected: true, signature: r.signature }
    return { ok: r.status === 'clean' ? true : false, detected: false, reason: r.status === 'clean' ? 'not-detected' : 'clamd-error' }
  } catch (e: any) {
    const reason = e?.code === 'TIMEOUT' ? 'timeout' : 'unreachable'
    remember(false, reason)
    return { ok: false, detected: false, reason }
  }
}

/** what to do with a file given the scan and who sent it: 'allow' (store it), or 'infected' / 'rejected' (do not) */
export function verdict(r: ScanResult, who: Audience): 'allow' | 'infected' | 'rejected' {
  if (r.status === 'infected') return 'infected'
  if (r.status !== 'error') return 'allow'
  const v = policy.antivirusValues()
  if (r.reason === 'too-big') return (who === 'link' ? v.onTooBigLinks : v.onTooBigUsers) === 'reject' ? 'rejected' : 'allow'
  return (who === 'link' ? v.onErrorLinks : v.onErrorUsers) === 'reject' ? 'rejected' : 'allow'
}

// ───────────── quarantine ─────────────

export type QuarantineMeta = {
  id: string
  /** the file's name as uploaded (never used as a path here) */
  name: string
  size: number
  signature: string
  /** who sent it: a user name, or `guest` / `share:<link id>` */
  by: string
  ip: string
  via: 'upload' | 'link' | 'webdav'
  at: string
  /** the folder it was meant for, as a path under the storage (storagePath form) */
  dest: string
}

const ID_RE = /^[a-f0-9]{24}$/
const dataOf = (id: string) => join(paths.quarantine, `${id}.bin`)
const metaOf = (id: string) => join(paths.quarantine, `${id}.json`)

/** move a scanned file into the quarantine (a rename, or a copy then removal across disks); the original is gone afterwards */
export async function quarantine(file: string, info: Omit<QuarantineMeta, 'id' | 'size' | 'at'>): Promise<QuarantineMeta> {
  mkdirSync(paths.quarantine, { recursive: true, mode: 0o700 })
  const id = randomBytes(12).toString('hex')
  const meta: QuarantineMeta = { ...info, id, size: statSync(file).size, at: new Date().toISOString() }
  try {
    renameSync(file, dataOf(id))
  } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e
    await copyFile(file, dataOf(id))
    rmSync(file, { force: true })
  }
  try { chmodSync(dataOf(id), 0o600) } catch { /* a disk without modes */ }
  writeFileSync(metaOf(id), JSON.stringify(meta), { mode: 0o600 })
  trimQuarantine()
  return meta
}

export function listQuarantine(): QuarantineMeta[] {
  let names: string[] = []
  try { names = readdirSync(paths.quarantine) } catch { return [] }
  const out: QuarantineMeta[] = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    try {
      const m = JSON.parse(readFileSync(join(paths.quarantine, n), 'utf8')) as QuarantineMeta
      if (ID_RE.test(m.id) && existsSync(dataOf(m.id))) out.push(m)
    } catch { /* not ours */ }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at))
}

function find(id: unknown): QuarantineMeta {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw notFound()
  const m = listQuarantine().find(x => x.id === id)
  if (!m) throw notFound()
  return m
}

export function deleteQuarantined(id: unknown): QuarantineMeta {
  const m = find(id)
  rmSync(dataOf(m.id), { force: true })
  rmSync(metaOf(m.id), { force: true })
  return m
}

/**
 * Put a quarantined file back where it was meant to go (the admin decided it is a false alarm). The folder must still
 * exist inside the storage; the name is made free like any upload's. The file is not scanned again.
 */
export async function releaseQuarantined(id: unknown): Promise<{ path: string; meta: QuarantineMeta }> {
  const m = find(id)
  const dir = join(config.storageDir, ...m.dest.split('/').filter(Boolean))
  let ok = false
  try { ok = within(config.storageDir, dir) && statSync(dir).isDirectory() } catch { /* gone */ }
  if (!ok) throw bad('antivirus.release-dest-gone')
  const name = basename(m.name.replace(/[\\/\0]/g, '_')) || 'file'
  let finalPath = uniquePath(join(dir, name))
  for (let tries = 0; ; tries++) {
    try {
      try {
        await renameNoReplace(dataOf(m.id), finalPath)
      } catch (err: any) {
        if (err?.code !== 'EXDEV') throw err
        await copyFile(dataOf(m.id), finalPath, constants.COPYFILE_EXCL)
        rmSync(dataOf(m.id), { force: true })
      }
      break
    } catch (err: any) {
      if (err?.code !== 'EEXIST' || tries >= 5) throw err
      finalPath = uniquePath(join(dir, name))
    }
  }
  rmSync(metaOf(m.id), { force: true })
  indexTouched(finalPath)
  return { path: finalPath, meta: m }
}

/** old entries and the oldest beyond the size cap go (hourly housekeeping, and after each new entry) */
export function trimQuarantine(now = Date.now()): number {
  const all = listQuarantine().sort((a, b) => a.at.localeCompare(b.at))
  let removed = 0
  let total = all.reduce((n, m) => n + m.size, 0)
  for (const m of all) {
    const old = now - Date.parse(m.at) > config.quarantineDays * 86_400_000
    const over = config.quarantineMaxBytes > 0 && total > config.quarantineMaxBytes
    if (!old && !over) continue
    rmSync(dataOf(m.id), { force: true })
    rmSync(metaOf(m.id), { force: true })
    total -= m.size
    removed++
  }
  return removed
}

// ───────────── the gate used by the entry points ─────────────

export type Origin = { who: Audience; via: QuarantineMeta['via']; by: string; ip: string; name: string; destDir: string }

/**
 * Scan `file` (a complete upload that is not in the storage yet) and decide. When it passes, returns and the caller goes on.
 * When it is infected the file is moved to the quarantine, the admins are told and the audit trail gets a line; then an
 * HttpError for the uploader is thrown. When it could not be scanned and the policy says reject, the file is left for the
 * caller to throw away and an HttpError is thrown too. Scanning off: nothing happens.
 */
export async function gate(file: string, o: Origin): Promise<void> {
  if (!antivirusOn()) return
  const r = await scanFile(file)
  const v = verdict(r, o.who)
  if (v === 'allow') {
    // an unscanned big file went in: leave a trace so the admin can see it
    if (r.status === 'error' && r.reason === 'too-big') {
      let size = 0
      try { size = statSync(file).size } catch { /* gone */ }
      audit({ user: o.by, ip: o.ip, action: 'virus-scan-skipped', target: storagePath(o.destDir), detail: `too-big: ${size} bytes > ${policy.antivirusValues().maxScanBytes} bytes: ${o.name.slice(0, 200)} (${o.via})` })
    }
    return
  }
  if (v === 'infected' && r.status === 'infected') {
    let meta: QuarantineMeta | null = null
    try {
      meta = await quarantine(file, { name: o.name, signature: r.signature, by: o.by, ip: o.ip, via: o.via, dest: storagePath(o.destDir) })
    } catch (e) {
      // the file must not stay where it can be stored: if it can not be held back, it is deleted
      log.error('quarantine-failed', e)
      rmSync(file, { force: true })
    }
    audit({
      user: o.by, ip: o.ip, action: 'virus-found', target: meta ? `quarantine:${meta.id}` : storagePath(o.destDir),
      detail: `${r.signature}: ${o.name.slice(0, 200)} (${o.via})`,
    })
    alert('virus-found', 'admin.alert-virus-found', { signature: r.signature, user: o.by, ip: o.ip, via: o.via })
    throw new HttpError(422, 'antivirus.infected')
  }
  // could not be scanned, and the policy for this sender says do not keep it
  audit({ user: o.by, ip: o.ip, action: 'virus-scan-failed', target: storagePath(o.destDir), detail: `${r.status === 'error' ? r.reason : ''}: ${o.name.slice(0, 200)} (${o.via})` })
  throw new HttpError(r.status === 'error' && r.reason === 'too-big' ? 413 : 503, r.status === 'error' && r.reason === 'too-big' ? 'antivirus.too-big' : 'antivirus.unavailable')
}

// ───────────── background check ─────────────

/** the warning is about the last answer: unknown (never asked) is not a warning */
export const antivirusUnreachable = () => antivirusOn() && lastCheck.ok === false

let timer: ReturnType<typeof setInterval> | undefined
/** a PING at start and every few minutes while scanning is on, so the dashboard warns before an upload finds out */
export function startAntivirusMonitor(everyMs = 5 * 60_000): () => void {
  const tick = async () => {
    if (!antivirusOn()) return
    const r = await pingClamd()
    if (!r.ok) log.warn('antivirus-unreachable', { reason: r.reason })
  }
  void tick()
  timer = setInterval(() => void tick(), everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
