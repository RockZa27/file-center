// F2: POST /api/password has no lockout on wrong `current` password, so a stolen session cookie
// can be used to brute-force the current password with unlimited attempts (vs. login lockout).
import { setupEnv, session, loginAdmin, createUser } from './helper'

setupEnv('f2')

async function main() {
  const { app, cookie: sessCookie, csrf: sessCsrf } = await session()
  const admin = await loginAdmin(app, sessCookie, sessCsrf)

  // create a normal user with a known real password
  const realPassword = 'CorrectHorseBattery9!'
  await createUser(app, admin.cookie, admin.csrf, 'victim', realPassword)

  // victim logs in -> gets their own session/csrf (simulates attacker having stolen this session cookie)
  const { app: app2, cookie: vSessCookie, csrf: vSessCsrf } = await session()
  const vLogin = await app2.handle(new Request('http://localhost/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: vSessCookie, 'x-csrf-token': vSessCsrf },
    body: JSON.stringify({ username: 'victim', password: realPassword }),
  }))
  const vCookie = (vLogin.headers.get('set-cookie') ?? '').split(';')[0]
  const vBody: any = await vLogin.json()
  const vCsrf = vBody.csrf

  // attacker (holding the session cookie) brute-forces the `current` password field with many wrong guesses
  const attempts = 30
  let lockedAt = -1
  for (let i = 0; i < attempts; i++) {
    const res = await app2.handle(new Request('http://localhost/api/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: vCookie, 'x-csrf-token': vCsrf },
      body: JSON.stringify({ current: `wrong-guess-${i}`, next: 'SomeNewPassw0rd!' }),
    }))
    if (res.status === 429) { lockedAt = i; break }
    if (res.status !== 400) {
      console.error('unexpected status', res.status, await res.text())
      process.exit(1)
    }
  }

  if (lockedAt === -1) {
    console.error(`no lockout after ${attempts} wrong current-password guesses on /api/password`)
    process.exit(42)
  }
  console.error('locked out at attempt', lockedAt)
  process.exit(0)
}

main()
