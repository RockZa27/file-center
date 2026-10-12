import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import pkg from '../package.json'

const root = resolve(import.meta.dir, '..')
const env = (k: string, d: string) => process.env[k] ?? d
const num = (k: string, d: number) => {
  const v = Number(process.env[k])
  return Number.isFinite(v) && process.env[k] !== undefined && process.env[k] !== '' ? v : d
}
function backupHour(v: string): number | null {
  if (v.trim().toLowerCase() === 'off') return null
  const h = Number(v)
  return Number.isInteger(h) && h >= 0 && h <= 23 && v.trim() !== '' ? h : 3
}

const dataDir = resolve(env('DATA_DIR', join(root, 'data')))

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
  uploadSimultaneous: num('UPLOAD_SIMULTANEOUS', 3),
  uploadStaleMs: num('UPLOAD_STALE_HOURS', 3) * 3600_000,
  /** bytes all visitors (not signed in) may upload together per day; 0 = visitors can not upload */
  guestUploadDailyBytes: num('GUEST_UPLOAD_DAILY_BYTES', 1024 ** 3), // 1 GB
  /** uploads are refused when they would leave less free disk space than this */
  minFreeSpace: num('MIN_FREE_SPACE', 2 * 1024 ** 3), // 2 GB
  sessionTtlMs: num('SESSION_TTL_HOURS', 24 * 7) * 3600_000,
  trashRetentionDays: num('TRASH_RETENTION_DAYS', 30),
  loginMaxAttempts: num('LOGIN_MAX_ATTEMPTS', 5),
  loginLockoutMs: num('LOGIN_LOCKOUT_SECONDS', 60) * 1000,
  /** longest a share link may last; a link is made for 1, 7 or 30 days, whichever of those is not above this */
  shareMaxDays: num('SHARE_MAX_DAYS', 30),
  auditMaxBytes: 10 * 1024 * 1024,
  auditMaxFiles: 10,
  /** logs/system.log (and access.log) is rotated past this size; LOG_MAX_FILES counts the current file too */
  logMaxBytes: num('LOG_MAX_BYTES', 10 * 1024 ** 2), // 10 MB
  logMaxFiles: Math.max(2, Math.floor(num('LOG_MAX_FILES', 5))),
  /** "true" writes one line per request to logs/access.log (method, path without tokens or query, status, ms, ip, user) */
  accessLog: env('ACCESS_LOG', 'false') === 'true',
  unzipMaxBytes: num('UNZIP_MAX_BYTES', 20 * 1024 ** 3),
  unzipMaxFiles: num('UNZIP_MAX_FILES', 50_000),
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
  /** "false" turns the update-from-the-web feature off completely */
  webUpdate: env('WEB_UPDATE', 'true') !== 'false',
  /** biggest update package an admin may upload */
  updateMaxSize: num('UPDATE_MAX_SIZE', 200 * 1024 ** 2),
  /**
   * Ed25519 public key (base64 SPKI DER, from "bun run package --gen-key") that update packages must be signed with.
   * Empty = packages are not signed-checked. Parsed in updater.ts, so a bad value refuses packages instead of crashing the app.
   */
  updatePublicKey: env('UPDATE_PUBLIC_KEY', '').trim(),
  /**
   * base URL of published updates (the `updates` branch made by "bun run release"), e.g.
   * https://raw.githubusercontent.com/<owner>/<repo>/updates. Empty = off. Checked in update-source.ts: anything but
   * https (or http to this machine, for tests) is refused at startup with a warning and stays off.
   */
  updateSource: env('UPDATE_SOURCE', '').trim(),
  /** where backups are written; best on another disk, a dead disk takes the backups on it along */
  backupDir: resolve(env('BACKUP_DIR', join(dirname(dataDir), 'backups'))),
  /** after a successful backup the oldest beyond this many are deleted */
  backupKeep: Math.max(1, Math.floor(num('BACKUP_KEEP', 7))),
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
  tmp: join(config.dataDir, 'tmp'),
  branding: join(config.dataDir, 'branding'),
  /** installed web updates: state.json, releases/, staging/ (see release.ts) */
  app: join(config.dataDir, 'app'),
  backupStatus: join(config.dataDir, 'backup-status.json'),
  /** what visitors uploaded today, so a restart does not hand out a fresh daily allowance */
  guestUploads: join(config.dataDir, 'guest-uploads.json'),
  /** share links (only the SHA-256 of each token, never the token itself) */
  shares: join(config.dataDir, 'shares.json'),
  /** signs the links the office document server opens (office.ts); made on first use, never leaves this server */
  officeKey: join(config.dataDir, 'office-links.key'),
  /** saved office versions while they download (office.ts) */
  officeTmp: join(config.dataDir, 'office-tmp'),
  publicDir: join(config.storageDir, config.publicDirName),
  /** parent of the default user folders (/users/<name>) */
  usersDir: join(config.storageDir, 'users'),
}

export function ensureDirs() {
  for (const p of [config.storageDir, config.dataDir, paths.logs, paths.trash, paths.tmp, paths.branding, paths.app, paths.publicDir]) {
    mkdirSync(p, { recursive: true })
  }
}

// stores are created while modules load, so the folders must exist before that
ensureDirs()
