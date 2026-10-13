import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function setupEnv(tag: string) {
  const base = mkdtempSync(join(tmpdir(), `fc-${tag}-`))
  process.env.STORAGE_DIR = join(base, 'storage')
  process.env.DATA_DIR = join(base, 'data')
  process.env.ADMIN_PASSWORD = 'AdminPass123!XYZ'
  process.env.LOG_MAX_BYTES = '1000000'
  return base
}

export async function session() {
  const { app } = await import('../../src/index')
  const res = await app.handle(new Request('http://localhost/api/session'))
  const setCookie = res.headers.get('set-cookie') ?? ''
  const cookie = setCookie.split(';')[0]
  const j: any = await res.json()
  return { app, cookie, csrf: j.csrf as string }
}

export async function loginAdmin(app: any, cookie: string, csrf: string) {
  const res = await app.handle(new Request('http://localhost/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
    body: JSON.stringify({ username: 'admin', password: process.env.ADMIN_PASSWORD }),
  }))
  const setCookie = res.headers.get('set-cookie') ?? ''
  const newCookie = setCookie ? setCookie.split(';')[0] : cookie
  const j: any = await res.json()
  return { cookie: newCookie, csrf: j.csrf as string, body: j }
}

export async function createUser(app: any, adminCookie: string, adminCsrf: string, username: string, password: string, extra: any = {}) {
  const res = await app.handle(new Request('http://localhost/api/admin/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie, 'x-csrf-token': adminCsrf },
    body: JSON.stringify({ username, password, role: 'user', name: username, permissions: [], publicPermissions: [], ...extra }),
  }))
  if (res.status >= 300) throw new Error(`createUser failed: ${res.status} ${await res.text()}`)
  return res.json()
}
