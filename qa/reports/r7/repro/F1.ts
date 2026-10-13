import { boot, admin, mkUser, Client, verdict } from './h'
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
const { app, storage } = await boot()
const adm = await admin(app)
const u = await mkUser(adm, 'alice')
mkdirSync(join(storage, 'alice', 'drop'), { recursive: true })
writeFileSync(join(storage, 'alice', 'drop', 'existing.docx'), 'ORIGINAL')
const sh = await u.req('POST', '/api/shares', { space: 'home', path: '/drop', days: 1, kind: 'upload' })
if (sh.status !== 200) throw new Error('share ' + sh.text)
const tok = sh.json.token
const v = new Client(app) // anonymous, no session, no csrf
const body = new TextEncoder().encode('EVILEVIL')
const a = await v.req('POST', `/api/s/${tok}/upload`, { name: 'existing.docx', size: body.length })
if (a.status !== 200) throw new Error('announce ' + a.status + a.text)
const p = await v.req('PUT', `/api/s/${tok}/upload/${a.json.id}/0`, body)
const c = await v.req('POST', `/api/s/${tok}/upload/${a.json.id}/complete`)
console.log(p.status, c.status, c.text)
const now = readFileSync(join(storage, 'alice', 'drop', 'existing.docx'), 'utf8')
verdict(now === 'EVILEVIL', 'file content=' + now)
