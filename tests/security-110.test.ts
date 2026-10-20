/**
 * The low-severity findings of the 1.10.0 security review: a deleted account's trash, purging from a shared folder,
 * uploads that outlive their rights and user-name guessing. (The notification floods are in notify.test.ts, which has
 * the stand-in mail and LINE servers.) Runs in-process on the same app as api.test.ts; every user here starts with "sc-".
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import './in-process-env'

let app: any
let paths: typeof import('../src/config').paths
let quota: typeof import('../src/quota')
let auth: typeof import('../src/auth')
let trashMod: typeof import('../src/trash')

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

async function createUser(username: string, extra: Record<string, unknown> = {}) {
  const r = await admin.json('POST', '/api/admin/users', { username, name: `Name of ${username}`, password: PW, role: 'user', permissions: PERMS, publicPermissions: [], ...extra })
  expect(r.status).toBe(200)
}
async function userWith(username: string, extra: Record<string, unknown> = {}) {
  await createUser(username, extra)
  return new Client().login(username, PW)
}

/** an owner with /proj and a recipient it is shared with */
async function pair(tag: string, perms: 'view' | 'edit', ownerExtra: Record<string, unknown> = {}) {
  const owner = await userWith(`sc-${tag}-o`, ownerExtra)
  const rec = await userWith(`sc-${tag}-r`)
  mkdirSync(home(`sc-${tag}-o`, 'proj'), { recursive: true })
  writeFileSync(home(`sc-${tag}-o`, 'proj', 'a.txt'), 'aaa')
  const made = await owner.json('POST', '/api/grants', { space: 'home', path: '/proj', to: `sc-${tag}-r`, perms })
  expect(made.status).toBe(200)
  return { owner, rec, id: made.data.grant.id as string, space: `grant:${made.data.grant.id}`, ou: `sc-${tag}-o`, ru: `sc-${tag}-r` }
}

const del = (c: Client, space: string, ...items: string[]) => c.json('POST', '/api/delete', { space, items, withTrash: true })
const mine = async (c: Client) => (await c.json('GET', '/api/me/trash')).data.items as any[]
const adminTrash = async () => (await admin.json('GET', '/api/admin/trash')).data.items as any[]
const chunk = (c: Client, id: string, data: Uint8Array) => c.raw('PUT', `/api/upload/${id}/0`, data, { 'content-type': 'application/octet-stream' })

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ paths } = await import('../src/config'))
  quota = await import('../src/quota')
  auth = await import('../src/auth')
  trashMod = await import('../src/trash')
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
})

// ───────────── F1 ─────────────

describe('F1: a deleted account does not pass its trash to a new account of the same name', () => {
  test("bob is deleted and made again: his trash is not the new bob's, the admin still sees it", async () => {
    const bob = await userWith('sc-bob')
    writeFileSync(home('sc-bob', 'one.txt'), '1')
    writeFileSync(home('sc-bob', 'two.txt'), '22')
    const r = await del(bob, 'home', '/one.txt', '/two.txt')
    expect(r.data.done).toBe(2)
    const ids = (r.data.trashed as any[]).map(t => t.id)
    expect(await mine(bob)).toHaveLength(2)
    // an old entry (from before 1.10): no owner recorded, found from where it was
    writeFileSync(home('sc-bob', 'old.txt'), 'o')
    const old = (await del(bob, 'home', '/old.txt')).data.trashed[0].id as string
    const metaFile = join(paths.trash, old, 'meta.json')
    const meta = JSON.parse(await Bun.file(metaFile).text())
    delete meta.owner
    delete meta.space
    writeFileSync(metaFile, JSON.stringify(meta))
    expect(await mine(bob)).toHaveLength(3)

    expect((await admin.json('DELETE', '/api/admin/users/sc-bob')).status).toBe(200)
    await createUser('sc-bob')
    const bob2 = await new Client().login('sc-bob', PW)
    expect(await mine(bob2)).toEqual([])
    for (const id of [...ids, old]) {
      expect((await bob2.json('POST', `/api/me/trash/${id}/restore`)).status).toBe(404)
      expect((await bob2.json('DELETE', `/api/me/trash/${id}`)).status).toBe(404)
    }
    expect((await bob2.json('DELETE', '/api/me/trash')).data.removed).toBe(0)
    const all = await adminTrash()
    for (const id of [...ids, old]) {
      const e = all.find(x => x.id === id)
      expect(e).toBeTruthy()
      expect(e.owner).toMatch(/^~sc-bob@\d+$/)
      expect(e.deletedBy).toMatch(/^~sc-bob@\d+$/)
    }
    // the admin can still bring one back
    expect((await admin.json('POST', '/api/admin/trash/restore', { id: ids[0] })).status).toBe(200)
  })

  test('what a recipient deleted from a folder shared with them is not theirs either once their account is gone', async () => {
    const a = await pair('rec', 'edit')
    expect((await del(a.rec, a.space, '/a.txt')).data.done).toBe(1)
    expect(await mine(a.rec)).toHaveLength(1)
    expect((await admin.json('DELETE', `/api/admin/users/${a.ru}`)).status).toBe(200)
    await createUser(a.ru)
    const again = await new Client().login(a.ru, PW)
    expect(await mine(again)).toEqual([])
    // the owner keeps it
    expect(await mine(a.owner)).toHaveLength(1)
  })

  test('an entry without a recorded owner does not belong to an account made after it was deleted', () => {
    const u = auth.findUser('sc-bob')!
    const base = { id: '0', name: 'x', type: 'file' as const, size: 1, originalPath: '/users/sc-bob/x.txt', deletedBy: 'sc-bob' }
    expect(trashMod.trashOwner({ ...base, deletedAt: new Date(Date.parse(u.createdAt) + 60_000).toISOString() })).toBe('sc-bob')
    expect(trashMod.trashOwner({ ...base, deletedAt: new Date(Date.parse(u.createdAt) - 60_000).toISOString() })).toBeNull()
  })
})

// ───────────── F2 ─────────────

describe('F2: a recipient with edit can undo a delete but not destroy it', () => {
  test("purge (one and all) is the owner's; the recipient restores", async () => {
    const a = await pair('purge', 'edit')
    writeFileSync(home(a.ou, 'proj', 'b.txt'), 'bbb')
    const r = await del(a.rec, a.space, '/a.txt', '/b.txt')
    expect(r.data.done).toBe(2)
    const [first, second] = (r.data.trashed as any[]).map(t => t.id)
    // the recipient sees both, the owner too
    expect(await mine(a.rec)).toHaveLength(2)
    expect(await mine(a.owner)).toHaveLength(2)
    const one = await a.rec.json('DELETE', `/api/me/trash/${first}`)
    expect(one.status).toBe(403)
    expect(one.data.code).toBe('trash.cannot-purge')
    const all = await a.rec.json('DELETE', '/api/me/trash')
    expect(all.status).toBe(200)
    expect(all.data.removed).toBe(0)
    expect(existsSync(join(paths.trash, first))).toBe(true)
    expect(existsSync(join(paths.trash, second))).toBe(true)
    // undo is still theirs while they can edit
    expect((await a.rec.json('POST', `/api/me/trash/${first}/restore`)).status).toBe(200)
    expect(existsSync(home(a.ou, 'proj', 'a.txt'))).toBe(true)
    // the owner empties
    expect((await a.owner.json('DELETE', `/api/me/trash/${second}`)).status).toBe(200)
    expect(existsSync(join(paths.trash, second))).toBe(false)
  })

  test('the owner can empty it all, and the public folder stays with the one who deleted from it', async () => {
    const a = await pair('purge2', 'edit')
    expect((await del(a.rec, a.space, '/a.txt')).data.done).toBe(1)
    expect((await a.owner.json('DELETE', '/api/me/trash')).data.removed).toBe(1)
    const pub = await userWith('sc-pub', { publicPermissions: ['read', 'write', 'upload'] })
    writeFileSync(join(paths.publicDir, 'sc-pub.txt'), 'p')
    const id = (await del(pub, 'public', '/sc-pub.txt')).data.trashed[0].id
    expect((await mine(pub)).map(i => i.id)).toContain(id)
    expect((await pub.json('DELETE', `/api/me/trash/${id}`)).status).toBe(200)
  })
})

// ───────────── F3 ─────────────

describe('F3: an upload in progress stops when its right is taken away', () => {
  async function start(c: Client, space: string, name: string, bytes: number) {
    const init = await c.json('POST', '/api/upload', { space, path: '/', name, size: bytes })
    expect(init.status).toBe(200)
    return init.data.id as string
  }

  test('a revoked grant: the next chunk and the end are 403, nothing is written, the quota hold is given back', async () => {
    const a = await pair('up', 'edit', { quotaBytes: 10_000 })
    const owner = auth.findUser(a.ou)!
    await quota.ready(owner)
    const before = (await a.owner.json('GET', '/api/me/usage')).data.used
    const id = await start(a.rec, a.space, 'late.bin', 4000)
    await quota.ready(owner)
    expect((await a.owner.json('GET', '/api/me/usage')).data.used).toBe(before + 4000)
    expect((await a.owner.json('DELETE', `/api/grants/${a.id}`)).status).toBe(200)
    expect((await chunk(a.rec, id, new Uint8Array(4000))).status).toBe(403)
    expect(existsSync(join(paths.tmp, id))).toBe(false)
    await quota.ready(owner)
    expect((await a.owner.json('GET', '/api/me/usage')).data.used).toBe(before)
    // the end of an upload whose chunks were all in before the grant went
    const b = await pair('up1b', 'edit', { quotaBytes: 10_000 })
    const idB = await start(b.rec, b.space, 'late.bin', 4000)
    expect((await chunk(b.rec, idB, new Uint8Array(4000))).status).toBe(200)
    expect((await b.owner.json('DELETE', `/api/grants/${b.id}`)).status).toBe(200)
    expect((await b.rec.json('POST', `/api/upload/${idB}/complete`)).status).toBe(403)
    expect(existsSync(home(b.ou, 'proj', 'late.bin'))).toBe(false)
    expect(existsSync(join(paths.tmp, idB))).toBe(false)
    await quota.ready(auth.findUser(b.ou)!)
    expect((await b.owner.json('GET', '/api/me/usage')).data.used).toBe(3)
  })

  test('a grant changed to view stops the end of the upload too', async () => {
    const a = await pair('up2', 'edit')
    const id = await start(a.rec, a.space, 'x.bin', 10)
    expect((await chunk(a.rec, id, new Uint8Array(10))).status).toBe(200)
    expect((await a.owner.json('PATCH', `/api/grants/${a.id}`, { perms: 'view' })).status).toBe(200)
    expect((await a.rec.json('POST', `/api/upload/${id}/complete`)).status).toBe(403)
    expect(existsSync(home(a.ou, 'proj', 'x.bin'))).toBe(false)
    expect(existsSync(join(paths.tmp, id))).toBe(false)
  })

  test('home: a user whose upload permission is taken away cannot go on', async () => {
    const c = await userWith('sc-upm', { quotaBytes: 10_000 })
    const u = auth.findUser('sc-upm')!
    const id = await start(c, 'home', 'h.bin', 10)
    expect((await admin.json('PUT', '/api/admin/users/sc-upm', { permissions: ['read'] })).status).toBe(200)
    expect((await chunk(c, id, new Uint8Array(10))).status).toBe(403)
    expect(existsSync(home('sc-upm', 'h.bin'))).toBe(false)
    await quota.ready(u)
    expect((await c.json('GET', '/api/me/usage')).data.used).toBe(0)
  })

  test('an upload nobody changed still goes through', async () => {
    const a = await pair('up3', 'edit')
    const id = await start(a.rec, a.space, 'ok.bin', 10)
    expect((await chunk(a.rec, id, new Uint8Array(10))).status).toBe(200)
    expect((await a.rec.json('POST', `/api/upload/${id}/complete`)).status).toBe(200)
    expect(existsSync(home(a.ou, 'proj', 'ok.bin'))).toBe(true)
  })

  test('an upload-request link that is taken back stops its visitors', async () => {
    const o = await userWith('sc-link')
    mkdirSync(home('sc-link', 'inbox'), { recursive: true })
    const mk = await o.json('POST', '/api/shares', { space: 'home', path: '/inbox', days: 7, kind: 'upload' })
    expect(mk.status).toBe(200)
    const token = mk.data.token as string
    const v = new Client()
    const a = await v.json('POST', `/api/s/${token}/upload`, { name: 'v.bin', size: 5 })
    expect(a.status).toBe(200)
    expect((await o.json('DELETE', `/api/shares/${mk.data.share.id}`)).status).toBe(200)
    const put = await v.raw('PUT', `/api/s/${token}/upload/${a.data.id}/0`, new Uint8Array(5), { 'content-type': 'application/octet-stream' })
    expect(put.status).toBeGreaterThanOrEqual(400)
    expect((await v.json('POST', `/api/s/${token}/upload/${a.data.id}/complete`)).status).toBeGreaterThanOrEqual(400)
    expect(existsSync(home('sc-link', 'inbox', 'v.bin'))).toBe(false)
  })
})

// ───────────── F4 ─────────────

describe('F4: picking a person is no way to list the accounts', () => {
  const look = (c: Client, s: string) => c.json('GET', `/api/users/lookup?q=${encodeURIComponent(s)}`)
  const names = (r: { data: any }) => (r.data.users as any[]).map(u => u.username)

  test('three letters at least, staff only for staff, searches 20 a minute', async () => {
    const plain = await userWith('sc-look')
    await createUser('sc-look-boss', { role: 'manager' })
    await createUser('sc-look-peer')
    const short = await look(plain, 'sc')
    expect(short.status).toBe(400)
    expect(short.data.code).toBe('grants.query-short')
    expect(short.data.params).toEqual({ min: 3 })
    expect(names(await look(plain, 'sc-look-'))).toEqual(['sc-look-peer'])
    expect(names(await look(plain, 'sc-look-boss'))).toEqual([])
    expect(names(await look(plain, 'admin'))).not.toContain('admin')
    const mgr = await new Client().login('sc-look-boss', PW)
    expect(names(await look(mgr, 'sc-look-'))).toEqual(['sc-look-peer'])
    expect(names(await look(mgr, 'adm'))).toContain('admin')
    expect(names(await look(admin, 'sc-look-'))).toEqual(['sc-look-boss', 'sc-look-peer'])
    // the exact name still works for sharing with staff
    mkdirSync(home('sc-look', 'f'), { recursive: true })
    const g = await plain.json('POST', '/api/grants', { space: 'home', path: '/f', to: 'sc-look-boss', perms: 'view' })
    expect(g.status).toBe(200)

    // 4 searches so far
    let last = 0
    let n = 4
    while (last !== 429 && n < 40) { last = (await look(plain, 'zzz')).status; n++ }
    expect(last).toBe(429)
    expect(n).toBe(21)
  })

  test('giving a folder to a name is limited to 30 a minute', async () => {
    const c = await userWith('sc-give')
    mkdirSync(home('sc-give', 'f'), { recursive: true })
    let r: { status: number; data: any } = { status: 0, data: null }
    let n = 0
    while (r.status !== 429 && n < 40) { r = await c.json('POST', '/api/grants', { space: 'home', path: '/f', to: `sc-nobody-${n}`, perms: 'view' }); n++ }
    expect(n).toBe(31)
    expect(r.data.code).toBe('grants.create-rate')
    // someone else is not held up
    const other = await userWith('sc-give2')
    mkdirSync(home('sc-give2', 'f'), { recursive: true })
    expect((await other.json('POST', '/api/grants', { space: 'home', path: '/f', to: 'sc-give', perms: 'view' })).status).toBe(200)
  })
})
