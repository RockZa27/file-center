// F4: /api/copy never calls ensureSpace, so MIN_FREE_SPACE is not enforced for copies (zip of the same folder is refused)
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { boot, login, makeUser, req, finish, ADMIN_PW } from './helper'

process.env.MIN_FREE_SPACE = String(1e18) // a reserve no disk can meet: every space-checked write must be refused
const { app, config } = await boot()
const admin = await login(app, 'admin', ADMIN_PW)
const u = await makeUser(app, admin, 'writer', ['read', 'write', 'zip', 'download'], [])
const mk = await req(app, u, 'POST', '/api/mkdir', { space: 'home', path: '/', name: 'big' })
const home = join(config.storageDir, 'users', 'writer')
writeFileSync(join(home, 'big', 'data.bin'), Buffer.alloc(64 * 1024, 1))
const control = await req(app, u, 'POST', '/api/zip', { space: 'home', path: '/', items: ['big'], name: 'big.zip' })
console.log('mkdir', mk.status, 'control zip:', control.status, control.json?.code)
if (control.status !== 507) { console.log('control not refused, cannot judge'); process.exit(1) }
const r = await req(app, u, 'POST', '/api/copy', { space: 'home', items: ['/big'], dest: '/' })
const copied = existsSync(join(home, 'big (1)', 'data.bin')) || (r.json?.done ?? 0) > 0
console.log('copy:', r.status, JSON.stringify(r.json))
finish(r.status === 200 && copied, `folder copy succeeded below MIN_FREE_SPACE (status ${r.status})`)
