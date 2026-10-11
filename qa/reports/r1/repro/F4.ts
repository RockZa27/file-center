// F4: clientIp() takes the FIRST X-Forwarded-For entry (client-controlled) when TRUST_PROXY=true.
// A real reverse proxy appends the true client IP LAST; the first entries are attacker-supplied.
// An attacker varies the first XFF entry each attempt -> a fresh lockout key every time -> lockout never fires.
// Setup: a constant trusted-proxy IP is appended last; the attacker spoofs a different first entry per try.
// CONFIRMED (42) if, with LOGIN_MAX_ATTEMPTS exceeded, NO request is ever locked out (no 429).
// SAFE  (0)      if lockout engages (>=1 request returns 429), i.e. the trusted last entry is used.
import { freshEnv } from './helper'

const env = freshEnv({ TRUST_PROXY: 'true', LOGIN_MAX_ATTEMPTS: '3', LOGIN_LOCKOUT_SECONDS: '60' })
const srcIndex = process.env.FC_SRC ?? '../../src/index'
const { app } = await import(srcIndex)

// anon session for the CSRF token (reused across attempts; failed logins do not destroy it)
const sres = await app.handle(new Request('http://localhost/api/session', {}))
const sbody: any = await sres.json()
const sid = ((sres.headers as any).getSetCookie?.() ?? []).map(String).join(';').match(/fc_sid=([^;]+)/)?.[1]
const cookie = `fc_sid=${sid}`
const csrf = sbody.csrf

const TRUSTED_PROXY = '10.0.0.1' // appended last by the operator's own proxy; constant & real
const attempts = 6 // > LOGIN_MAX_ATTEMPTS (3)
let locked = 0
const statuses: number[] = []
for (let i = 0; i < attempts; i++) {
  const spoofedClient = `203.0.113.${i}` // attacker controls the first entry, varies it each time
  const res = await app.handle(new Request('http://localhost/api/login', {
    method: 'POST',
    headers: {
      cookie, 'x-csrf-token': csrf, 'content-type': 'application/json',
      'x-forwarded-for': `${spoofedClient}, ${TRUSTED_PROXY}`,
    },
    body: JSON.stringify({ username: 'admin', password: 'definitely-wrong' }),
  }))
  statuses.push(res.status)
  if (res.status === 429) locked++
}
console.log('statuses =', statuses.join(','), 'locked(429) =', locked)

if (locked === 0) {
  console.log('CONFIRMED: lockout never fired despite', attempts, 'failures (first XFF entry trusted, spoofable)')
  process.exit(42)
}
console.log('SAFE: lockout engaged (trusted last XFF entry used)')
process.exit(0)
