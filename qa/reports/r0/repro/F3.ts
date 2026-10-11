import { call, login, makeUser, run, ADMIN_PW, STORAGE } from './_h'
import { mkdtempSync, writeFileSync, symlinkSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// A symlink inside a user's home pointing outside the storage root must not be followed.
// (The API cannot create symlinks; one is planted on disk, as an operator/host process could.)
run(async () => {
  const outside = mkdtempSync(join(tmpdir(), 'fcr-outside-'))
  writeFileSync(join(outside, 'secret.txt'), 'TOP-SECRET-OUTSIDE')
  const admin = await login('admin', ADMIN_PW)
  await makeUser(admin, 'alice')
  const alice = await login('alice', 'UserPass-12345')
  mkdirSync(join(STORAGE, 'users', 'alice'), { recursive: true })
  symlinkSync(outside, join(STORAGE, 'users', 'alice', 'link'))
  const dl = await call('GET', '/api/download?space=home&path=/link/secret.txt', alice)
  const put = await call('PUT', '/api/content', alice, { space: 'home', path: '/link/secret.txt', content: 'OVERWRITTEN' })
  const disk = readFileSync(join(outside, 'secret.txt'), 'utf8')
  console.log('download via link ->', dl.status, JSON.stringify(dl.text.slice(0, 30)), '| write via link ->', put.status, '| outside file now:', disk)
  return dl.status === 200 && dl.text === 'TOP-SECRET-OUTSIDE' && disk === 'OVERWRITTEN'
})
