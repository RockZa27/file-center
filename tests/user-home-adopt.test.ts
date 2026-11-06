/**
 * An admin who gives an account a folder that holds files, or another account's folder, must say so (adoptHome).
 * In-process on the app of api.test.ts. Every user here starts with "uha-"; everything is removed again at the end.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import './in-process-env'

let app: any
let auditMod: typeof import('../src/audit')

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
const storage = (...p: string[]) => join(process.env.STORAGE_DIR!, ...p)
const made = new Set<string>()
const extraDirs = ['uha-shared', 'uha-empty', 'uha-zzhome', 'uha-upd']

const mk = async (c: Client, username: string, extra: Record<string, unknown> = {}) => {
  const r = await c.json('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', permissions: PERMS, publicPermissions: [], ...extra })
  if (r.status === 200) made.add(username)
  return r
}
const users = async () => (await admin.json('GET', '/api/admin/users')).data.users as any[]
const has = async (name: string) => (await users()).some(u => u.username === name)
const del = (name: string) => admin.json('DELETE', `/api/admin/users/${name}`)
const lastAudit = (action: string, target: string) =>
  auditMod.queryAudit({ page: 1, pageSize: 50, action }).items.find((r: any) => r.target === target)

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  auditMod = await import('../src/audit')
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
})

afterAll(async () => {
  for (const name of made) await del(name)
  for (const name of made) rmSync(storage('users', name), { recursive: true, force: true })
  for (const d of extraDirs) rmSync(storage(d), { recursive: true, force: true })
})

describe('admin takes over a folder', () => {
  test('a deleted account\'s leftovers do not pass to the next account of that name', async () => {
    expect((await mk(admin, 'uha-a')).status).toBe(200)
    mkdirSync(storage('users', 'uha-a', 'secret-project'), { recursive: true })
    expect((await del('uha-a')).status).toBe(200)
    made.delete('uha-a')
    expect(existsSync(storage('users', 'uha-a', 'secret-project'))).toBe(true)

    const refused = await mk(admin, 'uha-a')
    expect(refused.status).toBe(409)
    expect(refused.data.code).toBe('admin.home-has-files')
    expect(refused.data.params).toEqual({ home: '/users/uha-a', files: 1 })
    expect(await has('uha-a')).toBe(false)

    const ok = await mk(admin, 'uha-a', { adoptHome: true })
    expect(ok.status).toBe(200)
    const a = await new Client().login('uha-a', PW)
    const list = await a.json('GET', '/api/list?space=home&path=/')
    expect(list.data.entries.map((i: any) => i.name)).toContain('secret-project')
    const line = lastAudit('user-create', 'uha-a')
    expect(line?.detail).toContain('taken over')
    expect(line?.detail).not.toContain('secret-project')
  })

  test('a hidden entry counts as a file', async () => {
    mkdirSync(storage('uha-shared'), { recursive: true })
    writeFileSync(storage('uha-shared', '.hidden'), 'x')
    const r = await mk(admin, 'uha-h', { homedir: '/uha-shared' })
    expect(r.status).toBe(409)
    expect(r.data.code).toBe('admin.home-has-files')
    expect((await mk(admin, 'uha-h', { homedir: '/uha-shared', adoptHome: true })).status).toBe(200)
  })

  test('another account\'s home, or inside it, needs the flag; the answer never names the account', async () => {
    expect((await mk(admin, 'uha-c')).status).toBe(200)
    const same = await mk(admin, 'uha-b', { homedir: '/users/uha-c' })
    expect(same.status).toBe(409)
    expect(same.data.code).toBe('admin.home-of-other')
    expect(same.data.params).toEqual({ home: '/users/uha-c' })
    expect(await has('uha-b')).toBe(false)
    expect((await mk(admin, 'uha-b', { homedir: '/users/uha-c', adoptHome: true })).status).toBe(200)
    expect(lastAudit('user-create', 'uha-b')?.detail).toContain('shared')

    // the home's name is no secret (it is in the message); the account's name must not be
    expect((await mk(admin, 'uha-own', { homedir: '/uha-zzhome' })).status).toBe(200)
    const named = await mk(admin, 'uha-n', { homedir: '/uha-zzhome' })
    expect(named.data.code).toBe('admin.home-of-other')
    expect(JSON.stringify(named.data)).not.toContain('uha-own')

    const inside = await mk(admin, 'uha-i', { homedir: '/users/uha-c/sub' })
    expect(inside.status).toBe(409)
    expect(inside.data.code).toBe('admin.home-of-other')
    expect((await mk(admin, 'uha-i', { homedir: '/users/uha-c/sub', adoptHome: true })).status).toBe(200)

    const above = await mk(admin, 'uha-up', { homedir: '/users' })
    expect(above.status).toBe(409)
    expect(above.data.code).toBe('admin.home-of-other')
  })

  test('a new or empty folder needs no flag', async () => {
    expect((await mk(admin, 'uha-fresh')).status).toBe(200)
    expect(lastAudit('user-create', 'uha-fresh')?.detail).toBeUndefined()
    mkdirSync(storage('uha-empty'), { recursive: true })
    expect((await mk(admin, 'uha-e', { homedir: '/uha-empty' })).status).toBe(200)
  })

  test('an admin account (home "/") is not affected', async () => {
    expect((await mk(admin, 'uha-adm', { role: 'admin' })).status).toBe(200)
  })
})

describe('changing the home of an account', () => {
  test('a folder with files or another account\'s needs the flag; the own home does not', async () => {
    expect((await mk(admin, 'uha-d')).status).toBe(200)
    mkdirSync(storage('uha-upd', 'x'), { recursive: true })
    const put = (body: any) => admin.json('PUT', '/api/admin/users/uha-d', body)
    const home = async () => (await users()).find(u => u.username === 'uha-d').homedir

    const r = await put({ homedir: '/uha-upd' })
    expect(r.status).toBe(409)
    expect(r.data.code).toBe('admin.home-has-files')
    expect(await home()).toBe('/users/uha-d')

    const o = await put({ homedir: '/users/uha-c' })
    expect(o.status).toBe(409)
    expect(o.data.code).toBe('admin.home-of-other')
    expect(await home()).toBe('/users/uha-d')

    // its own home, even when it holds files: no flag
    writeFileSync(storage('users', 'uha-d', 'mine.txt'), 'x')
    expect((await put({ homedir: '/users/uha-d', name: 'D' })).status).toBe(200)
    expect((await put({ name: 'D2' })).status).toBe(200)

    expect((await put({ homedir: '/uha-upd', adoptHome: true })).status).toBe(200)
    expect(await home()).toBe('/uha-upd')
    expect(lastAudit('user-update', 'uha-d')?.detail).toContain('taken over')
  })
})

describe('a manager', () => {
  test('keeps the old rule, and adoptHome does not bypass it', async () => {
    expect((await mk(admin, 'uha-mgr', { role: 'manager' })).status).toBe(200)
    const m = await new Client().login('uha-mgr', PW)
    mkdirSync(storage('users', 'uha-m1'), { recursive: true })
    writeFileSync(storage('users', 'uha-m1', 'old.txt'), 'x')
    made.add('uha-m1')
    for (const extra of [{}, { adoptHome: true }]) {
      const r = await mk(m, 'uha-m1', extra)
      expect(r.status).toBe(409)
      expect(r.data.code).toBe('admin.home-exists')
      expect(await has('uha-m1')).toBe(false)
    }
    // a free name still works without the flag
    expect((await mk(m, 'uha-m2')).status).toBe(200)
    expect(readdirSync(storage('users')).includes('uha-m2')).toBe(true)
  })
})
