/**
 * The remaining findings of the 2.0.0-beta.1 security reviews (run 4: qa/reports/sec-2.0.0-beta.1, and the gaps the
 * run-6 critic named): an upload or an upload-link file that finishes after the virus scan asks again for the account,
 * its rights and the link; a LINE link code dies with its account; two creations of one name at once make one account;
 * folders implied by zip names count; visitors' downloads can not flood the audit trail; "my activity" leaves out lines
 * of another account of the same name; and backup codes are kept under a server key (old ones still work).
 * In-process on the shared app (see in-process-env.ts); users start with "s203-".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import './in-process-env'

// links that users made before 2.0.0-beta.3 (only an admin makes a new one): this file tests what such a link does
beforeAll(async () => { (await import('../src/routes/shares')).uploadLinkPolicy.adminOnly = false })
afterAll(async () => { (await import('../src/routes/shares')).uploadLinkPolicy.adminOnly = true })

let app: any
let config: typeof import('../src/config').config
let paths: typeof import('../src/config').paths
let settings: typeof import('../src/settings').settings
let auth: typeof import('../src/auth')
let line: typeof import('../src/line')
let myData: typeof import('../src/my-data')

class Client {
  cookie = ''
  csrf = ''
  async raw(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers }
    if (this.cookie) h.cookie = this.cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    let payload: any = body
    if (body !== undefined && !(body instanceof Uint8Array) && typeof body !== 'string') { payload = JSON.stringify(body); h['content-type'] = 'application/json' }
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: payload }))
    // every cookie it is given (the session, and an upload link's visitor cookie)
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0]
      const name = pair.split('=')[0]
      this.cookie = [...this.cookie.split('; ').filter(x => x && !x.startsWith(name + '=')), pair].join('; ')
    }
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
  async visit() {
    this.csrf = (await this.json('GET', '/api/session')).data.csrf
    return this
  }
}

const PW = 'harbor-lamp-42'
const PERMS = ['read', 'write', 'upload', 'download', 'share', 'zip']
const admin = new Client()
const home = (user: string, ...p: string[]) => join(process.env.STORAGE_DIR!, 'users', user, ...p)
const made: string[] = []
const mkUser = (username: string) => admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', permissions: PERMS, publicPermissions: [], adoptHome: true })
async function userWith(username: string) {
  const r = await mkUser(username)
  expect(r.status).toBe(200)
  made.push(username)
  mkdirSync(home(username), { recursive: true })
  return new Client().login(username, PW)
}

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config, paths } = await import('../src/config'))
  ;({ settings } = await import('../src/settings'))
  auth = await import('../src/auth')
  line = await import('../src/line')
  myData = await import('../src/my-data')
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
})
afterAll(async () => {
  settings.update({ antivirus: undefined })
  for (const u of [...new Set(made)]) {
    await admin.json('DELETE', `/api/admin/users/${u}`)
    rmSync(home(u), { recursive: true, force: true })
  }
})

describe('an upload that finishes after the scan asks again', () => {
  let server: net.Server
  beforeAll(async () => {
    // answers OK, but only after a while: the completion waits for the scan
    server = net.createServer(sock => {
      let buf = Buffer.alloc(0)
      let started = false
      sock.on('error', () => {})
      sock.on('data', d => {
        buf = Buffer.concat([buf, d])
        if (!started) {
          const nul = buf.indexOf(0)
          if (nul < 0) return
          const command = buf.subarray(0, nul).toString()
          buf = buf.subarray(nul + 1)
          if (command === 'zPING') { sock.end('PONG\0'); return }
          started = true
        }
        for (;;) {
          if (buf.length < 4) return
          const len = buf.readUInt32BE(0)
          if (len === 0) { setTimeout(() => sock.end('stream: OK\0'), 300); return }
          if (buf.length < 4 + len) return
          buf = buf.subarray(4 + len)
        }
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as net.AddressInfo).port
    settings.update({ antivirus: { enabled: true, host: '127.0.0.1', port, timeoutSeconds: 5, maxScanMb: 25, onErrorLinks: 'reject', onErrorUsers: 'reject' } as any })
  })
  afterAll(() => {
    settings.update({ antivirus: undefined })
    server?.close()
  })

  /** announce and send one chunk; the completion is started and returned unawaited */
  async function startUpload(c: Client, name: string) {
    const bytes = new TextEncoder().encode('hello')
    const a = await c.json('POST', '/api/upload', { space: 'home', path: '/', name, size: bytes.length })
    expect(a.status).toBe(200)
    expect((await c.raw('PUT', `/api/upload/${a.data.id}/0`, bytes, { 'content-type': 'application/octet-stream' })).status).toBe(200)
    return c.json('POST', `/api/upload/${a.data.id}/complete`)
  }

  test('an upload scanned while it is allowed still lands', async () => {
    const c = await userWith('s203-upok')
    expect((await startUpload(c, 'ok.txt')).status).toBe(200)
    expect(existsSync(home('s203-upok', 'ok.txt'))).toBe(true)
  })

  test('the upload right taken away during the scan: 403, nothing lands', async () => {
    const c = await userWith('s203-updown')
    const done = startUpload(c, 'f.txt')
    await Bun.sleep(150)
    expect((await admin.json('PUT', '/api/admin/users/s203-updown', { permissions: ['read'] })).status).toBe(200)
    expect((await done).status).toBe(403)
    expect(existsSync(home('s203-updown', 'f.txt'))).toBe(false)
  })

  test('the account deleted and made again during the scan: refused, nothing lands in the new home', async () => {
    const c = await userWith('s203-upnew')
    const done = startUpload(c, 'f.txt')
    await Bun.sleep(150)
    expect((await admin.json('DELETE', '/api/admin/users/s203-upnew')).status).toBe(200)
    await Bun.sleep(5)
    expect((await mkUser('s203-upnew')).status).toBe(200)
    const r = await done
    expect([401, 403]).toContain(r.status)
    expect(existsSync(home('s203-upnew', 'f.txt'))).toBe(false)
  })

  test('an upload link revoked during the scan: refused, nothing lands', async () => {
    const owner = await userWith('s203-link')
    mkdirSync(home('s203-link', 'inbox'), { recursive: true })
    const s = await owner.json('POST', '/api/shares', { space: 'home', path: '/inbox', days: 7, kind: 'upload' })
    expect(s.status).toBe(200)
    const token = s.data.token as string
    const v = await new Client().visit()
    const bytes = new TextEncoder().encode('from a visitor')
    const a = await v.json('POST', `/api/s/${token}/upload`, { name: 'v.txt', size: bytes.length })
    expect(a.status).toBe(200)
    expect((await v.raw('PUT', `/api/s/${token}/upload/${a.data.id}/0`, bytes, { 'content-type': 'application/octet-stream' })).status).toBe(200)
    const done = v.json('POST', `/api/s/${token}/upload/${a.data.id}/complete`)
    await Bun.sleep(150)
    expect((await owner.json('DELETE', `/api/shares/${s.data.share.id}`)).status).toBe(200)
    const r = await done
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(existsSync(home('s203-link', 'inbox', 'v.txt'))).toBe(false)
  })
})

describe('account lifecycle', () => {
  test('a LINE link code does not survive its account: delete, make again, the code links nobody', async () => {
    await userWith('s203-line')
    const { code } = line.issueLinkCode('s203-line')
    expect((await admin.json('DELETE', '/api/admin/users/s203-line')).status).toBe(200)
    expect((await mkUser('s203-line')).status).toBe(200)
    expect(line.redeemLinkCode(code, 'U-s203-line')).toBeNull()
  })

  test('two creations of one name at the same time make one account', async () => {
    const [a, b] = await Promise.all([mkUser('s203-twin'), mkUser('s203-twin')])
    made.push('s203-twin')
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(auth.allUsers().filter(u => u.username.toLowerCase() === 's203-twin').length).toBe(1)
  })

  test('"my activity" leaves out lines written for another account of the same name', () => {
    const now = auth.findUser('admin')!
    const own = myData.ownEntries({ username: 'x', createdAt: '2026-01-01T00:00:00.000Z' })
    const ts = new Date().toISOString()
    expect(own({ ts, user: 'x', ip: '-', action: 'login' })).toBe(true)
    expect(own({ ts, user: 'x', ip: '-', action: 'login', born: '2026-01-01T00:00:00.000Z' })).toBe(true)
    expect(own({ ts, user: 'x', ip: '-', action: 'login', born: '2026-06-01T00:00:00.000Z' })).toBe(false)
    // and new lines carry the account's creation time
    const lines = readFileSync(paths.audit, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines.filter(l => l.user === 'admin').at(-1)?.born).toBe(now.createdAt)
  })
})

describe('zip folders and the audit trail', () => {
  test('folders implied by zip names count toward the file limit', async () => {
    const c = await userWith('s203-dirs')
    const files: Record<string, Uint8Array> = {}
    // 3 files but 60 folders implied by their names
    for (let i = 0; i < 3; i++) files[Array.from({ length: 20 }, (_, d) => `d${i}-${d}`).join('/') + '/f.txt'] = new TextEncoder().encode('x')
    writeFileSync(home('s203-dirs', 'deep.zip'), zipSync(files))
    const saved = config.unzipMaxFiles
    config.unzipMaxFiles = 10
    try {
      const r = await c.json('POST', '/api/unzip', { space: 'home', path: '/deep.zip' })
      expect(r.status).toBe(400)
      expect(r.data.code).toBe('zip.too-many-files')
      expect(existsSync(home('s203-dirs', 'deep'))).toBe(false)
    } finally {
      config.unzipMaxFiles = saved
    }
  })

  test('the same visitor downloading the same public file again and again writes one audit line a minute', async () => {
    mkdirSync(paths.publicDir, { recursive: true })
    const name = `s203-flood-${Date.now()}.txt`
    writeFileSync(join(paths.publicDir, name), 'public')
    const v = await new Client().visit()
    try {
      for (let i = 0; i < 20; i++) {
        const r = await v.raw('GET', `/api/download?space=public&path=/${name}`)
        expect(r.status).toBe(200)
        await r.text()
      }
      const lines = readFileSync(paths.audit, 'utf8').split('\n').filter(l => l.includes(name) && l.includes('"action":"download"'))
      expect(lines.length).toBe(1)
    } finally {
      rmSync(join(paths.publicDir, name), { force: true })
    }
  })
})

describe('2FA backup codes', () => {
  test('new codes are kept under a server key; a code kept the old way still works once', () => {
    const { codes, hashes } = auth.newBackupCodes()
    expect(hashes.every(h => h.startsWith('h1:'))).toBe(true)
    expect(hashes).not.toContain(createHash('sha256').update(codes[0]).digest('hex'))
    const old = 'abcd-efgh'
    const user = { username: 's203-2fa', twoFactor: { secret: 'x', enabledAt: '', lastStep: 0, backup: [...hashes, createHash('sha256').update(old).digest('hex')] } } as any
    // saveUsers is not reached for a user not in the store? it is a plain save: harmless
    expect(auth.checkSecondFactor(user, codes[0])).toBe(true)
    expect(auth.checkSecondFactor(user, codes[0])).toBe(false)
    expect(auth.checkSecondFactor(user, old)).toBe(true)
    expect(auth.checkSecondFactor(user, old)).toBe(false)
    expect(user.twoFactor.backup.length).toBe(9)
  })
})
