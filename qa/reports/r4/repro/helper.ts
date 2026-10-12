import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const base = mkdtempSync(join(tmpdir(), 'fc-r4-verify-'))
process.on('exit', () => { try { rmSync(base, { recursive: true, force: true }) } catch {} })
process.env.STORAGE_DIR = join(base, 'storage')
process.env.DATA_DIR = join(base, 'data')
process.env.BACKUP_DIR = join(base, 'backups')
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Adm1n-Repro-Pass-2026!'
export const ADMIN_PW = process.env.ADMIN_PASSWORD

export async function boot() {
  const mod = await import('../../src/index')
  const auth = await import('../../src/auth')
  await auth.bootstrapAdmin()
  const { config, paths } = await import('../../src/config')
  return { app: mod.app, config, paths }
}

export type Sess = { cookie: string; csrf: string }

function cookieOf(res: Response, prev = ''): string {
  const sc = res.headers.get('set-cookie')
  const m = sc?.match(/fc_sid=([^;]*)/)
  return m ? `fc_sid=${m[1]}` : prev
}

export async function req(app: any, s: Sess | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (s) { headers.cookie = s.cookie; headers['x-csrf-token'] = s.csrf }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res: Response = await app.handle(new Request('http://localhost' + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }))
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch {}
  if (s) s.cookie = cookieOf(res, s.cookie)
  return { status: res.status, json, text }
}

export async function guest(app: any): Promise<Sess> {
  const res: Response = await app.handle(new Request('http://localhost/api/session'))
  const j: any = await res.json()
  return { cookie: cookieOf(res), csrf: j.csrf }
}

export async function login(app: any, username: string, password: string): Promise<Sess> {
  const s = await guest(app)
  const r = await req(app, s, 'POST', '/api/login', { username, password })
  if (r.status !== 200) throw new Error(`login ${username} failed: ${r.status} ${r.text}`)
  s.csrf = r.json.csrf
  return s
}

export async function makeUser(app: any, admin: Sess, username: string, permissions: string[], publicPermissions: string[]) {
  const password = 'Us3r-Repro-Pass-2026!xq'
  const r = await req(app, admin, 'POST', '/api/admin/users', {
    username, name: username, password, role: 'user', permissions, publicPermissions,
  })
  if (r.status !== 200) throw new Error(`create user failed: ${r.status} ${r.text}`)
  return login(app, username, password)
}

export function finish(vulnerable: boolean, msg: string): never {
  console.log((vulnerable ? 'VULNERABLE: ' : 'SAFE: ') + msg)
  process.exit(vulnerable ? 42 : 0)
}
