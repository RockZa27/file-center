import { createHash, randomBytes } from 'node:crypto'
import { config, paths } from './config'
import { bad, ensureDir, normRel, resolveIn } from './fsx'
import { cleanPerms, PERMISSIONS, settings, type Perm } from './settings'
import { JsonStore } from './store'

export type Role = 'admin' | 'user'

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
  createdAt: string
  lastLogin?: string
}

const userStore = new JsonStore<{ users: User[] }>(paths.users, () => ({ users: [] }), { onCorrupt: 'fail' })

export const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/

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
  createdAt: u.createdAt,
  lastLogin: u.lastLogin ?? null,
})

export const hashPassword = (pw: string) => Bun.password.hash(pw)

export function checkPasswordStrength(pw: unknown): string {
  if (typeof pw !== 'string' || pw.length < 8) throw bad('รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร')
  if (pw.length > 200) throw bad('รหัสผ่านยาวเกินไป')
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
  console.log('')
  console.log('  ── สร้างบัญชีผู้ดูแลระบบครั้งแรกแล้ว ──')
  console.log('  ชื่อผู้ใช้: admin')
  console.log(`  รหัสผ่าน:  ${generated ? password : '(ตามค่า ADMIN_PASSWORD)'}`)
  if (generated) console.log('  (ระบบจะให้เปลี่ยนรหัสผ่านทันทีที่เข้าสู่ระบบ)')
  console.log('')
}

export function cleanHomedir(input: unknown, username: string): string {
  const p = input === undefined || input === '' ? `/users/${username}` : normRel(input)
  // inside the public folder the user would get full rights there through their own space
  const pub = `/${config.publicDirName}`
  if (p === pub || p.startsWith(`${pub}/`)) throw bad('โฟลเดอร์ของผู้ใช้ต้องไม่อยู่ในโฟลเดอร์สาธารณะ')
  return p
}

// ───────────────────────────── sessions ─────────────────────────────

export type Session = { csrf: string; username: string | null; created: number; seen: number }

// Signed-in sessions are saved to disk and survive restarts. Visitors only carry a CSRF token, so their
// sessions stay in memory, expire quickly and are capped; bots can not fill the disk with them.
const sessionStore = new JsonStore<Record<string, Session>>(paths.sessions, () => ({}))
const anonymous = new Map<string, Session>()
const ANON_TTL_MS = 6 * 3600_000
const ANON_MAX = 5000
const sidKey = (sid: string) => createHash('sha256').update(sid).digest('hex')
const ttlOf = (s: Session) => (s.username ? config.sessionTtlMs : ANON_TTL_MS)

export function createSession(username: string | null): { sid: string; session: Session } {
  const sid = randomBytes(32).toString('base64url')
  const session: Session = { csrf: randomBytes(24).toString('base64url'), username, created: Date.now(), seen: Date.now() }
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

/** drop every session of a user (password change, account deleted) except an optional kept one */
export function destroyUserSessions(username: string, keepSid?: string) {
  const keep = keepSid ? sidKey(keepSid) : null
  sessionStore.update(d => {
    for (const [k, s] of Object.entries(d)) {
      if (s.username?.toLowerCase() === username.toLowerCase() && k !== keep) delete d[k]
    }
  })
}

export function purgeExpiredSessions() {
  const now = Date.now()
  sessionStore.update(d => {
    for (const [k, s] of Object.entries(d)) if (now - s.seen > config.sessionTtlMs) delete d[k]
  })
  for (const [k, s] of anonymous) if (now - s.seen > ANON_TTL_MS) anonymous.delete(k)
}

// ───────────────────────────── login lockout ─────────────────────────────

// per "ip|username": failures within the lockout window, and when the lockout ends
const attempts = new Map<string, { count: number; until: number; last: number }>()
const ATTEMPTS_MAX = 10_000

export function lockedFor(key: string): number {
  const a = attempts.get(key)
  return a && a.until > Date.now() ? Math.ceil((a.until - Date.now()) / 1000) : 0
}

export function recordFailure(key: string) {
  if (attempts.size >= ATTEMPTS_MAX) pruneLoginAttempts()
  const now = Date.now()
  const a = attempts.get(key) ?? { count: 0, until: 0, last: now }
  if (a.until && a.until <= now) { a.count = 0; a.until = 0 }
  a.count++
  a.last = now
  if (a.count >= config.loginMaxAttempts) a.until = now + config.loginLockoutMs
  attempts.set(key, a)
}

export const clearFailures = (key: string) => attempts.delete(key)

/** forget lockouts that ended and failures older than the lockout window; returns how many were dropped */
export function pruneLoginAttempts(): number {
  const now = Date.now()
  let n = 0
  for (const [k, a] of attempts) {
    if (a.until ? a.until <= now : now - a.last > config.loginLockoutMs) {
      attempts.delete(k)
      n++
    }
  }
  return n
}

// ───────────────────────────── access ─────────────────────────────

export type Space = 'home' | 'public'

export type Access = {
  space: Space
  root: string
  perms: Set<Perm>
}

/** Which part of the storage may this visitor see for the given space, and with which rights. */
export function accessFor(user: User | null, space: unknown): Access | null {
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

export { cleanPerms }
