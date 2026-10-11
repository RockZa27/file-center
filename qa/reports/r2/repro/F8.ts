// F8: BACKUP_NAME_RE ("file-center-backup-.+\.zip") allows "/" and "..", and backupPath() joins without
// a within() check, so restore (name comes from the JSON body) can read a .zip from anywhere on disk.
// Here a .zip sitting OUTSIDE the backup dir (as if a regular user had uploaded it) is restored via traversal.
// Vulnerable: restore reads the outside zip (200). Safe: backupPath within() guard -> 400.
// A VALID admin password is supplied so the step-up (present on safe code) is not what's being tested.
import { copyFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { setupEnv, importApp, login, send, fail, pass, vuln } from './helpers'

const { base } = setupEnv({ adminPassword: 'adminPassw0rd!', supervised: true })
const app = await importApp()

const admin = await login(app, 'admin', 'adminPassw0rd!')

// a real, valid backup zip (contains a users.json with an admin, so checkData passes)
const made = await send(app, 'POST', '/api/admin/backups', admin)
if (made.status !== 200) fail(`create backup: ${made.status} ${await made.text()}`)
const { name: realName } = (await made.json()) as { name: string }

const backupDir = join(base, 'backups')
const legit = join(backupDir, realName)
// drop it OUTSIDE the backup dir, under storage (somewhere a non-admin could put a file)
const outside = join(base, 'storage', 'pwn.zip')
copyFileSync(legit, outside)

// craft a traversal name that still matches /^file-center-backup-.+\.zip$/
const traversal = `file-center-backup-x/../${relative(backupDir, outside)}`
if (join(backupDir, traversal) !== outside) fail(`traversal does not resolve to the outside file: ${join(backupDir, traversal)}`)
if (!/^file-center-backup-.+\.zip$/.test(traversal)) fail(`crafted name fails the regex: ${traversal}`)

const res = await send(app, 'POST', '/api/admin/backups/restore', admin, { name: traversal, password: 'adminPassw0rd!' })
const text = await res.text()
if (res.status === 200) { console.log(`restored a zip from outside the backup dir via traversal (200): ${text.slice(0, 100)}`); vuln() }
console.log(`traversal name rejected (${res.status}) — safe`); pass()
