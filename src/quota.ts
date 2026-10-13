/**
 * Storage quota per user. Only the user's home space counts (admins, whose home is the whole storage, and the public
 * folder have none), and the trash is outside the home, so deleting a file gives its space back at once.
 *
 * Usage is counted with treeStats and kept for a minute, like the dashboard numbers in stats.ts. A write that is
 * still going on holds a reservation, taken in the same tick as the check (no await in between), so two requests
 * can not both pass on the last bytes. Whatever ends the write gives the reservation back: done, failed, cancelled
 * or cleaned up as stale.
 */
import { accessFor, allUsers, type User } from './auth'
import { bad, HttpError, treeStats, within } from './fsx'
import { sizeText } from './messages'
import { versionBytesUnder } from './versions'

/** biggest quota an admin may set (1 PiB) */
export const QUOTA_MAX = 2 ** 50
/** a count younger than this is used as it is */
const MAX_AGE_MS = 60_000
/** entries looked at in one count; a home with more counts as full */
const LIMIT = 1_000_000

type Entry = { root: string; size: number; truncated: boolean; at: number; stale: boolean }
const cache = new Map<string, Entry>()
const reserved = new Map<string, number>()
const counting = new Map<string, Promise<void>>()
// changes whenever the numbers move, so a count that was running meanwhile knows it may be off
const epochs = new Map<string, number>()
const keyOf = (username: string) => username.toLowerCase()
const bump = (k: string) => epochs.set(k, (epochs.get(k) ?? 0) + 1)

/** whole bytes from 0 to QUOTA_MAX (0 = no limit); anything else is refused */
export function cleanQuota(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 || input > QUOTA_MAX) {
    throw bad('admin.bad-quota')
  }
  return input
}

/** the limit in bytes that applies to this user, or 0 for none (no limit set, an admin, a visitor) */
export function limitOf(user: User | null | undefined): number {
  if (!user || user.role === 'admin') return 0
  const q = user.quotaBytes
  return typeof q === 'number' && Number.isFinite(q) && q > 0 ? q : 0
}

function recount(user: User): Promise<void> {
  const k = keyOf(user.username)
  const running = counting.get(k)
  if (running) return running
  const root = accessFor(user, 'home')!.root
  const started = epochs.get(k) ?? 0
  const p = (async () => {
    const r = await treeStats(root, LIMIT)
    // the earlier versions of the files in this home count too
    cache.set(k, { root, size: r.size + versionBytesUnder(root), truncated: r.truncated, at: Date.now(), stale: (epochs.get(k) ?? 0) !== started })
  })().catch(() => { /* nothing saved: the next call counts again */ }).finally(() => { counting.delete(k) })
  counting.set(k, p)
  return p
}

function fresh(user: User): boolean {
  const e = cache.get(keyOf(user.username))
  return !!e && !e.stale && Date.now() - e.at < MAX_AGE_MS && e.root === accessFor(user, 'home')!.root
}

/** counted bytes plus reservations; a count that was cut short counts as full */
function usedNow(user: User): number {
  const k = keyOf(user.username)
  const e = cache.get(k)
  const counted = e ? (e.truncated ? Math.max(e.size, limitOf(user)) : e.size) : 0
  return counted + (reserved.get(k) ?? 0)
}

/** wait for a fresh count when the user has a limit; call before reserve() so the check itself needs no await */
export async function ready(user: User | null | undefined): Promise<void> {
  // a count that was already running when something changed is marked stale when it ends: count once more
  for (let i = 0; i < 3 && user && limitOf(user) && !fresh(user); i++) await recount(user)
}

/** for the usage page: never waits, `counting` is true while there is no usable number yet */
export function usage(user: User): { used: number; quota: number; counting: boolean } {
  const isFresh = fresh(user)
  if (!isFresh) void recount(user)
  const e = cache.get(keyOf(user.username))
  return { used: usedNow(user), quota: limitOf(user), counting: !e && counting.has(keyOf(user.username)) }
}

/** bytes the user may still add, Infinity without a limit */
export function roomLeft(user: User): number {
  const limit = limitOf(user)
  return limit ? Math.max(0, limit - usedNow(user)) : Infinity
}

export function exceeded(user: User): HttpError {
  const used = usedNow(user)
  const quota = limitOf(user)
  return new HttpError(507, 'quota.exceeded', { used, quota, usedText: sizeText(used), quotaText: sizeText(quota) })
}

/** take `bytes` or throw 507. Synchronous on purpose: check and reservation happen in one tick. */
export function reserveBytes(user: User, bytes: number): void {
  const limit = limitOf(user)
  if (!limit || bytes <= 0) return
  if (usedNow(user) + bytes > limit) throw exceeded(user)
  const k = keyOf(user.username)
  reserved.set(k, (reserved.get(k) ?? 0) + bytes)
}

/** the same bytes without a check: an upload announced before a restart still holds its place */
export function restoreReservation(username: string, bytes: number): void {
  const k = keyOf(username)
  reserved.set(k, (reserved.get(k) ?? 0) + bytes)
}

export function releaseBytes(username: string, bytes: number): void {
  const k = keyOf(username)
  const left = (reserved.get(k) ?? 0) - bytes
  if (left > 0) reserved.set(k, left)
  else reserved.delete(k)
}

/** the write finished: give the reservation back and add what really landed (may be negative) to the count */
export function commitBytes(username: string, reservedBytes: number, delta: number = reservedBytes): void {
  const k = keyOf(username)
  releaseBytes(username, reservedBytes)
  const e = cache.get(k)
  if (e) e.size = Math.max(0, e.size + delta)
  bump(k)
}

/** something was deleted or moved away: count again on the next use. No user = everybody (an admin works in all homes). */
export function markStale(username?: string): void {
  const keys = username ? [keyOf(username)] : [...cache.keys()]
  for (const k of keys) {
    const e = cache.get(k)
    if (e) e.stale = true
    bump(k)
  }
}

/** a changed limit or home folder: forget the count */
export function forget(username: string): void {
  const k = keyOf(username)
  cache.delete(k)
  bump(k)
}

/**
 * The user whose limited home holds `abs` (a restore from the trash goes back to where the item was), or null.
 * Checked against every limited user's home, so it also finds a home that was moved by an admin.
 */
export function ownerOfPath(abs: string): User | null {
  for (const u of allUsers()) {
    if (!limitOf(u)) continue
    if (within(accessFor(u, 'home')!.root, abs)) return u
  }
  return null
}

export type Hold = { commit(delta?: number): void; release(): void }
const NONE: Hold = { commit() {}, release() {} }

/** wait for the count, then reserve; the returned hold is finished once, by commit() or release() */
export async function hold(user: User | null | undefined, bytes: number): Promise<Hold> {
  if (!user || !limitOf(user) || bytes <= 0) return NONE
  await ready(user)
  return holdNow(user, bytes)
}

/** reserve without waiting: only after ready() */
export function holdNow(user: User | null | undefined, bytes: number): Hold {
  if (!user || !limitOf(user) || bytes <= 0) return NONE
  reserveBytes(user, bytes)
  let done = false
  return {
    commit(delta = bytes) { if (!done) { done = true; commitBytes(user.username, bytes, delta) } },
    release() { if (!done) { done = true; releaseBytes(user.username, bytes) } },
  }
}
