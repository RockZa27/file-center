/**
 * Round 9 security fixes: one request can not stall the server (item and body limits), wrong passwords on the password
 * change count in the step-up lockout, login lockouts per account and per address, and upload-request links with
 * default limits, the visitors' daily allowance and a short idle time. Runs in-process on the shared app
 * (see in-process-env.ts); every user and address here starts with "r9".
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import './in-process-env'

let app: any
let config: typeof import('../src/config').config
let paths: typeof import('../src/config').paths
let auth: typeof import('../src/auth')
let uploads: typeof import('../src/uploads')
let totp: typeof import('../src/totp')

class Client {
  jar = new Map<string, string>()
  csrf = ''
  async raw(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers }
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    if (cookie) h.cookie = cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    let payload: any = body
    if (typeof body === 'string') h['content-type'] = 'application/json'
    else if (body !== undefined) {
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
  async session() {
    this.csrf = (await this.json('GET', '/api/session')).data.csrf
    return this
  }
  async login(username: string, password: string, headers: Record<string, string> = {}) {
    await this.session()
    const r = await this.json('POST', '/api/login', { username, password }, headers)
    expect(r.status).toBe(200)
    this.csrf = r.data.csrf
    return this
  }
}

const PW = 'harbor-lamp-42'
const admin = new Client()
const code = (r: { status: number; data: any }) => ({ status: r.status, code: r.data?.code })
const xff = (ip: string) => ({ 'x-forwarded-for': ip })

async function makeUser(username: string, extra: Record<string, unknown> = {}) {
  const r = await admin.json('POST', '/api/admin/users', {
    username, name: username, password: PW, role: 'user', permissions: ['read', 'write', 'upload', 'download', 'share', 'zip', 'batchdownload'],
    publicPermissions: [], ...extra,
  })
  expect(r.status).toBe(200)
}

let saved: any
beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config, paths } = await import('../src/config'))
  auth = await import('../src/auth')
  uploads = await import('../src/uploads')
  totp = await import('../src/totp')
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
  saved = { ...config }
})

afterEach(() => {
  Object.assign(config, {
    trustProxy: saved.trustProxy, loginAccountMaxAttempts: saved.loginAccountMaxAttempts,
    loginAddressMaxAttempts: saved.loginAddressMaxAttempts, uploadRequestMaxFile: saved.uploadRequestMaxFile,
    uploadRequestMaxTotal: saved.uploadRequestMaxTotal, uploadRequestIdleMs: saved.uploadRequestIdleMs,
  })
  // lockouts must not reach into the next test (every request here comes from one address)
  for (const k of ['login-address|unknown', 'step-up|unknown|r9pw', 'login-address|10.9.0.1', 'login-address|10.9.0.2']) auth.clearFailures(k)
})

describe('F1: one request can not stall the server', () => {
  test('more items than the limit: 400 with a catalog message, in every route that takes a list', async () => {
    const items = Array.from({ length: 2001 }, (_, i) => `f${i}.txt`)
    for (const [path, body] of [
      ['/api/batch', { space: 'home', path: '/', items }],
      ['/api/zip', { space: 'home', path: '/', items }],
      ['/api/delete', { space: 'home', items }],
      ['/api/copy', { space: 'home', items, dest: '/' }],
      ['/api/move', { space: 'home', items, dest: '/' }],
    ] as const) {
      const r = await admin.json('POST', path, body)
      expect(code(r)).toEqual({ status: 400, code: 'files.bad-count' })
      // the message says what the limit is
      expect(r.data.params).toEqual({ max: 2000 })
      expect(r.data.error).toContain('2000')
    }
    // 2000 are still fine to ask for (they are simply not there)
    const ok = await admin.json('POST', '/api/batch', { space: 'home', path: '/', items: items.slice(0, 2000) })
    expect(code(ok)).toEqual({ status: 404, code: 'files.item-missing' })
  })

  test('the same name many times is one item', async () => {
    mkdirSync(join(config.storageDir, 'r9dup'), { recursive: true })
    writeFileSync(join(config.storageDir, 'r9dup', 'a.txt'), 'hello')
    const r = await admin.json('POST', '/api/batch', { space: 'home', path: '/r9dup', items: Array(2000).fill('a.txt') })
    expect(r.status).toBe(200)
    const z = await admin.json('POST', '/api/zip', { space: 'home', path: '/r9dup', items: Array(2000).fill('a.txt'), name: 'dup.zip' })
    expect(z.status).toBe(200)
    expect(z.data.name).toBe('dup.zip')
  })

  test('a big JSON body is refused before it is parsed; the editor and invalid JSON keep their answers', async () => {
    const big = JSON.stringify({ username: 'x'.repeat(1.2 * 1024 * 1024), password: 'y' })
    const r = await new Client().raw('POST', '/api/login', big)
    expect(r.status).toBe(413)
    expect((await r.json()).code).toBe('request.too-big')
    expect((await new Client().raw('POST', '/api/login', '{not json')).status).toBe(400)
    // a 1.5 MB text file is still saved through PUT /api/content
    writeFileSync(join(config.storageDir, 'r9big.txt'), '')
    const put = await admin.json('PUT', '/api/content', { space: 'home', path: '/r9big.txt', content: 'z'.repeat(1.5 * 1024 * 1024) })
    expect(put.status).toBe(200)
  })
})

describe('F2: password change counts wrong guesses in the step-up lockout', () => {
  test('wrong current passwords lock (429, auth.confirm-locked), and the right one does not skip the wait', async () => {
    await makeUser('r9pw')
    const c = await new Client().login('r9pw', PW)
    const change = (current: string) => c.json('POST', '/api/password', { current, next: 'a-brand-new-pass-77' })
    // LOGIN_MAX_ATTEMPTS is 3 in tests: the old answer for a wrong password stays 400
    expect(code(await change('nope-1'))).toEqual({ status: 400, code: 'auth.wrong-current-password' })
    expect(code(await change('nope-2'))).toEqual({ status: 400, code: 'auth.wrong-current-password' })
    expect(code(await change('nope-3'))).toEqual({ status: 400, code: 'auth.wrong-current-password' })
    expect(code(await change('nope-4'))).toEqual({ status: 429, code: 'auth.confirm-locked' })
    expect(code(await change(PW))).toEqual({ status: 429, code: 'auth.confirm-locked' })
    auth.clearFailures('step-up|unknown|r9pw')
    expect((await change(PW)).status).toBe(200)
  })
})

describe('F3: login lockouts per account and per address', () => {
  test('one account guessed from many addresses locks as a whole; the right password does not skip the wait', async () => {
    await makeUser('r9acct')
    config.trustProxy = 'true'
    config.loginAccountMaxAttempts = 4
    for (let i = 1; i <= 4; i++) {
      const r = await new Client().session().then(c => c.json('POST', '/api/login', { username: 'r9acct', password: 'wrong-' + i }, xff(`10.9.1.${i}`)))
      expect(code(r)).toEqual({ status: 401, code: 'auth.bad-credentials' })
    }
    const c = await new Client().session()
    const r = await c.json('POST', '/api/login', { username: 'R9ACCT', password: PW }, xff('10.9.1.99'))
    expect(code(r)).toEqual({ status: 429, code: 'auth.locked' })
    expect(r.data.params.seconds).toBeGreaterThan(0)
    auth.clearFailures('login-account|r9acct')
    expect((await c.json('POST', '/api/login', { username: 'r9acct', password: PW }, xff('10.9.1.99'))).status).toBe(200)
  })

  test('one address trying many usernames waits as a whole', async () => {
    config.trustProxy = 'true'
    config.loginAddressMaxAttempts = 4
    const c = await new Client().session()
    for (let i = 0; i < 4; i++) {
      expect((await c.json('POST', '/api/login', { username: `r9nobody${i}`, password: 'x' }, xff('10.9.0.1'))).status).toBe(401)
    }
    expect(code(await c.json('POST', '/api/login', { username: 'r9nobody9', password: 'x' }, xff('10.9.0.1')))).toEqual({ status: 429, code: 'auth.locked' })
    // another address is not affected
    expect((await c.json('POST', '/api/login', { username: 'r9nobody9', password: 'x' }, xff('10.9.0.2'))).status).toBe(401)
  })

  test('the second step of a sign-in locks per account as well', async () => {
    await makeUser('r9tfa')
    const c = await new Client().login('r9tfa', PW)
    const setup = await c.json('POST', '/api/2fa/setup', { password: PW })
    const good = () => totp.totpAt(setup.data.secret, totp.stepOf(Date.now()))
    expect((await c.json('POST', '/api/2fa/enable', { code: good() })).status).toBe(200)
    config.trustProxy = 'true'
    config.loginAccountMaxAttempts = 3
    const ticketFrom = async (ip: string) => (await (await new Client().session()).json('POST', '/api/login', { username: 'r9tfa', password: PW }, xff(ip))).data.ticket
    for (let i = 1; i <= 3; i++) {
      const v = await new Client().session()
      expect(code(await v.json('POST', '/api/login/2fa', { ticket: await ticketFrom(`10.9.2.${i}`), code: '000000' }, xff(`10.9.2.${i}`)))).toEqual({ status: 401, code: 'auth.two-factor-bad-code' })
    }
    const v = await new Client().session()
    const r = await v.json('POST', '/api/login/2fa', { ticket: await ticketFrom('10.9.2.50'), code: good() }, xff('10.9.2.50'))
    expect(code(r)).toEqual({ status: 429, code: 'auth.two-factor-locked' })
    auth.clearFailures('2fa-account|r9tfa')
  })

  test('failed sign-ins reach the audit log at most once a minute per key, with a count', async () => {
    const c = await new Client().session()
    for (let i = 0; i < 3; i++) await c.json('POST', '/api/login', { username: 'r9flood', password: 'x' })
    auth.clearFailures('login-address|unknown')
    const act = await admin.json('GET', '/api/admin/activity?action=login-failed&q=r9flood&pageSize=100')
    const mine = act.data.items.filter((e: any) => e.user === 'r9flood')
    expect(mine.length).toBe(1)
    expect(mine[0].detail).toContain('1')
  })

  test('the limits are config values', () => {
    expect(saved.loginAccountMaxAttempts).toBe(20)
    expect(saved.loginAddressMaxAttempts).toBe(30)
    expect(saved.loginWideWindowMs).toBe(15 * 60_000)
  })
})

describe('F4: upload-request links', () => {
  const PERMS = ['read', 'write', 'upload', 'download', 'share']
  const inbox = (user: string) => join(process.env.STORAGE_DIR!, 'users', user, 'inbox')
  const announce = (v: Client, t: string, name: string, size: number) => v.json('POST', `/api/s/${t}/upload`, { name, size })

  async function linkOf(username: string, body: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    await makeUser(username, { permissions: PERMS, ...extra })
    mkdirSync(inbox(username), { recursive: true })
    const o = await new Client().login(username, PW)
    const r = await o.json('POST', '/api/shares', { space: 'home', path: '/inbox', days: 7, kind: 'upload', ...body })
    expect(r.status).toBe(200)
    return r.data.token as string
  }

  afterEach(() => {
    const old = new Date(Date.now() - config.uploadStaleMs - 60_000)
    for (const id of existsSync(paths.tmp) ? readdirSync(paths.tmp) : []) {
      try { utimesSync(join(paths.tmp, id, 'meta.json'), old, old) } catch { /* not an upload */ }
    }
    uploads.cleanStaleUploads()
  })

  test('a link without limits gets the defaults (per file and in total)', async () => {
    config.uploadRequestMaxFile = 1000
    config.uploadRequestMaxTotal = 1500
    const t = await linkOf('r9lim')
    const v = new Client()
    expect(code(await announce(v, t, 'big.bin', 1001))).toEqual({ status: 413, code: 'share.upload-too-big' })
    const first = await announce(v, t, 'a.bin', 1000)
    expect(first.status).toBe(200)
    expect(code(await announce(v, t, 'b.bin', 600))).toEqual({ status: 403, code: 'share.upload-full' })
    expect((await announce(v, t, 'c.bin', 500)).status).toBe(200)
  })

  test('uploads count against the visitors\' daily allowance when no quota holds them', async () => {
    const before = uploads.guestUploadUsage().used
    const t = await linkOf('r9noquota')
    const v = new Client()
    const a = await announce(v, t, 'a.bin', 700)
    expect(a.status).toBe(200)
    expect(uploads.guestUploadUsage().used).toBe(before + 700)
    // cancelling gives it back
    expect((await v.json('DELETE', `/api/s/${t}/upload/${a.data.id}`)).status).toBe(200)
    expect(uploads.guestUploadUsage().used).toBe(before)
    // an owner with a quota is counted by the quota, not by the visitors' allowance
    const q = await linkOf('r9quota', {}, { quotaBytes: 10_000_000 })
    expect((await announce(new Client(), q, 'a.bin', 700)).status).toBe(200)
    expect(uploads.guestUploadUsage().used).toBe(before)
  })

  test('an announced upload that gets no chunk stops holding the link\'s slots after the idle time', async () => {
    const t = await linkOf('r9idle')
    const v = new Client()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const a = await announce(v, t, `f${i}.bin`, 10)
      expect(a.status).toBe(200)
      ids.push(a.data.id)
    }
    expect(code(await announce(v, t, 'f3.bin', 10))).toEqual({ status: 429, code: 'share.upload-busy' })
    // 20 minutes without a chunk (far below UPLOAD_STALE_HOURS)
    const old = new Date(Date.now() - 20 * 60_000)
    for (const id of ids) utimesSync(join(paths.tmp, id, 'meta.json'), old, old)
    expect((await announce(v, t, 'f3.bin', 10)).status).toBe(200)
    expect(existsSync(join(paths.tmp, ids[0]))).toBe(false)
  })
})
