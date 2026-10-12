// F3: another user can write into / cancel someone else's upload by id
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { adminLogin, call, done, json, makeUser } from './helper'
const admin = await adminLogin()
const alice = await makeUser(admin, 'alice')
const mallory = await makeUser(admin, 'mallory')
const init = await call('POST', '/api/upload', alice.sess, { space: 'home', path: '/', name: 'report.txt', size: 5 })
const { id } = await json(init) as any
if (init.status !== 200 || !id) throw new Error(`init ${init.status}`)
// mallory (a different signed-in user) writes alice's chunk
const put = await call('PUT', `/api/upload/${id}/0`, mallory.sess, new TextEncoder().encode('EVIL!'))
console.log('mallory PUT chunk:', put.status, await put.text())
if (put.status === 200) {
  // alice completes her upload: her file now holds mallory's bytes
  const fin = await call('POST', `/api/upload/${id}/complete`, alice.sess)
  console.log('alice complete:', fin.status, await fin.text())
  const f = join(process.env.STORAGE_DIR!, 'users', 'alice', 'report.txt')
  const content = existsSync(f) ? readFileSync(f, 'utf8') : null
  console.log('alice file content:', content)
  done(content === 'EVIL!', "another user wrote the content of alice's upload")
}
done(false, 'chunk from a different user refused')
