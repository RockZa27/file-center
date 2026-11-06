/**
 * Folders under /users that no account owns (GET /api/admin/orphan-homes, POST /api/admin/orphan-homes/trash),
 * in-process on the app of api.test.ts. Every user and folder here starts with "oh-"; everything is removed again at the end.
 * Other test files leave folders under /users too, so the list is only checked for our own names.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import './in-process-env'

let app: any
let trashMod: typeof import('../src/trash')

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
const FOLDERS = ['oh-gone', 'oh-live', 'oh-custom', 'oh-shared', 'oh-link', 'oh-.hidden', 'oh-file', 'oh-mgr']

async function userWith(username: string, extra: Record<string, unknown> = {}, role = 'user') {
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role, permissions: PERMS, publicPermissions: [], ...extra })
  expect(r.status).toBe(200)
  made.add(username)
  return new Client().login(username, PW)
}
const del = (name: string) => admin.json('DELETE', `/api/admin/users/${name}`)
const orphans = async () => (await admin.json('GET', '/api/admin/orphan-homes')).data.folders as { name: string; path: string; mtime: string; entries: number }[]
const trash = (name: string, password = adminPw, who = admin) => who.json('POST', '/api/admin/orphan-homes/trash', { name, password })
const mine = () => trashMod.listTrash().filter(m => m.originalPath.startsWith('/users/oh-'))

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  trashMod = await import('../src/trash')
  adminPw = process.env.ADMIN_PASSWORD!
  await admin.login('admin', adminPw)
})

afterAll(async () => {
  for (const m of mine()) { try { trashMod.purge(m.id) } catch { /* already gone */ } }
  for (const id of trashMade) { try { trashMod.purge(id) } catch { /* already gone */ } }
  for (const name of made) await del(name)
  for (const name of FOLDERS) rmSync(storage('users', name), { recursive: true, force: true })
  rmSync(storage('oh-elsewhere'), { recursive: true, force: true })
})

describe('folders with no account', () => {
  test('listed after a delete without files; live homes (default or custom under /users) are not', async () => {
    await userWith('oh-gone')
    mkdirSync(storage('users', 'oh-gone', 'sub'), { recursive: true })
    writeFileSync(storage('users', 'oh-gone', 'a.txt'), 'a')
    writeFileSync(storage('users', 'oh-gone', 'sub', 'b.txt'), 'b')
    await userWith('oh-live')
    await userWith('oh-custom', { homedir: '/users/oh-shared', adoptHome: true })
    expect((await del('oh-gone')).status).toBe(200)
    made.delete('oh-gone')
    // hidden names count; links and plain files are skipped
    mkdirSync(storage('users', 'oh-.hidden'), { recursive: true })
    mkdirSync(storage('oh-elsewhere'), { recursive: true })
    symlinkSync(storage('oh-elsewhere'), storage('users', 'oh-link'))
    writeFileSync(storage('users', 'oh-file'), 'x')
    const list = await orphans()
    const names = list.map(f => f.name)
    expect(names).toContain('oh-gone')
    expect(names).toContain('oh-.hidden')
    for (const no of ['oh-live', 'oh-custom', 'oh-shared', 'oh-link', 'oh-file']) expect(names).not.toContain(no)
    const gone = list.find(f => f.name === 'oh-gone')!
    expect(gone).toMatchObject({ path: '/users/oh-gone', entries: 2 })
    expect(Number.isNaN(Date.parse(gone.mtime))).toBe(false)
  })

  test('a manager gets 403 for both routes', async () => {
    const m = await userWith('oh-mgr', {}, 'manager')
    expect((await m.json('GET', '/api/admin/orphan-homes')).status).toBe(403)
    expect((await trash('oh-gone', PW, m)).status).toBe(403)
    expect(existsSync(storage('users', 'oh-gone', 'a.txt'))).toBe(true)
  })

  test('a wrong password moves nothing', async () => {
    expect((await trash('oh-gone', 'not-the-password')).status).toBe(403)
    expect(existsSync(storage('users', 'oh-gone', 'a.txt'))).toBe(true)
    expect(mine().length).toBe(0)
  })

  test('bad names and links are refused', async () => {
    for (const name of ['..', '.', 'a/b', 'a\\b', '', ' oh-gone', 'oh-gone ', 'oh-\u0000x']) {
      const r = await trash(name)
      expect([name, r.status]).toEqual([name, 400])
    }
    expect((await trash('oh-link')).status).toBe(400)
    expect((await trash('oh-file')).status).toBe(400)
    expect((await trash('oh-nothing-here')).status).toBe(404)
    expect(existsSync(storage('oh-elsewhere'))).toBe(true)
    expect(existsSync(storage('users', 'oh-gone', 'a.txt'))).toBe(true)
    expect(mine().length).toBe(0)
  })

  test('a folder that became a live account\'s home meanwhile answers 409', async () => {
    await userWith('oh-gone', { adoptHome: true })
    const r = await trash('oh-gone')
    expect([r.status, r.data.code]).toEqual([409, 'admin.orphan-home-owned'])
    expect(existsSync(storage('users', 'oh-gone', 'a.txt'))).toBe(true)
    expect(mine().length).toBe(0)
    expect((await del('oh-gone')).status).toBe(200)
    made.delete('oh-gone')
  })

  test('the trash move: one admin-only entry, audit line, gone from the list, restorable', async () => {
    const r = await trash('oh-gone')
    expect(r.status).toBe(200)
    expect(r.data.ok).toBe(true)
    trashMade.add(r.data.trashId)
    expect(existsSync(storage('users', 'oh-gone'))).toBe(false)
    const entries = mine().filter(m => m.originalPath === '/users/oh-gone')
    expect(entries.length).toBe(1)
    expect(entries[0]).toMatchObject({ id: r.data.trashId, type: 'dir', deletedBy: 'admin', owner: null })
    expect(trashMod.homeOwnerOf(storage('users', 'oh-gone'))).toBeNull()
    expect((await admin.json('GET', '/api/admin/trash')).data.items.some((m: any) => m.id === r.data.trashId)).toBe(true)
    // no account's own trash shows it
    const u = await new Client().login('oh-live', PW)
    expect(JSON.stringify((await u.json('GET', '/api/me/trash')).data)).not.toContain('oh-gone')
    const log = JSON.stringify((await admin.json('GET', '/api/admin/activity?action=orphan-home-trashed&q=oh-gone')).data)
    expect(log).toContain('/users/oh-gone')
    expect(log).toContain(r.data.trashId)
    expect(log).not.toContain('a.txt')
    expect((await orphans()).map(f => f.name)).not.toContain('oh-gone')
    const back = await admin.json('POST', '/api/admin/trash/restore', { id: r.data.trashId })
    expect(back.status).toBe(200)
    trashMade.delete(r.data.trashId)
    expect(back.data.restoredTo).toBe('/users/oh-gone')
    expect(readFileSync(storage('users', 'oh-gone', 'sub', 'b.txt'), 'utf8')).toBe('b')
    expect((await orphans()).map(f => f.name)).toContain('oh-gone')
  })
})
