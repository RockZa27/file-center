import { join, relative } from 'node:path'
import { Elysia, t } from 'elysia'
import { audit } from '../audit'
import { accessFor, type Access, type User } from '../auth'
import { config } from '../config'
import * as policy from '../policy'
import { context, requireUser } from '../context'
import { forbidden, normRel, notFound, resolveIn, within } from '../fsx'
import { activeGrantsTo } from '../grants'
import { groupOfOwner, groupsOf, memberOf } from '../groups'
import { listTrash, purge, readTrash, restore, trashOwner, type TrashMeta } from '../trash'

/**
 * A user's own trash: what was deleted from their home, and what they deleted themselves from a place they can still
 * write to. It is the same central trash the admin sees (src/trash.ts); these routes only narrow it down and every
 * answer for an entry that is not the caller's is the same 404 as for an id that does not exist.
 */

const same = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase()

/** the spaces the caller can write to now: home, the folders shared with them for editing, the groups they may edit, the public folder */
function writableSpaces(user: User): Access[] {
  const out: Access[] = []
  const add = (a: Access | null) => { if (a?.perms.has('write')) out.push(a) }
  add(accessFor(user, 'home'))
  for (const g of activeGrantsTo(user)) add(accessFor(user, `grant:${g.grant.id}`))
  // as a member only: an admin who is not one sees group items in the admin trash
  for (const g of groupsOf(user.username)) add(accessFor(user, `group:${g.id}`))
  add(accessFor(user, 'public'))
  return out
}

/** where in one of the caller's writable spaces `abs` lies (a link that would lead out of the space does not count) */
function locate(spaces: Access[], abs: string): { access: Access; path: string } | null {
  for (const a of spaces) {
    if (!within(a.root, abs)) continue
    const path = normRel(relative(a.root, abs))
    try { resolveIn(a.root, path) } catch { continue }
    return { access: a, path }
  }
  return null
}

/** an entry of a group folder belongs to the group: every member who may edit there sees it */
function ofMyGroup(user: User, meta: TrashMeta): boolean {
  const g = groupOfOwner(trashOwner(meta))
  return !!g && memberOf(g, user.username)?.perms === 'edit'
}

/** the owner sees it; so does whoever deleted it, as long as the place it came from is one they can still write to */
function visible(user: User, meta: TrashMeta, spaces: Access[]): boolean {
  if (ofMyGroup(user, meta)) return true
  if (same(trashOwner(meta), user.username)) return true
  if (!same(meta.deletedBy, user.username)) return false
  return !!locate(spaces, join(config.storageDir, normRel(meta.originalPath)))
}

/**
 * who may remove an entry for good: its owner; and, for what lay outside every home (the public folder), whoever deleted
 * it. Someone who deleted it from a folder shared with them may undo that (restore) but not destroy it.
 */
function purgeable(user: User, meta: TrashMeta, spaces: Access[]): boolean {
  const owner = trashOwner(meta)
  // a group's entry: any editor restores it, but only the one who deleted it (still an editor) destroys it; the admin does so from the admin trash
  if (groupOfOwner(owner)) return same(meta.deletedBy, user.username) && ofMyGroup(user, meta)
  if (owner) return same(owner, user.username)
  return visible(user, meta, spaces)
}

/** the entry, or the same 404 as an unknown id */
function mine(user: User, id: unknown, spaces: Access[]): TrashMeta {
  const meta = readTrash(id)
  if (!visible(user, meta, spaces)) throw notFound()
  return meta
}

export const trashRoutes = new Elysia({ prefix: '/api/me' })
  .use(context)

  .get('/trash', ({ user, ip }) => {
    const u = requireUser({ user, ip })
    const spaces = writableSpaces(u)
    const items = listTrash().filter(m => visible(u, m, spaces)).map(m => {
      const at = locate(spaces, join(config.storageDir, normRel(m.originalPath)))
      return {
        id: m.id, name: m.name, type: m.type, size: m.size, deletedAt: m.deletedAt, deletedBy: m.deletedBy,
        owner: trashOwner(m),
        // set when the item came from a group folder (owner is then `group:<id>`)
        group: (g => (g ? { id: g.id, name: g.name } : null))(groupOfOwner(trashOwner(m))),
        // where it goes back to, in the caller's own terms; null when it can not go back (the home moved, no write right)
        space: at?.access.space ?? null,
        path: at?.path ?? null,
        restorable: !!at,
      }
    })
    return { items, retentionDays: policy.trashRetentionDays() }
  })

  .post('/trash/:id/restore', async ({ user, ip, params }) => {
    const u = requireUser({ user, ip })
    const spaces = writableSpaces(u)
    const picked: { into?: Access } = {}
    const r = await restore(params.id, (meta, target) => {
      if (!visible(u, meta, spaces)) throw notFound()
      const at = locate(spaces, target)
      if (!at) throw forbidden('trash.cannot-restore-here')
      picked.into = at.access
    })
    audit({ user: u.username, ip, action: 'trash-restore-own', target: r.restoredTo })
    const into = picked.into!
    const space = into.space
    const path = normRel(relative(into.root, join(config.storageDir, r.restoredTo)))
    return { ok: true, restoredTo: r.restoredTo, space, path }
  })

  .delete('/trash/:id', ({ user, ip, params }) => {
    const u = requireUser({ user, ip })
    const spaces = writableSpaces(u)
    const meta = mine(u, params.id, spaces)
    if (!purgeable(u, meta, spaces)) throw forbidden('trash.cannot-purge')
    purge(meta.id)
    audit({ user: u.username, ip, action: 'trash-delete-own', target: meta.originalPath })
    return { ok: true, removed: 1 }
  })

  .delete('/trash', ({ user, ip }) => {
    const u = requireUser({ user, ip })
    const spaces = writableSpaces(u)
    const own = listTrash().filter(m => visible(u, m, spaces) && purgeable(u, m, spaces))
    for (const m of own) purge(m.id)
    audit({ user: u.username, ip, action: 'trash-delete-own', detail: `${own.length} รายการ` })
    return { ok: true, removed: own.length }
  })
