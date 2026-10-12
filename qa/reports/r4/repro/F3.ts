// F3: copyTree's copy-into-self guard is skipped when relative(from,to) starts with '..' because of a folder named '..a'
import { boot, login, makeUser, req, finish, ADMIN_PW } from './helper'

const { app } = await boot()
const { text } = await import('../../src/messages')
const admin = await login(app, 'admin', ADMIN_PW)
const u = await makeUser(app, admin, 'writer', ['read', 'write', 'download'], [])
for (const [path, name] of [['/', '..a'], ['/..a', '..b'], ['/', 'a'], ['/a', 'b']]) {
  const r = await req(app, u, 'POST', '/api/mkdir', { space: 'home', path, name })
  if (r.status !== 200) { console.log('mkdir failed', path, name, r.status, r.text); process.exit(1) }
}
const intoSelf = text('th', 'files.copy-into-self')
const control = await req(app, u, 'POST', '/api/copy', { space: 'home', items: ['/a'], dest: '/a/b' })
const r = await req(app, u, 'POST', '/api/copy', { space: 'home', items: ['/..a'], dest: '/..a/..b' })
const ctrlBlocked = control.json?.failed?.[0]?.error === intoSelf
const err = r.json?.failed?.[0]?.error
console.log('control:', JSON.stringify(control.json), '\nattack:', JSON.stringify(r.json))
if (!ctrlBlocked) { console.log('control copy was not blocked; guard behaves differently'); process.exit(1) }
finish(err !== undefined && err !== intoSelf, `copy of '/..a' into '/..a/..b' was not refused as copy-into-self (error: ${err})`)
