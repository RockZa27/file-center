import { Elysia, t } from 'elysia'
import { audit } from '../audit'
import { context, need } from '../context'
import { bad, normRel, storagePath } from '../fsx'
import { cancelUpload, completeUpload, initUpload, receivedChunks, saveChunk } from '../uploads'

export const uploadRoutes = new Elysia({ prefix: '/api/upload' })
  .use(context)

  // 1) announce a file, 2) PUT its chunks (any order, retried freely), 3) complete
  .post('/', ({ user, body }) => {
    const a = need({ user, ip: '' }, body.space, 'upload')
    const relDir = (body.relativeDir ?? '').split('/').filter(Boolean)
    if (relDir.length > 30) throw bad('โฟลเดอร์ซ้อนลึกเกินไป')
    return initUpload({
      owner: user?.username ?? 'guest',
      root: a.root,
      dir: normRel(body.path),
      relativeDir: relDir,
      name: body.name,
      size: body.size,
    })
  }, {
    body: t.Object({
      space: t.String(),
      path: t.String(),
      name: t.String(),
      size: t.Number(),
      relativeDir: t.Optional(t.String()),
    }),
  })

  .get('/:id', ({ user, params }) => receivedChunks(params.id, user?.username ?? 'guest'))

  .put('/:id/:index', async ({ user, params, request }) => {
    const data = await request.arrayBuffer()
    await saveChunk(params.id, user?.username ?? 'guest', Number(params.index), data)
    return { ok: true }
  }, { parse: 'none' })

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
