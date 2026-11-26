import { Elysia, t } from 'elysia'
import { audit } from '../audit'
import { context, need } from '../context'
import { bad, HttpError, normRel, storagePath } from '../fsx'
import { sizeText } from '../messages'
import * as policy from '../policy'
import { settings } from '../settings'
import { quotaUserOf, ready } from '../quota'
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
  }, async ({ user, ip, body }) => {
    const a = need({ user, ip: '' }, body.space, 'upload')
    const relDir = (body.relativeDir ?? '').split('/').filter(Boolean)
    if (relDir.length > 30) throw bad('upload.too-deep')
    // only a home space (or a folder shared with the caller: the owner's quota) counts against a quota; the count is awaited here so the reservation itself needs no await
    // a visitor's file is held to the largest size the admin chose when opening the public folder to uploads (a setting
    // from before 2.0.0-beta.3 has none yet: the general upload limit then)
    if (!user) {
      const mb = settings.get().guestUploadMaxMb
      const max = mb ? mb * 1024 ** 2 : policy.uploadMaxSize()
      if (Number(body.size) > max) throw new HttpError(413, 'upload.guest-too-big', { max, maxText: sizeText(max) })
    }
    const quotaUser = quotaUserOf(a, user) ?? undefined
    await ready(quotaUser)
    return initUpload({
      quotaUser,
      space: a.space,
      owner: user?.username ?? 'guest',
      ownerUser: user ?? undefined,
      guest: !user,
      ip,
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
    checkUpload(params.id, owner, user)
    const data = await request.arrayBuffer()
    await saveChunk(params.id, owner, Number(params.index), data, user)
    return { ok: true }
  })

  .post('/:id/complete', async ({ user, ip, params }) => {
    const owner = user?.username ?? 'guest'
    const done = await completeUpload(params.id, owner, user)
    // a repeat (the client did not get the first answer) is not a second upload
    if (!done.again) audit({ user: owner, ip, action: 'upload', target: storagePath(done.path), detail: String(done.size) })
    return { ok: true, size: done.size }
  })

  .delete('/:id', ({ user, params }) => {
    cancelUpload(params.id, user?.username ?? 'guest')
    return { ok: true }
  })
