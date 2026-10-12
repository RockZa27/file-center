import { Elysia, t } from 'elysia'
import { audit } from '../audit'
import {
  accessFor, checkPasswordStrength, clearFailures, createSession, destroySession, destroyUserSessions,
  findUser, hashPassword, lockedFor, PASSWORD_MIN_LENGTH, publicUser, recordFailure, saveUsers, verifyLogin, type Session, type User,
} from '../auth'
import { config } from '../config'
import { context, requireUser, SESSION_COOKIE } from '../context'
import { HttpError } from '../fsx'
import { settings } from '../settings'

/** cookies take whole seconds: SESSION_TTL_HOURS=0.0001 must not break every response */
const cookieMaxAge = () => Math.max(1, Math.floor(config.sessionTtlMs / 1000))

function appConfig(user: User | null) {
  const s = settings.get()
  return {
    // visitors do not need to know which version (and so which known holes) is running
    ...(user ? { version: config.version } : {}),
    appName: s.appName,
    primaryColor: s.primaryColor,
    welcomeTitle: s.welcomeTitle,
    welcomeText: s.welcomeText,
    publicEmptyText: s.publicEmptyText,
    publicEnabled: s.publicEnabled,
    logo: s.logo,
    uploadMaxSize: config.uploadMaxSize,
    uploadChunkSize: config.uploadChunkSize,
    uploadSimultaneous: config.uploadSimultaneous,
    trashRetentionDays: config.trashRetentionDays,
    passwordMinLength: PASSWORD_MIN_LENGTH,
  }
}

function snapshot(user: User | null, session: Session) {
  const spaces: Record<string, string[]> = {}
  for (const space of ['home', 'public'] as const) {
    const a = accessFor(user, space)
    if (a) spaces[space] = [...a.perms]
  }
  return { csrf: session.csrf, user: user ? publicUser(user) : null, spaces, config: appConfig(user) }
}

export const sessionRoutes = new Elysia({ prefix: '/api' })
  .use(context)

  // Always answers: hands out the session cookie + CSRF token and tells the app who is logged in.
  .get('/session', ({ cookie, session, user }) => {
    let s = session
    if (!s) {
      const created = createSession(null)
      s = created.session
      cookie[SESSION_COOKIE].set({
        value: created.sid, httpOnly: true, sameSite: 'lax', path: '/',
        secure: config.secureCookie, maxAge: cookieMaxAge(),
      })
    }
    return snapshot(user, s)
  })

  .post('/login', async ({ cookie, sid, ip, body }) => {
    const username = body.username.trim()
    const key = `${ip}|${username.toLowerCase()}`
    const wait = lockedFor(key)
    if (wait) throw new HttpError(429, 'auth.locked', { seconds: wait })
    const user = await verifyLogin(username, body.password)
    if (!user) {
      recordFailure(key)
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
    return snapshot(user, session)
  }, { body: t.Object({ username: t.String({ maxLength: 64 }), password: t.String({ maxLength: 1000 }) }) })

  .post('/logout', ({ cookie, sid, user, ip }) => {
    if (user) audit({ user: user.username, ip, action: 'logout' })
    destroySession(sid)
    const { sid: newSid, session } = createSession(null)
    cookie[SESSION_COOKIE].set({
      value: newSid, httpOnly: true, sameSite: 'lax', path: '/',
      secure: config.secureCookie, maxAge: cookieMaxAge(),
    })
    return snapshot(null, session)
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
