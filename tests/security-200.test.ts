/**
 * The fixes for the three medium findings of the 2.0.0-beta.1 security audit (qa/reports/sec-2.0.0-beta.1). Runs
 * in-process on the same app as api.test.ts; every user here starts with "s200-".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { BlobReader, BlobWriter, TextReader, ZipReader, ZipWriter } from '@zip.js/zip.js'
import { base } from './in-process-env'

let app: any
let config: typeof import('../src/config').config
let settings: typeof import('../src/settings').settings
let files: typeof import('../src/routes/files')
let zip: typeof import('../src/zip')

class Client {
  jar = new Map<string, string>()
  csrf = ''
  async raw(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers }
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    if (cookie) h.cookie = cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    let payload: any = body
    if (body !== undefined && !(body instanceof Uint8Array) && typeof body !== 'string') {
      payload = JSON.stringify(body)
      h['content-type'] = 'application/json'
    }
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: payload }))
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';')
      const at = pair.indexOf('=')
      this.jar.set(pair.slice(0, at), pair.slice(at + 1))
    }
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
const ADMIN_PW = 'test-admin-pass'
const admin = new Client()
const boss = new Client()
const mk = (c: Client, username: string, extra: Record<string, unknown> = {}) =>
  c.json('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', permissions: ['read', 'download', 'batchdownload', 'write', 'upload'], publicPermissions: [], ...extra })

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config } = await import('../src/config'))
  ;({ settings } = await import('../src/settings'))
  files = await import('../src/routes/files')
  zip = await import('../src/zip')
  await admin.login('admin', ADMIN_PW)
  // the refusals below are made as this second admin: a wrong password counts toward the step-up lockout of the
  // account that typed it, and the shared "admin" of the other test files must not be locked by this file
  expect((await mk(admin, 's200-boss', { role: 'admin', confirmPassword: ADMIN_PW })).status).toBe(200)
  await boss.login('s200-boss', PW)
})

describe('an admin account is made or re-keyed only with the acting admin\'s password', () => {
  test('creating an admin: refused without the password, done with it', async () => {
    const no = await mk(boss, 's200-adm', { role: 'admin' })
    expect(no.status).toBe(403)
    expect(no.data.code).toBe('auth.wrong-password')
    expect((await admin.json('GET', '/api/admin/users')).data.users.some((u: any) => u.username === 's200-adm')).toBe(false)
    expect((await mk(boss, 's200-adm', { role: 'admin', confirmPassword: 'not-the-password-1' })).status).toBe(403)
    // the right password clears the counter again
    expect((await mk(boss, 's200-adm', { role: 'admin', confirmPassword: PW })).status).toBe(200)
  })

  test('the stolen-session chain of the audit no longer works', async () => {
    // a session alone (cookie and CSRF token, no password): no new admin, no promotion, no new password for an admin
    expect((await mk(boss, 's200-evil', { role: 'admin' })).status).toBe(403)
    expect((await boss.json('PUT', '/api/admin/users/s200-boss', { name: 'still me' })).status).toBe(200) // clears nothing, asks nothing
    expect((await mk(boss, 's200-plain')).status).toBe(200)
    expect((await boss.json('PUT', '/api/admin/users/s200-plain', { role: 'admin' })).status).toBe(403)
    expect((await boss.json('PUT', '/api/admin/users/s200-plain', { role: 'admin', confirmPassword: PW })).status).toBe(200)
    const set = await boss.json('PUT', '/api/admin/users/s200-adm', { password: 'chosen-by-thief-55' })
    expect(set.status).toBe(403)
    // the password of s200-adm is unchanged
    await new Client().login('s200-adm', PW)
    expect((await boss.json('PUT', '/api/admin/users/s200-adm', { password: 'chosen-by-boss-55', confirmPassword: PW })).status).toBe(200)
    await new Client().login('s200-adm', 'chosen-by-boss-55')
  })

  test('an admin\'s own password through the admin route needs the current one too', async () => {
    expect((await boss.json('PUT', '/api/admin/users/s200-boss', { password: 'thief-sets-this-91' })).status).toBe(403)
    expect((await boss.json('PUT', '/api/admin/users/s200-boss', { name: 'boss', confirmPassword: PW })).status).toBe(200)
  })

  test('what stays as it was: plain users and managers are made and reset by an admin without it', async () => {
    expect((await mk(boss, 's200-u')).status).toBe(200)
    expect((await mk(boss, 's200-m', { role: 'manager' })).status).toBe(200)
    expect((await boss.json('PUT', '/api/admin/users/s200-u', { password: 'admin-set-pass-77' })).status).toBe(200)
    expect((await boss.json('PUT', '/api/admin/users/s200-m', { password: 'admin-set-pass-78' })).status).toBe(200)
    // an admin who stops being one needs no password either
    expect((await boss.json('PUT', '/api/admin/users/s200-plain', { role: 'user' })).status).toBe(200)
  })

  test('a new admin is in the audit trail with its role', async () => {
    const rows = (await admin.json('GET', '/api/admin/activity?action=user-create&pageSize=100')).data.items
    expect(rows.find((r: any) => r.target === 's200-adm')?.detail).toBe('role admin')
    const denied = (await admin.json('GET', '/api/admin/activity?action=user-admin-denied&pageSize=100')).data.items
    expect(denied.some((r: any) => r.user === 's200-boss')).toBe(true)
  })
})

describe('the zip directory limits hold whichever end record the reader takes', () => {
  const dir = join(base, 's200-zip')
  async function zipOf(n: number, comment = ''): Promise<Uint8Array> {
    const w = new ZipWriter(new BlobWriter('application/zip'))
    for (let i = 0; i < n; i++) await w.add(`f${i}.txt`, new TextReader('x'))
    return new Uint8Array(await (await w.close(comment ? new TextEncoder().encode(comment) : undefined)).arrayBuffer())
  }
  /** the real end record gets a 22-byte comment that is itself an end record claiming an empty archive */
  function withFakeEnd(bytes: Uint8Array): Uint8Array {
    const out = new Uint8Array(bytes.length + 22)
    out.set(bytes)
    new DataView(out.buffer).setUint16(bytes.length - 2, 22, true) // comment length of the real record (it had none)
    new DataView(out.buffer).setUint32(bytes.length, 0x06054b50, true) // the rest of the fake record stays zero
    return out
  }
  const put = (name: string, bytes: Uint8Array) => { mkdirSync(dir, { recursive: true }); const p = join(dir, name); writeFileSync(p, bytes); return p }
  const check = (p: string, maxEntries: number) => zip.checkDirectory(p, { maxEntries }).then(() => 'passed', (e: any) => e.code as string)

  test('a second end record in the comment does not hide the entries', async () => {
    const plain = await zipOf(12)
    const crafted = withFakeEnd(plain)
    expect(await check(put('plain.zip', plain), 5)).toBe('archive.directory-too-big')
    // the crafted file is a zip the reader opens in full: that is what the limit must see
    const seen = await new ZipReader(new BlobReader(new Blob([crafted]))).getEntries()
    expect(seen.length).toBe(12)
    expect(await check(put('crafted.zip', crafted), 5)).toBe('archive.directory-too-big')
    // and under the limit both still pass
    expect(await check(join(dir, 'plain.zip'), 50)).toBe('passed')
    expect(await check(join(dir, 'crafted.zip'), 50)).toBe('passed')
  })

  test('an ordinary comment, and bytes in it that only look like an end record, change nothing', async () => {
    expect(await check(put('note.zip', await zipOf(3, 'made on a Tuesday')), 5)).toBe('passed')
    // "PK\x05\x06" inside a short comment: the record it would start runs past the end of the file, so it is none
    expect(await check(put('looks.zip', await zipOf(3, 'PK\x05\x06 is how a zip ends')), 5)).toBe('passed')
    expect(await check(put('looks-big.zip', await zipOf(9, 'PK\x05\x06 is how a zip ends')), 5)).toBe('archive.directory-too-big')
  })
})

describe('batch download tokens are capped per caller and in total', () => {
  // read every download to the end, as a browser does: a zip stream nobody reads keeps one of zip.js's few codec slots,
  // and a later zip (a backup in another test file) would wait for it forever
  const fetched = async (c: Client, token: string) => {
    const res = await c.raw('GET', `/api/batch/${token}`)
    await res.arrayBuffer()
    return res.status
  }
  let prev: { publicEnabled: boolean; guestPermissions: string[] }
  beforeAll(() => {
    const s = settings.get()
    prev = { publicEnabled: s.publicEnabled, guestPermissions: [...s.guestPermissions] }
    settings.update({ publicEnabled: true, guestPermissions: ['read', 'download', 'batchdownload'] })
    const pub = join(process.env.STORAGE_DIR!, config.publicDirName, 's200')
    mkdirSync(pub, { recursive: true })
    writeFileSync(join(pub, 'a.txt'), 'a')
    writeFileSync(join(process.env.STORAGE_DIR!, 'users', 's200-u', 'mine.txt'), 'm')
  })
  afterAll(() => { settings.update(prev as any) })

  test('a visitor who keeps asking holds no more than the cap, and the newest token works', async () => {
    const visitor = new Client()
    visitor.csrf = (await visitor.json('GET', '/api/session')).data.csrf
    const user = await new Client().login('s200-u', 'admin-set-pass-77')
    const mine = (await user.json('POST', '/api/batch', { space: 'home', path: '/', items: ['mine.txt'] })).data.token
    const before = files.batchCount()
    const tokens: string[] = []
    for (let i = 0; i < files.BATCH_PER_CALLER + 10; i++) {
      const r = await visitor.json('POST', '/api/batch', { space: 'public', path: '/s200', items: ['a.txt'] })
      expect(r.status).toBe(200)
      tokens.push(r.data.token)
    }
    expect(files.batchCount()).toBe(before + files.BATCH_PER_CALLER)
    const first = await visitor.json('GET', `/api/batch/${tokens[0]}`)
    expect(first.status).toBe(404)
    expect(first.data.code).toBe('files.link-expired')
    expect(await fetched(visitor, tokens.at(-1)!)).toBe(200)
    // someone else's token is not what went
    expect(await fetched(user, mine)).toBe(200)
  })

  test('a signed-in user is capped the same way', async () => {
    const user = await new Client().login('s200-u', 'admin-set-pass-77')
    const tokens: string[] = []
    for (let i = 0; i < files.BATCH_PER_CALLER + 3; i++) tokens.push((await user.json('POST', '/api/batch', { space: 'home', path: '/', items: ['mine.txt'] })).data.token)
    expect((await user.json('GET', `/api/batch/${tokens[0]}`)).status).toBe(404)
    expect(await fetched(user, tokens.at(-1)!)).toBe(200)
    expect(files.batchCount()).toBeLessThanOrEqual(files.BATCH_MAX)
  })
})
