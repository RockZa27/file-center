// F5: the stage step accepts a package whose version equals the running one.
// Build a valid package (correct manifest, sizes and SHA-256s) with version == runningVersion,
// upload it, and stage it. Vulnerable (gate is "< 0"): stage succeeds (200).
// Safe (gate is "<= 0"): stage is refused (400). This is the only defect exercised; every other input is valid.
import { zipSync } from 'fflate'
import { setupEnv, importApp, login, send, fail, pass, vuln } from './helpers'

setupEnv({ adminPassword: 'adminPassw0rd!', supervised: true })
const app = await importApp()

const RUNNING = '1.1.0' // = config.version (package.json, no FC_VERSION set)
const enc = new TextEncoder()
const sha = (b: Uint8Array) => new Bun.CryptoHasher('sha256').update(b).digest('hex')

const server = enc.encode('// test server\n')
const indexHtml = enc.encode('<!doctype html><title>fc</title>')
const manifest = {
  name: 'file-center', version: RUNNING, builtAt: new Date().toISOString(), notes: 'same-version test',
  files: {
    'server.js': { size: server.length, sha256: sha(server) },
    'web/index.html': { size: indexHtml.length, sha256: sha(indexHtml) },
  },
}
const zip = zipSync({
  'manifest.json': enc.encode(JSON.stringify(manifest, null, 2)),
  'server.js': server,
  'web/index.html': indexHtml,
}, { level: 0 })

const admin = await login(app, 'admin', 'adminPassw0rd!')
const up = await send(app, 'POST', '/api/admin/update/upload', admin, { size: zip.length })
if (up.status !== 200) fail(`update/upload: ${up.status} ${await up.text()}`)
const { id, total } = (await up.json()) as { id: string; total: number }
if (total !== 1) fail(`expected 1 chunk, got ${total}`)

const put = await app.handle(new Request(`http://localhost/api/upload/${id}/0`, {
  method: 'PUT',
  headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
  body: zip,
}))
if (put.status !== 200) fail(`chunk upload: ${put.status} ${await put.text()}`)

const stage = await send(app, 'POST', '/api/admin/update/stage', admin, { id })
const text = await stage.text()
if (stage.status === 200) { console.log(`stage accepted same-version package (200): ${text.slice(0, 120)}`); vuln() }
console.log(`stage rejected same-version package (${stage.status}) — safe`); pass()
