/**
 * Office documents (docx, xlsx, pptx ...) open in ONLYOFFICE Docs, a separate document server (docker compose profile
 * `office`). Off unless OFFICE_URL and OFFICE_JWT_SECRET (32+ characters) are set.
 *
 * The browser gets an editor config from POST /api/office/config and loads the editor from the document server. The
 * document server then talks to File Center by itself, without the user's cookie:
 * - it downloads the file from `document.url` (GET /api/office/file/:token)
 * - it reports and hands over saved versions at `editorConfig.callbackUrl` (POST /api/office/callback/:token)
 * Both URLs carry a token File Center signed (own key in DATA_DIR) that names one file, one user, view or edit, and
 * an expiry; every use checks the user's rights again. The document server proves itself with a JWT signed with
 * OFFICE_JWT_SECRET (ONLYOFFICE's own scheme), and the config the browser hands it is signed with the same secret,
 * so nobody can make it open another file or save with other rights.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { accessFor, findUser, type Space, type User } from './auth'
import { config, paths } from './config'
import { bad, ensureDir, ensureSpace, forbidden, HttpError, moveTree, normRel, notFound, resolveIn, storagePath } from './fsx'
import type { Lang } from './messages'
import { recordRecent } from './favorites'
import { holdNow, markStale, ownerOfPath, ready } from './quota'
import { indexTouched } from './search-index'
import { moveToTrash } from './trash'
import { reserveVersion } from './versions'

/** ONLYOFFICE edits these as they are; legacy binary formats (doc, xls, ppt) only open for reading */
export const OFFICE_EDIT = ['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.csv', '.txt']
export const OFFICE_VIEW = [...OFFICE_EDIT, '.doc', '.xls', '.ppt']
const DOCUMENT_TYPE: Record<string, 'word' | 'cell' | 'slide'> = {
  '.docx': 'word', '.odt': 'word', '.doc': 'word', '.txt': 'word',
  '.xlsx': 'cell', '.ods': 'cell', '.xls': 'cell', '.csv': 'cell',
  '.pptx': 'slide', '.odp': 'slide', '.ppt': 'slide',
}

/** how long the document server may take to hand over a saved file; tests make it shorter */
export const OFFICE_LIMITS = { downloadTimeoutMs: 120_000, tokenTtlMs: 24 * 3600_000 }
export const OFFICE_SECRET_MIN = 32
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

type Parsed = {
  value: string
  enabled: boolean
  /** OFFICE_URL without a trailing slash: where the browser loads the editor from */
  url: string | null
  /** where the document server reaches File Center (document.url, callbackUrl) */
  internalUrl: string | null
  /** where File Center fetches saved files from, and the origins a callback may name */
  serverUrl: string | null
  origins: string[]
  error: string | null
}
let parsed: Parsed | undefined

function baseUrl(value: string, name: string, browser: boolean): string {
  let u: URL
  try { u = new URL(value) } catch { throw new Error(`${name} อ่าน URL ไม่ได้`) }
  if (browser ? !(u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname))) : !/^https?:$/.test(u.protocol)) {
    throw new Error(browser ? `${name} ต้องเป็น https:// (http:// ได้เฉพาะ localhost)` : `${name} ต้องเป็น http:// หรือ https://`)
  }
  if (u.search || u.hash || u.username || u.password) throw new Error(`${name} ต้องไม่มี ? # หรือชื่อผู้ใช้/รหัสผ่าน`)
  return u.href.replace(/\/+$/, '')
}

/** the OFFICE_* settings, checked once per value; `error` says why the integration stays off (startup log) */
export function officeConfig(): Omit<Parsed, 'value'> {
  const value = JSON.stringify([config.officeUrl, config.officeInternalUrl, config.officeServerInternalUrl, config.officeJwtSecret])
  if (parsed?.value !== value) {
    parsed = { value, enabled: false, url: null, internalUrl: null, serverUrl: null, origins: [], error: null }
    if (config.officeUrl) {
      try {
        const url = baseUrl(config.officeUrl, 'OFFICE_URL', true)
        if (!config.officeInternalUrl) throw new Error('ต้องตั้ง OFFICE_INTERNAL_URL (ที่อยู่ที่ document server ใช้เรียก File Center)')
        const internalUrl = baseUrl(config.officeInternalUrl, 'OFFICE_INTERNAL_URL', false)
        const serverUrl = config.officeServerInternalUrl ? baseUrl(config.officeServerInternalUrl, 'OFFICE_SERVER_INTERNAL_URL', false) : url
        if (config.officeJwtSecret.length < OFFICE_SECRET_MIN) throw new Error(`ต้องตั้ง OFFICE_JWT_SECRET ยาวอย่างน้อย ${OFFICE_SECRET_MIN} ตัวอักษร`)
        const origins = [...new Set([new URL(url).origin, new URL(serverUrl).origin])]
        Object.assign(parsed, { enabled: true, url, internalUrl, serverUrl, origins })
      } catch (err) {
        parsed.error = (err as Error).message
      }
    }
  }
  const { value: _, ...rest } = parsed
  return rest
}

/** the origin the web page may load the editor from (CSP), or null when office editing is off */
export const officeOrigin = () => {
  const c = officeConfig()
  return c.enabled && c.url ? new URL(c.url).origin : null
}

/** for GET /api/session: whether the page shows the office button, and for which files */
export function officeClientConfig() {
  const enabled = officeConfig().enabled
  return { enabled, edit: enabled ? OFFICE_EDIT.map(e => e.slice(1)) : [], view: enabled ? OFFICE_VIEW.map(e => e.slice(1)) : [] }
}

/** the checked settings; 404 while office editing is off */
export function requireEnabled() {
  const c = officeConfig()
  if (!c.enabled) throw notFound('office.disabled')
  return c as { url: string; internalUrl: string; serverUrl: string; origins: string[] }
}

// ───────────── JWT (HS256), the scheme of ONLYOFFICE Docs ─────────────

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest()

export function signJwt(payload: object, secret: string): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  return `${head}.${body}.${b64url(hmac(secret, `${head}.${body}`))}`
}

/** the payload when `token` is an HS256 JWT signed with `secret` and not expired; null otherwise */
export function verifyJwt(token: unknown, secret: string): Record<string, unknown> | null {
  if (typeof token !== 'string' || token.length > 64 * 1024) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    // only HS256: "none" or another algorithm named by the sender is never taken
    const head = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    if (head?.alg !== 'HS256') return null
    const want = hmac(secret, `${parts[0]}.${parts[1]}`)
    const got = Buffer.from(parts[2], 'base64url')
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) return null
    if (typeof payload.nbf === 'number' && payload.nbf * 1000 > Date.now() + 60_000) return null
    return payload
  } catch {
    return null
  }
}

/** the JWT the document server sent in the Authorization header ("Bearer <jwt>"), verified; null when missing or wrong */
export function serverJwt(request: Request): Record<string, unknown> | null {
  const auth = request.headers.get('authorization') ?? ''
  const m = /^Bearer\s+(\S+)$/i.exec(auth.trim())
  return m ? verifyJwt(m[1], config.officeJwtSecret) : null
}

// ───────────── File Center's own tokens in document.url and callbackUrl ─────────────

export type OfficeMode = 'edit' | 'view'
/** s = space, p = path in that space, f = where that was in the storage, u = user, m = mode, e = expiry (ms) */
export type OfficeToken = { s: Space; p: string; f: string; u: string; m: OfficeMode; e: number }

let keyCache: Buffer | null = null
/** made on first use, readable by this account only; deleting it ends every link handed out so far */
function tokenKey(): Buffer {
  if (keyCache) return keyCache
  const file = paths.officeKey
  if (existsSync(file)) {
    const k = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64url')
    if (k.length >= 32) return (keyCache = k)
  }
  const k = randomBytes(32)
  writeFileSync(file, k.toString('base64url'), { mode: 0o600 })
  try { chmodSync(file, 0o600) } catch { /* Windows */ }
  return (keyCache = k)
}

export function makeToken(t: Omit<OfficeToken, 'e'>, ttlMs = OFFICE_LIMITS.tokenTtlMs): string {
  const body = b64url(JSON.stringify({ ...t, e: Date.now() + ttlMs }))
  return `${body}.${b64url(hmac(tokenKey(), `office.${body}`))}`
}

/** the token's content when File Center signed it and it has not run out; one 403 for everything else */
export function readToken(token: unknown): OfficeToken {
  const refuse = () => forbidden('office.bad-token')
  if (typeof token !== 'string' || token.length > 4096) throw refuse()
  const [body, mac, extra] = token.split('.')
  if (!body || !mac || extra !== undefined) throw refuse()
  const want = hmac(tokenKey(), `office.${body}`)
  const got = Buffer.from(mac, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw refuse()
  let t: OfficeToken
  try { t = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { throw refuse() }
  if (!t || typeof t.e !== 'number' || t.e <= Date.now()) throw refuse()
  if ((t.s !== 'home' && t.s !== 'public') || (t.m !== 'edit' && t.m !== 'view') || typeof t.u !== 'string' || typeof t.p !== 'string') throw refuse()
  return t
}

/**
 * the file a token names, if its user still exists, still holds `perms` in that space and the path still leads to
 * the same place in the storage (an admin may have moved the user's folder since) and is a plain file
 */
export function tokenFile(t: OfficeToken, perms: ('read' | 'download' | 'write')[]): { user: User; abs: string } {
  const user = findUser(t.u)
  const a = user ? accessFor(user, t.s) : null
  if (!user || !a || perms.some(p => !a.perms.has(p))) throw forbidden()
  const abs = resolveIn(a.root, normRel(t.p))
  if (storagePath(abs) !== t.f) throw notFound()
  let st
  try { st = lstatSync(abs) } catch { throw notFound() }
  if (!st.isFile()) throw notFound()
  return { user, abs }
}

// ───────────── the editor config ─────────────

/**
 * ONLYOFFICE keeps one editing session per document.key: it must change whenever the file changes (or the editor
 * would show an old version), and two different files must never share one. The storage path tells files apart
 * across spaces and users; signed with the own key, so a key can not be guessed from a path.
 */
export function documentKey(abs: string): string {
  const st = statSync(abs)
  return hmac(tokenKey(), `key.${storagePath(abs)}.${Math.round(st.mtimeMs)}.${st.size}`).toString('base64url').slice(0, 40)
}

/** POST /api/office/config: the answer for the page, `config.token` signed for the document server */
export function editorConfig(user: User, space: Space, rel: string, abs: string, mode: OfficeMode, lang: Lang) {
  const c = requireEnabled()
  const ext = extname(abs).toLowerCase()
  if (!(mode === 'edit' ? OFFICE_EDIT : OFFICE_VIEW).includes(ext)) throw bad('office.bad-type')
  const size = statSync(abs).size
  if (size > config.officeMaxSize) throw new HttpError(413, 'office.too-big', { mb: Math.floor(config.officeMaxSize / 1024 ** 2) })
  const token = makeToken({ s: space, p: rel, f: storagePath(abs), u: user.username, m: mode })
  const editor: Record<string, unknown> = {
    document: {
      fileType: ext.slice(1),
      key: documentKey(abs),
      title: basename(abs),
      url: `${c.internalUrl}/api/office/file/${token}`,
      permissions: { edit: mode === 'edit', download: true, print: true },
    },
    documentType: DOCUMENT_TYPE[ext],
    editorConfig: {
      // only an editor saves; a viewer has nothing to report back
      ...(mode === 'edit' ? { callbackUrl: `${c.internalUrl}/api/office/callback/${token}` } : {}),
      user: { id: user.username, name: user.name },
      lang,
      mode,
    },
  }
  editor.token = signJwt(editor, config.officeJwtSecret)
  return { apiUrl: `${c.url}/web-apps/apps/api/documents/api.js`, config: editor }
}

// ───────────── saving what the document server hands back ─────────────

/** the callback's data: the JWT payload is the trusted copy (the plain body is not signed) */
export function callbackData(body: unknown, request: Request): Record<string, unknown> | null {
  const inBody = body && typeof body === 'object' ? (body as Record<string, unknown>).token : undefined
  const decoded = inBody !== undefined ? verifyJwt(inBody, config.officeJwtSecret) : serverJwt(request)
  if (!decoded) return null
  // in the header ONLYOFFICE wraps the body as { payload: {...} }; in the body the token holds the fields themselves
  const inner = inBody === undefined && decoded.payload && typeof decoded.payload === 'object' ? decoded.payload : decoded
  return inner as Record<string, unknown>
}

/**
 * Where to fetch a saved file from: only the document server (OFFICE_URL or OFFICE_SERVER_INTERNAL_URL); a link
 * under the public OFFICE_URL is fetched through OFFICE_SERVER_INTERNAL_URL when that is set.
 */
export function savedFileUrl(raw: unknown): string | null {
  const c = requireEnabled()
  if (typeof raw !== 'string') return null
  let u: URL
  try { u = new URL(raw) } catch { return null }
  // http(s) only, on its own as well: Bun's fetch would read a file: URL from this machine
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (!c.origins.includes(u.origin) || u.username || u.password) return null
  const pub = new URL(c.url).origin
  const server = new URL(c.serverUrl)
  if (u.origin === pub && server.origin !== pub) {
    u.protocol = server.protocol
    u.host = server.host
  }
  return u.href
}

const tmpDir = () => paths.officeTmp

/** files a crash left in office-tmp are of no use once they are an hour old */
function cleanTmp() {
  try {
    for (const n of readdirSync(tmpDir())) {
      const p = join(tmpDir(), n)
      try { if (Date.now() - statSync(p).mtimeMs > 3600_000) rmSync(p, { force: true }) } catch { /* gone */ }
    }
  } catch { /* no folder yet */ }
}

/** fetch `url` into `file`: no redirects, at most OFFICE_MAX_SIZE bytes, given up after downloadTimeoutMs */
async function download(url: string, file: string): Promise<number> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), OFFICE_LIMITS.downloadTimeoutMs)
  const out = await open(file, 'wx', 0o644)
  try {
    const res = await fetch(url, { redirect: 'error', signal: abort.signal })
    if (!res.ok || !res.body) {
      void res.body?.cancel().catch(() => {})
      throw new Error(`document server answered HTTP ${res.status}`)
    }
    if (Number(res.headers.get('content-length')) > config.officeMaxSize) {
      void res.body.cancel().catch(() => {})
      throw new Error('saved file is bigger than OFFICE_MAX_SIZE')
    }
    let bytes = 0
    const reader = res.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.length
        if (bytes > config.officeMaxSize) throw new Error('saved file is bigger than OFFICE_MAX_SIZE')
        await out.write(value)
      }
    } finally {
      reader.cancel().catch(() => {})
    }
    return bytes
  } finally {
    clearTimeout(timer)
    await out.close()
  }
}

// one save per file at a time: a forced save and the final one may arrive close together
const saving = new Map<string, Promise<unknown>>()

/**
 * Status 2 / 6: fetch the new version, keep the current one as a version (it can be restored from there; in the trash
 * when versions are off) and put the new one in its place with a rename, so nobody ever reads half a file. Throws on any failure; the caller
 * answers { error: 1 }.
 */
export async function saveVersion(t: OfficeToken, data: Record<string, unknown>): Promise<{ user: User; abs: string; size: number }> {
  if (t.m !== 'edit') throw forbidden('office.bad-token')
  const { abs } = tokenFile(t, ['write'])
  const url = savedFileUrl(data.url)
  if (!url) throw bad('office.bad-url')
  // a file of another type under the old name would be unreadable (the document server converts back on its own)
  const ext = extname(abs).toLowerCase().slice(1)
  if (typeof data.filetype === 'string' && data.filetype.toLowerCase() !== ext) throw bad('office.bad-type')

  const prev = saving.get(abs) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(async () => {
    ensureDir(tmpDir())
    cleanTmp()
    const tmp = join(tmpDir(), `${Date.now()}-${randomBytes(6).toString('hex')}`)
    const stage = join(dirname(abs), `.${basename(abs)}.office-${randomBytes(6).toString('hex')}`)
    try {
      const size = await download(url, tmp)
      ensureSpace(dirname(abs), size)
      // the count is awaited before the rights are checked, so nothing awaits between that check and the reservation
      if (t.s === 'home') await ready(findUser(t.u))
      // the old content is kept as a version in DATA_DIR: it counts against the owner of the home the file is in
      const owner = ownerOfPath(abs)
      await ready(owner)
      // checked again after the download: rights or the file may have changed meanwhile
      const { user } = tokenFile(t, ['write'])
      // the old version is kept (or goes to the trash) outside the file: only the growth counts for the file itself
      const q = t.s === 'home' ? user : null
      const grow = size - lstatSync(abs).size
      // over the quota even after the oldest versions of this file went: refused, the current content stays
      const ticket = reserveVersion(owner, abs)
      let hold
      try { hold = holdNow(q, grow) } catch (err) { ticket?.release(); throw err }
      try {
        // next to the file first (a copy when DATA_DIR is on another disk), then one rename into place
        await moveTree(tmp, stage)
        if (ticket) await ticket.keepAsync('office', user.username)
        else await moveToTrash(abs, user.username)
        if (!ticket && existsSync(abs)) throw new HttpError(409, 'files.name-taken')
        await rename(stage, abs)
        indexTouched(abs)
      } catch (err) {
        hold.release()
        ticket?.release()
        if (q) markStale(q.username)
        throw err
      }
      hold.commit(grow)
      recordRecent(user, t.s, t.p)
      return { user, abs, size }
    } finally {
      await rm(tmp, { force: true }).catch(() => {})
      await rm(stage, { force: true }).catch(() => {})
    }
  })
  saving.set(abs, run)
  try {
    return await run
  } finally {
    if (saving.get(abs) === run) saving.delete(abs)
  }
}
