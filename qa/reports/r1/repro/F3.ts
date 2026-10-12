// F3: GET /api/download checks 'read' instead of 'download'.
// A user granted only ['read'] (download withheld) downloads the file bytes.
// CONFIRMED (42) if a read-only (no-download) user retrieves the file contents.
// SAFE  (0)      if the download is rejected (403).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshEnv, login, createUser, get, confirmed, pass } from './helper'

const env = freshEnv()
const srcIndex = process.env.FC_SRC ?? '../../src/index'
const { app } = await import(srcIndex)

const secret = 'TOP-SECRET-BYTES-12345'
writeFileSync(join(env.storage, 'public', 'secret.txt'), secret)

const admin = await login(app as any, 'admin', env.adminPassword)
if (admin.status !== 200) throw new Error('admin login failed: ' + admin.status)
// read but explicitly NOT download
await createUser(app as any, admin, { username: 'reader', password: 'ReaderPass123!', permissions: ['read'], publicPermissions: ['read'] })

const reader = await login(app as any, 'reader', 'ReaderPass123!')
if (reader.status !== 200) throw new Error('reader login failed: ' + reader.status)

const res = await get(app as any, '/api/download?space=public&path=/secret.txt', reader)
const text = res.status === 200 ? await res.text() : ''
console.log('download status =', res.status, 'got secret =', text === secret)

if (res.status === 200 && text === secret) {
  confirmed('read-only (no download perm) user downloaded /public/secret.txt contents')
}
pass(`download rejected for no-download user (status ${res.status})`)
