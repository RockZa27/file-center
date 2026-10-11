// F5: CSV export must neutralise cells starting with + - @ (not only =)
import { setup, client, done, ADMIN_PW } from './helper'
const { app } = await setup()
const c = client(app)
const payloads = ["@SUM(1+1)*cmd|' /C calc'!A0", "+cmd|' /C calc'!A0", "-2+3+cmd|' /C calc'!A0"]
for (const p of payloads) {
  const s = await c.session()
  const r = await c.req('POST', '/api/login', s, { username: p, password: 'wrong-password' })
  console.log('failed login', r.status)
}
const admin = await c.login('admin', ADMIN_PW)
const r = await c.req('GET', '/api/admin/activity/export', admin)
const csv = await r.text()
const live = payloads.filter(p => csv.includes(`"${p.replaceAll('"', '""')}"`))
console.log('export', r.status, 'live formula cells:', live)
done(r.status === 200 && live.length > 0, `${live.length} formula cells left live`)
