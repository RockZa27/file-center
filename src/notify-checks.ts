/**
 * The notifications that have no request of their own to hang on, looked for in the hourly housekeeping (index.ts):
 * a share link about to expire (once per link) and a home above 90% of its quota (once, until it drops below again).
 * The others are raised where they happen: an upload through a request link and a link used up (routes/shares.ts,
 * shares.ts), a system alert (alerts.ts).
 */
import { allUsers } from './auth'
import { log } from './logger'
import { firstTime, EXPIRY_WARN_MS, nameOf, notify, pruneMarks, QUOTA_WARN_PERCENT, quotaWarning } from './notify'
import { sizeText } from './messages'
import { limitOf, ready, usage } from './quota'
import { allShares, kindOf } from './shares'

const EXPIRING = 'link-expiring:'

/**
 * Tell the owner of each link that ends within 24 hours, once per link. A link made for 24 hours or less is left out: its
 * owner chose that and does not need a warning right after making it. Returns how many were told.
 */
export function checkExpiringLinks(now = Date.now()): number {
  let told = 0
  const live = new Set<string>()
  for (const s of allShares()) {
    live.add(EXPIRING + s.id)
    const end = Date.parse(s.expiresAt)
    if (s.revokedAt || !(end > now) || end - now > EXPIRY_WARN_MS) continue
    if (end - Date.parse(s.createdAt) <= EXPIRY_WARN_MS) continue
    if (!firstTime(EXPIRING + s.id)) continue
    if (notify(s.owner, 'link-expiring', { id: s.id, name: nameOf(s.path), type: kindOf(s) }, '/links')) told++
  }
  // a link that is gone takes its mark along
  pruneMarks(EXPIRING, live)
  return told
}

/** Tell each user with a quota whose home is above 90% of it. Waits for the counts, so run it in the background. */
export async function checkQuotaLow(): Promise<number> {
  let told = 0
  for (const u of allUsers()) {
    const limit = limitOf(u)
    if (!limit) continue
    try {
      await ready(u)
      const { used, counting } = usage(u)
      if (counting) continue
      const percent = (used / limit) * 100
      if (quotaWarning(u.username, percent > QUOTA_WARN_PERCENT)) {
        if (notify(u.username, 'quota-low', { percent: Math.floor(percent), used, quota: limit, usedText: sizeText(used), quotaText: sizeText(limit) }, '/files')) told++
      }
    } catch (err) {
      log.warn('notify-quota-check-failed', { user: u.username, error: err })
    }
  }
  return told
}

/** both checks; never throws */
export async function checkNotifications() {
  try {
    checkExpiringLinks()
    await checkQuotaLow()
  } catch (err) {
    log.warn('notify-check-failed', err)
  }
}
