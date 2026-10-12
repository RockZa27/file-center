// F4: admin backup routes reach a .zip outside BACKUP_DIR via '/..' in the name
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { adminLogin, base, call, done } from './helper'
const admin = await adminLogin()
// a zip that lives outside BACKUP_DIR (base/backups) and outside storage: base/elsewhere/secret.zip
mkdirSync(join(base, 'elsewhere'), { recursive: true })
const secret = join(base, 'elsewhere', 'secret.zip')
writeFileSync(secret, 'PK-outside-backup-dir')
mkdirSync(process.env.BACKUP_DIR!, { recursive: true })
const name = encodeURIComponent('file-center-backup-/../../elsewhere/secret.zip')
const dl = await call('GET', `/api/admin/backups/${name}/download`, admin)
const body = await dl.text()
console.log('download outside BACKUP_DIR:', dl.status, JSON.stringify(body.slice(0, 60)))
const del = await call('DELETE', `/api/admin/backups/${name}`, admin)
console.log('delete outside BACKUP_DIR:', del.status, await del.text(), 'file still there:', existsSync(secret))
done((dl.status === 200 && body === 'PK-outside-backup-dir') || (del.status === 200 && !existsSync(secret)), 'backup name escapes BACKUP_DIR')
