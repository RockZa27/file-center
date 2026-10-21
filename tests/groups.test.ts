/**
 * Groups: /api/groups/*, /api/admin/groups*, the space group:<id>, the group quota, the group trash, grants to a group
 * and the notices. Runs in-process on the same app as api.test.ts (see in-process-env.ts); every user here starts with "gp".
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import './in-process-env'

let app: any
let quota: typeof import('../src/quota')
let groupsMod: typeof import('../src/groups')
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
let adminPw = ''
const storage = (...p: string[]) => join(process.env.STORAGE_DIR!, ...p)

async function userWith(username: string, extra: Record<string, unknown> = {}, role = 'user') {
  const r = await admin.json('POST', '/api/admin/users', { username, name: `Name of ${username}`, password: PW, role, permissions: PERMS, publicPermissions: [], ...extra })
  expect(r.status).toBe(200)
  return new Client().login(username, PW)
}

async function makeGroup(name: string, quotaBytes?: number) {
  const r = await admin.json('POST', '/api/admin/groups', { name, ...(quotaBytes === undefined ? {} : { quotaBytes }) })
  expect(r.status).toBe(200)
  const id = r.data.group.id as string
  return { id, space: `group:${id}`, dir: storage('groups', id) }
}
const addMember = (id: string, username: string, perms: 'view' | 'edit') =>
  admin.json('PUT', `/api/admin/groups/${id}/members`, { username, perms })

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
const code = (r: { status: number; data: any }) => `${r.status} ${r.data?.code}`

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  quota = await import('../src/quota')
  groupsMod = await import('../src/groups')
  auth = await import('../src/auth')
  adminPw = process.env.ADMIN_PASSWORD!
  await admin.login('admin', adminPw)
})

describe('groups: what a member may do', () => {
  test('view reads and downloads but changes nothing; edit adds and changes; a stranger gets the answer of an unknown id', async () => {
    const g = await makeGroup('gp Rights')
    writeFileSync(join(g.dir, 'a.txt'), 'aaa')
    const view = await userWith('gp-view')
    const edit = await userWith('gp-edit')
    const out = await userWith('gp-out')
    expect((await addMember(g.id, 'gp-view', 'view')).data).toMatchObject({ ok: true, added: true })
    await addMember(g.id, 'gp-edit', 'edit')

    expect(names(await list(view, g.space))).toEqual(['a.txt'])
    const read = await list(view, g.space)
    expect(read.data.permissions.sort()).toEqual(['batchdownload', 'download', 'read', 'zip'])
    expect((await view.raw('GET', `/api/download?${q(g.space, '/a.txt')}`)).status).toBe(200)
    expect((await view.json('GET', `/api/content?${q(g.space, '/a.txt')}`)).data.content).toBe('aaa')
    expect((await view.json('POST', '/api/batch', { space: g.space, path: '/', items: ['a.txt'] })).status).toBe(200)
    // nothing that changes a file
    for (const [path, body] of [
      ['/api/mkdir', { space: g.space, path: '/', name: 'new' }],
      ['/api/newfile', { space: g.space, path: '/', name: 'new.txt' }],
      ['/api/rename', { space: g.space, path: '/a.txt', name: 'b.txt' }],
      ['/api/delete', { space: g.space, items: ['/a.txt'] }],
      ['/api/zip', { space: g.space, path: '/', items: ['a.txt'] }],
      ['/api/upload', { space: g.space, path: '/', name: 'up.txt', size: 1 }],
    ] as const) expect((await view.json('POST', path, body)).status).toBe(403)
    expect((await view.json('PUT', '/api/content', { space: g.space, path: '/a.txt', content: 'x' })).status).toBe(403)
    expect(readFileSync(join(g.dir, 'a.txt'), 'utf8')).toBe('aaa')
    // never a share link out of a group folder
    expect((await view.json('POST', '/api/shares', { space: g.space, path: '/a.txt', days: 1 })).status).toBe(403)
    expect((await edit.json('POST', '/api/shares', { space: g.space, path: '/a.txt', days: 1 })).status).toBe(403)

    expect((await edit.json('POST', '/api/mkdir', { space: g.space, path: '/', name: 'made' })).status).toBe(200)
    expect((await upload(edit, g.space, 'up.bin', 10)).status).toBe(200)
    expect((await edit.json('PUT', '/api/content', { space: g.space, path: '/a.txt', content: 'bbb' })).status).toBe(200)
    expect((await edit.json('POST', '/api/rename', { space: g.space, path: '/a.txt', name: 'c.txt' })).status).toBe(200)
    expect(names(await list(view, g.space))).toEqual(['c.txt', 'made', 'up.bin'])

    // a stranger, a visitor and a made-up id all look the same
    const unknown = await list(out, 'group:000000000000000000')
    const stranger = await list(out, g.space)
    expect(code(stranger)).toBe(code(unknown))
    expect(stranger.status).toBe(403)
    expect((await list(new Client(), g.space)).status).toBe(401)
    expect(auth.accessFor(null, g.space)).toBeNull()
    expect(auth.accessFor(auth.findUser('gp-out')!, g.space)).toBeNull()
    expect((await upload(out, g.space, 'x.bin', 1)).status).toBe(403)
  })

  test('an admin who is not a member has everything', async () => {
    const g = await makeGroup('gp Admin')
    expect((await admin.json('POST', '/api/mkdir', { space: g.space, path: '/', name: 'by-admin' })).status).toBe(200)
    expect((await upload(admin, g.space, 'a.bin', 5)).status).toBe(200)
    expect(names(await list(admin, g.space))).toEqual(['a.bin', 'by-admin'])
    expect((await admin.json('POST', '/api/delete', { space: g.space, items: ['/a.bin'] })).data.done).toBe(1)
    // the list of "my" groups is about membership
    expect((await admin.json('GET', '/api/groups/mine')).data.items).toEqual([])
  })

  test('removing a member, or the group, takes the access at once; a deleted account leaves its groups', async () => {
    const g = await makeGroup('gp Revoke')
    writeFileSync(join(g.dir, 'a.txt'), 'aaa')
    const m = await userWith('gp-rev')
    await addMember(g.id, 'gp-rev', 'edit')
    const init = await m.json('POST', '/api/upload', { space: g.space, path: '/', name: 'half.bin', size: 5 })
    expect(init.status).toBe(200)
    expect((await list(m, g.space)).status).toBe(200)
    expect((await admin.json('DELETE', `/api/admin/groups/${g.id}/members/gp-rev`)).status).toBe(200)
    expect((await list(m, g.space)).status).toBe(403)
    expect((await m.json('POST', '/api/mkdir', { space: g.space, path: '/', name: 'x' })).status).toBe(403)
    // an upload announced before it stops at the next chunk
    expect((await chunk(m, init.data.id, new Uint8Array(5))).status).toBe(403)
    expect((await admin.json('DELETE', `/api/admin/groups/${g.id}/members/gp-rev`)).data.code).toBe('groups.member-not-found')
    expect((await m.json('GET', '/api/groups/mine')).data.items).toEqual([])

    // a deleted account is in no group any more, and a new account by the same name gets nothing back
    const d = await userWith('gp-gone')
    await addMember(g.id, 'gp-gone', 'edit')
    expect((await list(d, g.space)).status).toBe(200)
    expect((await admin.json('DELETE', '/api/admin/users/gp-gone')).status).toBe(200)
    expect(groupsMod.findGroup(g.id)!.members.map(x => x.username)).not.toContain('gp-gone')
    const again = await userWith('gp-gone')
    expect((await list(again, g.space)).status).toBe(403)
    expect((await again.json('GET', '/api/groups/mine')).data.items).toEqual([])

    // the group itself
    const m2 = await userWith('gp-rev2')
    await addMember(g.id, 'gp-rev2', 'view')
    expect((await list(m2, g.space)).status).toBe(200)
    expect((await admin.json('DELETE', `/api/admin/groups/${g.id}`, { password: adminPw })).status).toBe(200)
    expect((await list(m2, g.space)).status).toBe(403)
    expect((await list(admin, g.space)).status).toBe(403)
  })
})

describe('groups: making and changing', () => {
  test('names: 1 to 64 characters, unique in any letter case, no slash', async () => {
    const g = await makeGroup('gp Name One')
    const make = (name: unknown) => admin.json('POST', '/api/admin/groups', { name })
    expect(code(await make('GP NAME ONE'))).toBe('409 groups.name-taken')
    expect(code(await make('  '))).toBe('400 groups.bad-name')
    expect(code(await make('a/b'))).toBe('400 groups.bad-name')
    expect(code(await make('a\\b'))).toBe('400 groups.bad-name')
    expect(code(await make('x'.repeat(65)))).toBe('400 groups.bad-name')
    expect((await make('x'.repeat(64))).status).toBe(200)
    expect((await admin.json('POST', '/api/admin/groups', { name: 'gp bad quota', quotaBytes: -1 })).data.code).toBe('admin.bad-quota')
    const other = await makeGroup('gp Name Two')
    expect(code(await admin.json('PATCH', `/api/admin/groups/${other.id}`, { name: 'gp name one' }))).toBe('409 groups.name-taken')
    // renaming to its own name in another case is fine, and the folder does not move
    const r = await admin.json('PATCH', `/api/admin/groups/${g.id}`, { name: 'GP NAME ONE', quotaBytes: 5000 })
    expect(r.data.group).toMatchObject({ id: g.id, name: 'GP NAME ONE', quotaBytes: 5000 })
    expect(existsSync(g.dir)).toBe(true)
    expect(code(await admin.json('PATCH', '/api/admin/groups/nope', { name: 'q' }))).toBe('404 groups.not-found')
    expect(code(await admin.json('PUT', '/api/admin/groups/nope/members', { username: 'admin', perms: 'view' }))).toBe('404 groups.not-found')
    expect(code(await admin.json('PUT', `/api/admin/groups/${g.id}/members`, { username: 'nobody-here', perms: 'view' }))).toBe('404 admin.user-not-found')
    expect((await admin.json('PUT', `/api/admin/groups/${g.id}/members`, { username: 'admin', perms: 'owner' })).status).toBe(422)
  })

  test('the folder is made with the group; the list shows members, limit and use', async () => {
    const g = await makeGroup('gp Listed', 1234)
    expect(existsSync(g.dir)).toBe(true)
    expect(g.id).toMatch(/^[a-z0-9]+$/)
    await userWith('gp-listed')
    await addMember(g.id, 'gp-listed', 'edit')
    const row = (await admin.json('GET', '/api/admin/groups')).data.items.find((x: any) => x.id === g.id)
    expect(row).toMatchObject({
      name: 'gp Listed', space: g.space, quotaBytes: 1234, used: 0, createdBy: 'admin',
      members: [{ username: 'gp-listed', name: 'Name of gp-listed', perms: 'edit' }],
    })
    const me = await new Client().login('gp-listed', PW)
    expect((await me.json('GET', '/api/groups/mine')).data.items).toEqual([
      { id: g.id, name: 'gp Listed', perms: 'edit', space: g.space, quotaBytes: 1234, used: 0 },
    ])
    expect((await me.json('GET', '/api/admin/groups')).status).toBe(403)
    expect(groupsMod.groupSpacesOf(auth.findUser('gp-listed'))).toEqual([{ name: 'gp Listed', space: g.space }])
    expect(groupsMod.groupSpacesOf(null)).toEqual([])
  })

  test('deleting asks for the password, and the folder goes to the admin trash, not away', async () => {
    const g = await makeGroup('gp Deleted')
    writeFileSync(join(g.dir, 'keep.txt'), 'precious')
    const m = await userWith('gp-del')
    await addMember(g.id, 'gp-del', 'edit')
    expect(code(await admin.json('DELETE', `/api/admin/groups/${g.id}`, { password: 'not it' }))).toBe('403 auth.wrong-password')
    expect(groupsMod.findGroup(g.id)).toBeDefined()
    expect((await admin.json('DELETE', `/api/admin/groups/${g.id}`, { password: adminPw })).status).toBe(200)
    expect(groupsMod.findGroup(g.id)).toBeUndefined()
    expect(existsSync(g.dir)).toBe(false)
    const trash = (await admin.json('GET', '/api/admin/trash')).data.items as any[]
    const entry = trash.find(x => x.originalPath === `/groups/${g.id}`)
    expect(entry).toBeDefined()
    expect(entry.owner).toBeNull()
    expect(readFileSync(join(process.env.DATA_DIR!, 'trash', entry.id, 'item', 'keep.txt'), 'utf8')).toBe('precious')
    // members see nothing of it, and the admin can bring it back
    expect(((await m.json('GET', '/api/me/trash')).data.items as any[]).some(x => x.id === entry.id)).toBe(false)
    expect((await admin.json('POST', '/api/admin/trash/restore', { id: entry.id })).status).toBe(200)
    expect(readFileSync(join(g.dir, 'keep.txt'), 'utf8')).toBe('precious')
  })
})

describe('groups: homes may not lie inside /groups', () => {
  test('an admin can not give a user a home there, and the overlap checks keep the place reserved', async () => {
    const make = (homedir: string) => admin.json('POST', '/api/admin/users', { username: 'gp-home', name: 'x', password: PW, role: 'user', homedir, permissions: PERMS, publicPermissions: [] })
    for (const home of ['/groups', '/groups/abc', '/Groups/abc/deep', '/GROUPS']) expect(code(await make(home))).toBe('400 admin.home-in-groups')
    expect(auth.findUser('gp-home')).toBeUndefined()
    expect((await make('/groupsX')).status).toBe(200)
    // a change of the folder of an existing user is refused the same way
    expect(code(await admin.json('PUT', '/api/admin/users/gp-home', { homedir: '/groups/xyz' }))).toBe('400 admin.home-in-groups')
    expect(auth.findUser('gp-home')!.homedir).toBe('/groupsX')
    expect(auth.homeOverlapsOther('/groups/abc')).toBe(true)
    expect(auth.homeOverlapsOther('/groups')).toBe(true)
    expect(auth.homeOverlapsOther('/users/fresh')).toBe(false)
    // a manager does not manage an account whose home is inside it (even if it is /users/<name> by name: the home decides)
    const mgr = auth.findUser('gp-home')!
    const odd = { ...mgr, username: 'gp-odd', role: 'user' as const, homedir: '/groups/abc' }
    expect(auth.canManage({ ...mgr, role: 'manager' }, odd)).toBe(false)
  })
})

describe('groups: quota', () => {
  test('uploads and saves count against the group, never against the member; 507 when it is full', async () => {
    const g = await makeGroup('gp Quota', 10_000)
    const m = await userWith('gp-quota', { quotaBytes: 5_000 })
    await addMember(g.id, 'gp-quota', 'edit')
    const owner = groupsMod.groupOwner(groupsMod.findGroup(g.id)!)
    expect(owner.username).toBe(`group:${g.id}`)
    expect(quota.limitOf(owner)).toBe(10_000)
    expect(quota.ownerOfPath(join(g.dir, 'sub', 'x'))?.username).toBe(owner.username)

    expect((await upload(m, g.space, 'one.bin', 6000)).status).toBe(200)
    // more than the member's own 5000 fits: it is the group's limit that counts
    await quota.counted(owner)
    expect(quota.usage(owner).used).toBe(6000)
    expect((await m.json('GET', '/api/me/usage')).data).toMatchObject({ used: 0, quota: 5000 })
    expect((await m.json('GET', '/api/groups/mine')).data.items[0]).toMatchObject({ used: 6000, quotaBytes: 10_000 })

    const over = await m.json('POST', '/api/upload', { space: g.space, path: '/', name: 'two.bin', size: 5000 })
    expect(code(over)).toBe('507 quota.exceeded')
    expect(over.data.params).toMatchObject({ quota: 10_000 })
    expect((await upload(m, g.space, 'two.bin', 4000)).status).toBe(200)
    expect(code(await m.json('POST', '/api/upload', { space: g.space, path: '/', name: 'three.bin', size: 1 }))).toBe('507 quota.exceeded')
    // a delete gives the space back; a bigger limit gives room at once
    expect((await m.json('POST', '/api/delete', { space: g.space, items: ['/one.bin'] })).data.done).toBe(1)
    expect((await upload(m, g.space, 'three.bin', 5000)).status).toBe(200)
    expect((await admin.json('PATCH', `/api/admin/groups/${g.id}`, { quotaBytes: 0 })).status).toBe(200)
    expect((await upload(m, g.space, 'four.bin', 50_000)).status).toBe(200)
    expect((await m.json('GET', '/api/me/usage')).data.used).toBe(0)
  })

  test('the quota of an admin who writes in a group space is the group\'s too', async () => {
    const g = await makeGroup('gp Quota Admin', 100)
    expect(code(await admin.json('POST', '/api/upload', { space: g.space, path: '/', name: 'big.bin', size: 101 }))).toBe('507 quota.exceeded')
  })
})

describe('groups: trash', () => {
  test('items belong to the group; editors see and restore them; only the one who deleted destroys', async () => {
    const g = await makeGroup('gp Trash')
    const a = await userWith('gp-t-a')
    const b = await userWith('gp-t-b')
    const v = await userWith('gp-t-v')
    const out = await userWith('gp-t-out')
    await addMember(g.id, 'gp-t-a', 'edit')
    await addMember(g.id, 'gp-t-b', 'edit')
    await addMember(g.id, 'gp-t-v', 'view')
    writeFileSync(join(g.dir, 'one.txt'), '1')
    writeFileSync(join(g.dir, 'two.txt'), '2')
    expect((await a.json('POST', '/api/delete', { space: g.space, items: ['/one.txt', '/two.txt'] })).data.done).toBe(2)

    const mine = (c: Client) => c.json('GET', '/api/me/trash')
    const seen = (await mine(b)).data.items as any[]
    expect(seen.map(x => x.name).sort()).toEqual(['one.txt', 'two.txt'])
    expect(seen[0]).toMatchObject({ owner: `group:${g.id}`, group: { id: g.id, name: 'gp Trash' }, space: g.space, restorable: true, deletedBy: 'gp-t-a' })
    expect((await mine(a)).data.items).toHaveLength(2)
    expect((await mine(v)).data.items).toEqual([])
    expect((await mine(out)).data.items).toEqual([])
    const one = seen.find(x => x.name === 'one.txt').id
    const two = seen.find(x => x.name === 'two.txt').id
    // outsiders and view members get the answer of an unknown id
    for (const c of [v, out]) {
      expect((await c.json('POST', `/api/me/trash/${one}/restore`)).status).toBe(404)
      expect((await c.json('DELETE', `/api/me/trash/${one}`)).status).toBe(404)
    }
    // another editor restores (back into the group) but may not destroy
    const back = await b.json('POST', `/api/me/trash/${one}/restore`)
    expect(back.data).toMatchObject({ ok: true, space: g.space, path: '/one.txt' })
    expect(readFileSync(join(g.dir, 'one.txt'), 'utf8')).toBe('1')
    expect(code(await b.json('DELETE', `/api/me/trash/${two}`))).toBe('403 trash.cannot-purge')
    expect(await b.json('DELETE', '/api/me/trash')).toMatchObject({ data: { removed: 0 } })
    expect((await mine(a)).data.items).toHaveLength(1)
    // the one who deleted it may
    expect((await a.json('DELETE', `/api/me/trash/${two}`)).data.removed).toBe(1)
    expect((await mine(b)).data.items).toEqual([])
    // when the editor is made a viewer the entries are no longer theirs
    writeFileSync(join(g.dir, 'three.txt'), '3')
    await a.json('POST', '/api/delete', { space: g.space, items: ['/three.txt'] })
    await addMember(g.id, 'gp-t-a', 'view')
    expect((await mine(a)).data.items).toEqual([])
  })

  test('the restore counts against the group quota', async () => {
    const g = await makeGroup('gp Trash Quota', 1000)
    const a = await userWith('gp-tq')
    await addMember(g.id, 'gp-tq', 'edit')
    expect((await upload(a, g.space, 'f.bin', 800)).status).toBe(200)
    expect((await a.json('POST', '/api/delete', { space: g.space, items: ['/f.bin'] })).data.done).toBe(1)
    expect((await upload(a, g.space, 'g.bin', 800)).status).toBe(200)
    const id = ((await a.json('GET', '/api/me/trash')).data.items as any[]).find(x => x.name === 'f.bin').id
    expect((await a.json('POST', `/api/me/trash/${id}/restore`)).status).toBe(507)
  })

  test('when an account is deleted its trash entries of a group are not passed to a new account of that name', async () => {
    const g = await makeGroup('gp Trash Gone')
    const a = await userWith('gp-tg-a')
    const b = await userWith('gp-tg-b')
    await addMember(g.id, 'gp-tg-a', 'edit')
    await addMember(g.id, 'gp-tg-b', 'edit')
    writeFileSync(join(g.dir, 'x.txt'), 'x')
    await a.json('POST', '/api/delete', { space: g.space, items: ['/x.txt'] })
    const id = ((await b.json('GET', '/api/me/trash')).data.items as any[])[0].id
    await admin.json('DELETE', '/api/admin/users/gp-tg-a')
    const again = await userWith('gp-tg-a')
    await addMember(g.id, 'gp-tg-a', 'edit')
    // the new account is an editor and sees the group's entry, but did not delete it, so it can not destroy it
    expect(code(await again.json('DELETE', `/api/me/trash/${id}`))).toBe('403 trash.cannot-purge')
    expect(((await b.json('GET', '/api/me/trash')).data.items as any[])[0].deletedBy).toMatch(/^~gp-tg-a@/)
  })
})

describe('groups: a folder shared with a group', () => {
  async function setup(tag: string, perms: 'view' | 'edit' = 'edit') {
    const g = await makeGroup(`gp Share ${tag}`)
    const owner = await userWith(`gp-${tag}-o`)
    const m1 = await userWith(`gp-${tag}-1`)
    const m2 = await userWith(`gp-${tag}-2`)
    const out = await userWith(`gp-${tag}-x`)
    await addMember(g.id, `gp-${tag}-o`, 'edit')
    await addMember(g.id, `gp-${tag}-1`, 'edit')
    await addMember(g.id, `gp-${tag}-2`, 'view')
    mkdirSync(storage('users', `gp-${tag}-o`, 'proj'), { recursive: true })
    writeFileSync(storage('users', `gp-${tag}-o`, 'proj', 'a.txt'), 'aaa')
    const made = await owner.json('POST', '/api/grants', { space: 'home', path: '/proj', toGroup: g.id, perms })
    expect(made.status).toBe(200)
    return { g, owner, m1, m2, out, grant: made.data.grant, space: `grant:${made.data.grant.id}`, tag }
  }

  test('every member sees it (a viewer no more than view); the owner ends it; a member can not leave it', async () => {
    const s = await setup('a')
    expect(s.grant).toMatchObject({ to: null, toName: null, toGroup: s.g.id, toGroupName: 'gp Share a', perms: 'edit', active: true })
    const mine = (await s.owner.json('GET', '/api/grants/mine')).data.items
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ toGroup: s.g.id, toGroupName: 'gp Share a' })
    // the owner is in the group but does not get his own folder back as a share
    expect((await s.owner.json('GET', '/api/grants/to-me')).data.items).toEqual([])
    const one = (await s.m1.json('GET', '/api/grants/to-me')).data.items
    expect(one).toHaveLength(1)
    expect(one[0]).toMatchObject({ id: s.grant.id, space: s.space, name: 'proj', owner: 'gp-a-o', perms: 'edit', viaGroup: { id: s.g.id, name: 'gp Share a' } })
    expect((await s.m2.json('GET', '/api/grants/to-me')).data.items[0]).toMatchObject({ perms: 'view' })
    expect((await s.out.json('GET', '/api/grants/to-me')).data.items).toEqual([])

    expect(names(await list(s.m1, s.space))).toEqual(['a.txt'])
    expect((await s.m1.json('POST', '/api/mkdir', { space: s.space, path: '/', name: 'by-m1' })).status).toBe(200)
    expect(names(await list(s.m2, s.space))).toEqual(['a.txt', 'by-m1'])
    expect((await s.m2.json('POST', '/api/mkdir', { space: s.space, path: '/', name: 'by-m2' })).status).toBe(403)
    expect((await list(s.out, s.space)).status).toBe(403)
    expect(code(await list(s.out, s.space))).toBe(code(await list(s.out, 'grant:ffffffffffffffffffffffff')))

    // a member can not end it alone, nor change it
    expect((await s.m1.json('DELETE', `/api/grants/${s.grant.id}`)).status).toBe(404)
    expect((await s.m1.json('PATCH', `/api/grants/${s.grant.id}`, { perms: 'view' })).status).toBe(404)
    // the same folder and group again changes the rights instead of making a second grant
    const again = await s.owner.json('POST', '/api/grants', { space: 'home', path: '/proj', toGroup: s.g.id, perms: 'view' })
    expect(again.data).toMatchObject({ created: false, grant: { id: s.grant.id, perms: 'view' } })
    expect((await s.m1.json('POST', '/api/mkdir', { space: s.space, path: '/', name: 'late' })).status).toBe(403)
    expect((await s.owner.json('DELETE', `/api/grants/${s.grant.id}`)).status).toBe(200)
    expect((await list(s.m1, s.space)).status).toBe(403)
  })

  test('a member who is removed loses it; so does everybody when the group is deleted', async () => {
    const s = await setup('b')
    expect((await list(s.m1, s.space)).status).toBe(200)
    await admin.json('DELETE', `/api/admin/groups/${s.g.id}/members/gp-b-1`)
    expect((await list(s.m1, s.space)).status).toBe(403)
    expect((await s.m1.json('GET', '/api/grants/to-me')).data.items).toEqual([])
    expect((await list(s.m2, s.space)).status).toBe(200)
    await admin.json('DELETE', `/api/admin/groups/${s.g.id}`, { password: adminPw })
    expect((await list(s.m2, s.space)).status).toBe(403)
    expect((await s.owner.json('GET', '/api/grants/mine')).data.items).toEqual([])
  })

  test('only a member (or an admin) may share with a group; exactly one recipient; the group lookup', async () => {
    const s = await setup('c')
    const body = (extra: Record<string, unknown>) => ({ space: 'home', path: '/proj', perms: 'view', ...extra })
    mkdirSync(storage('users', 'gp-c-x', 'proj'), { recursive: true })
    expect(code(await s.out.json('POST', '/api/grants', body({ toGroup: s.g.id })))).toBe('404 groups.not-found')
    expect(code(await s.owner.json('POST', '/api/grants', body({ toGroup: 'nope' })))).toBe('404 groups.not-found')
    expect(code(await s.owner.json('POST', '/api/grants', body({})))).toBe('400 grants.to-one')
    expect(code(await s.owner.json('POST', '/api/grants', body({ to: 'gp-c-1', toGroup: s.g.id })))).toBe('400 grants.to-one')
    expect((await s.owner.json('GET', '/api/grants/mine')).data.items).toHaveLength(1)

    expect((await s.owner.json('GET', '/api/groups/lookup?q=share')).data.groups).toEqual([{ id: s.g.id, name: 'gp Share c' }])
    expect((await s.owner.json('GET', '/api/groups/lookup?q=nothing-like-it')).data.groups).toEqual([])
    expect((await s.out.json('GET', '/api/groups/lookup?q=share')).data.groups).toEqual([])
    expect((await s.owner.json('GET', '/api/groups/lookup')).data.groups.map((x: any) => x.name)).toEqual(['gp Share c'])
    expect((await new Client().json('GET', '/api/groups/lookup?q=x')).status).toBe(401)
    const noShare = await userWith('gp-c-noshare', { permissions: ['read'] })
    expect((await noShare.json('GET', '/api/groups/lookup?q=x')).status).toBe(403)
    // an admin may share with any group, and sees all of them in the lookup
    mkdirSync(storage('admin-proj'), { recursive: true })
    expect((await admin.json('POST', '/api/grants', { space: 'home', path: '/admin-proj', toGroup: s.g.id, perms: 'view' })).status).toBe(200)
    expect((await admin.json('GET', '/api/groups/lookup?q=share c')).data.groups).toHaveLength(1)
  })

  test("what a member adds in a shared folder counts against the owner's quota, not the group's", async () => {
    const g = await makeGroup('gp Share Quota', 100)
    const owner = await userWith('gp-sq-o', { quotaBytes: 10_000 })
    const m = await userWith('gp-sq-m')
    await addMember(g.id, 'gp-sq-o', 'edit')
    await addMember(g.id, 'gp-sq-m', 'edit')
    mkdirSync(storage('users', 'gp-sq-o', 'proj'), { recursive: true })
    const made = await owner.json('POST', '/api/grants', { space: 'home', path: '/proj', toGroup: g.id, perms: 'edit' })
    expect((await upload(m, `grant:${made.data.grant.id}`, 'big.bin', 3000)).status).toBe(200)
    await quota.ready(auth.findUser('gp-sq-o')!)
    expect((await owner.json('GET', '/api/me/usage')).data.used).toBe(3000)
  })
})

describe('groups: managers', () => {
  test('a manager adds and removes only the users they manage, in a group they are in, with no more than their own rights', async () => {
    const mgrC = await userWith('gp-mgr', {}, 'manager')
    const plain = await userWith('gp-m-plain')
    const other = await userWith('gp-m-other', {}, 'manager')
    const g = await makeGroup('gp Managers')
    const hidden = await makeGroup('gp Managers Hidden')
    const adminAdds = await addMember(g.id, 'gp-mgr', 'view')
    expect(adminAdds.status).toBe(200)

    // may not make, change or delete groups
    expect((await mgrC.json('POST', '/api/admin/groups', { name: 'gp mgr made' })).status).toBe(403)
    expect((await mgrC.json('PATCH', `/api/admin/groups/${g.id}`, { name: 'gp mgr renamed' })).status).toBe(403)
    expect((await mgrC.json('DELETE', `/api/admin/groups/${g.id}`, { password: PW })).status).toBe(403)
    expect(groupsMod.findGroup(g.id)!.name).toBe('gp Managers')

    // sees only the groups they are in
    expect((await mgrC.json('GET', '/api/admin/groups')).data.items.map((x: any) => x.id)).toEqual([g.id])
    expect(code(await mgrC.json('PUT', `/api/admin/groups/${hidden.id}/members`, { username: 'gp-m-plain', perms: 'view' }))).toBe('404 groups.not-found')

    expect((await mgrC.json('PUT', `/api/admin/groups/${g.id}/members`, { username: 'gp-m-plain', perms: 'view' })).data).toMatchObject({ ok: true, added: true })
    expect((await list(plain, g.space)).status).toBe(200)
    // not more than their own rights (they are a viewer)
    expect(code(await mgrC.json('PUT', `/api/admin/groups/${g.id}/members`, { username: 'gp-m-plain', perms: 'edit' }))).toBe('403 groups.not-manageable')
    // not another manager, not an admin, not themself
    for (const name of ['gp-m-other', 'admin', 'gp-mgr']) {
      expect(code(await mgrC.json('PUT', `/api/admin/groups/${g.id}/members`, { username: name, perms: 'view' }))).toBe('403 groups.not-manageable')
    }
    await addMember(g.id, 'gp-m-other', 'view')
    expect(code(await mgrC.json('DELETE', `/api/admin/groups/${g.id}/members/gp-m-other`))).toBe('403 groups.not-manageable')
    expect(groupsMod.memberOf(groupsMod.findGroup(g.id)!, 'gp-m-other')).toBeDefined()
    expect((await mgrC.json('DELETE', `/api/admin/groups/${g.id}/members/gp-m-plain`)).status).toBe(200)
    expect((await list(plain, g.space)).status).toBe(403)
    // an editor-manager may give edit
    await addMember(g.id, 'gp-mgr', 'edit')
    expect((await mgrC.json('PUT', `/api/admin/groups/${g.id}/members`, { username: 'gp-m-plain', perms: 'edit' })).status).toBe(200)
    // a plain user and a visitor are refused
    expect((await plain.json('PUT', `/api/admin/groups/${g.id}/members`, { username: 'gp-m-plain', perms: 'edit' })).status).toBe(403)
    expect((await new Client().json('GET', '/api/admin/groups')).status).toBe(401)
    expect(other).toBeDefined()
  })
})

describe('groups: notices, audit and backup', () => {
  test('a user added to a group is told once; a change of rights is no news', async () => {
    const g = await makeGroup('gp Notice')
    const m = await userWith('gp-note')
    await addMember(g.id, 'gp-note', 'view')
    await addMember(g.id, 'gp-note', 'edit')
    const items = ((await m.json('GET', '/api/me/notifications')).data.items as any[]).filter(n => n.kind === 'group-added')
    expect(items).toHaveLength(1)
    expect(items[0].params).toMatchObject({ name: 'gp Notice' })
    expect(items[0].link).toBe(`/groups/${g.id}`)
    expect(items[0].text).toContain('gp Notice')
    expect((await m.json('GET', '/api/me/notify-prefs')).data.events['group-added']).toEqual({ web: true, email: false, line: false })
  })

  test('a folder shared with a group tells every member but the owner', async () => {
    const g = await makeGroup('gp Notice Share')
    const owner = await userWith('gp-ns-o')
    const m1 = await userWith('gp-ns-1')
    const m2 = await userWith('gp-ns-2')
    for (const n of ['gp-ns-o', 'gp-ns-1', 'gp-ns-2']) await addMember(g.id, n, 'view')
    mkdirSync(storage('users', 'gp-ns-o', 'proj'), { recursive: true })
    const made = await owner.json('POST', '/api/grants', { space: 'home', path: '/proj', toGroup: g.id, perms: 'view' })
    const shared = async (c: Client) => ((await c.json('GET', '/api/me/notifications')).data.items as any[]).filter(n => n.kind === 'folder-shared')
    for (const c of [m1, m2]) {
      const got = await shared(c)
      expect(got).toHaveLength(1)
      expect(got[0].link).toBe(`/with-me/${made.data.grant.id}`)
      expect(got[0].params).toEqual({ from: 'Name of gp-ns-o', name: 'proj' })
    }
    expect(await shared(owner)).toEqual([])
  })

  test('the audit trail has the changes and the looking', async () => {
    const g = await makeGroup('gp Audited')
    const m = await userWith('gp-aud')
    await addMember(g.id, 'gp-aud', 'edit')
    await admin.json('PATCH', `/api/admin/groups/${g.id}`, { name: 'gp Audited 2' })
    await list(m, g.space)
    await list(m, g.space)
    await m.raw('GET', `/api/download?${q(g.space, '/none.txt')}`)
    writeFileSync(join(g.dir, 'a.txt'), 'a')
    await m.raw('GET', `/api/download?${q(g.space, '/a.txt')}`)
    await admin.json('DELETE', `/api/admin/groups/${g.id}/members/gp-aud`)
    await admin.json('DELETE', `/api/admin/groups/${g.id}`, { password: adminPw })
    const rows = (await admin.json('GET', '/api/admin/activity?pageSize=100&q=gp%20Audited')).data.items as any[]
    const has = (action: string) => rows.filter(r => r.action === action)
    expect(has('group-create')).toHaveLength(1)
    expect(has('group-update')).toHaveLength(1)
    expect(has('group-member-add')[0]).toMatchObject({ target: 'gp Audited', detail: 'gp-aud, edit' })
    expect(has('group-member-remove')[0]).toMatchObject({ detail: 'gp-aud' })
    expect(has('group-delete')).toHaveLength(1)
    const mine = ((await admin.json('GET', '/api/admin/activity?user=gp-aud&pageSize=100')).data.items as any[])
    expect(mine.filter(r => r.action === 'browse')).toHaveLength(1)
    expect(mine.find(r => r.action === 'browse')).toMatchObject({ detail: g.space })
    expect(mine.find(r => r.action === 'download')).toMatchObject({ detail: g.space })
  })

  test('a backup carries groups.json', async () => {
    await makeGroup('gp Backed Up')
    const made = await admin.json('POST', '/api/admin/backups')
    expect(made.status).toBe(200)
    const zip = unzipSync(new Uint8Array(await (await admin.raw('GET', `/api/admin/backups/${made.data.name}/download`)).arrayBuffer()))
    expect(Object.keys(zip)).toContain('groups.json')
    expect(JSON.parse(Buffer.from(zip['groups.json']).toString('utf8')).groups.some((x: any) => x.name === 'gp Backed Up')).toBe(true)
  })
})
