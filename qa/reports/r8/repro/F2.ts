import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { setup, put } from './helper'
const h = await setup()
const u = await h.mkUser('carol', ['read'], ['read'])
const f = join(h.storage, 'public', 'report.txt')
// admin edits twice so a real version exists
put(f, 'v1')
const pub = await h.call(h.admin, 'GET', '/api/files?space=public&path=/')
const c = await h.call(h.admin, 'GET', '/api/content?space=public&path=/report.txt')
const e = await h.call(h.admin, 'PUT', '/api/content', { space: 'public', path: '/report.txt', content: 'v2-edited' })
const vs = await h.call(h.admin, 'GET', '/api/versions?space=public&path=/report.txt')
console.log(pub.status, c.status, e.status, JSON.stringify(vs.json))
const id = vs.json.items[0].id
const w = await h.call(u, 'PUT', '/api/content', { space: 'public', path: '/report.txt', content: 'hack' })
console.log('direct write by read-only', w.status)
const r = await h.call(u, 'POST', `/api/versions/${id}/restore`, { space: 'public', path: '/report.txt' })
const now = readFileSync(f, 'utf8')
console.log('restore', r.status, now)
process.exit(w.status === 403 && r.status === 200 && now === 'v1' ? 42 : 0)
