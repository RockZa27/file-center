/**
 * Notifications for one user: a bell in the app (notifications.json, at most 100 per user, the oldest drop out) and,
 * when the user turned them on, e-mail and LINE.
 *
 * What is stored is the kind and its params, never the text: the text is written when it is read, in the reader's
 * language (the catalog, notify.* codes). Nothing secret goes in: a link is a path inside the app (/links,
 * /files?path=...), never a share link with its token, and params are cleaned like the log is.
 *
 * Other code calls `notify(username, kind, params, link?)`; it never throws and never waits. Delivery by e-mail or LINE
 * is queued (deliver.ts). Mail only goes to an address the user has confirmed, at most 20 an hour per user.
 */
import { createHash, randomBytes } from 'node:crypto'
import { basename } from 'node:path'
import { allUsers, findUser, type User } from './auth'
import { config, paths } from './config'
import { enqueue } from './deliver'
import { bad, HttpError } from './fsx'
import { lineEnabled, linePush } from './line'
import { clean, log, scrub } from './logger'
import { cleanAddress, oneLine, publicBase, sendMail, smtpConfig } from './mail'
import { type Lang, MESSAGES, type MessageCode, type Params, sizeText, text } from './messages'
import { settings } from './settings'
import { JsonStore } from './store'

export const KINDS = ['upload-received', 'link-expiring', 'link-limit-reached', 'quota-low', 'folder-shared', 'system-alert'] as const
export type NotifyKind = (typeof KINDS)[number]
export type Channel = 'web' | 'email' | 'line'
const CHANNELS: Channel[] = ['web', 'email', 'line']
/** the kinds only an administrator gets (the system alerts of alerts.ts) */
const ADMIN_KINDS: NotifyKind[] = ['system-alert']

const KIND_TEXT: Record<Exclude<NotifyKind, 'system-alert'>, MessageCode> = {
  'upload-received': 'notify.upload-received',
  'link-expiring': 'notify.link-expiring',
  'link-limit-reached': 'notify.link-limit-reached',
  'quota-low': 'notify.quota-low',
  'folder-shared': 'notify.folder-shared',
}

export const NOTIFY_MAX = 100
export const MAILS_PER_HOUR = 20
export const VERIFY_EVERY_MS = 2 * 60_000
export const VERIFY_TTL_MS = 24 * 3600_000
/** a link may expire this soon before the owner is told */
export const EXPIRY_WARN_MS = 24 * 3600_000
export const QUOTA_WARN_PERCENT = 90

export type Notification = { id: string; kind: NotifyKind; at: string; read: boolean; params: Record<string, string | number>; link?: string }
type Events = Partial<Record<NotifyKind, Partial<Record<Channel, boolean>>>>
type UserState = {
  lang?: Lang
  email?: { address: string; verified: boolean; tokenHash?: string; tokenExpires?: number; verifySentAt?: number }
  line?: { userId: string }
  events?: Events
  quotaLow?: boolean
}
type State = { users: Record<string, UserState>; marks: Record<string, number> }

const store = new JsonStore<Record<string, Notification[]>>(paths.notifications, () => ({}))
const state = new JsonStore<State>(paths.notifyState, () => ({ users: {}, marks: {} }))

/** usernames are keys of plain objects: "__proto__" is a valid username, so it is read and written as an own property only */
function own<T>(obj: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(obj, key) ? obj[key] : undefined
}
function put<T>(obj: Record<string, T>, key: string, value: T) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true })
}

/** the username as the account has it (the stores are keyed by that) */
const canon = (username: string) => findUser(username)?.username

const listOf = (username: string): Notification[] => own(store.value, username) ?? []
function userState(username: string): UserState {
  let s = own(state.value.users, username)
  if (!s) { s = {}; put(state.value.users, username, s) }
  return s
}
const saveSoon = () => { store.updateSoon(() => {}, 1000) }
const saveState = () => { state.updateSoon(() => {}, 1000) }

// ───────────── what may be written ─────────────

/** only short text and numbers, cleaned like the log */
function cleanParams(params: Params): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(clean(params) as Record<string, unknown>).slice(0, 12)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (typeof v === 'string') out[k] = v.slice(0, 300)
  }
  return out
}

/** a path inside the app: it starts with one slash, so it can not point to another site, and holds no line break */
export function cleanLink(link: unknown): string | undefined {
  if (typeof link !== 'string' || link.length > 400) return undefined
  return /^\/(?![/\\])[^\x00-\x1f\x7f\\]*$/.test(link) ? link : undefined
}

const isKind = (k: unknown): k is NotifyKind => typeof k === 'string' && (KINDS as readonly string[]).includes(k)
const kindsFor = (u: Pick<User, 'role'>): NotifyKind[] => KINDS.filter(k => u.role === 'admin' || !ADMIN_KINDS.includes(k))

// ───────────── the text ─────────────

/** the text of a notification in a language; also used for the e-mail and the LINE message */
export function describe(lang: Lang, kind: NotifyKind, params: Record<string, string | number>): string {
  const p: Params = { ...params }
  if (typeof p.size === 'number') p.sizeText = sizeText(p.size)
  if (kind === 'system-alert') {
    const code = String(p.code)
    // a reason that is itself a catalog message (backup failures) is told in the same language
    if (typeof p.reasonCode === 'string' && Object.hasOwn(MESSAGES, p.reasonCode)) p.reason = text(lang, p.reasonCode as MessageCode)
    return Object.hasOwn(MESSAGES, code) ? scrub(text(lang, code as MessageCode, p)) : code
  }
  return text(lang, KIND_TEXT[kind], p)
}

export function render(n: Notification, lang: Lang) {
  return { id: n.id, kind: n.kind, at: n.at, read: n.read, text: describe(lang, n.kind, n.params), params: n.params, link: n.link ?? null }
}

// ───────────── the bell ─────────────

/** newest first */
export function listNotifications(username: string, unreadOnly = false): { items: Notification[]; unread: number } {
  const all = listOf(username)
  const items = (unreadOnly ? all.filter(n => !n.read) : all).slice().reverse()
  return { items, unread: all.filter(n => !n.read).length }
}

/** mark some (ids) or all (none given) as read; returns the unread count left */
export function markRead(username: string, ids?: string[]): number {
  const list = listOf(username)
  const only = ids ? new Set(ids) : null
  for (const n of list) if (!only || only.has(n.id)) n.read = true
  saveSoon()
  return list.filter(n => !n.read).length
}

export function removeNotification(username: string, id: string): boolean {
  const list = listOf(username)
  const i = list.findIndex(n => n.id === id)
  if (i < 0) return false
  list.splice(i, 1)
  saveSoon()
  return true
}

/** an account that is deleted takes its notifications and settings along */
export function forgetNotifications(username: string) {
  if (Object.hasOwn(store.value, username)) { delete store.value[username]; saveSoon() }
  if (Object.hasOwn(state.value.users, username)) { delete state.value.users[username]; saveState() }
}

// ───────────── settings ─────────────

const defaultOn = (channel: Channel) => channel === 'web'

function eventsOf(u: User) {
  const set = own(state.value.users, u.username)?.events ?? {}
  const out: Record<string, Record<Channel, boolean>> = {}
  for (const k of kindsFor(u)) {
    out[k] = { web: set[k]?.web ?? defaultOn('web'), email: set[k]?.email ?? defaultOn('email'), line: set[k]?.line ?? defaultOn('line') }
  }
  return out
}

export function langOfUser(username: string): Lang {
  return own(state.value.users, username)?.lang ?? 'th'
}

/** GET /api/me/notify-prefs */
export function prefsOf(u: User) {
  const s = own(state.value.users, u.username)
  return {
    lang: langOfUser(u.username),
    email: { enabled: smtpConfig().enabled, address: s?.email?.address ?? null, verified: !!s?.email?.verified },
    line: { enabled: lineEnabled(), linked: !!s?.line?.userId },
    events: eventsOf(u),
  }
}

/** PUT /api/me/notify-prefs: only what is given changes */
export function setPrefs(u: User, input: { lang?: Lang; events?: Record<string, Partial<Record<Channel, boolean>>> }) {
  const allowed = kindsFor(u)
  for (const k of Object.keys(input.events ?? {})) if (!isKind(k) || !allowed.includes(k)) throw bad('notify.bad-kind')
  const s = userState(u.username)
  if (input.lang) s.lang = input.lang
  s.events ??= {}
  for (const [k, ch] of Object.entries(input.events ?? {})) {
    const e = (s.events[k as NotifyKind] ??= {})
    for (const c of CHANNELS) if (typeof ch[c] === 'boolean') e[c] = ch[c]
  }
  saveState()
}

/** the language of the page that asked, when the user has not chosen one yet */
export function rememberLang(username: string, lang: Lang) {
  const s = userState(username)
  if (!s.lang) { s.lang = lang; saveState() }
}

// ───────────── sending ─────────────

const mailTimes = new Map<string, number[]>()
/** one more mail for this user this hour, or false when the hour's 20 are used */
function takeMailSlot(username: string, now = Date.now()): boolean {
  const key = username.toLowerCase()
  const times = (mailTimes.get(key) ?? []).filter(t => now - t < 3600_000)
  if (times.length >= MAILS_PER_HOUR) { mailTimes.set(key, times); return false }
  times.push(now)
  mailTimes.set(key, times)
  return true
}

const appName = () => settings.get().appName
const linkUrl = (link?: string) => (link && publicBase() ? `${publicBase()}${link}` : '')

function deliverMail(u: User, address: string, kind: NotifyKind, params: Record<string, string | number>, link?: string) {
  if (!smtpConfig().enabled) return
  if (!takeMailSlot(u.username)) { log.warn('notify-mail-limit', { user: u.username }); return }
  const lang = langOfUser(u.username)
  const body = describe(lang, kind, params)
  const subject = `[${oneLine(appName())}] ${oneLine(body)}`.slice(0, 150)
  const url = linkUrl(link)
  enqueue('email', () => sendMail({ to: address, subject, text: `${body}\n${url ? `\n${url}\n` : ''}` }))
}

function deliverLine(userId: string, kind: NotifyKind, params: Record<string, string | number>, lang: Lang, link?: string) {
  if (!lineEnabled()) return
  const url = linkUrl(link)
  enqueue('line', () => linePush(userId, `[${appName()}] ${describe(lang, kind, params)}${url ? `\n${url}` : ''}`))
}

/**
 * Tell a user. The bell gets it when "web" is on for this kind (the default), mail goes to a confirmed address and LINE
 * to a linked account when those are on. Returns whether anything was done; never throws, never waits.
 */
export function notify(username: string, kind: NotifyKind, params: Params = {}, link?: string): boolean {
  try {
    const name = canon(username)
    const user = name ? findUser(name) : undefined
    if (!user || !isKind(kind) || !kindsFor(user).includes(kind)) return false
    const p = cleanParams(params)
    const url = cleanLink(link)
    const ev = eventsOf(user)[kind]
    const s = own(state.value.users, user.username)
    let did = false
    if (ev.web) {
      const list = own(store.value, user.username) ?? []
      if (!Object.hasOwn(store.value, user.username)) put(store.value, user.username, list)
      list.push({ id: randomBytes(8).toString('hex'), kind, at: new Date().toISOString(), read: false, params: p, ...(url ? { link: url } : {}) })
      if (list.length > NOTIFY_MAX) list.splice(0, list.length - NOTIFY_MAX)
      saveSoon()
      did = true
    }
    // nothing at all goes to an address that has not been confirmed
    if (ev.email && s?.email?.verified) { deliverMail(user, s.email.address, kind, p, url); did = true }
    if (ev.line && s?.line?.userId) { deliverLine(s.line.userId, kind, p, langOfUser(user.username), url); did = true }
    return did
  } catch (err) {
    log.warn('notify-failed', { kind, error: err })
    return false
  }
}

// ───────────── e-mail address ─────────────

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex')

/** PUT /api/me/email: remember the address as unconfirmed and mail it a link; nothing else is mailed there before it is opened */
export function requestEmailVerification(u: User, input: unknown): { address: string; verified: boolean } {
  if (!smtpConfig().enabled) throw new HttpError(409, 'notify.email-off')
  const address = cleanAddress(input)
  if (!address) throw bad('notify.bad-address')
  const s = userState(u.username)
  if (s.email?.verified && s.email.address.toLowerCase() === address.toLowerCase()) return { address: s.email.address, verified: true }
  const now = Date.now()
  const wait = (s.email?.verifySentAt ?? 0) + VERIFY_EVERY_MS - now
  if (wait > 0) throw new HttpError(429, 'notify.verify-too-soon', { seconds: Math.ceil(wait / 1000) })
  if (!takeMailSlot(u.username, now)) throw new HttpError(429, 'notify.mail-limit')
  const token = randomBytes(32).toString('base64url')
  s.email = { address, verified: false, tokenHash: hashToken(token), tokenExpires: now + VERIFY_TTL_MS, verifySentAt: now }
  saveState()
  const lang = langOfUser(u.username)
  const url = `${publicBase()}/api/me/email/verify?token=${token}`
  enqueue('email', () => sendMail({
    to: address,
    subject: `[${oneLine(appName())}] ${text(lang, 'notify.verify-subject')}`,
    text: text(lang, 'notify.verify-body', { name: oneLine(u.name || u.username), app: oneLine(appName()), url }),
  }))
  return { address, verified: false }
}

/** GET /api/me/email/verify: the address whose link this is becomes confirmed; the link works once */
export function verifyEmail(token: unknown): string {
  if (typeof token === 'string' && token.length >= 20 && token.length <= 100) {
    const hash = hashToken(token)
    for (const [name, s] of Object.entries(state.value.users)) {
      const e = s.email
      if (e && !e.verified && e.tokenHash === hash && (e.tokenExpires ?? 0) > Date.now() && findUser(name)) {
        e.verified = true
        delete e.tokenHash
        delete e.tokenExpires
        saveState()
        return name
      }
    }
  }
  throw bad('notify.bad-token')
}

export function removeEmail(username: string) {
  const s = own(state.value.users, username)
  if (s?.email) { delete s.email; saveState() }
}

// ───────────── LINE ─────────────

/** tie a LINE user to an account; false when that LINE user belongs to another account already */
export function linkLine(username: string, lineUserId: string): boolean {
  for (const [name, s] of Object.entries(state.value.users)) {
    if (s.line?.userId === lineUserId && name !== username && findUser(name)) return false
  }
  userState(username).line = { userId: lineUserId }
  saveState()
  return true
}

export function unlinkLine(username: string) {
  const s = own(state.value.users, username)
  if (s?.line) { delete s.line; saveState() }
}

/** the account a LINE user is tied to (for a reply in their language, and for "unfollow") */
export function accountOfLine(lineUserId: string): string | null {
  for (const [name, s] of Object.entries(state.value.users)) if (s.line?.userId === lineUserId && findUser(name)) return name
  return null
}

// ───────────── the admins' bell: system alerts ─────────────

const lastBell = new Map<string, number>()

/**
 * What alerts.ts sends to the admin's chat also goes to the bell of every administrator (and to LINE_GROUP_ID), once
 * an hour per kind like the chat message. `params` are cleaned like the log is.
 */
export function mirrorAlert(event: string, code: MessageCode, params: Params, now = Date.now()) {
  try {
    const last = lastBell.get(event)
    if (last !== undefined && now - last < 3600_000) return
    lastBell.set(event, now)
    const p = { ...params, code }
    for (const admin of allUsers()) if (admin.role === 'admin') notify(admin.username, 'system-alert', p)
    if (config.lineGroupId && lineEnabled()) {
      const message = `[${appName()}] ${describe(config.alertLang, 'system-alert', cleanParams(p))}`
      enqueue('line', () => linePush(config.lineGroupId, message))
    }
  } catch (err) {
    log.warn('notify-failed', { kind: 'system-alert', error: err })
  }
}

// ───────────── once-only marks ─────────────

/** true the first time a key is seen (and remembers it), false after that */
export function firstTime(key: string): boolean {
  if (Object.hasOwn(state.value.marks, key)) return false
  put(state.value.marks, key, Date.now())
  saveState()
  return true
}

/** forget the marks that start with `prefix` and are not in `keep` (a link that is gone, a quota that is below the line again) */
export function pruneMarks(prefix: string, keep: Set<string>) {
  let changed = false
  for (const k of Object.keys(state.value.marks)) if (k.startsWith(prefix) && !keep.has(k)) { delete state.value.marks[k]; changed = true }
  if (changed) saveState()
}

/** the quota warning is sent once until the usage falls below the line; returns true when one should go out now */
export function quotaWarning(username: string, over: boolean): boolean {
  const s = userState(username)
  if (over && !s.quotaLow) { s.quotaLow = true; saveState(); return true }
  if (!over && s.quotaLow) { s.quotaLow = false; saveState() }
  return false
}

/** the name of a shared item for a notification: the last part of its path */
export const nameOf = (path: string) => basename(path) || '/'

/** wait for what is written to disk (tests) */
export async function notifyIdle() {
  await Promise.all([store.idle(), state.idle()])
}

/** forget the hourly marks and counters (tests) */
export function resetNotifyLimits() {
  mailTimes.clear()
  lastBell.clear()
}
