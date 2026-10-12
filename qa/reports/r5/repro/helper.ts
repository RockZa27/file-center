// shared repro helper: fresh dirs, env, app import, login, user creation
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const base = mkdtempSync(join(tmpdir(), 'fc-repro-'))
export const ADMIN_PW = 'Adm1n-Repro-Pass!x'
process.env.STORAGE_DIR = join(base, 'storage')
process.env.DATA_DIR = join(base, 'data')
process.env.BACKUP_DIR ??= join(base, 'backups')
process.env.ADMIN_PASSWORD = ADMIN_PW
process.env.BACKUP_HOUR = 'off'

export const { app } = await import('../../src/index')

export type Sess = { cookie: string; csrf: string }

function cookieOf(res: Response, prev = ''): string {
  const jar = new Map<string, string>()
  for (const p of prev.split(';').map(s => s.trim()).filter(Boolean)) {
    const i = p.indexOf('='); jar.set(p.slice(0, i), p.slice(i + 1))
  }
  for (const sc of res.headers.getSetCookie()) {
    const kv = sc.split(';')[0]; const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1))
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
}

export async function call(method: string, path: string, s?: Sess | null, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra }
  if (s) { headers.cookie = s.cookie; headers['x-csrf-token'] = s.csrf }
  let b: BodyInit | undefined
  if (body instanceof Uint8Array || typeof body === 'string') b = body as any
  else if (body !== undefined) { b = JSON.stringify(body); headers['content-type'] = 'application/json' }
  const res = await app.handle(new Request(`http://localhost${path}`, { method, headers, body: b }))
  return res
}

export async function json(res: Response): Promise<any> {
  const t = await res.text()
  try { return JSON.parse(t) } catch { return t }
}

export async function login(username: string, password: string): Promise<Sess> {
  const r1 = await app.handle(new Request('http://localhost/api/session'))
  const s1 = await r1.json() as any
  const c1 = cookieOf(r1)
  const r2 = await app.handle(new Request('http://localhost/api/login', {
    method: 'POST', headers: { cookie: c1, 'x-csrf-token': s1.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }))
  if (r2.status !== 200) throw new Error(`login ${username} failed ${r2.status} ${await r2.text()}`)
  const s2 = await r2.json() as any
  return { cookie: cookieOf(r2, c1), csrf: s2.csrf }
}

export const adminLogin = () => login('admin', ADMIN_PW)

export async function makeUser(admin: Sess, username: string, perms: string[] = ['read', 'write', 'upload', 'download', 'batchdownload', 'zip', 'share'], publicPerms: string[] = []) {
  const password = "Zq7-Repro-Long#Pw-4471"
  const r = await call('POST', '/api/admin/users', admin, { username, name: username, password, role: 'user', permissions: perms, publicPermissions: publicPerms })
  if (r.status !== 200) throw new Error(`create ${username} failed ${r.status} ${await r.text()}`)
  return { username, password, sess: await login(username, password) }
}

export function done(vulnerable: boolean, msg: string): never {
  console.log((vulnerable ? 'VULNERABLE: ' : 'SAFE: ') + msg)
  process.exit(vulnerable ? 42 : 0)
}

/** make a file in the caller's home through the API */
export async function putFile(s: Sess, dir: string, name: string, content: string) {
  const r1 = await call('POST', '/api/newfile', s, { space: 'home', path: dir, name })
  if (r1.status !== 200) throw new Error(`newfile ${r1.status} ${await r1.text()}`)
  const r2 = await call('PUT', '/api/content', s, { space: 'home', path: `${dir === '/' ? '' : dir}/${name}`, content })
  if (r2.status !== 200) throw new Error(`content ${r2.status} ${await r2.text()}`)
}

export async function share(s: Sess, path: string, extra: Record<string, unknown> = {}) {
  const r = await call('POST', '/api/shares', s, { space: 'home', path, days: 7, ...extra })
  if (r.status !== 200) throw new Error(`share ${r.status} ${await r.text()}`)
  return (await r.json() as any).token as string
}
