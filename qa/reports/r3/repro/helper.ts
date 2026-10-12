// shared setup: fresh dirs, env, app import, session/login/user helpers
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const ADMIN_PW = 'Adm1n!Strong#Pw-2026'
export async function setup(extraEnv: Record<string, string> = {}) {
  const base = mkdtempSync(join(tmpdir(), 'fc-repro-'))
  process.env.STORAGE_DIR = join(base, 'storage')
  process.env.DATA_DIR = join(base, 'data')
  process.env.ADMIN_PASSWORD = ADMIN_PW
  for (const [k, v] of Object.entries(extraEnv)) process.env[k] = v
  const { app } = await import('../../src/index')
  return { app, base, storage: process.env.STORAGE_DIR!, data: process.env.DATA_DIR! }
}

export type Sess = { cookie: string; csrf: string }
const sidFrom = (r: Response, prev = '') => {
  const sc = r.headers.getSetCookie?.() ?? []
  for (const c of sc) { const m = /fc_sid=([^;]*)/.exec(c); if (m) return `fc_sid=${m[1]}` }
  return prev
}

export function client(app: any) {
  const req = (method: string, path: string, s?: Sess, body?: unknown, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { ...extra }
    if (s?.cookie) headers.cookie = s.cookie
    if (s?.csrf && !('x-csrf-token' in extra)) headers['x-csrf-token'] = s.csrf
    if (body !== undefined) headers['content-type'] = 'application/json'
    return app.handle(new Request('http://localhost' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })) as Promise<Response>
  }
  const session = async (): Promise<Sess> => {
    const r = await req('GET', '/api/session')
    const j: any = await r.json()
    return { cookie: sidFrom(r), csrf: j.csrf }
  }
  const login = async (username: string, password: string): Promise<Sess> => {
    const s = await session()
    const r = await req('POST', '/api/login', s, { username, password })
    if (r.status !== 200) throw new Error(`login ${username} failed ${r.status} ${await r.text()}`)
    const j: any = await r.json()
    return { cookie: sidFrom(r, s.cookie), csrf: j.csrf }
  }
  const createUser = async (admin: Sess, username: string, password: string, permissions: string[], publicPermissions: string[]) => {
    const r = await req('POST', '/api/admin/users', admin, { username, name: username, password, role: 'user', permissions, publicPermissions })
    if (r.status !== 200) throw new Error(`create user failed ${r.status} ${await r.text()}`)
  }
  return { req, session, login, createUser }
}

export const done = (vuln: boolean, msg: string) => { console.log((vuln ? 'VULNERABLE: ' : 'SAFE: ') + msg); process.exit(vuln ? 42 : 0) }
