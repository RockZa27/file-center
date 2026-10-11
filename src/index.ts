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
import { cleanStaging, signingKey } from './updater'

ensureDirs()
await bootstrapAdmin()

// a bad key must not stop the app (the admin could not reach the update page to see why); packages are refused instead
const keyError = signingKey().error
if (keyError) console.error(`[update] UPDATE_PUBLIC_KEY ไม่ถูกต้อง: ${keyError} ระบบจะไม่รับแพ็กเกจอัปเดตใด ๆ จนกว่าจะแก้ค่านี้`)

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

function serveStatic(pathname: string): Response {
  let decoded: string
  try { decoded = decodeURIComponent(pathname) } catch { return new Response('Bad request', { status: 400 }) }
  const abs = normalize(join(config.webDir, decoded))
  if (within(config.webDir, abs) && existsSync(abs) && statSync(abs).isFile()) {
    const immutable = decoded.startsWith('/assets/')
    return new Response(Bun.file(abs), {
      headers: { 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' },
    })
  }
  // a missing asset must stay a 404, any other path is a client-side route
  if (extname(decoded) && decoded !== '/') return new Response('Not found', { status: 404 })
  if (!existsSync(indexHtml)) {
    return new Response('ยังไม่ได้ build หน้าเว็บ — รัน "bun run build" ก่อน หรือใช้ "bun run dev" ระหว่างพัฒนา', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
  return new Response(Bun.file(indexHtml), { headers: { 'Cache-Control': 'no-cache', 'Content-Type': 'text/html; charset=utf-8' } })
}

export const app = new Elysia({ serve: { maxRequestBodySize: config.uploadChunkSize * 2 + 1024 * 1024 } })
  // set before routing, so error responses (401, 404...) carry them too
  .onRequest(({ set }) => {
    set.headers['x-content-type-options'] = 'nosniff'
    set.headers['x-frame-options'] = 'SAMEORIGIN'
    set.headers['referrer-policy'] = 'same-origin'
  })
  .use(context)
  // `release` and `boot` let the launcher and the update page tell which process answered
  .get('/api/health', () => ({ status: 'ok', version: config.version, release: process.env.FC_RELEASE || null, boot: bootedAt, time: new Date().toISOString() }))
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
