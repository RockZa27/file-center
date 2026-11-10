/**
 * Commands for the server's operator, run on the server itself against DATA_DIR (the same settings as the app):
 *   bun src/cli.ts reset-2fa <user>         turns 2FA off for a user who lost the phone and the backup codes
 *   bun src/cli.ts sessions-revoke <user>   signs the user out everywhere and removes their app passwords (WebDAV)
 *   bun src/cli.ts backup-key               prints a new BACKUP_ENCRYPTION_KEY (nothing is saved)
 *   bun src/cli.ts backup-decrypt <file.zip.enc> <out.zip>   opens an encrypted backup with BACKUP_ENCRYPTION_KEY from the environment
 * Works while the app is running: the app notices the change on its next request (see reloadIfChangedByCli).
 */
import { existsSync } from 'node:fs'

const [command, name, target] = process.argv.slice(2)

function usage(): never {
  console.error('Usage: bun src/cli.ts reset-2fa <user> | sessions-revoke <user> | backup-key | backup-decrypt <file.zip.enc> <out.zip>')
  process.exit(1)
}

// the backup commands need no data folder: they run before anything of the app is loaded
if (command === 'backup-key') {
  const { newBackupKey } = await import('./backup-crypt')
  console.log(newBackupKey())
  console.error(`
Put this line in .env:  BACKUP_ENCRYPTION_KEY=<the key above>
AND keep a copy in a second safe place (a password manager, a printed sheet in a safe), never next to the backups.
Without this key the encrypted backups cannot be opened by anyone.

นำค่าด้านบนไปใส่ใน .env เป็นบรรทัด BACKUP_ENCRYPTION_KEY=<กุญแจ>
และเก็บสำเนาไว้ในที่ปลอดภัยอีกแห่ง (เช่นโปรแกรมจัดการรหัสผ่าน หรือกระดาษในตู้เซฟ) ห้ามเก็บไว้ข้างไฟล์สำรอง
ถ้ากุญแจหาย ไฟล์สำรองที่เข้ารหัสไว้จะเปิดไม่ได้อีกเลย`)
  process.exit(0)
}

if (command === 'backup-decrypt') {
  if (!name || !target) usage()
  const { BackupCryptError, backupKeyState, decryptFile } = await import('./backup-crypt')
  const state = backupKeyState()
  if (state.state !== 'on') {
    console.error(state.state === 'off'
      ? 'BACKUP_ENCRYPTION_KEY is not set in the environment. / ยังไม่ได้ตั้ง BACKUP_ENCRYPTION_KEY'
      : 'BACKUP_ENCRYPTION_KEY is not valid (32 random bytes as base64url, 43 characters). / BACKUP_ENCRYPTION_KEY ไม่ถูกต้อง')
    process.exit(1)
  }
  if (!existsSync(name)) {
    console.error(`No such file: ${name}`)
    process.exit(1)
  }
  if (existsSync(target)) {
    console.error(`${target} already exists and is not overwritten. / มีไฟล์ ${target} อยู่แล้ว จะไม่เขียนทับ`)
    process.exit(1)
  }
  try {
    await decryptFile(name, target, state.key)
  } catch (err) {
    if (err instanceof BackupCryptError) {
      console.error(err.code === 'backup.key-wrong'
        ? 'Wrong key: this backup was encrypted with another BACKUP_ENCRYPTION_KEY. / กุญแจไม่ตรงกับที่ใช้เข้ารหัสไฟล์สำรองนี้'
        : 'The backup is damaged, was changed or is incomplete. / ไฟล์สำรองเสียหาย ถูกแก้ไข หรือไม่ครบ')
    } else {
      console.error(`Could not decrypt: ${(err as Error).message}`)
    }
    process.exit(1)
  }
  console.log(`Decrypted to ${target}`)
  process.exit(0)
}

if ((command !== 'reset-2fa' && command !== 'sessions-revoke') || !name) usage()

// loaded only now: importing the app's modules creates DATA_DIR
const { writeFileSync } = await import('node:fs')
const { removeAppPasswordsOf } = await import('./app-passwords')
const { audit } = await import('./audit')
const { destroyUserSessions, dropLoginTickets, findUser, saveUsers } = await import('./auth')
const { paths } = await import('./config')
const { JsonStore } = await import('./store')

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
