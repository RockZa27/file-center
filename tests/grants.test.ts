/**
 * Folders shared with another user ("grants"): /api/grants*, /api/users/lookup and the space grant:<id>.
 * Runs in-process on the same app as api.test.ts (see in-process-env.ts); every user here starts with "gr".
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import './in-process-env'

let app: any
let quota: typeof import('../src/quota')
let grantsMod: typeof import('../src/grants')
let auth: typeof import('../src/auth')

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
const admin = new Client()
const home = (user: string, ...p: string[]) => join(process.env.STORAGE_DIR!, 'users', user, ...p)

async function userWith(username: string, extra: Record<string, unknown> = {}) {
  const r = await admin.json('POST', '/api/admin/users', { username, name: `Name of ${username}`, password: PW, role: 'user', permissions: PERMS, publicPermissions: [], ...extra })
  expect(r.status).toBe(200)
  return new Client().login(username, PW)
}

/** an owner with a folder /proj (a.txt, sub/b.txt) and a recipient; the grant is made with `perms` */
async function pair(tag: string, perms: 'view' | 'edit', ownerExtra: Record<string, unknown> = {}) {
  const owner = await userWith(`gr-${tag}-o`, ownerExtra)
  const rec = await userWith(`gr-${tag}-r`)
  mkdirSync(home(`gr-${tag}-o`, 'proj', 'sub'), { recursive: true })
  writeFileSync(home(`gr-${tag}-o`, 'proj', 'a.txt'), 'aaa')
  writeFileSync(home(`gr-${tag}-o`, 'proj', 'sub', 'b.txt'), 'bbb')
  mkdirSync(home(`gr-${tag}-o`, 'private'))
  writeFileSync(home(`gr-${tag}-o`, 'private', 's.txt'), 'secret')
  const made = await owner.json('POST', '/api/grants', { space: 'home', path: '/proj', to: `gr-${tag}-r`, perms })
  expect(made.status).toBe(200)
  const space = `grant:${made.data.grant.id}`
  return { owner, rec, id: made.data.grant.id as string, space, ou: `gr-${tag}-o`, ru: `gr-${tag}-r` }
}

const q = (space: string, path = '/') => `space=${encodeURIComponent(space)}&path=${encodeURIComponent(path)}`
const list = (c: Client, space: string, path = '/') => c.json('GET', `/api/list?${q(space, path)}`)
const names = (r: { data: any }) => (r.data.entries as any[]).map(e => e.name).sort()
const chunk = (c: Client, id: string, data: Uint8Array) => c.raw('PUT', `/api/upload/${id}/0`, data, { 'content-type': 'application/octet-stream' })
async function upload(c: Client, space: string, name: string, bytes: number) {
  const init = await c.json('POST', '/api/upload', { space, path: '/', name, size: bytes })
  if (init.status !== 200) return init
  expect((await chunk(c, init.data.id, new Uint8Array(bytes))).status).toBe(200)
  return c.json('POST', `/api/upload/${init.data.id}/complete`)
}

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  quota = await import('../src/quota')
  grantsMod = await import('../src/grants')
  auth = await import('../src/auth')
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
})

describe('grants: making and listing', () => {
  test('create, list on both sides, the same folder and person again only changes the rights', async () => {
    const heard: string[] = []
    grantsMod.grantCreatedListeners.push(g => heard.push(g.id))
    const { owner, rec, id, ou, ru } = await pair('list', 'view')
    expect(heard).toEqual([id])

    const mine = (await owner.json('GET', '/api/grants/mine')).data.items
    expect(mine).toEqual([{ id, path: '/proj', name: 'proj', to: ru, toName: `Name of ${ru}`, perms: 'view', createdAt: expect.any(String), active: true }])

    const again = await owner.json('POST', '/api/grants', { space: 'home', path: '/proj/', to: ru.toUpperCase(), perms: 'edit' })
    expect(again.status).toBe(200)
    expect(again.data.created).toBe(false)
    expect(again.data.grant.id).toBe(id)
    expect((await owner.json('GET', '/api/grants/mine')).data.items.map((g: any) => g.perms)).toEqual(['edit'])
    // the listener hears about a new grant only
    expect(heard).toEqual([id])

    const toMe = (await rec.json('GET', '/api/grants/to-me')).data.items
    expect(toMe).toEqual([{ id, space: `grant:${id}`, name: 'proj', owner: ou, ownerName: `Name of ${ou}`, perms: 'edit', createdAt: expect.any(String) }])
    // nothing of the owner's inside layout reaches the recipient
    expect(JSON.stringify(toMe)).not.toContain('/users')
    expect((await owner.json('GET', '/api/grants/to-me')).data.items).toEqual([])
    expect((await rec.json('GET', '/api/grants/mine')).data.items).toEqual([])

    const log = (await admin.json('GET', `/api/admin/activity?q=${ru}&pageSize=100`)).data.items
    expect(log.filter((r: any) => r.action === 'grant-create' && r.user === ou)).toHaveLength(1)
    expect(log.filter((r: any) => r.action === 'grant-update' && r.user === ou)).toHaveLength(1)
  })

  test('what is refused', async () => {
    const owner = await userWith('gr-bad-o')
    await userWith('gr-bad-r')
    const noShare = await userWith('gr-bad-ns', { permissions: ['read', 'write'] })
    mkdirSync(home('gr-bad-o', 'dir', 'inner'), { recursive: true })
    mkdirSync(home('gr-bad-o', 'real'))
    writeFileSync(home('gr-bad-o', 'file.txt'), 'f')
    symlinkSync(home('gr-bad-o', 'real'), home('gr-bad-o', 'link'))
    symlinkSync(home('gr-bad-o', 'real'), home('gr-bad-o', 'dir', 'inner-link'))
    symlinkSync(join(process.env.STORAGE_DIR!, 'public'), home('gr-bad-o', 'to-public'))
    const make = (body: Record<string, unknown>) => owner.json('POST', '/api/grants', { space: 'home', path: '/dir', to: 'gr-bad-r', perms: 'view', ...body })
    const code = async (r: Promise<{ status: number; data: any }>) => { const x = await r; return `${x.status} ${x.data.code}` }

    expect(await code(make({ path: '/../../etc' }))).toBe('400 fs.bad-path')
    expect(await code(make({ path: '/dir/../../x' }))).toBe('400 fs.bad-path')
    expect(await code(make({ path: '/' }))).toBe('400 grants.folder-only')
    expect(await code(make({ path: '/file.txt' }))).toBe('400 grants.folder-only')
    expect(await code(make({ path: '/link' }))).toBe('400 grants.folder-only')
    expect(await code(make({ path: '/to-public' }))).toBe('403 auth.forbidden')
    expect(await code(make({ path: '/link/x' }))).toMatch(/^(404|400|403)/)
    expect(await code(make({ path: '/nothing' }))).toBe('404 files.folder-not-found')
    expect(await code(make({ to: 'gr-bad-o' }))).toBe('400 grants.to-self')
    expect(await code(make({ to: 'nobody-here' }))).toBe('404 admin.user-not-found')
    expect((await make({ perms: 'owner' })).status).toBe(422)
    expect((await make({ space: 'public' })).status).toBe(403)
    expect((await make({ space: 'user:gr-bad-r' })).status).toBe(403)
    expect((await noShare.json('POST', '/api/grants', { space: 'home', path: '/', to: 'gr-bad-r', perms: 'view' })).status).toBe(403)
    expect((await new Client().json('POST', '/api/grants', { space: 'home', path: '/dir', to: 'gr-bad-r', perms: 'view' })).status).toBe(403) // no session: no CSRF token either
    expect((await owner.json('GET', '/api/grants/mine')).data.items).toEqual([])
    // sharing with an admin is fine
    expect((await make({ to: 'admin' })).status).toBe(200)
  })
})

describe('grants: what a recipient may do', () => {
  test('view: look, read, download; nothing that changes or shares', async () => {
    const { rec, space } = await pair('view', 'view')
    const l = await list(rec, space)
    expect(l.status).toBe(200)
    expect(names(l)).toEqual(['a.txt', 'sub'])
    expect(l.data.permissions.sort()).toEqual(['batchdownload', 'download', 'read', 'zip'])
    expect(names(await list(rec, space, '/sub'))).toEqual(['b.txt'])
    expect((await rec.json('GET', `/api/content?${q(space, '/a.txt')}`)).data.content).toBe('aaa')
    const dl = await rec.raw('GET', `/api/download?${q(space, '/sub/b.txt')}`)
    expect(dl.status).toBe(200)
    expect(await dl.text()).toBe('bbb')
    // a zip of the folder to take away
    const batch = await rec.json('POST', '/api/batch', { space, path: '/', items: ['a.txt', 'sub'] })
    expect(batch.status).toBe(200)

    const denied = async (r: Promise<{ status: number }>) => expect((await r).status).toBe(403)
    await denied(rec.json('POST', '/api/mkdir', { space, path: '/', name: 'x' }))
    await denied(rec.json('POST', '/api/newfile', { space, path: '/', name: 'x.txt' }))
    await denied(rec.json('PUT', '/api/content', { space, path: '/a.txt', content: 'changed' }))
    await denied(rec.json('POST', '/api/rename', { space, path: '/a.txt', name: 'z.txt' }))
    await denied(rec.json('POST', '/api/delete', { space, items: ['/a.txt'] }))
    await denied(rec.json('POST', '/api/zip', { space, path: '/', items: ['a.txt'] }))
    await denied(rec.json('POST', '/api/unzip', { space, path: '/a.txt' }))
    await denied(rec.json('POST', '/api/upload', { space, path: '/', name: 'u.bin', size: 1 }))
    await denied(rec.json('POST', '/api/move', { space, items: ['/a.txt'], dest: '/sub' }))
    await denied(rec.json('POST', '/api/shares', { space, path: '/a.txt', days: 7 }))
    await denied(rec.json('POST', '/api/grants', { space, path: '/sub', to: 'admin', perms: 'view' }))
    // moving out to the own home needs the right to write at the source
    await denied(rec.json('POST', '/api/move', { space, items: ['/a.txt'], dest: '/', destSpace: 'home' }))
    // but taking a copy to the own home is a download
    const copy = await rec.json('POST', '/api/copy', { space, items: ['/a.txt'], dest: '/', destSpace: 'home' })
    expect(copy.data.done).toBe(1)
    expect(readFileSync(home('gr-view-r', 'a.txt'), 'utf8')).toBe('aaa')
    // nothing changed at the owner's
    expect(readFileSync(home('gr-view-o', 'proj', 'a.txt'), 'utf8')).toBe('aaa')
    expect(existsSync(home('gr-view-o', 'proj', 'x'))).toBe(false)
  })

  test('edit: add, change, rename and delete; the folder is the root and nothing above it opens', async () => {
    const { owner, rec, space } = await pair('edit', 'edit')
    expect((await rec.json('POST', '/api/mkdir', { space, path: '/', name: 'new' })).status).toBe(200)
    expect((await rec.json('PUT', '/api/content', { space, path: '/a.txt', content: 'changed' })).status).toBe(200)
    expect(readFileSync(home('gr-edit-o', 'proj', 'a.txt'), 'utf8')).toBe('changed')
    expect((await rec.json('POST', '/api/rename', { space, path: '/a.txt', name: 'z.txt' })).status).toBe(200)
    expect((await upload(rec, space, 'u.bin', 10)).status).toBe(200)
    expect(existsSync(home('gr-edit-o', 'proj', 'u.bin'))).toBe(true)
    const del = await rec.json('POST', '/api/delete', { space, items: ['/z.txt'], withTrash: true })
    expect(del.data.done).toBe(1)
    expect(existsSync(home('gr-edit-o', 'proj', 'z.txt'))).toBe(false)
    // the deleted file is in the owner's trash (and the one who deleted it can undo it)
    expect((await owner.json('GET', '/api/me/trash')).data.items.map((i: any) => i.name)).toContain('z.txt')
    expect((await rec.json('POST', `/api/me/trash/${del.data.trashed[0].id}/restore`)).status).toBe(200)
    expect(existsSync(home('gr-edit-o', 'proj', 'z.txt'))).toBe(true)
    // the share right is never part of it
    expect((await rec.json('POST', '/api/shares', { space, path: '/z.txt', days: 7 })).status).toBe(403)
    expect((await rec.json('POST', '/api/grants', { space, path: '/new', to: 'admin', perms: 'view' })).status).toBe(403)
    // no way out of the folder
    for (const path of ['/../private', '/sub/../../private']) expect((await list(rec, space, path)).status).toBe(400)
    expect((await rec.json('GET', `/api/content?${q(space, '/../private/s.txt')}`)).status).toBe(400)
    // a link inside the folder that leads out of it
    symlinkSync(home('gr-edit-o', 'private'), home('gr-edit-o', 'proj', 'out'))
    expect((await list(rec, space, '/out')).status).toBe(403)
    expect((await rec.json('GET', `/api/content?${q(space, '/out/s.txt')}`)).status).toBe(403)
  })

  test("someone else can not open it: the answer is the one for an id that does not exist", async () => {
    const { owner, rec, space, id } = await pair('third', 'edit')
    const third = await userWith('gr-third-x')
    const unknown = await list(third, 'grant:000000000000000000000000')
    expect(unknown.status).toBe(403)
    for (const c of [third, owner, new Client()]) {
      const r = await list(c, space)
      if (c === third || c === owner) expect(r).toEqual(unknown)
      else expect(r.status).toBe(401)
    }
    for (const r of [
      third.json('GET', `/api/content?${q(space, '/a.txt')}`),
      third.json('POST', '/api/mkdir', { space, path: '/', name: 'x' }),
      third.json('POST', '/api/upload', { space, path: '/', name: 'x', size: 1 }),
    ]) expect((await r).status).toBe(403)
    expect((await third.raw('GET', `/api/download?${q(space, '/a.txt')}`)).status).toBe(403)
    expect(existsSync(home('gr-third-o', 'proj', 'x'))).toBe(false)
    // ... nor change or end it
    expect((await third.json('PATCH', `/api/grants/${id}`, { perms: 'view' })).status).toBe(404)
    expect((await third.json('DELETE', `/api/grants/${id}`)).status).toBe(404)
    expect((await rec.json('PATCH', `/api/grants/${id}`, { perms: 'view' })).status).toBe(404)
    expect((await list(rec, space)).status).toBe(200)
  })
})

describe('grants: when they stop working', () => {
  test('the owner changes the rights, takes it back; the recipient leaves', async () => {
    const { owner, rec, space, id } = await pair('end', 'edit')
    expect((await rec.json('POST', '/api/mkdir', { space, path: '/', name: 'one' })).status).toBe(200)
    expect((await owner.json('PATCH', `/api/grants/${id}`, { perms: 'view' })).status).toBe(200)
    expect((await rec.json('POST', '/api/mkdir', { space, path: '/', name: 'two' })).status).toBe(403)
    expect((await list(rec, space)).status).toBe(200)
    expect((await owner.json('PATCH', `/api/grants/${id}`, { perms: 'nope' })).status).toBe(422)
    // the recipient leaves
    expect((await rec.json('DELETE', `/api/grants/${id}`)).status).toBe(200)
    expect((await list(rec, space)).status).toBe(403)
    expect((await owner.json('GET', '/api/grants/mine')).data.items).toEqual([])
    expect((await owner.json('DELETE', `/api/grants/${id}`)).status).toBe(404)
    // the owner takes one back
    const again = await owner.json('POST', '/api/grants', { space: 'home', path: '/proj', to: 'gr-end-r', perms: 'view' })
    const space2 = `grant:${again.data.grant.id}`
    expect((await list(rec, space2)).status).toBe(200)
    expect((await owner.json('DELETE', `/api/grants/${again.data.grant.id}`)).status).toBe(200)
    expect((await list(rec, space2)).status).toBe(403)
    const actions = (await admin.json('GET', '/api/admin/activity?q=gr-end&pageSize=100')).data.items.map((r: any) => r.action)
    expect(actions).toContain('grant-update')
    expect(actions.filter((a: string) => a === 'grant-delete')).toHaveLength(2)
  })

  test('an owner or a recipient who is deleted takes the grants along, and a new account by the same name gets nothing', async () => {
    const a = await pair('gone1', 'view')
    expect((await list(a.rec, a.space)).status).toBe(200)
    expect((await admin.json('DELETE', `/api/admin/users/${a.ou}`)).status).toBe(200)
    expect((await list(a.rec, a.space)).status).toBe(403)
    expect((await a.rec.json('GET', '/api/grants/to-me')).data.items).toEqual([])
    expect(grantsMod.allGrants().some(g => g.id === a.id)).toBe(false)
    // the owner comes back under the same name with the same folder: the old grant is not back
    await userWith(a.ou)
    expect((await list(a.rec, a.space)).status).toBe(403)

    const b = await pair('gone2', 'view')
    expect((await admin.json('DELETE', `/api/admin/users/${b.ru}`)).status).toBe(200)
    expect(grantsMod.allGrants().some(g => g.id === b.id)).toBe(false)
    expect((await b.owner.json('GET', '/api/grants/mine')).data.items).toEqual([])
  })

  test('without the clean-up of the delete route the grant is still dead (checked on every use)', async () => {
    const a = await pair('lazy', 'view')
    // the account disappears behind the grant's back (the command line tool edits users.json directly)
    const users = auth.allUsers()
    const gone = users.splice(users.findIndex(u => u.username === a.ou), 1)[0]
    expect((await list(a.rec, a.space)).status).toBe(403)
    users.push(gone)
    expect((await list(a.rec, a.space)).status).toBe(200)
  })

  test('the folder is renamed, replaced by a link or removed, or the owner may not share any more', async () => {
    const a = await pair('moved', 'view')
    renameSync(home(a.ou, 'proj'), home(a.ou, 'proj2'))
    expect((await list(a.rec, a.space)).status).toBe(403)
    expect((await a.owner.json('GET', '/api/grants/mine')).data.items[0]).toMatchObject({ active: false })
    expect((await a.rec.json('GET', '/api/grants/to-me')).data.items).toEqual([])
    renameSync(home(a.ou, 'proj2'), home(a.ou, 'proj'))
    expect((await list(a.rec, a.space)).status).toBe(200)
    // a link in its place
    renameSync(home(a.ou, 'proj'), home(a.ou, 'real'))
    symlinkSync(home(a.ou, 'real'), home(a.ou, 'proj'))
    expect((await list(a.rec, a.space)).status).toBe(403)
    rmSync(home(a.ou, 'proj'))
    renameSync(home(a.ou, 'real'), home(a.ou, 'proj'))
    expect((await list(a.rec, a.space)).status).toBe(200)
    // a file in its place
    rmSync(home(a.ou, 'proj'), { recursive: true })
    writeFileSync(home(a.ou, 'proj'), 'now a file')
    expect((await list(a.rec, a.space)).status).toBe(403)
    rmSync(home(a.ou, 'proj'))
    mkdirSync(home(a.ou, 'proj'))
    expect((await list(a.rec, a.space)).status).toBe(200)
    // the right to share goes
    expect((await admin.json('PUT', `/api/admin/users/${a.ou}`, { permissions: ['read', 'write'] })).status).toBe(200)
    expect((await list(a.rec, a.space)).status).toBe(403)
  })

  test("the owner's home moves elsewhere: the grant no longer reaches into it", async () => {
    const a = await pair('home', 'view')
    expect((await admin.json('PUT', `/api/admin/users/${a.ou}`, { homedir: '/elsewhere/gr-home-o' })).status).toBe(200)
    expect((await list(a.rec, a.space)).status).toBe(403)
    // back to the old home it works again; the folder is still where it was
    expect((await admin.json('PUT', `/api/admin/users/${a.ou}`, { homedir: '/users/gr-home-o' })).status).toBe(200)
    expect((await list(a.rec, a.space)).status).toBe(200)
  })
})

describe('grants: quota', () => {
  test("what the recipient adds counts against the owner's quota, not their own", async () => {
    const a = await pair('quota', 'edit', { quotaBytes: 10_000 })
    const owner = auth.findUser(a.ou)!
    const recipient = auth.findUser(a.ru)!
    expect(quota.ownerOfPath(home(a.ou, 'proj', 'x'))?.username).toBe(a.ou)
    await quota.ready(owner)
    const before = (await a.owner.json('GET', '/api/me/usage')).data.used
    expect((await upload(a.rec, a.space, 'big.bin', 4000)).status).toBe(200)
    await quota.ready(owner)
    expect((await a.owner.json('GET', '/api/me/usage')).data.used).toBe(before + 4000)
    expect((await a.rec.json('GET', '/api/me/usage')).data).toMatchObject({ used: 0, quota: 0 })
    // a second upload that does not fit in what is left of the owner's quota
    const over = await a.rec.json('POST', '/api/upload', { space: a.space, path: '/', name: 'more.bin', size: 7000 })
    expect(over.status).toBe(507)
    expect(over.data.code).toBe('quota.exceeded')
    expect(quota.limitOf(recipient)).toBe(0)
    // a text save counts too (the growth, and the old text kept as a version), and a delete gives the space back
    expect((await a.rec.json('PUT', '/api/content', { space: a.space, path: '/a.txt', content: 'x'.repeat(2000) })).status).toBe(200)
    await quota.ready(owner)
    expect((await a.owner.json('GET', '/api/me/usage')).data.used).toBe(before + 4000 + 2000)
    expect((await a.rec.json('POST', '/api/delete', { space: a.space, items: ['/big.bin'] })).data.done).toBe(1)
    await quota.ready(owner)
    expect((await a.owner.json('GET', '/api/me/usage')).data.used).toBe(before + 2000)
    expect((await upload(a.rec, a.space, 'more.bin', 7000)).status).toBe(200)
  })
})

describe('grants: picking a person', () => {
  test('two letters at least, ten names at most, only username and name, never yourself', async () => {
    const me = await userWith('grl-me')
    for (let i = 0; i < 12; i++) await userWith(`grl-p${String(i).padStart(2, '0')}`)
    const look = (c: Client, s: string) => c.json('GET', `/api/users/lookup?q=${encodeURIComponent(s)}`)
    expect((await look(me, 'g')).status).toBe(400)
    expect((await look(me, 'g')).data.code).toBe('grants.query-short')
    expect((await look(me, ' g ')).status).toBe(400)
    const r = await look(me, 'grl-p')
    expect(r.status).toBe(200)
    expect(r.data.users).toHaveLength(10)
    for (const u of r.data.users) expect(Object.keys(u).sort()).toEqual(['name', 'username'])
    expect(JSON.stringify(r.data)).not.toMatch(/role|homedir|passwordHash|permissions/)
    expect((await look(me, 'GRL-ME')).data.users).toEqual([])
    expect((await look(me, 'name of grl-p03')).data.users).toEqual([{ username: 'grl-p03', name: 'Name of grl-p03' }])
    expect((await look(me, 'no-such-person')).data.users).toEqual([])
    // not for visitors, nor for users who may not share
    expect((await look(new Client(), 'grl')).status).toBe(401)
    const noShare = await userWith('grl-ns', { permissions: ['read'] })
    expect((await look(noShare, 'grl')).status).toBe(403)
    // an admin may
    expect((await look(admin, 'grl-p0')).status).toBe(200)
  })

  test('a light limit on searches per minute', async () => {
    const c = await userWith('grl-rate')
    let last = 0
    let codes = ''
    for (let i = 0; i < 45 && last !== 429; i++) {
      const r = await c.json('GET', '/api/users/lookup?q=zzz')
      last = r.status
      codes = r.data.code ?? ''
    }
    expect(last).toBe(429)
    expect(codes).toBe('grants.lookup-rate')
    // someone else is not held up by it
    const other = await userWith('grl-rate2')
    expect((await other.json('GET', '/api/users/lookup?q=zzz')).status).toBe(200)
  })
})

describe('grants: browsing leaves a line', () => {
  test("a recipient's visit to the folder is on the audit trail once, with the space", async () => {
    const { rec, space, ru } = await pair('audit', 'view')
    await list(rec, space)
    await list(rec, space)
    await rec.raw('GET', `/api/download?${q(space, '/a.txt')}`)
    const rows = (await admin.json('GET', `/api/admin/activity?user=${ru}&pageSize=100`)).data.items
    const browse = rows.filter((r: any) => r.action === 'browse')
    expect(browse).toHaveLength(1)
    expect(browse[0].detail).toBe(space)
    expect(rows.find((r: any) => r.action === 'download')).toMatchObject({ detail: space })
  })
})

describe('a new grant tells the recipient', () => {
  test('the recipient gets a folder-shared notice, the owner none', async () => {
    const { owner, rec } = await pair('nt', 'view')
    const got = await rec.json('GET', '/api/me/notifications')
    const mine = (got.data.items as any[]).filter(n => n.kind === 'folder-shared')
    expect(mine).toHaveLength(1)
    expect(mine[0].params).toEqual({ from: 'Name of gr-nt-o', name: 'proj' })
    expect(mine[0].link).toMatch(/^\/with-me\/[A-Za-z0-9_-]+$/)
    const own = await owner.json('GET', '/api/me/notifications')
    expect((own.data.items as any[]).some(n => n.kind === 'folder-shared')).toBe(false)
  })
})
