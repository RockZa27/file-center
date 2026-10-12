// F1: unauthenticated GET /api/admin/logs/download must be 401, not a zip of the logs
import { setup, client, done, ADMIN_PW } from './helper'
const { app } = await setup()
const c = client(app)
await c.login('admin', ADMIN_PW) // puts a 'login' entry into audit.log
const guest = await c.session()
const r = await c.req('GET', '/api/admin/logs/download', guest)
const buf = Buffer.from(await r.arrayBuffer())
const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b
const hasAudit = buf.includes(Buffer.from('audit.log'))
console.log('status', r.status, 'zip', isZip, 'contains audit.log', hasAudit)
done(r.status === 200 && isZip && hasAudit, `guest log download -> ${r.status}`)
