/**
 * File versions (src/versions.ts), favorites and recent files (src/favorites.ts), copy/move between spaces and the
 * 2FA date. Runs in-process on the same app as api.test.ts (see in-process-env.ts); every user here starts with "vr-".
 * The ONLYOFFICE save keeping a version is tested in tests/office.test.ts (it needs the stub document server).
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import './in-process-env'

let app: any
let config: typeof import('../src/config').config
let paths: typeof import('../src/config').paths
let quota: typeof import('../src/quota')
let versions: typeof import('../src/versions')
let totp: typeof import('../src/totp')
let auth: typeof import('../src/auth')

class Client {
  cookie = ''
  csrf = ''
  async raw(method: string, path: string, body?: any) {
    const h: Record<string, string> = {}
    if (this.cookie) h.cookie = this.cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    let payload: any = body
    if (body !== undefined) {
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
  async start() {
    this.csrf = (await this.json('GET', '/api/session')).data.csrf
    return this
  }
  async login(username: string, password: string) {
    await this.start()
    const r = await this.json('POST', '/api/login', { username, password })
    expect(r.status).toBe(200)
    this.csrf = r.data.csrf
    return this
  }
}

const PW = 'harbor-lamp-42'
const ALL = ['read', 'write', 'upload', 'download', 'zip', 'batchdownload']
const admin = new Client()
const home = (user: string, ...p: string[]) => join(process.env.STORAGE_DIR!, 'users', user, ...p)
const pub = (...p: string[]) => join(process.env.STORAGE_DIR!, 'public', ...p)

async function userWith(username: string, permissions = ALL, publicPermissions: string[] = [], quotaBytes?: number) {
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', permissions, publicPermissions, quotaBytes })
  expect(r.status).toBe(200)
  return new Client().login(username, PW)
}

const put = (c: Client, path: string, content: string, extra: object = {}, space = 'home') =>
  c.json('PUT', '/api/content', { space, path, content, ...extra })
const list = (c: Client, path: string, space = 'home') => c.json('GET', `/api/versions?space=${space}&path=${encodeURIComponent(path)}`)
const ids = async (c: Client, path: string, space = 'home') => (await list(c, path, space)).data.items.map((v: any) => v.id) as string[]
const restore = (c: Client, id: string, path: string, extra: object = {}, space = 'home') =>
  c.json('POST', `/api/versions/${id}/restore`, { space, path, ...extra })
const download = (c: Client, id: string, path: string, space = 'home') =>
  c.raw('GET', `/api/versions/${id}/download?space=${space}&path=${encodeURIComponent(path)}`)
const remove = (c: Client, id: string, path: string, space = 'home') =>
  c.json('DELETE', `/api/versions/${id}?space=${space}&path=${encodeURIComponent(path)}`)
const itemOf = (path: string, id: string) => versions.getVersion(path, id).item
const text = (p: string) => readFileSync(p, 'utf8')
async function used(c: Client, username: string) {
  await quota.ready(auth.findUser(username))
  return (await c.json('GET', '/api/me/usage')).data.used as number
}

let savedKeep = 0
let savedDays = 0
beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config, paths } = await import('../src/config'))
  quota = await import('../src/quota')
  versions = await import('../src/versions')
  totp = await import('../src/totp')
  auth = await import('../src/auth')
  savedKeep = config.versionsKeep
  savedDays = config.versionsDays
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
})
afterEach(() => {
  config.versionsKeep = savedKeep
  config.versionsDays = savedDays
})

describe('versions: kept on every save', () => {
  test('saves in the same millisecond still list newest first', async () => {
    const c = await userWith('vr-same-ms')
    writeFileSync(home('vr-same-ms', 'a.txt'), 'v0')
    const realNow = Date.now
    const frozen = realNow()
    Date.now = () => frozen // every save sees the same clock
    try {
      for (const text of ['v1', 'v2', 'v3', 'v4']) expect((await put(c, '/a.txt', text)).status).toBe(200)
    } finally { Date.now = realNow }
    const items = (await list(c, '/a.txt')).data.items
    const texts = await Promise.all(items.map(async (v: any) => (await download(c, v.id, '/a.txt')).text()))
    expect(texts).toEqual(['v3', 'v2', 'v1', 'v0'])
  })

  test('each PUT /api/content keeps the content it replaces; list and download show it', async () => {
    const c = await userWith('vr-save')
    writeFileSync(home('vr-save', 'a.txt'), 'one')
    expect((await put(c, '/a.txt', 'two')).status).toBe(200)
    expect((await put(c, '/a.txt', 'three')).status).toBe(200)
    const r = await list(c, '/a.txt')
    expect(r.status).toBe(200)
    expect(r.data.items.map((v: any) => v.size)).toEqual([3, 3]) // newest first: "two", then "one"
    expect(r.data.items[0]).toMatchObject({ reason: 'edit', savedBy: 'vr-save' })
    expect(typeof r.data.items[0].mtime).toBe('number')
    expect(Date.parse(r.data.items[0].savedAt)).toBeGreaterThan(Date.now() - 60_000)
    expect(r.data.current.size).toBe(5)
    const dl = await download(c, r.data.items[0].id, '/a.txt')
    expect(dl.status).toBe(200)
    expect(await dl.text()).toBe('two')
    expect(await (await download(c, r.data.items[1].id, '/a.txt')).text()).toBe('one')
    // stored as DATA_DIR/versions/<sha1>/<id>/{item,meta.json}
    const dir = join(paths.versions, readdirSync(paths.versions).find(b => readdirSync(join(paths.versions, b)).includes(r.data.items[0].id))!, r.data.items[0].id)
    expect(readdirSync(dir).sort()).toEqual(['item', 'meta.json'])
    expect(JSON.parse(text(join(dir, 'meta.json')))).toMatchObject({ id: r.data.items[0].id, storagePath: '/users/vr-save/a.txt', reason: 'edit' })
  })

  test('a refused save (stale mtime) keeps nothing', async () => {
    const c = await userWith('vr-stale-save')
    writeFileSync(home('vr-stale-save', 'a.txt'), 'one')
    expect((await put(c, '/a.txt', 'two', { expectedMtime: 1 })).status).toBe(409)
    expect(await ids(c, '/a.txt')).toEqual([])
  })

  test('VERSIONS_KEEP=0 keeps nothing', async () => {
    const c = await userWith('vr-off')
    writeFileSync(home('vr-off', 'a.txt'), 'one')
    config.versionsKeep = 0
    expect((await put(c, '/a.txt', 'two')).status).toBe(200)
    expect(await ids(c, '/a.txt')).toEqual([])
  })

  test('at most VERSIONS_KEEP per file: the oldest go first', async () => {
    const c = await userWith('vr-limit')
    writeFileSync(home('vr-limit', 'a.txt'), '0')
    writeFileSync(home('vr-limit', 'b.txt'), '0')
    config.versionsKeep = 2
    for (const n of [1, 2, 3, 4]) expect((await put(c, '/a.txt', String(n))).status).toBe(200)
    expect((await put(c, '/b.txt', '1')).status).toBe(200)
    const kept = await ids(c, '/a.txt')
    expect(kept.length).toBe(2)
    expect(text(itemOf(home('vr-limit', 'a.txt'), kept[0]))).toBe('3')
    expect(text(itemOf(home('vr-limit', 'a.txt'), kept[1]))).toBe('2')
    expect((await ids(c, '/b.txt')).length).toBe(1) // the limit is per file
  })

  test('versions older than VERSIONS_DAYS are purged by housekeeping, younger ones stay', async () => {
    const c = await userWith('vr-expire')
    writeFileSync(home('vr-expire', 'a.txt'), '0')
    for (const n of [1, 2]) await put(c, '/a.txt', String(n))
    const abs = home('vr-expire', 'a.txt')
    const [newer, older] = await ids(c, '/a.txt')
    const { dir, meta } = versions.getVersion(abs, older)
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...meta, savedAt: new Date(Date.now() - 31 * 86_400_000).toISOString() }))
    config.versionsDays = 30
    expect(versions.purgeExpiredVersions()).toBeGreaterThanOrEqual(1)
    expect(await ids(c, '/a.txt')).toEqual([newer])
    expect(existsSync(dir)).toBe(false)
  })
})

describe('versions: restore and delete', () => {
  test('restore puts the version back and keeps the current content as a version', async () => {
    const c = await userWith('vr-restore')
    writeFileSync(home('vr-restore', 'a.txt'), 'old')
    await put(c, '/a.txt', 'new')
    const [id] = await ids(c, '/a.txt')
    const r = await restore(c, id, '/a.txt')
    expect(r.status).toBe(200)
    expect(typeof r.data.mtime).toBe('number')
    expect(text(home('vr-restore', 'a.txt'))).toBe('old')
    const now = await list(c, '/a.txt')
    expect(now.data.items.length).toBe(2)
    expect(now.data.items[0].reason).toBe('restore')
    expect(text(itemOf(home('vr-restore', 'a.txt'), now.data.items[0].id))).toBe('new')
    expect(readdirSync(home('vr-restore')).filter(n => n.includes('restore'))).toEqual([]) // no stage file left
    expect(readFileSync(paths.audit, 'utf8')).toMatch(/"action":"version-restore","target":"\/users\/vr-restore\/a.txt"/)
  })

  test('a stale expectedMtime is a 409 and changes nothing; the current one passes', async () => {
    const c = await userWith('vr-restore-mtime')
    writeFileSync(home('vr-restore-mtime', 'a.txt'), 'old')
    await put(c, '/a.txt', 'new')
    const [id] = await ids(c, '/a.txt')
    const stale = await restore(c, id, '/a.txt', { expectedMtime: 12345 })
    expect(stale.status).toBe(409)
    expect(stale.data.code).toBe('files.changed-elsewhere')
    expect(text(home('vr-restore-mtime', 'a.txt'))).toBe('new')
    expect((await list(c, '/a.txt')).data.items.length).toBe(1)
    const mtime = (await list(c, '/a.txt')).data.current.mtime
    expect((await restore(c, id, '/a.txt', { expectedMtime: mtime })).status).toBe(200)
    expect(text(home('vr-restore-mtime', 'a.txt'))).toBe('old')
  })

  test('delete removes one version and writes the audit entry', async () => {
    const c = await userWith('vr-del')
    writeFileSync(home('vr-del', 'a.txt'), '0')
    await put(c, '/a.txt', '1')
    await put(c, '/a.txt', '2')
    const [first, second] = await ids(c, '/a.txt')
    expect((await remove(c, first, '/a.txt')).status).toBe(200)
    expect(await ids(c, '/a.txt')).toEqual([second])
    expect((await remove(c, first, '/a.txt')).status).toBe(404)
    expect(text(home('vr-del', 'a.txt'))).toBe('2')
    expect(readFileSync(paths.audit, 'utf8')).toMatch(/"action":"version-delete","target":"\/users\/vr-del\/a.txt"/)
  })

  test('an id of another file opens nothing on any route (and bad ids are 404)', async () => {
    const c = await userWith('vr-other')
    writeFileSync(home('vr-other', 'a.txt'), '0')
    writeFileSync(home('vr-other', 'b.txt'), '0')
    await put(c, '/a.txt', '1')
    await put(c, '/b.txt', '1')
    const [idA] = await ids(c, '/a.txt')
    const [idB] = await ids(c, '/b.txt')
    for (const bad of [idA, '../x', '0000000000000_00000000', 'zzz']) {
      expect((await download(c, bad, '/b.txt')).status).toBe(404)
      expect((await restore(c, bad, '/b.txt')).status).toBe(404)
      expect((await remove(c, bad, '/b.txt')).status).toBe(404)
    }
    // nothing happened to either file
    expect(text(home('vr-other', 'b.txt'))).toBe('1')
    expect(await ids(c, '/a.txt')).toEqual([idA])
    expect(await ids(c, '/b.txt')).toEqual([idB])
    // another user's file: the same id through the other user's own path finds nothing
    const c2 = await userWith('vr-other2')
    writeFileSync(home('vr-other2', 'a.txt'), '0')
    expect((await download(c2, idA, '/a.txt')).status).toBe(404)
    // a folder or a missing file has no versions
    expect((await list(c, '/missing.txt')).status).toBe(404)
    expect((await list(c, '/')).status).toBe(404)
  })

  test('with only read + download a user can list and download, not restore or delete', async () => {
    const owner = await userWith('vr-ro-owner')
    writeFileSync(home('vr-ro-owner', 'a.txt'), '0')
    await put(owner, '/a.txt', '1')
    const [id] = await ids(owner, '/a.txt')
    // the same file seen through the public folder by a user who may only read and download there
    const reader = await userWith('vr-ro', [], ['read', 'download'])
    writeFileSync(pub('vr-ro.txt'), '0')
    await put(admin, '/public/vr-ro.txt', '1') // the admin's home is the whole storage
    const pubId = (await ids(admin, '/public/vr-ro.txt'))[0]
    expect((await list(reader, '/vr-ro.txt', 'public')).status).toBe(200)
    expect((await download(reader, pubId, '/vr-ro.txt', 'public')).status).toBe(200)
    expect((await restore(reader, pubId, '/vr-ro.txt', {}, 'public')).status).toBe(403)
    expect((await remove(reader, pubId, '/vr-ro.txt', 'public')).status).toBe(403)
    expect(await ids(admin, '/public/vr-ro.txt')).toEqual([pubId])
    // no read at all: not even the list; no download permission: no download
    const noRead = await userWith('vr-no-read', ['download'], [])
    expect((await list(noRead, '/a.txt')).status).toBe(403)
    const noDl = await userWith('vr-no-dl', ['read'], [])
    writeFileSync(home('vr-no-dl', 'a.txt'), '0')
    expect((await list(noDl, '/a.txt')).status).toBe(200)
    expect((await download(noDl, id, '/a.txt')).status).toBe(403)
  })

  test('a visitor follows the guest permissions: 401 where a user would be refused', async () => {
    writeFileSync(pub('vr-guest.txt'), '0')
    await put(admin, '/public/vr-guest.txt', '1')
    const id = (await ids(admin, '/public/vr-guest.txt'))[0]
    const v = await new Client().start()
    expect((await restore(v, id, '/vr-guest.txt', {}, 'public')).status).toBe(401)
    expect((await remove(v, id, '/vr-guest.txt', 'public')).status).toBe(401)
    expect((await list(v, '/vr-guest.txt', 'home')).status).toBe(401)
  })
})

describe('versions: quota', () => {
  test('versions of a file in a home count against its owner', async () => {
    const c = await userWith('vr-q-count', ALL, [], 5000)
    writeFileSync(home('vr-q-count', 'a.txt'), 'x'.repeat(100))
    quota.markStale('vr-q-count')
    expect(await used(c, 'vr-q-count')).toBe(100)
    await put(c, '/a.txt', 'y'.repeat(100))
    expect(await used(c, 'vr-q-count')).toBe(200)
    // a fresh count (after a restart, say) finds the same number
    quota.forget('vr-q-count')
    expect(await used(c, 'vr-q-count')).toBe(200)
    // deleting a version gives its bytes back
    expect((await remove(c, (await ids(c, '/a.txt'))[0], '/a.txt')).status).toBe(200)
    expect(await used(c, 'vr-q-count')).toBe(100)
  })

  test('over the quota the oldest versions of that file go first', async () => {
    const c = await userWith('vr-q-drop', ALL, [], 1000)
    writeFileSync(home('vr-q-drop', 'a.txt'), 'a'.repeat(300))
    quota.markStale('vr-q-drop')
    await put(c, '/a.txt', 'b'.repeat(300)) // 300 + 300
    await put(c, '/a.txt', 'c'.repeat(300)) // 300 + 600
    const before = await ids(c, '/a.txt')
    expect(before.length).toBe(2)
    expect((await put(c, '/a.txt', 'd'.repeat(300))).status).toBe(200) // would be 1200: the oldest version goes
    const after = await ids(c, '/a.txt')
    expect(after.length).toBe(2)
    expect(after).toContain(before[0])
    expect(after).not.toContain(before[1])
    expect(text(home('vr-q-drop', 'a.txt'))).toBe('d'.repeat(300))
    expect(await used(c, 'vr-q-drop')).toBe(900)
  })

  test('when dropping is not enough the save is refused and the content stays', async () => {
    const c = await userWith('vr-q-refuse', ALL, [], 1000)
    writeFileSync(home('vr-q-refuse', 'a.txt'), 'a'.repeat(600))
    quota.markStale('vr-q-refuse')
    const r = await put(c, '/a.txt', 'b'.repeat(600)) // a version of 600 + the file of 600 does not fit
    expect(r.status).toBe(507)
    expect(r.data.code).toBe('quota.exceeded')
    expect(text(home('vr-q-refuse', 'a.txt'))).toBe('a'.repeat(600))
    expect(await ids(c, '/a.txt')).toEqual([])
    expect(await used(c, 'vr-q-refuse')).toBe(600)
  })

  test('restore is refused the same way when the current content can not be kept', async () => {
    const c = await userWith('vr-q-restore', ALL, [], 1000)
    writeFileSync(home('vr-q-restore', 'a.txt'), 'a'.repeat(100))
    quota.markStale('vr-q-restore')
    await put(c, '/a.txt', 'b'.repeat(500)) // version 100 + file 500
    const [id] = await ids(c, '/a.txt')
    writeFileSync(home('vr-q-restore', 'a.txt'), 'c'.repeat(900)) // outside the app
    quota.markStale('vr-q-restore')
    const r = await restore(c, id, '/a.txt')
    expect(r.status).toBe(507)
    expect(text(home('vr-q-restore', 'a.txt'))).toBe('c'.repeat(900))
  })
})

describe('versions: follow the file', () => {
  test('rename and move take the versions along; the old path has none', async () => {
    const c = await userWith('vr-move')
    writeFileSync(home('vr-move', 'a.txt'), '0')
    mkdirSync(home('vr-move', 'sub'))
    await put(c, '/a.txt', '1')
    const [id] = await ids(c, '/a.txt')
    expect((await c.json('POST', '/api/rename', { space: 'home', path: '/a.txt', name: 'b.txt' })).status).toBe(200)
    expect(await ids(c, '/b.txt')).toEqual([id])
    expect((await list(c, '/a.txt')).status).toBe(404)
    expect((await c.json('POST', '/api/move', { space: 'home', items: ['/b.txt'], dest: '/sub' })).data.done).toBe(1)
    expect(await ids(c, '/sub/b.txt')).toEqual([id])
    expect(text(itemOf(home('vr-move', 'sub', 'b.txt'), id))).toBe('0')
    // a folder: the versions of the files inside follow
    expect((await c.json('POST', '/api/rename', { space: 'home', path: '/sub', name: 'moved' })).status).toBe(200)
    expect(await ids(c, '/moved/b.txt')).toEqual([id])
    expect((await restore(c, id, '/moved/b.txt')).status).toBe(200)
    expect(text(home('vr-move', 'moved', 'b.txt'))).toBe('0')
  })

  test('delete moves the versions into the trash entry; restoring brings them back, purging removes them', async () => {
    const c = await userWith('vr-trash')
    writeFileSync(home('vr-trash', 'a.txt'), '0')
    await put(c, '/a.txt', '1')
    await put(c, '/a.txt', '2')
    const before = await ids(c, '/a.txt')
    expect((await c.json('POST', '/api/delete', { space: 'home', items: ['/a.txt'] })).data.done).toBe(1)
    expect((await list(c, '/a.txt')).status).toBe(404)
    const entry = (await admin.json('GET', '/api/admin/trash')).data.items.find((i: any) => i.originalPath === '/users/vr-trash/a.txt')
    expect(readdirSync(join(paths.trash, entry.id, 'versions')).sort()).toEqual([...before].sort())
    // the name is taken meanwhile: it comes back under another name, and the versions with it
    writeFileSync(home('vr-trash', 'a.txt'), 'new file')
    const back = await admin.json('POST', '/api/admin/trash/restore', { id: entry.id })
    expect(back.data.restoredTo).toBe('/users/vr-trash/a (1).txt')
    expect(await ids(c, '/a (1).txt')).toEqual(before)
    expect(await ids(c, '/a.txt')).toEqual([])
    expect(text(itemOf(home('vr-trash', 'a (1).txt'), before[0]))).toBe('1')

    // purge: the versions go with the entry
    await c.json('POST', '/api/delete', { space: 'home', items: ['/a (1).txt'] })
    const entry2 = (await admin.json('GET', '/api/admin/trash')).data.items.find((i: any) => i.originalPath === '/users/vr-trash/a (1).txt')
    expect(existsSync(join(paths.trash, entry2.id, 'versions'))).toBe(true)
    expect((await admin.json('POST', '/api/admin/trash/purge', { id: entry2.id })).status).toBe(200)
    expect(existsSync(join(paths.trash, entry2.id))).toBe(false)
    const left = existsSync(paths.versions) ? readdirSync(paths.versions).flatMap(b => readdirSync(join(paths.versions, b))) : []
    for (const id of before) expect(left).not.toContain(id)
  })

  test('a deleted folder takes the versions of the files in it, and its restore returns them', async () => {
    const c = await userWith('vr-trash-dir')
    mkdirSync(home('vr-trash-dir', 'd'))
    writeFileSync(home('vr-trash-dir', 'd', 'a.txt'), '0')
    await put(c, '/d/a.txt', '1')
    const [id] = await ids(c, '/d/a.txt')
    await c.json('POST', '/api/delete', { space: 'home', items: ['/d'] })
    const entry = (await admin.json('GET', '/api/admin/trash')).data.items.find((i: any) => i.originalPath === '/users/vr-trash-dir/d')
    await admin.json('POST', '/api/admin/trash/restore', { id: entry.id })
    expect(await ids(c, '/d/a.txt')).toEqual([id])
  })

  test('the quota follows: a deleted file gives its versions back, a restore counts them again', async () => {
    const c = await userWith('vr-q-trash', ALL, [], 5000)
    writeFileSync(home('vr-q-trash', 'a.txt'), 'x'.repeat(100))
    quota.markStale('vr-q-trash')
    await put(c, '/a.txt', 'y'.repeat(100))
    expect(await used(c, 'vr-q-trash')).toBe(200)
    await c.json('POST', '/api/delete', { space: 'home', items: ['/a.txt'] })
    expect(await used(c, 'vr-q-trash')).toBe(0)
    const entry = (await admin.json('GET', '/api/admin/trash')).data.items.find((i: any) => i.originalPath === '/users/vr-q-trash/a.txt')
    await admin.json('POST', '/api/admin/trash/restore', { id: entry.id })
    expect(await used(c, 'vr-q-trash')).toBe(200)
  })
})

describe('versions: backup', () => {
  test('a backup does not contain the versions folder', async () => {
    const c = await userWith('vr-backup')
    writeFileSync(home('vr-backup', 'a.txt'), '0')
    await put(c, '/a.txt', '1')
    expect(existsSync(paths.versions)).toBe(true)
    const made = await admin.json('POST', '/api/admin/backups')
    expect(made.status).toBe(200)
    const res = await admin.raw('GET', `/api/admin/backups/${made.data.name}/download`)
    const files = Object.keys(unzipSync(new Uint8Array(await res.arrayBuffer())))
    expect(files).toContain('users.json')
    expect(files.filter(f => f.startsWith('versions'))).toEqual([])
  })
})

describe('favorites and recent', () => {
  const favs = (c: Client) => c.json('GET', '/api/me/favorites').then(r => r.data.items as any[])
  const recent = (c: Client) => c.json('GET', '/api/me/recent').then(r => r.data.items as any[])
  const add = (c: Client, path: string, space = 'home') => c.json('POST', '/api/me/favorites', { space, path })
  const unfav = (c: Client, path: string, space = 'home') => c.json('DELETE', '/api/me/favorites', { space, path })

  test('add, list, dedupe (newest first) and remove', async () => {
    const c = await userWith('vr-fav')
    writeFileSync(home('vr-fav', 'a.txt'), 'aaa')
    writeFileSync(home('vr-fav', 'b.txt'), 'b')
    mkdirSync(home('vr-fav', 'dir'))
    for (const p of ['/a.txt', '/b.txt', '/dir', '/a.txt']) expect((await add(c, p)).status).toBe(200)
    const items = await favs(c)
    expect(items.map(i => i.path)).toEqual(['/a.txt', '/dir', '/b.txt'])
    expect(items[0]).toMatchObject({ space: 'home', name: 'a.txt', type: 'file', size: 3 })
    expect(items[1].type).toBe('dir')
    expect((await unfav(c, '/dir')).status).toBe(200)
    expect((await unfav(c, '/dir')).status).toBe(200) // already gone: fine
    expect((await favs(c)).map(i => i.path)).toEqual(['/a.txt', '/b.txt'])
    // a file that is not there, and the top folder, can not be a favorite
    expect((await add(c, '/missing.txt')).status).toBe(404)
    expect((await add(c, '/')).status).toBe(400)
  })

  test('visitors have none (401); a user sees only their own', async () => {
    const v = await new Client().start()
    expect((await v.json('GET', '/api/me/favorites')).status).toBe(401)
    expect((await v.json('GET', '/api/me/recent')).status).toBe(401)
    expect((await add(v, '/vr-guest.txt', 'public')).status).toBe(401)
    expect((await unfav(v, '/vr-guest.txt', 'public')).status).toBe(401)
    const a = await userWith('vr-fav-own1')
    const b = await userWith('vr-fav-own2')
    writeFileSync(home('vr-fav-own1', 'a.txt'), 'a')
    await add(a, '/a.txt')
    expect(await favs(b)).toEqual([])
  })

  test('at most 200 favorites: the 201st is refused, an existing one can still be added again', async () => {
    const c = await userWith('vr-fav-max')
    for (let i = 0; i < 201; i++) writeFileSync(home('vr-fav-max', `f${i}.txt`), '')
    for (let i = 0; i < 200; i++) expect((await add(c, `/f${i}.txt`)).status).toBe(200)
    const over = await add(c, '/f200.txt')
    expect(over.status).toBe(400)
    expect(over.data.code).toBe('favorites.too-many')
    expect((await add(c, '/f0.txt')).status).toBe(200)
    expect((await favs(c)).length).toBe(200)
  })

  test('permissions are checked on add and on every read', async () => {
    const c = await userWith('vr-fav-perm', ALL, ['read', 'download'])
    writeFileSync(pub('vr-fav-perm.txt'), 'p')
    expect((await add(c, '/vr-fav-perm.txt', 'public')).status).toBe(200)
    expect((await favs(c)).map(i => `${i.space}:${i.path}`)).toEqual(['public:/vr-fav-perm.txt'])
    expect((await c.json('GET', `/api/download?space=public&path=/vr-fav-perm.txt`)).status).toBe(200)
    // the right to read the public folder is taken away: hidden at once...
    expect((await admin.json('PUT', '/api/admin/users/vr-fav-perm', { publicPermissions: [] })).status).toBe(200)
    expect(await favs(c)).toEqual([])
    expect(await recent(c)).toEqual([])
    expect((await add(c, '/vr-fav-perm.txt', 'public')).status).toBe(403)
    // other rights in that space, but not read (a drop folder): still hidden
    expect((await admin.json('PUT', '/api/admin/users/vr-fav-perm', { publicPermissions: ['upload'] })).status).toBe(200)
    expect(await favs(c)).toEqual([])
    expect(await recent(c)).toEqual([])
    // ...and back again when it is given back
    await admin.json('PUT', '/api/admin/users/vr-fav-perm', { publicPermissions: ['read'] })
    expect((await favs(c)).length).toBe(1)
  })

  test('a file that is gone drops out; a rename or move updates the path', async () => {
    const c = await userWith('vr-fav-move')
    writeFileSync(home('vr-fav-move', 'a.txt'), 'a')
    writeFileSync(home('vr-fav-move', 'gone.txt'), 'g')
    mkdirSync(home('vr-fav-move', 'd'))
    writeFileSync(home('vr-fav-move', 'd', 'in.txt'), 'i')
    for (const p of ['/a.txt', '/gone.txt', '/d/in.txt']) await add(c, p)
    await c.json('GET', '/api/content?space=home&path=/d/in.txt')
    expect((await c.json('POST', '/api/rename', { space: 'home', path: '/a.txt', name: 'renamed.txt' })).status).toBe(200)
    expect((await c.json('POST', '/api/rename', { space: 'home', path: '/d', name: 'e' })).status).toBe(200)
    await c.json('POST', '/api/delete', { space: 'home', items: ['/gone.txt'] })
    expect((await favs(c)).map(i => i.path).sort()).toEqual(['/e/in.txt', '/renamed.txt'])
    expect((await recent(c)).map(i => i.path)).toEqual(['/e/in.txt'])
    mkdirSync(home('vr-fav-move', 'f'))
    await c.json('POST', '/api/move', { space: 'home', items: ['/renamed.txt'], dest: '/f' })
    expect((await favs(c)).map(i => i.path).sort()).toEqual(['/e/in.txt', '/f/renamed.txt'])
  })

  test('an admin renaming a file updates the favorites of the user it belongs to', async () => {
    const c = await userWith('vr-fav-adm')
    writeFileSync(home('vr-fav-adm', 'a.txt'), 'a')
    await add(c, '/a.txt')
    expect((await admin.json('POST', '/api/rename', { space: 'home', path: '/users/vr-fav-adm/a.txt', name: 'z.txt' })).status).toBe(200)
    expect((await favs(c)).map(i => i.path)).toEqual(['/z.txt'])
  })

  test('recent: recorded on download, content read and save; newest first, no duplicates', async () => {
    const c = await userWith('vr-recent')
    for (const n of ['a', 'b', 'c']) writeFileSync(home('vr-recent', `${n}.txt`), n)
    expect((await c.raw('GET', '/api/download?space=home&path=/a.txt')).status).toBe(200)
    expect((await c.json('GET', '/api/content?space=home&path=/b.txt')).status).toBe(200)
    expect((await put(c, '/c.txt', 'cc')).status).toBe(200)
    expect((await c.raw('GET', '/api/download?space=home&path=/a.txt&inline=1')).status).toBe(200) // preview
    const items = await recent(c)
    expect(items.map(i => i.path)).toEqual(['/a.txt', '/c.txt', '/b.txt'])
    expect(items[0]).toMatchObject({ space: 'home', name: 'a.txt', type: 'file' })
    expect(Date.parse(items[0].at)).toBeGreaterThan(Date.now() - 60_000)
    // a refused read records nothing
    await c.json('GET', '/api/content?space=home&path=/missing.txt')
    expect((await recent(c)).length).toBe(3)
  })

  test('recent keeps the newest 50', async () => {
    const c = await userWith('vr-recent-max')
    for (let i = 0; i < 55; i++) {
      writeFileSync(home('vr-recent-max', `f${i}.txt`), 'x')
      await c.json('GET', `/api/content?space=home&path=/f${i}.txt`)
    }
    const items = await recent(c)
    expect(items.length).toBe(50)
    expect(items[0].path).toBe('/f54.txt')
    expect(items[49].path).toBe('/f5.txt')
  })

  test('deleting a user drops their lists', async () => {
    const c = await userWith('vr-fav-del')
    writeFileSync(home('vr-fav-del', 'a.txt'), 'a')
    await add(c, '/a.txt')
    await c.json('GET', '/api/content?space=home&path=/a.txt')
    const state = () => JSON.parse(text(paths.userState))
    await Bun.sleep(20)
    expect(state()['vr-fav-del']).toBeDefined()
    expect((await admin.json('DELETE', '/api/admin/users/vr-fav-del')).status).toBe(200)
    await Bun.sleep(20)
    expect(state()['vr-fav-del']).toBeUndefined()
  })
})

describe('copy and move between spaces', () => {
  const transfer = (c: Client, kind: 'copy' | 'move', body: object) => c.json('POST', `/api/${kind}`, body)

  test('a copy needs read + download at the source and write + upload at the destination', async () => {
    writeFileSync(pub('vr-x-src.txt'), 'pub')
    const full = await userWith('vr-x-full', ALL, ['read', 'download', 'write', 'upload'])
    expect((await transfer(full, 'copy', { space: 'public', items: ['/vr-x-src.txt'], dest: '/', destSpace: 'home' })).data.done).toBe(1)
    expect(text(home('vr-x-full', 'vr-x-src.txt'))).toBe('pub')
    expect(text(pub('vr-x-src.txt'))).toBe('pub')
    writeFileSync(home('vr-x-full', 'up.txt'), 'home')
    expect((await transfer(full, 'copy', { space: 'home', items: ['/up.txt'], dest: '/', destSpace: 'public' })).data.done).toBe(1)
    expect(text(pub('up.txt'))).toBe('home')

    // destination refuses: public without upload
    const noUp = await userWith('vr-x-noup', ALL, ['read', 'download', 'write'])
    writeFileSync(home('vr-x-noup', 'a.txt'), 'a')
    expect((await transfer(noUp, 'copy', { space: 'home', items: ['/a.txt'], dest: '/', destSpace: 'public' })).status).toBe(403)
    // destination refuses: public without write
    const noWrite = await userWith('vr-x-nowrite', ALL, ['read', 'download', 'upload'])
    writeFileSync(home('vr-x-nowrite', 'a.txt'), 'a')
    expect((await transfer(noWrite, 'copy', { space: 'home', items: ['/a.txt'], dest: '/', destSpace: 'public' })).status).toBe(403)
    // source refuses: no download for a copy
    const noDl = await userWith('vr-x-nodl', ['read', 'write', 'upload'], ['read', 'write', 'upload'])
    writeFileSync(home('vr-x-nodl', 'a.txt'), 'a')
    expect((await transfer(noDl, 'copy', { space: 'home', items: ['/a.txt'], dest: '/', destSpace: 'public' })).status).toBe(403)
    // source refuses: no read
    const noRead = await userWith('vr-x-noread', ['download', 'write', 'upload'], ['read', 'write', 'upload'])
    expect((await transfer(noRead, 'copy', { space: 'home', items: ['/a.txt'], dest: '/', destSpace: 'public' })).status).toBe(403)
    // a visitor has no home and may not write the public folder
    const v = await new Client().start()
    expect((await transfer(v, 'copy', { space: 'public', items: ['/vr-x-src.txt'], dest: '/', destSpace: 'home' })).status).toBe(401)
    expect(existsSync(pub('a.txt'))).toBe(false)
  })

  test('a move across spaces copies, then deletes the source into the trash; same-space behaviour is unchanged', async () => {
    const c = await userWith('vr-x-move', ALL, ['read', 'download', 'write', 'upload'])
    writeFileSync(home('vr-x-move', 'm.txt'), 'm')
    writeFileSync(home('vr-x-move', 'keep.txt'), 'k')
    await put(c, '/m.txt', 'm2')
    const r = await transfer(c, 'move', { space: 'home', items: ['/m.txt'], dest: '/', destSpace: 'public' })
    expect(r.data).toEqual({ done: 1, failed: [] })
    expect(text(pub('m.txt'))).toBe('m2')
    expect(existsSync(home('vr-x-move', 'm.txt'))).toBe(false)
    const trashed = (await admin.json('GET', '/api/admin/trash')).data.items.find((i: any) => i.originalPath === '/users/vr-x-move/m.txt')
    expect(trashed).toBeDefined()
    // a name that is taken at the destination: refused, the source stays
    writeFileSync(pub('keep.txt'), 'other')
    const taken = await transfer(c, 'move', { space: 'home', items: ['/keep.txt'], dest: '/', destSpace: 'public' })
    expect(taken.data.done).toBe(0)
    expect(text(home('vr-x-move', 'keep.txt'))).toBe('k')
    expect(text(pub('keep.txt'))).toBe('other')
    // the same space with destSpace given explicitly is the old behaviour
    mkdirSync(home('vr-x-move', 'sub'))
    expect((await transfer(c, 'move', { space: 'home', items: ['/keep.txt'], dest: '/sub', destSpace: 'home' })).data.done).toBe(1)
    expect(existsSync(home('vr-x-move', 'sub', 'keep.txt'))).toBe(true)
  })

  test('a move needs write at the source too: the source goes', async () => {
    const c = await userWith('vr-x-move-ro', ['read', 'download'], ['read', 'write', 'upload'])
    writeFileSync(home('vr-x-move-ro', 'a.txt'), 'a')
    expect((await transfer(c, 'move', { space: 'home', items: ['/a.txt'], dest: '/', destSpace: 'public' })).status).toBe(403)
    expect(text(home('vr-x-move-ro', 'a.txt'))).toBe('a')
    expect(existsSync(pub('a.txt'))).toBe(false)
  })

  test('the destination quota counts for a copy and for a cross-space move; a failed copy leaves the source', async () => {
    const c = await userWith('vr-x-quota', ALL, ['read', 'download', 'write', 'upload'], 1000)
    writeFileSync(pub('vr-x-big.bin'), new Uint8Array(1500))
    writeFileSync(pub('vr-x-small.bin'), new Uint8Array(400))
    quota.markStale('vr-x-quota')
    const big = await transfer(c, 'copy', { space: 'public', items: ['/vr-x-big.bin'], dest: '/', destSpace: 'home' })
    expect(big.data.done).toBe(0)
    expect(big.data.failed[0].error).toContain('1000')
    expect(existsSync(home('vr-x-quota', 'vr-x-big.bin'))).toBe(false)
    // a move that does not fit: copy fails, the source is untouched and nothing is in the trash
    const trashBefore = readdirSync(paths.trash).length
    const mv = await transfer(c, 'move', { space: 'public', items: ['/vr-x-big.bin'], dest: '/', destSpace: 'home' })
    expect(mv.data.done).toBe(0)
    expect(existsSync(pub('vr-x-big.bin'))).toBe(true)
    expect(existsSync(home('vr-x-quota', 'vr-x-big.bin'))).toBe(false)
    expect(readdirSync(paths.trash).length).toBe(trashBefore)
    // the small one fits once, the second copy would not (400 + 400 + 400 > 1000)
    expect((await transfer(c, 'copy', { space: 'public', items: ['/vr-x-small.bin'], dest: '/', destSpace: 'home' })).data.done).toBe(1)
    expect((await transfer(c, 'copy', { space: 'public', items: ['/vr-x-small.bin'], dest: '/', destSpace: 'home' })).data.done).toBe(1)
    expect((await transfer(c, 'copy', { space: 'public', items: ['/vr-x-small.bin'], dest: '/', destSpace: 'home' })).data.done).toBe(0)
    expect(await used(c, 'vr-x-quota')).toBe(800)
  })

  test('system folders are never moved, and a folder never goes into itself', async () => {
    const adminMove = await admin.json('POST', '/api/move', { space: 'home', items: ['/public', '/users'], dest: '/', destSpace: 'public' })
    expect(adminMove.data.done).toBe(0)
    expect(adminMove.data.failed.length).toBe(2)
    expect(existsSync(pub())).toBe(true)
    expect(existsSync(join(process.env.STORAGE_DIR!, 'users'))).toBe(true)
    // copying /public into the public space (which lies inside it) would copy it into itself
    const into = await admin.json('POST', '/api/copy', { space: 'home', items: ['/public'], dest: '/', destSpace: 'public' })
    expect(into.data.done).toBe(0)
    expect(existsSync(pub('public'))).toBe(false)
  })

  test('an unknown destination space is refused', async () => {
    const c = await userWith('vr-x-unknown')
    writeFileSync(home('vr-x-unknown', 'a.txt'), 'a')
    expect((await transfer(c, 'copy', { space: 'home', items: ['/a.txt'], dest: '/', destSpace: 'nowhere' })).status).toBe(403)
  })
})

describe('2FA since', () => {
  test('twoFactorSince is null without 2FA and the enable date with it', async () => {
    const c = await userWith('vr-2fa')
    expect((await c.json('GET', '/api/session')).data.user.twoFactorSince).toBeNull()
    const setup = await c.json('POST', '/api/2fa/setup', { password: PW })
    expect(setup.status).toBe(200)
    const before = Date.now() - 1000
    const code = totp.totpAt(setup.data.secret, totp.stepOf(Date.now()))
    expect((await c.json('POST', '/api/2fa/enable', { code })).status).toBe(200)
    const user = (await c.json('GET', '/api/session')).data.user
    expect(user.twoFactor).toBe(true)
    expect(Date.parse(user.twoFactorSince)).toBeGreaterThan(before)
    const row = (await admin.json('GET', '/api/admin/users')).data.users.find((u: any) => u.username === 'vr-2fa')
    expect(row.twoFactorSince).toBe(user.twoFactorSince)
    expect((await admin.json('GET', '/api/admin/users')).data.users.find((u: any) => u.username === 'vr-save').twoFactorSince).toBeNull()
  })
})
