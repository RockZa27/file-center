// F5: CSV activity export only escapes a leading '=', not + - @ (tab/CR). An unauthenticated visitor can
// plant a formula as a username in a failed login; it lands in the audit log and is exported unescaped,
// so Excel runs it. We check a '+'-prefixed formula username comes out WITHOUT the leading-quote guard.
import { prepEnv, importApp, loginAdmin, anonSession } from './helper'

const MARK = '+FCINJECT' + Math.floor(Math.random() * 1e6)
const FORMULA = MARK + '(1+1)*cmd|/C_calc'

prepEnv()
const app = await importApp()

// unauthenticated: get a session+csrf, then a failed login with the formula as the username
const anon = await anonSession(app)
const lr = await app.handle(new Request('http://localhost/api/login', {
  method: 'POST',
  headers: { cookie: anon.cookie, 'x-csrf-token': anon.csrf, 'content-type': 'application/json' },
  body: JSON.stringify({ username: FORMULA, password: 'nope' }),
}))
console.log('login attempt status', lr.status) // expected 401 (recorded as login-failed)

// admin exports the activity log as CSV
const admin = await loginAdmin(app)
const er = await app.handle(new Request('http://localhost/api/admin/activity/export', {
  headers: { cookie: admin.cookie },
}))
const csv = await er.text()
const line = csv.split('\n').find(l => l.includes(MARK)) ?? ''
console.log('csv cell line:', JSON.stringify(line.trim()))

if (line.includes(`"'${FORMULA}"`)) {
  console.log('safe: formula username escaped with a leading quote')
  process.exit(0)
}
if (line.includes(`"${FORMULA}"`)) {
  console.log('CONFIRMED: formula username exported unescaped (Excel would run it)')
  process.exit(42)
}
console.log('username not found in export')
process.exit(0)
