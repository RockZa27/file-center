/**
 * Groups: a shared folder with members ("กลุ่ม"), in DATA_DIR/groups.json. The folder is <storage>/groups/<id> and its
 * space is `group:<id>` (groupSpace, called by accessFor): members only, view = look and take a copy, edit = also add
 * and change files. Admins always get in. Membership is read again on every use, so removing a member or the group
 * stops access at once. Anything that fails answers like an unknown id, so a stranger learns nothing.
 *
 * Quota: the folder has its own limit (quotaBytes, 0 = none). For the quota code the group is a pseudo account
 * (groupOwner) named `group:<id>` whose home is the group folder, so counts, reservations, versions and the trash
 * restore all work as they do for a user's home, and nothing is ever charged to the member who wrote.
 */
import { randomBytes } from 'node:crypto'
import { type Access, findUser, type User } from './auth'
import { config, paths } from './config'
import { ensureDir, resolveIn } from './fsx'
import { type Perm, PERMISSIONS } from './settings'
import { JsonStore } from './store'

export type GroupPerms = 'view' | 'edit'
export type Member = { username: string; perms: GroupPerms }
export type Group = {
  id: string
  name: string
  members: Member[]
  /** bytes the folder may hold; 0 = no limit */
  quotaBytes: number
  createdAt: string
  createdBy: string
}

export const GROUP_SPACE = 'group:'
/** the top folder of all group folders; no account may have its home inside it (cleanHomedir, homeOverlapsOther) */
export const GROUPS_TOP = '/groups'
export const GROUP_NAME_MAX = 64

/** view = look and take a copy; edit = also add and change files. Never `share`: no share links out of a group folder */
const PERMS: Record<GroupPerms, Perm[]> = {
  view: ['read', 'download', 'batchdownload', 'zip'],
  edit: ['read', 'download', 'batchdownload', 'zip', 'upload', 'write'],
}

const store = new JsonStore<{ groups: Group[] }>(paths.groups, () => ({ groups: [] }))

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
export const allGroups = () => store.value.groups
export const findGroup = (id: unknown) => (typeof id === 'string' ? allGroups().find(g => g.id === id) : undefined)
export const findGroupByName = (name: string) => allGroups().find(g => same(g.name, name))
export const memberOf = (g: Group, username: string) => g.members.find(m => same(m.username, username))
/** the groups this user is a member of (an admin who is not a member is not listed) */
export const groupsOf = (username: string) => allGroups().filter(g => memberOf(g, username))

export const groupHome = (g: Pick<Group, 'id'>) => `${GROUPS_TOP}/${g.id}`
export const groupRoot = (g: Pick<Group, 'id'>) => resolveIn(config.storageDir, groupHome(g))

/** ids are random lowercase hex: safe in a path, a URL and a space name, also on a filesystem that ignores case */
const newId = () => randomBytes(9).toString('hex')

/**
 * The group as an account for quota.ts: a plain user whose home is the group folder and whose limit is the group's.
 * Its name has a colon, which no real username can have, so it never meets a person.
 */
export function groupOwner(g: Group): User {
  return {
    username: `${GROUP_SPACE}${g.id}`, name: g.name, role: 'user', homedir: groupHome(g), permissions: [], publicPermissions: [],
    passwordHash: '', ...(g.quotaBytes ? { quotaBytes: g.quotaBytes } : {}), createdAt: g.createdAt,
  }
}
/** the pseudo accounts of all groups (quota.ts and trash.ts: which home holds a path) */
export const groupOwners = () => allGroups().map(groupOwner)

/** the group behind a pseudo account name / trash owner, if it is one and still exists */
export const groupOfOwner = (owner: string | null | undefined) =>
  owner && owner.startsWith(GROUP_SPACE) ? findGroup(owner.slice(GROUP_SPACE.length)) : undefined

/** the space `group:<id>` for this user: a member (with their rights) or an admin (everything) */
export function groupSpace(user: User | null, space: string): Access | null {
  const g = findGroup(space.slice(GROUP_SPACE.length))
  if (!user || !g) return null
  const m = memberOf(g, user.username)
  if (!m && user.role !== 'admin') return null
  const perms = user.role === 'admin' ? PERMISSIONS : PERMS[m!.perms]
  const root = groupRoot(g)
  ensureDir(root)
  return { space: `${GROUP_SPACE}${g.id}`, root, perms: new Set(perms), quotaOwner: groupOwner(g) }
}

/**
 * The group spaces this user is a member of, for places that list them (the WebDAV tree shows each as a folder).
 * `name` is the group's name (unique, never holds a slash), `space` is what accessFor takes.
 */
export function groupSpacesOf(user: User | null | undefined): { name: string; space: string }[] {
  if (!user) return []
  return groupsOf(user.username).map(g => ({ name: g.name, space: `${GROUP_SPACE}${g.id}` }))
}

/** a new group and its folder; the caller has checked the name */
export function createGroup(name: string, quotaBytes: number, createdBy: string): Group {
  const g: Group = { id: newId(), name, members: [], quotaBytes, createdAt: new Date().toISOString(), createdBy }
  ensureDir(groupRoot(g))
  store.update(d => { d.groups.push(g) })
  return g
}

export function saveGroups() {
  store.save()
}

/** add a member or change their rights; `added` is false for a change */
export function setMember(g: Group, username: string, perms: GroupPerms): { added: boolean; member: Member } {
  const found = memberOf(g, username)
  if (found) {
    store.update(() => { found.perms = perms })
    return { added: false, member: found }
  }
  const member: Member = { username, perms }
  store.update(() => { g.members.push(member) })
  return { added: true, member }
}

export function removeMember(g: Group, username: string): boolean {
  if (!memberOf(g, username)) return false
  store.update(() => { g.members = g.members.filter(m => !same(m.username, username)) })
  return true
}

/** an account that is deleted leaves every group: a new account by the same name must not get its place back */
export function removeUserFromGroups(username: string): number {
  const hit = groupsOf(username)
  if (!hit.length) return 0
  store.update(() => { for (const g of hit) g.members = g.members.filter(m => !same(m.username, username)) })
  return hit.length
}

export function removeGroup(g: Group) {
  store.update(d => { d.groups = d.groups.filter(x => x !== g) })
}

/** the member's account, when it still exists */
export const accountOf = (m: Member) => findUser(m.username)
