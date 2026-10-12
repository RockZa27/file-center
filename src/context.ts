import { Elysia } from 'elysia'
import { accessFor, getSession, type Access, type Session, type User, findUser } from './auth'
import { config } from './config'
import { forbidden, fromFsError, HttpError } from './fsx'
import { log, safePath } from './logger'
import { type Lang, langOf, type MessageCode, type Params, text } from './messages'
import type { Perm } from './settings'

export const SESSION_COOKIE = 'fc_sid'
const PASSWORD_CHANGE_ROUTES = new Set(['/api/session', '/api/password', '/api/logout', '/api/health', '/api/branding/logo'])

function clientIp(request: Request, socketIp: string): string {
  if (config.trustProxy === 'cloudflare') return request.headers.get('cf-connecting-ip')?.trim() || socketIp
  if (config.trustProxy === 'true') return request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || socketIp
  return socketIp
}

// GET routes the page opens as plain links: the browser takes the whole tab there, so a failure must read as a page
const DOWNLOAD_ROUTES = [
  /^\/api\/download$/, /^\/api\/batch\/[^/]+$/, /^\/api\/admin\/logs\/download$/, /^\/api\/admin\/activity\/export$/,
  /^\/api\/admin\/backups\/[^/]+\/download$/,
]

/** the tab opening a download link, not the page's own fetch (which sends x-lang and reads the JSON) */
function isDownloadNavigation(request: Request): boolean {
  if (request.method !== 'GET') return false
  const h = request.headers
  const navigation = h.get('sec-fetch-mode') === 'navigate' || ((h.get('accept') ?? '').includes('text/html') && !h.has('x-lang'))
  return navigation && DOWNLOAD_ROUTES.some(r => r.test(new URL(request.url).pathname))
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

// no script at all, and nothing from the request is written into the page except the catalog text, escaped
const ERROR_PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  'Cache-Control': 'no-store',
}

/**
 * a small page for a failed download link: the message in the visitor's language, the status number and a way
 * back. The internal code is for tools, not readers: it goes in the X-Error-Code header.
 */
export function errorPage(status: number, lang: Lang, code: MessageCode, params: Params): Response {
  const message = escapeHtml(text(lang, code, params))
  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${message}</title>
<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:12vh auto;padding:0 1rem;line-height:1.6}h1{font-size:1.3rem}small{color:#777}</style>
</head>
<body>
<h1>${message}</h1>
<p><small>${status}</small></p>
<p><a href="/">${escapeHtml(text(lang, 'request.back-to-app'))}</a></p>
</body>
</html>
`
  return new Response(html, { status, headers: { ...ERROR_PAGE_HEADERS, 'X-Error-Code': code } })
}

/** Per-request context: who is calling, their session, and uniform JSON errors (a small page for download links). */
export const context = new Elysia({ name: 'context' })
  .error({ HTTP_ERROR: HttpError })
  .onError({ as: 'global' }, ({ error, code, set, request }) => {
    // the text in the visitor's language; the code and params let the page tell cases apart without reading it
    const answer = (status: number, c: MessageCode, params: Params = {}) => {
      if (isDownloadNavigation(request)) return errorPage(status, langOf(request), c, params)
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
