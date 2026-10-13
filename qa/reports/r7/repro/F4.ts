import { boot, admin, mkUser, Client, PW } from './h'
const { app } = await boot()
const adm = await admin(app)
const victim = await mkUser(adm, 'victim')
const evil = await mkUser(adm, 'evil')
const list = await adm.req('GET', '/api/sessions')
const adminSid = list.json.sessions[0].id
const r = await evil.req('DELETE', `/api/sessions/${adminSid}`)
const after = await adm.req('GET', '/api/sessions')
console.log(r.status, after.status)
// admin session gone => not authenticated any more
process.exit(r.status === 200 && after.status === 401 ? 42 : 0)
