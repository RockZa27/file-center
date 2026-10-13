import { rmSync } from 'node:fs'
import { Elysia, t } from 'elysia'
import { audit } from '../audit'
import { confirmPassword } from '../auth'
import { config, paths } from '../config'
import { context, requireAdmin } from '../context'
import { bad, conflict, ensureDir, forbidden, fromFsError, HttpError } from '../fsx'
import { restartSoon, supervised } from '../lifecycle'
import { log } from '../logger'
import { langOf } from '../messages'
import { checkSource, fetchPackage, sourceStatus } from '../update-source'
import { applyStaged, discardStaged, rollbackTo, stagePackage, updateStatus } from '../updater'
import { completeUpload, initUpload, uploadsInProgress } from '../uploads'

const incoming = () => `${paths.app}/incoming`

function enabled() {
  if (!config.webUpdate) throw forbidden('update.disabled')
  if (!supervised()) {
    throw new HttpError(409, 'not-supervised')
  }
}

type Step = 'check' | 'fetch' | 'stage' | 'apply'

/** the same answer, plus which step of /fetch-and-apply gave it (params.step) */
function withStep(e: unknown, name: Step): HttpError {
  const known = fromFsError(e)
  if (known) return new HttpError(known.status, known.code, { ...known.params, step: name })
  log.error('update-fetch-and-apply-failed', { step: name, error: e })
  return new HttpError(500, 'request.internal', { step: name })
}

async function step<T>(name: Step, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw withStep(e, name)
  }
}

export const updateRoutes = new Elysia({ prefix: '/api/admin/update' })
  .use(context)

  .get('/', ({ user, ip, request }) => {
    requireAdmin({ user, ip })
    return { ...updateStatus(langOf(request)), source: sourceStatus(), uploadsInProgress: uploadsInProgress() }
  })

  // is there a newer version at UPDATE_SOURCE? Asked only when the admin presses the button
  .get('/check', ({ user, ip }) => {
    requireAdmin({ user, ip })
    return checkSource()
  })

  // download the newest package from UPDATE_SOURCE and stage it exactly like an uploaded one (same answer as /stage)
  .post('/fetch', async ({ user, ip }) => {
    const admin = requireAdmin({ user, ip })
    enabled()
    const got = await fetchPackage()
    try {
      const staged = await stagePackage(got.path, got.size)
      audit({ user: admin.username, ip, action: 'update-fetch', detail: staged.version })
      return staged
    } finally {
      rmSync(got.path, { force: true })
    }
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
    if (!r.signed) audit({ user: admin.username, ip, action: 'update-apply-unsigned', detail: r.version })
    restartSoon()
    return { ok: true, version: r.version, restarting: true }
  }, { body: t.Object({ id: t.String(), password: t.String({ maxLength: 1000 }) }) })

  // the button "update now": /check, /fetch and /apply in one go, after the password and with none of their checks left out
  .post('/fetch-and-apply', async ({ user, ip, body }) => {
    const admin = requireAdmin({ user, ip })
    enabled()
    // before anything is downloaded: a stolen session alone must not even make the server fetch a package
    await confirmPassword(admin, ip, body.password, 'update-denied')
    const checked = await step('check', () => checkSource())
    if (!checked.enabled) throw withStep(conflict('update.source-off'), 'check')
    if (!checked.newer) throw withStep(bad('update.source-not-newer', { version: checked.latest!.version, running: checked.current }), 'check')
    const got = await step('fetch', () => fetchPackage())
    let staged: Awaited<ReturnType<typeof stagePackage>>
    try {
      staged = await step('stage', () => stagePackage(got.path, got.size))
    } finally {
      rmSync(got.path, { force: true })
    }
    audit({ user: admin.username, ip, action: 'update-fetch', detail: staged.version })
    let r: Awaited<ReturnType<typeof applyStaged>>
    try {
      r = await step('apply', () => applyStaged(staged.id))
    } catch (e) {
      // a package that failed here is not left waiting on the update page
      discardStaged(staged.id)
      throw e
    }
    audit({ user: admin.username, ip, action: 'update-apply', detail: r.version })
    if (!r.signed) audit({ user: admin.username, ip, action: 'update-apply-unsigned', detail: r.version })
    restartSoon()
    return { ok: true, version: r.version, restarting: true }
  }, { body: t.Object({ password: t.String({ maxLength: 1000 }) }) })

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

