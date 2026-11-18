/**
 * The findings of the run-5 and run-6 security reviews of 2.0.0-beta.1 (qa/reports/sec-2.0.0-beta.1-followup and
 * sec-2.0.0-beta.1-gaps): zip downloads that are never read must not hold every zip codec (the backup waited behind them),
 * one zip of a big folder must not stop the server for its whole length, and POST /api/unzip asks again for the account
 * and its rights after the antivirus scan. In-process on the shared app (see in-process-env.ts); users start with "s202-".
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import './in-process-env'

let app: any
let settings: typeof import('../src/settings').settings
let zip: typeof import('../src/zip')

class Client {
  cookie = ''
  csrf = ''
  async raw(method: string, path: string, body?: any) {
    const h: Record<string, string> = {}
    if (this.cookie) h.cookie = this.cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    let payload: any
    if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json' }
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: payload }))
    const set = res.headers.get('set-cookie')
    if (set?.startsWith('fc_sid=')) this.cookie = set.split(';')[0]
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
}

const PW = 'harbor-lamp-42'
const PERMS = ['read', 'write', 'upload', 'download', 'zip', 'batchdownload']
const admin = new Client()
const home = (user: string, ...p: string[]) => join(process.env.STORAGE_DIR!, 'users', user, ...p)
const made: string[] = []
const saved = { perCaller: 0, total: 0, idleMs: 0, maxEntries: 0 }

async function userWith(username: string) {
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', permissions: PERMS, publicPermissions: [], adoptHome: true })
  expect(r.status).toBe(200)
  made.push(username)
  mkdirSync(home(username), { recursive: true })
  return new Client().login(username, PW)
}
/** start a batch zip download of `items` in the caller's home; the body is not read */
async function batch(c: Client, items: string[]) {
  const t = await c.json('POST', '/api/batch', { space: 'home', path: '/', items })
  expect(t.status).toBe(200)
  return c.raw('GET', `/api/batch/${t.data.token}`)
}
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, Bun.sleep(ms).then(() => 'TIMEOUT' as const)])

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ settings } = await import('../src/settings'))
  zip = await import('../src/zip')
  Object.assign(saved, zip.zipLimits ?? {})
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
})
afterEach(() => { if (zip.zipLimits) Object.assign(zip.zipLimits, saved) })
afterAll(async () => {
  settings.update({ antivirus: undefined })
  for (const u of made) {
    await admin.json('DELETE', `/api/admin/users/${u}`)
    rmSync(home(u), { recursive: true, force: true })
  }
})

describe('zip downloads that are never read do not hold the server', () => {
  test('a caller runs at most perCaller zips at a time; the next is 503 zip.busy until one ends', async () => {
    const c = await userWith('s202-ann')
    writeFileSync(home('s202-ann', 'a.txt'), 'a')
    const held = [await batch(c, ['a.txt']), await batch(c, ['a.txt'])]
    expect(held.map(r => r.status)).toEqual([200, 200])
    const third = await batch(c, ['a.txt'])
    expect(third.status).toBe(503)
    expect((await third.json()).code).toBe('zip.busy')
    // read one to the end: its place comes back
    await held[0].arrayBuffer()
    const again = await batch(c, ['a.txt'])
    expect(again.status).toBe(200)
    await again.arrayBuffer()
    await held[1].body?.cancel()
    expect(zip.zipBusy()).toBe(0)
  })

  test('with every allowed download held unread, the backup still finishes', async () => {
    const big = randomBytes(3 * 1024 * 1024).toString('base64')
    const holders: Response[] = []
    const codecs = zip.ZIP_CODECS ?? Math.max(2, navigator.hardwareConcurrency || 2)
    for (let i = 0; i < codecs + 1; i++) {
      const name = `s202-h${i}`
      const c = await userWith(name)
      for (const f of ['a', 'b', 'c']) writeFileSync(home(name, `${f}.txt`), big)
      const r = await batch(c, ['a.txt', 'b.txt', 'c.txt'])
      if (r.status === 200) holders.push(r)
      else expect((await r.json()).code).toBe('zip.busy')
    }
    // never all codecs: one is always left
    expect(holders.length).toBeLessThan(codecs)
    try {
      const backup = await within(admin.json('POST', '/api/admin/backups'), 15_000)
      expect(backup === 'TIMEOUT' ? 'TIMEOUT' : backup.status).toBe(200)
    } finally {
      for (const r of holders) await r.body?.cancel()
    }
  }, 30_000)

  test('a reader that takes nothing for idleMs loses its download and its place', async () => {
    expect(zip.zipLimits).toBeDefined()
    zip.zipLimits.idleMs = 200
    const c = await userWith('s202-ida')
    writeFileSync(home('s202-ida', 'a.txt'), 'a')
    const r = await batch(c, ['a.txt'])
    expect(r.status).toBe(200)
    expect(zip.zipBusy()).toBe(1)
    await Bun.sleep(700)
    expect(zip.zipBusy()).toBe(0)
    await r.body?.cancel().catch(() => {})
  })
})

describe('one zip of a big folder does not stop the server', () => {
  test('timers keep running while a zip of 3,000 small files is built', async () => {
    const c = await userWith('s202-tree')
    for (let d = 0; d < 30; d++) {
      mkdirSync(home('s202-tree', 'tree', `d${d}`), { recursive: true })
      for (let f = 0; f < 100; f++) writeFileSync(home('s202-tree', 'tree', `d${d}`, `f${f}.txt`), 'x')
    }
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 5)
    const t0 = Date.now()
    const r = await batch(c, ['tree'])
    expect(r.status).toBe(200)
    await r.arrayBuffer()
    clearInterval(timer)
    const ms = Date.now() - t0
    // before the fix no timer ran at all until the zip was done
    expect(ticks).toBeGreaterThan(Math.min(5, ms / 50))
  }, 30_000)

  test('more entries than maxEntries: 413 zip.too-many for a download and for POST /api/zip', async () => {
    expect(zip.zipLimits).toBeDefined()
    zip.zipLimits.maxEntries = 10
    const c = await userWith('s202-many')
    mkdirSync(home('s202-many', 'many'))
    for (let f = 0; f < 20; f++) writeFileSync(home('s202-many', 'many', `f${f}.txt`), 'x')
    const r = await batch(c, ['many'])
    expect(r.status).toBe(413)
    expect((await r.json()).code).toBe('zip.too-many')
    const z = await c.json('POST', '/api/zip', { space: 'home', path: '/', items: ['many'] })
    expect(z.status).toBe(413)
    expect(z.data.code).toBe('zip.too-many')
    expect(readdirSync(home('s202-many')).filter(n => n.endsWith('.zip'))).toEqual([])
  })
})

describe('POST /api/unzip asks again after the virus scan', () => {
  let server: net.Server
  beforeAll(async () => {
    // answers OK, but only after a while
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
  const mkZip = (user: string) => writeFileSync(home(user, 'p.zip'), zipSync({ 'a.txt': new TextEncoder().encode('a'), 'b.txt': new TextEncoder().encode('b') }))

  test('an unzip scanned while it is allowed still works', async () => {
    const c = await userWith('s202-uok')
    mkZip('s202-uok')
    const r = await c.json('POST', '/api/unzip', { space: 'home', path: '/p.zip' })
    expect(r.status).toBe(200)
    expect(existsSync(home('s202-uok', 'p', 'a.txt'))).toBe(true)
  })

  test('rights lowered to read during the scan: 403, nothing lands', async () => {
    const c = await userWith('s202-udown')
    mkZip('s202-udown')
    const run = c.json('POST', '/api/unzip', { space: 'home', path: '/p.zip' })
    await Bun.sleep(150)
    expect((await admin.json('PUT', '/api/admin/users/s202-udown', { permissions: ['read'] })).status).toBe(200)
    const r = await run
    expect(r.status).toBe(403)
    expect(existsSync(home('s202-udown', 'p'))).toBe(false)
  })

  test('the account deleted during the scan: refused, nothing lands in its old home', async () => {
    const c = await userWith('s202-udel')
    mkZip('s202-udel')
    const run = c.json('POST', '/api/unzip', { space: 'home', path: '/p.zip' })
    await Bun.sleep(150)
    expect((await admin.json('DELETE', '/api/admin/users/s202-udel')).status).toBe(200)
    const r = await run
    expect([401, 403]).toContain(r.status)
    expect(existsSync(home('s202-udel', 'p'))).toBe(false)
  })
})
