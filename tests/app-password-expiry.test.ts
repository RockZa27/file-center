/**
 * Optional lifetime of an app password (src/app-passwords.ts, src/routes/app-passwords.ts): an expired one does not sign
 * in to WebDAV, not even from the one-minute cache, and an old record without the field goes on working. Users: "ax-".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import './in-process-env'

let app: any
let config: typeof import('../src/config').config
let pw: typeof import('../src/app-passwords')
let auditMod: typeof import('../src/audit')
const PW = 'harbor-lamp-42'
const DAY = 86_400_000
let savedAddressMax = 0

class Web {
  cookie = ''
  csrf = ''
  async json(method: string, path: string, body?: any) {
    const h: Record<string, string> = {}
    if (this.cookie) h.cookie = this.cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    if (body !== undefined) h['content-type'] = 'application/json'
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }))
    const set = res.headers.get('set-cookie')
    if (set?.startsWith('fc_sid=')) this.cookie = set.split(';')[0]
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

const admin = new Web()
const propfind = (user: string, secret: string): Promise<number> => app.handle(new Request('http://localhost/dav/home/', {
  method: 'PROPFIND', headers: { authorization: `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`, depth: '0' },
})).then((r: Response) => r.status)

async function userWith(username: string) {
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', permissions: ['read', 'write', 'upload', 'download'], publicPermissions: [] })
  expect(r.status).toBe(200)
  mkdirSync(join(process.env.STORAGE_DIR!, 'users', username), { recursive: true })
  return new Web().login(username, PW)
}
const make = (web: Web, extra: Record<string, unknown> = {}) => web.json('POST', '/api/me/app-passwords', { name: 'n', scope: 'readwrite', password: PW, ...extra })
/** the record in the store, to edit it the way an old file or the passing of time would */
const find = (user: string, id: string) => pw.appPasswordsOf(user).find(p => p.id === id)!

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config } = await import('../src/config'))
  pw = await import('../src/app-passwords')
  auditMod = await import('../src/audit')
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
  // wrong passwords here all come from one address: the wide net must not trip
  savedAddressMax = config.loginAddressMaxAttempts
  config.loginAddressMaxAttempts = 1000
})
afterAll(() => { config.loginAddressMaxAttempts = savedAddressMax })

describe('app password expiry', () => {
  test('days: 30 sets expiresAt about 30 days ahead (answer and list); no days means null', async () => {
    const web = await userWith('ax-create')
    const before = Date.now()
    const a = await make(web, { days: 30 })
    expect(a.status).toBe(200)
    const at = Date.parse(a.data.expiresAt)
    expect(at).toBeGreaterThanOrEqual(before + 30 * DAY - 1000)
    expect(at).toBeLessThanOrEqual(Date.now() + 30 * DAY + 1000)
    const b = await make(web)
    expect(b.data.expiresAt).toBeNull()
    const c = await make(web, { days: 0 })
    expect(c.data.expiresAt).toBeNull()
    const list = (await web.json('GET', '/api/me/app-passwords')).data.items
    expect(list.find((x: any) => x.id === a.data.id).expiresAt).toBe(a.data.expiresAt)
    expect(list.find((x: any) => x.id === b.data.id).expiresAt).toBeNull()
    for (const days of [90, 180, 365]) expect((await make(web, { days })).status).toBe(200)
  })

  test('any other days is 400 auth.app-password-bad-days', async () => {
    const web = await userWith('ax-bad')
    for (const days of [7, -1, 'x', 30.5, 366]) {
      const r = await make(web, { days })
      expect(`${r.status} ${r.data.code}`).toBe('400 auth.app-password-bad-days')
    }
    expect((await web.json('GET', '/api/me/app-passwords')).data.items).toEqual([])
  })

  test('an expired app password gets 401, a fresh one works, the expired one stays in the list', async () => {
    const web = await userWith('ax-old')
    const old = await make(web, { days: 30 })
    const fresh = await make(web, { days: 30 })
    expect(await propfind('ax-old', old.data.secret)).toBe(207)
    pw.appPasswordCache.clear()
    find('ax-old', old.data.id).expiresAt = new Date(Date.now() - 1000).toISOString()
    expect(await propfind('ax-old', old.data.secret)).toBe(401)
    expect(await propfind('ax-old', fresh.data.secret)).toBe(207)
    const list = (await web.json('GET', '/api/me/app-passwords')).data.items
    expect(list.map((x: any) => x.id)).toContain(old.data.id)
  })

  test('the success cache does not carry an expired password through its minute', async () => {
    const web = await userWith('ax-cache')
    const made = await make(web, { days: 30 })
    pw.appPasswordCache.clear()
    expect(await propfind('ax-cache', made.data.secret)).toBe(207)
    expect(await propfind('ax-cache', made.data.secret)).toBe(207) // from the cache
    find('ax-cache', made.data.id).expiresAt = new Date(Date.now() - 1000).toISOString()
    expect(await propfind('ax-cache', made.data.secret)).toBe(401)
  })

  test('a record from an old file, without the field, keeps working and shows null', async () => {
    const web = await userWith('ax-legacy')
    const made = await make(web)
    delete (find('ax-legacy', made.data.id) as any).expiresAt
    pw.appPasswordCache.clear()
    expect(await propfind('ax-legacy', made.data.secret)).toBe(207)
    const list = (await web.json('GET', '/api/me/app-passwords')).data.items
    expect(list[0].expiresAt).toBeNull()
  })

  test('the audit line names the lifetime and never the secret', async () => {
    const web = await userWith('ax-audit')
    const made = await make(web, { days: 90 })
    const none = await make(web)
    const mine = Array.from(auditMod.auditEntries()).filter(e => e.user === 'ax-audit' && e.action === 'app-password-create')
    expect(mine.map(e => e.detail).sort()).toEqual(['readwrite, 90 วัน', 'readwrite, never'])
    const text = JSON.stringify(mine)
    expect(text).not.toContain(made.data.secret)
    expect(text).not.toContain(none.data.secret)
  })
})
