import { existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { Elysia } from 'elysia'
import { startAlerts } from './alerts'
import { audit } from './audit'
import { bootstrapAdmin, pruneLoginAttempts, purgeExpiredSessions } from './auth'
import { backupDue, backupRunning, runBackup } from './backup'
import { config, ensureDirs } from './config'
import { context } from './context'
import { HttpError, notFound, within } from './fsx'
import { onStop, shutdown } from './lifecycle'
import { accessLine, log } from './logger'
import { adminRoutes } from './routes/admin'
import { backupRoutes } from './routes/backup'
import { fileRoutes } from './routes/files'
import { meRoutes } from './routes/me'
import { versionRoutes } from './routes/versions'
import { logRoutes } from './routes/logs'
import { officeRoutes } from './routes/office'
import { sessionRoutes } from './routes/session'
import { shareRoutes } from './routes/shares'
import { updateRoutes } from './routes/update'
import { uploadRoutes } from './routes/upload'
import { startSearchIndex, stopSearchIndex } from './search-index'
import { purgeExpiredShares } from './shares'
import { purgeExpired } from './trash'
import { purgeExpiredVersions } from './versions'
import { cleanStaleUploads } from './uploads'
import { officeConfig, officeOrigin } from './office'
import { cleanStaging, signingKey } from './updater'
import { sourceConfig } from './update-source'

ensureDirs()
await bootstrapAdmin()

// a bad key must not stop the app (the admin could not reach the update page to see why); packages are refused instead
const keyError = signingKey().error
if (keyError) log.error('update-key-invalid', `UPDATE_PUBLIC_KEY ไม่ถูกต้อง: ${keyError} ระบบจะไม่รับแพ็กเกจอัปเดตใด ๆ จนกว่าจะแก้ค่านี้`)
// the same for UPDATE_SOURCE: the app starts, checking for updates stays off
const source = sourceConfig()
if (source.error) log.warn('update-source-invalid', `UPDATE_SOURCE ${source.shown ?? ''} ไม่ถูกต้อง: ${source.error} ปิดการตรวจหาอัปเดตไว้จนกว่าจะแก้ค่านี้`)
// and for the office editor: a wrong OFFICE_* value keeps it off
const office = officeConfig()
if (office.error) log.warn('office-config-invalid', `ตั้งค่า ONLYOFFICE ไม่ถูกต้อง: ${office.error} ปิดการแก้ไขเอกสาร office ไว้จนกว่าจะแก้ค่านี้`)

function housekeeping() {
  try {
    const trash = purgeExpired()
    const versions = purgeExpiredVersions()
    const uploads = cleanStaleUploads()
    purgeExpiredSessions()
    cleanStaging()
    pruneLoginAttempts()
    if (trash || uploads || versions) log.info('housekeeping', { trash, staleUploads: uploads, versions })
    // runs in the background; the result goes to backup-status.json, which the dashboard shows
    if (backupDue() && !backupRunning()) {
      runBackup().then(
        b => audit({ user: 'system', ip: '-', action: 'backup-create', target: b.name, detail: 'อัตโนมัติ' }),
        () => { /* writeBackup logged it */ },
      )
    }
  } catch (err) {
    log.error('housekeeping-failed', err)
  }
}
housekeeping()
setInterval(housekeeping, 60 * 60 * 1000).unref()

// share links that ran out leave the store at start and once a day
function cleanShares() {
  try {
    const n = purgeExpiredShares()
    if (n) log.info('shares-cleaned', { expired: n })
  } catch (err) {
    log.error('shares-clean-failed', err)
  }
}
cleanShares()
setInterval(cleanShares, 24 * 60 * 60 * 1000).unref()

const bootedAt = Date.now()
const indexHtml = join(config.webDir, 'index.html')

// The page loads only its own files. Naive UI writes its styles into <style> tags (hence 'unsafe-inline' for
// styles only); previews use blob: URLs and frames of our own downloads. Downloads and the logo send their own,
// stricter policy: it is set on those responses only, never here. With ONLYOFFICE on (OFFICE_URL), the editor's
// script, its frame and its connections come from the document server's origin as well, and from nowhere else.
function webHeaders(): Record<string, string> {
  const office = officeOrigin()
  const plus = office ? ` ${office}` : ''
  return {
    'Content-Security-Policy': `default-src 'self'; script-src 'self'${plus}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; ` +
      `media-src 'self' blob:; font-src 'self' data:; connect-src 'self'${plus}; frame-src 'self'${plus}; object-src 'none'; base-uri 'self'; ` +
      "form-action 'self'; frame-ancestors 'self'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  }
}

function serveStatic(pathname: string): Response {
  const web = webHeaders()
  let decoded: string
  try { decoded = decodeURIComponent(pathname) } catch { return new Response('Bad request', { status: 400, headers: web }) }
  const abs = normalize(join(config.webDir, decoded))
  if (within(config.webDir, abs) && existsSync(abs) && statSync(abs).isFile()) {
    const immutable = decoded.startsWith('/assets/')
    return new Response(Bun.file(abs), {
      headers: { ...web, 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' },
    })
  }
  // a missing asset must stay a 404, any other path is a client-side route
  if (extname(decoded) && decoded !== '/') return new Response('Not found', { status: 404, headers: web })
  if (!existsSync(indexHtml)) {
    return new Response('ยังไม่ได้ build หน้าเว็บ — รัน "bun run build" ก่อน หรือใช้ "bun run dev" ระหว่างพัฒนา', {
      status: 503, headers: { ...web, 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
  return new Response(Bun.file(indexHtml), { headers: { ...web, 'Cache-Control': 'no-cache', 'Content-Type': 'text/html; charset=utf-8' } })
}

// Only the socket address counts: X-Forwarded-For and CF-Connecting-IP are written by the client as much as by a
// proxy. A proxy on this machine (cloudflared, nginx) connects from loopback too, so a request that carries such a
// header came from somewhere else: the headers can only take the local answer away, never grant it.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const FORWARDED = ['x-forwarded-for', 'cf-connecting-ip', 'forwarded', 'x-real-ip']
const fromThisMachine = (request: Request, socketIp: string | undefined) =>
  LOOPBACK.has(socketIp ?? '') && !FORWARDED.some(h => request.headers.has(h))

// when each request came in, for the access log (ACCESS_LOG=true)
const requestStart = new WeakMap<Request, number>()

// Bun's own limit has to fit a chunk upload, so it is far too generous for JSON: a list of names or a form is small.
// Only the text editor (PUT /api/content, up to 2 MB of text, more once escaped) needs more.
const JSON_MAX_BYTES = 1024 * 1024
const BIG_JSON = /^\/api\/content$/

/**
 * A JSON body over JSON_MAX_BYTES is refused before anything parses it (a parse and a schema check of millions of
 * list entries is a stall of its own). The length header says it when there is one; without it (chunked) the body is
 * read from a copy of the request. Routes that read their own body (chunks, logo, update package) are not JSON.
 */
async function refuseBigJson(request: Request) {
  if (request.method === 'GET' || request.method === 'HEAD' || !request.body) return
  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('json')) return
  if (BIG_JSON.test(new URL(request.url).pathname)) return
  const length = Number(request.headers.get('content-length'))
  if (length > JSON_MAX_BYTES || (!length && (await request.clone().text()).length > JSON_MAX_BYTES)) throw new HttpError(413, 'request.too-big')
}

export const app = new Elysia({ serve: { maxRequestBodySize: config.uploadChunkSize * 2 + 1024 * 1024 } })
  // set before routing, so error responses (401, 404...) carry them too
  .onRequest(async ({ request, set }) => {
    if (config.accessLog) requestStart.set(request, performance.now())
    await refuseBigJson(request)
    set.headers['x-content-type-options'] = 'nosniff'
    set.headers['x-frame-options'] = 'SAMEORIGIN'
    set.headers['referrer-policy'] = 'same-origin'
    // only behind HTTPS: over plain HTTP the header would be ignored anyway, and a wrong one locks browsers out for a year
    if (config.secureCookie) set.headers['strict-transport-security'] = 'max-age=31536000'
  })
  .use(context)
  .onAfterResponse({ as: 'global' }, ({ request, set, responseValue, ip, user }) => {
    const start = requestStart.get(request)
    if (start === undefined) return
    const status = responseValue instanceof Response ? responseValue.status : typeof set.status === 'number' ? set.status : 200
    accessLine({ method: request.method, url: request.url, status, ms: performance.now() - start, ip: ip ?? '-', user: user?.username ?? null })
  })
  // `release` and `boot` let the launcher and the update page tell which process answered. The version tells an
  // attacker which known holes to try, so only the launcher (this machine) and admins (update page) get it.
  .get('/api/health', ({ request, server, user }) => {
    if (user?.role !== 'admin' && !fromThisMachine(request, server?.requestIP(request)?.address)) return { status: 'ok' }
    return { status: 'ok', version: config.version, release: process.env.FC_RELEASE || null, boot: bootedAt, time: new Date().toISOString() }
  })
  .use(sessionRoutes)
  .use(adminRoutes)
  .use(updateRoutes)
  .use(backupRoutes)
  .use(logRoutes)
  .use(fileRoutes)
  .use(meRoutes)
  .use(versionRoutes)
  .use(uploadRoutes)
  .use(shareRoutes)
  .use(officeRoutes)
  .get('/*', ({ request }) => {
    const { pathname } = new URL(request.url)
    if (pathname.startsWith('/api/')) throw notFound('request.no-api')
    return serveStatic(pathname)
  })

if (import.meta.main) {
  // errors nobody caught go where the admin can see them. A rejected promise costs only its own request; after an
  // exception the process is in an unknown state, so it exits as Bun would and the launcher starts it again
  process.on('unhandledRejection', reason => log.error('unhandled-rejection', reason))
  process.on('uncaughtException', err => {
    log.error('uncaught-exception', err)
    process.exit(1)
  })
  onStop(async () => { stopSearchIndex(); await app.stop() })
  startAlerts()
  startSearchIndex() // built in the background: searches walk the disk until it is ready
  // docker stop, Ctrl+C and updates: finish writing users, sessions and settings before leaving
  process.on('SIGTERM', () => void shutdown(0))
  process.on('SIGINT', () => void shutdown(0))
  app.listen({ port: config.port, hostname: config.host }, ({ hostname, port }) => {
    log.info('start', `File Center v${config.version} พร้อมใช้งานที่ http://${hostname === '0.0.0.0' ? 'localhost' : hostname}:${port}`)
    console.log(`  ไฟล์เก็บที่  ${config.storageDir}`)
    console.log(`  ข้อมูลระบบที่ ${config.dataDir}`)
  })
}
