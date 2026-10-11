// F3: upload owner check removed — anyone with the upload id can write/complete another user's upload.
// Victim A starts an upload into A's own home; attacker B (a different user) pushes bytes and completes it.
// Vulnerable: the file lands in A's folder with B's bytes. Safe: B is rejected (404) and no file appears.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setupEnv, importApp, login, send, createUser, fail, pass, vuln } from './helpers'

const { base } = setupEnv({ adminPassword: 'adminPassw0rd!' })
const app = await importApp()

const admin = await login(app, 'admin', 'adminPassw0rd!')
let r = await createUser(app, admin, { username: 'alice', name: 'Alice', password: 'alicePassw0rd!', permissions: ['read', 'write', 'upload', 'download'] })
if (r.status !== 200) fail(`create alice: ${r.status} ${await r.text()}`)
r = await createUser(app, admin, { username: 'mallory', name: 'Mallory', password: 'malloryPass0!', permissions: ['read', 'write', 'upload', 'download'] })
if (r.status !== 200) fail(`create mallory: ${r.status} ${await r.text()}`)

const alice = await login(app, 'alice', 'alicePassw0rd!')
const mallory = await login(app, 'mallory', 'malloryPass0!')

// Alice announces an upload of a 5-byte file into her own home root
const initRes = await send(app, 'POST', '/api/upload/', alice, { space: 'home', path: '/', name: 'victim.txt', size: 5 })
if (initRes.status !== 200) fail(`init upload: ${initRes.status} ${await initRes.text()}`)
const { id } = (await initRes.json()) as { id: string }

// Mallory, knowing the id, writes chunk 0 and completes the upload
const put = await app.handle(new Request(`http://localhost/api/upload/${id}/0`, {
  method: 'PUT',
  headers: { cookie: mallory.cookie, 'x-csrf-token': mallory.csrf },
  body: new Uint8Array([72, 65, 67, 75, 68]), // "HACKD"
}))
const complete = await send(app, 'POST', `/api/upload/${id}/complete`, mallory)

const victimFile = join(base, 'storage', 'users', 'alice', 'victim.txt')
if (existsSync(victimFile) && readFileSync(victimFile, 'utf8') === 'HACKD') {
  console.log(`Mallory wrote into Alice's folder (put=${put.status}, complete=${complete.status})`)
  vuln()
}
console.log(`Mallory blocked (put=${put.status}, complete=${complete.status}); no cross-user file — safe`)
pass()
