import { existsSync } from 'node:fs'
import { Elysia, t } from 'elysia'
import { context, need, requireUser } from '../context'
import { normRel, notFound, resolveIn } from '../fsx'
import { addFavorite, listFavorites, listRecent, removeFavorite } from '../favorites'

const place = t.Object({ space: t.String(), path: t.String() })

/** the signed-in user's own lists: favorites and recently opened files (a visitor has none: 401) */
export const meRoutes = new Elysia({ prefix: '/api/me' })
  .use(context)

  .get('/favorites', ({ user, ip }) => ({ items: listFavorites(requireUser({ user, ip })) }))

  .post('/favorites', { body: place }, ({ user, ip, body }) => {
    const u = requireUser({ user, ip })
    const a = need({ user: u, ip }, body.space, 'read')
    if (!existsSync(resolveIn(a.root, normRel(body.path)))) throw notFound()
    addFavorite(u, body.space, body.path)
    return { ok: true }
  })

  .delete('/favorites', { body: place }, ({ user, ip, body }) => {
    removeFavorite(requireUser({ user, ip }), body.space, body.path)
    return { ok: true }
  })

  .get('/recent', ({ user, ip }) => ({ items: listRecent(requireUser({ user, ip })) }))
