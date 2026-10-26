/**
 * Everything an account leaves behind outside users.json, and the two ways to drop it: in memory when an admin
 * deletes the account (forgetAccount), and in the files when a restore swaps users.json (dropRecordsOnDisk). They live
 * side by side so a new kind of per-account record is added to both.
 *
 * An account instance is the pair (lowercase username, createdAt): a later account that reused a name is not the one
 * a backup holds, and none of the records of the first may act for it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { paths as realPaths } from './config'
import { destroyUserSessions } from './auth'
import { removeAppPasswordsOf } from './app-passwords'
import { removeUserState } from './favorites'
import { forgetGuide } from './guide'
import { removeGrantsOf } from './grants'
import { removeUserFromGroups } from './groups'
import { forgetNotifications } from './notify'
import { revokeSharesOf } from './shares'

/** sign-ins, links, grants, groups, app passwords, own settings: a deleted account takes them along (memory, saved by the stores) */
export function forgetAccount(username: string) {
  destroyUserSessions(username)
  revokeSharesOf(username)
  removeUserState(username)
  forgetNotifications(username)
  forgetGuide(username)
  removeGrantsOf(username)
  removeAppPasswordsOf(username)
  removeUserFromGroups(username)
}

/** the data files this touches (a test points them at its own folder) */
type Files = Pick<typeof realPaths, 'sessions' | 'shares' | 'userState' | 'notifications' | 'notifyState' | 'guide' | 'grants' | 'appPasswords' | 'groups'>
type Named = { username?: unknown; createdAt?: unknown }
const lc = (s: unknown) => (typeof s === 'string' ? s.toLowerCase() : '')

/**
 * Which accounts of a restore are the very ones that are live now. `same`: name -> time the account was made (the
 * records of these stay, sessions only when made after that). `drop`: every other name on either side, whose records
 * are not proven to belong to the restored account: no live account, another createdAt, or no createdAt on a side.
 */
export function planRestore(live: Named[], restored: Named[]) {
  const liveBorn = new Map<string, string>()
  for (const u of live) if (typeof u?.username === 'string') liveBorn.set(lc(u.username), typeof u.createdAt === 'string' ? u.createdAt : '')
  const same = new Map<string, number>()
  const drop = new Set<string>()
  for (const u of restored) {
    if (typeof u?.username !== 'string') continue
    const name = lc(u.username)
    const born = typeof u.createdAt === 'string' ? u.createdAt : ''
    const ms = Date.parse(born)
    if (born && liveBorn.get(name) === born && !Number.isNaN(ms) && !drop.has(name)) same.set(name, ms)
    else { same.delete(name); drop.add(name) }
  }
  for (const name of liveBorn.keys()) if (!same.has(name)) drop.add(name)
  return { same, drop }
}

function rewrite(file: string, change: (data: any) => boolean) {
  if (!existsSync(file)) return
  const data = JSON.parse(readFileSync(file, 'utf8'))
  if (data && typeof data === 'object' && change(data)) writeFileSync(file, JSON.stringify(data, null, 2))
}
/** delete the keys of a plain object that name a dropped account; true when something went */
function dropKeys(obj: unknown, drop: Set<string>): boolean {
  if (!obj || typeof obj !== 'object') return false
  let hit = false
  for (const k of Object.keys(obj)) if (drop.has(k.toLowerCase())) { delete (obj as any)[k]; hit = true }
  return hit
}

/**
 * The same as forgetAccount for a whole plan, on the files. A restore freezes the stores (they would write the old
 * data back) and the app restarts right after, so only the files count. Sessions are not in a backup and name their
 * account only: one stays when its account is in `same` and it was made after that account.
 */
export function dropRecordsOnDisk({ same, drop }: ReturnType<typeof planRestore>, paths: Files = realPaths) {
  const gone = (name: unknown) => drop.has(lc(name))
  rewrite(paths.sessions, all => {
    for (const [k, s] of Object.entries<any>(all)) {
      if (!s?.username) continue
      const born = same.get(lc(s.username))
      if (born === undefined || (s.created ?? 0) < born) delete all[k]
    }
    return true
  })
  rewrite(paths.shares, d => {
    let hit = false
    for (const s of d.shares ?? []) if (gone(s.owner) && !s.revokedAt) { s.revokedAt = new Date().toISOString(); hit = true }
    return hit
  })
  rewrite(paths.userState, d => dropKeys(d, drop))
  rewrite(paths.notifications, d => dropKeys(d, drop))
  rewrite(paths.notifyState, d => dropKeys(d.users, drop))
  rewrite(paths.guide, d => dropKeys(d.users, drop))
  rewrite(paths.grants, d => {
    const n = d.grants?.length ?? 0
    if (n) d.grants = d.grants.filter((g: any) => !gone(g.owner) && (g.toGroup || !gone(g.to)))
    return n !== (d.grants?.length ?? 0)
  })
  rewrite(paths.appPasswords, d => {
    const n = d.items?.length ?? 0
    if (n) d.items = d.items.filter((p: any) => !gone(p.username))
    return n !== (d.items?.length ?? 0)
  })
  rewrite(paths.groups, d => {
    let hit = false
    for (const g of d.groups ?? []) {
      const n = g.members?.length ?? 0
      if (n) g.members = g.members.filter((m: any) => !gone(m.username))
      if (n !== (g.members?.length ?? 0)) hit = true
    }
    return hit
  })
}
