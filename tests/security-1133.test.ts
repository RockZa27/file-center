/**
 * The fixes of 1.13.3 (security audit run 3). Runs in-process on the same app as api.test.ts; every user here starts
 * with "s133-".
 */
import { beforeAll, describe, expect, setSystemTime, test } from 'bun:test'
import { join } from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import './in-process-env'

let app: any
let config: typeof import('../src/config').config
let settings: typeof import('../src/settings').settings
let uploads: typeof import('../src/uploads')

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
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', permissions, publicPermissions: [], adoptHome: true })
  expect(r.status).toBe(200)
  return new Client().login(username, PW)
}

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config } = await import('../src/config'))
  ;({ settings } = await import('../src/settings'))
  uploads = await import('../src/uploads')
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

describe('a cancel while the upload is completing (audit run 3)', () => {
  test('completion claims the upload: the cancel is refused, the file lands and stays counted in the visitors\' allowance', async () => {
    const was = { perms: [...settings.get().guestPermissions], limit: config.guestUploadDailyBytes, proxy: config.trustProxy }
    settings.update({ guestPermissions: ['read', 'download', 'upload'] as any })
    ;(config as any).guestUploadDailyBytes = uploads.guestUploadUsage().used + 64 * 1024 ** 2
    ;(config as any).trustProxy = 'true'
    // on a day of its own: the file that lands stays counted (that is the point), and the tests that start from an
    // empty allowance today must not find it there
    setSystemTime(Date.now() + 3 * 86_400_000)
    const ip = { 'x-forwarded-for': '198.51.100.33' }
    const v = new Client()
    v.csrf = (await v.json('GET', '/api/session')).data.csrf
    const SIZE = 4096
    try {
      const a = await v.json('POST', '/api/upload', { space: 'public', path: '/', name: 's133-race.bin', size: SIZE }, ip)
      expect(a.status).toBe(200)
      const id = a.data.id as string
      expect((await v.raw('PUT', `/api/upload/${id}/0`, new Uint8Array(SIZE), { 'content-type': 'application/octet-stream', ...ip })).status).toBe(200)
      const counted = uploads.guestUploadUsage().used
      // complete starts and, before it has moved the file, the same visitor cancels
      const done = uploads.completeUpload(id, 'guest')
      let refused: any = null
      try { uploads.cancelUpload(id, 'guest') } catch (err) { refused = err }
      expect(refused?.status).toBe(409)
      expect(refused?.code).toBe('upload.completing')
      const landed = await done
      expect(existsSync(landed.path)).toBe(true)
      // the bytes that landed are still counted: the cancel gave nothing back
      expect(uploads.guestUploadUsage().used).toBe(counted)
      // once complete, a cancel finds nothing to give back
      expect(() => uploads.cancelUpload(id, 'guest')).toThrow()
      expect(uploads.guestUploadUsage().used).toBe(counted)
    } finally {
      setSystemTime()
      settings.update({ guestPermissions: was.perms as any })
      ;(config as any).guestUploadDailyBytes = was.limit
      ;(config as any).trustProxy = was.proxy
    }
  })
})

describe('an account named like an Object method (audit run 3, hardening)', () => {
  test('"constructor" and "toString" keep favorites and recent files like anyone else', async () => {
    for (const name of ['constructor', 'toString']) {
      const u = await userWith(name, ['read', 'write', 'upload', 'download'])
      writeFileSync(home(name, 'a.txt'), 'x')
      expect((await u.raw('GET', '/api/download?space=home&path=/a.txt')).status).toBe(200)
      expect((await u.json('POST', '/api/me/favorites', { space: 'home', path: '/a.txt' })).status).toBe(200)
      expect((await u.json('GET', '/api/me/favorites')).data.items.map((i: any) => i.name)).toEqual(['a.txt'])
      expect((await u.json('DELETE', '/api/me/favorites', { space: 'home', path: '/a.txt' })).status).toBe(200)
      expect((await u.json('GET', '/api/me/favorites')).data.items).toEqual([])
    }
  })
})

describe('office link tokens and a later account of the same name (audit run 3)', () => {
  test('a token of a deleted account does not open the file of the account that took the name; the own account still does', async () => {
    const office = await import('../src/office')
    const { findUser } = await import('../src/auth')
    const u = await userWith('s133-off', ['read', 'write', 'download'])
    writeFileSync(home('s133-off', 'r.docx'), 'FIRST')
    const first = findUser('s133-off')!
    const f = (await import('../src/fsx')).storagePath(home('s133-off', 'r.docx'))
    const withC = office.makeToken({ s: 'home', p: '/r.docx', f, u: first.username, c: first.createdAt, m: 'view' })
    // a token made by 1.13.2 has no c
    const old = office.makeToken({ s: 'home', p: '/r.docx', f, u: first.username, m: 'view' })
    expect(office.tokenFile(office.readToken(withC), ['read']).abs).toBe(home('s133-off', 'r.docx'))
    expect(office.tokenFile(office.readToken(old), ['read']).abs).toBe(home('s133-off', 'r.docx'))
    void u
    expect((await admin.json('DELETE', '/api/admin/users/s133-off')).status).toBe(200)
    await Bun.sleep(5)
    await userWith('s133-off', ['read', 'write', 'download'])
    writeFileSync(home('s133-off', 'r.docx'), 'SECOND-OWNER')
    expect(() => office.tokenFile(office.readToken(withC), ['read'])).toThrow()
    expect(() => office.tokenFile(office.readToken(old), ['read'])).toThrow()
    // a token made for the new account works
    const second = findUser('s133-off')!
    const mine = office.makeToken({ s: 'home', p: '/r.docx', f, u: second.username, c: second.createdAt, m: 'view' })
    expect(office.tokenFile(office.readToken(mine), ['read']).abs).toBe(home('s133-off', 'r.docx'))
  })
})

describe('unfinished uploads of a deleted account (audit run 3)', () => {
  test('a later account of the name is not charged for them and can not reach them', async () => {
    const make = () => admin.json('POST', '/api/admin/users', { username: 's133-upd', name: 's133-upd', password: PW, role: 'user', permissions: ['read', 'write', 'upload'], publicPermissions: [], quotaBytes: 1_000_000 })
    expect((await make()).status).toBe(200)
    const first = await new Client().login('s133-upd', PW)
    const old = await first.json('POST', '/api/upload', { space: 'home', path: '/', name: 'big.bin', size: 900_000 })
    expect(old.status).toBe(200)
    expect((await admin.json('DELETE', '/api/admin/users/s133-upd')).status).toBe(200)
    expect((await make()).status).toBe(200)
    const second = await new Client().login('s133-upd', PW)
    // the dead account's 900 KB hold is gone: the new account has its whole quota
    const mine = await second.json('POST', '/api/upload', { space: 'home', path: '/', name: 'new.bin', size: 500_000 })
    expect(mine.status).toBe(200)
    expect((await second.json('GET', `/api/upload/${old.data.id}`)).status).toBe(404)
    expect((await second.json('DELETE', `/api/upload/${mine.data.id}`)).status).toBe(200)
  })
})
