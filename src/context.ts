import { Elysia } from 'elysia'
import { accessFor, getSession, type Access, type Session, type User, findUser } from './auth'
import { forbidden, HttpError } from './fsx'
import type { Perm } from './settings'

export const SESSION_COOKIE = 'fc_sid'
const TRUST_PROXY = process.env.TRUST_PROXY === 'true'

/** Per-request context: who is calling, their session, and uniform JSON errors. */
export const context = new Elysia({ name: 'context' })
  .error({ HTTP_ERROR: HttpError })
  .onError({ as: 'global' }, ({ error, code, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status
      return { error: error.message, code: error.code }
    }
    if (code === 'VALIDATION') {
      set.status = 422
      return { error: 'ข้อมูลที่ส่งมาไม่ถูกต้อง' }
    }
    if (code === 'NOT_FOUND') {
      set.status = 404
      return { error: 'ไม่พบหน้าที่ต้องการ' }
    }
    if (code === 'PARSE') {
      set.status = 400
      return { error: 'อ่านข้อมูลที่ส่งมาไม่ได้' }
    }
    console.error('[error]', error)
    set.status = 500
    return { error: 'เกิดข้อผิดพลาดภายในระบบ' }
  })
  .derive({ as: 'global' }, ({ cookie, request, server }) => {
    const sid = cookie[SESSION_COOKIE]?.value as string | undefined
    const session: Session | null = getSession(sid)
    const user: User | null = session?.username ? findUser(session.username) ?? null : null
    let ip = server?.requestIP(request)?.address ?? 'unknown'
    if (TRUST_PROXY) ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || ip
    return { sid, session, user, ip }
  })
  .onBeforeHandle({ as: 'global' }, ({ request, session }) => {
    // CSRF: every state-changing call must carry the token issued with the session
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return
    const token = request.headers.get('x-csrf-token')
    if (!session || !token || token !== session.csrf) throw new HttpError(403, 'โทเคนความปลอดภัยไม่ถูกต้อง กรุณารีเฟรชหน้าเว็บ', 'csrf')
  })

export type Caller = { user: User | null; ip: string }

export function requireUser(c: Caller): User {
  if (!c.user) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ')
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
    throw c.user ? forbidden() : new HttpError(401, 'กรุณาเข้าสู่ระบบ')
  }
  return access
}
