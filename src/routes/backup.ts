import { rmSync } from 'node:fs'
import { Elysia, t } from 'elysia'
import { audit } from '../audit'
import { confirmPassword } from '../auth'
import {
  backupPath, backupSettings, BACKUP_NAME_RE, listBackups, restoreBackup, runBackup, statusIn,
} from '../backup'
import { context, requireAdmin } from '../context'
import { fileResponse } from './files'
import { bad, HttpError } from '../fsx'
import { restartSoon, supervised } from '../lifecycle'
import { langOf } from '../messages'

export const backupRoutes = new Elysia({ prefix: '/api/admin' })
  .use(context)

  .get('/backups', ({ user, ip, request }) => {
    requireAdmin({ user, ip })
    return { items: listBackups(), status: statusIn(langOf(request)), settings: backupSettings() }
  })

  .post('/backups', async ({ user, ip }) => {
    const admin = requireAdmin({ user, ip })
    const item = await runBackup()
    audit({ user: admin.username, ip, action: 'backup-create', target: item.name })
    return item
  })

  .get('/backups/:name/download', ({ user, ip, params, request }) => {
    const admin = requireAdmin({ user, ip })
    const abs = backupPath(params.name)
    // a resumed download asks for the rest only: one audit line per download, not per part
    if (!request.headers.get('range')) audit({ user: admin.username, ip, action: 'backup-download', target: params.name })
    // the same answer as any file download: Range and validators, so a backup of gigabytes can be resumed after a break
    const res = fileResponse(abs, params.name, request, false)
    res.headers.set('Cache-Control', 'no-store')
    return res
  })

  .delete('/backups/:name', ({ user, ip, params }) => {
    const admin = requireAdmin({ user, ip })
    rmSync(backupPath(params.name))
    audit({ user: admin.username, ip, action: 'backup-delete', target: params.name })
    return { ok: true }
  })

  // puts back users, passwords, settings and the logo of a backup, then restarts so the app reads them
  .post('/backups/restore', async ({ user, ip, body }) => {
    const admin = requireAdmin({ user, ip })
    if (!supervised()) {
      throw new HttpError(409, 'not-supervised')
    }
    if (!BACKUP_NAME_RE.test(body.name)) throw bad('backup.bad-name')
    await confirmPassword(admin, ip, body.password, 'backup-restore-denied')
    const { safety } = await restoreBackup(body.name)
    audit({ user: admin.username, ip, action: 'backup-restore', target: body.name, detail: `สำรองข้อมูลก่อนกู้คืนไว้ที่ ${safety.name}` })
    restartSoon()
    return { ok: true, restarting: true, safety: safety.name }
  }, { body: t.Object({ name: t.String({ maxLength: 200 }), password: t.String({ maxLength: 1000 }) }) })
