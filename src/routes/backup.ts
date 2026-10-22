import { rmSync } from 'node:fs'
import { Elysia, t } from 'elysia'
import { audit } from '../audit'
import { confirmPassword } from '../auth'
import {
  backupPath, backupSettings, BACKUP_NAME_RE, estimateBackup, listBackupsDetailed, restoreBackup, runBackup, saveBackupSettings,
  statusIn, turnsOnFiles,
} from '../backup'
import { context, requireAdmin } from '../context'
import { fileResponse } from './files'
import { bad, HttpError } from '../fsx'
import { restartSoon, supervised } from '../lifecycle'
import { langOf, text } from '../messages'

export const backupRoutes = new Elysia({ prefix: '/api/admin' })
  .use(context)

  .get('/backups', async ({ user, ip, request }) => {
    requireAdmin({ user, ip })
    return { items: await listBackupsDetailed(), status: statusIn(langOf(request)), settings: backupSettings() }
  })

  // how much room a backup would need now, and how much there is (the same check runs before every backup)
  .get('/backups/estimate', async ({ user, ip }) => {
    requireAdmin({ user, ip })
    return await estimateBackup()
  })

  // compression, schedule (server local time), copies to keep, files included. A key left out stays; null = back to the default
  .put('/backups/settings', async ({ user, ip, body }) => {
    const admin = requireAdmin({ user, ip })
    // the copies get as big as the whole storage: turning that on asks for the password
    if (turnsOnFiles(body)) await confirmPassword(admin, ip, body.password ?? '', 'backup-settings-denied')
    const changes = saveBackupSettings(body)
    audit({ user: admin.username, ip, action: 'backup-settings', detail: changes.join(', ') })
    return backupSettings()
  }, {
    body: t.Object({
      compression: t.Optional(t.Union([t.String(), t.Null()])),
      schedule: t.Optional(t.Union([t.Any(), t.Null()])),
      keep: t.Optional(t.Union([t.Number(), t.Null()])),
      includeFiles: t.Optional(t.Union([t.Boolean(), t.Null()])),
      password: t.Optional(t.String({ maxLength: 1000 })),
    }),
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
  .post('/backups/restore', async ({ user, ip, body, request }) => {
    const admin = requireAdmin({ user, ip })
    if (!supervised()) {
      throw new HttpError(409, 'not-supervised')
    }
    if (!BACKUP_NAME_RE.test(body.name)) throw bad('backup.bad-name')
    await confirmPassword(admin, ip, body.password, 'backup-restore-denied')
    const { safety, twoFactorLost } = await restoreBackup(body.name)
    audit({
      user: admin.username, ip, action: 'backup-restore', target: body.name,
      detail: `สำรองข้อมูลก่อนกู้คืนไว้ที่ ${safety.name}${twoFactorLost.length ? ` (2FA ใช้ไม่ได้บนเครื่องนี้: ${twoFactorLost.join(', ')})` : ''}`,
    })
    restartSoon()
    // secret.key is not in a backup: users with 2FA from another host can not sign in with a code until it is reset
    const warning = twoFactorLost.length
      ? (() => {
          const params = { count: twoFactorLost.length, users: twoFactorLost.slice(0, 20).join(', ') }
          return { code: 'backup.restore-2fa-lost' as const, params, message: text(langOf(request), 'backup.restore-2fa-lost', params) }
        })()
      : null
    return { ok: true, restarting: true, safety: safety.name, twoFactorLost, warning }
  }, { body: t.Object({ name: t.String({ maxLength: 200 }), password: t.String({ maxLength: 1000 }) }) })
