/**
 * Onboarding per signed-in user, in DATA_DIR/guide.json (a JSON file like the others): the version whose "what's new"
 * the user has seen, and the tours they have finished. The web app shows the full tour to a user with no record
 * (seenVersion null) and only the news popup to one whose seenVersion is older than the running version.
 */
import { allUsers, type User } from './auth'
import { paths } from './config'
import { bad } from './fsx'
import { JsonStore } from './store'

export const MAX_TOURS = 50
const VERSION_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/
const TOUR_RE = /^[a-z0-9-]{1,40}$/

/** nothing on disk says which version ran before this one, so users that exist when the store is first made get this */
export const PREVIOUS_VERSION = '1.11.0'

export type Guide = { seenVersion: string | null; toursDone: string[] }
type State = { migrated?: string; users: Record<string, { seenVersion?: string; toursDone?: string[] }> }

export const guideStore = new JsonStore<State>(paths.guide, () => ({ users: {} }))

const own = (username: string) => Object.hasOwn(guideStore.value.users, username) ? guideStore.value.users[username] : undefined

/**
 * Once, at startup and before the first admin is made: every account that exists then was there before the guide,
 * so it has seen what came up to PREVIOUS_VERSION. On a fresh install there is no account yet, so the first admin (and
 * everyone after) has no record and gets the full tour. The marker in the file makes it run only once.
 */
export function migrateGuide(users: { username: string }[] = allUsers(), previous = PREVIOUS_VERSION): boolean {
  if (guideStore.value.migrated) return false
  guideStore.update(d => {
    for (const u of users) if (!Object.hasOwn(d.users, u.username)) d.users[u.username] = { seenVersion: previous }
    d.migrated = new Date().toISOString()
  })
  return true
}

export function guideOf(u: User): Guide {
  const g = own(u.username)
  return { seenVersion: g?.seenVersion ?? null, toursDone: [...(g?.toursDone ?? [])] }
}

/** merge: a field that is sent replaces that field, one that is not sent stays */
export function setGuide(username: string, patch: { seenVersion?: unknown; toursDone?: unknown }) {
  let seenVersion: string | undefined
  let toursDone: string[] | undefined
  if (patch.seenVersion !== undefined) {
    if (typeof patch.seenVersion !== 'string' || patch.seenVersion.length > 32 || !VERSION_RE.test(patch.seenVersion)) throw bad('guide.bad-version')
    seenVersion = patch.seenVersion
  }
  if (patch.toursDone !== undefined) {
    const t = patch.toursDone
    if (!Array.isArray(t) || t.length > MAX_TOURS || !t.every(x => typeof x === 'string' && TOUR_RE.test(x))) throw bad('guide.bad-tours', { max: MAX_TOURS })
    toursDone = [...new Set(t as string[])]
  }
  guideStore.update(d => {
    const g = Object.hasOwn(d.users, username) ? d.users[username] : (d.users[username] = {})
    if (seenVersion !== undefined) g.seenVersion = seenVersion
    if (toursDone !== undefined) g.toursDone = toursDone
  })
}

/** an account that is deleted takes its record along */
export function forgetGuide(username: string) {
  if (!Object.hasOwn(guideStore.value.users, username)) return
  guideStore.update(d => { delete d.users[username] })
}
