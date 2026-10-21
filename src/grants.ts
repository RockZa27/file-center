/**
 * Folders one user shares with another user of the system ("grants"), in DATA_DIR/grants.json.
 * A grant is only a place ({ owner, path, to, perms }); what it opens is decided again on every use (grantSpace, called
 * by accessFor for the space `grant:<id>`): both accounts still exist, the owner may still share, and the folder is
 * still a real folder (no link) inside the owner's current home. Anything that fails answers like an unknown id, so
 * a stranger learns nothing, and a grant of a deleted account or a moved folder simply stops working.
 *
 * A grant goes to one user (`to`) or to a group (`toGroup`, then `to` is empty): every member of the group at the
 * time of use gets it, a member who leaves stops having it, and a member who may only view the group gets no more than
 * view. Only the owner ends a group grant: a single member can not leave it.
 */
import { randomBytes } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join, relative } from 'node:path'
import { accessFor, findUser, type Access, type User } from './auth'
import { config, paths } from './config'
import { normRel, resolveIn, within } from './fsx'
import { findGroup, type Group, memberOf } from './groups'
import { log } from './logger'
import type { Perm } from './settings'
import { JsonStore } from './store'

export type GrantPerms = 'view' | 'edit'
export type Grant = {
  id: string
  owner: string
  /** where the folder is, relative to the storage root */
  path: string
  /** the recipient's username; empty for a group grant */
  to: string
  /** set for a grant to a group (groups.ts): its id */
  toGroup?: string
  perms: GrantPerms
  createdAt: string
}

export const GRANT_SPACE = 'grant:'
/** grants one user may hold as owner */
export const GRANTS_PER_USER = 200

/** view = look and take a copy; edit = also add and change files. Never `share`: a recipient can not pass it on */
const PERMS: Record<GrantPerms, Perm[]> = {
  view: ['read', 'download', 'batchdownload', 'zip'],
  edit: ['read', 'download', 'batchdownload', 'zip', 'upload', 'write'],
}

const store = new JsonStore<{ grants: Grant[] }>(paths.grants, () => ({ grants: [] }))

export const allGrants = () => store.value.grants
export const findGrant = (id: unknown) => (typeof id === 'string' ? allGrants().find(g => g.id === id) : undefined)
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export const grantsOf = (owner: string) => allGrants().filter(g => same(g.owner, owner))
export const grantsTo = (to: string) => allGrants().filter(g => !g.toGroup && same(g.to, to))
export const grantsToGroup = (id: string) => allGrants().filter(g => g.toGroup === id)

/**
 * What this user gets from the grant, or null when it is not for them: the recipient themself, or a member of the group
 * (never the owner through their own group, and a view-only member never gets edit)
 */
export function grantPermsFor(g: Grant, user: User): GrantPerms | null {
  if (!g.toGroup) return same(g.to, user.username) ? g.perms : null
  const group = findGroup(g.toGroup)
  const m = group && memberOf(group, user.username)
  if (!m || same(g.owner, user.username)) return null
  return g.perms === 'edit' && m.perms === 'edit' ? 'edit' : 'view'
}

/** the hook of the notifications module: it pushes a listener here, createGrant calls onGrantCreated */
export const grantCreatedListeners: ((grant: Grant) => void)[] = []
export function onGrantCreated(grant: Grant) {
  for (const fn of grantCreatedListeners) {
    try { fn(grant) } catch (err) { log.warn('grant-listener-failed', { id: grant.id, error: err }) }
  }
}

/**
 * The folder of a grant as it is now and the owner, or null when it does not work (account gone, no `share` any
 * more, folder gone, moved out of the owner's home, a link, or a link somewhere on the way to it).
 */
export function grantTarget(g: Grant): { owner: User; abs: string } | null {
  const owner = findUser(g.owner)
  if (!owner || !(g.toGroup ? findGroup(g.toGroup) : findUser(g.to))) return null
  try {
    const home = accessFor(owner, 'home')
    if (!home || !home.perms.has('share')) return null
    const abs = resolveIn(config.storageDir, normRel(g.path))
    const rel = relative(home.root, abs)
    if (!rel || rel.startsWith('..')) return null
    // resolveIn keeps the real path inside the home; here no step of the way may be a link at all
    let at = home.root
    for (const seg of rel.split('/')) {
      at = join(at, seg)
      if (lstatSync(at).isSymbolicLink()) return null
    }
    if (!lstatSync(abs).isDirectory()) return null
    return within(home.root, abs) ? { owner, abs } : null
  } catch {
    return null
  }
}

/** the space `grant:<id>` for this user: only the recipient gets it */
export function grantSpace(user: User | null, space: string): Access | null {
  const g = findGrant(space.slice(GRANT_SPACE.length))
  const perms = user && g ? grantPermsFor(g, user) : null
  if (!g || !perms) return null
  const target = grantTarget(g)
  if (!target) return null
  return { space: `${GRANT_SPACE}${g.id}`, root: target.abs, perms: new Set(PERMS[perms]), quotaOwner: target.owner }
}

/** the grants this user can use now (for the list of folders shared with them) */
export function activeGrantsTo(user: User) {
  const out: { grant: Grant; owner: User; abs: string; /** what this user gets (a group grant is capped by their rights in the group) */ perms: GrantPerms; viaGroup?: Group }[] = []
  for (const g of allGrants()) {
    const perms = grantPermsFor(g, user)
    if (!perms) continue
    const t = grantTarget(g)
    if (t) out.push({ grant: g, owner: t.owner, abs: t.abs, perms, ...(g.toGroup ? { viaGroup: findGroup(g.toGroup) } : {}) })
  }
  return out
}

/** one grant per (owner, folder, recipient): a second call changes the rights; `created` is false then. The recipient is a user or a group. */
export function saveGrant(owner: User, to: User | { group: Group }, path: string, perms: GrantPerms): { grant: Grant; created: boolean } {
  const toGroup = 'group' in to ? to.group.id : undefined
  const toName = 'group' in to ? '' : to.username
  const found = allGrants().find(g => same(g.owner, owner.username) && g.path === path && (toGroup ? g.toGroup === toGroup : !g.toGroup && same(g.to, toName)))
  if (found) {
    store.update(() => { found.perms = perms })
    return { grant: found, created: false }
  }
  const grant: Grant = {
    id: randomBytes(12).toString('hex'), owner: owner.username, path, to: toName, ...(toGroup ? { toGroup } : {}), perms, createdAt: new Date().toISOString(),
  }
  store.update(d => { d.grants.push(grant) })
  return { grant, created: true }
}

export function setGrantPerms(g: Grant, perms: GrantPerms) {
  store.update(() => { g.perms = perms })
}

export function removeGrant(g: Grant) {
  store.update(d => { d.grants = d.grants.filter(x => x !== g) })
}

/** a group that is deleted takes the grants made to it along */
export function removeGrantsToGroup(id: string) {
  if (!grantsToGroup(id).length) return
  store.update(d => { d.grants = d.grants.filter(g => g.toGroup !== id) })
}

/** an account that is deleted takes its grants (given and received) along: a new account by the same name must not get them back */
export function removeGrantsOf(username: string) {
  if (!allGrants().some(g => same(g.owner, username) || same(g.to, username))) return
  store.update(d => { d.grants = d.grants.filter(g => !same(g.owner, username) && !same(g.to, username)) })
}
