import { existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { Elysia } from 'elysia'
import { bootstrapAdmin, pruneLoginAttempts, purgeExpiredSessions } from './auth'
import { config, ensureDirs } from './config'
import { context } from './context'
import { within } from './fsx'
import { adminRoutes } from './routes/admin'
import { fileRoutes } from './routes/files'
import { sessionRoutes } from './routes/session'
import { uploadRoutes } from './routes/upload'
import { purgeExpired } from './trash'
import { cleanStaleUploads } from './uploads'

ensureDirs()
await bootstrapAdmin()

function housekeeping() {
  try {
    const trash = purgeExpired()
    const uploads = cleanStaleUploads()
    purgeExpiredSessions()
    pruneLoginAttempts()
    if (trash || uploads) console.log(`[housekeeping] trash: ${trash}, stale uploads: ${uploads}`)
  } catch (err) {
    console.error('[housekeeping] failed', err)
  }
}
housekeeping()
setInterval(housekeeping, 60 * 60 * 1000).unref()

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
  .get('/api/health', () => ({ status: 'ok', version: config.version, time: new Date().toISOString() }))
  .use(sessionRoutes)
  .use(adminRoutes)
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
  app.listen({ port: config.port, hostname: config.host }, ({ hostname, port }) => {
    console.log(`File Center v${config.version} พร้อมใช้งานที่ http://${hostname === '0.0.0.0' ? 'localhost' : hostname}:${port}`)
    console.log(`  ไฟล์เก็บที่  ${config.storageDir}`)
    console.log(`  ข้อมูลระบบที่ ${config.dataDir}`)
  })
}
