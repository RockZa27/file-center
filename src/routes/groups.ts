import { existsSync } from 'node:fs'
import { Elysia, t } from 'elysia'
import { audit } from '../audit'
import { canManage, confirmPassword, findUser, isAdmin, type User } from '../auth'
import { context, requireAdmin, requireStaff, requireUser } from '../context'
import { bad, conflict, forbidden, notFound } from '../fsx'
import {
  allGroups, createGroup, findGroup, findGroupByName, type Group, GROUP_NAME_MAX, groupOwner, groupRoot, groupsOf, memberOf, removeGroup,
  removeMember, saveGroups, setMember,
} from '../groups'
import { removeGrantsToGroup } from '../grants'
import { notify } from '../notify'
import { cleanQuota, counted, forget, usage } from '../quota'
import { moveToTrash, tombstoneTrashOf } from '../trash'

/**
 * Groups: a shared folder with members (src/groups.ts). Admins make, rename, limit and delete groups and manage their
 * members; a manager may add and remove only the plain users they manage, and only in a group they belong to
 * themselves (and never with more rights than their own); everybody else just sees the groups they are in.
 */

const permsT = t.Union([t.Literal('view'), t.Literal('edit')])
/** a slash would break the name as a folder name (WebDAV shows each group as one); control characters would break lines in the log */
const GROUP_NAME_CHARS = /[\x00-\x1f\x7f/\\]/

/** 1 to 64 characters, unique without regard to case, no slash (the name is a folder name for WebDAV) and no control character */
function cleanName(input: unknown, except?: Group): string {
  const name = typeof input === 'string' ? input.trim() : ''
  const length = [...name].length
  if (length < 1 || length > GROUP_NAME_MAX || GROUP_NAME_CHARS.test(name)) throw bad('groups.bad-name', { max: GROUP_NAME_MAX })
  const taken = findGroupByName(name)
  if (taken && taken !== except) throw conflict('groups.name-taken')
  return name
}

/** the group for a staff member: an admin sees all, a manager only the ones they are in; anything else is the same 404 as an unknown id */
function staffGroup(actor: User, id: unknown): Group {
  const g = findGroup(id)
  if (!g || (!isAdmin(actor) && !memberOf(g, actor.username))) throw notFound('groups.not-found')
  return g
}

/** a group as the admin pages show it; the folder is counted first, so `used` is a number and not a guess */
async function adminView(g: Group) {
  const owner = groupOwner(g)
  await counted(owner)
  return {
    id: g.id,
    name: g.name,
    space: `group:${g.id}`,
    quotaBytes: g.quotaBytes,
    used: usage(owner).used,
    createdAt: g.createdAt,
    createdBy: g.createdBy,
    members: g.members.map(m => ({ username: m.username, name: findUser(m.username)?.name ?? null, perms: m.perms })),
  }
}

/** a manager may add or remove only a user they manage, and give no more than they hold themself */
function checkMemberChange(actor: User, g: Group, target: User | undefined, perms?: 'view' | 'edit') {
  if (isAdmin(actor)) return
  if (!target || !canManage(actor, target)) throw forbidden('groups.not-manageable')
  if (perms === 'edit' && memberOf(g, actor.username)?.perms !== 'edit') throw forbidden('groups.not-manageable')
}

export const groupRoutes = new Elysia({ prefix: '/api' })
  .use(context)

  // ───────────── for every user ─────────────
  // the groups the caller belongs to (an admin who is not a member is not listed: the admin list has all)
  .get('/groups/mine', async ({ user, ip }) => {
    const u = requireUser({ user, ip })
    const items = await Promise.all(groupsOf(u.username).map(async g => {
      const owner = groupOwner(g)
      await counted(owner)
      return {
        id: g.id, name: g.name, perms: memberOf(g, u.username)!.perms, space: `group:${g.id}`, quotaBytes: g.quotaBytes,
        used: usage(owner).used,
      }
    }))
    return { items: items.sort((a, b) => a.name.localeCompare(b.name)) }
  })

  // for the share dialog: the groups the caller may share a folder with (their own; an admin: all), with the right to share
  .get('/groups/lookup', ({ user, ip, query }) => {
    const u = requireUser({ user, ip })
    if (!isAdmin(u) && !u.permissions.includes('share')) throw forbidden()
    const q = (query.q ?? '').trim().toLowerCase()
    const groups = (isAdmin(u) ? allGroups() : groupsOf(u.username))
      .filter(g => g.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 20)
      .map(g => ({ id: g.id, name: g.name }))
    return { groups }
  }, { query: t.Object({ q: t.Optional(t.String({ maxLength: 100 })) }) })

  // ───────────── staff ─────────────
  .get('/admin/groups', async ({ user, ip }) => {
    const actor = requireStaff({ user, ip })
    const mine = isAdmin(actor) ? allGroups() : groupsOf(actor.username)
    const items = await Promise.all(mine.map(adminView))
    return { items: items.sort((a, b) => a.name.localeCompare(b.name)) }
  })

  .post('/admin/groups', async ({ user, ip, body }) => {
    const admin = requireAdmin({ user, ip })
    const name = cleanName(body.name)
    const quotaBytes = body.quotaBytes === undefined ? 0 : cleanQuota(body.quotaBytes)
    const g = createGroup(name, quotaBytes, admin.username)
    audit({ user: admin.username, ip, action: 'group-create', target: g.name, detail: g.id })
    return { ok: true, group: await adminView(g) }
  }, { body: t.Object({ name: t.String(), quotaBytes: t.Optional(t.Number()) }) })

  .patch('/admin/groups/:id', async ({ user, ip, params, body }) => {
    const admin = requireAdmin({ user, ip })
    const g = findGroup(params.id)
    if (!g) throw notFound('groups.not-found')
    // every field is checked before one is applied
    const name = body.name === undefined ? undefined : cleanName(body.name, g)
    const quotaBytes = body.quotaBytes === undefined ? undefined : cleanQuota(body.quotaBytes)
    const before = g.name
    if (name !== undefined) g.name = name
    if (quotaBytes !== undefined) g.quotaBytes = quotaBytes
    saveGroups()
    // a new limit: the old count says nothing about it
    if (quotaBytes !== undefined) forget(groupOwner(g).username)
    const detail = [name !== undefined && name !== before ? `ชื่อเดิม ${before}` : '', quotaBytes !== undefined ? `quota ${quotaBytes}` : ''].filter(Boolean).join(', ')
    audit({ user: admin.username, ip, action: 'group-update', target: g.name, detail: detail || g.id })
    return { ok: true, group: await adminView(g) }
  }, { body: t.Object({ name: t.Optional(t.String()), quotaBytes: t.Optional(t.Number()) }) })

  // the folder goes to the admin trash (not purged); members lose access at once; the password is asked again
  .delete('/admin/groups/:id', async ({ user, ip, params, body }) => {
    const admin = requireAdmin({ user, ip })
    const g = findGroup(params.id)
    if (!g) throw notFound('groups.not-found')
    await confirmPassword(admin, ip, body.password, 'group-delete-denied')
    const abs = groupRoot(g)
    const owner = groupOwner(g).username
    // what members deleted from the folder earlier gets an owner nobody can have: only the admin trash shows it now
    tombstoneTrashOf(owner)
    removeGroup(g)
    removeGrantsToGroup(g.id)
    forget(owner)
    // after the group left the list, so the trash entry is no group's (the admin restores it from the admin trash)
    if (existsSync(abs)) await moveToTrash(abs, admin.username)
    audit({ user: admin.username, ip, action: 'group-delete', target: g.name, detail: g.id })
    return { ok: true }
  }, { body: t.Object({ password: t.String({ maxLength: 1000 }) }) })

  // add a member or change their rights
  .put('/admin/groups/:id/members', ({ user, ip, params, body }) => {
    const actor = requireStaff({ user, ip })
    const g = staffGroup(actor, params.id)
    const target = findUser(body.username.trim())
    if (!target) throw notFound('admin.user-not-found')
    checkMemberChange(actor, g, target, body.perms)
    const { added, member } = setMember(g, target.username, body.perms)
    audit({ user: actor.username, ip, action: 'group-member-add', target: g.name, detail: `${member.username}, ${member.perms}${added ? '' : ' (เปลี่ยนสิทธิ์)'}` })
    if (added) notify(member.username, 'group-added', { name: g.name, perms: member.perms }, `/groups/${g.id}`)
    return { ok: true, added, member }
  }, { body: t.Object({ username: t.String(), perms: permsT }) })

  .delete('/admin/groups/:id/members/:username', ({ user, ip, params }) => {
    const actor = requireStaff({ user, ip })
    const g = staffGroup(actor, params.id)
    const member = memberOf(g, params.username)
    if (!member) throw notFound('groups.member-not-found')
    checkMemberChange(actor, g, findUser(member.username))
    removeMember(g, member.username)
    audit({ user: actor.username, ip, action: 'group-member-remove', target: g.name, detail: member.username })
    return { ok: true }
  })
