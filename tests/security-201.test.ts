/**
 * The findings of the scoped follow-up audit of 2.0.0-beta.1 (qa/reports/sec-2.0.0-beta.1-followup): a revoke by
 * `bun src/cli.ts sessions-revoke` must not be undone by a timer write of the running app, and a WebDAV PUT or a text
 * editor save that is still running asks again for the credential, the account and its rights before it writes.
 * In-process on the shared app (see in-process-env.ts); every user here starts with "s201-".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import net from 'node:net'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import './in-process-env'

let app: any
let paths: typeof import('../src/config').paths
let auth: typeof import('../src/auth')
let settings: typeof import('../src/settings').settings
let JsonStore: typeof import('../src/store').JsonStore

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
const PERMS = ['read', 'write', 'upload', 'download']
const admin = new Client()
const home = (user: string, ...p: string[]) => join(process.env.STORAGE_DIR!, 'users', user, ...p)
const made: string[] = []

async function createUser(username: string) {
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', permissions: PERMS, publicPermissions: [], adoptHome: true })
  expect(r.status).toBe(200)
  if (!made.includes(username)) made.push(username)
  mkdirSync(home(username), { recursive: true })
}
async function userWith(username: string) {
  await createUser(username)
  return new Client().login(username, PW)
}
async function appPassword(c: Client) {
  const r = await c.json('POST', '/api/me/app-passwords', { name: 'laptop', scope: 'readwrite', password: PW })
  expect(r.status).toBe(200)
  return { secret: r.data.secret as string, id: r.data.item?.id ?? r.data.id as string }
}
const basic = (username: string, secret: string) => 'Basic ' + Buffer.from(`${username}:${secret}`).toString('base64')
const dav = (username: string, secret: string, method = 'PROPFIND', path = '/dav/', body?: any) =>
  app.handle(new Request('http://localhost' + path, {
    method, headers: { authorization: basic(username, secret), depth: '0' }, body, duplex: 'half',
  } as any)) as Promise<Response>
const cli = (username: string) => {
  const r = Bun.spawnSync([process.execPath, 'src/cli.ts', 'sessions-revoke', username], { env: process.env, cwd: join(import.meta.dir, '..') })
  expect(r.exitCode).toBe(0)
}
const onDisk = (username: string) =>
  (JSON.parse(readFileSync(paths.appPasswords, 'utf8')).items as any[]).filter(p => p.username === username).length

/** a PUT whose body comes in two pieces, with `between` run after the first one has arrived */
async function slowPut(username: string, secret: string, path: string, between: () => Promise<void>) {
  let ctl!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c } })
  const res = dav(username, secret, 'PUT', path, body)
  ctl.enqueue(new TextEncoder().encode('hello'))
  await Bun.sleep(150)
  await between()
  ctl.enqueue(new TextEncoder().encode('world'))
  ctl.close()
  return res
}

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ paths } = await import('../src/config'))
  auth = await import('../src/auth')
  ;({ settings } = await import('../src/settings'))
  ;({ JsonStore } = await import('../src/store'))
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
})
afterAll(async () => {
  settings.update({ antivirus: undefined })
  for (const u of made) {
    await admin.json('DELETE', `/api/admin/users/${u}`)
    rmSync(home(u), { recursive: true, force: true })
  }
})

describe('a revoke by the command line is not undone by a write of the running app', () => {
  test('the pending lastUsedAt write of an app password does not bring it back', async () => {
    const c = await userWith('s201-alice')
    const { secret } = await appPassword(c)
    // the first use leaves a write of lastUsedAt waiting for its timer
    expect((await dav('s201-alice', secret)).status).toBe(207)
    cli('s201-alice')
    // the timer fires before any request reaches the app
    await JsonStore.flushAll()
    expect(onDisk('s201-alice')).toBe(0)
    expect((await dav('s201-alice', secret)).status).toBe(401)
    expect(onDisk('s201-alice')).toBe(0)
  })

  test('the hourly session purge does not bring a revoked session back', async () => {
    const c = await userWith('s201-carol')
    expect((await c.json('GET', '/api/session')).data.user?.username).toBe('s201-carol')
    cli('s201-carol')
    auth.purgeExpiredSessions()
    await JsonStore.flushAll()
    const sessions = JSON.parse(readFileSync(paths.sessions, 'utf8'))
    expect(Object.values(sessions).some((s: any) => s.username === 's201-carol')).toBe(false)
    expect((await c.json('GET', '/api/session')).data.user?.username).not.toBe('s201-carol')
  })
})

describe('a WebDAV PUT asks again before it writes', () => {
  test('a normal slow PUT still works', async () => {
    const c = await userWith('s201-dan')
    const { secret } = await appPassword(c)
    const r = await slowPut('s201-dan', secret, '/dav/home/ok.txt', async () => {})
    expect(r.status).toBe(201)
    expect(readFileSync(home('s201-dan', 'ok.txt'), 'utf8')).toBe('helloworld')
  })

  test('an app password revoked while the body arrives: 401, nothing written', async () => {
    const c = await userWith('s201-erin')
    const { secret, id } = await appPassword(c)
    const r = await slowPut('s201-erin', secret, '/dav/home/f.txt', async () => {
      expect((await c.json('DELETE', `/api/me/app-passwords/${id}`)).status).toBe(200)
    })
    expect(r.status).toBe(401)
    expect(existsSync(home('s201-erin', 'f.txt'))).toBe(false)
  })

  test('rights lowered to read while the body arrives: 403, nothing written', async () => {
    const c = await userWith('s201-finn')
    const { secret } = await appPassword(c)
    const r = await slowPut('s201-finn', secret, '/dav/home/f.txt', async () => {
      expect((await admin.json('PUT', '/api/admin/users/s201-finn', { permissions: ['read'] })).status).toBe(200)
    })
    expect(r.status).toBe(403)
    expect(existsSync(home('s201-finn', 'f.txt'))).toBe(false)
  })

  test('the account deleted and made again under the same name: 401, nothing lands in the new home', async () => {
    const c = await userWith('s201-gail')
    const { secret } = await appPassword(c)
    const r = await slowPut('s201-gail', secret, '/dav/home/f.txt', async () => {
      expect((await admin.json('DELETE', '/api/admin/users/s201-gail')).status).toBe(200)
      await Bun.sleep(5)
      await createUser('s201-gail')
    })
    expect(r.status).toBe(401)
    expect(existsSync(home('s201-gail', 'f.txt'))).toBe(false)
  })
})

describe('a text editor save asks again after the virus scan', () => {
  let server: net.Server
  beforeAll(async () => {
    // answers OK, but only after a while: the save waits for the scan
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
          if (len === 0) { setTimeout(() => sock.end('stream: OK\0'), 400); return }
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

  test('a save scanned while it is allowed still works', async () => {
    const c = await userWith('s201-hal')
    writeFileSync(home('s201-hal', 'doc.txt'), 'old')
    const r = await c.json('PUT', '/api/content', { space: 'home', path: '/doc.txt', content: 'new' })
    expect(r.status).toBe(200)
    expect(readFileSync(home('s201-hal', 'doc.txt'), 'utf8')).toBe('new')
  })

  test('rights lowered to read during the scan: 403, the old content stays', async () => {
    const c = await userWith('s201-ivy')
    writeFileSync(home('s201-ivy', 'doc.txt'), 'old')
    const save = c.json('PUT', '/api/content', { space: 'home', path: '/doc.txt', content: 'AFTER-DOWNGRADE' })
    await Bun.sleep(150)
    expect((await admin.json('PUT', '/api/admin/users/s201-ivy', { permissions: ['read'] })).status).toBe(200)
    const r = await save
    expect(r.status).toBe(403)
    expect(readFileSync(home('s201-ivy', 'doc.txt'), 'utf8')).toBe('old')
  })
})
