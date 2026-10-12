// F7: update packages are verified by file SIZE only; the manifest SHA-256 is never computed (updater.ts:93).
// We build a valid, bootable package but put a WRONG sha256 for server.js in the manifest (size correct).
// A real integrity check would reject it; the size-only check accepts it.
// CONFIRMED (42) if stagePackage() accepts the package despite the wrong server.js sha256.
// SAFE  (0)      if staging rejects it (sha mismatch).
import { mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { freshEnv } from './helper'

const env = freshEnv({ MIN_FREE_SPACE: '0' })
const srcIndex = process.env.FC_SRC ?? '../../src/updater'
const { stagePackage } = await import(srcIndex)

// Build a minimal but genuinely bootable package.
const pkg = join(env.base, 'pkg')
mkdirSync(join(pkg, 'web'), { recursive: true })

const serverJs = `const port = Number(process.env.PORT)
Bun.serve({ port, hostname: '127.0.0.1', fetch(req) {
  const u = new URL(req.url)
  if (u.pathname === '/api/health') return new Response(JSON.stringify({ status: 'ok', version: process.env.FC_VERSION }), { headers: { 'content-type': 'application/json' } })
  return new Response('<!doctype html><title>ok</title>', { headers: { 'content-type': 'text/html' } })
} })
`
writeFileSync(join(pkg, 'server.js'), serverJs)
writeFileSync(join(pkg, 'web', 'index.html'), '<!doctype html><title>ok</title>')

const serverSize = statSync(join(pkg, 'server.js')).size
const indexSize = statSync(join(pkg, 'web', 'index.html')).size

const manifest = {
  name: 'file-center',
  version: '2.0.0', // newer than running 1.1.0
  builtAt: new Date().toISOString(),
  files: {
    // WRONG sha, CORRECT size: a size-only check passes, a real sha check fails.
    'server.js': { sha256: '0'.repeat(64), size: serverSize },
    'web/index.html': { sha256: '0'.repeat(64), size: indexSize },
  },
}
writeFileSync(join(pkg, 'manifest.json'), JSON.stringify(manifest))

// zip it (entry names: server.js, web/index.html, manifest.json)
const zipPath = join(env.base, 'pkg.zip')
const proc = Bun.spawnSync(['zip', '-X', '-q', zipPath, 'server.js', 'web/index.html', 'manifest.json'], { cwd: pkg })
if (!proc.success) throw new Error('zip failed: ' + proc.stderr.toString())
const zipSize = statSync(zipPath).size

try {
  const staged = await stagePackage(zipPath, zipSize)
  console.log('stagePackage RESOLVED:', JSON.stringify({ version: staged.version, serverSha256: staged.serverSha256 }))
  console.log('CONFIRMED: tampered server.js (wrong sha256, correct size) accepted by staging')
  process.exit(42)
} catch (e: any) {
  console.log('stagePackage rejected:', e?.message ?? e)
  console.log('SAFE: package rejected (integrity check caught the mismatch or boot failed)')
  process.exit(0)
}
