import { boot } from './h'
import { with2fa, ticketFor } from './h2'
const { app } = await boot()
const { backup, name } = await with2fa(app)
const code = backup[0]
const t1 = await ticketFor(app, name); const r1 = await t1.c.req('POST', '/api/login/2fa', { ticket: t1.ticket, code })
const t2 = await ticketFor(app, name); const r2 = await t2.c.req('POST', '/api/login/2fa', { ticket: t2.ticket, code })
console.log(r1.status, r2.status)
if (r1.status !== 200) throw new Error('first use should work: ' + r1.text)
process.exit(r2.status === 200 ? 42 : 0)
