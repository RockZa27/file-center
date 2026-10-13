// F3: login lockout is keyed only by `ip|username`, so guessing a different username on every
// request from the same IP is never throttled, and the same account guessed from many IPs never
// locks as a whole. We prove the "different username per request never locks" half: send more
// wrong-password attempts than LOGIN_MAX_ATTEMPTS, each against a distinct nonexistent username
// from the same IP, and show none of them is ever rejected with 429 (always plain 401).
import { setupEnv, session } from './helper'

setupEnv('f3')

async function main() {
  const { app, cookie, csrf } = await session()

  const attempts = 20 // well above default LOGIN_MAX_ATTEMPTS (5)
  let got429 = false
  for (let i = 0; i < attempts; i++) {
    const res = await app.handle(new Request('http://localhost/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
      body: JSON.stringify({ username: `nosuchuser${i}`, password: 'whatever-wrong' }),
    }))
    if (res.status === 429) { got429 = true; break }
    if (res.status !== 401) {
      console.error('unexpected status', res.status, await res.text())
      process.exit(1)
    }
  }

  if (!got429) {
    console.error(`no lockout after ${attempts} login attempts from one IP using a different (nonexistent) username each time`)
    process.exit(42)
  }
  console.error('got 429 lockout as expected')
  process.exit(0)
}

main()
