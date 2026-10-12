// F7: a user home folder may be set inside the public folder.
// cleanHomedir only rejects exactly "/public". Admin creates a user with homedir "/public/shared";
// that user then gets full home rights on content served to guests.
// Vulnerable: creation succeeds and the user can write into storage/public. Safe: creation is rejected (400).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setupEnv, importApp, login, send, createUser, fail, pass, vuln } from './helpers'

const { base } = setupEnv({ adminPassword: 'adminPassw0rd!' })
const app = await importApp()

const admin = await login(app, 'admin', 'adminPassw0rd!')
const create = await createUser(app, admin, {
  username: 'intruder', name: 'Intruder', password: 'intruderPass0!',
  homedir: '/public/shared', permissions: ['read', 'write', 'upload', 'download'],
})
if (create.status !== 200) {
  console.log(`homedir inside /public rejected (${create.status}) — safe`)
  pass()
}

// The user can now create content directly inside the public folder.
const user = await login(app, 'intruder', 'intruderPass0!')
const mk = await send(app, 'POST', '/api/mkdir', user, { space: 'home', path: '/', name: 'pwned' })
const landed = join(base, 'storage', 'public', 'shared', 'pwned')
if (mk.status === 200 && existsSync(landed)) {
  console.log('user home resolved inside storage/public and user wrote there — vulnerable')
  vuln()
}
fail(`creation accepted but write did not land in public (mkdir=${mk.status})`)
