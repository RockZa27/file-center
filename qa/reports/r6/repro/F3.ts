// F3: POST /api/admin/update/fetch-and-apply skips the password step-up (`void body.password`).
// With a WRONG password, the safe code answers auth.wrong-password (403) before doing anything.
// The vulnerable code ignores the password and proceeds to the 'check' step (here: update.source-off),
// proving the step-up (and its lockout) is bypassed. UPDATE_SOURCE is left unset so nothing is actually installed.
import { prepEnv, importApp, loginAdmin } from './helper'

process.env.FC_SUPERVISED = '1' // so enabled() passes; both safe and vulnerable code reach the same point
prepEnv() // WEB_UPDATE defaults true, UPDATE_SOURCE unset

const app = await importApp()
const admin = await loginAdmin(app)

const r = await app.handle(new Request('http://localhost/api/admin/update/fetch-and-apply', {
  method: 'POST',
  headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'definitely-the-WRONG-password' }),
}))
const body = await r.json().catch(() => ({}))
console.log('status', r.status, 'code', (body as { code?: string }).code)

if ((body as { code?: string }).code === 'auth.wrong-password') {
  console.log('safe: password step-up enforced before any update work')
  process.exit(0)
}
if ((body as { code?: string }).code === 'update.source-off') {
  console.log('CONFIRMED: wrong password ignored; handler advanced past the step-up to the source check')
  process.exit(42)
}
console.log('unexpected response, treating as not-reproduced')
process.exit(0)
