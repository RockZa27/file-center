import { rmSync } from 'node:fs'
import { Elysia, t } from 'elysia'
import { audit } from '../audit'
import { confirmPassword } from '../auth'
import { config, paths } from '../config'
import { context, requireAdmin } from '../context'
import { ensureDir, forbidden, HttpError } from '../fsx'
import { restartSoon, supervised } from '../lifecycle'
import { applyStaged, discardStaged, rollbackTo, stagePackage, updateStatus } from '../updater'
import { completeUpload, initUpload, uploadsInProgress } from '../uploads'

const incoming = () => `${paths.app}/incoming`

function enabled() {
  if (!config.webUpdate) throw forbidden('update.disabled')
  if (!supervised()) {
    throw new HttpError(409, 'not-supervised')
  }
}

export const updateRoutes = new Elysia({ prefix: '/api/admin/update' })
  .use(context)

  .get('/', ({ user, ip }) => {
    requireAdmin({ user, ip })
    return { ...updateStatus(), uploadsInProgress: uploadsInProgress() }
  })

  // 1) announce the package, 2) PUT its chunks to /api/upload/:id/:n, 3) stage it
  .post('/upload', ({ user, ip, body }) => {
    const admin = requireAdmin({ user, ip })
    enabled()
    if (body.size > config.updateMaxSize) throw new HttpError(413, 'update.too-big')
    ensureDir(incoming())
    return initUpload({ owner: admin.username, root: incoming(), dir: '/', relativeDir: [], name: 'update.zip', size: body.size })
  }, { body: t.Object({ size: t.Number() }) })

  .post('/stage', async ({ user, ip, body }) => {
    const admin = requireAdmin({ user, ip })
    enabled()
    const done = await completeUpload(body.id, admin.username)
    try {
      const staged = await stagePackage(done.path, done.size)
      audit({ user: admin.username, ip, action: 'update-stage', detail: staged.version })
      return staged
    } finally {
      rmSync(done.path, { force: true })
    }
  }, { body: t.Object({ id: t.String() }) })

  .delete('/staged/:id', ({ user, ip, params }) => {
    requireAdmin({ user, ip })
    discardStaged(params.id)
    return { ok: true }
  })

  .post('/apply', async ({ user, ip, body }) => {
    const admin = requireAdmin({ user, ip })
    enabled()
    await confirmPassword(admin, ip, body.password, 'update-denied')
    // the package's own code runs for the first time in here (its test run), so only after the password
    const r = await applyStaged(body.id)
    audit({ user: admin.username, ip, action: 'update-apply', detail: r.version })
    restartSoon()
    return { ok: true, version: r.version, restarting: true }
  }, { body: t.Object({ id: t.String(), password: t.String({ maxLength: 1000 }) }) })

  .post('/rollback', async ({ user, ip, body }) => {
    const admin = requireAdmin({ user, ip })
    enabled()
    await confirmPassword(admin, ip, body.password, 'update-denied')
    // "builtin" = the version that came with the image
    const r = await rollbackTo(body.dir === 'builtin' ? null : body.dir)
    audit({ user: admin.username, ip, action: 'update-rollback', detail: r.version })
    restartSoon()
    return { ok: true, version: r.version, restarting: true }
  }, { body: t.Object({ dir: t.String(), password: t.String({ maxLength: 1000 }) }) })

