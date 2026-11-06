/**
 * The effective value of every setting an admin can change on the web: settings.json (saved from the settings page)
 * wins over the env value (.env), which wins over the built-in default. A key missing from settings.json uses the env
 * value, so an install that never saved these behaves exactly as before. Everything reads through the getters here
 * at the moment it is used (never a copy taken at start), so a change applies at once without a restart.
 *
 * Secrets (the SMTP password, the alert URL with a bot token) are kept sealed with secret.key (secret-box.ts) like the
 * 2FA secrets, and only the getters here open them; `settingsView` (GET /api/admin/settings) never carries them.
 */
import { config } from './config'
import { bad } from './fsx'
import { open, seal } from './secret-box'
import { type AlertPrefs, type AntivirusPrefs, type AuditForwardPrefs, type FilesPrefs, type MailPrefs, type SecurityPrefs, type SharePrefs, type Settings, settings } from './settings'
import { log } from './logger'

export type Source = 'web' | 'env' | 'default'
export type Require2fa = 'none' | 'admin' | 'staff' | 'all'

/**
 * The biggest upload the process was started for (UPLOAD_MAX_SIZE): the HTTP server's body limit is fixed at start from
 * it, so a value saved on the web can lower the limit but never go above it.
 */
export const UPLOAD_CEILING = config.uploadMaxSize

/** the expiry choices of a share link, in days */
export const SHARE_DAY_CHOICES = [1, 3, 7, 14, 30, 90]
/** a link that never expires carries this far-off date (the rest of the code only compares dates) */
export const NEVER_EXPIRES_AT = '9999-12-31T23:59:59.000Z'
const DEFAULT_SHARE_DAYS = 7

const envSet = (name: string | null) => !!name && process.env[name] !== undefined && process.env[name] !== ''
/**
 * LOCK_OUTBOUND_SETTINGS=true: these keys decide where data leaves the server (uploads to ClamAV, the activity log, alert
 * texts, e-mail). They come from .env only: a stored web value stays in settings.json but is ignored, and the web can not save them.
 */
const LOCKED_KEYS: Record<string, string[]> = {
  antivirus: ['host', 'port'],
  auditForward: ['syslogHost', 'syslogPort', 'syslogProto', 'webhookUrl', 'webhookSecret'],
  alerts: ['webhookUrl', 'kind', 'telegramChatId'],
  mail: ['host', 'port', 'secure', 'user', 'pass'],
}
/** the same as `group.key` paths */
export const LOCKED_WHEN_OUTBOUND_LOCK: string[] = Object.entries(LOCKED_KEYS).flatMap(([g, ks]) => ks.map(k => `${g}.${k}`))
export const isLocked = (path: string) => config.lockOutbound && LOCKED_WHEN_OUTBOUND_LOCK.includes(path)
/** the locked keys of a request body (group.key), whatever their value */
export function lockedKeysIn(body: Record<string, unknown>): string[] {
  if (!config.lockOutbound) return []
  const out: string[] = []
  for (const g of POLICY_GROUPS) {
    const given = body[g]
    if (given === null || typeof given !== 'object' || Array.isArray(given)) continue
    for (const k of Object.keys(given)) if (isLocked(`${g}.${k}`)) out.push(`${g}.${k}`)
  }
  return out
}
/** where each locked key is stored in settings.json, per group */
const lockedStore = (g: string): string[] => LOCKED_WHEN_OUTBOUND_LOCK.filter(p => p.startsWith(`${g}.`)).map(p => SPEC[g][p.slice(g.length + 1)][0])

const grp = <G extends 'share' | 'security' | 'files' | 'mail' | 'alerts' | 'auditForward' | 'antivirus'>(g: G): NonNullable<Settings[G]> => {
  const stored = (settings.get()[g] ?? {}) as NonNullable<Settings[G]>
  if (!config.lockOutbound) return stored
  // locked: the stored web values of the locked keys do not exist as far as every reader is concerned
  const copy: Record<string, unknown> = { ...stored }
  for (const k of lockedStore(g)) delete copy[k]
  return copy as NonNullable<Settings[G]>
}
/** the raw stored group, for saving (savePolicy must keep what is stored, locked or not) */
const storedGroup = (g: string) => (settings.get() as any)[g] ?? {}

/** a sealed secret opened; `null` when this server can not open it (the key is another one), which turns the feature off */
const warnedUnreadable = new Set<string>()
function unseal(sealed: string | undefined, what: string): string | null {
  if (sealed === undefined) return null
  if (sealed === '') return ''
  try {
    return open(sealed)
  } catch {
    // this runs on every audit entry and request: warn once per process for a given stored value, not per call
    if (warnedUnreadable.has(sealed)) return null
    warnedUnreadable.add(sealed)
    log.warn('settings-secret-unreadable', `${what} ใน settings.json เปิดไม่ได้ (secret.key ไม่ตรงกัน) จึงไม่ใช้ค่านี้ ให้ตั้งใหม่ที่หน้าตั้งค่า`)
    return null
  }
}

// ───────────── share ─────────────

export const shareMaxDays = () => grp('share').maxDays ?? config.shareMaxDays
export const allowedShareDays = () => SHARE_DAY_CHOICES.filter(d => d <= shareMaxDays())
export function shareDefaultDays(): number {
  const allowed = allowedShareDays()
  const want = grp('share').defaultDays ?? DEFAULT_SHARE_DAYS
  if (allowed.includes(want)) return want
  return allowed.filter(d => d <= want).at(-1) ?? allowed[0] ?? 1
}
export const shareAllowNever = () => grp('share').allowNever ?? false
export const shareRequirePassword = () => grp('share').requirePassword ?? false
export type ViewOnlyPolicy = 'allow' | 'force' | 'forbid'
export const shareViewOnly = (): ViewOnlyPolicy => grp('share').viewOnly ?? 'allow'
export const shareForceWatermark = () => grp('share').forceWatermark ?? false

// ───────────── security ─────────────

export const sessionTtlMs = () => {
  const h = grp('security').sessionTtlHours
  return h !== undefined ? h * 3600_000 : config.sessionTtlMs
}
/** how long a signed-in session may live at all, used or not: SESSION_MAX_HOURS, never less than the idle TTL set on the settings page */
export const sessionMaxMs = () => Math.max(config.sessionMaxMs, sessionTtlMs())
export const loginMaxAttempts = () => grp('security').loginMaxAttempts ?? config.loginMaxAttempts
export const loginLockoutMs = () => {
  const s = grp('security').loginLockoutSeconds
  return s !== undefined ? s * 1000 : config.loginLockoutMs
}
export const require2fa = (): Require2fa => grp('security').require2fa ?? config.require2fa

/** does the setting ask this role for a second factor? */
export function roleNeeds2fa(role: string): boolean {
  switch (require2fa()) {
    case 'all': return true
    case 'staff': return role === 'admin' || role === 'manager'
    case 'admin': return role === 'admin'
    default: return false
  }
}
/** a signed-in user who must set up 2FA before anything else (like mustChangePassword) */
export const mustSetup2fa = (u: { role: string; twoFactor?: unknown }) => !u.twoFactor && roleNeeds2fa(u.role)

// ───────────── files ─────────────

export const defaultQuotaBytes = () => grp('files').defaultQuotaBytes ?? 0
export const trashRetentionDays = () => grp('files').trashRetentionDays ?? config.trashRetentionDays
export const versionsKeep = () => grp('files').versionsKeep ?? config.versionsKeep
export const versionsDays = () => grp('files').versionsDays ?? config.versionsDays
export const uploadMaxSize = () => {
  const v = grp('files').uploadMaxSize
  return v !== undefined ? Math.min(v, UPLOAD_CEILING) : config.uploadMaxSize
}
export const webdav = () => grp('files').webdav ?? config.webdav
export const thumbnails = () => grp('files').thumbnails ?? config.thumbnails

// ───────────── mail ─────────────

export type MailValues = { host: string; port: number; secure: string; user: string; pass: string; from: string }
export function mail(): MailValues {
  const m = grp('mail')
  return {
    host: m.host ?? config.smtpHost,
    port: m.port ?? config.smtpPort,
    secure: m.secure ?? config.smtpSecure,
    user: m.user ?? config.smtpUser,
    pass: unseal(m.passSealed, 'รหัสผ่าน SMTP') ?? (m.passSealed !== undefined ? '' : config.smtpPass),
    from: m.from ?? config.smtpFrom,
  }
}

// ───────────── alerts ─────────────

export function alertValues(): { url: string; kind: string; chatId: string; lang: 'th' | 'en' } {
  const a = grp('alerts')
  const url = unseal(a.webhookSealed, 'URL แจ้งเตือน')
  return {
    // a web URL that can not be opened leaves alerts off rather than falling back to another destination
    url: a.webhookSealed !== undefined ? (url ?? '') : config.alertWebhookUrl,
    kind: a.kind ?? config.alertWebhookKind,
    chatId: a.telegramChatId ?? config.alertTelegramChatId,
    lang: a.lang ?? config.alertLang,
  }
}
export const alertLang = () => grp('alerts').lang ?? config.alertLang

// ───────────── audit forwarding ─────────────

export type AuditForwardValues = { syslogHost: string; syslogPort: number; syslogProto: 'udp' | 'tcp'; syslogFacility: number; webhookUrl: string
  /** signing secret for the webhook ('' = unsigned); `webhookSecretBroken` = one is saved but secret.key can not open it, so nothing may be sent */
  webhookSecret: string; webhookSecretBroken: boolean }
/** web settings only (no env fallback): off until an admin sets a destination */
export function auditForwardValues(): AuditForwardValues {
  const a = grp('auditForward')
  const url = unseal(a.webhookSealed, 'URL ส่งต่อบันทึกกิจกรรม')
  // no URL = nothing is signed or sent, so the secret is not opened (and not warned about) on every audit entry
  const secret = url ? unseal(a.webhookSecretSealed, 'รหัสลับเซ็นชื่อ webhook ส่งต่อบันทึกกิจกรรม') : null
  return {
    syslogHost: a.syslogHost ?? '',
    syslogPort: a.syslogPort ?? 514,
    syslogProto: a.syslogProto ?? 'udp',
    syslogFacility: a.syslogFacility ?? 13,
    webhookUrl: url ?? '',
    webhookSecret: secret ?? '',
    webhookSecretBroken: !!url && a.webhookSecretSealed !== undefined && secret === null,
  }
}

// ───────────── virus scanning ─────────────

export type AntivirusValues = {
  enabled: boolean; host: string; port: number; timeoutMs: number; maxScanBytes: number
  onErrorLinks: 'allow' | 'reject'; onErrorUsers: 'allow' | 'reject'; onTooBigLinks: 'allow' | 'reject'; onTooBigUsers: 'allow' | 'reject'
}
export function antivirusValues(): AntivirusValues {
  const a = grp('antivirus')
  return {
    enabled: a.enabled ?? config.clamavEnabled,
    host: a.host ?? config.clamavHost,
    port: a.port ?? config.clamavPort,
    timeoutMs: (a.timeoutSeconds ?? config.clamavTimeoutSeconds) * 1000,
    maxScanBytes: Math.floor((a.maxScanMb ?? config.clamavMaxScanMb) * 1024 ** 2),
    onErrorLinks: a.onErrorLinks ?? config.clamavOnErrorLinks,
    onErrorUsers: a.onErrorUsers ?? config.clamavOnErrorUsers,
    onTooBigLinks: a.onTooBigLinks ?? config.clamavOnTooBigLinks,
    onTooBigUsers: a.onTooBigUsers ?? config.clamavOnTooBigUsers,
  }
}

/** a saved secret exists but this server can not open it */
export function unreadableSecrets(): string[] {
  const out: string[] = []
  const probe = (sealed: string | undefined, name: string) => {
    if (!sealed) return
    try { open(sealed) } catch { out.push(name) }
  }
  probe(grp('mail').passSealed, 'mail.pass')
  probe(grp('alerts').webhookSealed, 'alerts.webhookUrl')
  probe(grp('auditForward').webhookSealed, 'auditForward.webhookUrl')
  probe(grp('auditForward').webhookSecretSealed, 'auditForward.webhookSecret')
  return out
}

/** scheme and host of a URL and an ellipsis: a webhook's path or token is the secret part */
export function maskUrl(url: string): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}…`
  } catch {
    return '…'
  }
}

// ───────────── what GET /api/admin/settings tells ─────────────

type Eff<T> = { value: T; source: Source }
const eff = <T>(web: T | undefined, env: T, envName: string | null): Eff<T> =>
  web !== undefined ? { value: web, source: 'web' } : { value: env, source: envSet(envName) ? 'env' : 'default' }

/** every runtime setting with the value in force and where it comes from; no secret in it */
export function policyView() {
  const av2 = grp('antivirus'), sh = grp('share'), se = grp('security'), f = grp('files'), m = grp('mail'), a = grp('alerts'), af = grp('auditForward')
  const afv = auditForwardValues()
  const quota = defaultQuotaBytes()
  const mv = mail()
  const av = alertValues()
  const view = {
    share: {
      defaultDays: { value: shareDefaultDays(), source: (sh.defaultDays !== undefined ? 'web' : 'default') as Source },
      maxDays: eff(sh.maxDays, config.shareMaxDays, 'SHARE_MAX_DAYS'),
      allowNever: eff(sh.allowNever, false, null),
      requirePassword: eff(sh.requirePassword, false, null),
      viewOnly: eff<ViewOnlyPolicy>(sh.viewOnly, 'allow', null),
      forceWatermark: eff(sh.forceWatermark, false, null),
      choices: SHARE_DAY_CHOICES,
    },
    security: {
      // a REQUIRE_2FA typo falls back to 'none': the page then says default, not ".env" (the start log names the bad value)
      require2fa: eff<Require2fa>(se.require2fa, config.require2fa, config.require2faInvalid ? null : 'REQUIRE_2FA'),
      sessionTtlHours: eff(se.sessionTtlHours, config.sessionTtlMs / 3600_000, 'SESSION_TTL_HOURS'),
      loginMaxAttempts: eff(se.loginMaxAttempts, config.loginMaxAttempts, 'LOGIN_MAX_ATTEMPTS'),
      loginLockoutSeconds: eff(se.loginLockoutSeconds, config.loginLockoutMs / 1000, 'LOGIN_LOCKOUT_SECONDS'),
    },
    files: {
      /** null = no limit */
      defaultQuotaBytes: { value: quota || null, source: (f.defaultQuotaBytes !== undefined ? 'web' : 'default') as Source },
      trashRetentionDays: eff(f.trashRetentionDays, config.trashRetentionDays, 'TRASH_RETENTION_DAYS'),
      versionsKeep: eff(f.versionsKeep, config.versionsKeep, 'VERSIONS_KEEP'),
      versionsDays: eff(f.versionsDays, config.versionsDays, 'VERSIONS_DAYS'),
      uploadMaxSize: { value: uploadMaxSize(), source: (f.uploadMaxSize !== undefined ? 'web' : envSet('UPLOAD_MAX_SIZE') ? 'env' : 'default') as Source },
      /** the biggest value uploadMaxSize may be set to (UPLOAD_MAX_SIZE, fixed when the app started) */
      uploadMaxSizeCeiling: UPLOAD_CEILING,
      webdav: eff(f.webdav, config.webdav, 'WEBDAV'),
      thumbnails: eff(f.thumbnails, config.thumbnails, 'THUMBNAILS'),
    },
    mail: {
      host: eff(m.host, mv.host, 'SMTP_HOST'),
      port: eff(m.port, mv.port, 'SMTP_PORT'),
      secure: eff(m.secure, mv.secure, 'SMTP_SECURE'),
      user: eff(m.user, mv.user, 'SMTP_USER'),
      from: eff(m.from, mv.from, 'SMTP_FROM'),
      /** the password itself is never sent */
      passSet: !!mv.pass,
      passSource: (m.passSealed !== undefined ? 'web' : envSet('SMTP_PASS') ? 'env' : 'default') as Source,
    },
    alerts: {
      webhookUrl: { value: maskUrl(av.url), source: (a.webhookSealed !== undefined ? 'web' : envSet('ALERT_WEBHOOK_URL') ? 'env' : 'default') as Source },
      kind: eff(a.kind, av.kind, 'ALERT_WEBHOOK_KIND'),
      telegramChatId: eff(a.telegramChatId, av.chatId, 'ALERT_TELEGRAM_CHAT_ID'),
      lang: eff(a.lang, av.lang, 'ALERT_LANG'),
    },
    antivirus: {
      enabled: eff(av2.enabled, config.clamavEnabled, 'CLAMAV_ENABLED'),
      host: eff(av2.host, config.clamavHost, 'CLAMAV_HOST'),
      port: eff(av2.port, config.clamavPort, 'CLAMAV_PORT'),
      timeoutSeconds: eff(av2.timeoutSeconds, config.clamavTimeoutSeconds, 'CLAMAV_TIMEOUT_SECONDS'),
      maxScanMb: eff(av2.maxScanMb, config.clamavMaxScanMb, 'CLAMAV_MAX_SCAN_MB'),
      onErrorLinks: eff(av2.onErrorLinks, config.clamavOnErrorLinks, 'CLAMAV_ON_ERROR_LINKS'),
      onErrorUsers: eff(av2.onErrorUsers, config.clamavOnErrorUsers, 'CLAMAV_ON_ERROR_USERS'),
      onTooBigLinks: eff(av2.onTooBigLinks, config.clamavOnTooBigLinks, 'CLAMAV_ON_TOO_BIG_LINKS'),
      onTooBigUsers: eff(av2.onTooBigUsers, config.clamavOnTooBigUsers, 'CLAMAV_ON_TOO_BIG_USERS'),
    },
    auditForward: {
      syslogHost: eff(af.syslogHost, afv.syslogHost, null),
      syslogPort: eff(af.syslogPort, afv.syslogPort, null),
      syslogProto: eff<'udp' | 'tcp'>(af.syslogProto, afv.syslogProto, null),
      syslogFacility: eff(af.syslogFacility, afv.syslogFacility, null),
      webhookUrl: { value: maskUrl(afv.webhookUrl), source: (af.webhookSealed !== undefined ? 'web' : 'default') as Source },
      /** the secret itself is never sent */
      webhookSecretSet: !!af.webhookSecretSealed,
      webhookSecretSource: (af.webhookSecretSealed !== undefined ? 'web' : 'default') as Source,
    },
  }
  // a locked key says so (the page shows it read-only); the write-only secrets have no entry of their own, so their flag sits next to passSet / webhookSecretSet
  if (config.lockOutbound) {
    for (const path of LOCKED_WHEN_OUTBOUND_LOCK) {
      const [g, k] = path.split('.') as [keyof typeof view, string]
      const grpView = view[g] as Record<string, any>
      if (path === 'mail.pass') grpView.passLocked = true
      else if (path === 'auditForward.webhookSecret') grpView.webhookSecretLocked = true
      else grpView[k].locked = true
    }
  }
  return view
}

/** names (never values) of the locked keys that still hold a web value in settings.json: ignored while the lock is on */
export function ignoredLockedKeys(): string[] {
  if (!config.lockOutbound) return []
  return LOCKED_WHEN_OUTBOUND_LOCK.filter(p => {
    const [g, k] = p.split('.')
    return storedGroup(g)[SPEC[g][k][0]] !== undefined
  })
}

// ───────────── saving ─────────────

const fail = (key: string, extra: Record<string, string | number> = {}) => bad('admin.bad-setting', { key, ...extra })
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\x00-\x1f\x7f]/.test(v)
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

type Parse = (v: unknown, key: string) => unknown
const int = (min: number, max: number): Parse => (v, key) => { if (!isInt(v, min, max)) throw fail(key, { min, max }); return v }
const flag: Parse = (v, key) => { if (typeof v !== 'boolean') throw fail(key); return v }
const oneOf = (...values: string[]): Parse => (v, key) => { if (typeof v !== 'string' || !values.includes(v)) throw fail(key); return v }
const str = (max: number): Parse => (v, key) => { if (!isStr(v, max)) throw fail(key); return v.trim() }

/** the one rule for an outbound webhook URL (alerts and audit forwarding): https, or http only to this machine */
export function isSafeWebhookUrl(value: string): boolean {
  let u: URL
  try { u = new URL(value) } catch { return false }
  return u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname))
}

const webhook: Parse = (v, key) => {
  if (!isStr(v, 1000)) throw fail(key)
  const s = v.trim()
  if (!s) return ''
  if (!isSafeWebhookUrl(s)) throw fail(key)
  return s
}

/** group -> key -> [where it is stored in settings.json, check] */
const SPEC: Record<string, Record<string, [string, Parse]>> = {
  share: {
    defaultDays: ['defaultDays', (v, k) => { if (typeof v !== 'number' || !SHARE_DAY_CHOICES.includes(v)) throw fail(k); return v }],
    maxDays: ['maxDays', (v, k) => { if (typeof v !== 'number' || !SHARE_DAY_CHOICES.includes(v)) throw fail(k); return v }],
    allowNever: ['allowNever', flag],
    requirePassword: ['requirePassword', flag],
    viewOnly: ['viewOnly', oneOf('allow', 'force', 'forbid')],
    forceWatermark: ['forceWatermark', flag],
  },
  antivirus: {
    enabled: ['enabled', flag],
    host: ['host', (v, k) => { const s = str(253)(v, k) as string; if (!s || !/^[A-Za-z0-9.:\[\]-]+$/.test(s)) throw fail(k); return s }],
    port: ['port', int(1, 65535)],
    timeoutSeconds: ['timeoutSeconds', int(1, 600)],
    maxScanMb: ['maxScanMb', int(1, 4096)],
    onErrorLinks: ['onErrorLinks', oneOf('allow', 'reject')],
    onErrorUsers: ['onErrorUsers', oneOf('allow', 'reject')],
    onTooBigLinks: ['onTooBigLinks', oneOf('allow', 'reject')],
    onTooBigUsers: ['onTooBigUsers', oneOf('allow', 'reject')],
  },
  security: {
    require2fa: ['require2fa', oneOf('none', 'admin', 'staff', 'all')],
    sessionTtlHours: ['sessionTtlHours', int(1, 2160)],
    loginMaxAttempts: ['loginMaxAttempts', int(3, 20)],
    loginLockoutSeconds: ['loginLockoutSeconds', int(30, 3600)],
  },
  files: {
    defaultQuotaBytes: ['defaultQuotaBytes', int(0, 2 ** 50)],
    trashRetentionDays: ['trashRetentionDays', int(1, 365)],
    versionsKeep: ['versionsKeep', int(0, 100)],
    versionsDays: ['versionsDays', int(1, 365)],
    uploadMaxSize: ['uploadMaxSize', (v, k) => {
      if (!isInt(v, 1, Number.MAX_SAFE_INTEGER)) throw fail(k)
      if (v > UPLOAD_CEILING) throw bad('admin.upload-over-ceiling', { max: UPLOAD_CEILING })
      return v
    }],
    webdav: ['webdav', flag],
    thumbnails: ['thumbnails', flag],
  },
  mail: {
    host: ['host', (v, k) => { const s = str(253)(v, k) as string; if (s && !/^[A-Za-z0-9.:\[\]-]+$/.test(s)) throw fail(k); return s }],
    port: ['port', int(1, 65535)],
    secure: ['secure', oneOf('starttls', 'tls', 'none')],
    user: ['user', str(200)],
    pass: ['passSealed', (v, k) => { if (typeof v !== 'string' || v.length > 500) throw fail(k); return v ? seal(v) : '' }],
    from: ['from', str(200)],
  },
  alerts: {
    webhookUrl: ['webhookSealed', (v, k) => { const s = webhook(v, k) as string; return s ? seal(s) : '' }],
    kind: ['kind', oneOf('discord', 'slack', 'telegram', 'json')],
    telegramChatId: ['telegramChatId', str(100)],
    lang: ['lang', oneOf('th', 'en')],
  },
  auditForward: {
    syslogHost: ['syslogHost', (v, k) => { const s = str(253)(v, k) as string; if (s && !/^[A-Za-z0-9.:\[\]-]+$/.test(s)) throw fail(k); return s }],
    syslogPort: ['syslogPort', int(1, 65535)],
    syslogProto: ['syslogProto', oneOf('udp', 'tcp')],
    syslogFacility: ['syslogFacility', int(0, 23)],
    webhookUrl: ['webhookSealed', (v, k) => { const s = webhook(v, k) as string; return s ? seal(s) : '' }],
    // signs every webhook batch (X-FC-Signature); empty = unsigned
    webhookSecret: ['webhookSecretSealed', (v, k) => { if (typeof v !== 'string' || (v !== '' && !/^[\x20-\x7e]{16,200}$/.test(v))) throw fail(k); return v ? seal(v) : '' }],
  },
}

export const POLICY_GROUPS = Object.keys(SPEC)

/** the groups of a request body that need the admin's password: anything that changes sign-in rules, where mail and alerts go, or how data may leave through share links */
export const STEP_UP_GROUPS = ['security', 'mail', 'alerts', 'auditForward', 'antivirus', 'share']

/**
 * Check every given key and save them together (nothing is saved when one is wrong). A key given as `null` goes back
 * to the env value. Returns the changed keys as `group.key` (never a value) for the activity log.
 */
export function savePolicy(body: Record<string, unknown>): string[] {
  const next: Record<string, Record<string, unknown>> = {}
  const changed: string[] = []
  for (const g of POLICY_GROUPS) {
    const given = body[g]
    if (given === undefined) continue
    if (given === null || typeof given !== 'object' || Array.isArray(given)) throw fail(g)
    const cur = { ...storedGroup(g) }
    for (const [key, value] of Object.entries(given as Record<string, unknown>)) {
      const spec = SPEC[g][key]
      if (!spec) throw fail(`${g}.${key}`)
      if (value === null) delete cur[spec[0]]
      else cur[spec[0]] = spec[1](value, `${g}.${key}`)
      changed.push(`${g}.${key}`)
    }
    next[g] = cur
  }
  // the default choice can not be longer than the longest allowed
  if (next.share) {
    const s = next.share as SharePrefs
    const max = s.maxDays ?? config.shareMaxDays
    if (s.defaultDays !== undefined && s.defaultDays > max) throw fail('share.defaultDays', { max })
  }
  const patch: Partial<Settings> = {}
  for (const [g, v] of Object.entries(next)) (patch as any)[g] = Object.keys(v).length ? v : undefined
  if (changed.length) settings.update(patch)
  return changed
}

export type { AlertPrefs, AntivirusPrefs, AuditForwardPrefs, FilesPrefs, MailPrefs, SecurityPrefs, SharePrefs }
