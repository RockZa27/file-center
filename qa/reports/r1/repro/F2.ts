// F2: POST /api/rename checks 'read' instead of 'write'.
// A user whose publicPermissions are only ['read'] renames a file in /public.
// CONFIRMED (42) if a read-only user renames a public file.
// SAFE  (0)      if the rename is rejected (403).
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { freshEnv, getSession, login, createUser, post, confirmed, pass } from './helper'

const env = freshEnv()
const srcIndex = process.env.FC_SRC ?? '../../src/index'
const { app } = await import(srcIndex)

// an existing public file
const pub = join(env.storage, 'public')
writeFileSync(join(pub, 'manual.txt'), 'original content')

// admin creates a read-only user (read in both spaces, nothing else)
const admin = await login(app as any, 'admin', env.adminPassword)
if (admin.status !== 200) throw new Error('admin login failed: ' + admin.status)
await createUser(app as any, admin, { username: 'reader', password: 'ReaderPass123!', permissions: ['read'], publicPermissions: ['read'] })

const reader = await login(app as any, 'reader', 'ReaderPass123!')
if (reader.status !== 200) throw new Error('reader login failed: ' + reader.status)

const res = await post(app as any, '/api/rename', reader, { space: 'public', path: '/manual.txt', name: 'renamed.txt' })
const renamed = existsSync(join(pub, 'renamed.txt')) && !existsSync(join(pub, 'manual.txt'))
console.log('rename status =', res.status, 'renamed on disk =', renamed)

if (res.status === 200 && renamed) {
  confirmed('read-only user renamed /public/manual.txt -> renamed.txt (write op allowed with only read)')
}
pass(`rename rejected for read-only user (status ${res.status})`)
