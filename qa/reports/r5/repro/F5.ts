// F5: UPDATE_SOURCE over plain http to a non-local host is accepted and used
// "attacker" source served on 127.0.0.2 (not in LOCAL_HOSTS: 127.0.0.1 / localhost / [::1])
import { buildPackage, sha256hex } from './pkg'
const pkg = buildPackage('9.0.0')
const srv = Bun.serve({
  hostname: '127.0.0.2', port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname
    if (p.endsWith('/latest.json')) return Response.json({ version: '9.0.0', file: 'file-center-9.0.0.zip', sha256: sha256hex(pkg), size: pkg.length, notes: 'from attacker', signed: false })
    if (p.endsWith('/file-center-9.0.0.zip')) return new Response(pkg)
    return new Response('nf', { status: 404 })
  },
})
process.env.UPDATE_SOURCE = `http://127.0.0.2:${srv.port}/updates`
const { adminLogin, call, done, json } = await import('./helper')
const admin = await adminLogin()
const st = await json(await call('GET', '/api/admin/update', admin))
console.log('source status:', JSON.stringify(st.source))
const chk = await call('GET', '/api/admin/update/check', admin)
const c = await json(chk)
console.log('check:', chk.status, JSON.stringify(c))
srv.stop(true)
done(st.source?.enabled === true && chk.status === 200 && c.latest?.notes === 'from attacker', 'plain-http non-local UPDATE_SOURCE accepted and fetched')
