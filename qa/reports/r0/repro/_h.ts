import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// env must be set before ./src/index (and so config) is imported
export const STORAGE = mkdtempSync(join(tmpdir(), 'fcr-storage-'))
export const DATA = mkdtempSync(join(tmpdir(), 'fcr-data-'))
process.env.STORAGE_DIR = STORAGE
process.env.DATA_DIR = DATA
process.env.ADMIN_PASSWORD = 'AdminPass-12345'
process.env.MIN_FREE_SPACE = '0'
process.env.FC_SUPERVISED = '1'
process.env.WEB_UPDATE = 'true'
export const ADMIN_PW = 'AdminPass-12345'

const { app } = await import('../../src/index')
export { app }

export type Sess = { cookie: string; csrf: string }

export async function call(method: string, path: string, s?: Sess | null, body?: unknown, opts: { csrf?: string | null; raw?: Uint8Array } = {}) {
  const headers: Record<string, string> = {}
  if (s?.cookie) headers.cookie = s.cookie
  const token = opts.csrf === undefined ? s?.csrf : opts.csrf
  if (token) headers['x-csrf-token'] = token
  let b: any
  if (opts.raw) b = opts.raw
  else if (body !== undefined) { headers['content-type'] = 'application/json'; b = JSON.stringify(body) }
  const res = await app.handle(new Request('http://localhost' + path, { method, headers, body: b }))
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, text, json, res }
}

const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]

export async function anon(): Promise<Sess> {
  const r = await app.handle(new Request('http://localhost/api/session'))
  const j: any = await r.json()
  return { cookie: cookieOf(r), csrf: j.csrf }
}

export async function login(username: string, password: string): Promise<Sess> {
  const a = await anon()
  const res = await app.handle(new Request('http://localhost/api/login', {
    method: 'POST',
    headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }))
  if (res.status !== 200) throw new Error('login failed for ' + username + ': ' + res.status)
  const j: any = await res.json()
  return { cookie: cookieOf(res), csrf: j.csrf }
}

export async function makeUser(admin: Sess, username: string, perms = ['read', 'write', 'upload', 'download']) {
  const r = await call('POST', '/api/admin/users', admin, {
    username, name: username, password: 'UserPass-12345', role: 'user', permissions: perms, publicPermissions: [],
  })
  if (r.status !== 200) throw new Error('create user failed ' + r.status + r.text)
}

// exit codes: 42 = problem present, 0 = safe behaviour, 3 = repro setup broke
export const VULN = 42
export function run(fn: () => Promise<boolean>) {
  fn().then(v => process.exit(v ? VULN : 0), e => { console.error('SETUP ERROR', e); process.exit(3) })
}
