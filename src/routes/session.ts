import { Elysia, t } from 'elysia'
import { alert } from '../alerts'
import { audit } from '../audit'
import {
  accessFor, checkPasswordStrength, checkSecondFactor, clearFailures, confirmPassword, createLoginTicket, createSession,
  destroySession, destroySessionById, destroyUserSessions, finishTwoFactorSetup, findUser, hasPendingSetup, hashPassword,
  listUserSessions, lockedFor, newBackupCodes, PASSWORD_MIN_LENGTH, peekLoginTicket, publicUser, recordFailure, recordWideCodeFailure,
  recordWideLoginFailure, saveUsers, startTwoFactorSetup, useLoginTicket, verifyLogin, wideCodeWait, wideLoginWait, type Session, type User,
} from '../auth'
import { config } from '../config'
import { context, requireUser, SESSION_COOKIE } from '../context'
import { HttpError, notFound } from '../fsx'
import { type Lang, langOf } from '../messages'
import { officeClientConfig } from '../office'
import { pageTexts, settings } from '../settings'
import { allowedShareDays } from '../shares'
import { otpauthUri } from '../totp'

/** cookies take whole seconds: SESSION_TTL_HOURS=0.0001 must not break every response */
const cookieMaxAge = () => Math.max(1, Math.floor(config.sessionTtlMs / 1000))

function appConfig(user: User | null, lang: Lang) {
  const s = settings.get()
  return {
    // visitors do not need to know which version (and so which known holes) is running
    ...(user ? { version: config.version } : {}),
    // the expiry choices of the share dialog (SHARE_MAX_DAYS may leave out the longer ones); visitors cannot share
    ...(user ? { shareDays: allowedShareDays() } : {}),
    // whether the page shows "open in the office editor", and for which file types; visitors can not use it
    ...(user ? { office: officeClientConfig() } : {}),
    appName: s.appName,
    primaryColor: s.primaryColor,
    // left empty by the admin: the standard text in the visitor's language
    ...pageTexts(lang),
    publicEnabled: s.publicEnabled,
    logo: s.logo,
    uploadMaxSize: config.uploadMaxSize,
    uploadChunkSize: config.uploadChunkSize,
    uploadSimultaneous: config.uploadSimultaneous,
    trashRetentionDays: config.trashRetentionDays,
    passwordMinLength: PASSWORD_MIN_LENGTH,
  }
}

/** the browser behind a request, as far as it says (cut short: it is shown in the device list) */
const userAgent = (request: Request) => (request.headers.get('user-agent') ?? '').slice(0, 200)

/** what a successful sign-in does, with or without the second step */
function signIn(user: User, { cookie, sid, ip, request }: { cookie: any; sid: string | undefined; ip: string; request: Request }) {
  destroySession(sid) // new id on every login
  const { sid: newSid, session } = createSession(user.username, { ip, ua: userAgent(request) })
  cookie[SESSION_COOKIE].set({
    value: newSid, httpOnly: true, sameSite: 'lax', path: '/',
    secure: config.secureCookie, maxAge: cookieMaxAge(),
  })
  user.lastLogin = new Date().toISOString()
  saveUsers()
  audit({ user: user.username, ip, action: 'login' })
  return snapshot(user, session, langOf(request))
}

// A failed sign-in is written to the audit log at most once a minute per key, with how many there were since the last
// line: guessing at full speed must not be able to fill (and rotate away) the trail
const FAIL_LOG_MS = 60_000
const FAIL_LOG_MAX = 5000
const failLog = new Map<string, { at: number; skipped: number }>()

function auditFailure(key: string, entry: { user: string; ip: string; action: string }) {
  const now = Date.now()
  const prev = failLog.get(key)
  if (prev && now - prev.at < FAIL_LOG_MS) { prev.skipped++; return }
  if (failLog.size >= FAIL_LOG_MAX) for (const [k, v] of failLog) if (now - v.at >= FAIL_LOG_MS) failLog.delete(k)
  if (failLog.size >= FAIL_LOG_MAX) failLog.clear()
  failLog.set(key, { at: now, skipped: 0 })
  audit({ ...entry, detail: `${(prev?.skipped ?? 0) + 1} ครั้ง` })
}

/** wrong codes of the 2FA management calls share one counter per user and address, with the login limits */
const codeKey = (ip: string, user: User) => `2fa-step-up|${ip}|${user.username.toLowerCase()}`

function wrongCode(user: User, ip: string): never {
  if (recordFailure(codeKey(ip, user))) alert('lockout', 'admin.alert-2fa-locked', { user: user.username, ip })
  audit({ user: user.username, ip, action: '2fa-code-denied' })
  throw new HttpError(403, 'auth.two-factor-bad-code')
}

function notLockedForCodes(user: User, ip: string) {
  const wait = lockedFor(codeKey(ip, user))
  if (wait) throw new HttpError(429, 'auth.confirm-locked', { seconds: wait })
}

/** password and a current code (or a backup code) of a user who has 2FA on */
async function confirmWithCode(user: User, ip: string, password: string, code: string) {
  if (!user.twoFactor) throw new HttpError(400, 'auth.two-factor-not-enabled')
  notLockedForCodes(user, ip)
  await confirmPassword(user, ip, password, '2fa-password-denied')
  if (!checkSecondFactor(user, code)) wrongCode(user, ip)
  clearFailures(codeKey(ip, user))
}

function snapshot(user: User | null, session: Session, lang: Lang) {
  const spaces: Record<string, string[]> = {}
  for (const space of ['home', 'public'] as const) {
    const a = accessFor(user, space)
    if (a) spaces[space] = [...a.perms]
  }
  return { csrf: session.csrf, user: user ? publicUser(user) : null, spaces, config: appConfig(user, lang) }
}

export const sessionRoutes = new Elysia({ prefix: '/api' })
  .use(context)

  // Always answers: hands out the session cookie + CSRF token and tells the app who is logged in.
  .get('/session', ({ cookie, session, user, request }) => {
    let s = session
    if (!s) {
      const created = createSession(null)
      s = created.session
      cookie[SESSION_COOKIE].set({
        value: created.sid, httpOnly: true, sameSite: 'lax', path: '/',
        secure: config.secureCookie, maxAge: cookieMaxAge(),
      })
    }
    return snapshot(user, s, langOf(request))
  })

  .post('/login', { body: t.Object({ username: t.String({ maxLength: 64 }), password: t.String({ maxLength: 1000 }) }) }, async ({ cookie, sid, ip, body, request }) => {
    const username = body.username.trim()
    const key = `${ip}|${username.toLowerCase()}`
    // checked before the password: a right one does not skip the wait
    const wait = Math.max(lockedFor(key), wideLoginWait(username, ip))
    if (wait) throw new HttpError(429, 'auth.locked', { seconds: wait })
    const user = await verifyLogin(username, body.password)
    if (!user) {
      if (recordFailure(key)) alert('lockout', 'admin.alert-login-locked', { user: username || '-', ip })
      const wideLock = recordWideLoginFailure(username, ip)
      if (wideLock.account) alert('lockout', 'admin.alert-account-locked', { user: username || '-', ip })
      if (wideLock.address) alert('lockout', 'admin.alert-address-locked', { ip })
      auditFailure(key, { user: username || '-', ip, action: 'login-failed' })
      throw new HttpError(401, 'auth.bad-credentials')
    }
    clearFailures(key)
    // the right password is not enough for an account with 2FA: no session until /login/2fa has the code
    if (user.twoFactor) return { twoFactor: true, ticket: createLoginTicket(user.username, ip) }
    return signIn(user, { cookie, sid, ip, request })
  })

  .post('/login/2fa', { body: t.Object({ ticket: t.String({ maxLength: 200 }), code: t.String({ maxLength: 50 }) }) }, ({ cookie, sid, ip, body, request }) => {
    const username = peekLoginTicket(body.ticket, ip)
    const user = username ? findUser(username) : undefined
    if (!username || !user?.twoFactor) throw new HttpError(401, 'auth.two-factor-bad-ticket')
    const key = `2fa|${ip}|${user.username.toLowerCase()}`
    const wait = Math.max(lockedFor(key), wideCodeWait(user.username))
    if (wait) throw new HttpError(429, 'auth.two-factor-locked', { seconds: wait })
    if (!checkSecondFactor(user, body.code)) {
      if (recordFailure(key)) alert('lockout', 'admin.alert-2fa-locked', { user: user.username, ip })
      if (recordWideCodeFailure(user.username)) alert('lockout', 'admin.alert-2fa-locked', { user: user.username, ip })
      audit({ user: user.username, ip, action: 'login-2fa-failed' })
      throw new HttpError(401, 'auth.two-factor-bad-code')
    }
    clearFailures(key)
    useLoginTicket(body.ticket)
    return signIn(user, { cookie, sid, ip, request })
  })

  // ───────────── signed-in devices ─────────────
  .get('/sessions', ({ user, ip, sid }) => {
    const u = requireUser({ user, ip })
    return { sessions: listUserSessions(u.username, sid) }
  })

  .post('/sessions/revoke-others', ({ user, ip, sid }) => {
    const u = requireUser({ user, ip })
    const revoked = destroyUserSessions(u.username, sid)
    audit({ user: u.username, ip, action: 'sessions-revoke-others', detail: String(revoked) })
    return { ok: true, revoked }
  })

  .delete('/sessions/:id', ({ cookie, sid, user, ip, params, request }) => {
    const u = requireUser({ user, ip })
    const gone = destroySessionById(u.username, params.id, sid)
    if (!gone) throw notFound('auth.session-not-found')
    audit({ user: u.username, ip, action: 'session-revoke' })
    if (!gone.current) return { ok: true }
    // it was this browser's own session: same as logging out
    const { sid: newSid, session } = createSession(null)
    cookie[SESSION_COOKIE].set({
      value: newSid, httpOnly: true, sameSite: 'lax', path: '/',
      secure: config.secureCookie, maxAge: cookieMaxAge(),
    })
    return snapshot(null, session, langOf(request))
  })

  // ───────────── two-factor sign-in ─────────────
  .post('/2fa/setup', { body: t.Object({ password: t.String({ maxLength: 1000 }) }) }, async ({ user, ip, body }) => {
    const u = requireUser({ user, ip })
    if (u.twoFactor) throw new HttpError(409, 'auth.two-factor-already-enabled')
    await confirmPassword(u, ip, body.password, '2fa-password-denied')
    const secret = startTwoFactorSetup(u)
    return { secret, uri: otpauthUri(secret, u.username, settings.get().appName) }
  })

  .post('/2fa/enable', { body: t.Object({ code: t.String({ maxLength: 50 }) }) }, ({ user, ip, sid, body }) => {
    const u = requireUser({ user, ip })
    if (u.twoFactor) throw new HttpError(409, 'auth.two-factor-already-enabled')
    if (!hasPendingSetup(u)) throw new HttpError(400, 'auth.two-factor-no-setup')
    notLockedForCodes(u, ip)
    const backupCodes = finishTwoFactorSetup(u, body.code)
    if (!backupCodes) wrongCode(u, ip)
    clearFailures(codeKey(ip, u))
    destroyUserSessions(u.username, sid) // other devices sign in again, now with the code
    audit({ user: u.username, ip, action: '2fa-enable' })
    return { backupCodes }
  })

  .post('/2fa/disable', { body: t.Object({ password: t.String({ maxLength: 1000 }), code: t.String({ maxLength: 50 }) }) }, async ({ user, ip, body }) => {
    const u = requireUser({ user, ip })
    await confirmWithCode(u, ip, body.password, body.code)
    delete u.twoFactor
    saveUsers()
    audit({ user: u.username, ip, action: '2fa-disable' })
    return { ok: true }
  })

  .post('/2fa/backup-codes', { body: t.Object({ password: t.String({ maxLength: 1000 }), code: t.String({ maxLength: 50 }) }) }, async ({ user, ip, body }) => {
    const u = requireUser({ user, ip })
    await confirmWithCode(u, ip, body.password, body.code)
    const { codes, hashes } = newBackupCodes()
    u.twoFactor!.backup = hashes
    saveUsers()
    audit({ user: u.username, ip, action: '2fa-backup-codes' })
    return { backupCodes: codes }
  })

  .post('/logout', ({ cookie, sid, user, ip, request }) => {
    if (user) audit({ user: user.username, ip, action: 'logout' })
    destroySession(sid)
    const { sid: newSid, session } = createSession(null)
    cookie[SESSION_COOKIE].set({
      value: newSid, httpOnly: true, sameSite: 'lax', path: '/',
      secure: config.secureCookie, maxAge: cookieMaxAge(),
    })
    return snapshot(null, session, langOf(request))
  })

  .post('/password', { body: t.Object({ current: t.String({ maxLength: 1000 }), next: t.String({ maxLength: 1000 }) }) }, async ({ user, ip, sid, body }) => {
    const u = requireUser({ user, ip })
    // wrong guesses count in the step-up lockout (a stolen session must not be able to guess the password at will)
    await confirmPassword(u, ip, body.current, 'password-denied', () => new HttpError(400, 'auth.wrong-current-password'))
    checkPasswordStrength(body.next, u.username)
    u.passwordHash = await hashPassword(body.next)
    u.mustChangePassword = false
    saveUsers()
    destroyUserSessions(u.username, sid)
    audit({ user: u.username, ip, action: 'password-change' })
    return { ok: true }
  })

export { findUser }
