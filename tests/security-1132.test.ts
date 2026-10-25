/**
 * The hardening items of 1.13.2 (from the 1.13 security audit): the logo value of a restored settings.json, the alert
 * webhook behind the password, the launcher hashing server.js before it starts a release, a cap on unfinished uploads
 * and counters instead of a disk scan per announce, the password lockout of a whole share link, and two ways to get
 * more out of a share link than it allows. Runs in-process on the same app as api.test.ts; every user here starts with "s132-".
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import './in-process-env'

let app: any
let config: typeof import('../src/config').config
let paths: typeof import('../src/config').paths
let settings: typeof import('../src/settings').settings
let alerts: typeof import('../src/alerts')
let uploads: typeof import('../src/uploads')
let updater: typeof import('../src/updater')
let backup: typeof import('../src/backup')

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

const ROOT = resolve(import.meta.dir, '..')
const PW = 'harbor-lamp-42'
const ADMIN_PW = process.env.ADMIN_PASSWORD!
const admin = new Client()
const home = (user: string, ...p: string[]) => join(process.env.STORAGE_DIR!, 'users', user, ...p)
const scratch = () => mkdtempSync(join(process.env.DATA_DIR!, '..', 's132-'))
const OCTET = { 'content-type': 'application/octet-stream' }

async function userWith(username: string, permissions: string[]) {
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', permissions, publicPermissions: [] })
  expect(r.status).toBe(200)
  return new Client().login(username, PW)
}

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config, paths } = await import('../src/config'))
  ;({ settings } = await import('../src/settings'))
  alerts = await import('../src/alerts')
  uploads = await import('../src/uploads')
  updater = await import('../src/updater')
  backup = await import('../src/backup')
  await admin.login('admin', ADMIN_PW)
})
afterEach(() => {
  settings.update({ logo: null })
})
afterAll(async () => {
  await alerts.alertsIdle()
  alerts.resetAlerts()
})

// ───────────── 1. the logo value ─────────────

describe('settings.logo from a restored backup', () => {
  // join(branding, 'logo.' + '/../../canary') is DATA_DIR/canary: the value reaches out of the branding folder
  const canary = () => join(config.dataDir, 's132-canary.txt')

  test('a value that is not <ext>:<digits> is not served and not deleted', async () => {
    writeFileSync(canary(), 'KEEP-ME')
    settings.update({ logo: '/../../s132-canary.txt:1' })
    const r = await app.handle(new Request('http://localhost/api/branding/logo'))
    expect(r.status).toBe(404)
    expect(await r.text()).not.toContain('KEEP-ME')
    expect((await admin.json('DELETE', '/api/admin/logo')).status).toBe(200)
    expect(readFileSync(canary(), 'utf8')).toBe('KEEP-ME')

    settings.update({ logo: '/../../s132-canary.txt:1' })
    const put = await admin.raw('PUT', '/api/admin/logo', new Uint8Array([1, 2, 3]), { 'content-type': 'image/png' })
    expect(put.status).toBe(200)
    expect(readFileSync(canary(), 'utf8')).toBe('KEEP-ME')
    rmSync(canary(), { force: true })
    await admin.json('DELETE', '/api/admin/logo')
  })

  test('a good value still works', async () => {
    expect((await admin.raw('PUT', '/api/admin/logo', new Uint8Array([1, 2, 3]), { 'content-type': 'image/png' })).status).toBe(200)
    expect(settings.get().logo).toMatch(/^png:\d+$/)
    expect((await app.handle(new Request('http://localhost/api/branding/logo'))).status).toBe(200)
    expect((await admin.json('DELETE', '/api/admin/logo')).status).toBe(200)
  })

  test('a backup whose settings carry such a value is refused before anything is restored', () => {
    const dir = scratch()
    try {
      writeFileSync(join(dir, 'users.json'), JSON.stringify({ users: [{ username: 'x', role: 'admin', passwordHash: 'x' }] }))
      for (const logo of ['/../../secret.key:1', 'png:1/../x', '..:1', 'png:', 'exe:5', 5]) {
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ logo }))
        expect(() => backup.checkData(dir)).toThrow()
      }
      for (const logo of ['png:1700000000000', 'jpeg:1', 'svg:2', 'gif:3', 'webp:4', null]) {
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ logo }))
        expect(() => backup.checkData(dir)).not.toThrow()
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// ───────────── 2. alerts behind the password ─────────────

describe('the alert webhook needs the admin password', () => {
  let hook: ReturnType<typeof Bun.serve>
  let bodies: string[] = []
  beforeAll(() => { hook = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async req => { bodies.push(await req.text()); return new Response('ok') } }) })
  afterAll(async () => {
    await admin.json('PUT', '/api/admin/settings', { alerts: { webhookUrl: null }, mail: { host: null }, password: ADMIN_PW })
    await alerts.alertsIdle()
    await hook.stop(true)
  })

  test('without it the webhook is not changed; with it it is, and the admins hear of the change', async () => {
    const url = `http://127.0.0.1:${hook.port}/s132/send`
    const before = JSON.stringify((await admin.json('GET', '/api/admin/settings')).data.alerts)
    const denied = await admin.json('PUT', '/api/admin/settings', { alerts: { webhookUrl: url } })
    expect(denied.status).toBe(403)
    expect(JSON.stringify((await admin.json('GET', '/api/admin/settings')).data.alerts)).toBe(before)

    await alerts.alertsIdle()
    alerts.resetAlerts()
    bodies = []
    expect((await admin.json('PUT', '/api/admin/settings', { alerts: { webhookUrl: url }, password: ADMIN_PW })).status).toBe(200)
    await alerts.alertsIdle()
    expect(bodies.length).toBe(1)
    expect(bodies[0]).toContain('alerts.webhookUrl')
    expect(bodies[0]).not.toContain('s132/send')

    // a mail change is announced the same way
    alerts.resetAlerts()
    bodies = []
    expect((await admin.json('PUT', '/api/admin/settings', { mail: { host: 'smtp.example.com' }, password: ADMIN_PW })).status).toBe(200)
    await alerts.alertsIdle()
    expect(bodies.length).toBe(1)
    expect(bodies[0]).toContain('mail.host')
  })
})

// ───────────── 3. the launcher hashes server.js ─────────────

describe('the launcher checks server.js against the hash recorded at install', () => {
  const sha = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex')
  const NAME = '9.9.7-s132hash'

  /** a release folder that only writes a marker file when started, and a state.json that points at it */
  function setup(data: string, state: Record<string, unknown>, serverJs: string) {
    const release = join(data, 'app', 'releases', NAME)
    mkdirSync(join(release, 'web'), { recursive: true })
    writeFileSync(join(release, 'server.js'), serverJs)
    writeFileSync(join(release, 'web', 'index.html'), '<html></html>')
    writeFileSync(join(release, 'manifest.json'), JSON.stringify({ name: 'file-center', version: '9.9.7', builtAt: '', files: {} }))
    writeFileSync(join(data, 'app', 'state.json'), JSON.stringify({ schema: 1, current: NAME, history: [], pending: null, last: null, ...state }))
  }
  const writer = (marker: string) => `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000)`

  async function runLauncher(state: (js: string) => Record<string, unknown>, tamper: boolean) {
    const dir = scratch()
    const data = join(dir, 'data')
    const marker = join(dir, 'started')
    const js = writer(marker)
    setup(data, state(js), tamper ? js + '\n// changed after install' : js)
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
    const port = probe.port!
    await probe.stop(true)
    const launcher = Bun.spawn([process.execPath, join(ROOT, 'src', 'launcher.ts')], {
      cwd: ROOT, stdout: 'ignore', stderr: 'ignore',
      env: {
        PATH: process.env.PATH!, HOME: dir, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1',
        STORAGE_DIR: join(dir, 'storage'), DATA_DIR: data, ADMIN_PASSWORD: 'x-test-pass-1', MIN_FREE_SPACE: '0',
        FC_HEALTH_TIMEOUT_MS: '60000', FC_STABLE_MS: '500', UPDATE_SOURCE: 'off',
      },
    })
    const stateOf = () => { try { return JSON.parse(readFileSync(join(data, 'app', 'state.json'), 'utf8')) } catch { return null } }
    try {
      const until = Date.now() + 40_000
      while (Date.now() < until && !existsSync(marker) && stateOf()?.current !== null) await Bun.sleep(100)
      // the launcher has decided by now; give a wrongly started server.js a moment to leave its mark
      await Bun.sleep(500)
      const logFile = join(data, 'logs', 'launcher.log')
      return { started: existsSync(marker), state: stateOf(), log: existsSync(logFile) ? readFileSync(logFile, 'utf8') : '' }
    } finally {
      launcher.kill('SIGTERM')
      await Promise.race([launcher.exited, Bun.sleep(15_000)])
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('a changed server.js is not started: builtin runs and the reason is in the launcher log', async () => {
    const r = await runLauncher(js => ({ serverHashes: { [NAME]: sha(js) } }), true)
    expect(r.started).toBe(false)
    expect(r.state.current).toBeNull()
    expect(r.state.last).toMatchObject({ dir: NAME, ok: false, code: 'update.server-changed' })
    expect(r.log).toContain('server-changed')
  }, 60_000)

  test('the file that was installed starts, and so does a release with no hash recorded (installed by an older version)', async () => {
    const same = await runLauncher(js => ({ serverHashes: { [NAME]: sha(js) } }), false)
    expect(same.started).toBe(true)
    expect(same.state.current).toBe(NAME)
    const old = await runLauncher(() => ({}), false)
    expect(old.started).toBe(true)
    expect(old.state.current).toBe(NAME)
  }, 90_000)

  test('a rollback to a history release checks the hash too', async () => {
    const stateFile = join(config.dataDir, 'app', 'state.json')
    const had = existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : null
    const release = join(config.dataDir, 'app', 'releases', NAME)
    try {
      setup(config.dataDir, { current: null, history: [NAME], serverHashes: { [NAME]: sha('something else') } }, 'console.log(1)')
      await expect(updater.rollbackTo(NAME)).rejects.toMatchObject({ status: 400 })
      writeFileSync(stateFile, JSON.stringify({ schema: 1, current: null, history: [NAME], pending: null, last: null, serverHashes: { [NAME]: sha('console.log(1)') } }))
      expect((await updater.rollbackTo(NAME)).version).toBe('9.9.7')
    } finally {
      rmSync(release, { recursive: true, force: true })
      if (had === null) rmSync(stateFile, { force: true }); else writeFileSync(stateFile, had)
    }
  })
})

// ───────────── 4. unfinished uploads ─────────────

describe('unfinished uploads', () => {
  test('one owner holds at most UPLOAD_MAX_PENDING; finishing or cancelling gives a place back', async () => {
    const c = await userWith('s132-pend', ['read', 'write', 'upload'])
    const was = config.uploadMaxPending
    ;(config as any).uploadMaxPending = 3
    try {
      const announce = (name: string) => c.json('POST', '/api/upload', { space: 'home', path: '/', name, size: 1 })
      const ids: string[] = []
      for (let i = 0; i < 3; i++) {
        const r = await announce(`p${i}.bin`)
        expect(r.status).toBe(200)
        ids.push(r.data.id)
      }
      const full = await announce('p3.bin')
      expect([full.status, full.data.code]).toEqual([429, 'upload.too-many-pending'])
      // another owner is not held back
      const other = await userWith('s132-pend2', ['read', 'write', 'upload'])
      expect((await other.json('POST', '/api/upload', { space: 'home', path: '/', name: 'o.bin', size: 1 })).status).toBe(200)
      expect((await c.json('DELETE', `/api/upload/${ids[0]}`)).status).toBe(200)
      const again = await announce('p3.bin')
      expect(again.status).toBe(200)
      // finishing one frees a place as well
      await c.raw('PUT', `/api/upload/${again.data.id}/0`, new Uint8Array([7]), OCTET)
      expect((await c.json('POST', `/api/upload/${again.data.id}/complete`)).status).toBe(200)
      expect((await announce('p4.bin')).status).toBe(200)
      expect((await announce('p5.bin')).status).toBe(429)
    } finally {
      ;(config as any).uploadMaxPending = was
    }
  })

  test('the default is 500', () => {
    expect(config.uploadMaxPending).toBe(500)
  })

  test('an announce on an upload-request link reads no meta.json: the counters answer', async () => {
    const owner = await userWith('s132-inbox', ['read', 'write', 'upload', 'download', 'share'])
    mkdirSync(home('s132-inbox', 'in'), { recursive: true })
    const made = await owner.json('POST', '/api/shares', { space: 'home', path: '/in', days: 7, kind: 'upload' })
    const v = new Client()
    const a = await v.json('POST', `/api/s/${made.data.token}/upload`, { name: 'a.bin', size: 5 })
    expect(a.status).toBe(200)
    const id = a.data.id as string
    expect(uploads.shareUploadLoad(made.data.share.id, '')).toMatchObject({ count: 1, bytes: 5 })
    // the meta.json is gone from the disk: only a counter can still know about the upload
    const metaText = readFileSync(join(paths.tmp, id, 'meta.json'), 'utf8')
    rmSync(join(paths.tmp, id, 'meta.json'))
    expect(uploads.shareUploadLoad(made.data.share.id, '').count).toBe(1)
    writeFileSync(join(paths.tmp, id, 'meta.json'), metaText)
    // a second announce counts both
    const b = await v.json('POST', `/api/s/${made.data.token}/upload`, { name: 'b.bin', size: 7 })
    expect(b.status).toBe(200)
    expect(uploads.shareUploadLoad(made.data.share.id, '')).toMatchObject({ count: 2, bytes: 12 })
    expect((await v.json('DELETE', `/api/s/${made.data.token}/upload/${b.data.id}`)).status).toBe(200)
    expect(uploads.shareUploadLoad(made.data.share.id, '')).toMatchObject({ count: 1, bytes: 5 })
    // leave nothing counted for the next file (every request here comes from one address)
    expect((await v.json('DELETE', `/api/s/${made.data.token}/upload/${id}`)).status).toBe(200)
    expect(uploads.shareUploadLoad(made.data.share.id, '')).toMatchObject({ count: 0, bytes: 0, byIp: 0 })
  })
})

// ───────────── 5. password lockout of a whole link ─────────────

describe('a share link with a password locks across addresses', () => {
  test('50 wrong passwords from 50 addresses lock the link, even for the right password; another link is free', async () => {
    const saved = config.trustProxy
    ;(config as any).trustProxy = 'true'
    try {
      const owner = await userWith('s132-locker', ['read', 'write', 'upload', 'download', 'share'])
      writeFileSync(home('s132-locker', 'f.txt'), 'x')
      const mk = async () => (await owner.json('POST', '/api/shares', { space: 'home', path: '/f.txt', days: 7, password: 'open-sesame-1' })).data.token as string
      const [t, t2] = [await mk(), await mk()]
      const from = (n: number) => ({ 'x-forwarded-for': `10.9.${Math.floor(n / 250)}.${(n % 250) + 1}` })
      const v = new Client()
      for (let i = 0; i < 49; i++) expect((await v.json('POST', `/api/s/${t}/unlock`, { password: 'wrong-guess' }, from(i))).status).toBe(403)
      // still open for a new address with the right password
      expect((await v.json('POST', `/api/s/${t}/unlock`, { password: 'open-sesame-1' }, from(100))).status).toBe(200)
      expect((await v.json('POST', `/api/s/${t}/unlock`, { password: 'wrong-guess' }, from(49))).status).toBe(403)
      const locked = await v.json('POST', `/api/s/${t}/unlock`, { password: 'open-sesame-1' }, from(200))
      expect([locked.status, locked.data.code]).toEqual([429, 'auth.confirm-locked'])
      expect((await v.json('POST', `/api/s/${t2}/unlock`, { password: 'open-sesame-1' }, from(201))).status).toBe(200)
    } finally {
      ;(config as any).trustProxy = saved
    }
  }, 60_000)
})

// ───────────── 6. what a share link counts ─────────────

function png(w: number, h: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length)
    const dv = new DataView(out.buffer)
    dv.setUint32(0, data.length)
    out.set(new TextEncoder().encode(type), 4)
    out.set(data, 8)
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
    return out
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2
  const raw = new Uint8Array((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * (w * 3 + 1) + 1 + x * 3; raw[i] = x % 256; raw[i + 1] = y % 256; raw[i + 2] = 128 }
  return Buffer.concat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())])
}

describe('what a share link counts', () => {
  const haveVips = !!Bun.which('vipsthumbnail') && !!Bun.which('vipsheader')

  test.skipIf(!haveVips)('the 1024 px picture of a link with a download limit takes a download; 256 px does not', async () => {
    const owner = await userWith('s132-thumb', ['read', 'write', 'upload', 'download', 'share'])
    mkdirSync(home('s132-thumb', 'pics'), { recursive: true })
    writeFileSync(home('s132-thumb', 'pics', 'a.png'), png(1200, 900))
    const made = await owner.json('POST', '/api/shares', { space: 'home', path: '/pics', days: 7, maxDownloads: 1 })
    const anon = new Client()
    const get = (size: number) => anon.raw('GET', `/api/s/${made.data.token}/thumb?path=%2Fa.png&size=${size}`)
    expect((await get(256)).status).toBe(200)
    expect((await get(256)).status).toBe(200)
    expect((await get(1024)).status).toBe(200)
    expect((await get(1024)).status).toBe(404)
    expect((await owner.json('GET', '/api/shares')).data.shares.find((s: any) => s.id === made.data.share.id).downloads).toBe(1)
    // a link without a limit gives the large picture as often as asked
    const free = await owner.json('POST', '/api/shares', { space: 'home', path: '/pics', days: 7 })
    for (let i = 0; i < 2; i++) expect((await anon.raw('GET', `/api/s/${free.data.token}/thumb?path=%2Fa.png&size=1024`)).status).toBe(200)
  })

  test('completing an upload again does not count or announce it again', async () => {
    const owner = await userWith('s132-twice', ['read', 'write', 'upload', 'download', 'share'])
    mkdirSync(home('s132-twice', 'in'), { recursive: true })
    const made = await owner.json('POST', '/api/shares', { space: 'home', path: '/in', days: 7, kind: 'upload', maxFiles: 5 })
    const t = made.data.token
    const v = new Client()
    const a = await v.json('POST', `/api/s/${t}/upload`, { name: 'once.txt', size: 3 })
    expect((await v.raw('PUT', `/api/s/${t}/upload/${a.data.id}/0`, new Uint8Array([1, 2, 3]), OCTET)).status).toBe(200)
    const first = await v.json('POST', `/api/s/${t}/upload/${a.data.id}/complete`)
    expect(first.status).toBe(200)
    const received = async () => (await owner.json('GET', '/api/shares')).data.shares.find((s: any) => s.id === made.data.share.id).uploadedFiles
    expect(await received()).toBe(1)
    const notes = JSON.stringify((await owner.json('GET', '/api/notifications')).data)
    for (let i = 0; i < 3; i++) {
      const again = await v.json('POST', `/api/s/${t}/upload/${a.data.id}/complete`)
      expect(again.status).toBe(200)
      expect(again.data).toEqual(first.data)
    }
    expect(await received()).toBe(1)
    expect(JSON.stringify((await owner.json('GET', '/api/notifications')).data)).toBe(notes)
  })
})
