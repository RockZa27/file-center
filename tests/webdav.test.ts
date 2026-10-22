/**
 * WebDAV (/dav, src/webdav.ts) and the app passwords it signs in with (src/app-passwords.ts). Most tests run in-process
 * on the same app as api.test.ts (see in-process-env.ts); the ones about streaming and about the size limits start a real
 * server, because Bun's own limit and the way a body arrives exist only there. Every user here starts with "dv".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './in-process-env'
import { parseXml, type XNode } from '../src/webdav-xml'

let app: any
let config: typeof import('../src/config').config
let paths: typeof import('../src/config').paths
let auth: typeof import('../src/auth')
let pw: typeof import('../src/app-passwords')
let dav: typeof import('../src/webdav')
let versions: typeof import('../src/versions')
let trash: typeof import('../src/trash')
let auditMod: typeof import('../src/audit')
let grantsMod: typeof import('../src/grants')

class Web {
  cookie = ''
  csrf = ''
  async raw(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers }
    if (this.cookie) h.cookie = this.cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    let payload: any = body
    if (body !== undefined && !(body instanceof Uint8Array)) {
      payload = JSON.stringify(body)
      h['content-type'] = 'application/json'
    }
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: payload }))
    const set = res.headers.get('set-cookie')
    if (set?.startsWith('fc_sid=')) this.cookie = set.split(';')[0]
    return res
  }
  async json(method: string, path: string, body?: any) {
    const res = await this.raw(method, path, body)
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
const PERMS = ['read', 'write', 'upload', 'download', 'zip', 'share', 'batchdownload']
const MB = 1024 * 1024
const admin = new Web()
const home = (user: string, ...p: string[]) => join(process.env.STORAGE_DIR!, 'users', user, ...p)
const basic = (u: string, s: string) => `Basic ${Buffer.from(`${u}:${s}`).toString('base64')}`
const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/')

type Init = { body?: BodyInit | null; headers?: Record<string, string> }

/** a hand-written WebDAV client: Basic auth with an app password, every call one request */
class Dav {
  constructor(public username: string, public secret: string) {}
  async req(method: string, path: string, init: Init = {}): Promise<Response> {
    return app.handle(new Request('http://localhost' + path, {
      method, headers: { authorization: basic(this.username, this.secret), ...init.headers }, body: init.body,
    }))
  }
  async status(method: string, path: string, init: Init = {}) {
    return (await this.req(method, path, init)).status
  }
  async propfind(path: string, depth: string | null = '1', body?: string) {
    const res = await this.req('PROPFIND', path, { headers: depth === null ? {} : { depth }, body })
    const text = await res.text()
    return { status: res.status, text, res }
  }
  /** the hrefs of a multistatus, decoded */
  async hrefs(path: string, depth = '1') {
    const r = await this.propfind(path, depth)
    expect(r.status).toBe(207)
    return responsesOf(parseXml(r.text)).map(x => decodeURIComponent(x.href))
  }
  put(path: string, content: string | Uint8Array, headers: Record<string, string> = {}) {
    return this.req('PUT', path, { body: content, headers })
  }
  async get(path: string, headers: Record<string, string> = {}) {
    const res = await this.req('GET', path, { headers })
    return { status: res.status, text: await res.text(), res }
  }
}

function responsesOf(doc: XNode) {
  return doc.children.filter(c => c.name === 'response').map(r => {
    const href = r.children.find(c => c.name === 'href')!.text
    const props: Record<string, { status: string; value: XNode }> = {}
    for (const ps of r.children.filter(c => c.name === 'propstat')) {
      const status = ps.children.find(c => c.name === 'status')!.text
      for (const p of ps.children.find(c => c.name === 'prop')!.children) props[p.name] = { status, value: p }
    }
    return { href, props }
  })
}

async function userWith(username: string, extra: Record<string, unknown> = {}) {
  const r = await admin.json('POST', '/api/admin/users', { username, name: `Name of ${username}`, password: PW, role: 'user', permissions: PERMS, publicPermissions: [], ...extra })
  expect(r.status).toBe(200)
  return new Web().login(username, PW)
}

/** a user with an app password of the given scope; the folder of the user exists */
async function davUser(username: string, scope: 'read' | 'readwrite' = 'readwrite', extra: Record<string, unknown> = {}) {
  const web = await userWith(username, extra)
  mkdirSync(home(username), { recursive: true })
  const made = await web.json('POST', '/api/me/app-passwords', { name: 'test', scope, password: PW })
  expect(made.status).toBe(200)
  return { web, dav: new Dav(username, made.data.secret as string), id: made.data.id as string, username }
}

let savedAddressMax = 0

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config, paths } = await import('../src/config'))
  auth = await import('../src/auth')
  pw = await import('../src/app-passwords')
  dav = await import('../src/webdav')
  versions = await import('../src/versions')
  trash = await import('../src/trash')
  auditMod = await import('../src/audit')
  grantsMod = await import('../src/grants')
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
  // every wrong password in these tests comes from one address ('unknown' in process): the wide net must not trip
  savedAddressMax = config.loginAddressMaxAttempts
  config.loginAddressMaxAttempts = 1000
})

// the files after this one see the limit they expect
afterAll(() => { config.loginAddressMaxAttempts = savedAddressMax })

// ───────────────────────────── app passwords ─────────────────────────────

describe('app passwords: the routes', () => {
  test('the secret is shown once, the list has no secret and no hash, and a password is needed to make one', async () => {
    const web = await userWith('dv-pw1')
    expect((await web.json('GET', '/api/me/app-passwords')).data).toEqual({ items: [], max: 20, enabled: true })
    // the page learns from the session whether to show this; visitors are not told
    expect((await web.json('GET', '/api/session')).data.config.webdav).toBe(true)
    expect((await new Web().json('GET', '/api/session')).data.config.webdav).toBeUndefined()
    const wrong = await web.json('POST', '/api/me/app-passwords', { name: 'laptop', scope: 'read', password: 'not-my-password' })
    expect(wrong.status).toBe(403)
    expect(wrong.data.code).toBe('auth.wrong-password')

    const made = await web.json('POST', '/api/me/app-passwords', { name: '  laptop  ', scope: 'readwrite', password: PW })
    expect(made.status).toBe(200)
    expect(made.data.secret).toMatch(/^fc-[A-Za-z0-9]{32}$/)
    expect(made.data).toMatchObject({ name: 'laptop', scope: 'readwrite', lastUsedAt: null, lastIp: null })
    expect(made.data.hint).toBe(made.data.secret.slice(0, 11))

    const list = await web.json('GET', '/api/me/app-passwords')
    expect(list.data.items).toHaveLength(1)
    expect(Object.keys(list.data.items[0]).sort()).toEqual(['createdAt', 'hint', 'id', 'lastIp', 'lastUsedAt', 'name', 'scope'])
    expect(JSON.stringify(list.data)).not.toContain(made.data.secret)
    // on disk only a hash
    const stored = readFileSync(paths.appPasswords, 'utf8')
    expect(stored).not.toContain(made.data.secret)
    expect(stored).toContain('$argon2id$')
    // two are different
    const second = await web.json('POST', '/api/me/app-passwords', { name: 'phone', scope: 'read', password: PW })
    expect(second.data.secret).not.toBe(made.data.secret)
  })

  test('name and scope are checked, a visitor has none, others can not see or delete mine, the limit is 20', { timeout: 30_000 }, async () => {
    const web = await userWith('dv-pw2')
    const other = await userWith('dv-pw3')
    for (const name of ['', '   ', 'x'.repeat(61)]) {
      const r = await web.json('POST', '/api/me/app-passwords', { name, scope: 'read', password: PW })
      expect(`${r.status} ${r.data.code}`).toBe('400 auth.app-password-bad-name')
    }
    const badScope = await web.json('POST', '/api/me/app-passwords', { name: 'a', scope: 'admin', password: PW })
    expect(`${badScope.status} ${badScope.data.code}`).toBe('400 auth.app-password-bad-scope')
    const visitor = new Web()
    visitor.csrf = (await visitor.json('GET', '/api/session')).data.csrf
    expect((await visitor.json('GET', '/api/me/app-passwords')).status).toBe(401)

    const mine = (await web.json('POST', '/api/me/app-passwords', { name: 'mine', scope: 'read', password: PW })).data
    expect((await other.json('DELETE', `/api/me/app-passwords/${mine.id}`)).status).toBe(404)
    expect((await other.json('GET', '/api/me/app-passwords')).data.items).toEqual([])
    // an administrator sees no one's list, and the routes have no way to read a secret
    expect((await admin.json('GET', '/api/me/app-passwords')).data.items).toEqual([])

    for (let i = 1; i < 20; i++) expect((await web.json('POST', '/api/me/app-passwords', { name: `n${i}`, scope: 'read', password: PW })).status).toBe(200)
    const over = await web.json('POST', '/api/me/app-passwords', { name: 'one too many', scope: 'read', password: PW })
    expect(`${over.status} ${over.data.code}`).toBe('400 auth.app-password-limit')
    expect((await web.json('GET', '/api/me/app-passwords')).data.items).toHaveLength(20)
    expect((await web.json('DELETE', `/api/me/app-passwords/${mine.id}`)).status).toBe(200)
    expect((await web.json('DELETE', `/api/me/app-passwords/${mine.id}`)).status).toBe(404)
    expect((await web.json('POST', '/api/me/app-passwords', { name: 'room again', scope: 'read', password: PW })).status).toBe(200)
  })

  test('creating and deleting are in the audit trail, without the secret', async () => {
    const u = await davUser('dv-audit')
    expect((await u.web.json('DELETE', `/api/me/app-passwords/${u.id}`)).status).toBe(200)
    const mine = Array.from(auditMod.auditEntries()).filter(e => e.user === 'dv-audit')
    expect(mine.map(e => e.action)).toContain('app-password-create')
    expect(mine.map(e => e.action)).toContain('app-password-delete')
    expect(JSON.stringify(mine)).not.toContain(u.dav.secret)
  })

  test('changing the password, an admin resetting it and deleting the account end every app password of the user', async () => {
    const a = await davUser('dv-gone1')
    expect(await a.dav.status('OPTIONS', '/dav/')).toBe(200)
    expect((await a.web.json('POST', '/api/password', { current: PW, next: 'a-new-harbor-lamp-77' })).status).toBe(200)
    expect(await a.dav.status('OPTIONS', '/dav/')).toBe(401)
    expect(pw.appPasswordsOf('dv-gone1')).toHaveLength(0)

    const b = await davUser('dv-gone2')
    expect(await b.dav.status('OPTIONS', '/dav/')).toBe(200)
    expect((await admin.json('PUT', '/api/admin/users/dv-gone2', { password: 'reset-by-admin-4242' })).status).toBe(200)
    expect(await b.dav.status('OPTIONS', '/dav/')).toBe(401)
    expect(pw.appPasswordsOf('dv-gone2')).toHaveLength(0)

    const c = await davUser('dv-gone3')
    expect(await c.dav.status('OPTIONS', '/dav/')).toBe(200)
    expect((await admin.json('DELETE', '/api/admin/users/dv-gone3')).status).toBe(200)
    expect(await c.dav.status('OPTIONS', '/dav/')).toBe(401)
    expect(pw.appPasswordsOf('dv-gone3')).toHaveLength(0)
    // a new account of the same name does not get the old one's passwords back
    await userWith('dv-gone3')
    expect(await c.dav.status('OPTIONS', '/dav/')).toBe(401)
  })
})

// ───────────────────────────── signing in ─────────────────────────────

describe('webdav: signing in', () => {
  test('no credentials, wrong ones and the account password are refused with a Basic challenge', async () => {
    const u = await davUser('dv-auth1')
    const challenge = 'Basic realm="File Center", charset="UTF-8"'
    const none = await app.handle(new Request('http://localhost/dav/', { method: 'PROPFIND' }))
    expect(none.status).toBe(401)
    expect(none.headers.get('www-authenticate')).toBe(challenge)
    for (const [user, secret] of [['dv-auth1', 'fc-' + 'a'.repeat(32)], ['dv-auth1', PW], ['nobody-here', u.dav.secret], ['dv-auth1', '']]) {
      const r = await new Dav(user, secret).req('PROPFIND', '/dav/', { headers: { depth: '0' } })
      expect(`${user} ${r.status}`).toBe(`${user} 401`)
      expect(r.headers.get('www-authenticate')).toBe(challenge)
    }
    auth.clearFailures('dav|unknown|dv-auth1')
    // the right one works, in any letter case of the name
    expect(await new Dav('DV-AUTH1', u.dav.secret).status('PROPFIND', '/dav/', { headers: { depth: '0' } })).toBe(207)
    // another account's app password does not open this account
    const v = await davUser('dv-auth2')
    expect(await new Dav('dv-auth1', v.dav.secret).status('OPTIONS', '/dav/')).toBe(401)
  })

  test('the web session cookie opens nothing here, and /dav needs no CSRF token', async () => {
    const u = await davUser('dv-auth3')
    const res = await app.handle(new Request('http://localhost/dav/home/', { method: 'PROPFIND', headers: { cookie: u.web.cookie, 'x-csrf-token': u.web.csrf, depth: '0' } }))
    expect(res.status).toBe(401)
    // a write with the app password and no token at all
    expect((await u.dav.put('/dav/home/no-csrf.txt', 'x')).status).toBe(201)
    // and the app password does not sign in to the API
    const api = await app.handle(new Request('http://localhost/api/admin/users', { headers: { authorization: basic('dv-auth3', u.dav.secret) } }))
    expect(api.status).toBe(401)
  })

  test('wrong passwords lock the name out like the login, and a right one does not skip the wait', async () => {
    const u = await davUser('dv-lock')
    const bad = new Dav('dv-lock', 'fc-' + 'b'.repeat(32))
    const key = 'dav|unknown|dv-lock'
    auth.clearFailures(key)
    for (let i = 0; i < config.loginMaxAttempts; i++) expect(await bad.status('OPTIONS', '/dav/')).toBe(401)
    const locked = await bad.req('OPTIONS', '/dav/')
    expect(locked.status).toBe(429)
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await u.dav.status('OPTIONS', '/dav/')).toBe(429)
    // another name from the same address is not locked
    const other = await davUser('dv-lock2')
    expect(await other.dav.status('OPTIONS', '/dav/')).toBe(200)
    auth.clearFailures(key)
    expect(await u.dav.status('OPTIONS', '/dav/')).toBe(200)
  })

  test('a deleted app password stops working at once, and the minute of memory is shorter when set so', async () => {
    const u = await davUser('dv-revoke')
    expect(await u.dav.status('OPTIONS', '/dav/')).toBe(200)
    expect(await u.dav.status('OPTIONS', '/dav/')).toBe(200)
    expect((await u.web.json('DELETE', `/api/me/app-passwords/${u.id}`)).status).toBe(200)
    expect(await u.dav.status('OPTIONS', '/dav/')).toBe(401)

    // the cache: a record whose hash no longer fits still passes inside the time, and not after it
    const v = await davUser('dv-ttl')
    pw.appPasswordCache.clear()
    pw.appPasswordCache.ttlMs = 600
    try {
      expect(await v.dav.status('OPTIONS', '/dav/')).toBe(200)
      const item = pw.appPasswordsOf('dv-ttl')[0]
      const real = item.hash
      item.hash = await Bun.password.hash('something else entirely', { algorithm: 'argon2id', memoryCost: 8192, timeCost: 2 })
      expect(await v.dav.status('OPTIONS', '/dav/')).toBe(200)
      await Bun.sleep(700)
      expect(await v.dav.status('OPTIONS', '/dav/')).toBe(401)
      item.hash = real
      expect(await v.dav.status('OPTIONS', '/dav/')).toBe(200)
    } finally {
      pw.appPasswordCache.ttlMs = 60_000
      pw.appPasswordCache.clear()
    }
  })

  test('lastUsedAt is kept, at most once a minute, and an account that must change its password is refused', async () => {
    const u = await davUser('dv-used')
    expect(pw.appPasswordsOf('dv-used')[0].lastUsedAt).toBeNull()
    await u.dav.status('OPTIONS', '/dav/')
    const first = pw.appPasswordsOf('dv-used')[0].lastUsedAt
    expect(first).not.toBeNull()
    await Bun.sleep(20)
    await u.dav.status('OPTIONS', '/dav/')
    expect(pw.appPasswordsOf('dv-used')[0].lastUsedAt).toBe(first)

    auth.findUser('dv-used')!.mustChangePassword = true
    try {
      const r = await u.dav.req('OPTIONS', '/dav/')
      expect(r.status).toBe(403)
      expect(r.headers.get('x-error-code')).toBe('must-change-password')
    } finally {
      auth.findUser('dv-used')!.mustChangePassword = false
    }
  })

  test('WEBDAV=off answers 404 to everything under /dav', async () => {
    const u = await davUser('dv-off')
    config.webdav = false
    try {
      expect(await u.dav.status('PROPFIND', '/dav/', { headers: { depth: '0' } })).toBe(404)
      expect(await new Dav('x', 'y').status('OPTIONS', '/dav/home/')).toBe(404)
      expect((await u.web.json('GET', '/api/me/app-passwords')).data.enabled).toBe(false)
    } finally {
      config.webdav = true
    }
    expect(await u.dav.status('OPTIONS', '/dav/')).toBe(200)
  })

  test('OPTIONS announces class 1 and 2 for a writer, class 1 and no write methods for a reader', async () => {
    const w = await davUser('dv-opt1')
    const r = await davUser('dv-opt2', 'read')
    const wr = await w.dav.req('OPTIONS', '/dav/home/anything')
    expect(wr.headers.get('dav')).toBe('1, 2')
    expect(wr.headers.get('ms-author-via')).toBe('DAV')
    for (const m of ['PROPFIND', 'PROPPATCH', 'GET', 'PUT', 'DELETE', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK']) expect(wr.headers.get('allow')).toContain(m)
    const rr = await r.dav.req('OPTIONS', '/dav/')
    expect(rr.headers.get('dav')).toBe('1')
    expect(rr.headers.get('allow')).not.toMatch(/PUT|DELETE|MKCOL|MOVE|COPY|LOCK/)
    expect(await w.dav.status('FROBNICATE', '/dav/home/')).toBe(405)
  })
})

// ───────────────────────────── listing ─────────────────────────────

describe('webdav: PROPFIND', () => {
  test('the root lists home, and public only for someone who may use it; Thai names are percent-encoded', async () => {
    const u = await davUser('dv-list1')
    expect(await u.dav.hrefs('/dav/')).toEqual(['/dav/', '/dav/home/'])
    const p = await davUser('dv-list2', 'readwrite', { publicPermissions: ['read', 'download'] })
    expect(await p.dav.hrefs('/dav/')).toEqual(['/dav/', '/dav/home/', '/dav/public/'])
    // the admin may also have folders shared with them or groups, made by other test files
    const adminRoot = await new Dav('admin', (await (async () => {
      const made = await admin.json('POST', '/api/me/app-passwords', { name: 'adm', scope: 'readwrite', password: process.env.ADMIN_PASSWORD })
      return made.data.secret as string
    })())).hrefs('/dav/')
    expect(adminRoot.slice(0, 3)).toEqual(['/dav/', '/dav/home/', '/dav/public/'])
    for (const h of adminRoot.slice(3)) expect(['/dav/shared/', '/dav/groups/']).toContain(h)

    mkdirSync(home('dv-list1', 'โฟลเดอร์ ทดสอบ'), { recursive: true })
    writeFileSync(home('dv-list1', 'รายงาน 2569 #1 (final).txt'), 'สวัสดี')
    writeFileSync(home('dv-list1', 'plain.txt'), 'abc')
    const r = await u.dav.propfind('/dav/home/', '1')
    expect(r.status).toBe(207)
    expect(r.res.headers.get('content-type')).toContain('xml')
    const list = responsesOf(parseXml(r.text))
    expect(list.map(x => x.href).sort()).toEqual([
      '/dav/home/', '/dav/home/plain.txt', `/dav/home/${encodeURIComponent('รายงาน 2569 #1 (final).txt')}`,
      `/dav/home/${encodeURIComponent('โฟลเดอร์ ทดสอบ')}/`,
    ].sort())
    // the raw text holds no unencoded Thai in a href
    for (const m of r.text.matchAll(/<D:href>([^<]*)<\/D:href>/g)) expect(m[1]).toMatch(/^[\x21-\x7e]+$/)
    const thai = list.find(x => decodeURIComponent(x.href).endsWith('.txt') && x.href.includes('%E0'))!
    expect(thai.props.displayname.value.text).toBe('รายงาน 2569 #1 (final).txt')
    expect(thai.props.getcontentlength.value.text).toBe(String(Buffer.byteLength('สวัสดี')))
    const dir = list.find(x => x.href.endsWith('/') && x.href !== '/dav/home/')!
    expect(dir.props.resourcetype.value.children.map(c => c.name)).toEqual(['collection'])
    expect(dir.props.getcontentlength).toBeUndefined()
  })

  test('the properties of a file match the file, and getetag is the ETag of GET', async () => {
    const u = await davUser('dv-list3')
    writeFileSync(home('dv-list3', 'a.txt'), 'hello')
    const st = statSync(home('dv-list3', 'a.txt'))
    const r = await u.dav.propfind('/dav/home/a.txt', '0')
    const [x] = responsesOf(parseXml(r.text))
    expect(x.href).toBe('/dav/home/a.txt')
    expect(x.props.getcontentlength.value.text).toBe('5')
    expect(new Date(x.props.getlastmodified.value.text).getTime()).toBe(Math.floor(st.mtimeMs / 1000) * 1000)
    expect(x.props.getlastmodified.value.text).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/)
    expect(x.props.creationdate.value.text).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(x.props.getcontenttype.value.text).toContain('text/plain')
    expect(x.props.resourcetype.value.children).toEqual([])
    expect(x.props.supportedlock.value.children.length).toBe(2)
    const get = await u.dav.get('/dav/home/a.txt')
    expect(get.res.headers.get('etag')).toBe(x.props.getetag.value.text)
  })

  test('prop, propname and unknown properties; Depth 0 / 1; infinity and a missing Depth are refused', async () => {
    const u = await davUser('dv-list4')
    writeFileSync(home('dv-list4', 'a.txt'), 'hello')
    const want = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:z="urn:x-test"><d:prop><d:displayname/><d:getcontentlength/><z:nothing/><d:quota-available-bytes/></d:prop></d:propfind>'
    const r = await u.dav.propfind('/dav/home/a.txt', '0', want)
    const [x] = responsesOf(parseXml(r.text))
    expect(x.props.displayname.status).toContain('200')
    expect(x.props.nothing.status).toContain('404')
    expect(x.props.nothing.value.ns).toBe('urn:x-test')
    // quota only on folders; on a file it is "not found"
    expect(x.props['quota-available-bytes'].status).toContain('404')
    const dir = responsesOf(parseXml((await u.dav.propfind('/dav/home/', '0', want)).text))[0]
    expect(Number(dir.props['quota-available-bytes'].value.text)).toBeGreaterThanOrEqual(0)

    const names = await u.dav.propfind('/dav/home/a.txt', '0', '<d:propfind xmlns:d="DAV:"><d:propname/></d:propfind>')
    const named = responsesOf(parseXml(names.text))[0]
    expect(Object.keys(named.props)).toContain('getetag')
    expect(named.props.getetag.value.text).toBe('')

    expect((await u.dav.hrefs('/dav/home/', '0'))).toEqual(['/dav/home/'])
    for (const depth of ['infinity', null]) {
      const bad = await u.dav.propfind('/dav/home/', depth)
      expect(bad.status).toBe(403)
      expect(bad.text).toContain('propfind-finite-depth')
    }
    expect((await u.dav.propfind('/dav/home/nope.txt', '0')).status).toBe(404)
    expect((await u.dav.propfind('/dav/nothing-here/', '0')).status).toBe(404)
    expect((await u.dav.propfind('/dav/home/', '0', '<d:propfind xmlns:d="urn:other"/>')).status).toBe(400)
  })

  test('names are escaped in the XML: markup, ampersands and control characters can not break the answer', async () => {
    const u = await davUser('dv-list5')
    const name = 'a&b <c> "d" \'e\'.txt'
    writeFileSync(home('dv-list5', name), 'x')
    writeFileSync(home('dv-list5', 'ctl\u0001name.txt'), 'x')
    const r = await u.dav.propfind('/dav/home/', '1')
    expect(r.status).toBe(207)
    const doc = parseXml(r.text)
    const found = responsesOf(doc).find(x => x.props.displayname?.value.text === name)
    expect(found).toBeDefined()
    expect(decodeURIComponent(found!.href)).toBe(`/dav/home/${name}`)
    expect(r.text).not.toContain('<c>')
    expect(responsesOf(doc).find(x => x.props.displayname?.value.text === 'ctl�name.txt')).toBeDefined()
    // an unknown property name from the request is never written back raw
    const evil = '<d:propfind xmlns:d="DAV:" xmlns:z="a&quot;b"><d:prop><z:ok/></d:prop></d:propfind>'
    const e = await u.dav.propfind('/dav/home/', '0', evil)
    expect(e.status).toBe(207)
    expect(parseXml(e.text)).toBeDefined()
  })

  test('XML bodies: DOCTYPE and ENTITY are refused, so are too big and broken ones', async () => {
    const u = await davUser('dv-xml')
    const bombs = [
      '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><d:propfind xmlns:d="DAV:"><d:prop><d:displayname>&xxe;</d:displayname></d:prop></d:propfind>',
      '<!doctype x><d:propfind xmlns:d="DAV:"/>',
      '<d:propfind xmlns:d="DAV:"><!ENTITY a "b"/></d:propfind>',
    ]
    for (const body of bombs) {
      expect((await u.dav.propfind('/dav/home/', '0', body)).status).toBe(400)
      expect(await u.dav.status('LOCK', '/dav/home/x.txt', { body })).toBe(400)
      expect(await u.dav.status('PROPPATCH', '/dav/home/', { body })).toBe(400)
    }
    for (const body of ['<d:propfind xmlns:d="DAV:"><d:prop></d:propfind>', 'not xml at all', '<a><b></a></b>', '<d:propfind/>']) {
      expect(`${body} ${(await u.dav.propfind('/dav/home/', '0', body)).status}`).toBe(`${body} 400`)
    }
    const big = `<d:propfind xmlns:d="DAV:"><d:prop>${'<d:displayname/>'.repeat(5000)}</d:prop></d:propfind>`
    expect(big.length).toBeGreaterThan(64 * 1024)
    expect((await u.dav.propfind('/dav/home/', '0', big)).status).toBe(413)
    // the same, announced by the length header only
    expect(await u.dav.status('PROPFIND', '/dav/home/', { headers: { depth: '0', 'content-length': String(big.length) }, body: 'x' })).toBe(413)
    // a deep and wide document is cut off, not parsed
    expect((await u.dav.propfind('/dav/home/', '0', '<a>'.repeat(100) + '</a>'.repeat(100))).status).toBe(400)
  })

  test('the XML reader understands what clients send', () => {
    const doc = parseXml(`<?xml version="1.0" encoding="utf-8" ?>
      <!-- c --><D:propfind xmlns:D='DAV:' xmlns:Z="urn:schemas-microsoft-com:"><D:prop><Z:Win32FileAttributes/><D:displayname>a &amp; b &#x41;&#66; <![CDATA[<raw>]]></D:displayname></D:prop></D:propfind>`)
    expect(doc.ns).toBe('DAV:')
    const [a, b] = doc.children[0].children
    expect([a.ns, a.name]).toEqual(['urn:schemas-microsoft-com:', 'Win32FileAttributes'])
    expect(b.text.trim()).toBe('a & b AB <raw>')
    expect(() => parseXml('<a:b/>')).toThrow()
    // a prefix can not be declared empty (litmus propfind_invalid2)
    expect(() => parseXml('<a xmlns:b=""><b:c/></a>')).toThrow()
  })
})

// ───────────────────────────── reading ─────────────────────────────

describe('webdav: GET and HEAD', () => {
  test('a file, a range, HEAD, If-None-Match and a folder', async () => {
    const u = await davUser('dv-get1')
    writeFileSync(home('dv-get1', 'ไฟล์.txt'), '0123456789')
    const path = `/dav/home/${encodeURIComponent('ไฟล์.txt')}`
    const full = await u.dav.get(path)
    expect(full.status).toBe(200)
    expect(full.text).toBe('0123456789')
    expect(full.res.headers.get('accept-ranges')).toBe('bytes')
    expect(full.res.headers.get('content-length')).toBe('10')
    const part = await u.dav.get(path, { range: 'bytes=2-5' })
    expect(part.status).toBe(206)
    expect(part.text).toBe('2345')
    expect(part.res.headers.get('content-range')).toBe('bytes 2-5/10')
    expect((await u.dav.get(path, { range: 'bytes=-3' })).text).toBe('789')
    expect((await u.dav.get(path, { range: 'bytes=50-' })).status).toBe(416)
    const etag = full.res.headers.get('etag')!
    expect((await u.dav.get(path, { 'if-none-match': etag })).status).toBe(304)
    expect((await u.dav.get(path, { 'if-none-match': '"other"' })).status).toBe(200)
    const head = await u.dav.req('HEAD', path)
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('10')
    expect(await head.text()).toBe('')
    expect((await u.dav.get('/dav/home/')).status).toBe(405)
    expect((await u.dav.get('/dav/')).status).toBe(405)
    expect((await u.dav.get('/dav/home/missing.txt')).status).toBe(404)
  })

  test('a user without download can not GET, a visitor-style public folder follows the public rights', async () => {
    const u = await davUser('dv-get2', 'readwrite', { permissions: ['read', 'write', 'upload'], publicPermissions: ['read', 'download'] })
    writeFileSync(home('dv-get2', 'a.txt'), 'x')
    expect((await u.dav.get('/dav/home/a.txt')).status).toBe(403)
    expect(await u.dav.status('PROPFIND', '/dav/home/', { headers: { depth: '1' } })).toBe(207)
    writeFileSync(join(paths.publicDir, 'dv-pub.txt'), 'public text')
    expect((await u.dav.get('/dav/public/dv-pub.txt')).text).toBe('public text')
    expect((await u.dav.put('/dav/public/dv-new.txt', 'x')).status).toBe(403)
    rmSync(join(paths.publicDir, 'dv-pub.txt'))
  })
})

// ───────────────────────────── writing ─────────────────────────────

describe('webdav: PUT', () => {
  test('new is 201, an overwrite is 204 and keeps a version of what it replaced; the file is complete', async () => {
    const u = await davUser('dv-put1')
    const r = await u.dav.put('/dav/home/ใหม่.txt', 'first', { 'content-length': '5' })
    expect(r.status).toBe(201)
    expect(r.headers.get('etag')).toMatch(/^"/)
    expect(readFileSync(home('dv-put1', 'ใหม่.txt'), 'utf8')).toBe('first')
    const abs = home('dv-put1', 'ใหม่.txt')
    expect(versions.listVersions(abs)).toHaveLength(0)

    const over = await u.dav.put('/dav/home/ใหม่.txt', 'second!')
    expect(over.status).toBe(204)
    expect(readFileSync(abs, 'utf8')).toBe('second!')
    const kept = versions.listVersions(abs)
    expect(kept).toHaveLength(1)
    expect(kept[0].savedBy).toBe('dv-put1')
    expect(readFileSync(versions.getVersion(abs, kept[0].id).item, 'utf8')).toBe('first')
    // the web page sees it, a nested path needs its folders first
    const list = await u.web.json('GET', '/api/list?space=home&path=/')
    expect(list.data.entries.map((e: any) => e.name)).toContain('ใหม่.txt')
    expect((await u.dav.put('/dav/home/no/such/dir/f.txt', 'x')).status).toBe(409)
    expect((await u.dav.put('/dav/home/ใหม่.txt/inside.txt', 'x')).status).toBe(409)
    // an empty file
    expect((await u.dav.put('/dav/home/empty.bin', '')).status).toBe(201)
    expect(statSync(home('dv-put1', 'empty.bin')).size).toBe(0)
    // a folder can not be written over; the root of a space neither
    mkdirSync(home('dv-put1', 'adir'))
    expect((await u.dav.put('/dav/home/adir', 'x')).status).toBe(405)
    expect((await u.dav.put('/dav/home/', 'x')).status).toBe(405)
    expect((await u.dav.put('/dav/newroot.txt', 'x')).status).toBe(403)
    expect((await u.dav.put('/dav/shared/x.txt', 'x')).status).toBe(403)
    expect((await u.dav.put('/dav/shared/nothing/x.txt', 'x')).status).toBe(409)
    // bad names
    for (const name of ['a%3Ab.txt', 'q%3F.txt', 'x%7Cy', '%20lead']) {
      expect(`${name} ${(await u.dav.put(`/dav/home/${name}`, 'x')).status}`).toBe(`${name} 400`)
    }
    // nothing is left behind in the temp folder
    expect(readdirSync(paths.tmp).filter(n => n.startsWith('dav-'))).toEqual([])
  })

  test('If-Match and If-None-Match', async () => {
    const u = await davUser('dv-put2')
    expect((await u.dav.put('/dav/home/c.txt', 'one', { 'if-none-match': '*' })).status).toBe(201)
    const etag = (await u.dav.req('HEAD', '/dav/home/c.txt')).headers.get('etag')!
    expect((await u.dav.put('/dav/home/c.txt', 'two', { 'if-none-match': '*' })).status).toBe(412)
    expect((await u.dav.put('/dav/home/c.txt', 'two', { 'if-match': '"wrong"' })).status).toBe(412)
    expect((await u.dav.put('/dav/home/c.txt', 'two', { 'if-none-match': etag })).status).toBe(412)
    expect((await u.dav.put('/dav/home/none.txt', 'two', { 'if-match': '*' })).status).toBe(412)
    expect(readFileSync(home('dv-put2', 'c.txt'), 'utf8')).toBe('one')
    expect((await u.dav.put('/dav/home/c.txt', 'two', { 'if-match': etag })).status).toBe(204)
    expect(readFileSync(home('dv-put2', 'c.txt'), 'utf8')).toBe('two')
  })

  test('the quota is enforced, announced or not, and nothing is left half written', async () => {
    const u = await davUser('dv-put3', 'readwrite', { quotaBytes: 1000 })
    expect((await u.dav.put('/dav/home/a.bin', new Uint8Array(600), { 'content-length': '600' })).status).toBe(201)
    for (const headers of [{ 'content-length': '600' }, {}] as Record<string, string>[]) {
      const r = await u.dav.put('/dav/home/b.bin', new Uint8Array(600), headers)
      expect(`${r.status} ${r.headers.get('x-error-code')}`).toBe('507 quota.exceeded')
    }
    expect(existsSyncSafe(home('dv-put3', 'b.bin'))).toBe(false)
    // an overwrite that would grow past the limit leaves the old file alone
    const grow = await u.dav.put('/dav/home/a.bin', new Uint8Array(1500), { 'content-length': '1500' })
    expect(grow.status).toBe(507)
    expect(statSync(home('dv-put3', 'a.bin')).size).toBe(600)
    expect((await u.dav.put('/dav/home/a.bin', new Uint8Array(1500))).status).toBe(507)
    expect(statSync(home('dv-put3', 'a.bin')).size).toBe(600)
    expect(readdirSync(paths.tmp).filter(n => n.startsWith('dav-'))).toEqual([])
    // the room that was held while the bytes arrived is free again
    expect((await u.dav.put('/dav/home/c.bin', new Uint8Array(300), { 'content-length': '300' })).status).toBe(201)
    // deleting gives the room back
    expect(await u.dav.status('DELETE', '/dav/home/c.bin')).toBe(204)
    expect(await u.dav.status('DELETE', '/dav/home/a.bin')).toBe(204)
    expect((await u.dav.put('/dav/home/d.bin', new Uint8Array(900), { 'content-length': '900' })).status).toBe(201)
  })

  test('parallel PUTs without Content-Length each take only what they have received, so both fit when there is room', async () => {
    const u = await davUser('dv-putpar', 'readwrite', { quotaBytes: 10 * MB })
    const piece = new Uint8Array(MB)
    // a body of 2 MB without a length that, after the second piece, waits until `gate` opens; `reached` says it got that far
    const stream = (gate: Promise<void>) => {
      let sent = 0
      let reach!: () => void
      const reached = new Promise<void>(r => { reach = r })
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          if (sent < 2) { sent++; c.enqueue(piece); return }
          reach()
          await gate
          c.close()
        },
      }, { highWaterMark: 0 })
      return { body, reached }
    }
    const put = (name: string, body: ReadableStream) =>
      app.handle(new Request(`http://localhost/dav/home/${name}`, { method: 'PUT', body, duplex: 'half', headers: { authorization: basic(u.username, u.dav.secret) } } as any)) as Promise<Response>
    let open!: () => void
    const gate = new Promise<void>(r => { open = r })
    const a = stream(gate)
    const b = stream(gate)
    const first = put('a.bin', a.body)
    await a.reached
    // the first is half way: before the fix it held all 10 MB that were left, and this one was refused (507)
    const second = put('b.bin', b.body)
    await Promise.race([b.reached, second])
    open()
    expect([(await first).status, (await second).status]).toEqual([201, 201])
    expect([statSync(home('dv-putpar', 'a.bin')).size, statSync(home('dv-putpar', 'b.bin')).size]).toEqual([2 * MB, 2 * MB])
    // what is still over the quota is refused while it comes, and everything held is free again
    const big = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(piece) } })
    const over = await put('over.bin', big)
    expect(`${over.status} ${over.headers.get('x-error-code')}`).toBe('507 quota.exceeded')
    expect(existsSyncSafe(home('dv-putpar', 'over.bin'))).toBe(false)
    expect(readdirSync(paths.tmp).filter(n => n.startsWith('dav-'))).toEqual([])
    expect((await u.dav.put('/dav/home/c.bin', new Uint8Array(6 * MB), { 'content-length': String(6 * MB) })).status).toBe(201)
  })

  test('UPLOAD_MAX_SIZE, a length that does not match, and a folder that is a file', async () => {
    const u = await davUser('dv-put4')
    const was = config.uploadMaxSize
    config.uploadMaxSize = 100
    try {
      expect(`${(await u.dav.put('/dav/home/big.bin', new Uint8Array(101), { 'content-length': '101' })).status}`).toBe('413')
      expect((await u.dav.put('/dav/home/big.bin', new Uint8Array(101))).status).toBe(413)
      expect((await u.dav.put('/dav/home/ok.bin', new Uint8Array(100))).status).toBe(201)
    } finally {
      config.uploadMaxSize = was
    }
    expect((await u.dav.put('/dav/home/short.bin', new Uint8Array(5), { 'content-length': '9' })).status).toBe(400)
    expect(existsSyncSafe(home('dv-put4', 'short.bin'))).toBe(false)
    expect((await u.dav.put('/dav/home/neg.bin', 'x', { 'content-length': '-3' })).status).toBe(400)
    expect(readdirSync(paths.tmp).filter(n => n.startsWith('dav-'))).toEqual([])
  })

  test('X-OC-Mtime sets the modification time (what rclone sends)', async () => {
    const u = await davUser('dv-put5')
    const r = await u.dav.put('/dav/home/t.txt', 'x', { 'x-oc-mtime': '1700000000' })
    expect(r.headers.get('x-oc-mtime')).toBe('accepted')
    expect(Math.floor(statSync(home('dv-put5', 't.txt')).mtimeMs / 1000)).toBe(1700000000)
  })

  test('writes are in the audit trail, one line a minute per file for PUT', async () => {
    const u = await davUser('dv-aud')
    await u.dav.put('/dav/home/log.txt', 'a')
    await u.dav.put('/dav/home/log.txt', 'b')
    await u.dav.put('/dav/home/log.txt', 'c')
    await u.dav.req('MKCOL', '/dav/home/logdir')
    await u.dav.req('DELETE', '/dav/home/logdir')
    const mine = Array.from(auditMod.auditEntries()).filter(e => e.user === 'dv-aud')
    expect(mine.filter(e => e.target?.endsWith('/log.txt')).map(e => e.action)).toEqual(['upload'])
    expect(mine.map(e => e.action)).toEqual(expect.arrayContaining(['mkdir', 'delete']))
    expect(mine.filter(e => ['upload', 'edit', 'mkdir', 'delete'].includes(e.action)).every(e => e.detail?.startsWith('WebDAV'))).toBe(true)
  })
})

describe('webdav: DELETE, MKCOL', () => {
  test('DELETE goes to the trash as the user, and the root and system folders stay', async () => {
    const u = await davUser('dv-del1')
    writeFileSync(home('dv-del1', 'gone.txt'), 'bye')
    mkdirSync(home('dv-del1', 'tree', 'sub'), { recursive: true })
    writeFileSync(home('dv-del1', 'tree', 'sub', 'f.txt'), 'f')
    expect(await u.dav.status('DELETE', '/dav/home/gone.txt')).toBe(204)
    expect(await u.dav.status('DELETE', '/dav/home/tree/')).toBe(204)
    expect(existsSyncSafe(home('dv-del1', 'gone.txt'))).toBe(false)
    expect(existsSyncSafe(home('dv-del1', 'tree'))).toBe(false)
    const mine = trash.listTrash().filter(t => t.owner === 'dv-del1')
    expect(mine.map(t => t.name).sort()).toEqual(['gone.txt', 'tree'])
    expect(mine.every(t => t.deletedBy === 'dv-del1' && t.space === 'home')).toBe(true)
    // the owner restores it from the web page
    const entry = mine.find(t => t.name === 'gone.txt')!
    expect((await u.web.json('POST', `/api/me/trash/${entry.id}/restore`)).status).toBe(200)
    expect(readFileSync(home('dv-del1', 'gone.txt'), 'utf8')).toBe('bye')

    expect(await u.dav.status('DELETE', '/dav/home/missing')).toBe(404)
    expect(await u.dav.status('DELETE', '/dav/home/')).toBe(403)
    expect(await u.dav.status('DELETE', '/dav/home')).toBe(403)
    expect(await u.dav.status('DELETE', '/dav/')).toBe(403)
    const root = await new Dav('admin', (await admin.json('POST', '/api/me/app-passwords', { name: 'a2', scope: 'readwrite', password: process.env.ADMIN_PASSWORD })).data.secret)
    expect(await root.status('DELETE', '/dav/home/public')).toBe(403)
    expect(existsSyncSafe(paths.publicDir)).toBe(true)
  })

  test('MKCOL: 201, 409 without a parent, 405 when it exists, 415 with a body', async () => {
    const u = await davUser('dv-mk')
    expect(await u.dav.status('MKCOL', '/dav/home/new%20folder')).toBe(201)
    expect(lstatSync(home('dv-mk', 'new folder')).isDirectory()).toBe(true)
    expect(await u.dav.status('MKCOL', '/dav/home/new%20folder')).toBe(405)
    expect(await u.dav.status('MKCOL', '/dav/home/a/b/c')).toBe(409)
    expect(await u.dav.status('MKCOL', '/dav/home/with-body', { body: '<x/>', headers: { 'content-length': '4' } })).toBe(415)
    expect(existsSyncSafe(home('dv-mk', 'with-body'))).toBe(false)
    expect(await u.dav.status('MKCOL', '/dav/home/')).toBe(405)
    expect(await u.dav.status('MKCOL', '/dav/other')).toBe(403)
    expect(await u.dav.status('MKCOL', '/dav/home/bad%3Aname')).toBe(400)
    writeFileSync(home('dv-mk', 'afile'), 'x')
    expect(await u.dav.status('MKCOL', '/dav/home/afile/inner')).toBe(409)
  })
})

describe('webdav: MOVE and COPY', () => {
  test('MOVE renames and moves, with versions and the overwrite rules', async () => {
    const u = await davUser('dv-mv')
    writeFileSync(home('dv-mv', 'a.txt'), 'A')
    mkdirSync(home('dv-mv', 'dir'))
    const to = (p: string) => ({ headers: { destination: `http://localhost/dav/home/${p}` } })
    // an edit leaves a version, which follows the file
    expect((await u.dav.put('/dav/home/a.txt', 'A2')).status).toBe(204)
    expect(await u.dav.status('MOVE', '/dav/home/a.txt', to('dir/b.txt'))).toBe(201)
    expect(existsSyncSafe(home('dv-mv', 'a.txt'))).toBe(false)
    expect(readFileSync(home('dv-mv', 'dir', 'b.txt'), 'utf8')).toBe('A2')
    expect(versions.listVersions(home('dv-mv', 'dir', 'b.txt'))).toHaveLength(1)

    // a path-only Destination and Thai names
    writeFileSync(home('dv-mv', 'c.txt'), 'C')
    expect(await u.dav.status('MOVE', '/dav/home/c.txt', { headers: { destination: `/dav/home/${encodeURIComponent('ชื่อใหม่.txt')}` } })).toBe(201)
    expect(readFileSync(home('dv-mv', 'ชื่อใหม่.txt'), 'utf8')).toBe('C')

    // the target exists: Overwrite F is 412, the default replaces it and the old one is in the trash
    writeFileSync(home('dv-mv', 'd.txt'), 'D')
    writeFileSync(home('dv-mv', 'e.txt'), 'E')
    expect(await u.dav.status('MOVE', '/dav/home/d.txt', { headers: { ...to('e.txt').headers, overwrite: 'F' } })).toBe(412)
    expect(readFileSync(home('dv-mv', 'e.txt'), 'utf8')).toBe('E')
    expect(existsSyncSafe(home('dv-mv', 'd.txt'))).toBe(true)
    expect(await u.dav.status('MOVE', '/dav/home/d.txt', { headers: { ...to('e.txt').headers, overwrite: 'T' } })).toBe(204)
    expect(readFileSync(home('dv-mv', 'e.txt'), 'utf8')).toBe('D')
    expect(trash.listTrash().some(t => t.owner === 'dv-mv' && t.name === 'e.txt')).toBe(true)

    // things that are refused
    expect(await u.dav.status('MOVE', '/dav/home/e.txt', to('e.txt'))).toBe(403)
    expect(await u.dav.status('MOVE', '/dav/home/dir', to('dir/inside'))).toBe(403)
    expect(await u.dav.status('MOVE', '/dav/home/dir/b.txt', to('missing-dir/b.txt'))).toBe(409)
    expect(await u.dav.status('MOVE', '/dav/home/nothing', to('x'))).toBe(404)
    expect(await u.dav.status('MOVE', '/dav/home/e.txt', {})).toBe(400)
    expect(await u.dav.status('MOVE', '/dav/home/e.txt', { headers: { destination: 'http://elsewhere.example/dav/home/x' } })).toBe(502)
    expect(await u.dav.status('MOVE', '/dav/home/e.txt', { headers: { destination: 'http://localhost/api/session' } })).toBe(502)
    expect(await u.dav.status('MOVE', '/dav/home/', to('x'))).toBe(403)
    expect(await u.dav.status('MOVE', '/dav/home/e.txt', { headers: { destination: 'http://localhost/dav/home/' } })).toBe(403)
    expect(existsSyncSafe(home('dv-mv', 'e.txt'))).toBe(true)
  })

  test('COPY copies a file or a tree, Depth 0 only the folder, and never over itself', async () => {
    const u = await davUser('dv-cp')
    mkdirSync(home('dv-cp', 'src', 'sub'), { recursive: true })
    writeFileSync(home('dv-cp', 'src', 'a.txt'), 'A')
    writeFileSync(home('dv-cp', 'src', 'sub', 'b.txt'), 'B')
    const to = (p: string, extra: Record<string, string> = {}) => ({ headers: { destination: `http://localhost/dav/home/${p}`, ...extra } })
    expect(await u.dav.status('COPY', '/dav/home/src/a.txt', to('a-copy.txt'))).toBe(201)
    expect(readFileSync(home('dv-cp', 'a-copy.txt'), 'utf8')).toBe('A')
    expect(readFileSync(home('dv-cp', 'src', 'a.txt'), 'utf8')).toBe('A')
    expect(await u.dav.status('COPY', '/dav/home/src', to('tree'))).toBe(201)
    expect(readFileSync(home('dv-cp', 'tree', 'sub', 'b.txt'), 'utf8')).toBe('B')
    expect(await u.dav.status('COPY', '/dav/home/src', to('shallow', { depth: '0' }))).toBe(201)
    expect(readdirSync(home('dv-cp', 'shallow'))).toEqual([])
    expect(await u.dav.status('COPY', '/dav/home/src', to('bad', { depth: '1' }))).toBe(400)
    // onto an existing name
    expect(await u.dav.status('COPY', '/dav/home/src/a.txt', to('a-copy.txt', { overwrite: 'F' }))).toBe(412)
    writeFileSync(home('dv-cp', 'src', 'a.txt'), 'A-new')
    expect(await u.dav.status('COPY', '/dav/home/src/a.txt', to('a-copy.txt'))).toBe(204)
    expect(readFileSync(home('dv-cp', 'a-copy.txt'), 'utf8')).toBe('A-new')
    // into itself, onto itself, over what holds it
    expect(await u.dav.status('COPY', '/dav/home/src', to('src/sub/again'))).toBe(403)
    expect(await u.dav.status('COPY', '/dav/home/src/a.txt', to('src/a.txt'))).toBe(403)
    expect(await u.dav.status('COPY', '/dav/home/src/sub', to('src'))).toBe(403)
    expect(readdirSync(home('dv-cp')).filter(n => n.startsWith('.fc-dav-'))).toEqual([])
    // a copy counts against the quota
    const q = await davUser('dv-cp2', 'readwrite', { quotaBytes: 100 })
    expect((await q.dav.put('/dav/home/big.bin', new Uint8Array(60))).status).toBe(201)
    expect(await q.dav.status('COPY', '/dav/home/big.bin', { headers: { destination: 'http://localhost/dav/home/big2.bin' } })).toBe(507)
    expect(existsSyncSafe(home('dv-cp2', 'big2.bin'))).toBe(false)
  })

  test('between spaces: needs the rights on both sides; a move leaves the source in the trash', async () => {
    const u = await davUser('dv-x1', 'readwrite', { publicPermissions: ['read', 'download', 'write', 'upload'] })
    const ro = await davUser('dv-x2', 'readwrite', { publicPermissions: ['read', 'download'] })
    writeFileSync(home('dv-x1', 'p.txt'), 'P')
    writeFileSync(home('dv-x2', 'p.txt'), 'P')
    const dest = 'http://localhost/dav/public/dv-x-copy.txt'
    expect(await u.dav.status('COPY', '/dav/home/p.txt', { headers: { destination: dest } })).toBe(201)
    expect(readFileSync(join(paths.publicDir, 'dv-x-copy.txt'), 'utf8')).toBe('P')
    // the other user may read the public folder but not add to it
    expect(await ro.dav.status('COPY', '/dav/home/p.txt', { headers: { destination: 'http://localhost/dav/public/dv-x-no.txt' } })).toBe(403)
    expect(existsSyncSafe(join(paths.publicDir, 'dv-x-no.txt'))).toBe(false)
    // a move across spaces
    expect(await u.dav.status('MOVE', '/dav/home/p.txt', { headers: { destination: 'http://localhost/dav/public/dv-x-moved.txt' } })).toBe(201)
    expect(existsSyncSafe(home('dv-x1', 'p.txt'))).toBe(false)
    expect(readFileSync(join(paths.publicDir, 'dv-x-moved.txt'), 'utf8')).toBe('P')
    expect(trash.listTrash().some(t => t.owner === 'dv-x1' && t.name === 'p.txt')).toBe(true)
    // and the other way, into the home, from a file the user may only read: a copy is fine, a move is not
    expect(await ro.dav.status('MOVE', '/dav/public/dv-x-moved.txt', { headers: { destination: 'http://localhost/dav/home/m.txt' } })).toBe(403)
    expect(await ro.dav.status('COPY', '/dav/public/dv-x-moved.txt', { headers: { destination: 'http://localhost/dav/home/m.txt' } })).toBe(201)
    rmSync(join(paths.publicDir, 'dv-x-copy.txt'), { force: true })
    rmSync(join(paths.publicDir, 'dv-x-moved.txt'), { force: true })
  })
})

describe('webdav: PROPPATCH and locks', () => {
  test('PROPPATCH sets the modification time, accepts Win32 properties and refuses the rest', async () => {
    const u = await davUser('dv-pp')
    writeFileSync(home('dv-pp', 'f.txt'), 'x')
    const body = `<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:"><D:set><D:prop>
      <Z:Win32CreationTime>Mon, 01 Jan 2024 00:00:00 GMT</Z:Win32CreationTime><Z:Win32FileAttributes>00000020</Z:Win32FileAttributes>
      <D:getlastmodified>Mon, 01 Jan 2024 10:00:00 GMT</D:getlastmodified><D:displayname>nope</D:displayname><Q:own xmlns:Q="urn:q">1</Q:own>
      </D:prop></D:set></D:propertyupdate>`
    const r = await u.dav.req('PROPPATCH', '/dav/home/f.txt', { body })
    expect(r.status).toBe(207)
    const text = await r.text()
    const [x] = responsesOf(parseXml(text))
    expect(x.href).toBe('/dav/home/f.txt')
    expect(x.props.Win32CreationTime.status).toContain('200')
    expect(x.props.Win32FileAttributes.status).toContain('200')
    expect(x.props.getlastmodified.status).toContain('200')
    expect(x.props.displayname.status).toContain('403')
    expect(x.props.own.status).toContain('403')
    expect(statSync(home('dv-pp', 'f.txt')).mtime.toISOString()).toBe('2024-01-01T10:00:00.000Z')
    // rclone sets the time of a server-side copy this way (ownCloud / Nextcloud): Unix seconds in DAV:lastmodified
    const seconds = '<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:lastmodified>1700000000</D:lastmodified></D:prop></D:set></D:propertyupdate>'
    expect(await u.dav.status('PROPPATCH', '/dav/home/f.txt', { body: seconds })).toBe(207)
    expect(Math.floor(statSync(home('dv-pp', 'f.txt')).mtimeMs / 1000)).toBe(1700000000)
    expect(await u.dav.status('PROPPATCH', '/dav/home/missing', { body })).toBe(404)
    expect(await u.dav.status('PROPPATCH', '/dav/home/f.txt', { body: '<x/>' })).toBe(400)
  })

  test('LOCK hands out a token for a file, for a name that is not there yet and for a folder; UNLOCK and refresh', async () => {
    const u = await davUser('dv-lk')
    const info = '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>mailto:me@example.com</D:href></D:owner></D:lockinfo>'
    writeFileSync(home('dv-lk', 'doc.docx'), 'x')
    const r = await u.dav.req('LOCK', '/dav/home/doc.docx', { body: info, headers: { timeout: 'Second-99999' } })
    expect(r.status).toBe(200)
    const token = r.headers.get('lock-token')!
    expect(token).toMatch(/^<opaquelocktoken:[0-9a-f-]{36}>$/)
    const doc = parseXml(await r.text())
    const al = doc.children[0].children[0]
    const timeout = al.children.find(c => c.name === 'timeout')!.text
    expect(Number(timeout.replace('Second-', ''))).toBeLessThanOrEqual(3600)
    expect(al.children.find(c => c.name === 'owner')!.text).toBe('mailto:me@example.com')
    // it shows in PROPFIND
    const pf = responsesOf(parseXml((await u.dav.propfind('/dav/home/doc.docx', '0')).text))[0]
    expect(pf.props.lockdiscovery.value.children).toHaveLength(1)
    // refresh with the token, then unlock
    const token_ = token.slice(1, -1)
    expect(await u.dav.status('LOCK', '/dav/home/doc.docx', { headers: { if: `(<${token_}>)`, timeout: 'Second-10' } })).toBe(200)
    expect(await u.dav.status('LOCK', '/dav/home/doc.docx', { headers: { if: '(<opaquelocktoken:00000000-0000-0000-0000-000000000000>)' } })).toBe(412)
    expect(await u.dav.status('UNLOCK', '/dav/home/doc.docx', { headers: { 'lock-token': token } })).toBe(204)
    expect(await u.dav.status('UNLOCK', '/dav/home/doc.docx', { headers: { 'lock-token': token } })).toBe(409)
    // a lock is no wall: a write goes through, with or without the token
    expect((await u.dav.put('/dav/home/doc.docx', 'new')).status).toBe(204)

    const fresh = await u.dav.req('LOCK', '/dav/home/~$new.docx', { body: info })
    expect(fresh.status).toBe(201)
    expect(statSync(home('dv-lk', '~$new.docx')).size).toBe(0)
    expect((await u.dav.req('LOCK', '/dav/home/nodir/x.docx', { body: info })).status).toBe(409)
    expect((await u.dav.req('LOCK', '/dav/home/', { body: info })).status).toBe(200)
    // somebody else's token is not mine
    const other = await davUser('dv-lk2')
    expect(await other.dav.status('UNLOCK', '/dav/home/x', { headers: { 'lock-token': token } })).toBe(409)
    expect((await u.dav.req('LOCK', '/dav/home/doc.docx', { body: '<D:other xmlns:D="DAV:"/>' })).status).toBe(400)
  })
})

// ───────────────────────────── scope ─────────────────────────────

describe('webdav: an app password with scope read', () => {
  test('can look and download, can not change anything', async () => {
    const w = await davUser('dv-rd', 'readwrite')
    writeFileSync(home('dv-rd', 'keep.txt'), 'keep')
    mkdirSync(home('dv-rd', 'folder'))
    // a second, read-only password for the same account
    const made = await w.web.json('POST', '/api/me/app-passwords', { name: 'ro', scope: 'read', password: PW })
    const r = new Dav('dv-rd', made.data.secret)
    expect(await r.status('PROPFIND', '/dav/home/', { headers: { depth: '1' } })).toBe(207)
    expect((await r.get('/dav/home/keep.txt')).text).toBe('keep')
    const refused: [string, string, Init][] = [
      ['PUT', '/dav/home/new.txt', { body: 'x' }],
      ['PUT', '/dav/home/keep.txt', { body: 'overwritten' }],
      ['DELETE', '/dav/home/keep.txt', {}],
      ['MKCOL', '/dav/home/newdir', {}],
      ['MOVE', '/dav/home/keep.txt', { headers: { destination: 'http://localhost/dav/home/moved.txt' } }],
      ['COPY', '/dav/home/keep.txt', { headers: { destination: 'http://localhost/dav/home/copied.txt' } }],
      ['PROPPATCH', '/dav/home/keep.txt', { body: '<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:getlastmodified>Mon, 01 Jan 2001 00:00:00 GMT</D:getlastmodified></D:prop></D:set></D:propertyupdate>' }],
      ['LOCK', '/dav/home/keep.txt', { body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope></D:lockinfo>' }],
      ['LOCK', '/dav/home/fresh.txt', { body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope></D:lockinfo>' }],
    ]
    for (const [method, path, init] of refused) {
      const res = await r.req(method, path, init)
      expect(`${method} ${path} ${res.status} ${res.headers.get('x-error-code')}`).toBe(`${method} ${path} 403 auth.dav-read-only`)
    }
    expect(readFileSync(home('dv-rd', 'keep.txt'), 'utf8')).toBe('keep')
    expect(readdirSync(home('dv-rd')).sort()).toEqual(['folder', 'keep.txt'])
    // the same account, with the other password, can
    expect((await w.dav.put('/dav/home/new.txt', 'x')).status).toBe(201)
  })

  test('a read password is limited by the account too: a grant with view stays view', async () => {
    const owner = await davUser('dv-rg1')
    const rec = await davUser('dv-rg2')
    mkdirSync(home('dv-rg1', 'proj'))
    writeFileSync(home('dv-rg1', 'proj', 'a.txt'), 'A')
    const made = await owner.web.json('POST', '/api/grants', { space: 'home', path: '/proj', to: 'dv-rg2', perms: 'edit' })
    expect(made.status).toBe(200)
    expect((await rec.dav.put('/dav/shared/proj/b.txt', 'B')).status).toBe(201)
    const ro = await rec.web.json('POST', '/api/me/app-passwords', { name: 'ro', scope: 'read', password: PW })
    const reader = new Dav('dv-rg2', ro.data.secret)
    expect((await reader.get('/dav/shared/proj/b.txt')).text).toBe('B')
    expect((await reader.put('/dav/shared/proj/c.txt', 'C')).status).toBe(403)
  })
})

// ───────────────────────────── namespace ─────────────────────────────

describe('webdav: shared folders and the registry', () => {
  test('/dav/shared lists the folders shared with me, by name, and limits me to the grant', async () => {
    const o1 = await davUser('dv-sh1')
    const o2 = await davUser('dv-sh2')
    const me = await davUser('dv-sh3', 'readwrite', { quotaBytes: 100 })
    expect(await me.dav.hrefs('/dav/')).toEqual(['/dav/', '/dav/home/'])
    expect((await me.dav.propfind('/dav/shared/', '1')).status).toBe(404)
    for (const [o, perms] of [[o1, 'view'], [o2, 'edit']] as const) {
      mkdirSync(home(o.username, 'Photos'), { recursive: true })
      writeFileSync(home(o.username, 'Photos', 'x.txt'), 'x')
      writeFileSync(home(o.username, 'secret.txt'), 'secret')
      expect((await o.web.json('POST', '/api/grants', { space: 'home', path: '/Photos', to: 'dv-sh3', perms })).status).toBe(200)
    }
    expect(await me.dav.hrefs('/dav/')).toEqual(['/dav/', '/dav/home/', '/dav/shared/'])
    // the same name twice: the second gets a suffix, in the order the folders were shared
    expect(await me.dav.hrefs('/dav/shared/')).toEqual(['/dav/shared/', '/dav/shared/Photos/', '/dav/shared/Photos%20(2)/'].map(decodeURIComponent))
    expect(await me.dav.hrefs('/dav/shared/Photos/')).toEqual(['/dav/shared/Photos/', '/dav/shared/Photos/x.txt'])
    expect((await me.dav.get('/dav/shared/Photos/x.txt')).text).toBe('x')
    // only inside the shared folder
    expect((await me.dav.get('/dav/shared/Photos/../secret.txt')).status).toBe(404)
    expect((await me.dav.get('/dav/shared/Photos/%2e%2e/secret.txt')).status).toBe(404)
    // view: nothing can be changed; edit: it can, and the owner's quota is used, not mine
    expect((await me.dav.put('/dav/shared/x.txt', 'n')).status).toBe(403)
    expect((await me.dav.put('/dav/shared/Photos/new.txt', 'n')).status).toBe(403)
    expect(await me.dav.status('DELETE', '/dav/shared/Photos/x.txt')).toBe(403)
    expect(await me.dav.status('MKCOL', '/dav/shared/Photos/d')).toBe(403)
    expect(await me.dav.status('DELETE', '/dav/shared/Photos')).toBe(403)
    expect((await me.dav.put('/dav/shared/Photos%20(2)/new.txt', new Uint8Array(500))).status).toBe(201)
    expect(readFileSync(home('dv-sh2', 'Photos', 'new.txt')).length).toBe(500)
    expect(await me.dav.status('DELETE', '/dav/shared/Photos%20(2)/new.txt')).toBe(204)
    // a move between the two shared folders is a copy and a trash, and needs the rights on both
    expect(await me.dav.status('MOVE', '/dav/shared/Photos%20(2)/x.txt', { headers: { destination: 'http://localhost/dav/shared/Photos/y.txt' } })).toBe(403)
    // taking the grant back removes the folder
    const grant = grantsMod.allGrants().find(g => g.owner === 'dv-sh1')!
    grantsMod.removeGrant(grant)
    expect(await me.dav.hrefs('/dav/shared/')).toEqual(['/dav/shared/', '/dav/shared/Photos/'])
    expect((await me.dav.get('/dav/shared/Photos/x.txt')).text).toBe('x')
    expect(await me.dav.status('GET', '/dav/shared/Photos%20(2)/x.txt')).toBe(404)
  })

  test('a module can register a folder of spaces (user groups do): names are made safe and unique, an empty folder is left out', async () => {
    const u = await davUser('dv-reg1', 'readwrite', { publicPermissions: ['read', 'download'] })
    const seen: string[] = []
    dav.registerDavFolder('dv-groups', user => {
      seen.push(user.username)
      return user.username === 'dv-reg1' ? [{ name: 'Team/A', space: 'public' }, { name: 'Team/A', space: 'home' }, { name: 'bad', space: 'user:dv-reg1' }] : []
    })
    expect(() => dav.registerDavFolder('dv-groups', () => [])).toThrow()
    expect(() => dav.registerDavSpace('home', () => 'home')).toThrow()
    writeFileSync(join(paths.publicDir, 'dv-reg.txt'), 'pub')
    try {
      expect(await u.dav.hrefs('/dav/')).toEqual(['/dav/', '/dav/home/', '/dav/public/', '/dav/dv-groups/'])
      expect(await u.dav.hrefs('/dav/dv-groups/')).toEqual(['/dav/dv-groups/', '/dav/dv-groups/Team_A/', '/dav/dv-groups/Team_A (2)/'])
      expect((await u.dav.get('/dav/dv-groups/Team_A/dv-reg.txt')).text).toBe('pub')
      // the staff view of a home (user:<name>) is never a place for WebDAV, even when a module offers it
      expect(await u.dav.status('PROPFIND', '/dav/dv-groups/bad/', { headers: { depth: '0' } })).toBe(404)
      // the rights are the space's: public is read-only for this user
      expect((await u.dav.put('/dav/dv-groups/Team_A/no.txt', 'x')).status).toBe(403)
      const other = await davUser('dv-reg2')
      expect(await other.dav.hrefs('/dav/')).toEqual(['/dav/', '/dav/home/'])
      expect(await other.dav.status('PROPFIND', '/dav/dv-groups/', { headers: { depth: '0' } })).toBe(404)
    } finally {
      rmSync(join(paths.publicDir, 'dv-reg.txt'), { force: true })
    }
  })
})

// ───────────────────────────── security ─────────────────────────────

describe('webdav: paths', () => {
  test('dot segments, encoded slashes, backslashes and NUL never reach another place', async () => {
    const a = await davUser('dv-sec1')
    const b = await davUser('dv-sec2')
    writeFileSync(home('dv-sec2', 'private.txt'), 'private')
    writeFileSync(home('dv-sec1', 'mine.txt'), 'mine')
    const outside = join(process.env.STORAGE_DIR!, '..', 'dv-outside.txt')
    writeFileSync(outside, 'outside')
    const attacks = [
      '/dav/home/%2e%2e/dv-sec2/private.txt', '/dav/home/%2e%2e/%2e%2e/users/dv-sec2/private.txt', '/dav/home/..%2fdv-sec2%2fprivate.txt',
      '/dav/home/%2e%2e%2f%2e%2e%2fusers%2fdv-sec2%2fprivate.txt', '/dav/home/a%5c..%5c..%5cdv-sec2%5cprivate.txt', '/dav/home/%2E%2E%2Fx',
      '/dav/home/mine.txt%00.png', '/dav/home/a%00b', '/dav/home/..\\..\\x', '/dav/home/%252e%252e/private.txt', '/dav/users/dv-sec2/private.txt',
      '/dav/home/../../../etc/passwd', '/dav/%2e%2e/%2e%2e/dv-outside.txt', '/dav/home/%c0%ae%c0%ae/x',
    ]
    for (const path of attacks) {
      for (const method of ['GET', 'PROPFIND', 'PUT', 'DELETE', 'MKCOL']) {
        const res = await a.dav.req(method, path, { headers: { depth: '0' }, body: method === 'PUT' ? 'pwned' : undefined })
        const body = await res.text()
        // the URL parser collapses some of these out of /dav altogether (the page answers there, with nothing of ours)
        const stillDav = new URL(path, 'http://localhost').pathname.startsWith('/dav')
        expect(`${method} ${path} ${!stillDav || res.status >= 400 || (method === 'PROPFIND' && res.status === 207 && !body.includes('private'))}`).toBe(`${method} ${path} true`)
        expect(body).not.toContain('private')
        expect(body).not.toContain('outside')
      }
    }
    expect(readFileSync(home('dv-sec2', 'private.txt'), 'utf8')).toBe('private')
    expect(existsSyncSafe(home('dv-sec2', 'dv-sec2'))).toBe(false)
    expect(readFileSync(outside, 'utf8')).toBe('outside')
    // the same through the Destination of a MOVE and COPY
    for (const dest of ['/dav/home/%2e%2e/dv-sec2/stolen.txt', '/dav/home/a%2f..%2f..%2fdv-sec2/stolen.txt', 'http://localhost/dav/home/x%5c..%5cy']) {
      for (const method of ['MOVE', 'COPY']) {
        const code = await a.dav.status(method, '/dav/home/mine.txt', { headers: { destination: dest } })
        expect(`${method} ${dest} ${code >= 400}`).toBe(`${method} ${dest} true`)
      }
    }
    expect(readFileSync(home('dv-sec1', 'mine.txt'), 'utf8')).toBe('mine')
    expect(existsSyncSafe(home('dv-sec2', 'stolen.txt'))).toBe(false)
    // each sees only their own
    expect(await a.dav.hrefs('/dav/home/')).toEqual(['/dav/home/', '/dav/home/mine.txt'])
    expect(await b.dav.hrefs('/dav/home/')).toEqual(['/dav/home/', '/dav/home/private.txt'])
    rmSync(outside, { force: true })
  })

  test('a link inside the home that leads outside it is not followed, for reading or writing', async () => {
    const u = await davUser('dv-sec3')
    const outside = join(process.env.STORAGE_DIR!, '..', 'dv-linked')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'target.txt'), 'outside')
    symlinkSync(outside, home('dv-sec3', 'link'))
    symlinkSync(join(outside, 'target.txt'), home('dv-sec3', 'filelink.txt'))
    for (const [method, path] of [['GET', '/dav/home/link/target.txt'], ['PROPFIND', '/dav/home/link/'], ['PUT', '/dav/home/link/new.txt'], ['MKCOL', '/dav/home/link/d'], ['DELETE', '/dav/home/link/target.txt'], ['GET', '/dav/home/filelink.txt']]) {
      const res = await u.dav.req(method, path, { headers: { depth: '0' }, body: method === 'PUT' ? 'x' : undefined })
      expect(`${method} ${path} ${res.status}`).toMatch(/ (403|404)$/)
    }
    expect(readdirSync(outside)).toEqual(['target.txt'])
    expect(readFileSync(join(outside, 'target.txt'), 'utf8')).toBe('outside')
    // a link is not listed
    expect(await u.dav.hrefs('/dav/home/')).toEqual(['/dav/home/'])
    // a COPY into the link, and a move of the link's content
    writeFileSync(home('dv-sec3', 'ok.txt'), 'ok')
    expect([403, 404, 409]).toContain(await u.dav.status('COPY', '/dav/home/ok.txt', { headers: { destination: 'http://localhost/dav/home/link/ok.txt' } }))
    expect(existsSyncSafe(join(outside, 'ok.txt'))).toBe(false)
    rmSync(outside, { recursive: true, force: true })
  })

  test('answers carry the hardening headers, and error texts follow the language of the request', async () => {
    const u = await davUser('dv-sec4')
    const res = await u.dav.req('PROPFIND', '/dav/home/', { headers: { depth: '0' } })
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const en = await u.dav.req('GET', '/dav/home/missing.txt', { headers: { 'x-lang': 'en' } })
    expect(en.status).toBe(404)
    expect(await en.text()).toBe('The item was not found.')
    const th = await u.dav.req('GET', '/dav/home/missing.txt')
    expect(await th.text()).toBe('ไม่พบรายการที่ระบุ')
  })
})

function existsSyncSafe(p: string) {
  return existsSync(p)
}

// ───────────────────────────── a real server ─────────────────────────────

describe('webdav: over a real connection', () => {
  async function serve<T>(fn: (base: string) => Promise<T>): Promise<T> {
    app.listen({ port: 0, hostname: '127.0.0.1' })
    try {
      return await fn(`http://127.0.0.1:${app.server.port}`)
    } finally {
      await app.stop()
    }
  }
  const auth_ = (u: Dav) => ({ authorization: basic(u.username, u.secret) })

  test('PROPFIND, a chunked PUT without Content-Length, and every method name reach the handler', async () => {
    const u = await davUser('dv-net1')
    await serve(async base => {
      const pf = await fetch(`${base}/dav/`, { method: 'PROPFIND', headers: { ...auth_(u.dav), depth: '1' } })
      expect(pf.status).toBe(207)
      expect(await pf.text()).toContain('/dav/home/')
      // a stream has no length: the request goes out chunked
      let n = 0
      const stream = new ReadableStream({ pull(c) { if (n++ < 5) c.enqueue(new TextEncoder().encode('chunk-' + n + ';')); else c.close() } })
      const put = await fetch(`${base}/dav/home/chunked.txt`, { method: 'PUT', body: stream, headers: auth_(u.dav), duplex: 'half' } as any)
      expect(put.status).toBe(201)
      expect(readFileSync(home('dv-net1', 'chunked.txt'), 'utf8')).toBe('chunk-1;chunk-2;chunk-3;chunk-4;chunk-5;')
      for (const method of ['MKCOL', 'LOCK', 'UNLOCK', 'PROPPATCH', 'COPY', 'MOVE']) {
        const r = await fetch(`${base}/dav/home/zz`, { method, headers: auth_(u.dav) })
        expect(`${method} ${r.status}`).not.toBe(`${method} 404`)
        expect(r.headers.get('www-authenticate')).toBeNull()
      }
      // the client's own address is the one that counts in the lockout
      const bad = await fetch(`${base}/dav/`, { method: 'OPTIONS', headers: { authorization: basic('dv-net1', 'fc-' + 'z'.repeat(32)) } })
      expect(bad.status).toBe(401)
      auth.clearFailures('dav|127.0.0.1|dv-net1')
    })
  })

  test('a file of 100 MB streams to disk, announced or not, and the server\'s memory stays flat', async () => {
    // a server of its own, so that its memory is measured without the test client in it (Linux: /proc)
    if (!existsSync('/proc/self/status')) return
    const dir = mkdtempSync(join(tmpdir(), 'fc-dav-mem-'))
    const child = Bun.spawn(['bun', join(import.meta.dir, 'dav-server.ts')], {
      env: { ...process.env, STORAGE_DIR: join(dir, 'storage'), DATA_DIR: join(dir, 'data'), ADMIN_PASSWORD: 'test-admin-pass', UPDATE_SOURCE: 'off' },
      stdout: 'pipe', stderr: 'inherit',
    })
    try {
      let seen = ''
      const reader = child.stdout.getReader()
      while (!seen.includes('READY ')) {
        const { done, value } = await reader.read()
        if (done) throw new Error('the test server did not start')
        seen += new TextDecoder().decode(value)
      }
      const { port, secret } = JSON.parse(seen.slice(seen.indexOf('READY ') + 6).split('\n')[0])
      const peak = () => Number(readFileSync(`/proc/${child.pid}/status`, 'utf8').match(/VmHWM:\s+(\d+)/)![1]) * 1024
      const chunk = new Uint8Array(MB).fill(7)
      const total = 100
      const before = peak()
      for (const announce of [false, true]) {
        const name = announce ? 'known.bin' : 'unknown.bin'
        let sent = 0
        const body = new ReadableStream({ pull(c) { if (sent++ < total) c.enqueue(chunk); else c.close() } })
        const headers: Record<string, string> = { authorization: basic('admin', secret) }
        if (announce) headers['content-length'] = String(total * MB)
        const res = await fetch(`http://127.0.0.1:${port}/dav/home/${name}`, { method: 'PUT', body, headers, duplex: 'half' } as any)
        expect(res.status).toBe(201)
        expect(statSync(join(dir, 'storage', name)).size).toBe(total * MB)
      }
      // 100 MB held in memory, even once, would show here; the buffers of a stream are a few MB
      expect(peak() - before).toBeLessThan(40 * MB)
      expect(readdirSync(join(dir, 'data', 'tmp')).filter(n => n.startsWith('dav-'))).toEqual([])
    } finally {
      child.kill()
      await child.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('every other route keeps today\'s body limit: a JSON body or a chunk over it is refused, announced or not', async () => {
    const { BODY_LIMIT } = await import('../src/index')
    expect(BODY_LIMIT).toBe(config.uploadChunkSize * 2 + MB)
    const u = await davUser('dv-net3')
    const big = new Uint8Array(20 * MB)
    await serve(async base => {
      const cookie = { cookie: u.web.cookie, 'x-csrf-token': u.web.csrf }
      // announced (Content-Length): refused before a byte is read
      const json = await fetch(`${base}/api/mkdir`, { method: 'POST', body: big, headers: { ...cookie, 'content-type': 'application/json' } })
      expect(json.status).toBe(413)
      expect((await json.json()).code).toBe('request.too-big')
      const init = await u.web.json('POST', '/api/upload', { space: 'home', path: '/', name: 'big.bin', size: 20 * MB })
      expect(init.status).toBe(200)
      const chunk = await fetch(`${base}/api/upload/${init.data.id}/0`, { method: 'PUT', body: big, headers: { ...cookie, 'content-type': 'application/octet-stream' } })
      expect(chunk.status).toBe(413)
      // not announced (a stream, so chunked): counted while it comes
      for (const [path, type] of [['/api/mkdir', 'application/json'], [`/api/upload/${init.data.id}/0`, 'application/octet-stream'], ['/api/login', 'text/plain']] as const) {
        let sent = 0
        const stream = new ReadableStream({ pull(c) { if (sent++ < 20) c.enqueue(new Uint8Array(MB)); else c.close() } })
        const r = await fetch(`${base}${path}`, { method: path.includes('upload') ? 'PUT' : 'POST', body: stream, headers: { ...cookie, 'content-type': type }, duplex: 'half' } as any)
        expect(`${path} ${r.status} ${(await r.json().catch(() => ({}))).code}`).toBe(`${path} 413 request.too-big`)
      }
      // a normal chunk (the size the page sends) still goes through
      const ok = await fetch(`${base}/api/upload/${init.data.id}/0`, { method: 'PUT', body: new Uint8Array(MB), headers: { ...cookie, 'content-type': 'application/octet-stream' } })
      expect(ok.status).toBe(200)
      await u.web.json('DELETE', `/api/upload/${init.data.id}`)
      // and /dav is the one place that takes more than that
      const dav = await fetch(`${base}/dav/home/over-limit.bin`, { method: 'PUT', body: big, headers: auth_(u.dav) })
      expect(dav.status).toBe(201)
    })
    expect(statSync(home('dv-net3', 'over-limit.bin')).size).toBe(20 * MB)
  }, 60_000)
})

describe('webdav: group folders', () => {
  test('/dav/groups lists my groups; view reads only, edit writes and fills the group quota', async () => {
    const v = await davUser('dv-gv')
    const e = await davUser('dv-ge')
    const out = await davUser('dv-go')
    const made = await admin.json('POST', '/api/admin/groups', { name: 'ทีมบัญชี', quotaBytes: 1000 })
    expect(made.status).toBe(200)
    const id = made.data.group.id as string
    expect((await admin.json('PUT', `/api/admin/groups/${id}/members`, { username: 'dv-gv', perms: 'view' })).status).toBe(200)
    expect((await admin.json('PUT', `/api/admin/groups/${id}/members`, { username: 'dv-ge', perms: 'edit' })).status).toBe(200)
    expect(await e.dav.hrefs('/dav/')).toEqual(['/dav/', '/dav/home/', '/dav/groups/'])
    expect(await e.dav.hrefs('/dav/groups/')).toEqual(['/dav/groups/', '/dav/groups/ทีมบัญชี/'])
    expect((await e.dav.put(`/dav/groups/${enc('ทีมบัญชี')}/a.txt`, new Uint8Array(600))).status).toBe(201)
    expect((await e.dav.put(`/dav/groups/${enc('ทีมบัญชี')}/b.txt`, new Uint8Array(600))).status).toBe(507)
    expect((await v.dav.get(`/dav/groups/${enc('ทีมบัญชี')}/a.txt`)).status).toBe(200)
    expect((await v.dav.put(`/dav/groups/${enc('ทีมบัญชี')}/c.txt`, 'c')).status).toBe(403)
    expect(await v.dav.status('DELETE', `/dav/groups/${enc('ทีมบัญชี')}/a.txt`)).toBe(403)
    // not a member: no groups folder at all
    expect(await out.dav.hrefs('/dav/')).toEqual(['/dav/', '/dav/home/'])
    expect((await out.dav.get(`/dav/groups/${enc('ทีมบัญชี')}/a.txt`)).status).toBe(404)
    // removed from the group: gone at once
    expect((await admin.json('DELETE', `/api/admin/groups/${id}/members/dv-ge`)).status).toBe(200)
    expect((await e.dav.get(`/dav/groups/${enc('ทีมบัญชี')}/a.txt`)).status).toBe(404)
  })
})

describe('webdav: security fixes (1.11)', () => {
  const propBody = (...names: string[]) =>
    `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop>${names.map(n => `<D:${n}/>`).join('')}</D:prop></D:propfind>`

  test('property names that are names on every object are unknown properties, not errors', async () => {
    const u = await davUser('dv-proto')
    writeFileSync(home('dv-proto', 'f.txt'), 'x')
    const names = ['__proto__', 'hasOwnProperty', 'constructor', 'toString', 'valueOf', 'isPrototypeOf', 'displayname']
    const r = await u.dav.propfind('/dav/home/f.txt', '0', propBody(...names))
    expect(r.status).toBe(207)
    const [x] = responsesOf(parseXml(r.text))
    expect(x.props.displayname.status).toContain('200')
    for (const n of names.slice(0, -1)) {
      // a name that is no plain element name (__proto__ is one) is answered 404 where it can be written back
      if (x.props[n]) expect([n, x.props[n].status]).toEqual([n, expect.stringContaining('404')])
    }
    expect(r.text).not.toContain('[object')
    expect(r.text).not.toContain('function')
    // entities of that kind in a value are left as they are, not looked up on Object.prototype
    const doc = parseXml('<a>&constructor; &__proto__; &toString; &amp;</a>')
    expect(doc.text).toBe('&constructor; &__proto__; &toString; &')
  })

  test('more than 50 properties asked for is a 400; 50 is fine', async () => {
    const u = await davUser('dv-many')
    writeFileSync(home('dv-many', 'f.txt'), 'x')
    const fifty = Array.from({ length: 50 }, (_, i) => `p${i}`)
    expect((await u.dav.propfind('/dav/home/f.txt', '0', propBody(...fifty))).status).toBe(207)
    const r = await u.dav.propfind('/dav/home/f.txt', '0', propBody(...fifty, 'p50'))
    expect(r.status).toBe(400)
    expect(r.res.headers.get('x-error-code')).toBe('files.dav-too-many-props')
  })

  test('a folder with WEBDAV_MAX_ITEMS entries or more is refused whole with 507 and a DAV error body; one under the limit answers', async () => {
    const u = await davUser('dv-big')
    mkdirSync(home('dv-big', 'big'), { recursive: true })
    expect(config.davMaxItems).toBe(100_000)
    const saved = config.davMaxItems
    const limit = (config.davMaxItems = 300)
    for (let i = 0; i < limit; i++) writeFileSync(home('dv-big', 'big', `f${i}`), '')
    const big = await u.dav.propfind('/dav/home/big/', '1')
    expect(big.status).toBe(507)
    expect(big.res.headers.get('content-type')).toContain('xml')
    expect(big.text).toContain('number-of-matches-within-limits')
    // one entry less (the folder itself is the other item) is the most that is answered
    rmSync(home('dv-big', 'big', 'f0'))
    const ok = await u.dav.propfind('/dav/home/big/', '1', propBody('getcontentlength'))
    expect(ok.status).toBe(207)
    expect(ok.text.match(/<D:response>/g)!.length).toBe(limit)
    // Depth 0 on the same folder is still fine
    expect((await u.dav.propfind('/dav/home/big/', '0')).status).toBe(207)
    config.davMaxItems = saved
    rmSync(home('dv-big'), { recursive: true, force: true })
  })

  test('locks are shown on their own item only, and only to their owner, in a Depth 1 listing', async () => {
    const u = await davUser('dv-lkd')
    const o = await davUser('dv-lko')
    for (const n of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(home('dv-lkd', n), 'x')
    const info = '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>'
    expect(await u.dav.status('LOCK', '/dav/home/a.txt', { body: info })).toBe(200)
    expect(await u.dav.status('LOCK', '/dav/home/c.txt', { body: info })).toBe(200)
    writeFileSync(home('dv-lko', 'a.txt'), 'x')
    expect(await o.dav.status('LOCK', '/dav/home/a.txt', { body: info })).toBe(200)
    const r = await u.dav.propfind('/dav/home/', '1', propBody('lockdiscovery'))
    const by = Object.fromEntries(responsesOf(parseXml(r.text)).map(x => [x.href, x.props.lockdiscovery?.value.children.length ?? 0]))
    expect(by).toMatchObject({ '/dav/home/a.txt': 1, '/dav/home/b.txt': 0, '/dav/home/c.txt': 1 })
  })

  test('a legacy group called ".." or "." is listed under a safe name', async () => {
    const groups = await import('../src/groups')
    const u = await davUser('dv-dots')
    const made = [groups.createGroup('..', 0, 'admin'), groups.createGroup('.', 0, 'admin'), groups.createGroup('...', 0, 'admin')]
    try {
      for (const g of made) groups.setMember(g, 'dv-dots', 'edit')
      const hrefs = await u.dav.hrefs('/dav/groups/')
      expect(hrefs.length).toBe(4)
      for (const h of hrefs) expect(h.split('/').filter(s => s === '.' || s === '..' || /^\.+$/.test(s))).toEqual([])
      expect(hrefs).toContain('/dav/groups/_/')
      expect(hrefs).toContain('/dav/groups/_ (2)/')
      // the folder under the safe name opens
      expect((await u.dav.propfind('/dav/groups/_/', '1')).status).toBe(207)
    } finally {
      for (const g of made) groups.removeGroup(g)
    }
  })
})
