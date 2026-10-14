import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
// sets STORAGE_DIR, DATA_DIR, ADMIN_PASSWORD (test-admin-pass) before src/index is loaded
import './in-process-env'

let app: any
class Client {
  cookie = ''
  csrf = ''
  async raw(method: string, path: string, body?: any) {
    const h: Record<string, string> = {}
    if (this.cookie) h.cookie = this.cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    let payload: any = body
    if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json' }
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: payload }))
    const set = res.headers.get('set-cookie')
    if (set) this.cookie = set.split(';')[0]
    return res
  }
  async json(method: string, path: string, body?: any) {
    const res = await this.raw(method, path, body)
    const data = await res.json().catch(() => null)
    return { status: res.status, data }
  }
  async as(u: string, p = 'harbor-lamp-42') {
    this.csrf = (await this.json('GET', '/api/session')).data.csrf
    const r = await this.json('POST', '/api/login', { username: u, password: p })
    expect(r.status).toBe(200)
    this.csrf = r.data.csrf
    return this
  }
}

const PW = 'harbor-lamp-42'
const storage = () => process.env.STORAGE_DIR!
const admin = new Client()
let mia: Client // manager, public: read+download
let ubob: Client // plain user made by the manager
const mk = (username: string, role: string, extra: Record<string, unknown> = {}) =>
  ({ username, name: username, password: PW, role, permissions: ['read', 'write', 'upload', 'download', 'batchdownload', 'zip', 'share'], publicPermissions: [], ...extra })

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  await admin.as('admin', 'test-admin-pass')
  expect((await admin.json('POST', '/api/admin/users', mk('mia', 'manager', { publicPermissions: ['read', 'download'] }))).status).toBe(200)
  expect((await admin.json('POST', '/api/admin/users', mk('max', 'manager'))).status).toBe(200)
  expect((await admin.json('POST', '/api/admin/users', mk('boss2', 'admin'))).status).toBe(200)
  expect((await admin.json('POST', '/api/admin/users', mk('ann', 'user'))).status).toBe(200)
  mia = await new Client().as('mia')
  const made = await mia.json('POST', '/api/admin/users', mk('ubob', 'user'))
  expect(made.status).toBe(200)
  ubob = await new Client().as('ubob')
  mkdirSync(join(storage(), 'users', 'ubob', 'docs'), { recursive: true })
  writeFileSync(join(storage(), 'users', 'ubob', 'docs', 'hello.txt'), 'hello from bob')
  writeFileSync(join(storage(), 'users', 'ann', 'secret.txt'), 'ann secret')
})

const row = async (c: Client, name: string) => (await c.json('GET', '/api/admin/users')).data.users.find((u: any) => u.username === name)

describe('roles: the session carries the role', () => {
  test('a manager signs in with role manager and the same two spaces as a user', async () => {
    const s = (await mia.json('GET', '/api/session')).data
    expect(s.user.role).toBe('manager')
    expect(Object.keys(s.spaces).sort()).toEqual(['home', 'public'])
    expect(s.spaces.public.sort()).toEqual(['download', 'read'])
  })
  test('the files of a manager are like a user: their folder, not the whole storage', async () => {
    const names = (await mia.json('GET', '/api/list?space=home&path=/')).data.entries.map((e: any) => e.name)
    expect(names).not.toContain('users')
    expect((await mia.json('GET', '/api/list?space=home&path=/users')).status).toBe(404)
    expect((await mia.json('POST', '/api/mkdir', { space: 'public', path: '/', name: 'nope' })).status).toBe(403)
  })
})

describe('roles: users list and manageable', () => {
  test('a manager lists everyone; manageable is true for plain users only', async () => {
    const list = (await mia.json('GET', '/api/admin/users')).data.users
    const flags = Object.fromEntries(list.map((u: any) => [u.username, u.manageable]))
    expect(flags).toMatchObject({ admin: false, boss2: false, mia: false, max: false, ann: true, ubob: true })
  })
  test('for an admin everything is manageable', async () => {
    const list = (await admin.json('GET', '/api/admin/users')).data.users
    expect(list.every((u: any) => u.manageable === true)).toBe(true)
  })
  test('a plain user and a visitor get 403 / 401', async () => {
    expect((await ubob.json('GET', '/api/admin/users')).status).toBe(403)
    expect((await new Client().json('GET', '/api/admin/users')).status).toBe(401)
  })
})

describe('roles: a manager creates, edits and deletes plain users', () => {
  test('creates a user: the home is forced to /users/<name>', async () => {
    const r = await mia.json('POST', '/api/admin/users', mk('forced', 'user', { homedir: '/users/ann' }))
    expect(r.status).toBe(200)
    const u = await row(mia, 'forced')
    expect(u.homedir).toBe('/users/forced')
    expect(u.role).toBe('user')
    expect(existsSync(join(storage(), 'users', 'forced'))).toBe(true)
    const r2 = await mia.json('POST', '/api/admin/users', mk('forced2', 'user', { homedir: '/' }))
    expect(r2.status).toBe(200)
    expect((await row(mia, 'forced2')).homedir).toBe('/users/forced2')
  })
  test('an admin still chooses the home folder', async () => {
    expect((await admin.json('POST', '/api/admin/users', mk('shared1', 'user', { homedir: '/team/a' }))).status).toBe(200)
    expect((await row(admin, 'shared1')).homedir).toBe('/team/a')
  })
  test('can not create a manager or an admin', async () => {
    for (const role of ['manager', 'admin']) {
      const r = await mia.json('POST', '/api/admin/users', mk(`no-${role}`, role))
      expect([r.status, r.data.code]).toEqual([403, 'admin.role-not-allowed'])
      expect(await row(admin, `no-${role}`)).toBeUndefined()
    }
  })
  test('can not promote a user, nor demote or change a manager or admin', async () => {
    for (const role of ['manager', 'admin']) {
      const r = await mia.json('PUT', '/api/admin/users/ann', { role })
      expect([r.status, r.data.code]).toEqual([403, 'admin.role-not-allowed'])
    }
    expect((await row(admin, 'ann')).role).toBe('user')
    // every kind of change to a manager / admin is refused with 403 admin.not-manageable (they are visible, not hidden)
    for (const t of ['max', 'boss2', 'admin']) {
      const calls: [string, string, any?][] = [
        ['PUT', `/api/admin/users/${t}`, { name: 'hijack' }],
        ['PUT', `/api/admin/users/${t}`, { password: 'another-pass-77' }],
        ['PUT', `/api/admin/users/${t}`, { role: 'user' }],
        ['DELETE', `/api/admin/users/${t}`],
        ['GET', `/api/admin/users/${t}/sessions`],
        ['POST', `/api/admin/users/${t}/sessions/revoke`],
        ['POST', `/api/admin/users/${t}/2fa/reset`, { password: PW }],
      ]
      for (const [m, p, b] of calls) {
        const r = await mia.json(m, p, b)
        expect([m, p, r.status, r.data.code]).toEqual([m, p, 403, 'admin.not-manageable'])
      }
      expect((await row(admin, t)).name).not.toBe('hijack')
      expect(await new Client().as(t, t === 'admin' ? 'test-admin-pass' : PW)).toBeTruthy()
    }
  })
  test('can not change their own role or delete themself', async () => {
    expect((await mia.json('PUT', '/api/admin/users/mia', { role: 'admin' })).status).toBe(403)
    expect((await mia.json('PUT', '/api/admin/users/mia', { role: 'user' })).status).toBe(403)
    expect((await mia.json('DELETE', '/api/admin/users/mia')).status).toBe(403)
    expect((await row(admin, 'mia')).role).toBe('manager')
  })
  test('a user an admin gave another folder is the admin\'s alone', async () => {
    const r = await mia.json('PUT', '/api/admin/users/shared1', { name: 'x' })
    expect([r.status, r.data.code]).toEqual([403, 'admin.not-manageable'])
    expect((await row(mia, 'shared1')).manageable).toBe(false)
  })
  test('unknown user is 404', async () => {
    expect((await mia.json('PUT', '/api/admin/users/nobody-here', { name: 'x' })).status).toBe(404)
  })
  test('edits a plain user: name, rights, quota, password; the home stays', async () => {
    const r = await mia.json('PUT', '/api/admin/users/ann', {
      name: 'Ann B', permissions: ['read', 'download'], quotaBytes: 5_000_000, homedir: '/users/elsewhere', password: 'new-harbor-pass-9',
    })
    expect(r.status).toBe(200)
    const u = await row(admin, 'ann')
    expect([u.name, u.permissions, u.quotaBytes, u.homedir]).toEqual(['Ann B', ['read', 'download'], 5_000_000, '/users/ann'])
    await new Client().as('ann', 'new-harbor-pass-9')
  })
  test('public permissions only up to the manager\'s own', async () => {
    const over = await mia.json('POST', '/api/admin/users', mk('pub-over', 'user', { publicPermissions: ['read', 'write'] }))
    expect([over.status, over.data.code]).toEqual([403, 'admin.public-perms-exceed'])
    expect(await row(admin, 'pub-over')).toBeUndefined()
    const ok = await mia.json('POST', '/api/admin/users', mk('pub-ok', 'user', { publicPermissions: ['download'] }))
    expect(ok.status).toBe(200)
    const up = await mia.json('PUT', '/api/admin/users/pub-ok', { publicPermissions: ['read', 'download', 'upload'] })
    expect([up.status, up.data.code]).toEqual([403, 'admin.public-perms-exceed'])
    expect((await row(admin, 'pub-ok')).publicPermissions).toEqual(['download'])
    expect((await mia.json('PUT', '/api/admin/users/pub-ok', { publicPermissions: ['read', 'download'] })).status).toBe(200)
    // an admin is not limited
    expect((await admin.json('PUT', '/api/admin/users/pub-ok', { publicPermissions: ['read', 'write', 'upload', 'download'] })).status).toBe(200)
    // a value the user already holds is no escalation: the manager may save the form again
    expect((await mia.json('PUT', '/api/admin/users/pub-ok', { name: 'again', publicPermissions: ['read', 'write', 'upload', 'download'] })).status).toBe(200)
  })
  test('sessions list and revoke, 2FA reset (with their own password) for a managed user', async () => {
    expect((await mia.json('GET', '/api/admin/users/ubob/sessions')).data.sessions.length).toBeGreaterThan(0)
    expect((await mia.json('POST', '/api/admin/users/ubob/2fa/reset', { password: 'wrong-pass' })).status).toBe(403)
    expect((await mia.json('POST', '/api/admin/users/ubob/sessions/revoke')).data.revoked).toBeGreaterThan(0)
    ubob = await new Client().as('ubob')
    expect((await mia.json('POST', '/api/admin/users/ubob/2fa/reset', { password: PW })).status).toBe(200)
    ubob = await new Client().as('ubob')
  })
  test('deletes a plain user the way an admin does', async () => {
    expect((await mia.json('DELETE', '/api/admin/users/forced2')).status).toBe(200)
    expect(await row(admin, 'forced2')).toBeUndefined()
    expect(existsSync(join(storage(), 'users', 'forced2'))).toBe(true) // the folder stays, as with an admin
    expect((await mia.json('DELETE', '/api/admin/users/forced2')).status).toBe(404)
  })
})

describe('roles: read-only view of a managed user\'s files (space user:<name>)', () => {
  const S = 'user:ubob'
  test('list, folders, search, content, download, preview and zip work', async () => {
    const list = await mia.json('GET', `/api/list?space=${S}&path=/docs`)
    expect(list.status).toBe(200)
    expect(list.data.entries.map((e: any) => e.name)).toEqual(['hello.txt'])
    expect([...list.data.permissions].sort()).toEqual(['batchdownload', 'download', 'read', 'zip'])
    expect((await mia.json('GET', `/api/folders?space=${S}&path=/`)).data.entries.map((e: any) => e.name)).toEqual(['docs'])
    expect((await mia.json('GET', `/api/search?space=${S}&q=hello`)).data.results.map((e: any) => e.path)).toEqual(['/docs/hello.txt'])
    expect((await mia.json('GET', `/api/content?space=${S}&path=/docs/hello.txt`)).data.content).toBe('hello from bob')
    const dl = await mia.raw('GET', `/api/download?space=${S}&path=/docs/hello.txt`)
    expect([dl.status, await dl.text()]).toEqual([200, 'hello from bob'])
    expect((await mia.raw('GET', `/api/download?space=${S}&path=/docs/hello.txt&inline=1`)).status).toBe(200)
    const tok = await mia.json('POST', '/api/batch', { space: S, path: '/docs', items: ['hello.txt'] })
    expect(tok.status).toBe(200)
    expect((await mia.raw('GET', `/api/batch/${tok.data.token}`)).status).toBe(200)
    // the name is not case sensitive
    expect((await mia.json('GET', '/api/list?space=user:UBOB&path=/docs')).status).toBe(200)
  })
  test('an admin may use it too, read-only', async () => {
    expect((await admin.json('GET', `/api/list?space=${S}&path=/docs`)).status).toBe(200)
    expect((await admin.json('POST', '/api/mkdir', { space: S, path: '/', name: 'x' })).status).toBe(403)
  })
  test('every write is refused and nothing changes', async () => {
    const p = '/docs/hello.txt'
    const calls: [string, string, any][] = [
      ['POST', '/api/mkdir', { space: S, path: '/', name: 'new' }],
      ['POST', '/api/newfile', { space: S, path: '/', name: 'new.txt' }],
      ['PUT', '/api/content', { space: S, path: p, content: 'changed' }],
      ['POST', '/api/rename', { space: S, path: p, name: 'renamed.txt' }],
      ['POST', '/api/delete', { space: S, items: [p] }],
      ['POST', '/api/copy', { space: S, items: [p], dest: '/docs' }],
      ['POST', '/api/move', { space: S, items: [p], dest: '/' }],
      ['POST', '/api/zip', { space: S, path: '/docs', items: ['hello.txt'] }],
      ['POST', '/api/unzip', { space: S, path: p }],
      ['POST', '/api/upload', { space: S, path: '/', name: 'u.bin', size: 1 }],
      ['POST', '/api/shares', { space: S, path: p, days: 7 }],
      ['POST', '/api/me/favorites', { space: S, path: p }],
      ['DELETE', `/api/versions/x?space=${S}&path=${p}`, undefined],
    ]
    for (const [m, path, b] of calls) {
      const r = await mia.json(m, path, b)
      expect([m, path, r.status]).toEqual([m, path, 403])
    }
    // copy / move out of it into the manager's own home, and into it from there
    for (const kind of ['copy', 'move']) {
      expect((await mia.json('POST', `/api/${kind}`, { space: S, items: [p], dest: '/', destSpace: 'home' })).status).toBe(403)
      expect((await mia.json('POST', `/api/${kind}`, { space: 'home', items: ['/x'], dest: '/docs', destSpace: S })).status).toBe(403)
    }
    expect(await Bun.file(join(storage(), 'users', 'ubob', 'docs', 'hello.txt')).text()).toBe('hello from bob')
    expect(existsSync(join(storage(), 'users', 'ubob', 'new'))).toBe(false)
    expect(existsSync(join(storage(), 'users', 'mia', 'hello.txt'))).toBe(false)
  })
  test('can not leave that home: traversal, links, a neighbour', async () => {
    expect((await mia.json('GET', `/api/list?space=${S}&path=/../ann`)).status).toBe(400)
    expect((await mia.json('GET', `/api/content?space=${S}&path=/../ann/secret.txt`)).status).toBe(400)
    expect((await mia.raw('GET', `/api/download?space=${S}&path=/..%2Fann%2Fsecret.txt`)).status).toBe(400)
    symlinkSync(join(storage(), 'users', 'ann'), join(storage(), 'users', 'ubob', 'docs', 'ann-link'))
    expect((await mia.json('GET', `/api/list?space=${S}&path=/docs/ann-link`)).status).toBe(403)
    expect((await mia.raw('GET', `/api/download?space=${S}&path=/docs/ann-link/secret.txt`)).status).toBe(403)
    expect((await mia.json('GET', `/api/search?space=${S}&q=secret`)).data.results).toEqual([])
    for (const space of ['user:', 'user:../ann', 'user:ubob/..', 'user: ubob', 'users:ubob']) {
      expect([space, (await mia.json('GET', `/api/list?space=${encodeURIComponent(space)}&path=/`)).status]).toEqual([space, 403])
    }
  })
  test('a target the manager can not manage is refused', async () => {
    for (const t of ['max', 'boss2', 'admin', 'mia', 'shared1', 'nobody-here']) {
      expect([t, (await mia.json('GET', `/api/list?space=user:${t}&path=/`)).status]).toEqual([t, 403])
    }
  })
  test('a plain user and a visitor have no such space', async () => {
    expect((await ubob.json('GET', '/api/list?space=user:ann&path=/')).status).toBe(403)
    expect((await ubob.json('GET', '/api/list?space=user:ubob&path=/')).status).toBe(403)
    expect((await new Client().json('GET', '/api/list?space=user:ubob&path=/')).status).toBe(401)
  })
  test('reads are audited with who read whose file', async () => {
    const act = (await admin.json('GET', '/api/admin/activity?user=mia&pageSize=100')).data.items as any[]
    const dl = act.find(e => e.action === 'download' && e.target?.endsWith('/users/ubob/docs/hello.txt'))
    expect(dl?.detail).toBe('user:ubob')
    expect(act.some(e => e.action === 'view' && e.detail === 'user:ubob')).toBe(true)
    expect(act.some(e => e.action === 'download-zip' && e.detail.includes('user:ubob'))).toBe(true)
  })
  test('the view is not remembered as the viewer\'s recent files', async () => {
    const recent = (await mia.json('GET', '/api/me/recent')).data.items as any[]
    expect(recent.some(i => String(i.space).startsWith('user:'))).toBe(false)
  })
})

describe('roles: dashboard, activity, shares for a manager', () => {
  test('the status is reduced', async () => {
    const r = await mia.json('GET', '/api/admin/status')
    expect(r.status).toBe(200)
    expect(Object.keys(r.data).sort()).toEqual(['manageableUsers', 'reduced', 'stale', 'storage', 'users', 'warnings'])
    expect(r.data.reduced).toBe(true)
    const full = (await admin.json('GET', '/api/admin/status')).data
    expect(full.reduced).toBe(false)
    expect(full.version).toBeTruthy()
  })
  test('activity shows the manager and their users only', async () => {
    await new Client().as('max') // an entry by a manager they do not manage
    const items = (await mia.json('GET', '/api/admin/activity?pageSize=100')).data.items as any[]
    const who = new Set(items.map(e => e.user))
    expect(who.has('mia')).toBe(true)
    expect(who.has('ubob')).toBe(true)
    for (const u of ['admin', 'max', 'boss2', 'guest']) expect(who.has(u)).toBe(false)
    // asking for another user by filter does not get around it
    expect((await mia.json('GET', '/api/admin/activity?user=admin')).data.items).toEqual([])
    expect((await admin.json('GET', '/api/admin/activity?pageSize=100')).data.items.some((e: any) => e.user === 'max')).toBe(true)
  })
  test('shared links: a manager sees and revokes those of their users only', async () => {
    const mine = await ubob.json('POST', '/api/shares', { space: 'home', path: '/docs/hello.txt', days: 7 })
    expect(mine.status).toBe(200)
    writeFileSync(join(storage(), 'adm.txt'), 'x')
    writeFileSync(join(storage(), 'users', 'max', 'm.txt'), 'x')
    const adminLink = await admin.json('POST', '/api/shares', { space: 'home', path: '/adm.txt', days: 7 })
    expect(adminLink.status).toBe(200)
    const maxLink = await (await new Client().as('max')).json('POST', '/api/shares', { space: 'home', path: '/m.txt', days: 7 })
    expect(maxLink.status).toBe(200)
    const list = (await mia.json('GET', '/api/admin/shares')).data.shares as any[]
    // other test files share the process and add users of their own: what matters is who is in and who is out
    expect(list.map(s => s.owner)).toContain('ubob')
    expect(list.map(s => s.owner)).not.toContain('admin')
    expect(list.map(s => s.owner)).not.toContain('max')
    expect((await admin.json('GET', '/api/admin/shares')).data.shares.length).toBeGreaterThanOrEqual(3)
    expect((await mia.json('DELETE', `/api/shares/${adminLink.data.share.id}`)).status).toBe(404)
    expect((await mia.json('DELETE', `/api/shares/${maxLink.data.share.id}`)).status).toBe(404)
    expect((await mia.json('DELETE', `/api/shares/${mine.data.share.id}`)).status).toBe(200)
  })
})

describe('roles: what stays with the admin', () => {
  test('settings, logo, update, backups, logs, alerts, trash, folders are 403 for a manager (and a user)', async () => {
    const calls: [string, string, any?][] = [
      ['GET', '/api/admin/settings'],
      ['PUT', '/api/admin/settings', { appName: 'pwned' }],
      ['DELETE', '/api/admin/logo'],
      ['GET', '/api/admin/folders'],
      ['GET', '/api/admin/trash'],
      ['POST', '/api/admin/trash/purge', {}],
      ['POST', '/api/admin/trash/restore', { id: 'x' }],
      ['GET', '/api/admin/backups'],
      ['POST', '/api/admin/backups'],
      ['GET', '/api/admin/logs'],
      ['GET', '/api/admin/activity/export'],
      ['GET', '/api/admin/alerts'],
      ['POST', '/api/admin/alerts/test'],
      ['GET', '/api/admin/update'],
      ['GET', '/api/admin/update/check'],
      ['POST', '/api/admin/update/apply', { id: 'x', password: PW }],
      ['POST', '/api/admin/backups/restore', { name: 'x', password: PW }],
    ]
    for (const c of [mia, ubob]) {
      for (const [m, p, b] of calls) {
        const r = await c.json(m, p, b)
        expect([m, p, r.status]).toEqual([m, p, 403])
      }
    }
    expect((await admin.json('GET', '/api/admin/settings')).data.appName).not.toBe('pwned')
  })
  test('the health answer keeps the version from a manager', async () => {
    expect((await mia.json('GET', '/api/health')).data.version).toBeUndefined()
  })
  test('a plain user gets 403 on the user and dashboard routes', async () => {
    for (const [m, p, b] of [
      ['GET', '/api/admin/users'], ['POST', '/api/admin/users', mk('sneaky', 'user')], ['PUT', '/api/admin/users/ann', { name: 'x' }],
      ['DELETE', '/api/admin/users/ann'], ['GET', '/api/admin/users/ann/sessions'], ['POST', '/api/admin/users/ann/sessions/revoke'],
      ['POST', '/api/admin/users/ann/2fa/reset', { password: PW }], ['GET', '/api/admin/status'], ['GET', '/api/admin/activity'],
      ['GET', '/api/admin/shares'],
    ] as [string, string, any][]) {
      expect([m, p, (await ubob.json(m, p, b)).status]).toEqual([m, p, 403])
    }
  })
})

describe('roles: the last admin', () => {
  test('stays: the only admin can be neither deleted nor demoted', async () => {
    expect((await admin.json('POST', '/api/admin/users', mk('tmp-admin', 'admin'))).status).toBe(200)
    expect((await admin.json('DELETE', '/api/admin/users/tmp-admin')).status).toBe(200)
    expect((await admin.json('DELETE', '/api/admin/users/boss2')).status).toBe(200)
    expect((await admin.json('PUT', '/api/admin/users/admin', { role: 'manager' })).data.code).toBe('admin.last-admin')
    expect((await admin.json('PUT', '/api/admin/users/admin', { role: 'user' })).data.code).toBe('admin.last-admin')
    expect((await admin.json('DELETE', '/api/admin/users/admin')).status).toBe(400)
    expect((await row(admin, 'admin')).role).toBe('admin')
  })
  test('an admin may make a manager', async () => {
    expect((await admin.json('PUT', '/api/admin/users/ann', { role: 'manager' })).status).toBe(200)
    expect((await row(admin, 'ann')).role).toBe('manager')
  })
})
