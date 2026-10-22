/**
 * App passwords: the password a WebDAV client (Windows, Finder, rclone...) signs in with, in DATA_DIR/app-passwords.json.
 * Instead of the account password, which would give such a client everything the account can do (and does not
 * work with two-factor sign-in), the user makes one per device and can take it back at any time. Each has a scope:
 * `read` (look and download) or `readwrite`.
 *
 * Only an argon2 hash is kept; the secret is shown once, when it is made. The secret is `fc-` and 32 random letters
 * and digits, and its first 8 characters are kept as `hint` so a sign-in finds its record without trying every hash
 * (and the list can tell the passwords apart). The other 24 characters carry about 143 bits.
 *
 * A successful check is remembered for a minute (keyed by a SHA-256 of user and secret), so a client that sends
 * thousands of requests does not pay for argon2 each time. A cached answer is still checked against the record, so
 * deleting an app password (or the account, or changing its password) works at once, not after the minute.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { findUser, onCliChange, type User } from './auth'
import { paths } from './config'
import { bad } from './fsx'
import { JsonStore } from './store'

export type AppScope = 'read' | 'readwrite'
export type AppPassword = {
  id: string
  username: string
  name: string
  /** argon2 hash of the secret */
  hash: string
  /** first 8 characters after `fc-`: finds the record, tells the passwords apart in the list */
  hint: string
  scope: AppScope
  createdAt: string
  lastUsedAt: string | null
  lastIp: string | null
}

export const APP_PASSWORDS_PER_USER = 20
export const APP_SECRET_RE = /^fc-[A-Za-z0-9]{32}$/
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

// The secret is 143 bits of randomness, so the hash is not there to slow down guessing (nothing could) but to keep
// the file useless if it leaks. The light setting (8 MiB, 15 ms instead of 64 MiB, 130 ms) is the one that matters
// here: every sign-in that is not in the cache pays it, and a flood of wrong ones must not cost the server much.
const HASH_OPTIONS = { algorithm: 'argon2id', memoryCost: 8192, timeCost: 2 } as const

const store = new JsonStore<{ items: AppPassword[] }>(paths.appPasswords, () => ({ items: [] }), { onCorrupt: 'fail' })
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** what the list shows: never the hash */
export const publicAppPassword = (p: AppPassword) => ({
  id: p.id, name: p.name, scope: p.scope, hint: `fc-${p.hint}`, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt, lastIp: p.lastIp,
})

export const appPasswordsOf = (username: string) => store.value.items.filter(p => same(p.username, username))
const byId = (id: string) => store.value.items.find(p => p.id === id)

/** 32 letters and digits, every one equally likely (bytes that would favour the first letters are skipped) */
function randomBase62(n: number): string {
  let out = ''
  while (out.length < n) {
    for (const b of randomBytes(n * 2)) {
      if (b < 248 && out.length < n) out += BASE62[b % 62]
    }
  }
  return out
}

/** make one for `user`; the secret is in the answer once and nowhere else */
export async function createAppPassword(user: User, name: string, scope: AppScope): Promise<{ item: AppPassword; secret: string }> {
  const random = randomBase62(32)
  const secret = `fc-${random}`
  const hash = await Bun.password.hash(secret, HASH_OPTIONS)
  // counted again here, in the same tick as the insert: two requests can not both take the last place
  if (appPasswordsOf(user.username).length >= APP_PASSWORDS_PER_USER) throw bad('auth.app-password-limit', { max: APP_PASSWORDS_PER_USER })
  const item: AppPassword = {
    id: randomUUID(), username: user.username, name, hash, hint: random.slice(0, 8), scope,
    createdAt: new Date().toISOString(), lastUsedAt: null, lastIp: null,
  }
  store.update(d => { d.items.push(item) })
  return { item, secret }
}

export function removeAppPassword(username: string, id: string): AppPassword | null {
  const item = store.value.items.find(p => p.id === id && same(p.username, username))
  if (!item) return null
  store.update(d => { d.items = d.items.filter(p => p !== item) })
  forgetCached(p => p.id === item.id)
  return item
}

/** the account is deleted or its password changed: none of its app passwords may go on working. How many went. */
export function removeAppPasswordsOf(username: string): number {
  const n = appPasswordsOf(username).length
  if (n) store.update(d => { d.items = d.items.filter(p => !same(p.username, username)) })
  forgetCached(p => same(p.username, username))
  return n
}

// `bun src/cli.ts sessions-revoke` removes app passwords too: the running app reads the file again, so it neither
// keeps honouring them nor writes its old list back over the change
onCliChange(() => {
  store.replace(existsSync(paths.appPasswords) ? JSON.parse(readFileSync(paths.appPasswords, 'utf8')) : { items: [] })
  forgetCached(() => true)
})

// ───────────── checking a sign-in ─────────────

/** the minute is a property here so a test can shorten it */
export const appPasswordCache = {
  ttlMs: 60_000,
  clear() { cache.clear(); inflight.clear() },
}
type Cached = { id: string; username: string; until: number }
const cache = new Map<string, Cached>()
const inflight = new Map<string, Promise<AppPassword | null>>()
const CACHE_MAX = 2000
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

function forgetCached(test: (c: { id: string; username: string }) => boolean) {
  for (const [k, c] of cache) if (test(c)) cache.delete(k)
}

const DUMMY_HASH = await Bun.password.hash('not-a-real-app-password', HASH_OPTIONS)

/** a record that may still be used by this account: made after the account (a new account of the same name gets none) */
const usable = (p: AppPassword, user: User) => same(p.username, user.username) && Date.parse(p.createdAt) >= Date.parse(user.createdAt)

/** the account and the record a username and secret open, or null. Takes about as long whether or not the user exists. */
export async function verifyAppPassword(username: string, secret: string): Promise<{ user: User; item: AppPassword } | null> {
  const user = findUser(username)
  if (!APP_SECRET_RE.test(secret)) return null
  const key = sha256(`${username.toLowerCase()}\0${secret}`)
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.until > now) {
    const item = byId(hit.id)
    if (item && user && usable(item, user)) return { user, item }
    cache.delete(key)
  }
  let pending = inflight.get(key)
  if (!pending) {
    pending = (async () => {
      const hint = secret.slice(3, 11)
      const item = user ? appPasswordsOf(user.username).find(p => p.hint === hint && usable(p, user)) : undefined
      const ok = await Bun.password.verify(secret, item?.hash ?? DUMMY_HASH).catch(() => false)
      return item && ok ? item : null
    })().finally(() => inflight.delete(key))
    inflight.set(key, pending)
  }
  const item = await pending
  if (!item || !user) return null
  // checked again: it may have been deleted while the hash was computed
  if (byId(item.id) !== item) return null
  if (cache.size >= CACHE_MAX) for (const [k, c] of cache) if (c.until <= now) cache.delete(k)
  if (cache.size >= CACHE_MAX) cache.clear()
  if (appPasswordCache.ttlMs > 0) cache.set(key, { id: item.id, username: item.username, until: Date.now() + appPasswordCache.ttlMs })
  return { user, item }
}

/** at most one write a minute per app password: a client sends many requests a second */
export function touchAppPassword(item: AppPassword, ip: string) {
  const last = item.lastUsedAt ? Date.parse(item.lastUsedAt) : 0
  if (Date.now() - last < 60_000) return
  store.updateSoon(() => { item.lastUsedAt = new Date().toISOString(); item.lastIp = ip }, 5000)
}
