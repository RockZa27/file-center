// F1: Anonymous visitors get every permission in the public folder.
// settings.guestPermissions defaults to [read,download,batchdownload] but accessFor()
// returns new Set(PERMISSIONS) for a guest, so a write op (mkdir) must succeed.
// CONFIRMED (42) if an unauthenticated visitor can create a folder in /public.
// SAFE  (0)      if the write is rejected (401/403).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { freshEnv, getSession, post, confirmed, pass } from './helper'

const env = freshEnv()
const srcIndex = process.env.FC_SRC ?? '../../src/index'
const { app } = await import(srcIndex)

// A visitor who never logs in: just the anon session + CSRF token from GET /api/session.
const guest = await getSession(app as any)
if (!guest.csrf) throw new Error('no csrf for guest session')

const folder = 'pwned_by_guest'
const res = await post(app as any, '/api/mkdir', guest, { space: 'public', path: '/', name: folder })
const onDisk = existsSync(join(env.storage, 'public', folder))

console.log('mkdir status =', res.status, 'folder on disk =', onDisk)

if (res.status === 200 && onDisk) {
  confirmed(`guest created /public/${folder} with no account (write permission granted to anonymous visitor)`)
}
pass(`guest write rejected (status ${res.status})`)
