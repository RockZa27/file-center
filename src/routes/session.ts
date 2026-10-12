import { Elysia, t } from 'elysia'
import { alert } from '../alerts'
import { audit } from '../audit'
import {
  accessFor, checkPasswordStrength, clearFailures, createSession, destroySession, destroyUserSessions,
  findUser, hashPassword, lockedFor, PASSWORD_MIN_LENGTH, publicUser, recordFailure, saveUsers, verifyLogin, type Session, type User,
} from '../auth'
import { config } from '../config'
import { context, requireUser, SESSION_COOKIE } from '../context'
import { HttpError } from '../fsx'
import { type Lang, langOf } from '../messages'
import { pageTexts, settings } from '../settings'
import { allowedShareDays } from '../shares'

/** cookies take whole seconds: SESSION_TTL_HOURS=0.0001 must not break every response */
const cookieMaxAge = () => Math.max(1, Math.floor(config.sessionTtlMs / 1000))

function appConfig(user: User | null, lang: Lang) {
  const s = settings.get()
  return {
    // visitors do not need to know which version (and so which known holes) is running
    ...(user ? { version: config.version } : {}),
    // the expiry choices of the share dialog (SHARE_MAX_DAYS may leave out the longer ones); visitors cannot share
    ...(user ? { shareDays: allowedShareDays() } : {}),
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

  .post('/login', async ({ cookie, sid, ip, body, request }) => {
    const username = body.username.trim()
    const key = `${ip}|${username.toLowerCase()}`
    const wait = lockedFor(key)
    if (wait) throw new HttpError(429, 'auth.locked', { seconds: wait })
    const user = await verifyLogin(username, body.password)
    if (!user) {
      if (recordFailure(key)) alert('lockout', 'admin.alert-login-locked', { user: username || '-', ip })
      audit({ user: username || '-', ip, action: 'login-failed' })
      throw new HttpError(401, 'auth.bad-credentials')
    }
    clearFailures(key)
    destroySession(sid) // new id on every login
    const { sid: newSid, session } = createSession(user.username)
    cookie[SESSION_COOKIE].set({
      value: newSid, httpOnly: true, sameSite: 'lax', path: '/',
      secure: config.secureCookie, maxAge: cookieMaxAge(),
    })
    user.lastLogin = new Date().toISOString()
    saveUsers()
    audit({ user: user.username, ip, action: 'login' })
    return snapshot(user, session, langOf(request))
  }, { body: t.Object({ username: t.String({ maxLength: 64 }), password: t.String({ maxLength: 1000 }) }) })

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

  .post('/password', async ({ user, ip, sid, body }) => {
    const u = requireUser({ user, ip })
    if (!(await Bun.password.verify(body.current, u.passwordHash))) throw new HttpError(400, 'auth.wrong-current-password')
    checkPasswordStrength(body.next, u.username)
    u.passwordHash = await hashPassword(body.next)
    u.mustChangePassword = false
    saveUsers()
    destroyUserSessions(u.username, sid)
    audit({ user: u.username, ip, action: 'password-change' })
    return { ok: true }
  }, { body: t.Object({ current: t.String({ maxLength: 1000 }), next: t.String({ maxLength: 1000 }) }) })

export { findUser }
