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
import { findGroup, memberOf } from '../groups'

/** letters needed before a search for a user starts, and the most names one answer holds */
const LOOKUP_MIN = 3
const LOOKUP_MAX = 10
/** a light limit: this many searches per user per minute (a search box sends one per pause in typing) */
const LOOKUP_PER_MINUTE = 20
/** giving a folder to a name tells whether the name exists: that many tries per user per minute, so it is no free search */
const GIVE_PER_MINUTE = 30

/** `max` calls per minute and user; 0 when this one may go on, else the seconds to wait */
function minuteLimit(max: number) {
  const seen = new Map<string, { start: number; count: number }>()
  return (username: string): number => {
    const now = Date.now()
    const key = username.toLowerCase()
    if (seen.size > 5000) for (const [k, v] of seen) if (now - v.start >= 60_000) seen.delete(k)
    let e = seen.get(key)
    if (!e || now - e.start >= 60_000) { e = { start: now, count: 0 }; seen.set(key, e) }
    e.count++
    return e.count > max ? Math.max(1, Math.ceil((e.start + 60_000 - now) / 1000)) : 0
  }
}
const lookupAllowed = minuteLimit(LOOKUP_PER_MINUTE)
const giveAllowed = minuteLimit(GIVE_PER_MINUTE)

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
    // a grant to a group has no `to` (null): toGroup (id) and toGroupName say who gets it, and are left out for a grant to a user
    to: g.toGroup ? null : g.to,
    toName: g.toGroup ? null : findUser(g.to)?.name ?? null,
    ...(g.toGroup ? { toGroup: g.toGroup, toGroupName: findGroup(g.toGroup)?.name ?? null } : {}),
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
    const staff = u.role === 'admin' || u.role === 'manager'
    const users = allUsers()
      // staff are not listed to plain users (the list of who runs the server); the exact name still works in POST /grants
      .filter(x => !same(x.username, u.username) && (staff || x.role === 'user') && (x.username.toLowerCase().includes(q) || x.name.toLowerCase().includes(q)))
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
    const wait = giveAllowed(owner.username)
    if (wait) throw new HttpError(429, 'grants.create-rate', { seconds: wait })
    const rel = normRel(body.path)
    if (rel === '/') throw bad('grants.folder-only')
    const abs = resolveIn(a.root, rel)
    if (!existsSync(abs)) throw notFound('files.folder-not-found')
    // one recipient: a user, or a group the caller belongs to (an admin may use any group). An unknown group, or one the
    // caller is not in, is the same 404 as an unknown id
    if ((body.to === undefined) === (body.toGroup === undefined)) throw bad('grants.to-one')
    let to: User | undefined
    const group = body.toGroup === undefined ? undefined : findGroup(body.toGroup)
    if (body.toGroup !== undefined) {
      if (!group || (owner.role !== 'admin' && !memberOf(group, owner.username))) throw notFound('groups.not-found')
    } else {
      to = findUser(body.to!.trim())
      if (!to) throw notFound('admin.user-not-found')
      if (same(to.username, owner.username)) throw bad('grants.to-self')
    }
    const path = storagePath(abs)
    const recipient = group ? { group } : to!
    const toName = to?.username ?? ''
    // a file, a link or a path through a link is no folder of this home
    if (!grantTarget({ id: '', owner: owner.username, path, to: toName, ...(group ? { toGroup: group.id } : {}), perms: body.perms, createdAt: '' })) throw bad('grants.folder-only')
    const sameRecipient = (g: Grant) => (group ? g.toGroup === group.id : !g.toGroup && same(g.to, toName))
    if (grantsOf(owner.username).length >= GRANTS_PER_USER && !grantsOf(owner.username).some(g => g.path === path && sameRecipient(g))) {
      throw bad('grants.too-many', { max: GRANTS_PER_USER })
    }
    const { grant, created } = saveGrant(owner, recipient, path, body.perms)
    audit({ user: owner.username, ip, action: created ? 'grant-create' : 'grant-update', target: path, detail: `${group ? `กลุ่ม ${group.name}` : toName}, ${grant.perms}` })
    if (created) onGrantCreated(grant)
    return { ok: true, created, grant: given(grant) }
  }, { body: t.Object({ space: t.String(), path: t.String(), to: t.Optional(t.String()), toGroup: t.Optional(t.String()), perms: permsT }) })

  // ───────────── lists ─────────────
  .get('/grants/mine', ({ user, ip }) => {
    const u = requireUser({ user, ip })
    return { items: grantsOf(u.username).map(given) }
  })

  // what the caller can use now; the owner's own path and anything else of theirs stays out of it
  .get('/grants/to-me', ({ user, ip }) => {
    const u = requireUser({ user, ip })
    return {
      items: activeGrantsTo(u).map(({ grant, owner, abs, perms, viaGroup }) => ({
        id: grant.id,
        space: `grant:${grant.id}`,
        name: basename(abs),
        owner: owner.username,
        ownerName: owner.name,
        // for a group grant what this member gets: edit only when both the grant and their place in the group allow it
        perms,
        // only for a folder that came through a group (the member can not leave it; only the owner ends it)
        ...(viaGroup ? { viaGroup: { id: viaGroup.id, name: viaGroup.name } } : {}),
        createdAt: grant.createdAt,
      })),
    }
  })

  // ───────────── change / end ─────────────
  .patch('/grants/:id', ({ user, ip, params, body }) => {
    const u = requireUser({ user, ip })
    const g = ownGrant(u, params.id)
    if (g.perms !== body.perms) setGrantPerms(g, body.perms)
    audit({ user: u.username, ip, action: 'grant-update', target: g.path, detail: `${g.toGroup ? `กลุ่ม ${findGroup(g.toGroup)?.name ?? g.toGroup}` : g.to}, ${g.perms}` })
    return { ok: true, grant: given(g) }
  }, { body: t.Object({ perms: permsT }) })

  // the owner takes it back; the recipient leaves
  .delete('/grants/:id', ({ user, ip, params }) => {
    const u = requireUser({ user, ip })
    const g = findGrant(params.id)
    const isOwner = !!g && same(g.owner, u.username)
    // a member of a group does not leave a group grant alone: only the owner ends it
    if (!g || (!isOwner && (g.toGroup || !same(g.to, u.username)))) throw notFound()
    removeGrant(g)
    audit({ user: u.username, ip, action: 'grant-delete', target: g.path, detail: isOwner ? (g.toGroup ? `กลุ่ม ${findGroup(g.toGroup)?.name ?? g.toGroup}` : g.to) : `${g.owner}, leave` })
    return { ok: true }
  })
