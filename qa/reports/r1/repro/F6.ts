// F6: signed-in session expiry check multiplies the TTL by 1000 (auth.ts:134, ttlOf already in ms)
// and measures from creation, so a session stays valid far past its configured lifetime.
// Here SESSION_TTL_HOURS=0.0005 -> sessionTtlMs = 1800ms. We wait 3500ms (well past the TTL)
// and check whether the session is still accepted.
// CONFIRMED (42) if the session is still valid (user non-null) long after its TTL.
// SAFE  (0)      if the session has expired (user null).
import { freshEnv, login, get } from './helper'

const env = freshEnv({ SESSION_TTL_HOURS: '0.0005' }) // 0.0005h * 3600 * 1000 = 1800 ms
const srcIndex = process.env.FC_SRC ?? '../../src/index'
const { app } = await import(srcIndex)

const admin = await login(app as any, 'admin', env.adminPassword)
if (admin.status !== 200) throw new Error('admin login failed: ' + admin.status)
if (!admin.body?.user) throw new Error('login did not return a user')

// wait well past the 1800ms configured TTL
await Bun.sleep(3500)

const res = await get(app as any, '/api/session', admin)
const body: any = await res.json()
const stillValid = !!body.user
console.log('after 3500ms (TTL=1800ms), session user =', body.user ? body.user.username : null)

if (stillValid) {
  console.log('CONFIRMED: session still valid 3500ms after a 1800ms TTL (TTL*1000, measured from creation)')
  process.exit(42)
}
console.log('SAFE: session expired after its TTL')
process.exit(0)
