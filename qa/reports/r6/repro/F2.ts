// F2: the office callback trusts an UNSIGNED body when no JWT / Authorization is present.
// To isolate THIS defect (not F1), the saved-file url points at a legitimate stub document server whose
// origin == OFFICE_URL, so savedFileUrl accepts it on safe code too. The only thing wrong here is the
// missing signature: no token in the body, no Authorization header.
import { prepEnv, importApp, loginAdmin } from './helper'

const STUB_BODY = 'SAVED-BY-STUB-' + Math.random().toString(36).slice(2)
const JWT_SECRET = 'office-jwt-secret-32-characters-min!!'

// a local stub "document server" that hands back a saved file
const stub = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(STUB_BODY) })
const stubOrigin = `http://127.0.0.1:${stub.port}`

try {
  prepEnv({
    OFFICE_URL: stubOrigin,
    OFFICE_INTERNAL_URL: 'http://localhost:3000',
    OFFICE_JWT_SECRET: JWT_SECRET,
  })
  const app = await importApp()
  const admin = await loginAdmin(app)
  const hdr = { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'application/json' }

  let r = await app.handle(new Request('http://localhost/api/newfile', {
    method: 'POST', headers: hdr, body: JSON.stringify({ space: 'home', path: '/', name: 'doc.txt' }),
  }))
  if (r.status !== 200) throw new Error('newfile ' + r.status)
  r = await app.handle(new Request('http://localhost/api/content', {
    method: 'PUT', headers: hdr, body: JSON.stringify({ space: 'home', path: '/doc.txt', content: 'ORIGINAL' }),
  }))
  if (r.status !== 200) throw new Error('put ' + r.status)

  r = await app.handle(new Request('http://localhost/api/office/config', {
    method: 'POST', headers: hdr, body: JSON.stringify({ space: 'home', path: '/doc.txt', mode: 'edit' }),
  }))
  if (r.status !== 200) throw new Error('config ' + r.status)
  const cfg = await r.json()
  const token = (cfg.config.editorConfig.callbackUrl as string).split('/api/office/callback/')[1]

  // UNSIGNED body: no token field, no Authorization header. A forged/unauthenticated save.
  r = await app.handle(new Request('http://localhost/api/office/callback/' + token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 2, url: stubOrigin + '/save.txt' }),
  }))
  const cb = await r.json().catch(() => ({}))
  console.log('callback (unsigned)', r.status, JSON.stringify(cb))

  r = await app.handle(new Request('http://localhost/api/content?space=home&path=/doc.txt', { headers: { cookie: admin.cookie } }))
  const content = ((await r.json().catch(() => ({}))) as { content?: string }).content ?? ''
  console.log('document now:', JSON.stringify(content))

  if (content === STUB_BODY) {
    console.log('CONFIRMED: unsigned callback body was trusted and saved')
    stub.stop(true)
    process.exit(42)
  }
  console.log('safe: unsigned body refused (403), document unchanged')
  stub.stop(true)
  process.exit(0)
} catch (e) {
  stub.stop(true)
  throw e
}
