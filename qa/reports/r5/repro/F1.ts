// F1: wrong share-link passwords never lock the link
import { adminLogin, call, done, json, makeUser, putFile, share } from './helper'
const admin = await adminLogin()
const bob = await makeUser(admin, 'bob')
await putFile(bob.sess, '/', 'secret.txt', 'top secret')
const token = await share(bob.sess, '/secret.txt', { password: 'right-pass-123' })
const statuses: number[] = []
for (let i = 0; i < 8; i++) {
  const r = await call('POST', `/api/s/${token}/unlock`, null, { password: `wrong-guess-${i}` })
  statuses.push(r.status); await r.text()
}
console.log('wrong attempts:', statuses.join(','))
if (statuses.includes(429)) done(false, 'lockout engaged after wrong passwords')
// the correct guess after 8 misses still unlocks, and the cookie opens the download
const ok = await call('POST', `/api/s/${token}/unlock`, null, { password: 'right-pass-123' })
const c = ok.headers.getSetCookie().map(x => x.split(';')[0]).join('; ')
const dl = await call('GET', `/api/s/${token}/download`, null, undefined, { cookie: c })
const body = await dl.text()
console.log('correct guess:', ok.status, 'download:', dl.status, JSON.stringify(body))
done(ok.status === 200 && dl.status === 200 && body === 'top secret', 'no lockout; brute force succeeds after 8 misses')
