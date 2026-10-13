import { boot, admin, mkUser, PW } from './h'
import { with2fa } from './h2'
const { app } = await boot()
const { adm } = await with2fa(app)
const b = await adm.req('POST', '/api/admin/backups')
if (b.status !== 200) throw new Error('backup ' + b.text)
const res = await app.handle(new Request(`http://localhost/api/admin/backups/${b.json.name}/download`, { headers: { cookie: adm.cookie } }))
const buf = Buffer.from(await res.arrayBuffer())
const has = (n: string) => buf.includes(Buffer.from(n))
console.log(res.status, 'users.json', has('users.json'), 'secret.key', has('secret.key'))
process.exit(has('users.json') && has('secret.key') ? 42 : 0)
