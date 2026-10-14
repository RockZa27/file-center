import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// sets STORAGE_DIR, DATA_DIR, ADMIN_PASSWORD (test-admin-pass) before src/index is loaded
import './in-process-env'

// Fixes after the review of the manager role: folder takeover by name, password reset without step-up,
// the users list and dashboard leaking, browsing not audited. Names start with rf- to stay clear of the other files.
let app: any
class Client {
  cookie = ''
  csrf = ''
  async json(method: string, path: string, body?: any) {
    const h: Record<string, string> = {}
    if (this.cookie) h.cookie = this.cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    let payload: any = body
    if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json' }
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: payload }))
    const set = res.headers.get('set-cookie')
    if (set) this.cookie = set.split(';')[0]
    return { status: res.status, data: await res.json().catch(() => null) }
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
let mgr: Client
const mk = (username: string, role: string, extra: Record<string, unknown> = {}) =>
  ({ username, name: username, password: PW, role, permissions: ['read', 'write', 'upload', 'download', 'batchdownload', 'zip'], publicPermissions: [], ...extra })
const row = async (c: Client, name: string) => (await c.json('GET', '/api/admin/users')).data.users.find((u: any) => u.username === name)
const audits = async (q: string) => (await admin.json('GET', `/api/admin/activity?pageSize=100&${q}`)).data.items as any[]

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  await admin.as('admin', 'test-admin-pass')
  expect((await admin.json('POST', '/api/admin/users', mk('rfm', 'manager'))).status).toBe(200)
  mgr = await new Client().as('rfm')
})

describe('roles fixes: a manager can not take over a folder that exists', () => {
  test('a folder an admin made the home of another account', async () => {
    mkdirSync(join(storage(), 'team-share'), { recursive: true })
    writeFileSync(join(storage(), 'team-share', 'plan.txt'), 'private')
    mkdirSync(join(storage(), 'users', 'rf-team'), { recursive: true })
    expect((await admin.json('POST', '/api/admin/users', mk('rf-carol', 'user', { homedir: '/users/rf-team' }))).status).toBe(200)
    const r = await mgr.json('POST', '/api/admin/users', mk('rf-team', 'user'))
    expect([r.status, r.data.code]).toEqual([409, 'admin.home-exists'])
    expect(await row(admin, 'rf-team')).toBeUndefined()
  })
  test('an empty or full folder that is just there', async () => {
    mkdirSync(join(storage(), 'users', 'rf-empty'), { recursive: true })
    expect((await mgr.json('POST', '/api/admin/users', mk('rf-empty', 'user'))).data.code).toBe('admin.home-exists')
    mkdirSync(join(storage(), 'users', 'rf-full'), { recursive: true })
    writeFileSync(join(storage(), 'users', 'rf-full', 'a.txt'), 'x')
    expect((await mgr.json('POST', '/api/admin/users', mk('rf-full', 'user'))).status).toBe(409)
  })
  test('the leftover home of a deleted user', async () => {
    expect((await mgr.json('POST', '/api/admin/users', mk('rf-gone', 'user'))).status).toBe(200)
    expect((await mgr.json('DELETE', '/api/admin/users/rf-gone')).status).toBe(200)
    expect(existsSync(join(storage(), 'users', 'rf-gone'))).toBe(true)
    expect((await mgr.json('POST', '/api/admin/users', mk('rf-gone', 'user'))).status).toBe(409)
  })
  test('a name that differs only in letter case', async () => {
    expect((await mgr.json('POST', '/api/admin/users', mk('RF-Carol', 'user'))).status).toBe(409)
    mkdirSync(join(storage(), 'users', 'RF-Disk'), { recursive: true })
    const r = await mgr.json('POST', '/api/admin/users', mk('rf-disk', 'user'))
    expect([r.status, r.data.code]).toEqual([409, 'admin.home-exists'])
  })
  test('a folder that is not there but lies in or above the home of another account', async () => {
    expect((await admin.json('POST', '/api/admin/users', mk('rf-deep', 'user', { homedir: '/users/rf-above/deep' }))).status).toBe(200)
    rmSync(join(storage(), 'users', 'rf-above'), { recursive: true, force: true })
    expect((await mgr.json('POST', '/api/admin/users', mk('rf-above', 'user'))).data.code).toBe('admin.home-exists')
    expect((await admin.json('POST', '/api/admin/users', mk('rf-inside', 'user', { homedir: '/users/rf-below' }))).status).toBe(200)
    rmSync(join(storage(), 'users', 'rf-below'), { recursive: true, force: true })
    expect((await mgr.json('POST', '/api/admin/users', mk('rf-below', 'user'))).status).toBe(409)
  })
  test('an admin keeps choosing deliberately, and a fresh name works for a manager', async () => {
    expect((await admin.json('POST', '/api/admin/users', mk('rf-adm', 'user', { homedir: '/users/rf-team' }))).status).toBe(200)
    expect((await mgr.json('POST', '/api/admin/users', mk('rf-fresh', 'user'))).status).toBe(200)
    expect((await row(admin, 'rf-fresh')).homedir).toBe('/users/rf-fresh')
  })
})

describe('roles fixes: canManage needs a folder of the target\'s alone', () => {
  test('two accounts with one home: neither is manageable', async () => {
    expect((await mgr.json('POST', '/api/admin/users', mk('rf-s1', 'user'))).status).toBe(200)
    expect((await row(mgr, 'rf-s1')).manageable).toBe(true)
    expect((await admin.json('POST', '/api/admin/users', mk('rf-s2', 'user', { homedir: '/users/rf-s1' }))).status).toBe(200)
    expect((await row(mgr, 'rf-s1')).manageable).toBe(false)
    expect((await mgr.json('PUT', '/api/admin/users/rf-s1', { name: 'x' })).status).toBe(403)
    expect((await mgr.json('GET', '/api/list?space=user:rf-s1&path=/')).status).toBe(403)
    expect((await row(admin, 'rf-s1')).manageable).toBe(true)
  })
  test('one home inside another: the outer one is not manageable', async () => {
    expect((await mgr.json('POST', '/api/admin/users', mk('rf-o1', 'user'))).status).toBe(200)
    expect((await admin.json('POST', '/api/admin/users', mk('rf-o2', 'user', { homedir: '/users/rf-o1/inner' }))).status).toBe(200)
    expect((await row(mgr, 'rf-o1')).manageable).toBe(false)
    // and the inner one is not the manager's anyway
    expect((await row(mgr, 'rf-o2')).manageable).toBe(false)
  })
})

describe('roles fixes: a manager sets a password only with their own', () => {
  test('without it or with a wrong one: 403 and nothing changes', async () => {
    expect((await mgr.json('POST', '/api/admin/users', mk('rf-pw', 'user'))).status).toBe(200)
    expect((await mgr.json('PUT', '/api/admin/users/rf-pw', { password: 'brand-new-pass-91' })).status).toBe(403)
    expect((await mgr.json('PUT', '/api/admin/users/rf-pw', { password: 'brand-new-pass-91', confirmPassword: 'not-it' })).status).toBe(403)
    await new Client().as('rf-pw') // the old password still works
  })
  test('with it: changed, must change at next sign-in, audited as user-password-reset', async () => {
    const r = await mgr.json('PUT', '/api/admin/users/rf-pw', { password: 'brand-new-pass-91', confirmPassword: PW })
    expect(r.status).toBe(200)
    expect((await row(admin, 'rf-pw')).mustChangePassword).toBe(true)
    await new Client().as('rf-pw', 'brand-new-pass-91')
    const e = (await audits('action=user-password-reset')).find(x => x.target === 'rf-pw')
    expect(e?.user).toBe('rfm')
  })
  test('other edits of a manager need no password; an admin resets as before', async () => {
    expect((await mgr.json('PUT', '/api/admin/users/rf-pw', { name: 'Renamed' })).status).toBe(200)
    expect((await admin.json('PUT', '/api/admin/users/rf-pw', { password: 'admin-set-pass-77' })).status).toBe(200)
    const u = await row(admin, 'rf-pw')
    expect(u.mustChangePassword).toBe(false)
    expect((await audits('action=user-update')).some(x => x.target === 'rf-pw' && x.user === 'admin')).toBe(true)
  })
})

describe('roles fixes: what a manager sees', () => {
  test('rows they can not manage carry name and role only', async () => {
    const list = (await mgr.json('GET', '/api/admin/users')).data.users
    const adm = list.find((u: any) => u.username === 'admin')
    expect(adm).toEqual({ username: 'admin', name: adm.name, role: 'admin', manageable: false })
    const s2 = list.find((u: any) => u.username === 'rf-s2')
    expect(Object.keys(s2).sort()).toEqual(['manageable', 'name', 'role', 'username'])
    const mine = list.find((u: any) => u.username === 'rf-fresh')
    expect(mine.homedir).toBe('/users/rf-fresh')
    // an admin still sees everything
    expect((await row(admin, 'rf-s2')).homedir).toBe('/users/rf-s1')
  })
  test('the dashboard counts the managed users and the space of their homes only', async () => {
    writeFileSync(join(storage(), 'users', 'rf-fresh', 'a.bin'), Buffer.alloc(100))
    writeFileSync(join(storage(), 'users', 'rf-pw', 'b.bin'), Buffer.alloc(50))
    writeFileSync(join(storage(), 'team-share', 'big.bin'), Buffer.alloc(5000))
    const managed = (await mgr.json('GET', '/api/admin/users')).data.users.filter((u: any) => u.manageable).length
    let last: any
    for (let i = 0; i < 40; i++) {
      last = (await mgr.json('GET', '/api/admin/status')).data
      if (!last.stale && last.storage.size >= 150) break
      await Bun.sleep(100)
    }
    expect(last.users).toBe(managed)
    // other test files leave small files in their users' homes: at least ours, never the 5000 bytes outside the managed homes
    expect(Object.keys(last.storage)).toEqual(['size'])
    expect(last.storage.size).toBeGreaterThanOrEqual(150)
    expect(last.storage.size).toBeLessThan(5000)
    expect(last.manageableUsers).toBeUndefined()
  })
})

describe('roles fixes: browsing a managed user\'s folders is audited', () => {
  test('once a minute per folder, in the user space only', async () => {
    mkdirSync(join(storage(), 'users', 'rf-fresh', 'docs'), { recursive: true })
    const before = (await audits('action=browse&user=rfm')).length
    for (let i = 0; i < 3; i++) expect((await mgr.json('GET', '/api/list?space=user:rf-fresh&path=/')).status).toBe(200)
    expect((await mgr.json('GET', '/api/search?space=user:rf-fresh&q=a.bin&path=/')).status).toBe(200)
    expect((await mgr.json('GET', '/api/list?space=user:rf-fresh&path=/docs')).status).toBe(200)
    // their own space and the public one write nothing
    expect((await mgr.json('GET', '/api/list?space=home&path=/')).status).toBe(200)
    const lines = await audits('action=browse&user=rfm')
    expect(lines.length - before).toBe(2)
    expect(lines[0]).toMatchObject({ user: 'rfm', action: 'browse', target: '/users/rf-fresh/docs', detail: 'user:rf-fresh' })
    expect(lines.some(l => l.target === '/users/rf-fresh')).toBe(true)
  })
})
