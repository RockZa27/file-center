// F3: a POST with a wrong (but non-empty) X-CSRF-Token must be refused with 403
import { setup, client, done, ADMIN_PW } from './helper'
const { app } = await setup()
const c = client(app)
const admin = await c.login('admin', ADMIN_PW)
const body = { username: 'csrfuser', name: 'x', password: 'Csrf!Victim#Pw2026', role: 'user', permissions: ['read'], publicPermissions: [] }
const r = await c.req('POST', '/api/admin/users', admin, body, { 'x-csrf-token': 'attacker-chosen-value' })
const list: any = await (await c.req('GET', '/api/admin/users', admin)).json()
const created = list.users.some((u: any) => u.username === 'csrfuser')
console.log('wrong-token POST status', r.status, 'user created', created)
done(r.status === 200 && created, `wrong csrf token -> ${r.status}`)
