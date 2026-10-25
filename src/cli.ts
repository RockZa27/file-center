/**
 * Commands for the server's operator, run on the server itself against DATA_DIR (the same settings as the app):
 *   bun src/cli.ts reset-2fa <user>         turns 2FA off for a user who lost the phone and the backup codes
 *   bun src/cli.ts sessions-revoke <user>   signs the user out everywhere and removes their app passwords (WebDAV)
 * Works while the app is running: the app notices the change on its next request (see reloadIfChangedByCli).
 */
import { writeFileSync } from 'node:fs'
import { removeAppPasswordsOf } from './app-passwords'
import { audit } from './audit'
import { destroyUserSessions, dropLoginTickets, findUser, saveUsers } from './auth'
import { paths } from './config'
import { JsonStore } from './store'

const [command, name] = process.argv.slice(2)

function usage(): never {
  console.error('Usage: bun src/cli.ts reset-2fa <user> | sessions-revoke <user>')
  process.exit(1)
}

if ((command !== 'reset-2fa' && command !== 'sessions-revoke') || !name) usage()

const user = findUser(name)
if (!user) {
  console.error(`No such user: ${name}`)
  process.exit(1)
}

if (command === 'reset-2fa') {
  const had = !!user.twoFactor
  delete user.twoFactor
  saveUsers()
  dropLoginTickets(user.username)
  const n = destroyUserSessions(user.username)
  const apps = removeAppPasswordsOf(user.username)
  audit({ user: 'cli', ip: '-', action: '2fa-reset', target: user.username, detail: `${n} session, ${apps} app password` })
  console.log(`${had ? 'Two-factor sign-in turned off' : 'Two-factor sign-in was not on'} for ${user.username}; ${n} session(s) ended, ${apps} app password(s) removed.`)
} else {
  const n = destroyUserSessions(user.username)
  const apps = removeAppPasswordsOf(user.username)
  audit({ user: 'cli', ip: '-', action: 'sessions-revoke', target: user.username, detail: `${n} session, ${apps} app password` })
  console.log(`${n} session(s) of ${user.username} ended, ${apps} app password(s) removed.`)
}

await JsonStore.flushAll()
// last: tells a running app to read users.json and sessions.json again
writeFileSync(paths.cliChanged, `${Date.now()}-${process.pid}`)
process.exit(0)
