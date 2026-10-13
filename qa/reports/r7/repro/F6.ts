import { boot, admin, mkUser, Client } from './h'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
const { app, storage } = await boot()
const adm = await admin(app)
const u = await mkUser(adm, 'alice')
mkdirSync(join(storage, 'alice', 'drop'), { recursive: true })
const sh = await u.req('POST', '/api/shares', { space: 'home', path: '/drop', days: 1, kind: 'upload' })
if (sh.status !== 200) throw new Error('share ' + sh.text)
const tok = sh.json.token
// admin removes alice's upload permission
const up = await adm.req('PUT', '/api/admin/users/alice', { permissions: ['read', 'download', 'share'] })
if (up.status !== 200) throw new Error('perm ' + up.text)
const v = new Client(app)
const a = await v.req('POST', `/api/s/${tok}/upload`, { name: 'x.txt', size: 3 })
console.log(a.status, a.text.slice(0, 120))
process.exit(a.status === 200 ? 42 : 0)
