// F5: login lockout key is case-sensitive (`${ip}|${username}`) while findUser is case-insensitive.
// After locking out username 'admin', the attacker switches case ('Admin') to a fresh lockout bucket
// for the same account, continuing the brute force.
// CONFIRMED (42) if 'admin' is locked (429) but 'Admin' is NOT locked (not 429).
// SAFE  (0)      if the case variant is also locked (429) -> key is normalized.
import { freshEnv } from './helper'

const env = freshEnv({ LOGIN_MAX_ATTEMPTS: '3', LOGIN_LOCKOUT_SECONDS: '60' })
const srcIndex = process.env.FC_SRC ?? '../../src/index'
const { app } = await import(srcIndex)

const sres = await app.handle(new Request('http://localhost/api/session', {}))
const sbody: any = await sres.json()
const sid = ((sres.headers as any).getSetCookie?.() ?? []).map(String).join(';').match(/fc_sid=([^;]+)/)?.[1]
const cookie = `fc_sid=${sid}`
const csrf = sbody.csrf

async function tryLogin(username: string) {
  const res = await app.handle(new Request('http://localhost/api/login', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'definitely-wrong' }),
  }))
  return res.status
}

// burn through the lockout for 'admin' (TRUST_PROXY unset -> ip is constant 'unknown')
for (let i = 0; i < 3; i++) await tryLogin('admin')
const adminStatus = await tryLogin('admin') // should now be 429
const variantStatus = await tryLogin('Admin') // different case, same account
console.log('admin locked status =', adminStatus, 'Admin variant status =', variantStatus)

if (adminStatus === 429 && variantStatus !== 429) {
  console.log("CONFIRMED: 'admin' locked (429) but 'Admin' bypassed lockout (status " + variantStatus + ')')
  process.exit(42)
}
console.log('SAFE: case variant also locked (status ' + variantStatus + ')')
process.exit(0)
