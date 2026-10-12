import { call, login, makeUser, run, ADMIN_PW, STORAGE } from './_h'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
// bob must not be able to write to / complete alice's upload (should be 404). Vulnerable: file lands in alice's home.
run(async () => {
  const admin = await login('admin', ADMIN_PW)
  await makeUser(admin, 'alice')
  await makeUser(admin, 'bob')
  const alice = await login('alice', 'UserPass-12345')
  const bob = await login('bob', 'UserPass-12345')
  const init = await call('POST', '/api/upload', alice, { space: 'home', path: '/', name: 'planted.txt', size: 5 })
  const id = init.json?.id
  if (!id) throw new Error('init failed ' + init.text)
  const put = await call('PUT', `/api/upload/${id}/0`, bob, undefined, { raw: new TextEncoder().encode('BOBBY') })
  const done = await call('POST', `/api/upload/${id}/complete`, bob)
  const file = join(STORAGE, 'users', 'alice', 'planted.txt')
  const landed = existsSync(file) && readFileSync(file, 'utf8') === 'BOBBY'
  console.log('bob PUT chunk ->', put.status, '| bob complete ->', done.status, '| file in alice home with bob data:', landed)
  return put.status === 200 && done.status === 200 && landed
})
