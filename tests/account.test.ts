/**
 * Account security: the list of signed-in devices, TOTP two-factor sign-in with backup codes, the sealed secret
 * and the command line tool. Runs in-process on the same app as api.test.ts (see in-process-env.ts); every user
 * here starts with "ac-".
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './in-process-env'

let app: any
let auth: typeof import('../src/auth')
let totp: typeof import('../src/totp')
let box: typeof import('../src/secret-box')
let paths: typeof import('../src/config').paths
let JsonStore: typeof import('../src/store').JsonStore

class Client {
  cookie = ''
  csrf = ''
  async raw(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers }
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
  async json(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const res = await this.raw(method, path, body, headers)
    return { status: res.status, data: (await res.json().catch(() => null)) as any, res }
  }
  async start() {
    this.csrf = (await this.json('GET', '/api/session')).data.csrf
    return this
  }
  /** a password login; with 2FA on the answer is the ticket and the client stays signed out */
  async login(username: string, password: string, ua = 'test-browser/1.0') {
    await this.start()
    const r = await this.json('POST', '/api/login', { username, password }, { 'user-agent': ua })
    if (r.status === 200 && r.data.csrf) this.csrf = r.data.csrf
    return r
  }
  async loginOk(username: string, password: string, ua?: string) {
    const r = await this.login(username, password, ua)
    expect(r.status).toBe(200)
    return this
  }
}

const PW = 'harbor-lamp-42'
const admin = new Client()
const codeFor = (secret: string) => totp.totpAt(secret, totp.stepOf(Date.now()))
/** the same code can not be used twice; tests that sign in more than once let the user's last step go */
const forgetLastStep = (name: string) => { auth.findUser(name)!.twoFactor!.lastStep = -1 }
const auditLines = () => readFileSync(paths.audit, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))

async function userWith(username: string) {
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', permissions: [], publicPermissions: [] })
  expect(r.status).toBe(200)
}

/** a user who has 2FA on; `c` is signed in, `secret` is what the authenticator app holds */
async function twoFactorUser(username: string) {
  await userWith(username)
  const c = await new Client().loginOk(username, PW)
  const setup = await c.json('POST', '/api/2fa/setup', { password: PW })
  expect(setup.status).toBe(200)
  const enable = await c.json('POST', '/api/2fa/enable', { code: codeFor(setup.data.secret) })
  expect(enable.status).toBe(200)
  forgetLastStep(username)
  return { c, secret: setup.data.secret as string, codes: enable.data.backupCodes as string[] }
}

/** password step, then the code step with a fresh client */
async function secondStep(username: string, code: string) {
  const c = new Client()
  const first = await c.login(username, PW)
  expect(first.status).toBe(200)
  const second = await c.json('POST', '/api/login/2fa', { ticket: first.data.ticket, code }, { 'user-agent': 'test-browser/1.0' })
  return { c, first, second }
}

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  auth = await import('../src/auth')
  totp = await import('../src/totp')
  box = await import('../src/secret-box')
  ;({ paths } = await import('../src/config'))
  ;({ JsonStore } = await import('../src/store'))
  await admin.loginOk('admin', 'test-admin-pass')
})

describe('totp (RFC 6238)', () => {
  // the SHA1 vectors of RFC 6238 appendix B, cut to the last 6 of their 8 digits
  const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' // base32 of "12345678901234567890"
  const vectors: [number, string][] = [
    [59, '287082'], [1111111109, '081804'], [1111111111, '050471'],
    [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130'],
  ]
  for (const [seconds, code] of vectors) {
    test(`vector at ${seconds} s`, () => {
      expect(totp.totpAt(SECRET, totp.stepOf(seconds * 1000))).toBe(code)
      expect(totp.verifyTotp(SECRET, code, -1, seconds * 1000)).toBe(totp.stepOf(seconds * 1000))
    })
  }
  test('base32 round trip, case, spaces and padding', () => {
    expect(totp.base32Decode(SECRET).toString()).toBe('12345678901234567890')
    expect(totp.base32Encode(Buffer.from('12345678901234567890'))).toBe(SECRET)
    expect(totp.base32Decode('gezd gnbv-GY3T QOJQ====').toString()).toBe('1234567890')
    for (let n = 0; n < 12; n++) {
      const b = crypto.getRandomValues(new Uint8Array(n))
      expect([...totp.base32Decode(totp.base32Encode(b))]).toEqual([...b])
    }
    expect(() => totp.base32Decode('not*base32')).toThrow()
  })
  test('window: one step before and after, not two', () => {
    const at = 1_700_000_000_000
    const s = totp.stepOf(at)
    expect(totp.verifyTotp(SECRET, totp.totpAt(SECRET, s), -1, at)).toBe(s)
    expect(totp.verifyTotp(SECRET, totp.totpAt(SECRET, s - 1), -1, at)).toBe(s - 1)
    expect(totp.verifyTotp(SECRET, totp.totpAt(SECRET, s + 1), -1, at)).toBe(s + 1)
    expect(totp.verifyTotp(SECRET, totp.totpAt(SECRET, s - 2), -1, at)).toBeNull()
    expect(totp.verifyTotp(SECRET, totp.totpAt(SECRET, s + 2), -1, at)).toBeNull()
    // the edges of a step: the last millisecond of the step and the first of the next
    const edge = (s + 1) * 30_000
    expect(totp.verifyTotp(SECRET, totp.totpAt(SECRET, s - 1), -1, edge - 1)).toBe(s - 1)
    expect(totp.verifyTotp(SECRET, totp.totpAt(SECRET, s - 1), -1, edge)).toBeNull()
  })
  test('a step at or before lastStep is refused', () => {
    const at = 1_700_000_000_000
    const s = totp.stepOf(at)
    const c = totp.totpAt(SECRET, s)
    expect(totp.verifyTotp(SECRET, c, s, at)).toBeNull()
    expect(totp.verifyTotp(SECRET, c, s - 1, at)).toBe(s)
    expect(totp.verifyTotp(SECRET, totp.totpAt(SECRET, s - 1), s, at)).toBeNull()
  })
  test('codes that are not six digits never match', () => {
    const at = 59_000
    for (const bad of ['', '28708', '2870820', 'abcdef', '287 082']) expect(totp.verifyTotp(SECRET, bad, -1, at)).toBeNull()
  })
  test('otpauth uri carries the app name as issuer', () => {
    expect(totp.otpauthUri('ABCDEFGH', 'somchai', 'File Center')).toBe('otpauth://totp/File%20Center:somchai?secret=ABCDEFGH&issuer=File%20Center')
  })
})

describe('secret box', () => {
  test('seal and open, key file is private', () => {
    const sealed = box.seal('hello สวัสดี')
    expect(sealed).not.toContain('hello')
    expect(box.open(sealed)).toBe('hello สวัสดี')
    expect(box.seal('hello สวัสดี')).not.toBe(sealed) // a new iv every time
    expect(statSync(paths.secretKey).mode & 0o777).toBe(0o600)
    expect(Buffer.from(readFileSync(paths.secretKey, 'utf8').trim(), 'base64url').length).toBe(32)
  })
  test('a changed value fails closed', () => {
    const raw = Buffer.from(box.seal('top secret'), 'base64url')
    for (const at of [0, 12, 20, raw.length - 1]) {
      const bad = Buffer.from(raw)
      bad[at] ^= 1
      expect(() => box.open(bad.toString('base64url'))).toThrow()
    }
    expect(() => box.open('')).toThrow()
    expect(() => box.open('AAAA')).toThrow()
  })
  test('a value sealed with another key fails closed', () => {
    const sealed = box.seal('top secret')
    const original = readFileSync(paths.secretKey, 'utf8')
    try {
      writeFileSync(paths.secretKey, Buffer.alloc(32, 7).toString('base64url'))
      box.forgetKey()
      expect(() => box.open(sealed)).toThrow()
    } finally {
      writeFileSync(paths.secretKey, original, { mode: 0o600 })
      box.forgetKey()
    }
    expect(box.open(sealed)).toBe('top secret')
  })
})

describe('devices', () => {
  test('list, newest first, with ip, user agent and the current one marked', async () => {
    await userWith('ac-dev')
    const a = await new Client().loginOk('ac-dev', PW, 'Phone/1')
    await Bun.sleep(5)
    const b = await new Client().loginOk('ac-dev', PW, 'Laptop/' + 'x'.repeat(300))
    const list = await b.json('GET', '/api/sessions')
    expect(list.status).toBe(200)
    expect(list.data.sessions.map((s: any) => s.current)).toEqual([true, false])
    expect(list.data.sessions[0].ua.length).toBe(200)
    expect(list.data.sessions[1].ua).toBe('Phone/1')
    expect(list.data.sessions[0].ip).toBe('unknown')
    expect(Object.keys(list.data.sessions[0]).sort()).toEqual(['created', 'current', 'id', 'ip', 'seen', 'ua'])
    // the id is not the sid and not its hash
    const sid = b.cookie.split('=')[1]
    const { createHash } = await import('node:crypto')
    expect(list.data.sessions[0].id).not.toBe(sid)
    expect(list.data.sessions[0].id).not.toBe(createHash('sha256').update(sid).digest('hex'))
    expect(Buffer.from(list.data.sessions[0].id, 'base64url').length).toBe(16)
    expect((await a.json('GET', '/api/sessions')).data.sessions.find((s: any) => s.current).ua).toBe('Phone/1')
  })
  test('visitors have no list', async () => {
    const g = await new Client().start()
    expect((await g.json('GET', '/api/sessions')).status).toBe(401)
    expect((await g.json('POST', '/api/sessions/revoke-others')).status).toBe(401)
    expect((await g.json('DELETE', '/api/sessions/abc')).status).toBe(401)
  })
  test('delete another device, and not someone else\'s', async () => {
    await userWith('ac-dev2')
    await userWith('ac-dev3')
    const a = await new Client().loginOk('ac-dev2', PW)
    const b = await new Client().loginOk('ac-dev2', PW)
    const other = await new Client().loginOk('ac-dev3', PW)
    const otherId = (await other.json('GET', '/api/sessions')).data.sessions[0].id
    expect((await a.json('DELETE', `/api/sessions/${otherId}`)).status).toBe(404)
    expect((await other.json('GET', '/api/session')).data.user?.username).toBe('ac-dev3')
    const bId = (await b.json('GET', '/api/sessions')).data.sessions.find((s: any) => s.current).id
    expect((await a.json('DELETE', `/api/sessions/${bId}`)).status).toBe(200)
    expect((await b.json('GET', '/api/session')).data.user).toBeNull()
    expect((await a.json('DELETE', `/api/sessions/${bId}`)).status).toBe(404)
    expect((await a.json('DELETE', '/api/sessions/nope')).status).toBe(404)
  })
  test('deleting the current device signs out', async () => {
    await userWith('ac-dev4')
    const a = await new Client().loginOk('ac-dev4', PW)
    const id = (await a.json('GET', '/api/sessions')).data.sessions[0].id
    const r = await a.json('DELETE', `/api/sessions/${id}`)
    expect(r.status).toBe(200)
    expect(r.data.user).toBeNull()
    a.csrf = r.data.csrf
    expect((await a.json('GET', '/api/session')).data.user).toBeNull()
    expect((await a.json('GET', '/api/sessions')).status).toBe(401)
  })
  test('revoke-others keeps only this one', async () => {
    await userWith('ac-dev5')
    const keep = await new Client().loginOk('ac-dev5', PW)
    const gone = await new Client().loginOk('ac-dev5', PW)
    const r = await keep.json('POST', '/api/sessions/revoke-others')
    expect(r.status).toBe(200)
    expect(r.data.revoked).toBe(1)
    expect((await keep.json('GET', '/api/sessions')).data.sessions.length).toBe(1)
    expect((await gone.json('GET', '/api/session')).data.user).toBeNull()
  })
  test('an admin lists and ends the sessions of a user', async () => {
    await userWith('ac-dev6')
    const u = await new Client().loginOk('ac-dev6', PW, 'Tablet/9')
    await new Client().loginOk('ac-dev6', PW)
    const list = await admin.json('GET', '/api/admin/users/ac-dev6/sessions')
    expect(list.status).toBe(200)
    expect(list.data.sessions.length).toBe(2)
    expect(list.data.sessions.some((s: any) => s.ua === 'Tablet/9')).toBe(true)
    expect(list.data.sessions.every((s: any) => s.current === false)).toBe(true)
    expect((await admin.json('GET', '/api/admin/users/nobody-here/sessions')).status).toBe(404)
    expect((await u.json('GET', '/api/admin/users/ac-dev6/sessions')).status).toBe(403)
    expect((await u.json('POST', '/api/admin/users/ac-dev6/sessions/revoke')).status).toBe(403)
    const r = await admin.json('POST', '/api/admin/users/ac-dev6/sessions/revoke')
    expect(r.status).toBe(200)
    expect(r.data.revoked).toBe(2)
    expect((await u.json('GET', '/api/session')).data.user).toBeNull()
    expect((await admin.json('GET', '/api/admin/users/ac-dev6/sessions')).data.sessions).toEqual([])
    expect(auditLines().some(l => l.action === 'sessions-revoke' && l.target === 'ac-dev6' && l.user === 'admin')).toBe(true)
    expect((await admin.json('POST', '/api/admin/users/nobody-here/sessions/revoke')).status).toBe(404)
    expect((await admin.json('GET', '/api/session')).data.user?.username).toBe('admin')
  })
  test('sessions saved before the list existed keep working and get an id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-old-sessions-'))
    try {
      mkdirSync(join(dir, 'data'))
      const hash = (await import('node:crypto')).createHash('sha256').update('old-sid').digest('hex')
      writeFileSync(join(dir, 'data', 'sessions.json'), JSON.stringify({
        [hash]: { csrf: 'c', username: 'olduser', created: Date.now() - 1000, seen: Date.now() },
      }))
      const script = `
        const a = await import(${JSON.stringify(join(import.meta.dir, '../src/auth'))})
        const s = a.getSession('old-sid')
        console.log(JSON.stringify({ user: s?.username, list: a.listUserSessions('olduser', 'old-sid') }))
        await (await import(${JSON.stringify(join(import.meta.dir, '../src/store'))})).JsonStore.flushAll()
      `
      const p = Bun.spawnSync([process.execPath, '-e', script], {
        env: { ...process.env, DATA_DIR: join(dir, 'data'), STORAGE_DIR: join(dir, 'storage'), ADMIN_PASSWORD: 'x'.repeat(12) },
        cwd: dir, stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.stderr.toString()).toBe('')
      const out = JSON.parse(p.stdout.toString().trim().split('\n').at(-1)!)
      expect(out.user).toBe('olduser')
      expect(out.list.length).toBe(1)
      expect(out.list[0]).toMatchObject({ ip: 'unknown', ua: 'unknown', current: true })
      expect(Buffer.from(out.list[0].id, 'base64url').length).toBe(16)
      // the id was saved, so it is the same next time
      const saved = JSON.parse(readFileSync(join(dir, 'data', 'sessions.json'), 'utf8'))[hash]
      expect(saved.id).toBe(out.list[0].id)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('two-factor sign-in', () => {
  test('setup needs the password', async () => {
    await userWith('ac-setup')
    const c = await new Client().loginOk('ac-setup', PW)
    expect((await c.json('POST', '/api/2fa/setup', {})).status).toBe(422)
    const wrong = await c.json('POST', '/api/2fa/setup', { password: 'wrong-password-1' })
    expect(wrong.status).toBe(403)
    expect(wrong.data.secret).toBeUndefined()
    // no setup was started: a code has nothing to be checked against
    expect((await c.json('POST', '/api/2fa/enable', { code: '123456' })).status).toBe(400)
    expect((await new Client().start().then(g => g.json('POST', '/api/2fa/setup', { password: PW }))).status).toBe(401)
    expect(auth.findUser('ac-setup')!.twoFactor).toBeUndefined()
  })
  test('setup, wrong first code, enable; the secret is sealed and shown once', async () => {
    await userWith('ac-on')
    const c = await new Client().loginOk('ac-on', PW)
    const other = await new Client().loginOk('ac-on', PW)
    const setup = await c.json('POST', '/api/2fa/setup', { password: PW })
    expect(setup.status).toBe(200)
    expect(setup.data.secret).toMatch(/^[A-Z2-7]{32}$/)
    const issuer = encodeURIComponent((await c.json('GET', '/api/session')).data.config.appName)
    expect(setup.data.uri).toBe(`otpauth://totp/${issuer}:ac-on?secret=${setup.data.secret}&issuer=${issuer}`)
    expect((await c.json('POST', '/api/2fa/enable', { code: '000000' })).status).toBe(403)
    expect(auth.findUser('ac-on')!.twoFactor).toBeUndefined()
    const enable = await c.json('POST', '/api/2fa/enable', { code: codeFor(setup.data.secret) })
    expect(enable.status).toBe(200)
    expect(enable.data.backupCodes.length).toBe(10)
    for (const code of enable.data.backupCodes) expect(code).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/)
    expect(new Set(enable.data.backupCodes).size).toBe(10)
    // the other device is signed out, this one stays
    expect((await other.json('GET', '/api/session')).data.user).toBeNull()
    const me = await c.json('GET', '/api/session')
    expect(me.data.user.twoFactor).toBe(true)
    expect(Object.keys(me.data.user)).not.toContain('secret')
    // kept sealed, backup codes only as hashes, and nowhere else
    const stored = readFileSync(paths.users, 'utf8')
    await JsonStore.flushAll()
    const onDisk = readFileSync(paths.users, 'utf8')
    for (const text of [stored, onDisk]) {
      expect(text).not.toContain(setup.data.secret)
      for (const code of enable.data.backupCodes) expect(text).not.toContain(code)
    }
    expect(box.open(auth.findUser('ac-on')!.twoFactor!.secret)).toBe(setup.data.secret)
    expect(auth.findUser('ac-on')!.twoFactor!.backup.length).toBe(10)
    const audited = readFileSync(paths.audit, 'utf8')
    expect(audited).not.toContain(setup.data.secret)
    expect(audited).toContain('2fa-enable')
    // already on: no second setup
    expect((await c.json('POST', '/api/2fa/setup', { password: PW })).status).toBe(409)
  })
  test('the pending secret runs out after ten minutes', async () => {
    await userWith('ac-slow')
    const c = await new Client().loginOk('ac-slow', PW)
    const setup = await c.json('POST', '/api/2fa/setup', { password: PW })
    const realNow = Date.now
    Date.now = () => realNow() + 11 * 60_000
    try {
      const r = await c.json('POST', '/api/2fa/enable', { code: totp.totpAt(setup.data.secret, totp.stepOf(Date.now())) })
      expect(r.status).toBe(400)
    } finally {
      Date.now = realNow
    }
    expect(auth.findUser('ac-slow')!.twoFactor).toBeUndefined()
  })
  test('the password alone gives no session', async () => {
    const { codes } = await twoFactorUser('ac-gate')
    const c = new Client()
    const first = await c.login('ac-gate', PW)
    expect(first.status).toBe(200)
    expect(first.data.twoFactor).toBe(true)
    expect(typeof first.data.ticket).toBe('string')
    expect(first.data.user).toBeUndefined()
    expect(first.data.csrf).toBeUndefined()
    expect(first.res.headers.get('set-cookie') ?? '').not.toContain('fc_sid=' + 'x'.repeat(100))
    expect((await c.json('GET', '/api/session')).data.user).toBeNull()
    expect((await c.json('GET', '/api/sessions')).status).toBe(401)
    expect(auth.listUserSessions('ac-gate').length).toBe(1) // only the one used for the setup
    const second = await c.json('POST', '/api/login/2fa', { ticket: first.data.ticket, code: codes[0] })
    expect(second.status).toBe(200)
    expect(second.data.user.username).toBe('ac-gate')
    c.csrf = second.data.csrf
    expect((await c.json('GET', '/api/sessions')).data.sessions.length).toBe(2)
  })
  test('a TOTP code works once; the next step still works, the same one never again', async () => {
    const { secret } = await twoFactorUser('ac-replay')
    const step = totp.stepOf(Date.now())
    const user = auth.findUser('ac-replay')!
    user.twoFactor!.lastStep = step - 1
    expect((await secondStep('ac-replay', totp.totpAt(secret, step))).second.status).toBe(200)
    expect(user.twoFactor!.lastStep).toBe(step)
    // replayed, and the earlier step as well
    expect((await secondStep('ac-replay', totp.totpAt(secret, step))).second.status).toBe(401)
    expect((await secondStep('ac-replay', totp.totpAt(secret, step - 1))).second.status).toBe(401)
    // the following step is a new code
    expect((await secondStep('ac-replay', totp.totpAt(secret, step + 1))).second.status).toBe(200)
  })
  test('a backup code works once', async () => {
    const { codes } = await twoFactorUser('ac-backup')
    expect((await secondStep('ac-backup', codes[3])).second.status).toBe(200)
    expect(auth.findUser('ac-backup')!.twoFactor!.backup.length).toBe(9)
    expect((await secondStep('ac-backup', codes[3])).second.status).toBe(401)
    expect((await secondStep('ac-backup', codes[4].toUpperCase())).second.status).toBe(200)
  })
  test('a ticket is used once, and only by the one it was made for', async () => {
    const { codes } = await twoFactorUser('ac-ticket')
    const c = new Client()
    const first = await c.login('ac-ticket', PW)
    const ok = await c.json('POST', '/api/login/2fa', { ticket: first.data.ticket, code: codes[0] })
    expect(ok.status).toBe(200)
    const again = new Client()
    await again.start()
    const reuse = await again.json('POST', '/api/login/2fa', { ticket: first.data.ticket, code: codes[1] })
    expect(reuse.status).toBe(401)
    expect(reuse.data.code).toBe('auth.2fa-bad-ticket')
    expect((await again.json('POST', '/api/login/2fa', { ticket: 'made-up', code: codes[1] })).status).toBe(401)
    // a ticket is bound to the address that asked for it
    const t = auth.createLoginTicket('ac-ticket', '10.0.0.1')
    expect(auth.peekLoginTicket(t, '10.0.0.2')).toBeNull()
    expect(auth.peekLoginTicket(t, '10.0.0.1')).toBe('ac-ticket')
    // and to its user: another user's valid code does not open it
    const bob = await twoFactorUser('ac-ticket2')
    const mine = await new Client().login('ac-ticket', PW)
    const swap = await again.json('POST', '/api/login/2fa', { ticket: mine.data.ticket, code: bob.codes[0] })
    expect(swap.status).toBe(401)
    expect(auth.findUser('ac-ticket2')!.twoFactor!.backup.length).toBe(10)
  })
  test('a ticket runs out after five minutes', async () => {
    const { codes } = await twoFactorUser('ac-late')
    const c = new Client()
    const first = await c.login('ac-late', PW)
    const realNow = Date.now
    Date.now = () => realNow() + 5 * 60_000 + 1000
    try {
      expect((await c.json('POST', '/api/login/2fa', { ticket: first.data.ticket, code: codes[0] })).status).toBe(401)
    } finally {
      Date.now = realNow
    }
    expect(auth.findUser('ac-late')!.twoFactor!.backup.length).toBe(10)
  })
  test('only a few tickets per user are kept', () => {
    const first = auth.createLoginTicket('ac-many', '1.1.1.1')
    for (let i = 0; i < 8; i++) auth.createLoginTicket('ac-many', '1.1.1.1')
    expect(auth.peekLoginTicket(first, '1.1.1.1')).toBeNull()
    auth.dropLoginTickets('ac-many')
  })
  test('wrong codes lock the second step, with an audit line', async () => {
    const { codes } = await twoFactorUser('ac-lock')
    const c = new Client()
    const first = await c.login('ac-lock', PW)
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) statuses.push((await c.json('POST', '/api/login/2fa', { ticket: first.data.ticket, code: '000000' })).status)
    expect(statuses).toEqual([401, 401, 401, 429])
    // locked: even the right code waits
    const locked = await c.json('POST', '/api/login/2fa', { ticket: first.data.ticket, code: codes[0] })
    expect(locked.status).toBe(429)
    expect(locked.data.code).toBe('auth.2fa-locked')
    expect(auditLines().filter(l => l.action === 'login-2fa-failed' && l.user === 'ac-lock').length).toBe(3)
    auth.clearFailures('unknown|ac-lock'.replace('unknown|ac-lock', '2fa|unknown|ac-lock'))
  })
  test('mustChangePassword still applies after the second step', async () => {
    const { codes } = await twoFactorUser('ac-must')
    auth.findUser('ac-must')!.mustChangePassword = true
    const { c, second } = await secondStep('ac-must', codes[0])
    expect(second.status).toBe(200)
    expect(second.data.user.mustChangePassword).toBe(true)
    c.csrf = second.data.csrf
    const blocked = await c.json('GET', '/api/sessions')
    expect(blocked.status).toBe(403)
    expect(blocked.data.code).toBe('must-change-password')
  })
  test('a successful second step is a normal login: audit, last login, new session record', async () => {
    const { codes } = await twoFactorUser('ac-normal')
    const { c, second } = await secondStep('ac-normal', codes[0])
    expect(second.status).toBe(200)
    expect(auth.findUser('ac-normal')!.lastLogin).toBeTruthy()
    expect(auditLines().some(l => l.action === 'login' && l.user === 'ac-normal')).toBe(true)
    c.csrf = second.data.csrf
    const mine = (await c.json('GET', '/api/sessions')).data.sessions.find((s: any) => s.current)
    expect(mine.ua).toBe('test-browser/1.0')
  })
  test('disable needs the password and a code', async () => {
    const { c, secret, codes } = await twoFactorUser('ac-off')
    expect((await c.json('POST', '/api/2fa/disable', { password: PW })).status).toBe(422)
    expect((await c.json('POST', '/api/2fa/disable', { password: 'wrong-password-1', code: codeFor(secret) })).status).toBe(403)
    expect((await c.json('POST', '/api/2fa/disable', { password: PW, code: '000000' })).status).toBe(403)
    expect(auth.findUser('ac-off')!.twoFactor).toBeTruthy()
    forgetLastStep('ac-off')
    const r = await c.json('POST', '/api/2fa/disable', { password: PW, code: codes[0] })
    expect(r.status).toBe(200)
    expect(auth.findUser('ac-off')!.twoFactor).toBeUndefined()
    expect((await c.json('GET', '/api/session')).data.user.twoFactor).toBe(false)
    expect((await c.json('POST', '/api/2fa/disable', { password: PW, code: codes[1] })).status).toBe(400)
    // a plain login works again
    expect((await new Client().login('ac-off', PW)).data.user.username).toBe('ac-off')
  })
  test('new backup codes replace the old ones', async () => {
    const { c, secret, codes } = await twoFactorUser('ac-new')
    expect((await c.json('POST', '/api/2fa/backup-codes', { password: PW, code: '000000' })).status).toBe(403)
    expect((await c.json('POST', '/api/2fa/backup-codes', { password: 'wrong-password-1', code: codeFor(secret) })).status).toBe(403)
    const r = await c.json('POST', '/api/2fa/backup-codes', { password: PW, code: codeFor(secret) })
    expect(r.status).toBe(200)
    expect(r.data.backupCodes.length).toBe(10)
    expect(r.data.backupCodes.some((x: string) => codes.includes(x))).toBe(false)
    expect((await secondStep('ac-new', codes[0])).second.status).toBe(401)
    expect((await secondStep('ac-new', r.data.backupCodes[0])).second.status).toBe(200)
  })
  test('wrong codes on disable count toward a lockout', async () => {
    const { c, codes } = await twoFactorUser('ac-brute')
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) statuses.push((await c.json('POST', '/api/2fa/disable', { password: PW, code: '000000' })).status)
    expect(statuses).toEqual([403, 403, 403, 429])
    expect((await c.json('POST', '/api/2fa/disable', { password: PW, code: codes[0] })).status).toBe(429)
    expect(auth.findUser('ac-brute')!.twoFactor).toBeTruthy()
    auth.clearFailures('2fa-step-up|unknown|ac-brute')
  })
  test('an admin resets 2FA with their own password', async () => {
    const { c, codes } = await twoFactorUser('ac-reset')
    const u = await new Client().loginOk('ac-reset', PW)
    expect((await c.json('POST', '/api/admin/users/ac-reset/2fa/reset', { password: PW })).status).toBe(403)
    expect((await admin.json('POST', '/api/admin/users/ac-reset/2fa/reset', {})).status).toBe(422)
    expect((await admin.json('POST', '/api/admin/users/ac-reset/2fa/reset', { password: PW })).status).toBe(403)
    expect(auth.findUser('ac-reset')!.twoFactor).toBeTruthy()
    expect((await admin.json('POST', '/api/admin/users/nobody-here/2fa/reset', { password: 'test-admin-pass' })).status).toBe(404)
    const ticket = auth.createLoginTicket('ac-reset', 'unknown')
    const r = await admin.json('POST', '/api/admin/users/ac-reset/2fa/reset', { password: 'test-admin-pass' })
    expect(r.status).toBe(200)
    expect(auth.findUser('ac-reset')!.twoFactor).toBeUndefined()
    expect(auth.peekLoginTicket(ticket, 'unknown')).toBeNull()
    for (const client of [c, u]) expect((await client.json('GET', '/api/session')).data.user).toBeNull()
    expect((await new Client().login('ac-reset', PW)).data.user.username).toBe('ac-reset')
    expect(auditLines().some(l => l.action === '2fa-reset' && l.target === 'ac-reset' && l.user === 'admin')).toBe(true)
    expect(codes.length).toBe(10)
  })
  test('no other route gives a 2FA user a session without the code', async () => {
    await twoFactorUser('ac-only')
    // a share unlock, an upload or the session route do not sign anyone in; password change needs a session
    const c = await new Client().start()
    expect((await c.json('POST', '/api/password', { current: PW, next: 'another-pass-77' })).status).toBe(401)
    expect((await c.json('GET', '/api/session')).data.user).toBeNull()
    // a bad ticket (a username, a password) is not accepted as one
    expect((await c.json('POST', '/api/login/2fa', { ticket: 'ac-only', code: '000000' })).status).toBe(401)
    expect((await c.json('POST', '/api/login/2fa', { ticket: PW, code: '000000' })).status).toBe(401)
  })
})

describe('command line', () => {
  const cli = (dataDir: string, storageDir: string, ...args: string[]) => {
    const p = Bun.spawnSync([process.execPath, join(import.meta.dir, '../src/cli.ts'), ...args], {
      env: { ...process.env, DATA_DIR: dataDir, STORAGE_DIR: storageDir }, cwd: tmpdir(), stdout: 'pipe', stderr: 'pipe',
    })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }
  const sha = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex')
  const userRecord = (name: string) => ({
    username: name, name, role: 'user', homedir: `/users/${name}`, permissions: [], publicPermissions: [],
    passwordHash: 'x', createdAt: new Date().toISOString(),
    twoFactor: { secret: 'sealed', enabledAt: new Date().toISOString(), lastStep: 5, backup: ['a'] },
  })
  const session = (name: string) => ({ id: name + '-id', csrf: 'c', username: name, created: Date.now(), seen: Date.now() })

  test('reset-2fa and sessions-revoke on a data folder, unknown user exits 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-cli-'))
    try {
      const data = join(dir, 'data')
      mkdirSync(data)
      writeFileSync(join(data, 'users.json'), JSON.stringify({ users: [userRecord('cli-a'), userRecord('cli-b')] }))
      writeFileSync(join(data, 'sessions.json'), JSON.stringify({
        [sha('1')]: session('cli-a'), [sha('2')]: session('cli-a'), [sha('3')]: session('cli-b'),
      }))
      const reset = cli(data, join(dir, 'storage'), 'reset-2fa', 'cli-a')
      expect(reset.err).toBe('')
      expect(reset.code).toBe(0)
      expect(reset.out).toContain('cli-a')
      const users = JSON.parse(readFileSync(join(data, 'users.json'), 'utf8')).users
      expect(users.find((u: any) => u.username === 'cli-a').twoFactor).toBeUndefined()
      expect(users.find((u: any) => u.username === 'cli-b').twoFactor).toBeTruthy()
      let sessions = JSON.parse(readFileSync(join(data, 'sessions.json'), 'utf8'))
      expect(Object.values(sessions).map((s: any) => s.username)).toEqual(['cli-b'])

      const revoke = cli(data, join(dir, 'storage'), 'sessions-revoke', 'cli-b')
      expect(revoke.code).toBe(0)
      expect(revoke.out).toContain('1 session')
      sessions = JSON.parse(readFileSync(join(data, 'sessions.json'), 'utf8'))
      expect(sessions).toEqual({})

      const audit = readFileSync(join(data, 'logs', 'audit.log'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
      expect(audit.map((l: any) => [l.user, l.action, l.target])).toEqual([['cli', '2fa-reset', 'cli-a'], ['cli', 'sessions-revoke', 'cli-b']])

      for (const cmd of ['reset-2fa', 'sessions-revoke']) {
        const unknown = cli(data, join(dir, 'storage'), cmd, 'nobody-here')
        expect(unknown.code).toBe(1)
        expect(unknown.err).toContain('nobody-here')
      }
      expect(cli(data, join(dir, 'storage'), 'reset-2fa').code).toBe(1)
      expect(cli(data, join(dir, 'storage'), 'nonsense', 'cli-a').code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('while the app runs: the next request sees the change', async () => {
    const { codes } = await twoFactorUser('ac-cli')
    const c = await new Client().loginOk('admin', 'test-admin-pass')
    await JsonStore.flushAll() // what the app holds is on disk before another process reads it
    const r = cli(process.env.DATA_DIR!, process.env.STORAGE_DIR!, 'reset-2fa', 'ac-cli')
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    // the next request reads the files again: no 2FA any more, and the admin session of this app is still there
    expect((await c.json('GET', '/api/session')).data.user.username).toBe('admin')
    expect(auth.findUser('ac-cli')!.twoFactor).toBeUndefined()
    expect((await new Client().login('ac-cli', PW)).data.user.username).toBe('ac-cli')
    expect(codes.length).toBe(10)
    // ending sessions from the command line reaches the running app too
    const victim = await new Client().loginOk('ac-cli', PW)
    await JsonStore.flushAll()
    expect(cli(process.env.DATA_DIR!, process.env.STORAGE_DIR!, 'sessions-revoke', 'ac-cli').code).toBe(0)
    expect((await victim.json('GET', '/api/session')).data.user).toBeNull()
  })
})
