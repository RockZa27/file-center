import { boot } from './h'
import { with2fa, ticketFor, stepNow } from './h2'
import { totpAt } from '../../src/totp'
const { app } = await boot()
const { secret, name } = await with2fa(app)
// enable consumed current step; use the NEXT step's code (valid: now+1 accepted) twice
const code = totpAt(secret, stepNow() + 1)
const t1 = await ticketFor(app, name); const r1 = await t1.c.req('POST', '/api/login/2fa', { ticket: t1.ticket, code })
const t2 = await ticketFor(app, name); const r2 = await t2.c.req('POST', '/api/login/2fa', { ticket: t2.ticket, code })
console.log(r1.status, r2.status)
if (r1.status !== 200) throw new Error('first use should work: ' + r1.text)
const present = r2.status === 200
console.log(present ? 'PRESENT replay accepted' : 'SAFE')
process.exit(present ? 42 : 0)
