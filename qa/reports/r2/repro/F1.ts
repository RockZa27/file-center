// F1: login/step-up lockout never triggers (lockedFor always returns 0).
// After loginMaxAttempts (default 5) failed logins the account must be locked (429).
// Vulnerable: still 401 (no lockout). Safe: 429.
import { setupEnv, importApp, anon, fail, pass, vuln } from './helpers'

const ADMIN = 'adminPassw0rd!'
setupEnv({ adminPassword: ADMIN })
const app = await importApp()

// one anon session reused for every attempt (failed logins do not rotate it)
const a = await anon(app)
async function tryLogin(pw: string) {
  return app.handle(new Request('http://localhost/api/login', {
    method: 'POST',
    headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: pw }),
  }))
}

// 5 failing attempts reach the threshold (count >= loginMaxAttempts sets the lockout)
for (let i = 0; i < 5; i++) {
  const r = await tryLogin('definitely-wrong')
  if (r.status !== 401) fail(`priming attempt ${i} expected 401, got ${r.status}`)
}

// the 6th attempt must be blocked (429) on safe code
const r = await tryLogin('definitely-wrong')
if (r.status === 429) { console.log('locked out (429) — safe'); pass() }
if (r.status === 401) { console.log('NOT locked out after 5 failures (401) — lockout disabled'); vuln() }
fail(`unexpected status ${r.status}: ${await r.text()}`)
