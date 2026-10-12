// F6: fetched package is not checked against latest.json sha256 (source is http://127.0.0.1, which is allowed)
import { buildPackage, sha256hex } from './pkg'
const pkg = buildPackage('9.0.0')
const wrong = sha256hex(new TextEncoder().encode('some other bytes')) // valid-looking SHA-256 of different content
const srv = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname
    if (p.endsWith('/latest.json')) return Response.json({ version: '9.0.0', file: 'file-center-9.0.0.zip', sha256: wrong, size: pkg.length, notes: '', signed: false })
    if (p.endsWith('/file-center-9.0.0.zip')) return new Response(pkg)
    return new Response('nf', { status: 404 })
  },
})
process.env.UPDATE_SOURCE = `http://127.0.0.1:${srv.port}/updates`
process.env.FC_SUPERVISED = '1'
const { adminLogin, call, done, json } = await import('./helper')
const admin = await adminLogin()
// control: correct hash value would be sha256hex(pkg); we announce a different one
const r = await call('POST', '/api/admin/update/fetch', admin)
const j = await json(r)
console.log('fetch with wrong sha256 in latest.json:', r.status, JSON.stringify(j).slice(0, 200))
srv.stop(true)
done(r.status === 200 && j.version === '9.0.0', 'package with mismatching SHA-256 was staged')
