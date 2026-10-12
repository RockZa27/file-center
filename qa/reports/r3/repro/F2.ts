// F2: a user with only 'read' on the public space must not get file contents from /api/download
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setup, client, done, ADMIN_PW } from './helper'
const { app, storage } = await setup()
const c = client(app)
const admin = await c.login('admin', ADMIN_PW)
writeFileSync(join(storage, 'public', 'secret.txt'), 'TOP-SECRET-CONTENT')
const pw = 'Rd0nly!Lister#2026x'
await c.createUser(admin, 'viewer', pw, ['read'], ['read'])
const u = await c.login('viewer', pw)
const list = await c.req('GET', '/api/list?space=public&path=/', u)
const content = await c.req('GET', '/api/content?space=public&path=/secret.txt', u)
const dl = await c.req('GET', '/api/download?space=public&path=/secret.txt', u)
const body = await dl.text()
console.log('list', list.status, '/content', content.status, '/download', dl.status, body.slice(0, 40))
done(dl.status === 200 && body.includes('TOP-SECRET-CONTENT'), `read-only user download -> ${dl.status}`)
