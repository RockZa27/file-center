/**
 * WebDAV at /dav, so Windows (Map network drive), macOS Finder, iOS/Android file apps and rclone can use the files.
 *
 * How it differs from the API, on purpose:
 *  - It is answered from index.ts before routing, so none of the web page's machinery touches it: the fc_sid cookie
 *    is never read, and the CSRF check does not apply. CSRF is an attack on cookie sessions (a page in another tab makes
 *    the browser send the cookie along); a request here is signed in only by the `Authorization: Basic` header, which a
 *    browser sends for another site's page only after the user typed the password for this very address, and the
 *    password is an app password (app-passwords.ts) that opens WebDAV and nothing else.
 *  - Every path becomes (space, path inside it) and then goes through accessFor and resolveIn exactly like the API, so
 *    rights, links, quota, trash and versions behave the same. An app password with scope `read` loses write and upload.
 *
 * The tree:  /dav/home  /dav/public  /dav/shared/<folder name>  and whatever other modules register (registerDavFolder):
 * a space (registerDavSpace) is one folder holding that space, a folder (registerDavFolder) lists several, one per space.
 * User groups plug in with   registerDavFolder('groups', user => groupsOf(user).map(g => ({ name: g.name, space: `group:${g.id}` })))
 * (a folder with no entries is left out). The names inside a folder are made unique here with " (2)", " (3)": keep the
 * order of the entries stable so a name does not move to another entry when one is added.
 *
 * Locks (LOCK/UNLOCK) are handed out and remembered in memory (at most an hour) so that Windows Explorer, Finder and
 * Office, which refuse to write without them, work. They are not enforced against other clients: a lock is no promise
 * that nobody else writes to the file, and a restart forgets them all.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, type Stats } from 'node:fs'
import { copyFile, open } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { alert } from './alerts'
import { touchAppPassword, verifyAppPassword, type AppPassword, type AppScope } from './app-passwords'
import { audit, auditOnce } from './audit'
import { accessFor, clearFailures, lockedFor, recordFailure, reloadIfChangedByCli, USER_SPACE, type Access, type Lockout, type User } from './auth'
import { config, paths } from './config'
import * as policy from './policy'
import { clientIp } from './context'
import { moveState } from './favorites'
import {
  bad, conflict, copyTree, ensureSpace, forbidden, freeSpace, fromFsError, HttpError, isDir, moveTree, notFound, resolveIn,
  sameFile, storagePath, treeStats, validName, within,
} from './fsx'
import { activeGrantsTo, GRANT_SPACE } from './grants'
import { log, safePath } from './logger'
import { langOf, type MessageCode, type Params, text } from './messages'
import { exceeded, holdNow, limitOf, markStale, markStaleBetween, markStaleFor, ownerOfPath, quotaUserOf, ready, roomLeft, usage, type Hold } from './quota'
import { fileResponse, fileTag } from './routes/files'
import { indexTouched } from './search-index'
import type { Perm } from './settings'
import { etagMatches } from './static'
import { moveToTrash } from './trash'
import { moveVersions, reserveVersion } from './versions'
import { child, DAV_NS, esc, escAttr, parseXml, safeName, XML_HEAD, XML_MAX_BYTES, XmlError, type XNode } from './webdav-xml'

export const isDavPath = (pathname: string) => pathname === '/dav' || pathname.startsWith('/dav/')

// ───────────── what the tree holds ─────────────

export type DavEntry = { name: string; space: string }
const singles = new Map<string, (user: User) => string | null>()
const folders = new Map<string, (user: User) => DavEntry[]>()

/** /dav/<name> is one folder holding a space (null: this user has none, the folder is left out) */
export function registerDavSpace(name: string, spaceFor: (user: User) => string | null) {
  if (singles.has(name) || folders.has(name)) throw new Error(`/dav/${name} is taken`)
  singles.set(name, spaceFor)
}

/** /dav/<name> lists folders, one per entry, each holding that space (no entries: the folder is left out) */
export function registerDavFolder(name: string, entriesFor: (user: User) => DavEntry[]) {
  if (singles.has(name) || folders.has(name)) throw new Error(`/dav/${name} is taken`)
  folders.set(name, entriesFor)
}

registerDavSpace('home', () => 'home')
registerDavSpace('public', user => (accessFor(user, 'public') ? 'public' : null))
// the folders other people share with this user; the name is the folder's own
registerDavFolder('shared', user =>
  activeGrantsTo(user)
    .sort((a, b) => a.grant.createdAt.localeCompare(b.grant.createdAt) || a.grant.id.localeCompare(b.grant.id))
    .map(g => ({ name: basename(g.abs) || g.owner.username, space: `${GRANT_SPACE}${g.grant.id}` })))

/** the entries of a folder with names that are safe in a path and unique ("Photos", "Photos (2)") */
function entriesOf(fn: (user: User) => DavEntry[], user: User): DavEntry[] {
  const seen = new Set<string>()
  return fn(user).map(e => {
    // a name of only dots ("." and "..", from a group made before they were refused) would be a dot segment in an href
    const base = e.name.replace(/[\\/\u0000-\u001f]/g, '_').trim().replace(/^\.+$/, '_') || '_'
    let name = base
    for (let i = 2; seen.has(name); i++) name = `${base} (${i})`
    seen.add(name)
    return { name, space: e.space }
  })
}

// ───────────── answers ─────────────

const CHALLENGE = 'Basic realm="File Center", charset="UTF-8"'
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }
const ALLOW_READ = 'OPTIONS, PROPFIND, GET, HEAD'
const ALLOW_ALL = 'OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE, LOCK, UNLOCK'

function reply(request: Request, status: number, code?: MessageCode, params?: Params, headers: Record<string, string> = {}): Response {
  if (!code) return new Response(null, { status, headers: { ...BASE_HEADERS, ...headers } })
  return new Response(text(langOf(request), code, params), {
    status, headers: { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'X-Error-Code': code, ...headers },
  })
}

function failure(request: Request, err: unknown): Response {
  const known = fromFsError(err)
  if (known) {
    if (!(err instanceof HttpError)) log.warn('fs-error', { method: request.method, path: safePath(request.url), error: (err as Error).message.slice(0, 300) })
    return reply(request, known.status, known.code, known.params, known.status === 401 ? { 'WWW-Authenticate': CHALLENGE } : {})
  }
  log.error('request-failed', { method: request.method, path: safePath(request.url), error: err })
  return reply(request, 500, 'request.internal')
}

const XML_HEADERS = { ...BASE_HEADERS, 'Content-Type': 'application/xml; charset=utf-8' }
const xmlResponse = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(XML_HEAD + body, { status, headers: { ...XML_HEADERS, ...headers } })

// ───────────── signing in ─────────────

/** the same limits as the web login: a few wrong passwords from one address for one name, and a wider net per address */
const addressLimits = (): Lockout => ({ max: config.loginAddressMaxAttempts, lockMs: config.loginWideWindowMs, windowMs: config.loginWideWindowMs })

type Ctx = { request: Request; user: User; ip: string; scope: AppScope; item: AppPassword }

async function authenticate(request: Request, ip: string): Promise<Ctx | Response> {
  const challenge = (code: MessageCode) => reply(request, 401, code, {}, { 'WWW-Authenticate': CHALLENGE })
  const m = (request.headers.get('authorization') ?? '').match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i)
  if (!m) return challenge('auth.required')
  const raw = Buffer.from(m[1], 'base64').toString('utf8')
  const colon = raw.indexOf(':')
  const username = colon < 0 ? '' : raw.slice(0, colon).trim()
  const secret = colon < 0 ? '' : raw.slice(colon + 1)
  if (!username || username.length > 64 || secret.length > 200) return challenge('auth.bad-credentials')

  const userKey = `dav|${ip}|${username.toLowerCase()}`
  const addrKey = `dav-address|${ip}`
  // checked before the password: a right one does not skip the wait
  const wait = Math.max(lockedFor(userKey), lockedFor(addrKey))
  if (wait) return reply(request, 429, 'auth.locked', { seconds: wait }, { 'Retry-After': String(wait) })

  const found = await verifyAppPassword(username, secret)
  if (!found) {
    if (recordFailure(userKey)) alert('lockout', 'admin.alert-login-locked', { user: username, ip })
    if (recordFailure(addrKey, addressLimits())) alert('lockout', 'admin.alert-address-locked', { ip })
    auditOnce(`dav-login-failed|${userKey}`, { user: username, ip, action: 'login-failed', detail: 'WebDAV' })
    return challenge('auth.bad-credentials')
  }
  clearFailures(userKey)
  // an account that must change its password first may do nothing else, WebDAV included
  if (found.user.mustChangePassword) return reply(request, 403, 'must-change-password')
  // and one the 2FA rule says must turn on two-step sign-in first: an app password made before the rule does not skip it
  if (policy.mustSetup2fa(found.user)) return reply(request, 403, 'auth.2fa-required')
  touchAppPassword(found.item, ip)
  return { request, user: found.user, ip, scope: found.item.scope, item: found.item }
}

// ───────────── paths ─────────────

/** /dav/a/b%20c -> ['a', 'b c']. Decoded once; a name that holds "/", "\", NUL or is "." or ".." is refused. */
function parsePath(pathname: string): string[] {
  const rest = pathname.replace(/^\/dav(?:\/|$)/, '')
  const out: string[] = []
  for (const raw of rest.split('/')) {
    if (!raw) continue
    let seg: string
    try { seg = decodeURIComponent(raw) } catch { throw bad('fs.bad-path') }
    if (seg === '.' || seg === '..' || /[\\/\u0000]/.test(seg)) throw bad('fs.bad-path')
    out.push(seg)
  }
  return out
}

const encodeSeg = (s: string) => encodeURIComponent(s)
const hrefOf = (segs: string[], dir: boolean) => `/dav/${segs.map(encodeSeg).join('/')}${dir && segs.length ? '/' : ''}`

/** a space of a mount, with what this app password may do in it */
type Space = Access & {
  mount: string[]
  /** the path inside the space, and where it is on disk */
  rel: string
  abs: string
  /** what the account itself may do here (perms is that, less what the scope takes away) */
  full: Set<Perm>
}
type Place = { kind: 'root' } | { kind: 'folder'; name: string; entries: DavEntry[] } | ({ kind: 'space' } & Space)

function spaceFor(ctx: Ctx, space: string, mount: string[], inner: string[]): Space | null {
  // the staff view of someone's home is not a place for WebDAV
  if (space.startsWith(USER_SPACE)) return null
  const access = accessFor(ctx.user, space)
  if (!access) return null
  const perms = new Set(access.perms)
  if (ctx.scope === 'read') { perms.delete('write'); perms.delete('upload') }
  const rel = '/' + inner.join('/')
  return { ...access, perms, full: access.perms, mount, rel, abs: resolveIn(access.root, rel) }
}

function placeOf(ctx: Ctx, segs: string[]): Place | null {
  if (!segs.length) return { kind: 'root' }
  const [first, ...rest] = segs
  const single = singles.get(first)
  if (single) {
    const space = single(ctx.user)
    const s = space ? spaceFor(ctx, space, [first], rest) : null
    return s && { kind: 'space', ...s }
  }
  const folder = folders.get(first)
  if (!folder) return null
  const entries = entriesOf(folder, ctx.user)
  if (!entries.length) return null
  if (!rest.length) return { kind: 'folder', name: first, entries }
  const e = entries.find(x => x.name === rest[0])
  const s = e ? spaceFor(ctx, e.space, [first, e.name], rest.slice(1)) : null
  return s && { kind: 'space', ...s }
}

/** throws unless this app password may do all of these here */
function allow(s: Space, ...perms: Perm[]) {
  for (const p of perms) {
    if (!s.perms.has(p)) throw s.full.has(p) ? new HttpError(403, 'auth.dav-read-only') : forbidden()
  }
}

const spaceOnly = (p: Place | null): Space & { kind: 'space' } => {
  if (!p) throw notFound()
  if (p.kind !== 'space') throw new HttpError(403, 'files.dav-virtual')
  return p
}

/** where something is created: a space; the folders that only group (and a name at the top that is none) are not places to create in */
function writableSpace(p: Place | null, segs: string[]): Space & { kind: 'space' } {
  // a name directly under the root or under a grouping folder is a new entry of a folder we keep: not ours to make
  if (!p && segs.length > (folders.has(segs[0]) ? 2 : 1)) throw conflict('files.folder-not-found')
  if (!p || p.kind !== 'space') throw new HttpError(403, 'files.dav-virtual')
  return p
}

function statOf(abs: string): Stats | null {
  try { return statSync(abs) } catch { return null }
}
function lstatOf(abs: string): Stats | null {
  try { return lstatSync(abs) } catch { return null }
}

/** the public folder and the user folders can be copied from, but not deleted, moved or overwritten */
function guardSystemFolder(abs: string) {
  if (abs === paths.publicDir || abs === paths.usersDir) throw forbidden('files.system-folder')
}

async function readText(request: Request, max = XML_MAX_BYTES): Promise<string> {
  const length = Number(request.headers.get('content-length'))
  if (length > max) throw new HttpError(413, 'request.too-big')
  if (!request.body) return ''
  const reader = request.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) { await reader.cancel().catch(() => {}); throw new HttpError(413, 'request.too-big') }
    parts.push(value)
  }
  return Buffer.concat(parts).toString('utf8')
}

async function readXml(request: Request): Promise<XNode | null> {
  const body = await readText(request)
  if (!body.trim()) return null
  try { return parseXml(body) } catch (err) {
    if (err instanceof XmlError) throw bad('files.dav-bad-xml')
    throw err
  }
}

// ───────────── properties ─────────────

type Item = {
  segs: string[]
  name: string
  dir: boolean
  size: number
  mtime: number
  birth: number
  /** a folder that only groups others (the root, /shared): no lock, no quota */
  virtual: boolean
  space?: Space
}

const itemOf = (segs: string[], name: string, st: Stats | null, space?: Space): Item => ({
  segs, name, dir: !st || st.isDirectory(), size: st && !st.isDirectory() ? st.size : 0,
  mtime: st ? Math.floor(st.mtimeMs) : 0, birth: st && st.birthtimeMs > 0 ? Math.floor(st.birthtimeMs) : st ? Math.floor(st.mtimeMs) : 0,
  virtual: !space, space,
})

const LOCK_ENTRIES = '<D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>' +
  '<D:lockentry><D:lockscope><D:shared/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>'

type Quota = { used: number; available: number } | null
type Env = { user: User; quota: () => Quota; locksAt: (segs: string[]) => Lock[] }

const PROPS: Record<string, (it: Item, env: Env) => string | null> = {
  displayname: it => esc(it.name),
  resourcetype: it => (it.dir ? '<D:collection/>' : ''),
  getlastmodified: it => (it.mtime ? new Date(it.mtime).toUTCString() : null),
  creationdate: it => (it.birth ? new Date(it.birth).toISOString() : null),
  getcontentlength: it => (it.dir ? null : String(it.size)),
  getcontenttype: it => (it.dir ? 'httpd/unix-directory' : esc(Bun.file(it.name).type || 'application/octet-stream')),
  getetag: it => (it.virtual ? null : esc(fileTag({ size: it.size, mtimeMs: it.mtime }))),
  supportedlock: it => (it.virtual ? null : LOCK_ENTRIES),
  lockdiscovery: (it, env) => (it.virtual ? null : env.locksAt(it.segs).map(activeLock).join('')),
  'quota-used-bytes': (it, env) => (it.dir && it.space ? env.quota()?.used.toString() ?? null : null),
  'quota-available-bytes': (it, env) => (it.dir && it.space ? env.quota()?.available.toString() ?? null : null),
}
// what a request for "all properties" gets: the quota ones only when asked for by name (RFC 4331)
const ALL = ['displayname', 'resourcetype', 'getlastmodified', 'creationdate', 'getcontentlength', 'getcontenttype', 'getetag', 'supportedlock', 'lockdiscovery']

/**
 * a PROPFIND may name this many properties, and answers folders with fewer than config.davMaxItems entries (the answer
 * is items x properties: 100,000 items x 50 properties stays in the tens of MB, a photo folder of 20,000 still lists)
 */
export const PROPFIND_MAX_PROPS = 50
const tooMany = () => xmlResponse(507, '<D:error xmlns:D="DAV:"><D:number-of-matches-within-limits/></D:error>')

type Wanted = { ns: string; name: string }

function propstat(it: Item, wanted: Wanted[], env: Env, namesOnly: boolean, explicit: boolean): string {
  const ok: string[] = []
  const missing: string[] = []
  for (const w of wanted) {
    // own keys only: a property called __proto__, constructor or toString is simply unknown
    const def = w.ns === DAV_NS && Object.hasOwn(PROPS, w.name) ? PROPS[w.name] : undefined
    const value = def ? def(it, env) : null
    if (value === null) {
      // "all properties" lists what there is; only a name that was asked for can be answered with "not found"
      if (!explicit) continue
      // a name from the request is written back only when it is a plain name
      if (safeName(w.name)) missing.push(w.ns === DAV_NS ? `<D:${w.name}/>` : `<X:${w.name} xmlns:X="${escAttr(w.ns)}"/>`)
    } else ok.push(namesOnly || value === '' ? `<D:${w.name}/>` : `<D:${w.name}>${value}</D:${w.name}>`)
  }
  let out = ''
  if (ok.length) out += `<D:propstat><D:prop>${ok.join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`
  if (missing.length) out += `<D:propstat><D:prop>${missing.join('')}</D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>`
  return out
}

async function propfind(ctx: Ctx, segs: string[], place: Place | null): Promise<Response> {
  const { request, user } = ctx
  const depth = (request.headers.get('depth') ?? 'infinity').trim().toLowerCase()
  if (depth !== '0' && depth !== '1') {
    return xmlResponse(403, '<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>')
  }
  const doc = await readXml(request)
  let wanted: Wanted[] = ALL.map(name => ({ ns: DAV_NS, name }))
  let namesOnly = false
  let explicit = false
  if (doc) {
    if (doc.name !== 'propfind' || doc.ns !== DAV_NS) throw bad('files.dav-bad-xml')
    const prop = child(doc, 'prop')
    if (prop && prop.children.length > PROPFIND_MAX_PROPS) throw bad('files.dav-too-many-props', { max: PROPFIND_MAX_PROPS })
    // the same property asked for twice is answered once: 50 copies of a long name for every item of a big folder
    // would make the answer 50 times bigger for nothing
    if (prop) { wanted = [...new Map(prop.children.map(c => [`${c.ns} ${c.name}`, { ns: c.ns, name: c.name }])).values()]; explicit = true }
    else if (child(doc, 'propname')) { wanted = Object.keys(PROPS).map(name => ({ ns: DAV_NS, name })); namesOnly = true }
  }
  if (!place) throw notFound()

  const items: Item[] = []
  const mountItem = (s: Space, name: string, mountSegs: string[]) => itemOf(mountSegs, name, statOf(s.abs) ?? statOf(s.root), s)
  if (place.kind === 'root') {
    items.push(itemOf([], '', null))
    if (depth === '1') {
      for (const name of [...singles.keys(), ...folders.keys()]) {
        const p = placeOf(ctx, [name])
        if (p?.kind === 'space') items.push(mountItem(p, name, [name]))
        else if (p?.kind === 'folder') items.push(itemOf([name], name, null))
      }
    }
  } else if (place.kind === 'folder') {
    items.push(itemOf(segs, place.name, null))
    if (depth === '1') {
      for (const e of place.entries) {
        const p = placeOf(ctx, [place.name, e.name])
        if (p?.kind === 'space') items.push(mountItem(p, e.name, [place.name, e.name]))
      }
    }
  } else {
    allow(place, 'read')
    const st = statOf(place.abs)
    if (!st) throw notFound()
    const name = place.rel === '/' ? place.mount.at(-1)! : basename(place.abs)
    items.push(itemOf(segs, name, st, place))
    if (st.isDirectory() && depth === '1') {
      // more than the limit is refused whole (507), not cut off: a client that is shown half a folder believes it is all there
      if (readdirSync(place.abs).length >= config.davMaxItems) return tooMany()
      for (const [n, cst] of await listStats(place.abs)) items.push(itemOf([...segs, n], n, cst, place))
    }
  }

  let quota: Quota | undefined
  let byPath: Map<string, Lock[]> | undefined
  const env: Env = {
    user,
    quota: () => (quota === undefined ? (quota = quotaOf(ctx, items[0]?.space)) : quota),
    locksAt: segs => (byPath ??= lockMap(user)).get(pathKey(segs)) ?? [],
  }
  const body = items.map(it => `<D:response><D:href>${esc(hrefOf(it.segs, it.dir))}</D:href>${propstat(it, wanted, env, namesOnly, explicit)}</D:response>`)
  return xmlResponse(207, `<D:multistatus xmlns:D="DAV:">${body.join('')}</D:multistatus>`)
}

/** the entries of a folder and their stats, links left out (never followed or listed, as in the API); other requests get a turn now and then */
async function listStats(abs: string): Promise<[string, Stats][]> {
  const names = readdirSync(abs)
  const out: [string, Stats][] = []
  for (let i = 0; i < names.length; i++) {
    if (i && i % 64 === 0) await new Promise(r => setImmediate(r))
    const st = lstatOf(join(abs, names[i]))
    if (st && !st.isSymbolicLink()) out.push([names[i], st])
  }
  return out
}

/** what a client that asks "how much room is left" is told: the quota that applies, else the free space of the disk */
function quotaOf(ctx: Ctx, space: Space | undefined): Quota {
  if (!space) return null
  const q = quotaUserOf(space, ctx.user)
  if (q && limitOf(q)) {
    const { used, quota } = usage(q)
    return { used, available: Math.max(0, quota - used) }
  }
  const free = freeSpace(space.root)
  // no limit: the room is what the disk has left (what Windows shows as free space); used is not counted for it
  return free === null ? null : { used: 0, available: Math.max(0, free - config.minFreeSpace) }
}

// ───────────── locks (handed out, not enforced) ─────────────

type Lock = { token: string; username: string; segs: string[]; depth: '0' | 'infinity'; owner: string; shared: boolean; expires: number }
const locks = new Map<string, Lock>()
const LOCK_MAX_SECONDS = 3600
const LOCKS_PER_USER = 200
const pathKey = (segs: string[]) => '/' + segs.join('/')

function liveLocks(): void {
  const now = Date.now()
  for (const [k, l] of locks) if (l.expires <= now) locks.delete(k)
}

/** this user's locks by path, made once per request (not one scan of all locks per item) */
function lockMap(user: User): Map<string, Lock[]> {
  liveLocks()
  const map = new Map<string, Lock[]>()
  for (const l of locks.values()) {
    if (l.username !== user.username) continue
    const k = pathKey(l.segs)
    map.set(k, [...(map.get(k) ?? []), l])
  }
  return map
}

function activeLock(l: Lock): string {
  const seconds = Math.max(0, Math.round((l.expires - Date.now()) / 1000))
  return '<D:activelock><D:locktype><D:write/></D:locktype>' +
    `<D:lockscope>${l.shared ? '<D:shared/>' : '<D:exclusive/>'}</D:lockscope><D:depth>${l.depth}</D:depth>` +
    (l.owner ? `<D:owner>${esc(l.owner)}</D:owner>` : '') +
    `<D:timeout>Second-${seconds}</D:timeout><D:locktoken><D:href>opaquelocktoken:${l.token}</D:href></D:locktoken>` +
    `<D:lockroot><D:href>${esc(hrefOf(l.segs, false))}</D:href></D:lockroot></D:activelock>`
}

const lockReply = (status: number, l: Lock, headers: Record<string, string> = {}) =>
  xmlResponse(status, `<D:prop xmlns:D="DAV:"><D:lockdiscovery>${activeLock(l)}</D:lockdiscovery></D:prop>`, { 'Lock-Token': `<opaquelocktoken:${l.token}>`, ...headers })

const TOKEN_RE = /opaquelocktoken:([0-9a-f-]{36})/i

async function lockMethod(ctx: Ctx, segs: string[], place: Place | null): Promise<Response> {
  const { request, user } = ctx
  const s = spaceOnly(place)
  allow(s, 'write')
  const doc = await readXml(request)
  // no body: refreshing the lock named in the If header
  if (!doc) {
    const token = (request.headers.get('if') ?? '').match(TOKEN_RE)?.[1]
    liveLocks()
    const l = token ? locks.get(token) : undefined
    if (!l || l.username !== user.username) throw new HttpError(412, 'files.dav-lock-not-found')
    l.expires = Date.now() + lockSeconds(request) * 1000
    return lockReply(200, l)
  }
  if (doc.name !== 'lockinfo' || doc.ns !== DAV_NS) throw bad('files.dav-bad-xml')
  const shared = !!child(doc, 'lockscope')?.children.some(c => c.name === 'shared')
  // a lock on a name that is not there yet creates an empty file (RFC 4918 section 7.3), as Office and Finder expect
  let created = false
  if (!lstatOf(s.abs)) {
    allow(s, 'upload')
    if (s.rel === '/') throw notFound()
    const name = basename(s.abs)
    if (validName(name) !== name) throw bad('fs.bad-name')
    if (!isDir(dirname(s.abs))) throw conflict('files.folder-not-found')
    writeFileSync(s.abs, '', { flag: 'wx' })
    indexTouched(s.abs)
    audit({ user: user.username, ip: ctx.ip, action: 'create', target: storagePath(s.abs), detail: 'WebDAV' })
    created = true
  }
  liveLocks()
  const mine = [...locks.values()].filter(l => l.username === user.username)
  for (const old of mine.slice(0, Math.max(0, mine.length - LOCKS_PER_USER + 1))) locks.delete(old.token)
  const owner = child(doc, 'owner')?.children.length ? child(doc, 'owner')!.children[0].text : child(doc, 'owner')?.text ?? ''
  const l: Lock = {
    token: randomUUID(), username: user.username, segs, depth: (request.headers.get('depth') ?? '').trim() === '0' ? '0' : 'infinity',
    owner: owner.trim().slice(0, 200), shared, expires: Date.now() + lockSeconds(request) * 1000,
  }
  locks.set(l.token, l)
  return lockReply(created ? 201 : 200, l)
}

/** "Second-600" asks for 10 minutes; Infinite or nothing gets the longest we give */
function lockSeconds(request: Request): number {
  const asked = Number((request.headers.get('timeout') ?? '').match(/Second-(\d+)/i)?.[1])
  return Number.isFinite(asked) && asked > 0 ? Math.min(asked, LOCK_MAX_SECONDS) : LOCK_MAX_SECONDS
}

function unlockMethod(ctx: Ctx): Response {
  const token = (ctx.request.headers.get('lock-token') ?? '').match(TOKEN_RE)?.[1]
  const l = token ? locks.get(token) : undefined
  if (!l || l.username !== ctx.user.username) throw conflict('files.dav-lock-not-found')
  locks.delete(l.token)
  return reply(ctx.request, 204)
}

// ───────────── reading ─────────────

function getMethod(ctx: Ctx, place: Place | null, head: boolean): Response {
  const { request, user } = ctx
  if (place && place.kind !== 'space') throw new HttpError(405, 'files.dav-is-folder')
  const s = spaceOnly(place)
  allow(s, 'read', 'download')
  const st = statOf(s.abs)
  if (!st) throw notFound()
  if (st.isDirectory()) throw new HttpError(405, 'files.dav-is-folder')
  const etag = fileTag(st)
  if (etagMatches(request.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers: { ETag: etag } })
  const range = request.headers.get('range')
  if (!head && (!range || range.startsWith('bytes=0-'))) {
    auditOnce(`dav-get|${user.username}|${s.abs}`, { user: user.username, ip: ctx.ip, action: 'download', target: storagePath(s.abs), detail: 'WebDAV' })
  }
  const res = fileResponse(s.abs, basename(s.abs), request, false)
  return head ? new Response(null, { status: res.status, headers: res.headers }) : res
}

// ───────────── writing ─────────────

/** If-Match and If-None-Match against the file as it is now (st null: there is none) */
function preconditions(request: Request, st: Stats | null) {
  const etag = st ? fileTag(st) : null
  const ifMatch = request.headers.get('if-match')
  const ifNone = request.headers.get('if-none-match')
  if (ifMatch !== null && (!etag || !etagMatches(ifMatch, etag))) throw new HttpError(412, 'files.dav-precondition')
  if (ifNone !== null && etag && etagMatches(ifNone, etag)) throw new HttpError(412, 'files.dav-precondition')
}

/** the new file replaces `dest` in one step; across disks (EXDEV) it is copied beside it first */
async function place(tmp: string, dest: string, size: number) {
  try {
    renameSync(tmp, dest)
  } catch (err: any) {
    if (err?.code !== 'EXDEV') throw err
    ensureSpace(dirname(dest), size)
    const part = join(dirname(dest), `.fc-dav-${randomBytes(8).toString('hex')}`)
    try {
      await copyFile(tmp, part)
      renameSync(part, dest)
    } catch (e) {
      rmSync(part, { force: true })
      throw e
    }
    rmSync(tmp, { force: true })
  }
}

const SPACE_CHECK_EVERY = 8 * 1024 * 1024
/** how much quota a PUT without Content-Length takes at a time while its bytes arrive */
const RESERVE_STEP = 4 * 1024 * 1024

async function putMethod(ctx: Ctx, segs: string[], place_: Place | null): Promise<Response> {
  const { request, user, ip } = ctx
  const s = writableSpace(place_, segs)
  if (s.rel === '/') throw new HttpError(405, 'files.dav-is-folder')
  allow(s, 'upload')
  const name = basename(s.abs)
  if (validName(name) !== name) throw bad('fs.bad-name')
  if (!isDir(dirname(s.abs))) throw conflict('files.folder-not-found')
  const first = statOf(s.abs)
  if (first?.isDirectory()) throw new HttpError(405, 'files.dav-is-folder')
  if (first) allow(s, 'write')
  preconditions(request, first)

  const header = request.headers.get('content-length')
  const known = header === null || header === '' ? null : Number(header)
  if (known !== null && (!Number.isSafeInteger(known) || known < 0)) throw bad('request.invalid')
  if (known !== null && known > policy.uploadMaxSize()) throw new HttpError(413, 'upload.too-big')

  // the count is awaited first: from the check of the quota to the reservation there is no await
  const q = quotaUserOf(s, user)
  await ready(q)
  const before = statOf(s.abs)?.size ?? 0
  ensureSpace(paths.tmp, known ?? 0)
  // while the bytes arrive they hold their place in the quota: exactly the growth when the size is announced. A client
  // that does not say how much it sends holds a place a piece at a time as the bytes come in (taking all that is left
  // would make a second upload of the same user fail with 507 while there is room for both)
  let hold: Hold | null = null
  let meter: ((written: number) => void) | null = null
  if (q && limitOf(q)) {
    if (known !== null) hold = holdNow(q, Math.max(0, known - before))
    else {
      const parts: Hold[] = []
      let held = 0
      hold = { commit() {}, release() { for (const p of parts) p.release(); parts.length = 0; held = 0 } }
      meter = written => {
        const need = Math.max(0, written - before)
        if (need <= held) return
        // a piece of RESERVE_STEP, or less when that is all the room there is; never less than what is needed now
        const take = Math.min(Math.max(need - held, RESERVE_STEP), roomLeft(q))
        if (take < need - held) throw exceeded(q)
        parts.push(holdNow(q, take))
        held += take
      }
    }
  }

  const tmp = join(paths.tmp, `dav-${randomBytes(12).toString('hex')}`)
  let fh: Awaited<ReturnType<typeof open>> | null = null
  let written = 0
  try {
    fh = await open(tmp, 'wx')
    let checked = 0
    if (request.body) {
      for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
        written += chunk.byteLength
        if (known !== null) {
          if (written > known) throw bad('upload.size-mismatch')
        } else {
          if (written > policy.uploadMaxSize()) throw new HttpError(413, 'upload.too-big')
          meter?.(written)
        }
        if (written - checked >= SPACE_CHECK_EVERY) { ensureSpace(paths.tmp, 0); checked = written }
        let off = 0
        while (off < chunk.byteLength) off += (await fh.write(chunk, off, chunk.byteLength - off)).bytesWritten
      }
    }
    await fh.close()
    fh = null
    if (known !== null && written !== known) throw bad('upload.size-mismatch')

    // The whole file is here. The counts are awaited, then the version, the quota and the file itself follow each other
    // with no await in between (like PUT /api/content), so the file that is replaced is the one that was kept.
    await ready(q)
    const owner = ownerOfPath(s.abs)
    await ready(owner)
    const cur = statOf(s.abs)
    if (cur?.isDirectory()) throw new HttpError(405, 'files.dav-is-folder')
    preconditions(request, cur)
    const grow = written - (cur?.size ?? 0)
    hold?.release()
    hold = null
    const ticket = cur?.isFile() ? reserveVersion(owner, s.abs) : null
    try { hold = holdNow(q, Math.max(0, grow)) } catch (err) { ticket?.release(); throw err }
    try {
      ticket?.keep('edit', user.username)
      await place(tmp, s.abs, written)
    } catch (err) {
      hold.release()
      ticket?.release()
      throw err
    }
    hold.commit(grow)
    hold = null
    if (grow < 0 && q) markStale(q.username)

    // rclone (owncloud / nextcloud vendors) sends the modification time of the file it uploads
    const mt = Number(request.headers.get('x-oc-mtime'))
    const headers: Record<string, string> = {}
    if (Number.isFinite(mt) && mt > 0 && mt < 4e9) {
      try { utimesSync(s.abs, new Date(), new Date(mt * 1000)); headers['X-OC-Mtime'] = 'accepted' } catch { /* the time stays as it is */ }
    }
    indexTouched(s.abs)
    // an editor saves many times: one line a minute per file
    auditOnce(`dav-put|${user.username}|${s.abs}`, {
      user: user.username, ip, action: cur ? 'edit' : 'upload', target: storagePath(s.abs), detail: 'WebDAV',
    })
    const now = statOf(s.abs)
    if (now) headers.ETag = fileTag(now)
    return reply(request, cur ? 204 : 201, undefined, undefined, headers)
  } catch (err) {
    await fh?.close().catch(() => {})
    rmSync(tmp, { force: true })
    hold?.release()
    throw err
  }
}

async function deleteMethod(ctx: Ctx, place_: Place | null): Promise<Response> {
  const { request, user, ip } = ctx
  const s = spaceOnly(place_)
  allow(s, 'write')
  if (s.rel === '/') throw forbidden('files.root-item')
  if (!lstatOf(s.abs)) throw notFound()
  guardSystemFolder(s.abs)
  await moveToTrash(s.abs, user.username)
  // the trash is outside the home: the space is free again
  markStaleFor(s, user)
  audit({ user: user.username, ip, action: 'delete', target: storagePath(s.abs), detail: 'WebDAV' })
  return reply(request, 204)
}

function mkcolMethod(ctx: Ctx, segs: string[], place_: Place | null): Response {
  const { request, user, ip } = ctx
  const s = writableSpace(place_, segs)
  if (Number(request.headers.get('content-length')) > 0 || request.headers.has('transfer-encoding')) throw new HttpError(415, 'files.dav-unsupported-body')
  allow(s, 'write')
  if (s.rel === '/' || lstatOf(s.abs)) throw new HttpError(405, 'files.name-taken')
  const name = basename(s.abs)
  if (validName(name) !== name) throw bad('fs.bad-name')
  if (!isDir(dirname(s.abs))) throw conflict('files.folder-not-found')
  mkdirSync(s.abs)
  indexTouched(s.abs)
  audit({ user: user.username, ip, action: 'mkdir', target: storagePath(s.abs), detail: 'WebDAV' })
  return reply(request, 201)
}

/** where the Destination header points: a path under /dav of this server (or the public address behind a proxy) */
function destinationOf(request: Request): string[] {
  const header = request.headers.get('destination')
  if (!header) throw bad('files.dav-bad-destination')
  let u: URL
  try { u = new URL(header, request.url) } catch { throw bad('files.dav-bad-destination') }
  const hosts = new Set([new URL(request.url).host.toLowerCase()])
  if (config.trustProxy !== 'false') {
    const fwd = request.headers.get('x-forwarded-host')?.split(',').at(-1)?.trim().toLowerCase()
    if (fwd) hosts.add(fwd)
  }
  try { if (config.publicUrl) hosts.add(new URL(config.publicUrl).host.toLowerCase()) } catch { /* PUBLIC_URL is checked elsewhere */ }
  if (!hosts.has(u.host.toLowerCase()) || !isDavPath(u.pathname)) throw new HttpError(502, 'files.dav-other-server')
  return parsePath(u.pathname)
}

async function copyMoveMethod(ctx: Ctx, kind: 'copy' | 'move', place_: Place | null): Promise<Response> {
  const { request, user, ip } = ctx
  const src = spaceOnly(place_)
  const dstSegs = destinationOf(request)
  const dp = placeOf(ctx, dstSegs)
  if (!dp) throw conflict('files.dest-not-found')
  const dst = spaceOnly(dp)
  if (src.rel === '/' || dst.rel === '/') throw forbidden('files.root-item')
  const depthHeader = (request.headers.get('depth') ?? 'infinity').trim().toLowerCase()
  if (kind === 'copy' && depthHeader !== '0' && depthHeader !== 'infinity') throw bad('request.invalid')
  const overwrite = (request.headers.get('overwrite') ?? 'T').trim().toUpperCase() !== 'F'

  // the same rights as /api/copy and /api/move: inside one space write; between spaces the source must be readable
  // (a copy also downloadable, a move also writable) and the destination must take new files
  const cross = src.space !== dst.space
  if (cross) {
    allow(src, ...(kind === 'copy' ? ['read', 'download'] as const : ['read', 'write'] as const))
    allow(dst, 'write', 'upload')
  } else allow(src, 'write')

  const from = src.abs
  const to = dst.abs
  const fromSt = lstatOf(from)
  if (!fromSt) throw notFound()
  const name = basename(to)
  if (validName(name) !== name) throw bad('fs.bad-name')
  if (!isDir(dirname(to))) throw conflict('files.dest-not-found')
  if (from === to) throw forbidden('files.same-folder')
  // a folder can not go into itself, and what holds the source can not be replaced by it
  const intoSelf = kind === 'move' ? 'files.move-into-self' : 'files.copy-into-self'
  if (fromSt.isDirectory() && within(from, to)) throw new HttpError(403, intoSelf)
  if (within(to, from)) throw new HttpError(403, intoSelf)
  if (kind === 'move') guardSystemFolder(from)

  // "a.txt" -> "A.txt" is the same file on a case-insensitive disk
  const existed = !!lstatOf(to) && !sameFile(from, to)
  if (existed && !overwrite) throw new HttpError(412, 'files.dav-precondition')
  if (existed) guardSystemFolder(to)

  if (kind === 'move' && !cross) {
    // what is replaced goes to the trash first, like a delete
    if (existed) { await moveToTrash(to, user.username); markStaleFor(dst, user) }
    await moveTree(from, to)
    moveVersions(from, to)
    moveState(from, to)
    indexTouched(from); indexTouched(to)
    markStaleBetween(from, to)
  } else {
    // a copy, or a move into another space: copied beside the destination first, then put in place, so a failure
    // loses nothing; the source goes to the trash only when the copy is complete
    const q = quotaUserOf(dst, user)
    await ready(q)
    const size = fromSt.isDirectory() ? (await treeStats(from)).size : fromSt.size
    ensureSpace(dirname(to), size)
    const hold = holdNow(q, size)
    const part = join(dirname(to), `.fc-dav-${randomBytes(8).toString('hex')}`)
    try {
      if (kind === 'copy' && fromSt.isDirectory() && depthHeader === '0') mkdirSync(part)
      else await copyTree(from, part)
      if (existed) { await moveToTrash(to, user.username); markStaleFor(dst, user) }
      renameSync(part, to)
    } catch (err) {
      rmSync(part, { recursive: true, force: true })
      hold.release()
      throw err
    }
    hold.commit()
    indexTouched(to)
    if (kind === 'move') {
      try {
        await moveToTrash(from, user.username)
      } catch (err) {
        rmSync(to, { recursive: true, force: true })
        if (q) markStale(q.username)
        throw err
      }
      markStaleFor(src, user)
    }
  }
  audit({ user: user.username, ip, action: kind, target: storagePath(from), detail: `WebDAV ${storagePath(to)}` })
  return reply(request, existed ? 204 : 201, undefined, undefined, { Location: hrefOf(dstSegs, fromSt.isDirectory()) })
}

/** the Windows and Mac clients set times and attributes this way after a copy; getlastmodified really sets the time, the rest is accepted and ignored */
async function proppatchMethod(ctx: Ctx, segs: string[], place_: Place | null): Promise<Response> {
  const s = spaceOnly(place_)
  allow(s, 'write')
  const st = statOf(s.abs)
  if (!st) throw notFound()
  const doc = await readXml(ctx.request)
  if (!doc || doc.name !== 'propertyupdate' || doc.ns !== DAV_NS) throw bad('files.dav-bad-xml')
  const ok: string[] = []
  const refused: string[] = []
  for (const op of doc.children) {
    if (op.ns !== DAV_NS || (op.name !== 'set' && op.name !== 'remove')) continue
    for (const prop of child(op, 'prop')?.children ?? []) {
      if (!safeName(prop.name)) continue
      const tag = prop.ns === DAV_NS ? `<D:${prop.name}/>` : `<X:${prop.name} xmlns:X="${escAttr(prop.ns)}"/>`
      const win = prop.ns.startsWith('urn:schemas-microsoft-com:') && prop.name.startsWith('Win32')
      // `lastmodified` in Unix seconds is what rclone sends to ownCloud and Nextcloud servers after a server-side copy
      const when = prop.text.trim()
      if (op.name === 'set' && ((prop.ns === DAV_NS && (prop.name === 'getlastmodified' || prop.name === 'lastmodified')) || (win && prop.name === 'Win32LastModifiedTime'))) {
        const t = /^\d{1,11}(\.\d+)?$/.test(when) ? Number(when) * 1000 : Date.parse(when)
        if (Number.isFinite(t)) {
          try { utimesSync(s.abs, st.atime, new Date(t)); indexTouched(s.abs) } catch { /* the time stays as it was */ }
        }
        ok.push(tag)
      } else if (win) ok.push(tag)
      else refused.push(tag)
    }
  }
  const group = (tags: string[], status: string) =>
    (tags.length ? `<D:propstat><D:prop>${tags.join('')}</D:prop><D:status>${status}</D:status></D:propstat>` : '')
  return xmlResponse(207, '<D:multistatus xmlns:D="DAV:"><D:response>' +
    `<D:href>${esc(hrefOf(segs, st.isDirectory()))}</D:href>${group(ok, 'HTTP/1.1 200 OK')}${group(refused, 'HTTP/1.1 403 Forbidden')}` +
    '</D:response></D:multistatus>')
}

// ───────────── the entry point ─────────────

export async function handleDav(request: Request, socketIp: string): Promise<Response> {
  if (!policy.webdav()) return reply(request, 404, 'request.no-route')
  // /dav is answered before the /api hooks, so pick up `bun src/cli.ts` changes (revoked app passwords) here too
  reloadIfChangedByCli()
  try {
    const ip = clientIp(request, socketIp)
    const ctx = await authenticate(request, ip)
    if (ctx instanceof Response) return ctx
    const allowed = ctx.scope === 'read' ? ALLOW_READ : ALLOW_ALL
    const method = request.method.toUpperCase()
    if (method === 'OPTIONS') {
      return reply(request, 200, undefined, undefined, {
        DAV: ctx.scope === 'read' ? '1' : '1, 2', Allow: allowed, 'MS-Author-Via': 'DAV', 'Content-Length': '0',
      })
    }
    if (method === 'UNLOCK') return unlockMethod(ctx)
    const segs = parsePath(new URL(request.url).pathname)
    const place_ = placeOf(ctx, segs)
    switch (method) {
      case 'PROPFIND': return await propfind(ctx, segs, place_)
      case 'PROPPATCH': return await proppatchMethod(ctx, segs, place_)
      case 'GET': return getMethod(ctx, place_, false)
      case 'HEAD': return getMethod(ctx, place_, true)
      case 'PUT': return await putMethod(ctx, segs, place_)
      case 'DELETE': return await deleteMethod(ctx, place_)
      case 'MKCOL': return mkcolMethod(ctx, segs, place_)
      case 'COPY': return await copyMoveMethod(ctx, 'copy', place_)
      case 'MOVE': return await copyMoveMethod(ctx, 'move', place_)
      case 'LOCK': return await lockMethod(ctx, segs, place_)
      default: return reply(request, 405, 'files.dav-bad-method', {}, { Allow: allowed })
    }
  } catch (err) {
    return failure(request, err)
  }
}

