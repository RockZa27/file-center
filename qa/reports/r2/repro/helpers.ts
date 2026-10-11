import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type HandleApp = { handle: (req: Request) => Promise<Response> }

/** Create fresh temp STORAGE_DIR / DATA_DIR (and thus backupDir = dirname(DATA_DIR)/backups) BEFORE importing the app. */
export function setupEnv(opts: { adminPassword?: string | null; supervised?: boolean } = {}): { base: string } {
  const base = mkdtempSync(join(tmpdir(), 'fc-repro-'))
  process.env.STORAGE_DIR = join(base, 'storage')
  process.env.DATA_DIR = join(base, 'data')
  // backupDir defaults to dirname(DATA_DIR)/backups === base/backups
  if (opts.adminPassword !== null) process.env.ADMIN_PASSWORD = opts.adminPassword ?? 'adminPassw0rd!'
  else delete process.env.ADMIN_PASSWORD
  if (opts.supervised) process.env.FC_SUPERVISED = '1'
  // keep lockout defaults predictable
  delete process.env.LOGIN_MAX_ATTEMPTS
  delete process.env.LOGIN_LOCKOUT_SECONDS
  delete process.env.WEB_UPDATE
  delete process.env.FC_VERSION
  return { base }
}

export async function importApp(): Promise<HandleApp> {
  // FC_SRC lets the verifier re-run the same attack against a patched ("safe") copy of the code.
  const target = process.env.FC_SRC || '../../src/index'
  const mod = await import(target)
  return mod.app as unknown as HandleApp
}

function cookieOf(res: Response): string {
  const anyHeaders = res.headers as any
  const all = typeof anyHeaders.getSetCookie === 'function' ? anyHeaders.getSetCookie() : null
  const raw = all && all.length ? all[0] : res.headers.get('set-cookie')
  if (!raw) throw new Error('no set-cookie on response')
  return raw.split(';')[0]
}

export type Sess = { cookie: string; csrf: string }

export async function anon(app: HandleApp): Promise<Sess> {
  const res = await app.handle(new Request('http://localhost/api/session'))
  const cookie = cookieOf(res)
  const body = (await res.json()) as { csrf: string }
  return { cookie, csrf: body.csrf }
}

export async function login(app: HandleApp, username: string, password: string): Promise<Sess> {
  const a = await anon(app)
  const res = await app.handle(new Request('http://localhost/api/login', {
    method: 'POST',
    headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }))
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${await res.text()}`)
  const cookie = cookieOf(res)
  const body = (await res.json()) as { csrf: string }
  return { cookie, csrf: body.csrf }
}

/** POST/PUT/DELETE JSON helper that carries cookie + csrf */
export async function send(app: HandleApp, method: string, path: string, s: Sess, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { cookie: s.cookie, 'x-csrf-token': s.csrf }
  let payload: BodyInit | undefined
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
  return app.handle(new Request(`http://localhost${path}`, { method, headers, body: payload }))
}

export async function get(app: HandleApp, path: string, s?: Sess): Promise<Response> {
  const headers: Record<string, string> = {}
  if (s) headers.cookie = s.cookie
  return app.handle(new Request(`http://localhost${path}`, { headers }))
}

export async function createUser(app: HandleApp, admin: Sess, u: {
  username: string; name: string; password: string; role?: 'admin' | 'user'; homedir?: string;
  permissions?: string[]; publicPermissions?: string[];
}): Promise<Response> {
  return send(app, 'POST', '/api/admin/users', admin, {
    username: u.username, name: u.name, password: u.password, role: u.role ?? 'user',
    homedir: u.homedir, permissions: u.permissions ?? [], publicPermissions: u.publicPermissions ?? [],
  })
}

export function pass() { process.exit(0) }
export function vuln() { process.exit(42) }
export function fail(msg: string): never { console.error('REPRO ERROR:', msg); process.exit(1) }
