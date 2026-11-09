/**
 * What the system keeps about one signed-in person, for them (PDPA right of access): their own activity
 * (GET /api/me/activity) and a copy of their personal data (POST /api/me/export), see routes/me.ts.
 *
 * Only this account's own records are read, through the same list functions the pages use. Never in it: password
 * hashes, TOTP secrets and recovery codes, session ids, app-password hashes, share tokens (a token would make the
 * export file itself a key to the link), and files (those are downloaded from the files page or WebDAV).
 */
import { type AuditEntry, auditEntries, auditMatcher, queryAudit } from './audit'
import { appPasswordsOf } from './app-passwords'
import { type User, listUserSessions } from './auth'
import { activeGrantsTo, grantsOf } from './grants'
import { listFavorites, listRecent } from './favorites'
import { prefsOf } from './notify'
import { pageOf } from './logger'
import { limitOf } from './quota'
import { kindOf, sharesOf, stateOf } from './shares'

/** the activity page's paging limits (the same as the admin activity list: 5 to 100 rows, 25 by default) */
export const activityPageSize = (v: unknown) => Math.min(100, Math.max(5, Number(v) || 25))

/**
 * one export per account per `cooldownMs`; an export holds at most `activityMax` activity entries, past it the file
 * says `activityTruncated: true`. An object so a test can lower both.
 */
export const exportLimit = { cooldownMs: 60_000, activityMax: 50_000 }
const lastExport = new Map<string, number>()

/** seconds to wait before this account may export again, 0 = go ahead */
export function exportWait(username: string, now = Date.now()): number {
  for (const [k, at] of lastExport) if (now - at >= exportLimit.cooldownMs) lastExport.delete(k)
  const at = lastExport.get(username.toLowerCase())
  return at === undefined ? 0 : Math.max(1, Math.ceil((at + exportLimit.cooldownMs - now) / 1000))
}
export const markExport = (username: string, now = Date.now()) => { lastExport.set(username.toLowerCase(), now) }

/**
 * Only entries this account wrote itself, from the day the account was made on. Left out on purpose: entries other
 * people wrote about it (an admin's actions on the account, visitors of its links) carry their names and addresses;
 * failed sign-ins with a name that is no account (`?xxxxxxxx`) are nobody's; and an older account with the same name
 * (deleted, then made again) was another person: its entries stay before `createdAt`.
 */
export const ownEntries = (u: Pick<User, 'username' | 'createdAt'>) => {
  const from = Date.parse(u.createdAt)
  // fails closed: with no valid creation time nothing is shown, since an earlier account of the same name cannot be
  // told apart; an entry whose own time is not a valid date is left out for the same reason
  if (Number.isNaN(from)) return (_r: AuditEntry) => false
  return (r: AuditEntry) => r.user === u.username && Date.parse(r.ts) >= from
}
const shown = ({ ts, ip, action, target, detail }: AuditEntry) => ({ ts, ip, action, target, detail })

export function myActivity(u: User, page: number, pageSize: number) {
  const r = queryAudit({ only: ownEntries(u), page, pageSize })
  return { items: r.items.map(shown), hasMore: r.hasMore }
}

export function buildExport(u: User, now = new Date()) {
  const own = pageOf(auditEntries(), auditMatcher({ only: ownEntries(u) }), 1, exportLimit.activityMax)
  const notify = prefsOf(u)
  return {
    generatedAt: now.toISOString(),
    note: {
      th: 'ไฟล์นี้ไม่รวมตัวไฟล์ของคุณ (ดาวน์โหลดได้จากหน้าไฟล์หรือ WebDAV) และไม่รวมสำเนาในไฟล์สำรองหรือใน syslog ที่ส่งต่อไปยังเซิร์ฟเวอร์อื่น',
      en: 'This file does not include your files (download them from the files page or WebDAV), nor copies held in backups or in a syslog forwarded to another server.',
    },
    account: {
      username: u.username, name: u.name, role: u.role, homedir: u.homedir, createdAt: u.createdAt,
      lastLogin: u.lastLogin ?? null, twoFactorEnabled: !!u.twoFactor, mustChangePassword: !!u.mustChangePassword,
      permissions: u.permissions, publicPermissions: u.publicPermissions, quotaBytes: limitOf(u),
    },
    appPasswords: appPasswordsOf(u.username).map(p => ({
      name: p.name, scope: p.scope, createdAt: p.createdAt, expiresAt: p.expiresAt ?? null, lastUsedAt: p.lastUsedAt, lastIp: p.lastIp,
    })),
    sessions: listUserSessions(u.username).map(s => ({ ip: s.ip, userAgent: s.ua, created: s.created, lastSeen: s.seen })),
    // no link address or token: it would make this file a key to the link
    shareLinks: sharesOf(u.username).map(s => ({
      space: s.space, path: s.path, type: s.type, kind: kindOf(s), createdAt: s.createdAt, expiresAt: s.expiresAt, revokedAt: s.revokedAt ?? null,
      state: stateOf(s), viewOnly: !!s.viewOnly, hasPassword: !!s.passwordHash, maxDownloads: s.maxDownloads, downloads: s.downloads,
    })),
    grantsGiven: grantsOf(u.username).map(g => ({ path: g.path, to: g.toGroup ? null : g.to, toGroup: g.toGroup ?? null, perms: g.perms, createdAt: g.createdAt })),
    grantsReceived: activeGrantsTo(u).map(({ grant, owner, perms, viaGroup }) => ({
      path: grant.path, from: owner.username, perms, viaGroup: viaGroup?.name ?? null, createdAt: grant.createdAt,
    })),
    favorites: listFavorites(u).map(f => ({ space: f.space, path: f.path })),
    recent: listRecent(u).map(f => ({ space: f.space, path: f.path, at: f.at ?? null })),
    notifications: { lang: notify.lang, email: notify.email.address, emailVerified: notify.email.verified, lineLinked: notify.line.linked, events: notify.events },
    activity: own.items.map(shown),
    activityTruncated: own.hasMore,
  }
}
