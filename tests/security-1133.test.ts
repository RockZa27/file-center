/**
 * The fixes of 1.13.3 (security audit run 3). Runs in-process on the same app as api.test.ts; every user here starts
 * with "s133-".
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import './in-process-env'

let app: any

class Client {
  jar = new Map<string, string>()
  csrf = ''
  async raw(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers }
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    if (cookie) h.cookie = cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    let payload: any = body
    if (body !== undefined && !(body instanceof Uint8Array) && typeof body !== 'string') {
      payload = JSON.stringify(body)
      h['content-type'] = 'application/json'
    }
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: payload }))
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';')
      const at = pair.indexOf('=')
      this.jar.set(pair.slice(0, at), pair.slice(at + 1))
    }
    return res
  }
  async json(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const res = await this.raw(method, path, body, headers)
    return { status: res.status, data: (await res.json().catch(() => null)) as any }
  }
  async login(username: string, password: string) {
    this.csrf = (await this.json('GET', '/api/session')).data.csrf
    const r = await this.json('POST', '/api/login', { username, password })
    expect(r.status).toBe(200)
    this.csrf = r.data.csrf
    return this
  }
}

const PW = 'harbor-lamp-42'
const admin = new Client()
const home = (user: string, ...p: string[]) => join(process.env.STORAGE_DIR!, 'users', user, ...p)

async function userWith(username: string, permissions: string[]) {
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', permissions, publicPermissions: [] })
  expect(r.status).toBe(200)
  return new Client().login(username, PW)
}

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
})

describe('PROPPATCH answer size (audit run 3)', () => {
  const proppatch = (username: string, secret: string, path: string, body: string) =>
    app.handle(new Request('http://localhost' + path, {
      method: 'PROPPATCH',
      headers: { authorization: 'Basic ' + Buffer.from(`${username}:${secret}`).toString('base64'), 'content-type': 'application/xml' },
      body,
    })) as Promise<Response>
  // one namespace declared once on <prop>, n properties in it: each refused property is written back with the namespace
  const update = (n: number, nsLen: number) =>
    `<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop xmlns:q="u:${'a'.repeat(nsLen)}">` +
    Array.from({ length: n }, (_, i) => `<q:p${i}/>`).join('') + '</D:prop></D:set></D:propertyupdate>'

  test('a long namespace or too many properties is refused before any answer is built', async () => {
    const u = await userWith('s133-dav1', ['read', 'write', 'upload'])
    const secret = (await u.json('POST', '/api/me/app-passwords', { name: 'laptop', scope: 'readwrite', password: PW })).data.secret as string
    writeFileSync(home('s133-dav1', 'a.txt'), 'x')
    // what clients send (a few properties, short namespaces) still works
    const fine = await proppatch('s133-dav1', secret, '/dav/home/a.txt', update(4, 40))
    expect(fine.status).toBe(207)
    expect(await fine.text()).toContain('403 Forbidden')
    // the amplifying request of the audit: about 39 KB in, 33 MB out before the fix
    const long = await proppatch('s133-dav1', secret, '/dav/home/a.txt', update(1200, 28000))
    expect(long.status).toBe(400)
    const longNs = await proppatch('s133-dav1', secret, '/dav/home/a.txt', update(30, 300))
    expect(longNs.status).toBe(400)
    expect(longNs.headers.get('x-error-code')).toBe('files.dav-ns-too-long')
    const many = await proppatch('s133-dav1', secret, '/dav/home/a.txt', update(51, 10))
    expect(many.status).toBe(400)
    expect(many.headers.get('x-error-code')).toBe('files.dav-too-many-props')
    // the properties are counted across every set and remove, not per element
    const split = '<D:propertyupdate xmlns:D="DAV:">' +
      Array.from({ length: 3 }, () => `<D:remove><D:prop xmlns:q="u:x">${Array.from({ length: 20 }, (_, i) => `<q:p${i}/>`).join('')}</D:prop></D:remove>`).join('') +
      '</D:propertyupdate>'
    expect((await proppatch('s133-dav1', secret, '/dav/home/a.txt', split)).status).toBe(400)
  })
})
