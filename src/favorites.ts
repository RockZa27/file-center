/**
 * Favorites and recently opened files per signed-in user, in DATA_DIR/user-state.json (a JSON file like the others).
 * An entry is only a place ({ space, path }): what the user may see of it is decided again every time it is read
 * (the permission to read the space, and that the file still exists), so nothing here can open anything on its own.
 */
import { relative } from 'node:path'
import { accessFor, findUser, type User } from './auth'
import { paths } from './config'
import { bad, normRel, resolveIn, statEntry, within, type Entry } from './fsx'
import { JsonStore } from './store'

export const MAX_FAVORITES = 200
export const MAX_RECENT = 50

type Ref = { space: string; path: string }
type Recent = Ref & { at: string }
type State = { favorites: Ref[]; recent: Recent[] }

const store = new JsonStore<Record<string, State>>(paths.userState, () => ({}))

const same = (a: Ref, b: Ref) => a.space === b.space && a.path === b.path

function stateOf(draft: Record<string, State>, username: string): State {
  return (draft[username] ??= { favorites: [], recent: [] })
}

export function addFavorite(user: User, space: string, path: string) {
  const ref = { space, path: normRel(path) }
  if (ref.path === '/') throw bad('files.root-item')
  const mine = store.value[user.username]?.favorites ?? []
  if (mine.length >= MAX_FAVORITES && !mine.some(f => same(f, ref))) throw bad('favorites.too-many', { max: MAX_FAVORITES })
  store.update(d => {
    const s = stateOf(d, user.username)
    s.favorites = [ref, ...s.favorites.filter(f => !same(f, ref))]
  })
}

export function removeFavorite(user: User, space: string, path: string) {
  const ref = { space, path: normRel(path) }
  if (!store.value[user.username]?.favorites.some(f => same(f, ref))) return
  store.update(d => { d[user.username].favorites = d[user.username].favorites.filter(f => !same(f, ref)) })
}

/** a file was opened, downloaded or saved: newest first, once per place, at most MAX_RECENT */
export function recordRecent(user: User | null, space: string, path: string) {
  if (!user) return
  let ref: Ref
  try { ref = { space, path: normRel(path) } } catch { return }
  if (ref.path === '/') return
  store.update(d => {
    const s = stateOf(d, user.username)
    s.recent = [{ ...ref, at: new Date().toISOString() }, ...s.recent.filter(r => !same(r, ref))].slice(0, MAX_RECENT)
  })
}

export type PlaceEntry = Entry & { space: string; at?: string }

/**
 * what the user may see of their entries now: gone files are forgotten, places in a space the user can no longer
 * read are left out (and kept, in case the right comes back)
 */
function visible(user: User, refs: (Ref & { at?: string })[], forget: (gone: Ref[]) => void): PlaceEntry[] {
  const out: PlaceEntry[] = []
  const gone: Ref[] = []
  for (const r of refs) {
    const a = accessFor(user, r.space)
    if (!a || !a.perms.has('read')) continue
    let e: Entry | null = null
    try { e = statEntry(resolveIn(a.root, r.path), r.path) } catch { /* a path that no longer resolves */ }
    if (!e) { gone.push(r); continue }
    out.push({ ...e, space: r.space, ...(r.at ? { at: r.at } : {}) })
  }
  if (gone.length) forget(gone)
  return out
}

export function listFavorites(user: User): PlaceEntry[] {
  return visible(user, store.value[user.username]?.favorites ?? [], gone =>
    store.update(d => { d[user.username].favorites = d[user.username].favorites.filter(f => !gone.some(g => same(f, g))) }))
}

export function listRecent(user: User): PlaceEntry[] {
  return visible(user, store.value[user.username]?.recent ?? [], gone =>
    store.update(d => { d[user.username].recent = d[user.username].recent.filter(f => !gone.some(g => same(f, g))) }))
}

/** a file or folder was renamed or moved: the entries of every user that point into it follow */
export function moveState(fromAbs: string, toAbs: string) {
  const names = Object.keys(store.value)
  if (!names.length) return
  store.update(d => {
    for (const name of names) {
      const user = findUser(name)
      if (!user) continue
      const fix = <T extends Ref>(list: T[]): T[] => list.flatMap(r => {
        const a = accessFor(user, r.space)
        if (!a) return [r]
        let abs: string
        try { abs = resolveIn(a.root, r.path) } catch { return [r] }
        if (!within(fromAbs, abs)) return [r]
        const next = toAbs + abs.slice(fromAbs.length)
        // moved out of this space for this user: the entry has nowhere to point to
        return within(a.root, next) ? [{ ...r, path: '/' + relative(a.root, next).split(/[\\/]/).join('/') }] : []
      })
      d[name].favorites = fix(d[name].favorites)
      d[name].recent = fix(d[name].recent)
    }
  })
}

export function removeUserState(username: string) {
  if (!(username in store.value)) return
  store.update(d => { delete d[username] })
}
