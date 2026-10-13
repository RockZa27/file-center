import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const PW = 'Zebra-Quartz-4471!x'
const UPW = 'Walnut-Prism-9183!q'
export async function setup() {
  const base = mkdtempSync(join(tmpdir(), 'fcr-'))
  const storage = join(base, 'storage'), data = join(base, 'data')
  mkdirSync(storage, { recursive: true }); mkdirSync(data, { recursive: true })
  process.env.STORAGE_DIR = storage
  process.env.DATA_DIR = data
  process.env.ADMIN_PASSWORD = PW
  const { app } = await import('../../src/index')
  const call = async (s: { cookie: string; csrf: string }, method: string, path: string, body?: any) => {
    const r = await app.handle(new Request('http://localhost' + path, {
      method, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }))
    const text = await r.text()
    let json: any = null; try { json = JSON.parse(text) } catch {}
    return { status: r.status, json, text }
  }
  const cookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0]
  const login = async (username: string, password = PW) => {
    const r0 = await app.handle(new Request('http://localhost/api/session'))
    const j0: any = await r0.json()
    const c0 = cookieOf(r0)
    const r = await app.handle(new Request('http://localhost/api/login', {
      method: 'POST', headers: { cookie: c0, 'x-csrf-token': j0.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }))
    const j: any = await r.json()
    if (r.status !== 200) throw new Error('login failed ' + r.status + JSON.stringify(j))
    return { cookie: cookieOf(r) || c0, csrf: j.csrf ?? j0.csrf }
  }
  const si = await import('../../src/search-index'); si.startSearchIndex()
  const admin = await login('admin')
  const mkUser = async (username: string, permissions: string[], publicPermissions: string[], extra: any = {}) => {
    const r = await call(admin, 'POST', '/api/admin/users', { username, name: username, password: UPW, role: 'user', permissions, publicPermissions, ...extra })
    if (r.status !== 200) throw new Error('mkUser ' + JSON.stringify(r))
    return login(username, UPW)
  }
  const waitIndexed = async (s: any) => {
    for (let i = 0; i < 100; i++) {
      const r = await call(s, 'GET', '/api/search?space=home&q=zzzz')
      if (r.json?.indexed === true) return
      await Bun.sleep(100)
    }
    throw new Error('index never ready')
  }
  return { app, call, login, admin, mkUser, storage, data, waitIndexed, base }
}
export function put(path: string, content = 'x') { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content) }
