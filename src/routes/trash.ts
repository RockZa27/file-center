import { join, relative } from 'node:path'
import { Elysia, t } from 'elysia'
import { audit } from '../audit'
import { accessFor, type Access, type User } from '../auth'
import { config } from '../config'
import { context, requireUser } from '../context'
import { forbidden, normRel, notFound, resolveIn, within } from '../fsx'
import { activeGrantsTo } from '../grants'
import { listTrash, purge, readTrash, restore, trashOwner, type TrashMeta } from '../trash'

/**
 * A user's own trash: what was deleted from their home, and what they deleted themselves from a place they can still
 * write to. It is the same central trash the admin sees (src/trash.ts); these routes only narrow it down and every
 * answer for an entry that is not the caller's is the same 404 as for an id that does not exist.
 */

const same = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase()

/** the spaces the caller can write to now: home, the folders shared with them for editing, the public folder */
function writableSpaces(user: User): Access[] {
  const out: Access[] = []
  const add = (a: Access | null) => { if (a?.perms.has('write')) out.push(a) }
  add(accessFor(user, 'home'))
  for (const g of activeGrantsTo(user)) add(accessFor(user, `grant:${g.grant.id}`))
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

/** the owner sees it; so does whoever deleted it, as long as the place it came from is one they can still write to */
function visible(user: User, meta: TrashMeta, spaces: Access[]): boolean {
  if (same(trashOwner(meta), user.username)) return true
  if (!same(meta.deletedBy, user.username)) return false
  return !!locate(spaces, join(config.storageDir, normRel(meta.originalPath)))
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
        // where it goes back to, in the caller's own terms; null when it can not go back (the home moved, no write right)
        space: at?.access.space ?? null,
        path: at?.path ?? null,
        restorable: !!at,
      }
    })
    return { items, retentionDays: config.trashRetentionDays }
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
    const meta = mine(u, params.id, writableSpaces(u))
    purge(meta.id)
    audit({ user: u.username, ip, action: 'trash-delete-own', target: meta.originalPath })
    return { ok: true, removed: 1 }
  })

  .delete('/trash', ({ user, ip }) => {
    const u = requireUser({ user, ip })
    const spaces = writableSpaces(u)
    const own = listTrash().filter(m => visible(u, m, spaces))
    for (const m of own) purge(m.id)
    audit({ user: u.username, ip, action: 'trash-delete-own', detail: `${own.length} รายการ` })
    return { ok: true, removed: own.length }
  })
