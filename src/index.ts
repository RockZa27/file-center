import { existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { Elysia } from 'elysia'
import { audit } from './audit'
import { bootstrapAdmin, pruneLoginAttempts, purgeExpiredSessions } from './auth'
import { backupDue, backupRunning, runBackup } from './backup'
import { config, ensureDirs } from './config'
import { context } from './context'
import { within } from './fsx'
import { onStop, shutdown } from './lifecycle'
import { adminRoutes } from './routes/admin'
import { backupRoutes } from './routes/backup'
import { fileRoutes } from './routes/files'
import { sessionRoutes } from './routes/session'
import { updateRoutes } from './routes/update'
import { uploadRoutes } from './routes/upload'
import { purgeExpired } from './trash'
import { cleanStaleUploads } from './uploads'
import { cleanStaging } from './updater'

ensureDirs()
await bootstrapAdmin()

function housekeeping() {
  try {
    const trash = purgeExpired()
    const uploads = cleanStaleUploads()
    purgeExpiredSessions()
    cleanStaging()
    pruneLoginAttempts()
    if (trash || uploads) console.log(`[housekeeping] trash: ${trash}, stale uploads: ${uploads}`)
    // runs in the background; the result goes to backup-status.json, which the dashboard shows
    if (backupDue() && !backupRunning()) {
      runBackup().then(
        b => audit({ user: 'system', ip: '-', action: 'backup-create', target: b.name, detail: 'อัตโนมัติ' }),
        err => console.error('[backup] failed', (err as Error).message),
      )
    }
  } catch (err) {
    console.error('[housekeeping] failed', err)
  }
}
housekeeping()
setInterval(housekeeping, 60 * 60 * 1000).unref()

const bootedAt = Date.now()
const indexHtml = join(config.webDir, 'index.html')

// The page loads only its own files. Naive UI writes its styles into <style> tags (hence 'unsafe-inline' for
// styles only); previews use blob: URLs and frames of our own downloads. Downloads and the logo send their own,
// stricter policy: it is set on those responses only, never here.
const WEB_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; " +
    "form-action 'self'; frame-ancestors 'self'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
}

function serveStatic(pathname: string): Response {
  let decoded: string
  try { decoded = decodeURIComponent(pathname) } catch { return new Response('Bad request', { status: 400, headers: WEB_HEADERS }) }
  const abs = normalize(join(config.webDir, decoded))
  if (within(config.webDir, abs) && existsSync(abs) && statSync(abs).isFile()) {
    const immutable = decoded.startsWith('/assets/')
    return new Response(Bun.file(abs), {
      headers: { ...WEB_HEADERS, 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' },
    })
  }
  // a missing asset must stay a 404, any other path is a client-side route
  if (extname(decoded) && decoded !== '/') return new Response('Not found', { status: 404, headers: WEB_HEADERS })
  if (!existsSync(indexHtml)) {
    return new Response('ยังไม่ได้ build หน้าเว็บ — รัน "bun run build" ก่อน หรือใช้ "bun run dev" ระหว่างพัฒนา', {
      status: 503, headers: { ...WEB_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
  return new Response(Bun.file(indexHtml), { headers: { ...WEB_HEADERS, 'Cache-Control': 'no-cache', 'Content-Type': 'text/html; charset=utf-8' } })
}

// Only the socket address counts: X-Forwarded-For and CF-Connecting-IP are written by the client as much as by a
// proxy. A proxy on this machine (cloudflared, nginx) connects from loopback too, so a request that carries such a
// header came from somewhere else: the headers can only take the local answer away, never grant it.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const FORWARDED = ['x-forwarded-for', 'cf-connecting-ip', 'forwarded', 'x-real-ip']
const fromThisMachine = (request: Request, socketIp: string | undefined) =>
  LOOPBACK.has(socketIp ?? '') && !FORWARDED.some(h => request.headers.has(h))

export const app = new Elysia({ serve: { maxRequestBodySize: config.uploadChunkSize * 2 + 1024 * 1024 } })
  // set before routing, so error responses (401, 404...) carry them too
  .onRequest(({ set }) => {
    set.headers['x-content-type-options'] = 'nosniff'
    set.headers['x-frame-options'] = 'SAMEORIGIN'
    set.headers['referrer-policy'] = 'same-origin'
    // only behind HTTPS: over plain HTTP the header would be ignored anyway, and a wrong one locks browsers out for a year
    if (config.secureCookie) set.headers['strict-transport-security'] = 'max-age=31536000'
  })
  .use(context)
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
  .use(fileRoutes)
  .use(uploadRoutes)
  .get('/*', ({ request, set }) => {
    const { pathname } = new URL(request.url)
    if (pathname.startsWith('/api/')) {
      set.status = 404
      return { error: 'ไม่พบ API ที่เรียก' }
    }
    return serveStatic(pathname)
  })

if (import.meta.main) {
  onStop(() => app.stop())
  // docker stop, Ctrl+C and updates: finish writing users, sessions and settings before leaving
  process.on('SIGTERM', () => void shutdown(0))
  process.on('SIGINT', () => void shutdown(0))
  app.listen({ port: config.port, hostname: config.host }, ({ hostname, port }) => {
    console.log(`File Center v${config.version} พร้อมใช้งานที่ http://${hostname === '0.0.0.0' ? 'localhost' : hostname}:${port}`)
    console.log(`  ไฟล์เก็บที่  ${config.storageDir}`)
    console.log(`  ข้อมูลระบบที่ ${config.dataDir}`)
  })
}
