/**
 * Share links: a signed-in user hands out a link so someone without an account can download one file or one folder.
 *
 * A link is found by the SHA-256 of its token. The token itself is kept only sealed with the server's secret.key
 * (secret-box.ts), so the owner can copy the link again while a copy of shares.json alone still gives no working link. Every time a link is used it is checked again from scratch: not expired, revoked or used
 * up, the item still where it was and of the same type, the owner still there and still allowed to share and download
 * in that space. A link that fails any of these answers the same 404, so a guesser learns nothing.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { basename } from 'node:path'
import { accessFor, findUser, type Lockout, type Space } from './auth'
import { config, paths } from './config'
import { notFound, resolveIn, storagePath } from './fsx'
import { nameOf, notify } from './notify'
import { open, seal } from './secret-box'
import { JsonStore } from './store'

export type Share = {
  id: string
  tokenHash: string
  /** the token sealed (secret-box.ts), for showing the link again; absent on links made before 1.8.1 */
  tokenSealed?: string
  owner: string
  space: Space
  /** relative to the space of the owner */
  path: string
  type: 'file' | 'dir'
  createdAt: string
  expiresAt: string
  /** null = no limit */
  maxDownloads: number | null
  downloads: number
  passwordHash?: string
  revokedAt?: string
  /** absent = 'download', so every link made before upload links existed keeps working unchanged */
  kind?: ShareKind
  // ── upload-request links (kind 'upload'; the folder is `path`) ──
  /** null/absent = only the server's own limits */
  maxFileBytes?: number | null
  maxFiles?: number | null
  maxTotalBytes?: number | null
  /** shown to the visitor as plain text */
  note?: string
  /** files that arrived through this link and their bytes */
  uploadedFiles?: number
  uploadedBytes?: number
  /** what each visitor sent, by a hash of their visitor key (the key itself is never stored); oldest dropped past UPLOAD_LOG_MAX */
  received?: { by: string; name: string; size: number; at: string }[]
}

export type ShareKind = 'download' | 'upload'
export const kindOf = (s: Share): ShareKind => s.kind ?? 'download'

export type ShareState = 'active' | 'expired' | 'revoked' | 'used-up' | 'unavailable'

export const SHARE_DAYS = [1, 7, 30]
/** the expiry choices this server takes: SHARE_DAYS up to SHARE_MAX_DAYS */
export const allowedShareDays = () => SHARE_DAYS.filter(d => d <= config.shareMaxDays)
export const SHARE_PASSWORD_MIN = 6
export const SHARE_MAX_DOWNLOADS = 100_000
export const SHARE_NOTE_MAX = 500
/** most files an upload link may be set to accept */
export const SHARE_MAX_FILES = 100_000
export const SHARE_MAX_TOTAL = 2 ** 50
/** uploads in progress at one time, per link and per address (across links) */
export const SHARE_UPLOADS_PER_LINK = 5
export const SHARE_UPLOADS_PER_IP = 3
const UPLOAD_LOG_MAX = 2000
/** links one user may hold at a time (until they expire and are cleaned up) */
export const SHARES_PER_USER = 500
/** wrong passwords per link and address before it is locked, and for how long */
export const SHARE_LOCKOUT: Lockout = { max: 5, lockMs: 15 * 60_000 }
/** the password of a link is asked again after this */
export const UNLOCK_MS = 60 * 60_000
export const SHARE_COOKIE = 'fc_share'

const store = new JsonStore<{ shares: Share[] }>(paths.shares, () => ({ shares: [] }), { onCorrupt: 'fail' })

/** 32 random bytes, base64url: 43 characters */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
const gone = () => notFound('share.not-found')

export const allShares = () => store.value.shares
export const sharesOf = (username: string) =>
  store.value.shares.filter(s => s.owner.toLowerCase() === username.toLowerCase())
export const findShare = (id: unknown) => store.value.shares.find(s => s.id === id)

export function createShare(input: Omit<Share, 'id' | 'tokenHash' | 'tokenSealed' | 'createdAt' | 'downloads' | 'uploadedFiles' | 'uploadedBytes' | 'received'>): { share: Share; token: string } {
  const token = randomBytes(32).toString('base64url')
  const share: Share = {
    id: randomBytes(8).toString('hex'),
    tokenHash: hashToken(token),
    tokenSealed: seal(token),
    owner: input.owner,
    space: input.space,
    path: input.path,
    type: input.type,
    createdAt: new Date().toISOString(),
    expiresAt: input.expiresAt,
    maxDownloads: input.maxDownloads,
    downloads: 0,
    ...(input.passwordHash ? { passwordHash: input.passwordHash } : {}),
    ...(input.kind === 'upload' ? {
      kind: 'upload' as const,
      maxFileBytes: input.maxFileBytes ?? null,
      maxFiles: input.maxFiles ?? null,
      maxTotalBytes: input.maxTotalBytes ?? null,
      ...(input.note ? { note: input.note } : {}),
      uploadedFiles: 0,
      uploadedBytes: 0,
      received: [],
    } : {}),
  }
  store.update(d => { d.shares.push(share) })
  return { share, token }
}

/** the token of a link, for copying it again; null when the link predates 1.8.1 or secret.key changed since */
export function shareToken(share: Share): string | null {
  if (!share.tokenSealed) return null
  try {
    const token = open(share.tokenSealed)
    // a sealed value that does not belong to this link (copied between links by hand) is never shown
    return hashToken(token) === share.tokenHash ? token : null
  } catch {
    return null
  }
}

export function revokeShare(share: Share) {
  if (share.revokedAt) return
  share.revokedAt = new Date().toISOString()
  store.save()
}

/** an account that is deleted takes its links along: a new account by the same name must not bring them back */
export function revokeSharesOf(username: string) {
  for (const s of sharesOf(username)) if (!s.revokedAt) s.revokedAt = new Date().toISOString()
  store.save()
}

/**
 * the shared file or folder as it is now, or null when the owner may no longer share it or it is gone or changed.
 * A download link needs `share` and `download`, an upload link `share` and `upload` (and only ever a folder).
 */
export function sharedItem(s: Share): string | null {
  const owner = findUser(s.owner)
  if (!owner) return null
  const a = accessFor(owner, s.space)
  const need = kindOf(s) === 'upload' ? 'upload' : 'download'
  if (!a || !a.perms.has('share') || !a.perms.has(need)) return null
  try {
    const abs = resolveIn(a.root, s.path)
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) return null
    return (s.type === 'dir' ? st.isDirectory() : st.isFile()) ? abs : null
  } catch {
    return null
  }
}

// downloads that started and have not finished: they hold a place, so a limit of 1 can not be passed by starting many at once
const inflight = new Map<string, number>()

export function stateOf(s: Share, now = Date.now()): ShareState {
  if (s.revokedAt) return 'revoked'
  if (Date.parse(s.expiresAt) <= now) return 'expired'
  if (s.maxDownloads !== null && s.downloads >= s.maxDownloads) return 'used-up'
  if (kindOf(s) === 'upload' && uploadFull(s)) return 'used-up'
  return sharedItem(s) ? 'active' : 'unavailable'
}

/** what the owner and admins see: never the hashes */
export const publicShare = (s: Share) => ({
  id: s.id,
  owner: s.owner,
  space: s.space,
  path: s.path,
  name: basename(s.path),
  type: s.type,
  createdAt: s.createdAt,
  expiresAt: s.expiresAt,
  maxDownloads: s.maxDownloads,
  downloads: s.downloads,
  hasPassword: !!s.passwordHash,
  kind: kindOf(s),
  ...(kindOf(s) === 'upload' ? {
    maxFileBytes: s.maxFileBytes ?? null, maxFiles: s.maxFiles ?? null, maxTotalBytes: s.maxTotalBytes ?? null,
    note: s.note ?? '', uploadedFiles: s.uploadedFiles ?? 0, uploadedBytes: s.uploadedBytes ?? 0,
  } : {}),
  revokedAt: s.revokedAt ?? null,
  state: stateOf(s),
  /** the link can be shown again (made from 1.8.1 on) */
  linkAvailable: !!s.tokenSealed,
})

/** for the audit trail: where the item is in the storage, or space:path when the owner's space can not be found any more */
export function shareTarget(s: Share): string {
  const owner = findUser(s.owner)
  const a = owner ? accessFor(owner, s.space) : null
  try { if (a) return storagePath(resolveIn(a.root, s.path)) } catch { /* fall through */ }
  return `${s.space}:${s.path}`
}

/**
 * the link behind a token and the shared item, when the link works; one 404 for every other case.
 * `kind` names the routes asking: a download link answers no upload route and the other way round.
 */
export function openShare(token: unknown, kind?: ShareKind): { share: Share; abs: string } {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw gone()
  const hash = hashToken(token)
  const share = store.value.shares.find(s => s.tokenHash === hash)
  if (!share || share.revokedAt || Date.parse(share.expiresAt) <= Date.now()) throw gone()
  if (kind && kindOf(share) !== kind) throw gone()
  if (share.maxDownloads !== null && share.downloads >= share.maxDownloads) throw gone()
  const abs = sharedItem(share)
  if (!abs) throw gone()
  return { share, abs }
}

// ───────────── upload-request links ─────────────

/** the link has taken all the files or bytes it was set to take */
export function uploadFull(s: Share): boolean {
  return (s.maxFiles != null && (s.uploadedFiles ?? 0) >= s.maxFiles) || (s.maxTotalBytes != null && (s.uploadedBytes ?? 0) >= s.maxTotalBytes)
}

/** the hash of a visitor's key: what the link remembers of them */
export const visitorId = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 24)

/** a finished upload through the link: counted, and remembered for the visitor who sent it */
export function recordUpload(share: Share, key: string, name: string, size: number) {
  share.uploadedFiles = (share.uploadedFiles ?? 0) + 1
  share.uploadedBytes = (share.uploadedBytes ?? 0) + size
  const log = (share.received ??= [])
  log.push({ by: visitorId(key), name, size, at: new Date().toISOString() })
  if (log.length > UPLOAD_LOG_MAX) log.splice(0, log.length - UPLOAD_LOG_MAX)
  store.save()
}

/** what this visitor sent through the link, and nothing of anyone else's */
export const uploadsBy = (share: Share, key: string) =>
  (share.received ?? []).filter(r => r.by === visitorId(key)).map(({ name, size, at }) => ({ name, size, at }))

/**
 * Hold a place for one download. `finish` counts it (once the last byte has been handed over), `release` gives the
 * place back (the visitor cancelled, or the answer was only part of the file). Whichever comes first wins.
 */
export function startDownload(share: Share): { finish(): void; release(): void } {
  const held = inflight.get(share.id) ?? 0
  if (share.maxDownloads !== null && share.downloads + held >= share.maxDownloads) throw gone()
  inflight.set(share.id, held + 1)
  let done = false
  const end = (counted: boolean) => {
    if (done) return
    done = true
    const n = (inflight.get(share.id) ?? 1) - 1
    if (n > 0) inflight.set(share.id, n)
    else inflight.delete(share.id)
    if (counted) {
      share.downloads++
      store.save()
      // the last allowed download: the owner hears of it once (no more can start after this)
      if (share.maxDownloads !== null && share.downloads === share.maxDownloads) {
        notify(share.owner, 'link-limit-reached', { id: share.id, name: nameOf(share.path), max: share.maxDownloads }, '/links')
      }
    }
  }
  return { finish: () => end(true), release: () => end(false) }
}

// ───────────── password ─────────────

// signs "this browser gave the password of link <id> until <time>"; a restart forgets it and the password is asked again
const unlockKey = randomBytes(32)
const unlockMac = (id: string, until: number) => createHmac('sha256', unlockKey).update(`${id}.${until}`).digest()

export function unlockCookie(share: Share): string {
  const until = Date.now() + UNLOCK_MS
  return `${until}.${unlockMac(share.id, until).toString('base64url')}`
}

/** true when the link has no password, or the request carries a cookie made for this very link that has not run out */
export function isUnlocked(share: Share, request: Request): boolean {
  if (!share.passwordHash) return true
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at < 0 || part.slice(0, at).trim() !== SHARE_COOKIE) continue
    const [untilText, mac] = part.slice(at + 1).trim().split('.')
    const until = Number(untilText)
    if (!Number.isSafeInteger(until) || until <= Date.now() || !mac) continue
    const want = unlockMac(share.id, until)
    const got = Buffer.from(mac, 'base64url')
    if (got.length === want.length && timingSafeEqual(got, want)) return true
  }
  return false
}

export const lockoutKey = (share: Share, ip: string) => `share|${share.id}|${ip}`

// ───────────── housekeeping ─────────────

/** drop links that ran out (revoked and used-up ones go too, once their time is over); returns how many */
export function purgeExpiredShares(now = Date.now()): number {
  const before = store.value.shares.length
  const keep = store.value.shares.filter(s => Date.parse(s.expiresAt) > now)
  if (keep.length === before) return 0
  for (const s of store.value.shares) if (!keep.includes(s)) inflight.delete(s.id)
  store.replace({ shares: keep })
  return before - keep.length
}
