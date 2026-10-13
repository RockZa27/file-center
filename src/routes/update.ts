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
import { isBeta } from '../release'
import { checkSource, fetchPackage, sourceStatus, type Channel } from '../update-source'
import { applyStaged, discardStaged, rollbackTo, stagePackage, updateStatus } from '../updater'
import { completeUpload, initUpload, uploadsInProgress } from '../uploads'

const incoming = () => `${paths.app}/incoming`

function enabled() {
  if (!config.webUpdate) throw forbidden('update.disabled')
  if (!supervised()) {
    throw new HttpError(409, 'not-supervised')
  }
}

/** `channel` is optional (stable); a beta needs `acceptBetaRisk: true` and is refused before anything is downloaded */
/**
 * stage a downloaded package, which must be the version its channel's latest.json named: the signature proves who
 * built a package, not which channel it belongs to, so a stable latest.json can not hand out a signed beta
 */
async function stageFetched(got: { path: string; size: number; version: string }) {
  const staged = await stagePackage(got.path, got.size)
  if (staged.version !== got.version) {
    discardStaged(staged.id)
    throw new HttpError(502, 'update.source-mismatch')
  }
  return staged
}

const channelBody = { channel: t.Optional(t.Union([t.Literal('stable'), t.Literal('beta')])), acceptBetaRisk: t.Optional(t.Boolean()) }
function channelOf(body: { channel?: Channel; acceptBetaRisk?: boolean } | null | undefined): Channel {
  const channel = body?.channel ?? 'stable'
  if (channel === 'beta' && body?.acceptBetaRisk !== true) throw bad('update.beta-not-accepted')
  return channel
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
  .post('/fetch', async ({ user, ip, body }) => {
    const admin = requireAdmin({ user, ip })
    enabled()
    const channel = channelOf(body)
    const got = await fetchPackage(channel)
    try {
      const staged = await stageFetched(got)
      audit({ user: admin.username, ip, action: 'update-fetch', detail: staged.version })
      return staged
    } finally {
      rmSync(got.path, { force: true })
    }
  }, { body: t.Optional(t.Object(channelBody)) })

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
    if (isBeta(r.version)) audit({ user: admin.username, ip, action: 'update-apply-beta', detail: r.version })
    restartSoon()
    return { ok: true, version: r.version, restarting: true }
  }, { body: t.Object({ id: t.String(), password: t.String({ maxLength: 1000 }) }) })

  // the button "update now": /check, /fetch and /apply in one go, after the password and with none of their checks left out
  .post('/fetch-and-apply', async ({ user, ip, body }) => {
    const admin = requireAdmin({ user, ip })
    enabled()
    const channel = channelOf(body)
    // before anything is downloaded: a stolen session alone must not even make the server fetch a package
    await confirmPassword(admin, ip, body.password, 'update-denied')
    const checked = await step('check', () => checkSource({ beta: channel === 'beta' }))
    if (!checked.enabled) throw withStep(conflict('update.source-off'), 'check')
    if (channel === 'beta') {
      if (!checked.beta) throw withStep(bad('update.beta-none'), 'check')
    } else if (!checked.newer) throw withStep(bad('update.source-not-newer', { version: checked.latest!.version, running: checked.current }), 'check')
    const got = await step('fetch', () => fetchPackage(channel))
    let staged: Awaited<ReturnType<typeof stagePackage>>
    try {
      staged = await step('stage', () => stageFetched(got))
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
    if (isBeta(r.version)) audit({ user: admin.username, ip, action: 'update-apply-beta', detail: r.version })
    restartSoon()
    return { ok: true, version: r.version, restarting: true }
  }, { body: t.Object({ password: t.String({ maxLength: 1000 }), ...channelBody }) })

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

