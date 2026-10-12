// F6: the batch download token must not be written to access.log
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { setup, client, done } from './helper'
const { app, storage, data } = await setup({ ACCESS_LOG: 'true' })
const c = client(app)
writeFileSync(join(storage, 'public', 'a.txt'), 'hello')
const guest = await c.session()
const b = await c.req('POST', '/api/batch', guest, { space: 'public', path: '/', items: ['a.txt'] })
const { token } = await b.json() as any
const r = await c.req('GET', `/api/batch/${token}`, guest)
await r.arrayBuffer()
await new Promise(res => setTimeout(res, 300))
const file = join(data, 'logs', 'access.log')
const log = existsSync(file) ? readFileSync(file, 'utf8') : ''
const lines = log.split('\n').filter(l => l.includes('/api/batch/'))
console.log('batch', b.status, 'get', r.status, 'token', token, '\n' + lines.join('\n'))
if (!lines.length) { console.log('no batch line logged at all'); process.exit(1) }
done(r.status === 200 && log.includes(token), 'token in access.log')
