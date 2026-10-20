import { existsSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { Elysia, t } from 'elysia'
import { audit } from '../audit'
import { accessFor, allUsers, findUser, type User } from '../auth'
import { config } from '../config'
import { context, need, requireUser } from '../context'
import { bad, forbidden, HttpError, normRel, notFound, resolveIn, storagePath } from '../fsx'
import {
  activeGrantsTo, findGrant, type Grant, grantsOf, grantTarget, GRANTS_PER_USER, onGrantCreated, removeGrant, saveGrant,
  setGrantPerms,
} from '../grants'

/** letters needed before a search for a user starts, and the most names one answer holds */
const LOOKUP_MIN = 2
const LOOKUP_MAX = 10
/** a light limit: this many searches per user per minute (a search box sends one per pause in typing) */
const LOOKUP_PER_MINUTE = 40
const lookups = new Map<string, { start: number; count: number }>()

function lookupAllowed(username: string): number {
  const now = Date.now()
  const key = username.toLowerCase()
  if (lookups.size > 5000) for (const [k, v] of lookups) if (now - v.start >= 60_000) lookups.delete(k)
  let e = lookups.get(key)
  if (!e || now - e.start >= 60_000) { e = { start: now, count: 0 }; lookups.set(key, e) }
  e.count++
  return e.count > LOOKUP_PER_MINUTE ? Math.max(1, Math.ceil((e.start + 60_000 - now) / 1000)) : 0
}

const permsT = t.Union([t.Literal('view'), t.Literal('edit')])
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** where the folder is in the owner's home, or null when it is not inside it any more */
function homePath(owner: User | undefined, g: Grant): string | null {
  const home = owner ? accessFor(owner, 'home') : null
  if (!home) return null
  const rel = relative(home.root, join(config.storageDir, normRel(g.path)))
  return rel && !rel.startsWith('..') ? normRel(rel) : null
}

/** a grant the caller gave, for their own list: `active` is false when it does not open anything now (the page can offer to remove it) */
function given(g: Grant) {
  const owner = findUser(g.owner)
  return {
    id: g.id,
    path: homePath(owner, g),
    name: basename(g.path),
    to: g.to,
    toName: findUser(g.to)?.name ?? null,
    perms: g.perms,
    createdAt: g.createdAt,
    active: !!grantTarget(g),
  }
}

/** the grant when the caller gave it; anyone else gets the same 404 as for an id that does not exist */
function ownGrant(user: User, id: unknown): Grant {
  const g = findGrant(id)
  if (!g || !same(g.owner, user.username)) throw notFound()
  return g
}

export const grantRoutes = new Elysia({ prefix: '/api' })
  .use(context)

  // ───────────── pick a person ─────────────
  .get('/users/lookup', ({ user, ip, query }) => {
    const u = requireUser({ user, ip })
    if (u.role !== 'admin' && !u.permissions.includes('share')) throw forbidden()
    const wait = lookupAllowed(u.username)
    if (wait) throw new HttpError(429, 'grants.lookup-rate', { seconds: wait })
    const q = query.q.trim().toLowerCase()
    if ([...q].length < LOOKUP_MIN) throw bad('grants.query-short', { min: LOOKUP_MIN })
    const users = allUsers()
      .filter(x => !same(x.username, u.username) && (x.username.toLowerCase().includes(q) || x.name.toLowerCase().includes(q)))
      .sort((a, b) => a.username.localeCompare(b.username))
      .slice(0, LOOKUP_MAX)
      .map(x => ({ username: x.username, name: x.name }))
    return { users }
  }, { query: t.Object({ q: t.String({ maxLength: 100 }) }) })

  // ───────────── give ─────────────
  .post('/grants', ({ user, ip, body }) => {
    const a = need({ user, ip }, body.space, 'share')
    // a folder of the caller's own home only: not a staff view, not a folder somebody shared with them
    if (a.space !== 'home') throw forbidden()
    const owner = requireUser({ user, ip })
    const rel = normRel(body.path)
    if (rel === '/') throw bad('grants.folder-only')
    const abs = resolveIn(a.root, rel)
    if (!existsSync(abs)) throw notFound('files.folder-not-found')
    const to = findUser(body.to.trim())
    if (!to) throw notFound('admin.user-not-found')
    if (same(to.username, owner.username)) throw bad('grants.to-self')
    const path = storagePath(abs)
    // a file, a link or a path through a link is no folder of this home
    if (!grantTarget({ id: '', owner: owner.username, path, to: to.username, perms: body.perms, createdAt: '' })) throw bad('grants.folder-only')
    if (grantsOf(owner.username).length >= GRANTS_PER_USER && !grantsOf(owner.username).some(g => g.path === path && same(g.to, to.username))) {
      throw bad('grants.too-many', { max: GRANTS_PER_USER })
    }
    const { grant, created } = saveGrant(owner, to, path, body.perms)
    audit({ user: owner.username, ip, action: created ? 'grant-create' : 'grant-update', target: path, detail: `${to.username}, ${grant.perms}` })
    if (created) onGrantCreated(grant)
    return { ok: true, created, grant: given(grant) }
  }, { body: t.Object({ space: t.String(), path: t.String(), to: t.String(), perms: permsT }) })

  // ───────────── lists ─────────────
  .get('/grants/mine', ({ user, ip }) => {
    const u = requireUser({ user, ip })
    return { items: grantsOf(u.username).map(given) }
  })

  // what the caller can use now; the owner's own path and anything else of theirs stays out of it
  .get('/grants/to-me', ({ user, ip }) => {
    const u = requireUser({ user, ip })
    return {
      items: activeGrantsTo(u).map(({ grant, owner, abs }) => ({
        id: grant.id,
        space: `grant:${grant.id}`,
        name: basename(abs),
        owner: owner.username,
        ownerName: owner.name,
        perms: grant.perms,
        createdAt: grant.createdAt,
      })),
    }
  })

  // ───────────── change / end ─────────────
  .patch('/grants/:id', ({ user, ip, params, body }) => {
    const u = requireUser({ user, ip })
    const g = ownGrant(u, params.id)
    if (g.perms !== body.perms) setGrantPerms(g, body.perms)
    audit({ user: u.username, ip, action: 'grant-update', target: g.path, detail: `${g.to}, ${g.perms}` })
    return { ok: true, grant: given(g) }
  }, { body: t.Object({ perms: permsT }) })

  // the owner takes it back; the recipient leaves
  .delete('/grants/:id', ({ user, ip, params }) => {
    const u = requireUser({ user, ip })
    const g = findGrant(params.id)
    const isOwner = !!g && same(g.owner, u.username)
    if (!g || (!isOwner && !same(g.to, u.username))) throw notFound()
    removeGrant(g)
    audit({ user: u.username, ip, action: 'grant-delete', target: g.path, detail: isOwner ? g.to : `${g.owner}, leave` })
    return { ok: true }
  })
