/**
 * Storage quota per user (src/quota.ts). Runs in-process on the same app as api.test.ts (see in-process-env.ts);
 * every user here starts with "qt-". The count of a home is kept for a minute, so a test that puts files on disk by
 * hand marks it stale (quota.markStale) the way a delete through the API does.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import './in-process-env'

let app: any
let quota: typeof import('../src/quota')
let uploads: typeof import('../src/uploads')
let config: typeof import('../src/config').config
let paths: typeof import('../src/config').paths

class Client {
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

async function userWith(username: string, quotaBytes: number | undefined, publicPermissions: string[] = []) {
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', permissions: PERMS, publicPermissions, quotaBytes })
  expect(r.status).toBe(200)
  return new Client().login(username, PW)
}

const announce = (c: Client, name: string, size: number, space = 'home') => c.json('POST', '/api/upload', { space, path: '/', name, size })
const chunk = (c: Client, id: string, data: Uint8Array) => c.raw('PUT', `/api/upload/${id}/0`, data, { 'content-type': 'application/octet-stream' })
const complete = (c: Client, id: string) => c.json('POST', `/api/upload/${id}/complete`)
const usage = (c: Client) => c.json('GET', '/api/me/usage')
/** the usage answer after the count has finished: the endpoint itself never waits for it */
async function settled(c: Client, username: string) {
  await quota.ready((await import('../src/auth')).findUser(username))
  return (await usage(c)).data
}
/** put a file of `size` bytes in the home and tell the quota the count is out of date */
function fill(user: string, name: string, size: number) {
  writeFileSync(home(user, name), new Uint8Array(size))
  quota.markStale(user)
}
const full = (r: { status: number; data: any }) => ({ status: r.status, code: r.data?.code })
const EXCEEDED = { status: 507, code: 'quota.exceeded' }

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config, paths } = await import('../src/config'))
  quota = await import('../src/quota')
  uploads = await import('../src/uploads')
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
})

describe('quota: setting it', () => {
  test('set when a user is made or changed, shown in the user list, 0 takes it away', async () => {
    await userWith('qt-set', 5000)
    const list = () => admin.json('GET', '/api/admin/users').then(r => r.data.users.find((u: any) => u.username === 'qt-set'))
    expect((await list()).quotaBytes).toBe(5000)
    expect((await admin.json('PUT', '/api/admin/users/qt-set', { quotaBytes: 9000 })).status).toBe(200)
    expect((await list()).quotaBytes).toBe(9000)
    // a change that leaves the quota out keeps it
    expect((await admin.json('PUT', '/api/admin/users/qt-set', { name: 'Set' })).status).toBe(200)
    expect((await list()).quotaBytes).toBe(9000)
    expect((await admin.json('PUT', '/api/admin/users/qt-set', { quotaBytes: 0 })).status).toBe(200)
    expect((await list()).quotaBytes).toBe(0)
    expect((await list()).passwordHash).toBeUndefined()
  })

  test('whole bytes from 0 to 2^50 only', async () => {
    await userWith('qt-bad', undefined)
    for (const q of [-1, 1.5, 2 ** 50 + 1, 1e300]) {
      const r = await admin.json('PUT', '/api/admin/users/qt-bad', { quotaBytes: q })
      expect({ q, ...full(r) }).toEqual({ q, status: 400, code: 'admin.bad-quota' })
      const made = await admin.json('POST', '/api/admin/users', { username: 'qt-bad2', name: 'x', password: PW, role: 'user', permissions: [], publicPermissions: [], quotaBytes: q })
      expect({ q, ...full(made) }).toEqual({ q, status: 400, code: 'admin.bad-quota' })
    }
    expect((await admin.json('GET', '/api/admin/users')).data.users.some((u: any) => u.username === 'qt-bad2')).toBe(false)
    expect((await admin.json('PUT', '/api/admin/users/qt-bad', { quotaBytes: 2 ** 50 })).status).toBe(200)
  })

  test('a quota change takes effect at once, whatever the cached count says', async () => {
    const c = await userWith('qt-change', 1000)
    expect(full(await announce(c, 'a.bin', 800))).toEqual({ status: 200, code: undefined })
    expect(full(await announce(c, 'b.bin', 800))).toEqual(EXCEEDED)
    await admin.json('PUT', '/api/admin/users/qt-change', { quotaBytes: 5000 })
    expect((await announce(c, 'b.bin', 800)).status).toBe(200)
  })
})

describe('quota: upload announce', () => {
  test('over quota is 507 with used and quota; what fits is accepted', async () => {
    const c = await userWith('qt-up', 100_000)
    fill('qt-up', 'old.bin', 60_000)
    const r = await announce(c, 'big.bin', 50_000)
    expect(full(r)).toEqual(EXCEEDED)
    expect(r.data.params).toEqual({ used: 60_000, quota: 100_000, usedText: '58.6 KB', quotaText: '97.7 KB' })
    expect(r.data.error).toContain('58.6 KB')
    expect((await announce(c, 'ok.bin', 40_000)).status).toBe(200)
    // nothing was left behind by the refused one
    expect(readdirSync(paths.tmp).length).toBeGreaterThanOrEqual(1)
  })

  test('a reservation is given back when the upload is cancelled', async () => {
    const c = await userWith('qt-cancel', 10_000)
    const first = await announce(c, 'a.bin', 8000)
    expect(first.status).toBe(200)
    expect(full(await announce(c, 'b.bin', 8000))).toEqual(EXCEEDED)
    expect((await c.json('DELETE', `/api/upload/${first.data.id}`)).status).toBe(200)
    expect((await announce(c, 'b.bin', 8000)).status).toBe(200)
  })

  test('a finished upload counts as used, and the next one is refused when it does not fit', async () => {
    const c = await userWith('qt-done', 10_000)
    const a = await announce(c, 'a.bin', 7000)
    expect((await chunk(c, a.data.id, new Uint8Array(7000))).status).toBe(200)
    expect((await complete(c, a.data.id)).status).toBe(200)
    expect(full(await announce(c, 'b.bin', 4000))).toEqual(EXCEEDED)
    expect(await settled(c, 'qt-done')).toMatchObject({ used: 7000, quota: 10_000 })
    expect((await announce(c, 'b.bin', 3000)).status).toBe(200)
  })

  test('two announces at the same moment can not both take the last bytes', async () => {
    const c = await userWith('qt-race', 10_000)
    const results = await Promise.all([announce(c, 'a.bin', 6000), announce(c, 'b.bin', 6000), announce(c, 'c.bin', 6000)])
    expect(results.map(r => r.status).sort()).toEqual([200, 507, 507])
  })

  test('an upload nobody finishes gives its bytes back when it is cleaned up as stale', async () => {
    const c = await userWith('qt-stale', 10_000)
    const a = await announce(c, 'a.bin', 9000)
    expect(full(await announce(c, 'b.bin', 9000))).toEqual(EXCEEDED)
    const old = new Date(Date.now() - config.uploadStaleMs - 60_000)
    utimesSync(join(paths.tmp, a.data.id, 'meta.json'), old, old)
    expect(uploads.cleanStaleUploads()).toBeGreaterThanOrEqual(1)
    expect((await announce(c, 'b.bin', 9000)).status).toBe(200)
  })

  test('the public space does not count, and neither do admins', async () => {
    const c = await userWith('qt-pub', 1000, ['read', 'upload', 'write'])
    expect((await announce(c, 'p.bin', 5000, 'public')).status).toBe(200)
    expect(full(await announce(c, 'h.bin', 5000))).toEqual(EXCEEDED)
    // an admin with a quota set has none: the limit is for the home space of a user
    expect((await admin.json('PUT', '/api/admin/users/admin', { quotaBytes: 10 })).status).toBe(200)
    expect((await announce(admin, 'qt-admin-big.bin', 5000)).status).toBe(200)
    expect((await usage(admin)).data.quota).toBe(0)
    await admin.json('PUT', '/api/admin/users/admin', { quotaBytes: 0 })
  })
})

describe('quota: other ways bytes land in a home', () => {
  test('PUT /api/content counts the growth only', async () => {
    const c = await userWith('qt-edit', 1000)
    // versions (their own tests are in tests/versions.test.ts) would count too: this is about the file's growth
    const { config } = await import('../src/config')
    const keep = config.versionsKeep
    config.versionsKeep = 0
    try {
      writeFileSync(home('qt-edit', 'note.txt'), 'x'.repeat(600))
      quota.markStale('qt-edit')
      const put = (content: string) => c.json('PUT', '/api/content', { space: 'home', path: '/note.txt', content })
      expect(full(await put('y'.repeat(1200)))).toEqual(EXCEEDED)
      expect(readFileSync(home('qt-edit', 'note.txt'), 'utf8')).toBe('x'.repeat(600))
      // 600 -> 900 grows by 300 and fits
      expect((await put('y'.repeat(900))).status).toBe(200)
      // shrinking is always fine, and gives the space back
      expect((await put('z'.repeat(100))).status).toBe(200)
      expect((await settled(c, 'qt-edit')).used).toBe(100)
      expect((await put('y'.repeat(1000))).status).toBe(200)
    } finally {
      config.versionsKeep = keep
    }
  })

  test('zip: the archive has to fit', async () => {
    const c = await userWith('qt-zip', 5000)
    fill('qt-zip', 'a.bin', 3000)
    writeFileSync(home('qt-zip', 'b.bin'), new Uint8Array(1500))
    writeFileSync(home('qt-zip', 'c.bin'), new Uint8Array(100))
    const r = await c.json('POST', '/api/zip', { space: 'home', path: '/', items: ['a.bin', 'b.bin'], name: 'both.zip' })
    expect(full(r)).toEqual(EXCEEDED)
    expect(existsSync(home('qt-zip', 'both.zip'))).toBe(false)
    // one file fits: the archive counts afterwards
    const ok = await c.json('POST', '/api/zip', { space: 'home', path: '/', items: ['c.bin'], name: 'one.zip' })
    expect(ok.status).toBe(200)
    expect((await settled(c, 'qt-zip')).used).toBeGreaterThan(4600)
  })

  test('unzip: stops at what the quota leaves, and keeps nothing', async () => {
    const c = await userWith('qt-unzip', 10_000)
    writeFileSync(home('qt-unzip', 'in.zip'), zipSync({ 'a.bin': new Uint8Array(8000).fill(7), 'b.bin': new Uint8Array(8000).fill(9) }, { level: 9 }))
    quota.markStale('qt-unzip')
    const r = await c.json('POST', '/api/unzip', { space: 'home', path: '/in.zip' })
    expect(full(r)).toEqual(EXCEEDED)
    expect(existsSync(home('qt-unzip', 'in'))).toBe(false)
    // a smaller archive fits, and what came out is counted
    writeFileSync(home('qt-unzip', 'small.zip'), zipSync({ 'a.bin': new Uint8Array(3000).fill(1) }))
    quota.markStale('qt-unzip')
    const ok = await c.json('POST', '/api/unzip', { space: 'home', path: '/small.zip' })
    expect(ok.status).toBe(200)
    expect((await settled(c, 'qt-unzip')).used).toBeGreaterThanOrEqual(3000)
    // a limit of the zip itself is still the zip's own answer when the quota is not what stops it
    expect(readdirSync(home('qt-unzip', 'small')).length).toBe(1)
  })

  test('copy counts the copy, move inside the home counts nothing', async () => {
    const c = await userWith('qt-copy', 100_000)
    mkdirSync(home('qt-copy', 'dir'))
    fill('qt-copy', 'a.bin', 60_000)
    const copy = await c.json('POST', '/api/copy', { space: 'home', items: ['/a.bin'], dest: '/dir' })
    expect(copy.status).toBe(200)
    expect(copy.data.done).toBe(0)
    expect(copy.data.failed[0].error).toContain('58.6 KB')
    expect(existsSync(home('qt-copy', 'dir', 'a.bin'))).toBe(false)
    // a move is one file in a new place
    const move = await c.json('POST', '/api/move', { space: 'home', items: ['/a.bin'], dest: '/dir' })
    expect(move.data.done).toBe(1)
    expect((await settled(c, 'qt-copy')).used).toBe(60_000)
    // a folder is counted by what is in it
    const dirCopy = await c.json('POST', '/api/copy', { space: 'home', items: ['/dir'], dest: '/' })
    expect(dirCopy.data.done).toBe(0)
    writeFileSync(home('qt-copy', 'dir', 'a.bin'), new Uint8Array(30_000))
    quota.markStale('qt-copy')
    expect((await c.json('POST', '/api/copy', { space: 'home', items: ['/dir'], dest: '/' })).data.done).toBe(1)
  })

  test('copying inside the public space is not counted against the home', async () => {
    const c = await userWith('qt-pubcopy', 1000, ['read', 'write', 'upload'])
    writeFileSync(join(paths.publicDir, 'qt-big.bin'), new Uint8Array(5000))
    const r = await c.json('POST', '/api/copy', { space: 'public', items: ['/qt-big.bin'], dest: '/' })
    expect(r.data.done).toBe(1)
  })

  test('restoring from the trash counts again', async () => {
    const c = await userWith('qt-trash', 10_000)
    fill('qt-trash', 'big.bin', 8000)
    expect((await c.json('POST', '/api/delete', { space: 'home', items: ['/big.bin'] })).data.done).toBe(1)
    // the trash is outside the home: the space is free at once
    expect((await settled(c, 'qt-trash')).used).toBe(0)
    fill('qt-trash', 'other.bin', 5000)
    const item = (await admin.json('GET', '/api/admin/trash')).data.items.find((i: any) => i.originalPath === '/users/qt-trash/big.bin')
    expect(full(await admin.json('POST', '/api/admin/trash/restore', { id: item.id }))).toEqual(EXCEEDED)
    expect(existsSync(home('qt-trash', 'big.bin'))).toBe(false)
    // there is room again after a delete
    await c.json('POST', '/api/delete', { space: 'home', items: ['/other.bin'] })
    expect((await admin.json('POST', '/api/admin/trash/restore', { id: item.id })).status).toBe(200)
    expect(existsSync(home('qt-trash', 'big.bin'))).toBe(true)
  })

  test('deleting gives the space back at once', async () => {
    const c = await userWith('qt-del', 10_000)
    fill('qt-del', 'a.bin', 9000)
    expect(full(await announce(c, 'b.bin', 5000))).toEqual(EXCEEDED)
    await c.json('POST', '/api/delete', { space: 'home', items: ['/a.bin'] })
    expect((await announce(c, 'b.bin', 5000)).status).toBe(200)
  })
})

describe('quota: usage', () => {
  test('GET /api/me/usage needs a session and reports used, quota and counting', async () => {
    expect((await new Client().json('GET', '/api/me/usage')).status).toBe(401)
    const c = await userWith('qt-use', 20_000)
    fill('qt-use', 'a.bin', 1234)
    const first = await usage(c)
    expect(first.status).toBe(200)
    expect(Object.keys(first.data).sort()).toEqual(['counting', 'quota', 'used'])
    expect(first.data.quota).toBe(20_000)
    // the first answer does not wait for the count; a moment later it is there
    await quota.ready((await import('../src/auth')).findUser('qt-use'))
    expect(await usage(c).then(r => r.data)).toEqual({ used: 1234, quota: 20_000, counting: false })
    const none = await userWith('qt-nolimit', undefined)
    expect((await usage(none)).data.quota).toBe(0)
  })

  test('a home with a limit counts only the home, not the trash', async () => {
    const c = await userWith('qt-only', 10_000)
    fill('qt-only', 'a.bin', 2000)
    await c.json('POST', '/api/delete', { space: 'home', items: ['/a.bin'] })
    await quota.ready((await import('../src/auth')).findUser('qt-only'))
    expect((await usage(c)).data.used).toBe(0)
    expect(existsSync(paths.trash)).toBe(true)
  })
})

describe('quota: the message', () => {
  test('sizes read as KB/MB, the byte counts stay in the params', async () => {
    const { sizeText, text } = await import('../src/messages')
    expect(sizeText(512)).toBe('512 B')
    expect(sizeText(716_800)).toBe('700.0 KB')
    expect(sizeText(1_048_576)).toBe('1.0 MB')
    const { HttpError } = await import('../src/fsx')
    const users = (await import('../src/auth')).allUsers()
    const err = quota.exceeded({ ...users.find(u => u.role !== 'admin')!, quotaBytes: 1_048_576 })
    expect(err).toBeInstanceOf(HttpError)
    expect(err.params).toMatchObject({ quota: 1_048_576, quotaText: '1.0 MB' })
    expect(text('en', 'quota.exceeded', err.params)).toContain('of 1.0 MB used')
  })
})
