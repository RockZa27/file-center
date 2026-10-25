/**
 * The findings of the 1.13.1 security audit (Cloudflare security-audit skill, run 1 on 1.13.0): WebDAV and the 2FA
 * rule, the command line revoke seen by WebDAV, the 2FA reset and app passwords, a name used again after a backup
 * restore, one visitor holding the visitors' daily upload allowance, unzip holding the server thread, and repeated
 * PROPFIND properties. Runs in-process on the same app as api.test.ts; every user here starts with "s13-".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import './in-process-env'

let app: any
let config: typeof import('../src/config').config
let paths: typeof import('../src/config').paths
let auth: typeof import('../src/auth')
let settings: typeof import('../src/settings').settings

class Client {
  cookie = ''
  csrf = ''
  async raw(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers }
    if (this.cookie) h.cookie = this.cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    let payload: any = body
    if (body !== undefined && !(body instanceof Uint8Array) && typeof body !== 'string') {
      payload = JSON.stringify(body)
      h['content-type'] = 'application/json'
    }
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: payload }))
    const set = res.headers.get('set-cookie')
    if (set?.startsWith('fc_sid=')) this.cookie = set.split(';')[0]
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
const PERMS = ['read', 'write', 'upload', 'download', 'zip', 'share', 'batchdownload']
const admin = new Client()
const home = (user: string, ...p: string[]) => join(process.env.STORAGE_DIR!, 'users', user, ...p)

async function createUser(username: string) {
  const r = await admin.json('POST', '/api/admin/users', { username, name: `Name of ${username}`, password: PW, role: 'user', permissions: PERMS, publicPermissions: [] })
  expect(r.status).toBe(200)
}
async function userWith(username: string) {
  await createUser(username)
  return new Client().login(username, PW)
}
async function appPassword(c: Client) {
  const r = await c.json('POST', '/api/me/app-passwords', { name: 'laptop', scope: 'readwrite', password: PW })
  expect(r.status).toBe(200)
  return r.data.secret as string
}
const dav = (username: string, secret: string, method = 'PROPFIND', path = '/dav/', body?: string) =>
  app.handle(new Request('http://localhost' + path, {
    method,
    headers: { authorization: 'Basic ' + Buffer.from(`${username}:${secret}`).toString('base64'), depth: '1', ...(body ? { 'content-type': 'application/xml' } : {}) },
    body,
  })) as Promise<Response>

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config, paths } = await import('../src/config'))
  auth = await import('../src/auth')
  ;({ settings } = await import('../src/settings'))
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
})
afterAll(() => {
  settings.update({ security: undefined })
})

describe('WebDAV and the 2FA rule', () => {
  test('an app password made before the rule stops working until the user turns on 2FA', async () => {
    const bob = await userWith('s13-bob')
    const secret = await appPassword(bob)
    expect((await dav('s13-bob', secret)).status).toBe(207)
    settings.update({ security: { require2fa: 'all' } })
    try {
      expect((await bob.json('GET', '/api/me/notify-prefs')).data.code).toBe('auth.2fa-required')
      const r = await dav('s13-bob', secret)
      expect(r.status).toBe(403)
    } finally {
      settings.update({ security: undefined })
    }
    expect((await dav('s13-bob', secret)).status).toBe(207)
  })
})

describe('app passwords end with the account emergency actions', () => {
  test('an admin 2FA reset removes the WebDAV app passwords too', async () => {
    const c = await userWith('s13-carol')
    const secret = await appPassword(c)
    expect((await dav('s13-carol', secret)).status).toBe(207)
    const r = await admin.json('POST', '/api/admin/users/s13-carol/2fa/reset', { password: process.env.ADMIN_PASSWORD })
    expect(r.status).toBe(200)
    expect(r.data.appPasswords).toBe(1)
    expect((await dav('s13-carol', secret)).status).toBe(401)
  })

  test('`bun src/cli.ts sessions-revoke` is seen by WebDAV without an /api request first, and stays revoked', async () => {
    const d = await userWith('s13-dave')
    const secret = await appPassword(d)
    expect((await dav('s13-dave', secret)).status).toBe(207)
    const cli = Bun.spawnSync([process.execPath, 'src/cli.ts', 'sessions-revoke', 's13-dave'], { env: process.env, cwd: join(import.meta.dir, '..') })
    expect(cli.exitCode).toBe(0)
    expect((await dav('s13-dave', secret)).status).toBe(401)
    await Bun.sleep(50)
    const file = JSON.parse(readFileSync(paths.appPasswords, 'utf8'))
    expect(file.items.some((p: any) => p.username === 's13-dave')).toBe(false)
  })
})

describe('a name used again after a backup restore starts clean', () => {
  test('sign-ins, share links, grants and groups of the earlier account do not pass to the new one', async () => {
    const owner = await userWith('s13-alice')
    mkdirSync(home('s13-alice', 'proj'), { recursive: true })
    writeFileSync(home('s13-alice', 'proj', 'private.txt'), 'ALICE-DATA')
    const old = await userWith('s13-erin')
    writeFileSync(home('s13-erin', 'old.txt'), 'old')
    const share = await old.json('POST', '/api/shares', { space: 'home', path: '/old.txt', days: 7 })
    expect(share.status).toBe(200)
    expect((await owner.json('POST', '/api/grants', { space: 'home', path: '/proj', to: 's13-erin', perms: 'view' })).status).toBe(200)
    const group = await admin.json('POST', '/api/admin/groups', { name: 's13-team' })
    expect(group.status).toBe(200)
    const gid = group.data.group?.id ?? group.data.id
    expect((await admin.json('PUT', `/api/admin/groups/${gid}/members`, { username: 's13-erin', perms: 'edit' })).status).toBe(200)

    // what a restore of an older users.json does: the account is gone from the list, nothing else is touched
    const list = auth.allUsers()
    list.splice(list.findIndex(u => u.username === 's13-erin'), 1)
    auth.saveUsers()

    await createUser('s13-erin')
    expect((await old.json('GET', '/api/session')).data.user).toBeNull()
    expect((await new Client().json('GET', `/api/s/${share.data.token}`)).status).toBe(404)
    const fresh = await new Client().login('s13-erin', PW)
    expect((await fresh.json('GET', '/api/grants/to-me')).data.items).toEqual([])
    expect((await fresh.json('GET', '/api/groups/mine')).data.items.some((g: any) => g.name === 's13-team')).toBe(false)
  })
})

describe('the visitors\' daily upload allowance', () => {
  test('one address can hold only a part of it in uploads it announced and did not send', async () => {
    const f = await userWith('s13-frank')
    mkdirSync(home('s13-frank', 'drop'), { recursive: true })
    const link = await f.json('POST', '/api/shares', { space: 'home', path: '/drop', days: 7, kind: 'upload' })
    expect(link.status).toBe(200)
    const was = { daily: config.guestUploadDailyBytes, proxy: config.trustProxy }
    config.guestUploadDailyBytes = 4000
    ;(config as any).trustProxy = 'true'
    try {
      const announce = (ip: string, size: number) => new Client().json('POST', `/api/s/${link.data.token}/upload`, { name: 'x.bin', size }, { 'x-forwarded-for': ip })
      expect((await announce('192.0.2.1', 3000)).status).toBe(429)
      expect((await announce('192.0.2.1', 1000)).status).toBe(200)
      expect((await announce('192.0.2.1', 1)).status).toBe(429)
      // another visitor is not locked out by the first one
      expect((await announce('192.0.2.2', 1000)).status).toBe(200)
    } finally {
      config.guestUploadDailyBytes = was.daily
      ;(config as any).trustProxy = was.proxy
    }
  })
})

describe('unzip lets other requests through', () => {
  test('the server thread is not held for the whole extraction of a small zip that unpacks big', async () => {
    const g = await userWith('s13-gina')
    writeFileSync(home('s13-gina', 'bomb.zip'), zipSync({ 'zeros.bin': new Uint8Array(64 * 1024 ** 2) }, { level: 1 }))
    let ticks = 0
    const timer = setInterval(() => ticks++, 5)
    try {
      const r = await g.json('POST', '/api/unzip', { space: 'home', path: '/bomb.zip' })
      expect(r.status).toBe(200)
    } finally {
      clearInterval(timer)
    }
    expect(ticks).toBeGreaterThan(3)
  })
})

describe('PROPFIND', () => {
  test('a property asked for many times is answered once per item', async () => {
    const h = await userWith('s13-hank')
    for (let i = 0; i < 3; i++) writeFileSync(home('s13-hank', `f${i}.txt`), 'x')
    const secret = await appPassword(h)
    const body = `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop>${'<D:displayname/>'.repeat(50)}</D:prop></D:propfind>`
    const r = await dav('s13-hank', secret, 'PROPFIND', '/dav/home/', body)
    expect(r.status).toBe(207)
    const xml = await r.text()
    const items = xml.split('<D:response>').length - 1
    expect(items).toBeGreaterThan(3)
    expect(xml.split('<D:displayname').length - 1).toBe(items)
  })
})
