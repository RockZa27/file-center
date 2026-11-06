/**
 * Deleting an account together with its files (DELETE /api/admin/users/:username with { deleteFiles, password }),
 * in-process on the app of api.test.ts. Every user here starts with "udf-"; everything is removed again at the end.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import './in-process-env'

let app: any
let idx: typeof import('../src/search-index')
let trashMod: typeof import('../src/trash')
let startedIndex = false

class Client {
  cookie = ''
  csrf = ''
  async json(method: string, path: string, body?: any) {
    const h: Record<string, string> = {}
    if (this.cookie) h.cookie = this.cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    let payload: any
    if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json' }
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: payload }))
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

const PW = 'harbor-lamp-42'
const PERMS = ['read', 'write', 'upload', 'download', 'zip', 'share', 'batchdownload']
const admin = new Client()
let adminPw = ''
const storage = (...p: string[]) => join(process.env.STORAGE_DIR!, ...p)
const made = new Set<string>()
const trashMade = new Set<string>()

async function userWith(username: string, extra: Record<string, unknown> = {}, role = 'user') {
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role, permissions: PERMS, publicPermissions: [], ...extra })
  expect(r.status).toBe(200)
  made.add(username)
  return new Client().login(username, PW)
}
const hasUser = async (name: string) => (await admin.json('GET', '/api/admin/users')).data.users.some((u: any) => u.username === name)
const del = (name: string, body?: any, who = admin) => who.json('DELETE', `/api/admin/users/${name}`, body)

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  idx = await import('../src/search-index')
  trashMod = await import('../src/trash')
  adminPw = process.env.ADMIN_PASSWORD!
  await admin.login('admin', adminPw)
  if (!idx.indexReady()) { idx.startSearchIndex(); startedIndex = true; await idx.scanIndex() }
})

afterAll(async () => {
  for (const id of trashMade) { try { trashMod.purge(id) } catch { /* already gone */ } }
  for (const name of made) await del(name)
  rmSync(storage('udf-shared'), { recursive: true, force: true })
  for (const name of made) rmSync(storage('users', name), { recursive: true, force: true })
  if (startedIndex) idx.stopSearchIndex()
})

describe('delete an account with its files', () => {
  test('the home goes to the trash as one tombstoned entry; a new account of the same name starts empty', async () => {
    const c = await userWith('udf-main')
    mkdirSync(storage('users', 'udf-main', 'sub'), { recursive: true })
    writeFileSync(storage('users', 'udf-main', 'secret-udf-plan.txt'), 'one')
    writeFileSync(storage('users', 'udf-main', 'sub', 'old-udf-note.txt'), 'bbb')
    expect((await c.json('PUT', '/api/content', { space: 'home', path: '/secret-udf-plan.txt', content: 'two' })).status).toBe(200)
    expect((await c.json('GET', '/api/versions?space=home&path=%2Fsecret-udf-plan.txt')).data.items.length).toBe(1)
    idx.indexTouched(storage('users', 'udf-main'))
    await idx.indexIdle()
    expect((await c.json('GET', '/api/search?space=home&q=old-udf-note')).data.results.length).toBe(1)

    const r = await del('udf-main', { deleteFiles: true, password: adminPw })
    expect(r.status).toBe(200)
    expect(r.data).toMatchObject({ ok: true, filesMoved: true })
    trashMade.add(r.data.trashId)
    expect(existsSync(storage('users', 'udf-main'))).toBe(false)
    expect(await hasUser('udf-main')).toBe(false)
    const mine = trashMod.listTrash().filter(m => m.originalPath === '/users/udf-main')
    expect(mine.length).toBe(1)
    expect(mine[0]).toMatchObject({ id: r.data.trashId, type: 'dir', deletedBy: 'admin' })
    expect(mine[0].owner!.startsWith('~udf-main@')).toBe(true)
    const log = JSON.stringify((await admin.json('GET', '/api/admin/activity?action=user-delete&q=udf-main')).data)
    expect(log).toContain('files to trash')
    expect(log).not.toContain('secret-udf-plan')

    // the same name again: an empty home, no old file, version, trash entry or search hit
    const c2 = await userWith('udf-main')
    expect((await c2.json('GET', '/api/list?space=home&path=/')).data.entries).toEqual([])
    writeFileSync(storage('users', 'udf-main', 'secret-udf-plan.txt'), 'new')
    expect((await c2.json('GET', '/api/versions?space=home&path=%2Fsecret-udf-plan.txt')).data.items).toEqual([])
    expect((await c2.json('GET', '/api/me/trash')).data.items).toEqual([])
    await idx.indexIdle()
    expect((await c2.json('GET', '/api/search?space=home&q=old-udf-note')).data.results).toEqual([])
    expect((await admin.json('GET', '/api/admin/trash')).data.items.some((m: any) => m.id === r.data.trashId)).toBe(true)
  })

  test('the admin restores the entry: the folder is back at its path with its versions', async () => {
    const c = await userWith('udf-back')
    writeFileSync(storage('users', 'udf-back', 'a.txt'), 'one')
    await c.json('PUT', '/api/content', { space: 'home', path: '/a.txt', content: 'two' })
    const r = await del('udf-back', { deleteFiles: true, password: adminPw })
    trashMade.add(r.data.trashId)
    expect(existsSync(storage('users', 'udf-back'))).toBe(false)
    const back = await admin.json('POST', '/api/admin/trash/restore', { id: r.data.trashId })
    expect(back.status).toBe(200)
    trashMade.delete(r.data.trashId)
    expect(back.data.restoredTo).toBe('/users/udf-back')
    expect(readFileSync(storage('users', 'udf-back', 'a.txt'), 'utf8')).toBe('two')
  })

  test('a wrong password and a manager both get 403 and nothing changes', async () => {
    await userWith('udf-keep')
    writeFileSync(storage('users', 'udf-keep', 'k.txt'), 'k')
    const mgr = await userWith('udf-mgr', {}, 'manager')
    // deliberate misses first: a later right password clears the count
    expect((await del('udf-keep', { deleteFiles: true, password: 'not-the-password' })).status).toBe(403)
    expect((await del('udf-keep', { deleteFiles: true, password: PW }, mgr)).status).toBe(403)
    expect(await hasUser('udf-keep')).toBe(true)
    expect(existsSync(storage('users', 'udf-keep', 'k.txt'))).toBe(true)
    expect(trashMod.listTrash().filter(m => m.owner?.startsWith('~udf-keep@')).length).toBe(0)
    // a manager without deleteFiles works as before: the account goes, the home stays
    const plain = await del('udf-keep', undefined, mgr)
    expect(plain.status).toBe(200)
    expect(plain.data.filesMoved).toBe(false)
    expect(await hasUser('udf-keep')).toBe(false)
    expect(existsSync(storage('users', 'udf-keep', 'k.txt'))).toBe(true)
  })

  test('no body: exactly as before, the home stays', async () => {
    await userWith('udf-nobody')
    writeFileSync(storage('users', 'udf-nobody', 'n.txt'), 'n')
    expect((await del('udf-nobody')).status).toBe(200)
    expect(await hasUser('udf-nobody')).toBe(false)
    expect(existsSync(storage('users', 'udf-nobody', 'n.txt'))).toBe(true)
  })

  test('a home that is / or shared with another account is refused: nothing changes', async () => {
    await userWith('udf-adm', {}, 'admin')
    const r = await del('udf-adm', { deleteFiles: true, password: adminPw })
    expect(r.status).toBe(400)
    expect(r.data.code).toBe('admin.delete-files-home')
    expect(await hasUser('udf-adm')).toBe(true)

    await userWith('udf-s1', { homedir: '/udf-shared' })
    await userWith('udf-s2', { homedir: '/udf-shared', adoptHome: true })
    await userWith('udf-s3', { homedir: '/udf-shared/inner', adoptHome: true })
    writeFileSync(storage('udf-shared', 'x.txt'), 'x')
    for (const name of ['udf-s1', 'udf-s3']) {
      const o = await del(name, { deleteFiles: true, password: adminPw })
      expect([name, o.status, o.data.code]).toEqual([name, 400, 'admin.delete-files-home'])
      expect(await hasUser(name)).toBe(true)
    }
    expect(existsSync(storage('udf-shared', 'x.txt'))).toBe(true)
  })

  test('a home that does not exist: the account goes, the answer says no files were moved', async () => {
    await userWith('udf-ghost', { homedir: '/udf-ghost-home' })
    rmSync(storage('udf-ghost-home'), { recursive: true, force: true })
    const r = await del('udf-ghost', { deleteFiles: true, password: adminPw })
    expect(r.status).toBe(200)
    expect(r.data.filesMoved).toBe(false)
    expect(await hasUser('udf-ghost')).toBe(false)
  })

  test('an admin\'s grant to a folder inside the deleted home is gone, so it can not reach the next account of that name', async () => {
    await userWith('udf-gr')
    await userWith('udf-rcv')
    mkdirSync(storage('users', 'udf-gr', 'shared'), { recursive: true })
    const g = await admin.json('POST', '/api/grants', { space: 'home', path: '/users/udf-gr/shared', to: 'udf-rcv', perms: 'view' })
    expect(g.status).toBe(200)
    expect((await admin.json('GET', '/api/grants/mine')).data.items.some((x: any) => x.path === '/users/udf-gr/shared')).toBe(true)
    const r = await del('udf-gr', { deleteFiles: true, password: adminPw })
    expect(r.status).toBe(200)
    trashMade.add(r.data.trashId)
    expect((await admin.json('GET', '/api/grants/mine')).data.items.some((x: any) => x.path === '/users/udf-gr/shared')).toBe(false)
  })
})

describe('delete an account with its files: races and links', () => {
  test('two deletions of the same account at once: one goes through, the other is refused, no other account is touched', async () => {
    await userWith('udf-race')
    writeFileSync(storage('users', 'udf-race', 'r.txt'), 'r')
    const others = (await admin.json('GET', '/api/admin/users')).data.users.map((u: any) => u.username).filter((n: string) => n !== 'udf-race').sort()
    const [a, b] = await Promise.all([del('udf-race', { deleteFiles: true, password: adminPw }), del('udf-race', { deleteFiles: true, password: adminPw })])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const ok = a.status === 200 ? a : b
    if (ok.data.trashId) trashMade.add(ok.data.trashId)
    made.delete('udf-race')
    const left = (await admin.json('GET', '/api/admin/users')).data.users.map((u: any) => u.username).sort()
    expect(left).toEqual(others)
    expect(existsSync(storage('users', 'udf-race'))).toBe(false)
  })

  test('a home whose path goes through a link is refused and nothing moves', async () => {
    await userWith('udf-real')
    writeFileSync(storage('users', 'udf-real', 'keep.txt'), 'keep')
    // /udf-link -> /users, so /udf-link/udf-real names the other account's real folder without overlapping it as text
    rmSync(storage('udf-link'), { force: true })
    symlinkSync(storage('users'), storage('udf-link'))
    try {
      await userWith('udf-via', { homedir: '/udf-link/udf-real' })
      const r = await del('udf-via', { deleteFiles: true, password: adminPw })
      expect([r.status, r.data.code]).toEqual([400, 'admin.delete-files-home'])
      expect(readFileSync(storage('users', 'udf-real', 'keep.txt'), 'utf8')).toBe('keep')
      expect(await hasUser('udf-via')).toBe(true)
    } finally {
      await del('udf-via')
      made.delete('udf-via')
      rmSync(storage('udf-link'), { force: true })
    }
  })
})
