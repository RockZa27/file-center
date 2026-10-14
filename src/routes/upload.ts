import { Elysia, t } from 'elysia'
import { audit } from '../audit'
import { context, need } from '../context'
import { bad, normRel, storagePath } from '../fsx'
import { ready } from '../quota'
import { cancelUpload, checkUpload, completeUpload, initUpload, receivedChunks, saveChunk } from '../uploads'

export const uploadRoutes = new Elysia({ prefix: '/api/upload' })
  .use(context)

  // 1) announce a file, 2) PUT its chunks (any order, retried freely), 3) complete
  .post('/', {
    body: t.Object({
      space: t.String(),
      path: t.String(),
      name: t.String(),
      size: t.Number(),
      relativeDir: t.Optional(t.String()),
    }),
  }, async ({ user, body }) => {
    const a = need({ user, ip: '' }, body.space, 'upload')
    const relDir = (body.relativeDir ?? '').split('/').filter(Boolean)
    if (relDir.length > 30) throw bad('upload.too-deep')
    // only a home space counts against a quota; the count is awaited here so the reservation itself needs no await
    const quotaUser = a.space === 'home' && user ? user : undefined
    await ready(quotaUser)
    return initUpload({
      quotaUser,
      owner: user?.username ?? 'guest',
      guest: !user,
      root: a.root,
      dir: normRel(body.path),
      relativeDir: relDir,
      name: body.name,
      size: body.size,
    })
  })

  .get('/:id', ({ user, params }) => receivedChunks(params.id, user?.username ?? 'guest'))

  .put('/:id/:index', { parse: 'none' }, async ({ user, params, request }) => {
    const owner = user?.username ?? 'guest'
    // before buffering a whole chunk in memory: a stranger without a valid upload id costs nothing
    checkUpload(params.id, owner)
    const data = await request.arrayBuffer()
    await saveChunk(params.id, owner, Number(params.index), data)
    return { ok: true }
  })

  .post('/:id/complete', async ({ user, ip, params }) => {
    const owner = user?.username ?? 'guest'
    const done = await completeUpload(params.id, owner)
    audit({ user: owner, ip, action: 'upload', target: storagePath(done.path), detail: String(done.size) })
    return { ok: true, size: done.size }
  })

  .delete('/:id', ({ user, params }) => {
    cancelUpload(params.id, user?.username ?? 'guest')
    return { ok: true }
  })
