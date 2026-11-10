import { existsSync } from 'node:fs'
import { Elysia, t } from 'elysia'
import { audit } from '../audit'
import { confirmPassword } from '../auth'
import { context, need, requireUser } from '../context'
import { forbidden, HttpError, normRel, notFound, resolveIn } from '../fsx'
import { activityPageSize, buildExport, exportWait, markExport, myActivity } from '../my-data'
import { addFavorite, listFavorites, listRecent, removeFavorite } from '../favorites'

const place = t.Object({ space: t.String(), path: t.String() })

/** the signed-in user's own lists: favorites and recently opened files (a visitor has none: 401) */
export const meRoutes = new Elysia({ prefix: '/api/me' })
  .use(context)

  .get('/favorites', ({ user, ip }) => ({ items: listFavorites(requireUser({ user, ip })) }))

  .post('/favorites', { body: place }, ({ user, ip, body }) => {
    const u = requireUser({ user, ip })
    const a = need({ user: u, ip }, body.space, 'read')
    if (a.space !== 'home' && a.space !== 'public') throw forbidden()
    if (!existsSync(resolveIn(a.root, normRel(body.path)))) throw notFound()
    addFavorite(u, body.space, body.path)
    return { ok: true }
  })

  .delete('/favorites', { body: place }, ({ user, ip, body }) => {
    removeFavorite(requireUser({ user, ip }), body.space, body.path)
    return { ok: true }
  })

  .get('/recent', ({ user, ip }) => ({ items: listRecent(requireUser({ user, ip })) }))

  // The caller's own trail (my-data.ts decides what counts as theirs). Reading it is not itself audited.
  .get('/activity', {
    query: t.Object({ page: t.Optional(t.String()), pageSize: t.Optional(t.String()) }),
  }, ({ user, ip, query }) =>
    myActivity(requireUser({ user, ip }), Math.max(1, Number(query.page) || 1), activityPageSize(query.pageSize)))

  // A copy of the personal data kept about the caller (PDPA right of access), as a JSON download. The password is asked
  // first (a stolen session must not be able to hand the file over), then one export a minute per account.
  .post('/export', { body: t.Object({ password: t.String({ maxLength: 1000 }) }) }, async ({ user, ip, body }) => {
    const u = requireUser({ user, ip })
    await confirmPassword(u, ip, body.password, 'export-denied')
    const wait = exportWait(u.username)
    if (wait) throw new HttpError(429, 'me.export-cooldown', { seconds: wait })
    markExport(u.username)
    const now = new Date()
    const data = buildExport(u, now)
    audit({ user: u.username, ip, action: 'data-export' })
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="file-center-${u.username}-${now.toISOString().slice(0, 10)}.json"`,
        'Cache-Control': 'no-store',
      },
    })
  })
