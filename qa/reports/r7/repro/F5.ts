import { boot } from './h'
import { with2fa, ticketFor, stepNow } from './h2'
import { totpAt } from '../../src/totp'
const { app } = await boot({ TRUST_PROXY: 'true' })
const { secret, name } = await with2fa(app)
const { c, ticket } = await ticketFor(app, name, { 'x-forwarded-for': '10.0.0.1' })
// use the ticket from a different address, with a valid code
const other = new (c.constructor as any)(app, { 'x-forwarded-for': '203.0.113.9' }); await other.session()
const r = await other.req('POST', '/api/login/2fa', { ticket, code: totpAt(secret, stepNow() + 1) })
console.log(r.status, r.text.slice(0, 100))
process.exit(r.status === 200 ? 42 : 0)
