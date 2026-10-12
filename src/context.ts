import { Elysia } from 'elysia'
import { accessFor, getSession, type Access, type Session, type User, findUser } from './auth'
import { config } from './config'
import { forbidden, fromFsError, HttpError } from './fsx'
import { log, safePath } from './logger'
import { langOf, type MessageCode, type Params, text } from './messages'
import type { Perm } from './settings'

export const SESSION_COOKIE = 'fc_sid'
const PASSWORD_CHANGE_ROUTES = new Set(['/api/session', '/api/password', '/api/logout', '/api/health', '/api/branding/logo'])

function clientIp(request: Request, socketIp: string): string {
  if (config.trustProxy === 'cloudflare') return request.headers.get('cf-connecting-ip')?.trim() || socketIp
  if (config.trustProxy === 'true') return request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || socketIp
  return socketIp
}

/** Per-request context: who is calling, their session, and uniform JSON errors. */
export const context = new Elysia({ name: 'context' })
  .error({ HTTP_ERROR: HttpError })
  .onError({ as: 'global' }, ({ error, code, set, request }) => {
    // the text in the visitor's language; the code and params let the page tell cases apart without reading it
    const answer = (status: number, c: MessageCode, params: Params = {}) => {
      set.status = status
      return { error: text(langOf(request), c, params), code: c, params }
    }
    // file-system errors (disk full, name too long...) get a clear message instead of a 500 with server paths
    const known = fromFsError(error)
    if (known) {
      if (!(error instanceof HttpError)) log.warn('fs-error', { method: request.method, path: safePath(request.url), error: (error as Error).message.slice(0, 300) })
      return answer(known.status, known.code, known.params)
    }
    if (code === 'VALIDATION') return answer(422, 'request.invalid')
    if (code === 'NOT_FOUND') return answer(404, 'request.no-route')
    if (code === 'PARSE') return answer(400, 'request.unreadable')
    log.error('request-failed', { method: request.method, path: safePath(request.url), error })
    return answer(500, 'request.internal')
  })
  .derive({ as: 'global' }, ({ cookie, request, server }) => {
    const sid = cookie[SESSION_COOKIE]?.value as string | undefined
    const session: Session | null = getSession(sid)
    const user: User | null = session?.username ? findUser(session.username) ?? null : null
    const ip = clientIp(request, server?.requestIP(request)?.address ?? 'unknown')
    return { sid, session, user, ip }
  })
  .onBeforeHandle({ as: 'global' }, ({ request, session }) => {
    // CSRF: every state-changing call must carry the token issued with the session
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return
    const token = request.headers.get('x-csrf-token')
    if (!session || !token || token !== session.csrf) throw new HttpError(403, 'csrf')
  })
  .onBeforeHandle({ as: 'global' }, ({ request, user }) => {
    // an account with a handed-out password may only change it (or leave) before anything else
    if (!user?.mustChangePassword) return
    const { pathname } = new URL(request.url)
    if (pathname.startsWith('/api/') && !PASSWORD_CHANGE_ROUTES.has(pathname)) {
      throw new HttpError(403, 'must-change-password')
    }
  })

export type Caller = { user: User | null; ip: string }

export function requireUser(c: Caller): User {
  if (!c.user) throw new HttpError(401, 'auth.required')
  return c.user
}

export function requireAdmin(c: Caller): User {
  const u = requireUser(c)
  if (u.role !== 'admin') throw forbidden()
  return u
}

/** Resolve the space the caller asks for and check they hold every listed permission. */
export function need(c: Caller, space: unknown, ...perms: Perm[]): Access {
  const access = accessFor(c.user, space)
  if (!access || perms.some(p => !access.perms.has(p))) {
    throw c.user ? forbidden() : new HttpError(401, 'auth.required')
  }
  return access
}
