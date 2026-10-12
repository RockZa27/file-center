// F9: backup restore skips the password step-up.
// With a valid admin session but a WRONG password, restore must be refused (403) like update/apply.
// Vulnerable: body.password is ignored and the restore runs (200). Safe: confirmPassword -> 403.
// Only the step-up is under test: the backup name is a real, existing backup.
import { setupEnv, importApp, login, send, fail, pass, vuln } from './helpers'

setupEnv({ adminPassword: 'adminPassw0rd!', supervised: true })
const app = await importApp()

const admin = await login(app, 'admin', 'adminPassw0rd!')

// make a real backup so the name is valid and existing
const made = await send(app, 'POST', '/api/admin/backups', admin)
if (made.status !== 200) fail(`create backup: ${made.status} ${await made.text()}`)
const { name } = (await made.json()) as { name: string }

const res = await send(app, 'POST', '/api/admin/backups/restore', admin, { name, password: 'the-WRONG-password' })
const text = await res.text()
if (res.status === 200) { console.log(`restore ran with a wrong password (200): ${text.slice(0, 100)}`); vuln() }
console.log(`restore refused on wrong password (${res.status}) — safe`); pass()
