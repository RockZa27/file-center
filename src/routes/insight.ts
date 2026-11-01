import { Elysia, t } from 'elysia'
import { audit } from '../audit'
import { accessFor, isAdmin, USER_SPACE, type User } from '../auth'
import { config } from '../config'
import { context, manageable, requireAdmin, requireUser } from '../context'
import { forbidden, HttpError, normRel } from '../fsx'
import { insightState, startInsight } from '../insight'

/**
 * Storage insight (src/insight.ts) for one folder tree at a time:
 *   me         the caller's own space (an admin's is the whole storage)
 *   all        the whole storage (admin)
 *   user:<n>   the home of a user the caller manages (an admin: anyone; a manager: plain users, to look only)
 * Every request is checked again; the cache holds results by folder, never by who asked.
 */

type Target = { key: string; root: string; scope: string; space: string; base: string; canTrash: boolean; foreign: boolean }

function resolve(user: User, scope: string): Target {
  if (scope === 'all') {
    requireAdmin({ user, ip: '' })
    return { key: config.storageDir, root: config.storageDir, scope, space: 'home', base: '', canTrash: true, foreign: false }
  }
  if (scope === 'me') {
    const a = accessFor(user, 'home')
    if (!a || !a.perms.has('read')) throw forbidden()
    return { key: a.root, root: a.root, scope, space: 'home', base: '', canTrash: a.perms.has('write'), foreign: false }
  }
  if (scope.startsWith(USER_SPACE)) {
    const target = manageable(user, scope.slice(USER_SPACE.length))
    const a = accessFor(user, `${USER_SPACE}${target.username}`)
    if (!a) throw new HttpError(404, 'admin.user-not-found')
    // an admin's own space is the whole storage, so the user's files are deletable through it; a manager only looks
    return isAdmin(user)
      ? { key: a.root, root: a.root, scope: `${USER_SPACE}${target.username}`, space: 'home', base: normRel(target.homedir) === '/' ? '' : normRel(target.homedir), canTrash: true, foreign: true }
      : { key: a.root, root: a.root, scope: `${USER_SPACE}${target.username}`, space: a.space, base: '', canTrash: false, foreign: true }
  }
  throw new HttpError(400, 'request.invalid')
}

const view = (tg: Target) => ({ scope: tg.scope, space: tg.space, base: tg.base, canTrash: tg.canTrash, ...insightState(tg.key) })

export const insightRoutes = new Elysia({ prefix: '/api/insight' })
  .use(context)

  // what is known: { state: 'none' | 'running' | 'done', result? }
  .get('/', ({ user, ip, query }) => {
    const u = requireUser({ user, ip })
    return view(resolve(u, query.scope ?? 'me'))
  }, { query: t.Object({ scope: t.Optional(t.String({ maxLength: 100 })) }) })

  // start a scan in the background (one at a time on the server; a folder scanned a moment ago is not scanned again)
  .post('/scan', ({ user, ip, body, set }) => {
    const u = requireUser({ user, ip })
    const tg = resolve(u, body.scope ?? 'me')
    const outcome = startInsight(tg.key, tg.root)
    if (outcome === 'busy') throw new HttpError(429, 'insight.busy')
    if (outcome === 'started') {
      audit({ user: u.username, ip, action: 'insight-scan', target: tg.scope })
      set.status = 202
    }
    return { ...view(tg), outcome }
  }, { body: t.Object({ scope: t.Optional(t.String({ maxLength: 100 })) }) })
