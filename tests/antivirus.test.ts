/**
 * Virus scanning (src/antivirus.ts): a stand-in clamd (a local TCP server that speaks INSTREAM and PING) stands in for
 * ClamAV. Covers the protocol (chunks, EICAR), the three entry points (chunked uploads, upload-request links, WebDAV PUT),
 * the unreachable / timeout / too-big policies, and that an infected file never lands in the storage. In-process on the
 * shared app (see in-process-env.ts); users start with "av-".
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import './in-process-env'

let app: any
let config: typeof import('../src/config').config
let paths: typeof import('../src/config').paths
let settings: typeof import('../src/settings').settings
let av: typeof import('../src/antivirus')

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'

// ───────────── a stand-in clamd ─────────────

type Mode = 'normal' | 'hang' | 'error'
const fake = { mode: 'normal' as Mode, scans: 0, bytes: 0, chunks: 0, pings: 0 }

function clamd(): Promise<net.Server> {
  const server = net.createServer(sock => {
    let buf = Buffer.alloc(0)
    let command: string | null = null
    const body: Buffer[] = []
    sock.on('error', () => {})
    sock.on('data', d => {
      buf = Buffer.concat([buf, d])
      if (command === null) {
        const nul = buf.indexOf(0)
        if (nul < 0) return
        command = buf.subarray(0, nul).toString()
        buf = buf.subarray(nul + 1)
        if (command === 'zPING') { fake.pings++; sock.end('PONG\0'); return }
        if (command !== 'zINSTREAM') { sock.end('UNKNOWN COMMAND\0'); return }
        fake.scans++
      }
      // INSTREAM: [4 bytes length][data] ... [0000]
      for (;;) {
        if (buf.length < 4) return
        const len = buf.readUInt32BE(0)
        if (len === 0) {
          const data = Buffer.concat(body)
          fake.bytes += data.length
          if (fake.mode === 'hang') return
          if (fake.mode === 'error') { sock.end('INSTREAM size limit exceeded. ERROR\0'); return }
          sock.end(data.includes(Buffer.from(EICAR)) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0')
          return
        }
        if (buf.length < 4 + len) return
        fake.chunks++
        body.push(Buffer.from(buf.subarray(4, 4 + len)))
        buf = buf.subarray(4 + len)
      }
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)))
}

const scratch = mkdtempSync(join(tmpdir(), 'fc-av-'))
let server: net.Server
let port = 0

// ───────────── a client ─────────────

class Client {
  jar = new Map<string, string>()
  csrf = ''
  async raw(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers }
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    if (cookie) h.cookie = cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    let payload: any = body
    if (body !== undefined && !(body instanceof Uint8Array)) {
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
const admin = new Client()
const home = (user: string, ...p: string[]) => join(process.env.STORAGE_DIR!, 'users', user, ...p)
const code = (r: { status: number; data: any }) => ({ status: r.status, code: r.data?.code })

async function userWith(username: string) {
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', permissions: ['read', 'write', 'upload', 'download', 'share'], publicPermissions: [] })
  expect(r.status).toBe(200)
  mkdirSync(home(username), { recursive: true })
  return new Client().login(username, PW)
}

/** announce, send in chunks, complete */
async function upload(c: Client, name: string, data: Uint8Array | string, dir = '/') {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const a = await c.json('POST', '/api/upload', { space: 'home', path: dir, name, size: bytes.length })
  if (a.status !== 200) return a
  for (let i = 0; i < a.data.total; i++) {
    const part = bytes.subarray(i * a.data.chunkSize, (i + 1) * a.data.chunkSize)
    expect((await c.raw('PUT', `/api/upload/${a.data.id}/${i}`, part, { 'content-type': 'application/octet-stream' })).status).toBe(200)
  }
  return c.json('POST', `/api/upload/${a.data.id}/complete`)
}

const scanOn = (extra: Record<string, unknown> = {}) =>
  settings.update({ antivirus: { enabled: true, host: '127.0.0.1', port, timeoutSeconds: 5, maxScanMb: 25, onErrorLinks: 'reject', onErrorUsers: 'allow', ...extra } as any })

/** only what the scanner needs to be reached: every policy stays at its default */
const scanDefaults = (extra: Record<string, unknown> = {}) =>
  settings.update({ antivirus: { enabled: true, host: '127.0.0.1', port, timeoutSeconds: 5, ...extra } as any })

const quarantined = () => (existsSync(paths.quarantine) ? readdirSync(paths.quarantine) : [])
const clearQuarantine = () => { for (const m of av.listQuarantine()) av.deleteQuarantined(m.id) }
const auditText = () => (existsSync(paths.audit) ? readFileSync(paths.audit, 'utf8') : '')
const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? filesUnder(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []))

let user: Client

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config, paths } = await import('../src/config'))
  ;({ settings } = await import('../src/settings'))
  av = await import('../src/antivirus')
  server = await clamd()
  port = (server.address() as net.AddressInfo).port
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
  user = await userWith('av-user')
})

afterAll(() => { server.close(); rmSync(scratch, { recursive: true, force: true }) })

afterEach(() => {
  settings.update({ antivirus: undefined })
  fake.mode = 'normal'
  clearQuarantine()
  av.lastCheck.ok = null
})

describe('scanning is off by default', () => {
  test('an EICAR upload is stored as it is when scanning is not enabled', async () => {
    expect(config.clamavEnabled).toBe(false)
    const before = fake.scans
    const r = await upload(user, 'off.txt', EICAR)
    expect(r.status).toBe(200)
    expect(existsSync(home('av-user', 'off.txt'))).toBe(true)
    expect(fake.scans).toBe(before)
    // the only EICAR the storage may hold is this one (scanning was off); later tests look for any other
    rmSync(home('av-user', 'off.txt'))
  })
})

describe('the INSTREAM client', () => {
  test('a clean file is sent in length-prefixed chunks and answered OK', async () => {
    scanOn()
    const f = join(scratch, 'av-clean.bin')
    writeFileSync(f, Buffer.alloc(300_000, 7))
    const chunks = fake.chunks
    const bytes = fake.bytes
    expect(await av.scanFile(f)).toEqual({ status: 'clean' })
    expect(fake.bytes - bytes).toBe(300_000)
    // 64 KiB per chunk: 300000 bytes is 5 chunks
    expect(fake.chunks - chunks).toBe(5)
  })

  test('EICAR is reported with its signature', async () => {
    scanOn()
    const f = join(scratch, 'av-eicar.bin')
    writeFileSync(f, EICAR)
    expect(await av.scanFile(f)).toEqual({ status: 'infected', signature: 'Eicar-Test-Signature' })
  })

  test('an ERROR answer is an error, not a clean file', async () => {
    scanOn()
    fake.mode = 'error'
    const f = join(scratch, 'av-err.bin')
    writeFileSync(f, 'x')
    expect(await av.scanFile(f)).toEqual({ status: 'error', reason: 'clamd-error' })
  })

  test('no answer within the timeout is a timeout', async () => {
    scanOn({ timeoutSeconds: 0.3 })
    fake.mode = 'hang'
    const f = join(scratch, 'av-hang.bin')
    writeFileSync(f, 'x')
    const t0 = Date.now()
    expect(await av.scanFile(f)).toEqual({ status: 'error', reason: 'timeout' })
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  test('a closed port is unreachable', async () => {
    scanOn({ port: 1 })
    const f = join(scratch, 'av-down.bin')
    writeFileSync(f, 'x')
    expect(await av.scanFile(f)).toEqual({ status: 'error', reason: 'unreachable' })
  })

  test('a file over the scan size is never sent', async () => {
    scanOn({ maxScanMb: 0.001 })
    const f = join(scratch, 'av-big.bin')
    writeFileSync(f, Buffer.alloc(5000, 1))
    const scans = fake.scans
    expect(await av.scanFile(f)).toEqual({ status: 'error', reason: 'too-big' })
    expect(fake.scans).toBe(scans)
  })
})

describe('admin: test connection, settings, warning', () => {
  test('the test button runs EICAR through INSTREAM', async () => {
    scanOn()
    const r = await admin.json('POST', '/api/admin/antivirus/test')
    expect(r.status).toBe(200)
    expect(r.data).toMatchObject({ ok: true, signature: 'Eicar-Test-Signature' })
  })

  test('the test says why it failed: unreachable, timeout', async () => {
    scanOn({ port: 1 })
    expect(code(await admin.json('POST', '/api/admin/antivirus/test'))).toEqual({ status: 502, code: 'antivirus.test-unreachable' })
    scanOn({ timeoutSeconds: 0.3 })
    fake.mode = 'hang'
    expect(code(await admin.json('POST', '/api/admin/antivirus/test'))).toEqual({ status: 504, code: 'antivirus.test-timeout' })
  })

  test('only an admin sees the scanner, the quarantine and can test it', async () => {
    for (const [m, p] of [['GET', '/api/admin/antivirus'], ['POST', '/api/admin/antivirus/test'], ['GET', '/api/admin/antivirus/quarantine']] as const) {
      expect([401, 403]).toContain((await user.json(m, p)).status)
    }
  })

  test('the settings are saved with the admin password, validated, and shown with their source', async () => {
    const body = { antivirus: { enabled: true, host: '127.0.0.1', port, timeoutSeconds: 5, maxScanMb: 10, onErrorLinks: 'allow', onErrorUsers: 'reject' } }
    expect((await admin.json('PUT', '/api/admin/settings', body)).status).toBe(403)
    const ok = await admin.json('PUT', '/api/admin/settings', { ...body, password: process.env.ADMIN_PASSWORD })
    expect(ok.status).toBe(200)
    expect(ok.data.antivirus.enabled).toEqual({ value: true, source: 'web' })
    expect(ok.data.antivirus.onErrorUsers.value).toBe('reject')
    for (const wrong of [{ port: 0 }, { host: 'a b' }, { host: '' }, { onErrorLinks: 'maybe' }, { timeoutSeconds: 0 }, { unknown: 1 }]) {
      expect((await admin.json('PUT', '/api/admin/settings', { antivirus: wrong, password: process.env.ADMIN_PASSWORD })).status).toBe(400)
    }
    const reset = await admin.json('PUT', '/api/admin/settings', { antivirus: { enabled: null, host: null, port: null, timeoutSeconds: null, maxScanMb: null, onErrorLinks: null, onErrorUsers: null }, password: process.env.ADMIN_PASSWORD })
    expect(reset.data.antivirus.enabled).toEqual({ value: false, source: 'default' })
  })

  test('enabled but unreachable shows a config warning; reachable or off does not', async () => {
    scanOn({ port: 1 })
    await av.pingClamd()
    let w = await admin.json('GET', '/api/admin/config-warnings')
    expect(JSON.stringify(w.data)).toContain('admin.config-antivirus-unreachable')
    scanOn()
    await av.pingClamd()
    w = await admin.json('GET', '/api/admin/config-warnings')
    expect(JSON.stringify(w.data)).not.toContain('admin.config-antivirus-unreachable')
    scanOn({ port: 1, enabled: false })
    av.lastCheck.ok = false
    w = await admin.json('GET', '/api/admin/config-warnings')
    expect(JSON.stringify(w.data)).not.toContain('admin.config-antivirus-unreachable')
  })
})

describe('chunked uploads', () => {
  test('a clean multi-chunk file lands in the storage', async () => {
    scanOn()
    const data = new Uint8Array(1_500_000).fill(65)
    const r = await upload(user, 'clean.bin', data)
    expect(r.status).toBe(200)
    expect(readFileSync(home('av-user', 'clean.bin')).length).toBe(1_500_000)
  })

  test('an infected file never lands in the storage: it is quarantined, audited and the uploader gets the catalog error', async () => {
    scanOn()
    const r = await upload(user, 'virus.txt', EICAR)
    expect(code(r)).toEqual({ status: 422, code: 'antivirus.infected' })
    expect(existsSync(home('av-user', 'virus.txt'))).toBe(false)
    // nowhere in the storage or in the unfinished uploads, whatever its name
    for (const f of [...filesUnder(config.storageDir), ...filesUnder(paths.tmp)]) expect(readFileSync(f).includes(Buffer.from(EICAR))).toBe(false)
    // the quarantine holds it, outside the storage
    const list = (await admin.json('GET', '/api/admin/antivirus/quarantine')).data.items
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'virus.txt', signature: 'Eicar-Test-Signature', by: 'av-user', via: 'upload' })
    expect(JSON.stringify(list)).not.toContain(paths.quarantine)
    expect(quarantined().length).toBe(2)
    expect(paths.quarantine.startsWith(config.storageDir)).toBe(false)
    expect(auditText()).toContain('"action":"virus-found"')
  })

  test('the quarantine is reachable from no file route', async () => {
    scanOn()
    await upload(user, 'v.txt', EICAR)
    const id = av.listQuarantine()[0].id
    for (const p of [`/api/download?space=home&path=${encodeURIComponent(`/../../system/quarantine/${id}.bin`)}`, `/${id}.bin`, `/api/admin/antivirus/quarantine/${id}`]) {
      expect((await user.raw('GET', p)).status).not.toBe(200)
    }
  })

  test('the admin can delete a quarantined file, or release it to where it was going', async () => {
    scanOn()
    await upload(user, 'a.txt', EICAR)
    await upload(user, 'b.txt', EICAR)
    const [first, second] = av.listQuarantine()
    expect((await admin.json('DELETE', `/api/admin/antivirus/quarantine/${first.id}`)).status).toBe(200)
    expect((await admin.json('DELETE', `/api/admin/antivirus/quarantine/${first.id}`)).status).toBe(404)
    expect((await admin.json('DELETE', '/api/admin/antivirus/quarantine/..%2f..%2fusers')).status).toBe(404)
    const rel = await admin.json('POST', `/api/admin/antivirus/quarantine/${second.id}/release`)
    expect(rel.status).toBe(200)
    expect(readFileSync(home('av-user', rel.data.name), 'utf8')).toBe(EICAR)
    expect(av.listQuarantine()).toHaveLength(0)
    expect(auditText()).toContain('"action":"quarantine-release"')
  })

  test('a signed-in user is let through when clamd is down (policy allow), and refused when the policy says reject', async () => {
    scanOn({ port: 1 })
    expect((await upload(user, 'allowed.txt', 'hello')).status).toBe(200)
    expect(existsSync(home('av-user', 'allowed.txt'))).toBe(true)
    scanOn({ port: 1, onErrorUsers: 'reject' })
    expect(code(await upload(user, 'refused.txt', 'hello'))).toEqual({ status: 503, code: 'antivirus.unavailable' })
    expect(existsSync(home('av-user', 'refused.txt'))).toBe(false)
  })

  test('a timeout follows the same policy', async () => {
    scanOn({ timeoutSeconds: 0.3, onErrorUsers: 'reject' })
    fake.mode = 'hang'
    expect(code(await upload(user, 'slow.txt', 'hello'))).toEqual({ status: 503, code: 'antivirus.unavailable' })
    expect(existsSync(home('av-user', 'slow.txt'))).toBe(false)
  })

  test('a file over the scan size follows the policy too (413 when refused)', async () => {
    // onErrorUsers no longer covers big files: onTooBigUsers does (updated with the split of the two decisions)
    scanOn({ maxScanMb: 0.001, onTooBigUsers: 'reject' })
    expect(code(await upload(user, 'huge.bin', new Uint8Array(5000)))).toEqual({ status: 413, code: 'antivirus.too-big' })
    scanOn({ maxScanMb: 0.001 })
    expect((await upload(user, 'huge-ok.bin', new Uint8Array(5000))).status).toBe(200)
  })

  test('a refused upload gives back its holds (the same user can upload again)', async () => {
    scanOn()
    for (let i = 0; i < 3; i++) expect((await upload(user, `again${i}.txt`, EICAR)).status).toBe(422)
    expect((await upload(user, 'after.txt', 'fine')).status).toBe(200)
  })
})

describe('upload-request links', () => {
  async function linkFor(c: Client, folder: string) {
    mkdirSync(home('av-user', folder), { recursive: true })
    const r = await c.json('POST', '/api/shares', { space: 'home', path: `/${folder}`, days: 7, kind: 'upload' })
    expect(r.status).toBe(200)
    return r.data.token as string
  }
  async function send(v: Client, token: string, name: string, data: string) {
    const bytes = new TextEncoder().encode(data)
    const a = await v.json('POST', `/api/s/${token}/upload`, { name, size: bytes.length })
    if (a.status !== 200) return a
    expect((await v.raw('PUT', `/api/s/${token}/upload/${a.data.id}/0`, bytes, { 'content-type': 'application/octet-stream' })).status).toBe(200)
    return v.json('POST', `/api/s/${token}/upload/${a.data.id}/complete`)
  }

  test('a visitor sending EICAR is refused, nothing is stored or counted', async () => {
    scanOn()
    const token = await linkFor(user, 'inbox-virus')
    const visitor = new Client()
    const r = await send(visitor, token, 'evil.exe', EICAR)
    expect(code(r)).toEqual({ status: 422, code: 'antivirus.infected' })
    expect(readdirSync(home('av-user', 'inbox-virus'))).toEqual([])
    const shares = (await user.json('GET', '/api/shares')).data.shares
    expect(shares.find((s: any) => s.kind === 'upload' && s.path === '/inbox-virus').uploadedFiles).toBe(0)
    const item = av.listQuarantine()[0]
    expect(item).toMatchObject({ name: 'evil.exe', via: 'link' })
    expect(item.by.startsWith('share:')).toBe(true)
    // a clean file through the same link goes on to work
    expect((await send(visitor, token, 'ok.txt', 'hello')).status).toBe(200)
    expect(readdirSync(home('av-user', 'inbox-virus'))).toEqual(['ok.txt'])
  })

  test('with clamd down an upload link refuses by default, and accepts when the policy is allow', async () => {
    scanOn({ port: 1 })
    const token = await linkFor(user, 'inbox-down')
    const visitor = new Client()
    expect(code(await send(visitor, token, 'a.txt', 'hello'))).toEqual({ status: 503, code: 'antivirus.unavailable' })
    expect(readdirSync(home('av-user', 'inbox-down'))).toEqual([])
    scanOn({ port: 1, onErrorLinks: 'allow' })
    expect((await send(visitor, token, 'b.txt', 'hello')).status).toBe(200)
    expect(readdirSync(home('av-user', 'inbox-down'))).toEqual(['b.txt'])
  })
})

describe('WebDAV PUT', () => {
  test('an infected PUT is refused and never stored; a clean one works', async () => {
    scanOn()
    const made = await user.json('POST', '/api/me/app-passwords', { name: 'dav', scope: 'readwrite', password: PW })
    expect(made.status).toBe(200)
    const auth = `Basic ${Buffer.from(`av-user:${made.data.secret}`).toString('base64')}`
    const put = (name: string, body: string) => app.handle(new Request(`http://localhost/dav/home/${name}`, { method: 'PUT', headers: { authorization: auth }, body })) as Promise<Response>
    const evil = await put('dav-virus.txt', EICAR)
    expect(evil.status).toBe(422)
    expect(existsSync(home('av-user', 'dav-virus.txt'))).toBe(false)
    expect(av.listQuarantine()[0]).toMatchObject({ name: 'dav-virus.txt', via: 'webdav', by: 'av-user' })
    // it did not replace an existing file either
    writeFileSync(home('av-user', 'dav-keep.txt'), 'original')
    expect((await put('dav-keep.txt', EICAR)).status).toBe(422)
    expect(readFileSync(home('av-user', 'dav-keep.txt'), 'utf8')).toBe('original')
    expect((await put('dav-clean.txt', 'hello')).status).toBe(201)
    expect(readFileSync(home('av-user', 'dav-clean.txt'), 'utf8')).toBe('hello')
  })
})

describe('the quarantine folder', () => {
  test('old entries are removed', async () => {
    scanOn()
    await upload(user, 'q1.txt', EICAR)
    await upload(user, 'q2.txt', EICAR)
    expect(av.listQuarantine()).toHaveLength(2)
    expect(av.trimQuarantine(Date.now() + (config.quarantineDays + 1) * 86_400_000)).toBe(2)
    expect(av.listQuarantine()).toHaveLength(0)
    expect(quarantined()).toEqual([])
  })
})

describe('too big to scan is decided apart from a scanner failure', () => {
  const skipped = () => auditText().split('\n').filter(l => l.includes('"action":"virus-scan-skipped"'))

  test('with the defaults and clamd down, a signed-in user is refused (503) and nothing lands', async () => {
    scanDefaults({ port: 1 })
    expect(code(await upload(user, 'down-default.txt', 'hello'))).toEqual({ status: 503, code: 'antivirus.unavailable' })
    expect(existsSync(home('av-user', 'down-default.txt'))).toBe(false)
    expect(filesUnder(home('av-user')).some(p => p.includes('down-default'))).toBe(false)
  })

  test('onErrorUsers=allow brings back the pass-through while clamd is down', async () => {
    scanDefaults({ port: 1, onErrorUsers: 'allow' })
    expect((await upload(user, 'down-allow.txt', 'hello')).status).toBe(200)
    expect(existsSync(home('av-user', 'down-allow.txt'))).toBe(true)
  })

  test('a user file over the limit with clamd up is allowed by default and leaves a virus-scan-skipped line', async () => {
    scanDefaults({ maxScanMb: 0.001 })
    const before = skipped().length
    const scans = fake.scans
    expect((await upload(user, 'big-default.bin', new Uint8Array(5000))).status).toBe(200)
    expect(existsSync(home('av-user', 'big-default.bin'))).toBe(true)
    expect(fake.scans).toBe(scans)
    const lines = skipped()
    expect(lines.length).toBe(before + 1)
    expect(lines[lines.length - 1]).toContain('big-default.bin')
    expect(lines[lines.length - 1]).toContain('5000')
    expect(lines[lines.length - 1]).toContain(String(Math.floor(0.001 * 1024 ** 2)))
  })

  test('onTooBigUsers=reject refuses it with 413 and nothing lands, even when onErrorUsers is allow', async () => {
    scanDefaults({ maxScanMb: 0.001, onTooBigUsers: 'reject', onErrorUsers: 'allow' })
    const before = skipped().length
    expect(code(await upload(user, 'big-reject.bin', new Uint8Array(5000)))).toEqual({ status: 413, code: 'antivirus.too-big' })
    expect(existsSync(home('av-user', 'big-reject.bin'))).toBe(false)
    expect(skipped().length).toBe(before)
  })

  test('an upload link refuses a big file by default (onTooBigLinks), apart from onTooBigUsers and from a scanner failure', async () => {
    mkdirSync(home('av-user', 'inbox-big'), { recursive: true })
    const made = await user.json('POST', '/api/shares', { space: 'home', path: '/inbox-big', days: 7, kind: 'upload' })
    expect(made.status).toBe(200)
    const token = made.data.token as string
    const visitor = new Client()
    const send = async (name: string, bytes: Uint8Array) => {
      const a = await visitor.json('POST', `/api/s/${token}/upload`, { name, size: bytes.length })
      if (a.status !== 200) return a
      expect((await visitor.raw('PUT', `/api/s/${token}/upload/${a.data.id}/0`, bytes, { 'content-type': 'application/octet-stream' })).status).toBe(200)
      return visitor.json('POST', `/api/s/${token}/upload/${a.data.id}/complete`)
    }
    // an outsider must not get past the scan by padding a file over the limit: refused by default, users' default aside
    scanDefaults({ maxScanMb: 0.001 })
    expect(code(await send('big2.bin', new Uint8Array(5000)))).toEqual({ status: 413, code: 'antivirus.too-big' })
    expect(readdirSync(home('av-user', 'inbox-big'))).toEqual([])
    scanDefaults({ maxScanMb: 0.001, onTooBigLinks: 'allow', onTooBigUsers: 'reject' })
    const before = skipped().length
    expect((await send('big.bin', new Uint8Array(5000))).status).toBe(200)
    expect(readdirSync(home('av-user', 'inbox-big'))).toEqual(['big.bin'])
    expect(skipped().length).toBe(before + 1)
    scanDefaults({ port: 1 })
    expect(code(await send('small.txt', new TextEncoder().encode('hi')))).toEqual({ status: 503, code: 'antivirus.unavailable' })
    expect(readdirSync(home('av-user', 'inbox-big'))).toEqual(['big.bin'])
  })

  test('WebDAV: 503 with Retry-After while clamd is down', async () => {
    const made = await user.json('POST', '/api/me/app-passwords', { name: 'dav2', scope: 'readwrite', password: PW })
    expect(made.status).toBe(200)
    const auth = `Basic ${Buffer.from(`av-user:${made.data.secret}`).toString('base64')}`
    scanDefaults({ port: 1 })
    const res = await (app.handle(new Request('http://localhost/dav/home/dav-down.txt', { method: 'PUT', headers: { authorization: auth }, body: 'hello' })) as Promise<Response>)
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('3')
    expect(existsSync(home('av-user', 'dav-down.txt'))).toBe(false)
  })

  test('the settings view reports onTooBigLinks/onTooBigUsers with their source, and an invalid value is refused', async () => {
    expect((await admin.json('GET', '/api/admin/settings')).data.antivirus.onTooBigLinks).toEqual({ value: 'reject', source: 'default' })
    const view = async () => (await admin.json('GET', '/api/admin/settings')).data.antivirus.onTooBigUsers
    expect(await view()).toEqual({ value: 'allow', source: 'default' })
    const pw = process.env.ADMIN_PASSWORD
    // loosening the outsiders' rule asks for the password like every antivirus key (the right one below clears the miss)
    expect((await admin.json('PUT', '/api/admin/settings', { antivirus: { onTooBigLinks: 'allow' } })).status).toBe(403)
    const saved = await admin.json('PUT', '/api/admin/settings', { antivirus: { onTooBigUsers: 'reject' }, password: pw })
    expect(saved.status).toBe(200)
    expect(saved.data.antivirus.onTooBigUsers).toEqual({ value: 'reject', source: 'web' })
    expect((await admin.json('PUT', '/api/admin/settings', { antivirus: { onTooBigUsers: 'maybe' }, password: pw })).status).toBe(400)
    expect((await admin.json('PUT', '/api/admin/settings', { antivirus: { onTooBigLinks: 'maybe' }, password: pw })).status).toBe(400)
    expect((await view()).value).toBe('reject')
    settings.update({ antivirus: undefined })
    const had = process.env.CLAMAV_ON_TOO_BIG_USERS
    process.env.CLAMAV_ON_TOO_BIG_USERS = 'reject'
    try { expect((await view()).source).toBe('env') } finally { if (had === undefined) delete process.env.CLAMAV_ON_TOO_BIG_USERS; else process.env.CLAMAV_ON_TOO_BIG_USERS = had }
    expect(config.clamavOnTooBigLinks).toBe('reject')
    expect(config.clamavOnErrorUsers).toBe('reject')
  })
})
