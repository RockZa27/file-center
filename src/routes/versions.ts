import { copyFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Elysia, t } from 'elysia'
import { audit } from '../audit'
import { context, need } from '../context'
import { recordRecent } from '../favorites'
import { conflict, ensureSpace, normRel, notFound, resolveIn, storagePath } from '../fsx'
import { holdNow, markStale, ownerOfPath, ready } from '../quota'
import { indexTouched } from '../search-index'
import { dropVersion, getVersion, listVersions, reserveVersion } from '../versions'
import { fileResponse } from './files'

const fileQ = t.Object({ space: t.String(), path: t.String() })

/** the file these routes work on; every version id is looked up through it, an id alone opens nothing */
function fileOf(root: string, path: string): string {
  const abs = resolveIn(root, normRel(path))
  if (!existsSync(abs) || !statSync(abs).isFile()) throw notFound()
  return abs
}

export const versionRoutes = new Elysia({ prefix: '/api/versions' })
  .use(context)

  .get('/', ({ user, query }) => {
    const a = need({ user, ip: '' }, query.space, 'read')
    const abs = fileOf(a.root, query.path)
    const st = statSync(abs)
    return {
      current: { size: st.size, mtime: Math.round(st.mtimeMs) },
      items: listVersions(abs).map(({ id, size, mtime, savedAt, savedBy, reason }) => ({ id, size, mtime, savedAt, savedBy, reason })),
    }
  }, { query: fileQ })

  .get('/:id/download', ({ user, query, params, request }) => {
    const a = need({ user, ip: '' }, query.space, 'download')
    const abs = fileOf(a.root, query.path)
    const v = getVersion(abs, params.id)
    return fileResponse(v.item, basename(abs), request, false)
  }, { query: fileQ })

  .post('/:id/restore', async ({ user, ip, params, body }) => {
    const a = need({ user, ip }, body.space, 'write')
    const abs0 = resolveIn(a.root, normRel(body.path))
    // the counts are awaited first: from the check of the file to the write there is no await
    const owner = ownerOfPath(abs0)
    await ready(owner)
    const q = a.space === 'home' ? user : null
    await ready(q)
    const abs = fileOf(a.root, body.path)
    const v = getVersion(abs, params.id)
    const st = statSync(abs)
    if (body.expectedMtime !== undefined && Math.round(st.mtimeMs) !== body.expectedMtime) throw conflict('files.changed-elsewhere')
    const grow = v.meta.size - st.size
    ensureSpace(dirname(abs), Math.max(0, grow))
    const stage = join(dirname(abs), `.${basename(abs)}.restore-${randomBytes(6).toString('hex')}`)
    // the chosen version is copied out first: making room below may drop the oldest versions, this one among them
    try { copyFileSync(v.item, stage) } catch (err) { rmSync(stage, { force: true }); throw err }
    let ticket: ReturnType<typeof reserveVersion> = null
    let hold
    try {
      // what is there now becomes a version first (when over the quota the oldest go, then the restore is refused)
      ticket = reserveVersion(owner, abs)
      hold = holdNow(q, grow)
    } catch (err) {
      rmSync(stage, { force: true })
      ticket?.release()
      throw err
    }
    try {
      ticket?.keep('restore', user?.username ?? 'guest')
      renameSync(stage, abs)
    } catch (err) {
      rmSync(stage, { force: true })
      hold.release()
      ticket?.release()
      throw err
    }
    hold.commit(grow)
    if (grow < 0 && q) markStale(q.username)
    indexTouched(abs)
    audit({ user: user?.username ?? 'guest', ip, action: 'version-restore', target: storagePath(abs), detail: params.id })
    recordRecent(user, body.space, normRel(body.path))
    return { ok: true, mtime: Math.round(statSync(abs).mtimeMs) }
  }, { body: t.Object({ space: t.String(), path: t.String(), expectedMtime: t.Optional(t.Number()) }) })

  // the query is optional in the schema on purpose: validation runs before the CSRF check, which must answer 403 first
  .delete('/:id', ({ user, ip, params, query }) => {
    const a = need({ user, ip }, query.space, 'write')
    const abs = fileOf(a.root, query.path ?? '')
    const v = getVersion(abs, params.id)
    dropVersion(v.meta, v.dir)
    audit({ user: user?.username ?? 'guest', ip, action: 'version-delete', target: storagePath(abs), detail: params.id })
    return { ok: true }
  }, { query: t.Object({ space: t.Optional(t.String()), path: t.Optional(t.String()) }) })
