// Shared helpers for verifier repro scripts.
// NOTE: this module must NOT import src/* so that each repro can set env
// (STORAGE_DIR, DATA_DIR, ...) and import the app itself at the right time.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type App = { handle: (req: Request) => Promise<Response> }

/** Make fresh temp STORAGE_DIR/DATA_DIR and a known admin password, set env BEFORE importing the app. */
export function freshEnv(extra: Record<string, string> = {}) {
  const base = mkdtempSync(join(tmpdir(), 'fcrepro-'))
  process.env.STORAGE_DIR = join(base, 'storage')
  process.env.DATA_DIR = join(base, 'data')
  process.env.ADMIN_PASSWORD = 'AdminPass123!'
  for (const [k, v] of Object.entries(extra)) process.env[k] = v
  return { base, storage: process.env.STORAGE_DIR!, data: process.env.DATA_DIR!, adminPassword: process.env.ADMIN_PASSWORD! }
}

export function sidFrom(res: Response): string | null {
  const cookies = (res.headers as any).getSetCookie?.() ?? []
  for (const c of cookies) {
    const m = String(c).match(/fc_sid=([^;]+)/)
    if (m) return m[1]
  }
  return null
}

export type Sess = { cookie: string; csrf: string; body: any }

export async function getSession(app: App, headers: Record<string, string> = {}): Promise<Sess> {
  const res = await app.handle(new Request('http://localhost/api/session', { headers }))
  const body = await res.json()
  const sid = sidFrom(res)
  const cookie = sid ? `fc_sid=${sid}` : (headers.cookie ?? '')
  return { cookie, csrf: body.csrf, body }
}

/** Log in; returns the post-login cookie + csrf. Requires an anon session first for the CSRF token. */
export async function login(app: App, username: string, password: string, extraHeaders: Record<string, string> = {}): Promise<Sess & { status: number }> {
  const anon = await getSession(app, extraHeaders)
  const res = await app.handle(new Request('http://localhost/api/login', {
    method: 'POST',
    headers: { cookie: anon.cookie, 'x-csrf-token': anon.csrf, 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ username, password }),
  }))
  const status = res.status
  let body: any = null
  try { body = await res.json() } catch { /* non-json */ }
  const sid = sidFrom(res)
  const cookie = sid ? `fc_sid=${sid}` : anon.cookie
  return { cookie, csrf: body?.csrf, body, status }
}

export async function post(app: App, path: string, s: { cookie: string; csrf: string }, body: any, extraHeaders: Record<string, string> = {}) {
  return app.handle(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  }))
}

export async function get(app: App, path: string, s: { cookie: string }, extraHeaders: Record<string, string> = {}) {
  return app.handle(new Request(`http://localhost${path}`, { headers: { cookie: s.cookie, ...extraHeaders } }))
}

/** Create a normal user via the admin API. */
export async function createUser(app: App, admin: Sess, opts: {
  username: string; password: string; name?: string; homedir?: string;
  permissions: string[]; publicPermissions: string[];
}) {
  const res = await post(app, '/api/admin/users', admin, {
    username: opts.username,
    name: opts.name ?? opts.username,
    password: opts.password,
    role: 'user',
    homedir: opts.homedir ?? `/users/${opts.username}`,
    permissions: opts.permissions,
    publicPermissions: opts.publicPermissions,
  })
  if (res.status !== 200) throw new Error(`createUser failed: ${res.status} ${await res.text()}`)
  return res
}

export function pass(msg: string): never { console.log('SAFE:', msg); process.exit(0) }
export function confirmed(msg: string): never { console.log('CONFIRMED:', msg); process.exit(42) }
export function inconclusive(msg: string): never { console.log('INCONCLUSIVE:', msg); process.exit(1) }
