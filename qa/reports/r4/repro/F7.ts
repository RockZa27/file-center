// F7: login lockout key keeps the username's case, findUser ignores it, so a case variant gets a fresh counter
import { boot, guest, req, finish } from './helper'

const { app, config } = await boot()
const g = await guest(app)
for (let i = 0; i < config.loginMaxAttempts; i++) {
  const r = await req(app, g, 'POST', '/api/login', { username: 'admin', password: 'wrong-guess-' + i })
  if (r.status !== 401) { console.log('unexpected', r.status, r.text); process.exit(1) }
}
const locked = await req(app, g, 'POST', '/api/login', { username: 'admin', password: 'wrong-guess-x' })
if (locked.status !== 429) { console.log('lockout did not engage for admin:', locked.status); process.exit(1) }
// same account, other case: must still be locked
const variant = await req(app, g, 'POST', '/api/login', { username: 'ADMIN', password: 'wrong-guess-y' })
console.log('admin after lockout:', locked.status, ' ADMIN:', variant.status)
finish(variant.status === 401, `case variant got a fresh guess (status ${variant.status}) while 'admin' was locked`)
