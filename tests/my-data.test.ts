/**
 * A signed-in person sees their own activity (GET /api/me/activity) and downloads a copy of their personal data
 * (POST /api/me/export), see src/my-data.ts. In-process, on the app of api.test.ts. Users here start with "md-".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import './in-process-env'

let app: any
let myData: typeof import('../src/my-data')
let totp: typeof import('../src/totp')
let paths: typeof import('../src/config').paths

class Client {
  cookie = ''
  csrf = ''
  async raw(method: string, path: string, body?: any) {
    const h: Record<string, string> = {}
    if (this.cookie) h.cookie = this.cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    let payload: any
    if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json' }
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: payload }))
    const set = res.headers.get('set-cookie')
    if (set?.startsWith('fc_sid=')) this.cookie = set.split(';')[0]
    return res
  }
  async json(method: string, path: string, body?: any) {
    const res = await this.raw(method, path, body)
    return { status: res.status, data: (await res.json().catch(() => null)) as any }
  }
  /** a visitor with a session token, as the browser has before it signs in */
  async start() {
    this.csrf = (await this.json('GET', '/api/session')).data.csrf
    return this
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
const admin = new Client()
const storage = (...p: string[]) => join(process.env.STORAGE_DIR!, ...p)
const made = new Set<string>()
const auditLines = () => readFileSync(paths.audit, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
let savedCooldown = 0

async function create(username: string) {
  const r = await admin.json('POST', '/api/admin/users', { username, name: `Name ${username}`, password: PW, role: 'user', permissions: PERMS, publicPermissions: [] })
  expect(r.status).toBe(200)
  made.add(username)
  mkdirSync(storage('users', username), { recursive: true })
}
async function userWith(username: string) {
  await create(username)
  return new Client().login(username, PW)
}
const exportOf = (c: Client, password = PW) => c.raw('POST', '/api/me/export', { password })
/** the cooldown does not get in the way of tests that export more than once */
const noCooldown = () => { myData.exportLimit.cooldownMs = 0 }

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  myData = await import('../src/my-data')
  totp = await import('../src/totp')
  ;({ paths } = await import('../src/config'))
  savedCooldown = myData.exportLimit.cooldownMs
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
})

afterAll(async () => {
  myData.exportLimit.cooldownMs = savedCooldown
  for (const name of made) await admin.json('DELETE', `/api/admin/users/${name}`)
  for (const name of made) rmSync(storage('users', name), { recursive: true, force: true })
})

describe('GET /api/me/activity', () => {
  test('lists the caller\'s own entries (sign-in with address, download), not another user\'s, not an admin\'s action on them', async () => {
    const a = await userWith('md-alice')
    const b = await userWith('md-bob')
    writeFileSync(storage('users', 'md-alice', 'a.txt'), 'hello')
    writeFileSync(storage('users', 'md-bob', 'b.txt'), 'bob')
    expect((await a.raw('GET', '/api/download?space=home&path=/a.txt')).status).toBe(200)
    expect((await b.raw('GET', '/api/download?space=home&path=/b.txt')).status).toBe(200)
    // an admin acts on alice's account: written under the admin's name, about alice
    expect((await admin.json('PUT', '/api/admin/users/md-alice', { name: 'Alice Renamed' })).status).toBe(200)

    const r = await a.json('GET', '/api/me/activity')
    expect(r.status).toBe(200)
    const items = r.data.items as any[]
    expect(items.some(i => i.action === 'login')).toBe(true)
    const dl = items.find(i => i.action === 'download')
    expect(dl.target).toContain('a.txt')
    expect(typeof dl.ip).toBe('string')
    expect(Object.keys(dl).sort()).toEqual(['action', 'detail', 'ip', 'target', 'ts'].filter(k => k in dl).sort())
    expect(JSON.stringify(items)).not.toContain('b.txt')
    expect(items.some(i => i.action === 'user-update' || i.action === 'user-create')).toBe(false)
    // newest first
    expect(items.map(i => i.ts)).toEqual([...items.map(i => i.ts)].sort().reverse())
    // reading the trail is not itself on the trail
    const before = auditLines().length
    await a.json('GET', '/api/me/activity')
    expect(auditLines().length).toBe(before)
  })

  test('a failed sign-in with an unknown name is nobody\'s; one with the account\'s name is theirs', async () => {
    const a = await userWith('md-carol')
    expect((await (await new Client().start()).json('POST', '/api/login', { username: 'md-nobody-here', password: 'wrong-pass-123' })).status).toBe(401)
    expect((await (await new Client().start()).json('POST', '/api/login', { username: 'md-carol', password: 'wrong-pass-123' })).status).toBe(401)
    const items = (await a.json('GET', '/api/me/activity')).data.items as any[]
    expect(items.filter(i => i.action === 'login-failed').length).toBe(1)
    expect(items.every(i => !String(i.target ?? '').startsWith('?'))).toBe(true)
  })

  test('paging: pageSize is capped at 100 and raised to 5, page moves on', async () => {
    const a = await userWith('md-paging')
    for (let i = 0; i < 7; i++) await new Client().login('md-paging', PW)
    const p1 = (await a.json('GET', '/api/me/activity?page=1&pageSize=5')).data
    expect(p1.items.length).toBe(5)
    expect(p1.hasMore).toBe(true)
    const p2 = (await a.json('GET', '/api/me/activity?page=2&pageSize=5')).data
    expect(p2.items.length).toBeGreaterThan(0)
    expect(p2.items[0].ts <= p1.items[4].ts).toBe(true)
    expect((await a.json('GET', '/api/me/activity?pageSize=100000')).data.items.length).toBeLessThanOrEqual(100)
    expect((await a.json('GET', '/api/me/activity?pageSize=1')).data.items.length).toBe(5)
  })

  test('an account with no valid creation time sees nothing (fails closed); an entry with no valid time is left out', () => {
    const e = (ts: string, user = 'md-x') => ({ ts, user, ip: '1.2.3.4', action: 'login' })
    for (const createdAt of [undefined, '', 'not a date'] as any[]) {
      const own = myData.ownEntries({ username: 'md-x', createdAt })
      expect([e('2020-01-01T00:00:00.000Z'), e('2030-01-01T00:00:00.000Z')].filter(own)).toEqual([])
    }
    const own = myData.ownEntries({ username: 'md-x', createdAt: '2025-01-01T00:00:00.000Z' })
    expect([e('2024-12-31T23:59:59.999Z'), e('2025-01-01T00:00:00.000Z'), e('garbage'), e('2026-01-01T00:00:00.000Z', 'md-y')].filter(own).map(r => r.ts))
      .toEqual(['2025-01-01T00:00:00.000Z'])
  })

  test('a new account with the name of a deleted one does not see the old person\'s entries', async () => {
    const old = await userWith('md-old')
    expect((await old.json('GET', '/api/me/activity')).data.items.some((i: any) => i.action === 'login')).toBe(true)
    expect((await admin.json('DELETE', '/api/admin/users/md-old')).status).toBe(200)
    await sleep(15)
    const fresh = await userWith('md-old')
    const items = (await fresh.json('GET', '/api/me/activity')).data.items as any[]
    const created = Date.parse(JSON.parse(readFileSync(paths.users, 'utf8')).users.find((u: any) => u.username === 'md-old').createdAt)
    expect(items.length).toBeGreaterThan(0) // its own sign-in
    expect(items.every(i => Date.parse(i.ts) >= created)).toBe(true)
    expect(items.filter(i => i.action === 'login').length).toBe(1)
    // the export follows the same cut
    noCooldown()
    const file = JSON.parse(await (await exportOf(fresh)).text())
    expect(file.activity.every((i: any) => Date.parse(i.ts) >= created)).toBe(true)
    expect(file.activity.filter((i: any) => i.action === 'login').length).toBe(1)
  })

  test('not signed in: 401', async () => {
    expect((await new Client().json('GET', '/api/me/activity')).status).toBe(401)
  })
})

describe('POST /api/me/export', () => {
  test('a wrong password: 403, an export-denied entry, no file', async () => {
    const c = await userWith('md-wrong')
    noCooldown()
    const res = await exportOf(c, 'not-the-password')
    expect(res.status).toBe(403)
    expect(res.headers.get('content-disposition')).toBeNull()
    expect(auditLines().some(l => l.user === 'md-wrong' && l.action === 'export-denied')).toBe(true)
    expect(auditLines().some(l => l.user === 'md-wrong' && l.action === 'data-export')).toBe(false)
  })

  test('the file holds the person\'s data and none of the secrets', async () => {
    noCooldown()
    const peer = await userWith('md-peer')
    const c = await userWith('md-full')
    // two-factor on, an app password, a share link, grants both ways, a favorite
    const setup = await c.json('POST', '/api/2fa/setup', { password: PW })
    expect(setup.status).toBe(200)
    expect((await c.json('POST', '/api/2fa/enable', { code: totp.totpAt(setup.data.secret, totp.stepOf(Date.now())) })).status).toBe(200)
    const ap = await c.json('POST', '/api/me/app-passwords', { name: 'laptop', scope: 'read', password: PW })
    expect(ap.status).toBe(200)
    writeFileSync(storage('users', 'md-full', 'f.txt'), 'x')
    mkdirSync(storage('users', 'md-full', 'shared'), { recursive: true })
    mkdirSync(storage('users', 'md-peer', 'theirs'), { recursive: true })
    const sh = await c.json('POST', '/api/shares', { space: 'home', path: '/f.txt', days: 7 })
    expect(sh.status).toBe(200)
    expect((await c.json('POST', '/api/grants', { space: 'home', path: '/shared', to: 'md-peer', perms: 'view' })).status).toBe(200)
    expect((await peer.json('POST', '/api/grants', { space: 'home', path: '/theirs', to: 'md-full', perms: 'edit' })).status).toBe(200)
    expect((await c.json('POST', '/api/me/favorites', { space: 'home', path: '/f.txt' })).status).toBe(200)

    const res = await exportOf(c)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="file-center-md-full-${new Date().toISOString().slice(0, 10)}.json"`)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const text = await res.text()
    const file = JSON.parse(text)

    expect(file.account).toMatchObject({ username: 'md-full', name: 'Name md-full', role: 'user', twoFactorEnabled: true })
    expect(typeof file.account.createdAt).toBe('string')
    expect(file.appPasswords.map((p: any) => p.name)).toEqual(['laptop'])
    expect(file.sessions.length).toBeGreaterThan(0)
    expect(file.shareLinks.map((s: any) => s.path)).toEqual(['/f.txt'])
    expect(file.grantsGiven.map((g: any) => [g.to, g.perms])).toEqual([['md-peer', 'view']])
    expect(file.grantsReceived.map((g: any) => [g.from, g.perms])).toEqual([['md-peer', 'edit']])
    expect(file.favorites.map((f: any) => f.path)).toEqual(['/f.txt'])
    expect(Array.isArray(file.recent)).toBe(true)
    expect(file.notifications.events).toBeDefined()
    expect(file.activity.some((i: any) => i.action === 'login')).toBe(true)
    expect(file.activity.every((i: any) => !('user' in i))).toBe(true)
    expect(file.activityTruncated).toBe(false)
    expect(file.generatedAt).toBeString()
    expect(file.note.th).toBeString()
    expect(file.note.en).toBeString()

    // nothing in the text that works as a key
    const user = JSON.parse(readFileSync(paths.users, 'utf8')).users.find((u: any) => u.username === 'md-full')
    const secrets = [
      user.passwordHash, user.twoFactor.secret, setup.data.secret, ...user.twoFactor.backup,
      c.cookie.split('=')[1], sh.data.token, ap.data.secret, ap.data.secret.slice(3),
    ]
    const hashes = JSON.parse(readFileSync(paths.appPasswords, 'utf8')).items.map((p: any) => p.hash)
    const shareFile = JSON.parse(readFileSync(paths.shares, 'utf8')).shares
    for (const s of [...secrets, ...hashes, ...shareFile.flatMap((s: any) => [s.tokenHash, s.tokenSealed])]) {
      if (s) expect(text.includes(s)).toBe(false)
    }
    expect(text).not.toMatch(/passwordHash|tokenHash|tokenSealed|"secret"/)

    // audited, with no content
    const entry = auditLines().filter(l => l.user === 'md-full' && l.action === 'data-export').pop()
    expect(entry).toBeDefined()
    expect(entry.detail).toBeUndefined()
  })

  test('activity in the file is capped and says so', async () => {
    noCooldown()
    const c = await userWith('md-cap')
    for (let i = 0; i < 4; i++) await new Client().login('md-cap', PW)
    const saved = myData.exportLimit.activityMax
    try {
      myData.exportLimit.activityMax = 3
      const file = JSON.parse(await (await exportOf(c)).text())
      expect(file.activity.length).toBe(3)
      expect(file.activityTruncated).toBe(true)
    } finally { myData.exportLimit.activityMax = saved }
    expect(saved).toBe(50_000)
  })

  test('a second export within the cooldown: 429 me.export-cooldown with seconds; the cooldown is per account', async () => {
    myData.exportLimit.cooldownMs = 60_000
    const c = await userWith('md-rate')
    const other = await userWith('md-rate2')
    expect((await exportOf(c)).status).toBe(200)
    const again = await c.json('POST', '/api/me/export', { password: PW })
    expect(again.status).toBe(429)
    expect(again.data.code).toBe('me.export-cooldown')
    expect(again.data.params.seconds).toBeGreaterThan(0)
    expect(again.data.error).toContain(String(again.data.params.seconds))
    // a wrong password still gets the password answer first
    expect((await exportOf(c, 'not-the-password')).status).toBe(403)
    expect((await exportOf(other)).status).toBe(200)
    myData.exportLimit.cooldownMs = 20
    await sleep(40)
    expect((await exportOf(c)).status).toBe(200)
    noCooldown()
  })

  test('not signed in: 401; a CSRF token is needed like for every other POST', async () => {
    expect((await (await new Client().start()).json('POST', '/api/me/export', { password: PW })).status).toBe(401)
    const c = await userWith('md-csrf')
    c.csrf = ''
    const r = await c.json('POST', '/api/me/export', { password: PW })
    expect(r.status).toBe(403)
    expect(r.data.code).toBe('csrf')
    expect(auditLines().some(l => l.user === 'md-csrf' && l.action === 'data-export')).toBe(false)
  })
})
