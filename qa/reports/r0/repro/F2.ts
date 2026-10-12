import { call, login, makeUser, run, ADMIN_PW, STORAGE } from './_h'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
// A state-changing request with a WRONG csrf token (valid session cookie) must be 403.
run(async () => {
  const admin = await login('admin', ADMIN_PW)
  await makeUser(admin, 'alice')
  const alice = await login('alice', 'UserPass-12345')
  const bad = await call('POST', '/api/mkdir', alice, { space: 'home', path: '/', name: 'csrf-made' }, { csrf: 'totally-wrong-token' })
  const made = existsSync(join(STORAGE, 'users', 'alice', 'csrf-made'))
  console.log('mkdir with wrong csrf token ->', bad.status, '| folder created:', made)
  // control: no token at all must be refused either way
  const none = await call('POST', '/api/mkdir', alice, { space: 'home', path: '/', name: 'no-token' }, { csrf: null })
  console.log('control (no token) ->', none.status)
  return bad.status === 200 && made && none.status === 403
})
