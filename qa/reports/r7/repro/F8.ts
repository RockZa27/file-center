import { boot, admin, mkUser } from './h'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
const { app, storage } = await boot({ MIN_FREE_SPACE: '0' })
const adm = await admin(app)
const u = await mkUser(adm, 'quser', undefined, { quotaBytes: 50 * 1024 * 1024 })
writeFileSync(join(storage, 'quser', 'a.txt'), 'hello world')
const z = await u.req('POST', '/api/zip', { space: 'home', path: '/', items: ['a.txt'], name: 'small.zip' })
if (z.status !== 200) throw new Error('zip ' + z.status + z.text)
const r = await u.req('POST', '/api/unzip', { space: 'home', path: '/' + z.json.name })
console.log(r.status, r.text.slice(0, 150))
process.exit(r.status === 507 ? 42 : 0)
