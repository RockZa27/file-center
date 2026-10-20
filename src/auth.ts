import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { alert } from './alerts'
import { audit } from './audit'
import { COMMON_PASSWORDS, isRunOrRepeat } from './common-passwords'
import { config, paths } from './config'
import { bad, ensureDir, HttpError, normRel, resolveIn } from './fsx'
import { GRANT_SPACE, grantSpace } from './grants'
import { log } from './logger'
import { open, seal } from './secret-box'
import { cleanPerms, PERMISSIONS, settings, type Perm } from './settings'
import { JsonStore } from './store'
import { newTotpSecret, verifyTotp } from './totp'

/**
 * admin = super admin (the whole storage, settings, updates, backups); manager = "ผู้ดูแล": manages plain users and
 * reads their files, nothing else; user. The stored ids stay as they were so existing data needs no migration.
 */
export type Role = 'admin' | 'manager' | 'user'

export const isAdmin = (u: User | null | undefined): boolean => u?.role === 'admin'
/** admin or manager */
export const isStaff = (u: User | null | undefined): boolean => u?.role === 'admin' || u?.role === 'manager'
/** where the folder of a user created by a manager (and so the one a manager may read) is */
export const defaultHome = (username: string) => `/users/${username}`
const insideOrSame = (p: string, root: string) => p === root || p.startsWith(root === '/' ? '/' : `${root}/`)
/** equal, or one inside the other (case-insensitive: the storage may sit on a filesystem that is) */
const overlaps = (a: string, b: string) => {
  const x = a.toLowerCase(), y = b.toLowerCase()
  return insideOrSame(x, y) || insideOrSame(y, x)
}
/** does a folder of another account (not an admin: their "/" is no share) equal, hold or sit inside `home`? */
export function homeOverlapsOther(home: string, except?: string): boolean {
  return allUsers().some(u => u.role !== 'admin' && u.username !== except && overlaps(u.homedir, home))
}
/** a manager may only start a home that is new: nothing there yet (in any letter case) and no other account's folder near it */
export function homeIsTaken(username: string): boolean {
  const home = defaultHome(username)
  if (homeOverlapsOther(home)) return true
  const abs = resolveIn(config.storageDir, home)
  if (existsSync(abs)) return true
  try {
    return readdirSync(dirname(abs)).some(n => n.toLowerCase() === username.toLowerCase())
  } catch { return false }
}

/**
 * May `actor` change `target` (and, for the user:<name> space, read their files)? An admin: anyone. A manager: only
 * a plain user whose folder is their own /users/<name>, so a shared or odd folder an admin gave out stays admin-only. The folder must also be the target's alone: when
 * another account's home is the same, inside it or above it, whoever can write there could reach the other's files.
 * Nobody else, and never the manager themself.
 */
export function canManage(actor: User | null | undefined, target: User | null | undefined): boolean {
  if (!actor || !target) return false
  if (actor.role === 'admin') return true
  return actor.role === 'manager' && target.role === 'user' && target.homedir === defaultHome(target.username)
    && !homeOverlapsOther(target.homedir, target.username)
}

export type User = {
  username: string
  name: string
  role: Role
  /** folder (relative to storage) that is the user's own space */
  homedir: string
  permissions: Perm[]
  /** what the user may do in the public folder (empty = no access to it) */
  publicPermissions: Perm[]
  passwordHash: string
  mustChangePassword?: boolean
  /** bytes the home space may hold; absent or 0 = no limit (quota.ts) */
  quotaBytes?: number
  createdAt: string
  lastLogin?: string
  /** optional second step of the sign-in; the secret is sealed (secret-box.ts) and never leaves the server */
  twoFactor?: { secret: string; enabledAt: string; lastStep: number; backup: string[] }
}

const userStore = new JsonStore<{ users: User[] }>(paths.users, () => ({ users: [] }), { onCorrupt: 'fail' })

export const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/
/** visitors' uploads and audit entries go under the owner name 'guest': an account by that name would share them */
export const isReservedUsername = (username: string) => username.toLowerCase() === 'guest'

export const allUsers = () => userStore.value.users
export const findUser = (username: string) =>
  userStore.value.users.find(u => u.username.toLowerCase() === username.toLowerCase())

export const publicUser = (u: User) => ({
  username: u.username,
  name: u.name,
  role: u.role,
  homedir: u.homedir,
  permissions: u.permissions,
  publicPermissions: u.publicPermissions,
  mustChangePassword: !!u.mustChangePassword,
  quotaBytes: u.quotaBytes ?? 0,
  createdAt: u.createdAt,
  lastLogin: u.lastLogin ?? null,
  twoFactor: !!u.twoFactor,
  twoFactorSince: u.twoFactor?.enabledAt ?? null,
})

export const hashPassword = (pw: string) => Bun.password.hash(pw)

export const PASSWORD_MIN_LENGTH = 10

/** for new passwords only: passwords set before these rules keep working at login */
export function checkPasswordStrength(pw: unknown, username: string): string {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN_LENGTH) throw bad('auth.password-too-short', { min: PASSWORD_MIN_LENGTH })
  if (pw.length > 200) throw bad('auth.password-too-long')
  const lower = pw.toLowerCase()
  if (lower.includes(username.toLowerCase())) throw bad('auth.password-has-username')
  if (COMMON_PASSWORDS.has(lower)) throw bad('auth.password-common')
  if (isRunOrRepeat(lower)) throw bad('auth.password-pattern')
  return pw
}

export function saveUsers() {
  userStore.save()
}

const DUMMY_HASH = await Bun.password.hash('not-a-real-password')

/** verifies credentials in roughly constant time, whether or not the user exists */
export async function verifyLogin(username: string, password: string): Promise<User | null> {
  const user = findUser(username)
  const ok = await Bun.password.verify(password, user?.passwordHash ?? DUMMY_HASH).catch(() => false)
  return user && ok ? user : null
}

/** First start: create the admin account and tell the operator the password once. */
export async function bootstrapAdmin() {
  if (userStore.value.users.length) return
  const generated = !config.adminPassword
  const password = config.adminPassword || randomBytes(9).toString('base64url')
  userStore.update(d => {
    d.users.push({
      username: 'admin',
      name: 'ผู้ดูแลระบบ',
      role: 'admin',
      homedir: '/',
      permissions: [...PERMISSIONS],
      publicPermissions: [...PERMISSIONS],
      passwordHash: '',
      mustChangePassword: generated,
      createdAt: new Date().toISOString(),
    })
  })
  userStore.value.users[0].passwordHash = await hashPassword(password)
  userStore.save()
  log.info('admin-created', 'สร้างบัญชีผู้ดูแลระบบครั้งแรกแล้ว (ชื่อผู้ใช้ admin)')
  // the password is shown on stdout only (docker compose logs), never written to logs/system.log
  console.log('')
  console.log('  ── สร้างบัญชีผู้ดูแลระบบครั้งแรกแล้ว ──')
  console.log('  ชื่อผู้ใช้: admin')
  console.log(`  รหัสผ่าน:  ${generated ? password : '(ตามค่า ADMIN_PASSWORD)'}`)
  if (generated) console.log('  (ระบบจะให้เปลี่ยนรหัสผ่านทันทีที่เข้าสู่ระบบ)')
  console.log('')
}

export function cleanHomedir(input: unknown, username: string): string {
  const p = input === undefined || input === '' ? defaultHome(username) : normRel(input)
  // inside the public folder the user would get full rights there through their own space
  const pub = `/${config.publicDirName}`
  if (p === pub || p.startsWith(`${pub}/`)) throw bad('admin.home-in-public')
  return p
}

// ───────────────────────────── sessions ─────────────────────────────

export type Session = {
  /** shown in the device list and used to end that session; not the sid and not derived from it */
  id: string
  csrf: string
  username: string | null
  created: number
  seen: number
  ip?: string
  ua?: string
}

// Signed-in sessions are saved to disk and survive restarts. Visitors only carry a CSRF token, so their
// sessions stay in memory, expire quickly and are capped; bots can not fill the disk with them.
const sessionStore = new JsonStore<Record<string, Session>>(paths.sessions, () => ({}))
const newSessionId = () => randomBytes(16).toString('base64url')
/** sessions saved before the device list have no id: they get one when read, nobody is signed out for it */
function ensureSessionIds() {
  let changed = false
  for (const s of Object.values(sessionStore.value)) {
    if (!s.id) { s.id = newSessionId(); changed = true }
  }
  if (changed) sessionStore.save()
}
ensureSessionIds()
const anonymous = new Map<string, Session>()
const ANON_TTL_MS = 6 * 3600_000
const ANON_MAX = 5000
const sidKey = (sid: string) => createHash('sha256').update(sid).digest('hex')
const ttlOf = (s: Session) => (s.username ? config.sessionTtlMs : ANON_TTL_MS)

export function createSession(username: string | null, meta: { ip?: string; ua?: string } = {}): { sid: string; session: Session } {
  const sid = randomBytes(32).toString('base64url')
  const session: Session = {
    id: newSessionId(), csrf: randomBytes(24).toString('base64url'), username, created: Date.now(), seen: Date.now(),
    ...(meta.ip ? { ip: meta.ip } : {}), ...(meta.ua ? { ua: meta.ua.slice(0, 200) } : {}),
  }
  if (username) {
    sessionStore.update(d => { d[sidKey(sid)] = session })
  } else {
    if (anonymous.size >= ANON_MAX) {
      // Map keeps insertion order, so the first keys are the oldest
      for (const k of [...anonymous.keys()].slice(0, Math.floor(ANON_MAX / 10))) anonymous.delete(k)
    }
    anonymous.set(sidKey(sid), session)
  }
  return { sid, session }
}

export function getSession(sid: string | undefined): Session | null {
  if (!sid) return null
  const key = sidKey(sid)
  const s = sessionStore.value[key] ?? anonymous.get(key)
  if (!s) return null
  if (Date.now() - s.seen > ttlOf(s)) {
    destroySession(sid)
    return null
  }
  if (!s.username) return s
  if (Date.now() - s.seen > 5 * 60_000) {
    s.seen = Date.now()
    sessionStore.save()
  }
  return s
}

export function destroySession(sid: string | undefined) {
  if (!sid) return
  const key = sidKey(sid)
  anonymous.delete(key)
  if (sessionStore.value[key]) sessionStore.update(d => { delete d[key] })
}

/** drop every session of a user (password change, account deleted) except an optional kept one; how many went */
export function destroyUserSessions(username: string, keepSid?: string): number {
  const keep = keepSid ? sidKey(keepSid) : null
  let n = 0
  sessionStore.update(d => {
    for (const [k, s] of Object.entries(d)) {
      if (s.username?.toLowerCase() === username.toLowerCase() && k !== keep) { delete d[k]; n++ }
    }
  })
  return n
}

/** the signed-in sessions of a user, newest first, for the device list (never the sid) */
export function listUserSessions(username: string, currentSid?: string) {
  const cur = currentSid ? sidKey(currentSid) : null
  return Object.entries(sessionStore.value)
    .filter(([, s]) => s.username?.toLowerCase() === username.toLowerCase())
    .sort((a, b) => b[1].created - a[1].created)
    .map(([k, s]) => ({ id: s.id, ip: s.ip ?? 'unknown', ua: s.ua ?? 'unknown', created: s.created, seen: s.seen, current: k === cur }))
}

/** end one session of this user by its id; null when the user has none like it, else whether it was `currentSid` */
export function destroySessionById(username: string, id: string, currentSid?: string): { current: boolean } | null {
  const hit = Object.entries(sessionStore.value).find(([, s]) => s.id === id && s.username?.toLowerCase() === username.toLowerCase())
  if (!hit) return null
  sessionStore.update(d => { delete d[hit[0]] })
  return { current: !!currentSid && hit[0] === sidKey(currentSid) }
}

// The command line tool (cli.ts) is another process: it changes users.json / sessions.json and then touches
// cli-changed. The running app notices that on its next request and reads both files again.
const markerStamp = () => { try { return String(statSync(paths.cliChanged).mtimeMs) } catch { return '' } }
let seenMarker = markerStamp()
export function reloadIfChangedByCli() {
  const now = markerStamp()
  if (now === seenMarker) return
  seenMarker = now
  try {
    userStore.replace(JSON.parse(readFileSync(paths.users, 'utf8')))
    sessionStore.replace(existsSync(paths.sessions) ? JSON.parse(readFileSync(paths.sessions, 'utf8')) : {})
    ensureSessionIds()
  } catch (err) {
    log.error('cli-reload-failed', err)
  }
}

export function purgeExpiredSessions() {
  const now = Date.now()
  sessionStore.update(d => {
    for (const [k, s] of Object.entries(d)) if (now - s.seen > config.sessionTtlMs) delete d[k]
  })
  for (const [k, s] of anonymous) if (now - s.seen > ANON_TTL_MS) anonymous.delete(k)
}

// ───────────────────────────── two-factor sign-in ─────────────────────────────

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const BACKUP_CODE_RE = /^[a-z0-9]{4}-[a-z0-9]{4}$/
const BACKUP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const BACKUP_CODES = 10

/** 10 new backup codes: the plain codes (shown once) and what is kept (their hashes) */
export function newBackupCodes() {
  const part = () => Array.from(randomBytes(4), b => BACKUP_ALPHABET[b % BACKUP_ALPHABET.length]).join('')
  const codes = Array.from({ length: BACKUP_CODES }, () => `${part()}-${part()}`)
  return { codes, hashes: codes.map(sha256) }
}

/** a secret waiting for its first code, per user (memory only: an unfinished setup leaves nothing behind) */
const pending = new Map<string, { secret: string; until: number }>()
const PENDING_MS = 10 * 60_000

export function startTwoFactorSetup(user: User): string {
  const secret = newTotpSecret()
  pending.set(user.username.toLowerCase(), { secret, until: Date.now() + PENDING_MS })
  return secret
}

/** finishes the setup when the code fits the pending secret (null: no setup or wrong code); the backup codes are shown once */
export function finishTwoFactorSetup(user: User, code: string): string[] | null {
  const p = pending.get(user.username.toLowerCase())
  if (!p || p.until < Date.now()) return null
  const step = verifyTotp(p.secret, code.replace(/\s/g, ''))
  if (step === null) return null
  pending.delete(user.username.toLowerCase())
  const { codes, hashes } = newBackupCodes()
  user.twoFactor = { secret: seal(p.secret), enabledAt: new Date().toISOString(), lastStep: step, backup: hashes }
  saveUsers()
  return codes
}

export const hasPendingSetup = (user: User) => {
  const p = pending.get(user.username.toLowerCase())
  return !!p && p.until >= Date.now()
}

/**
 * A TOTP code (once per step: nothing at or before the last used step) or a backup code (removed when used).
 * Anything that can not be checked (a damaged secret) counts as wrong.
 */
export function checkSecondFactor(user: User, input: string): boolean {
  const tf = user.twoFactor
  if (!tf) return false
  const code = input.trim().toLowerCase().replace(/\s/g, '')
  if (BACKUP_CODE_RE.test(code)) {
    const h = sha256(code)
    if (!tf.backup.includes(h)) return false
    tf.backup = tf.backup.filter(x => x !== h)
    saveUsers()
    return true
  }
  let secret: string
  try { secret = open(tf.secret) } catch (err) { log.error('2fa-secret-unreadable', { user: user.username, error: (err as Error).message }); return false }
  const step = verifyTotp(secret, code, tf.lastStep)
  if (step === null) return false
  tf.lastStep = step
  saveUsers()
  return true
}

// Between the password and the code of a sign-in: a ticket, kept only as a hash, for one user and one address
type Ticket = { username: string; ip: string; until: number }
const tickets = new Map<string, Ticket>()
const TICKET_MS = 5 * 60_000
const TICKETS_PER_USER = 5
const TICKETS_MAX = 5000

export function createLoginTicket(username: string, ip: string): string {
  const now = Date.now()
  for (const [k, t] of tickets) if (t.until < now) tickets.delete(k)
  const mine = [...tickets.entries()].filter(([, t]) => t.username === username)
  // Map keeps insertion order: the oldest of this user's tickets go first
  for (const [k] of mine.slice(0, Math.max(0, mine.length - TICKETS_PER_USER + 1))) tickets.delete(k)
  if (tickets.size >= TICKETS_MAX) tickets.delete(tickets.keys().next().value!)
  const ticket = randomBytes(24).toString('base64url')
  tickets.set(sha256(ticket), { username, ip, until: now + TICKET_MS })
  return ticket
}

/** the username a ticket was made for, when it is still valid and asked for from the same address; does not use it up */
export function peekLoginTicket(ticket: string, ip: string): string | null {
  const t = tickets.get(sha256(ticket))
  if (!t || t.until < Date.now() || t.ip !== ip) return null
  return t.username
}

export const useLoginTicket = (ticket: string) => tickets.delete(sha256(ticket))

export function dropLoginTickets(username: string) {
  for (const [k, t] of tickets) if (t.username.toLowerCase() === username.toLowerCase()) tickets.delete(k)
}

// ───────────────────────────── login lockout ─────────────────────────────

// per "ip|username": failures within the lockout window, and when the lockout ends
const attempts = new Map<string, { count: number; until: number; last: number; first: number; lockMs: number; keepMs: number }>()
const ATTEMPTS_MAX = 10_000

/** how many failures lock a key, and for how long; logins use LOGIN_MAX_ATTEMPTS / LOGIN_LOCKOUT_SECONDS */
export type Lockout = { max: number; lockMs: number; /** failures older than this are forgotten (default: the lockout time) */ windowMs?: number }
const loginLockout = (): Lockout => ({ max: config.loginMaxAttempts, lockMs: config.loginLockoutMs })

export function lockedFor(key: string): number {
  const a = attempts.get(key)
  return a && a.until > Date.now() ? Math.ceil((a.until - Date.now()) / 1000) : 0
}

/** count a wrong password; true when this one locks the key (the caller sends the alert, it knows what was locked) */
export function recordFailure(key: string, limits: Lockout = loginLockout()): boolean {
  if (attempts.size >= ATTEMPTS_MAX) pruneLoginAttempts()
  const now = Date.now()
  const keepMs = Math.max(limits.lockMs, limits.windowMs ?? 0)
  const a = attempts.get(key) ?? { count: 0, until: 0, last: now, first: now, lockMs: limits.lockMs, keepMs }
  if ((a.until && a.until <= now) || (limits.windowMs && !a.until && now - a.first > limits.windowMs)) { a.count = 0; a.until = 0 }
  if (a.count === 0) a.first = now
  a.count++
  a.last = now
  a.lockMs = limits.lockMs
  a.keepMs = keepMs
  const locks = a.count >= limits.max && !a.until
  if (a.count >= limits.max) a.until = now + limits.lockMs
  attempts.set(key, a)
  return locks
}

export const clearFailures = (key: string) => attempts.delete(key)

// Wider nets than ip|user, which one address defeats by changing the username and one account defeats by changing the
// address: all failures of an account (any address), and all failures of an address (any username).
const wide = (max: number): Lockout => ({ max, lockMs: config.loginWideWindowMs, windowMs: config.loginWideWindowMs })
const accountKey = (kind: 'login' | '2fa', username: string) => `${kind}-account|${username.toLowerCase()}`
const addressKey = (ip: string) => `login-address|${ip}`

/** seconds a sign-in must wait because of the account-wide or address-wide counter (0 = free); a right password does not skip it */
export const wideLoginWait = (username: string, ip: string): number =>
  Math.max(lockedFor(accountKey('login', username)), lockedFor(addressKey(ip)))
export const wideCodeWait = (username: string): number => lockedFor(accountKey('2fa', username))

/** count a wrong password in both wide nets; says which of them this failure locked */
export function recordWideLoginFailure(username: string, ip: string): { account: boolean; address: boolean } {
  return {
    account: recordFailure(accountKey('login', username), wide(config.loginAccountMaxAttempts)),
    address: recordFailure(addressKey(ip), wide(config.loginAddressMaxAttempts)),
  }
}
export const recordWideCodeFailure = (username: string): boolean =>
  recordFailure(accountKey('2fa', username), wide(config.loginAccountMaxAttempts))

/** forget lockouts that ended and failures older than the lockout window; returns how many were dropped */
export function pruneLoginAttempts(): number {
  const now = Date.now()
  let n = 0
  for (const [k, a] of attempts) {
    if (a.until ? a.until <= now : now - a.last > a.keepMs) {
      attempts.delete(k)
      n++
    }
  }
  return n
}

/**
 * Installing code or restoring a backup are the most powerful things an admin can do, so a stolen session
 * cookie is not enough: the password is asked again, and wrong guesses are rate limited like a login.
 * Every step-up shares one counter, so guesses can not be spread over several actions.
 */
export async function confirmPassword(
  user: User, ip: string, password: string, deniedAction: string,
  /** the answer to a wrong password (the password change keeps its own message and status) */
  wrong: () => HttpError = () => new HttpError(403, 'auth.wrong-password'),
) {
  const key = `step-up|${ip}|${user.username.toLowerCase()}`
  const wait = lockedFor(key)
  if (wait) throw new HttpError(429, 'auth.confirm-locked', { seconds: wait })
  if (!(await Bun.password.verify(password, user.passwordHash).catch(() => false))) {
    if (recordFailure(key)) alert('lockout', 'admin.alert-confirm-locked', { user: user.username, ip })
    audit({ user: user.username, ip, action: deniedAction })
    throw wrong()
  }
  clearFailures(key)
}

// ───────────────────────────── access ─────────────────────────────

export type Space = 'home' | 'public'
/** `user:<username>`: read-only view of the home of a user the caller manages (accessFor) */
/** `grant:<id>`: a folder another user shares with the caller (grants.ts) */
export type AnySpace = Space | `user:${string}` | `grant:${string}`
export const USER_SPACE = 'user:'

export type Access = {
  space: AnySpace
  root: string
  perms: Set<Perm>
  /** set for a grant space: the user whose home holds the folder, so what is written there counts against their quota */
  quotaOwner?: User
}

/** a space that shows someone else's files (a staff view or a grant): looking into it leaves a line in the audit trail */
export const isForeignSpace = (space: string) => space.startsWith(USER_SPACE) || space.startsWith(GRANT_SPACE)

/** Which part of the storage may this visitor see for the given space, and with which rights. */
export function accessFor(user: User | null, space: unknown): Access | null {
  if (typeof space === 'string' && space.startsWith(USER_SPACE)) return userSpace(user, space)
  if (typeof space === 'string' && space.startsWith(GRANT_SPACE)) return grantSpace(user, space)
  if (space !== 'home' && space !== 'public') return null
  if (!user) {
    if (space !== 'public' || !settings.get().publicEnabled) return null
    return { space, root: paths.publicDir, perms: new Set(settings.get().guestPermissions) }
  }
  if (space === 'public') {
    const perms = user.role === 'admin' ? PERMISSIONS : user.publicPermissions
    return perms.length ? { space, root: paths.publicDir, perms: new Set(perms) } : null
  }
  const root = user.role === 'admin' ? config.storageDir : resolveIn(config.storageDir, normRel(user.homedir))
  ensureDir(root)
  return { space, root, perms: new Set(user.role === 'admin' ? PERMISSIONS : user.permissions) }
}

/** what a manager (or admin) may do in a managed user's home: look and take a copy, never change */
const VIEW_PERMS: Perm[] = ['read', 'download', 'batchdownload', 'zip']

function userSpace(user: User | null, space: string): Access | null {
  const target = findUser(space.slice(USER_SPACE.length))
  if (!user || !target || !canManage(user, target)) return null
  const root = resolveIn(config.storageDir, normRel(target.homedir))
  if (!existsSync(root) || !statSync(root).isDirectory()) return null
  // the name as stored, so `user:BOB` and `user:bob` are one space
  return { space: `${USER_SPACE}${target.username}`, root, perms: new Set(VIEW_PERMS) }
}

export { cleanPerms }
