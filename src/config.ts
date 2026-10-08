import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const env = (k: string, d: string) => process.env[k] ?? d
const num = (k: string, d: number) => {
  const v = Number(process.env[k])
  return Number.isFinite(v) && process.env[k] !== undefined && process.env[k] !== '' ? v : d
}

export const config = {
  version: '1.0.0',
  root,
  port: num('PORT', 3000),
  host: env('HOST', '0.0.0.0'),
  /** uploaded files live here */
  storageDir: resolve(env('STORAGE_DIR', join(root, 'storage'))),
  /** users, settings, logs, trash, sessions, temp uploads */
  dataDir: resolve(env('DATA_DIR', join(root, 'data'))),
  /** compiled frontend */
  webDir: resolve(env('WEB_DIR', join(root, 'web', 'dist'))),
  /** folder (inside storage) shown to visitors who are not logged in */
  publicDirName: 'public',
  uploadMaxSize: num('UPLOAD_MAX_SIZE', 10 * 1024 ** 3), // 10 GB per file
  uploadChunkSize: num('UPLOAD_CHUNK_SIZE', 8 * 1024 ** 2), // 8 MB
  uploadSimultaneous: num('UPLOAD_SIMULTANEOUS', 3),
  uploadStaleMs: num('UPLOAD_STALE_HOURS', 3) * 3600_000,
  /** uploads are refused when they would leave less free disk space than this */
  minFreeSpace: num('MIN_FREE_SPACE', 2 * 1024 ** 3), // 2 GB
  sessionTtlMs: num('SESSION_TTL_HOURS', 24 * 7) * 3600_000,
  trashRetentionDays: num('TRASH_RETENTION_DAYS', 30),
  loginMaxAttempts: num('LOGIN_MAX_ATTEMPTS', 5),
  loginLockoutMs: num('LOGIN_LOCKOUT_SECONDS', 60) * 1000,
  auditMaxBytes: 10 * 1024 * 1024,
  auditMaxFiles: 10,
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
}

export const paths = {
  users: join(config.dataDir, 'users.json'),
  settings: join(config.dataDir, 'settings.json'),
  sessions: join(config.dataDir, 'sessions.json'),
  logs: join(config.dataDir, 'logs'),
  audit: join(config.dataDir, 'logs', 'audit.log'),
  trash: join(config.dataDir, 'trash'),
  tmp: join(config.dataDir, 'tmp'),
  branding: join(config.dataDir, 'branding'),
  backupStatus: join(config.dataDir, 'backup-status.json'),
  publicDir: join(config.storageDir, config.publicDirName),
  /** parent of the default user folders (/users/<name>) */
  usersDir: join(config.storageDir, 'users'),
}

export function ensureDirs() {
  for (const p of [config.storageDir, config.dataDir, paths.logs, paths.trash, paths.tmp, paths.branding, paths.publicDir]) {
    mkdirSync(p, { recursive: true })
  }
}

// stores are created while modules load, so the folders must exist before that
ensureDirs()
