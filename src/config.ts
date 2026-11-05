import { chmodSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import pkg from '../package.json'

const root = resolve(import.meta.dir, '..')
const env = (k: string, d: string) => process.env[k] ?? d

/** where File Center publishes its signed releases (the `updates` branch, see scripts/release.ts) */
export const OFFICIAL_UPDATE_SOURCE = 'https://raw.githubusercontent.com/RockZa27/file-center/updates'
export function updateSourceOf(value: string | undefined): string {
  if (value === undefined) return OFFICIAL_UPDATE_SOURCE
  const v = value.trim()
  return v.toLowerCase() === 'off' ? '' : v
}
const num = (k: string, d: number) => {
  const v = Number(process.env[k])
  return Number.isFinite(v) && process.env[k] !== undefined && process.env[k] !== '' ? v : d
}
function backupHour(v: string): number | null {
  if (v.trim().toLowerCase() === 'off') return null
  const h = Number(v)
  return Number.isInteger(h) && h >= 0 && h <= 23 && v.trim() !== '' ? h : 3
}

/** FC_UMASK: 3 octal digits; anything else gives the default 077 (files private to the app's account) */
export const DEFAULT_UMASK = 0o077
export function parseUmask(v: string | undefined): { mask: number; invalid: boolean } {
  const t = (v ?? '').trim()
  if (t === '') return { mask: DEFAULT_UMASK, invalid: false }
  return /^[0-7]{3}$/.test(t) ? { mask: parseInt(t, 8), invalid: false } : { mask: DEFAULT_UMASK, invalid: true }
}
/**
 * The umask this process runs with: FC_UMASK, but only when it owns the data. A process of another account (root running
 * the CLI with `docker compose exec`) keeps its own umask, so what it writes stays readable by the owner of DATA_DIR.
 * dataOwnerUid null = DATA_DIR does not exist yet (this process makes it), processUid null = no uid (Windows).
 */
export function effectiveUmask(o: { setting: number; processUid: number | null; dataOwnerUid: number | null; current: number }): number {
  if (o.processUid === null || o.dataOwnerUid === null || o.processUid === o.dataOwnerUid) return o.setting
  return o.current
}
const umaskSetting = parseUmask(process.env.FC_UMASK)
const dataDir = resolve(env('DATA_DIR', join(root, 'data')))
const umaskNow = (() => { try { return process.umask() } catch { return DEFAULT_UMASK } })()
let ownsData = true
const umaskApplied = (() => {
  let dataOwnerUid: number | null = null
  try { dataOwnerUid = statSync(dataDir).uid } catch { /* not there yet: this process makes it */ }
  const processUid = typeof process.getuid === 'function' ? process.getuid() : null
  ownsData = processUid === null || dataOwnerUid === null || processUid === dataOwnerUid
  return effectiveUmask({ setting: umaskSetting.mask, processUid, dataOwnerUid, current: umaskNow })
})()
/** the bad FC_UMASK value (index.ts warns once at start), '' when it was fine */
export const invalidUmask = umaskSetting.invalid ? process.env.FC_UMASK!.trim() : ''
// before any folder or file is made, so that every file the app (and the vips / ffmpeg / app processes it starts) writes gets it
try { process.umask(umaskApplied) } catch { /* Windows */ }
export const umask = umaskApplied

/**
 * Existing installs: a top-level folder made with the old 022 is made as private as the umask says. Not recursive and
 * never fatal (a mount the app does not own, Windows).
 */
export function tightenDir(p: string) {
  if (!ownsData) return // not the owner of DATA_DIR: leave the modes alone
  try {
    const mode = statSync(p).mode & 0o777
    if (mode & umaskSetting.mask) chmodSync(p, mode & ~umaskSetting.mask)
  } catch { /* EPERM etc.: keep going */ }
}

export const config = {
  /** a web update runs with FC_VERSION set to the version in its manifest; otherwise the version of package.json */
  version: process.env.FC_VERSION || pkg.version,
  root,
  port: num('PORT', 3000),
  host: env('HOST', '0.0.0.0'),
  /** uploaded files live here */
  storageDir: resolve(env('STORAGE_DIR', join(root, 'storage'))),
  /** users, settings, logs, trash, sessions, temp uploads */
  dataDir,
  /** compiled frontend */
  webDir: resolve(env('WEB_DIR', join(root, 'web', 'dist'))),
  /** folder (inside storage) shown to visitors who are not logged in */
  publicDirName: 'public',
  uploadMaxSize: num('UPLOAD_MAX_SIZE', 10 * 1024 ** 3), // 10 GB per file
  uploadChunkSize: num('UPLOAD_CHUNK_SIZE', 8 * 1024 ** 2), // 8 MB
  uploadSimultaneous: num('UPLOAD_SIMULTANEOUS', 6),
  /** announced and unfinished uploads one owner may hold at once (0 = no limit) */
  uploadMaxPending: num('UPLOAD_MAX_PENDING', 500),
  uploadStaleMs: num('UPLOAD_STALE_HOURS', 3) * 3600_000,
  /** an upload-request link made without limits gets these (per file, and all files of the link together) */
  uploadRequestMaxFile: num('UPLOAD_REQUEST_MAX_FILE', 1024 ** 3), // 1 GB
  uploadRequestMaxTotal: num('UPLOAD_REQUEST_MAX_TOTAL', 5 * 1024 ** 3), // 5 GB
  /** an announced upload of such a link that gets no chunk for this long stops holding the link's slots */
  uploadRequestIdleMs: num('UPLOAD_REQUEST_IDLE_MINUTES', 15) * 60_000,
  /** bytes all visitors (not signed in) may upload together per day; 0 = visitors can not upload */
  guestUploadDailyBytes: num('GUEST_UPLOAD_DAILY_BYTES', 1024 ** 3), // 1 GB
  /** uploads are refused when they would leave less free disk space than this */
  minFreeSpace: num('MIN_FREE_SPACE', 2 * 1024 ** 3), // 2 GB
  sessionTtlMs: num('SESSION_TTL_HOURS', 24 * 7) * 3600_000,
  /** a signed-in session ends this long after sign-in however often it is used (never below the idle TTL); positive whole hours */
  sessionMaxMs: (Number.isInteger(Number(process.env.SESSION_MAX_HOURS)) && Number(process.env.SESSION_MAX_HOURS) > 0 ? Number(process.env.SESSION_MAX_HOURS) : 24 * 30) * 3600_000,
  trashRetentionDays: num('TRASH_RETENTION_DAYS', 30),
  /** old contents of a file kept on every save (0 = off) and for how many days (0 = until pushed out by the count) */
  versionsKeep: Math.max(0, Math.floor(num('VERSIONS_KEEP', 10))),
  versionsDays: Math.max(0, num('VERSIONS_DAYS', 30)),
  loginMaxAttempts: num('LOGIN_MAX_ATTEMPTS', 5),
  loginLockoutMs: num('LOGIN_LOCKOUT_SECONDS', 60) * 1000,
  /** wider nets than ip|user: failures of one account from any address, and of one address with any username, within the window */
  loginAccountMaxAttempts: num('LOGIN_ACCOUNT_MAX_ATTEMPTS', 20),
  loginAddressMaxAttempts: num('LOGIN_ADDRESS_MAX_ATTEMPTS', 30),
  /** the window those failures are counted in, and how long the account / address then waits */
  loginWideWindowMs: num('LOGIN_WIDE_WINDOW_MINUTES', 15) * 60_000,
  /** longest a share link may last; a link is made for 1, 7 or 30 days, whichever of those is not above this */
  shareMaxDays: num('SHARE_MAX_DAYS', 30),
  auditMaxBytes: 10 * 1024 * 1024,
  auditMaxFiles: 10,
  /** logs/system.log (and access.log) is rotated past this size; LOG_MAX_FILES counts the current file too */
  logMaxBytes: num('LOG_MAX_BYTES', 10 * 1024 ** 2), // 10 MB
  logMaxFiles: Math.max(2, Math.floor(num('LOG_MAX_FILES', 5))),
  /** "true" writes one line per request to logs/access.log (method, path without tokens or query, status, ms, ip, user) */
  accessLog: env('ACCESS_LOG', 'false') === 'true',
  /** "off" turns server-side thumbnails (thumbs.ts) off: the page then shows icons */
  thumbnails: !['off', 'false', '0'].includes(env('THUMBNAILS', 'on').trim().toLowerCase()),
  /** the thumbnail cache (DATA_DIR/thumbs) is trimmed to this size, oldest used first */
  thumbCacheMax: Math.max(1, num('THUMB_CACHE_MAX_MB', 1024)) * 1024 ** 2,
  unzipMaxBytes: num('UNZIP_MAX_BYTES', 20 * 1024 ** 3),
  unzipMaxFiles: num('UNZIP_MAX_FILES', 50_000),
  /** code page of the names in a zip that are not UTF-8 (zip.js would read them as CP437): cp874 = Thai Windows; cp437 = leave it to zip.js */
  zipLegacyEncoding: env('ZIP_LEGACY_ENCODING', 'cp874'),
  /** set to "true" behind HTTPS so the session cookie is marked Secure */
  secureCookie: env('SECURE_COOKIE', 'false') === 'true',
  /**
   * where the visitor's IP comes from:
   * "false" = the connection itself, "cloudflare" = CF-Connecting-IP (Cloudflare / Cloudflare Tunnel),
   * "true" = the last X-Forwarded-For entry, the one written by your own reverse proxy (earlier entries come from the client)
   */
  trustProxy: env('TRUST_PROXY', 'false') as 'false' | 'true' | 'cloudflare',
  /** first-run admin password; random one is printed to the console when empty */
  adminPassword: env('ADMIN_PASSWORD', ''),
  /** "off" turns WebDAV (/dav, webdav.ts) off: it then answers 404 */
  webdav: !['off', 'false', '0'].includes(env('WEBDAV', 'on').trim().toLowerCase()),
  /** a WebDAV folder listing (PROPFIND Depth 1) answers folders with fewer entries than this; bigger ones get 507 */
  davMaxItems: num('WEBDAV_MAX_ITEMS', 100_000),
  /** "false" turns the update-from-the-web feature off completely */
  webUpdate: env('WEB_UPDATE', 'true') !== 'false',
  /** biggest update package an admin may upload */
  updateMaxSize: num('UPDATE_MAX_SIZE', 200 * 1024 ** 2),
  /**
   * Ed25519 public key (base64 SPKI DER, from "bun run package --gen-key") that update packages must be signed with.
   * Empty = the key built into File Center (update-key.ts). Parsed in updater.ts, so a bad value refuses packages instead of crashing the app.
   */
  updatePublicKey: env('UPDATE_PUBLIC_KEY', '').trim(),
  /**
   * "true" accepts update packages that carry no signature (one that is signed must still verify). For people who
   * build their own packages; anyone who can make an admin install a package can then run code on the server.
   */
  updateAllowUnsigned: env('UPDATE_ALLOW_UNSIGNED', 'false') === 'true',
  /**
   * base URL of published updates (the `updates` branch made by "bun run release"), e.g.
   * https://raw.githubusercontent.com/<owner>/<repo>/updates. Empty = off. Checked in update-source.ts: anything but
   * https (or http to this machine, for tests) is refused at startup with a warning and stays off.
   */
  // not set: File Center's own releases on GitHub (safe since every package must carry File Center's signature);
  // UPDATE_SOURCE=off (or empty) turns checking and fetching off, another URL points at your own releases
  updateSource: updateSourceOf(process.env.UPDATE_SOURCE),
  /** where backups are written; best on another disk, a dead disk takes the backups on it along */
  backupDir: resolve(env('BACKUP_DIR', join(dirname(dataDir), 'backups'))),
  /** after a successful backup the oldest beyond this many are deleted */
  backupKeep: Math.max(1, Math.floor(num('BACKUP_KEEP', 7))),
  /** "false" turns the search index off: /api/search then always walks the disk */
  searchIndex: env('SEARCH_INDEX', 'true') !== 'false',
  /** the search index (search-index.ts) is built again from the disk this often; 0 = only at start */
  searchRescanMinutes: Math.max(0, num('SEARCH_RESCAN_MINUTES', 30)),
  /** local hour (0-23) of the daily backup, null = "off" (no schedule; backups still run from the web page) */
  backupHour: backupHour(env('BACKUP_HOUR', '3')),
  /** "true" also puts the uploaded files (storage) in every backup; off by default because it can be huge */
  backupIncludeFiles: env('BACKUP_INCLUDE_FILES', 'false') === 'true',
  /**
   * ONLYOFFICE Docs (office.ts), off while empty: OFFICE_URL is the document server as the browser reaches it,
   * OFFICE_INTERNAL_URL is File Center as the document server reaches it, OFFICE_SERVER_INTERNAL_URL the document
   * server as File Center reaches it (default OFFICE_URL). Checked in office.ts: a bad value keeps it off with a warning.
   */
  officeUrl: env('OFFICE_URL', '').trim(),
  officeInternalUrl: env('OFFICE_INTERNAL_URL', '').trim(),
  officeServerInternalUrl: env('OFFICE_SERVER_INTERNAL_URL', '').trim(),
  /** shared with the document server (its JWT_SECRET); at least 32 characters or office editing stays off */
  officeJwtSecret: env('OFFICE_JWT_SECRET', '').trim(),
  /** biggest file that opens in the office editor (and biggest saved version taken back) */
  officeMaxSize: num('OFFICE_MAX_SIZE', 100 * 1024 ** 2), // 100 MB
  /**
   * where alerts go (alerts.ts): https only (http to this machine, for tests). Empty = no alerts. Checked in alerts.ts:
   * a wrong value leaves alerts off with a warning at startup. A Telegram bot token is part of this URL: never shown.
   */
  alertWebhookUrl: env('ALERT_WEBHOOK_URL', '').trim(),
  /** the shape of the message: discord | slack | telegram | json */
  alertWebhookKind: env('ALERT_WEBHOOK_KIND', 'json').trim().toLowerCase(),
  /** the chat a Telegram bot writes to (ALERT_WEBHOOK_KIND=telegram needs it) */
  alertTelegramChatId: env('ALERT_TELEGRAM_CHAT_ID', '').trim(),
  /** language of the alert texts */
  alertLang: (env('ALERT_LANG', 'th').trim().toLowerCase() === 'en' ? 'en' : 'th') as 'th' | 'en',
  /** more errors than this in the last hour sends an alert */
  alertErrorsPerHour: Math.max(1, Math.floor(num('ALERT_ERRORS_PER_HOUR', 20))),
  /**
   * Notifications (notify.ts). PUBLIC_URL is the address people open File Center at (https://files.example.com): the
   * verification link in an e-mail and the links in messages are made from it, never from a request's Host header.
   */
  publicUrl: env('PUBLIC_URL', '').trim(),
  /** e-mail (mail.ts), off while SMTP_HOST is empty. SMTP_SECURE: starttls (port 587) | tls (port 465) | none (this machine only) */
  smtpHost: env('SMTP_HOST', '').trim(),
  smtpPort: num('SMTP_PORT', 587),
  smtpSecure: env('SMTP_SECURE', 'starttls').trim().toLowerCase(),
  smtpUser: env('SMTP_USER', '').trim(),
  smtpPass: env('SMTP_PASS', ''),
  smtpFrom: env('SMTP_FROM', '').trim(),
  /** LINE Messaging API (line.ts), off while LINE_CHANNEL_TOKEN is empty; the secret checks the webhook's signature */
  lineChannelToken: env('LINE_CHANNEL_TOKEN', '').trim(),
  lineChannelSecret: env('LINE_CHANNEL_SECRET', '').trim(),
  /** a LINE group or room that gets the admins' system alerts */
  lineGroupId: env('LINE_GROUP_ID', '').trim(),
  /** FOR TESTS: http://127.0.0.1:<port> of a stand-in for api.line.me. Any other host is ignored (line.ts). */
  lineApiBase: env('LINE_API_BASE', '').trim(),
  /**
   * Virus scanning with ClamAV (antivirus.ts), off by default. clamd is reached over TCP (INSTREAM). These are the env
   * values; the settings page overrides each of them. A file bigger than CLAMAV_MAX_SCAN_MB is not sent to clamd and is
   * treated like an unreachable scanner. CLAMAV_ON_ERROR_LINKS / _USERS (allow | reject) say what happens to an upload
   * that could not be scanned: from an upload link or a visitor, and from a signed-in user (WebDAV included).
   */
  clamavEnabled: env('CLAMAV_ENABLED', 'false').trim().toLowerCase() === 'true',
  clamavHost: env('CLAMAV_HOST', '127.0.0.1').trim(),
  clamavPort: num('CLAMAV_PORT', 3310),
  clamavTimeoutSeconds: num('CLAMAV_TIMEOUT_SECONDS', 60),
  clamavMaxScanMb: num('CLAMAV_MAX_SCAN_MB', 25),
  clamavOnErrorLinks: (env('CLAMAV_ON_ERROR_LINKS', 'reject').trim().toLowerCase() === 'allow' ? 'allow' : 'reject') as 'allow' | 'reject',
  clamavOnErrorUsers: (env('CLAMAV_ON_ERROR_USERS', 'allow').trim().toLowerCase() === 'reject' ? 'reject' : 'allow') as 'allow' | 'reject',
  /** quarantined files are deleted after this many days, and the oldest go first when they take more than the cap */
  quarantineDays: Math.max(1, Math.floor(num('QUARANTINE_DAYS', 30))),
  quarantineMaxBytes: Math.max(0, num('QUARANTINE_MAX_MB', 2048)) * 1024 ** 2,
}

export const paths = {
  users: join(config.dataDir, 'users.json'),
  settings: join(config.dataDir, 'settings.json'),
  sessions: join(config.dataDir, 'sessions.json'),
  logs: join(config.dataDir, 'logs'),
  audit: join(config.dataDir, 'logs', 'audit.log'),
  /** errors and events of the app (logger.ts), shown on the admin logs page */
  systemLog: join(config.dataDir, 'logs', 'system.log'),
  /** written by launcher.ts: starts, restarts, rollbacks, crashes */
  launcherLog: join(config.dataDir, 'logs', 'launcher.log'),
  accessLog: join(config.dataDir, 'logs', 'access.log'),
  trash: join(config.dataDir, 'trash'),
  /** earlier contents of edited files (versions.ts): <sha1 of the storage path>/<id>/{item,meta.json} */
  versions: join(config.dataDir, 'versions'),
  /** favorites and recent files per user (favorites.ts) */
  userState: join(config.dataDir, 'user-state.json'),
  /** onboarding per user (guide.ts): the version whose news they have seen, and the tours they finished */
  guide: join(config.dataDir, 'guide.json'),
  grants: join(config.dataDir, 'grants.json'),
  /** app passwords for WebDAV (app-passwords.ts): only an argon2 hash of each, never the password */
  appPasswords: join(config.dataDir, 'app-passwords.json'),
  /** groups, their members and limits (groups.ts) */
  groups: join(config.dataDir, 'groups.json'),
  tmp: join(config.dataDir, 'tmp'),
  /** files the virus scanner held back (antivirus.ts): not under the storage, reachable from no route but the admin's list */
  quarantine: join(config.dataDir, 'quarantine'),
  /** thumbnail cache (thumbs.ts): <sha1>.webp|jpg, and tmp/ for the one being made; rebuilt on demand, so not in backups */
  thumbs: join(config.dataDir, 'thumbs'),
  branding: join(config.dataDir, 'branding'),
  /** installed web updates: state.json, releases/, staging/ (see release.ts) */
  app: join(config.dataDir, 'app'),
  backupStatus: join(config.dataDir, 'backup-status.json'),
  /** what visitors uploaded today, so a restart does not hand out a fresh daily allowance */
  guestUploads: join(config.dataDir, 'guest-uploads.json'),
  /** notifications per user (notify.ts): the bell, at most 100 each */
  notifications: join(config.dataDir, 'notifications.json'),
  /** notification settings per user: channels, e-mail address (+ hashed verification token), LINE id, once-only marks */
  notifyState: join(config.dataDir, 'notify-state.json'),
  /** share links (only the SHA-256 of each token, never the token itself) */
  shares: join(config.dataDir, 'shares.json'),
  /** signs the links the office document server opens (office.ts); made on first use, never leaves this server */
  officeKey: join(config.dataDir, 'office-links.key'),
  /** AES key for secrets kept in users.json (secret-box.ts); made on first use */
  secretKey: join(config.dataDir, 'secret.key'),
  /** touched by the command line tool (cli.ts) after it changed users or sessions, so a running app re-reads them */
  cliChanged: join(config.dataDir, 'cli-changed'),
  /** saved office versions while they download (office.ts) */
  officeTmp: join(config.dataDir, 'office-tmp'),
  /** search index (search-index.ts): rebuilt from the disk when missing or damaged, so it is not in backups */
  searchDb: join(config.dataDir, 'search.db'),
  publicDir: join(config.storageDir, config.publicDirName),
  /** parent of the default user folders (/users/<name>) */
  usersDir: join(config.storageDir, 'users'),
}

export function ensureDirs() {
  for (const p of [config.storageDir, config.dataDir, paths.logs, paths.trash, paths.tmp, paths.quarantine, paths.branding, paths.app, paths.publicDir]) {
    mkdirSync(p, { recursive: true })
  }
  tightenDir(config.dataDir)
}

// stores are created while modules load, so the folders must exist before that
ensureDirs()
