/**
 * The antivirus also covers what the editors save: the ONLYOFFICE save callback (via 'office') and the web text editor,
 * PUT /api/content (via 'edit'). An infected save is refused and quarantined and the old file stays. A stand-in clamd
 * answers FOUND when the bytes hold EICAR. In-process on the shared app (see in-process-env.ts); users start with "ave-",
 * the antivirus and OFFICE_* settings and the quarantine are put back afterwards.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createHmac, randomBytes } from 'node:crypto'
import net from 'node:net'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import './in-process-env'

let app: any
let config: typeof import('../src/config').config
let paths: typeof import('../src/config').paths
let settings: typeof import('../src/settings').settings
let av: typeof import('../src/antivirus')
let versions: typeof import('../src/versions')

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'

function clamd(): Promise<net.Server> {
  const server = net.createServer(sock => {
    let buf = Buffer.alloc(0)
    let started = false
    const body: Buffer[] = []
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
        if (len === 0) {
          const data = Buffer.concat(body)
          sock.end(data.includes(Buffer.from(EICAR)) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0')
          return
        }
        if (buf.length < 4 + len) return
        body.push(Buffer.from(buf.subarray(4, 4 + len)))
        buf = buf.subarray(4 + len)
      }
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)))
}

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
const SECRET = randomBytes(24).toString('base64url')
const INTERNAL = 'http://file-center.internal:3000'
const admin = new Client()
const home = (user: string, ...p: string[]) => join(process.env.STORAGE_DIR!, 'users', user, ...p)
const quarantined = () => av.listQuarantine()
const editTmp = () => (existsSync(paths.tmp) ? readdirSync(paths.tmp).filter(n => n.startsWith('edit-')) : [])
const read = (f: string) => readFileSync(f, 'utf8')

let server: net.Server
const port = () => (server.address() as net.AddressInfo).port
const scanOn = (over: Record<string, unknown> = {}) =>
  settings.update({ antivirus: { enabled: true, host: '127.0.0.1', port: port(), timeoutSeconds: 5, maxScanMb: 25, onErrorLinks: 'reject', onErrorUsers: 'reject', ...over } as any })
const scanOff = () => settings.update({ antivirus: { enabled: false } as any })

let docServer: ReturnType<typeof Bun.serve>
const savedFiles = new Map<string, Uint8Array>()
const DOC = () => `http://127.0.0.1:${docServer.port}`
const saved = { url: '', internal: '', server: '', secret: '' }

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url')
function sign(payload: object) {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64(JSON.stringify(payload))
  return `${head}.${body}.${b64(createHmac('sha256', SECRET).update(`${head}.${body}`).digest())}`
}
function callback(url: string, data: Record<string, unknown>) {
  return app.handle(new Request('http://localhost' + url.slice(INTERNAL.length), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...data, token: sign(data) }),
  })) as Promise<Response>
}
function publish(bytes: string) {
  const id = randomBytes(6).toString('hex')
  savedFiles.set(`/cache/files/${id}/output.docx`, new TextEncoder().encode(bytes))
  return `${DOC()}/cache/files/${id}/output.docx`
}

let ed: Client
beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config, paths } = await import('../src/config'))
  ;({ settings } = await import('../src/settings'))
  av = await import('../src/antivirus')
  versions = await import('../src/versions')
  server = await clamd()
  docServer = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) { const b = savedFiles.get(new URL(req.url).pathname); return b ? new Response(b) : new Response('no', { status: 404 }) } })
  Object.assign(saved, { url: config.officeUrl, internal: config.officeInternalUrl, server: config.officeServerInternalUrl, secret: config.officeJwtSecret })
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
  const r = await admin.json('POST', '/api/admin/users', { username: 'ave-ed', name: 'ave-ed', password: PW, role: 'user', permissions: ['read', 'write', 'upload', 'download'], publicPermissions: [] })
  expect(r.status).toBe(200)
  ed = await new Client().login('ave-ed', PW)
})

afterEach(() => {
  scanOff()
  for (const m of av.listQuarantine()) av.deleteQuarantined(m.id)
  Object.assign(config, { officeUrl: '', officeInternalUrl: '', officeServerInternalUrl: '', officeJwtSecret: '' })
})

afterAll(() => {
  scanOff()
  for (const m of av.listQuarantine()) av.deleteQuarantined(m.id)
  Object.assign(config, { officeUrl: saved.url, officeInternalUrl: saved.internal, officeServerInternalUrl: saved.server, officeJwtSecret: saved.secret })
  docServer?.stop(true)
  server?.close()
})

describe('text editor (PUT /api/content)', () => {
  const put = (name: string, content: string) => ed.json('PUT', '/api/content', { space: 'home', path: `/${name}`, content })
  const mk = (name: string, content = 'old text') => { writeFileSync(home('ave-ed', name), content); return home('ave-ed', name) }

  test('EICAR is refused, quarantined as via edit, the old content stays', async () => {
    scanOn()
    const f = mk('infected.html')
    const r = await put('infected.html', `<script>${EICAR}</script>`)
    expect(r.status).toBe(422)
    expect(r.data.code).toBe('antivirus.infected')
    expect(read(f)).toBe('old text')
    const q = quarantined()
    expect(q.length).toBe(1)
    expect(q[0]).toMatchObject({ via: 'edit', by: 'ave-ed', name: 'infected.html', dest: '/users/ave-ed' })
    expect(readFileSync(paths.audit, 'utf8')).toMatch(/"action":"virus-found"[^\n]*infected\.html \(edit\)/)
    // a refused save keeps no version
    expect(versions.listVersions(f).length).toBe(0)
    expect(editTmp()).toEqual([])
  })

  test('clean content saves as before', async () => {
    scanOn()
    const f = mk('clean.txt')
    const r = await put('clean.txt', 'new text')
    expect(r.status).toBe(200)
    expect(read(f)).toBe('new text')
    expect(quarantined().length).toBe(0)
    expect(editTmp()).toEqual([])
  })

  test('clamd down: refused with onErrorUsers reject, saved with allow', async () => {
    const dead = net.createServer()
    await new Promise<void>(r => dead.listen(0, '127.0.0.1', () => r()))
    const deadPort = (dead.address() as net.AddressInfo).port
    await new Promise<void>(r => dead.close(() => r()))
    const f = mk('down.txt')
    scanOn({ port: deadPort, onErrorUsers: 'reject' })
    const r = await put('down.txt', 'new text')
    expect(r.status).toBe(503)
    expect(r.data.code).toBe('antivirus.unavailable')
    expect(read(f)).toBe('old text')
    expect(editTmp()).toEqual([])
    scanOn({ port: deadPort, onErrorUsers: 'allow' })
    expect((await put('down.txt', 'new text')).status).toBe(200)
    expect(read(f)).toBe('new text')
    expect(editTmp()).toEqual([])
  })

  test('antivirus off: EICAR text saves, no temp file', async () => {
    const f = mk('off.txt')
    expect((await put('off.txt', EICAR)).status).toBe(200)
    expect(read(f)).toBe(EICAR)
    expect(quarantined().length).toBe(0)
    expect(editTmp()).toEqual([])
  })

  test('releasing an edit item lands beside the original, never over it', async () => {
    scanOn()
    const f = mk('keep.html')
    expect((await put('keep.html', EICAR)).status).toBe(422)
    const [m] = quarantined()
    const out = await av.releaseQuarantined(m.id)
    expect(out.path).not.toBe(f)
    expect(read(f)).toBe('old text')
    expect(read(out.path)).toBe(EICAR)
    expect(out.path.startsWith(home('ave-ed') + '/')).toBe(true)
    rmSync(out.path, { force: true })
  })
})

describe('ONLYOFFICE save callback', () => {
  async function setup(name: string) {
    Object.assign(config, { officeUrl: DOC(), officeInternalUrl: INTERNAL, officeServerInternalUrl: '', officeJwtSecret: SECRET })
    writeFileSync(home('ave-ed', name), 'old version')
    const r = await ed.json('POST', '/api/office/config', { space: 'home', path: `/${name}`, mode: 'edit' })
    expect(r.status).toBe(200)
    return { cb: r.data.config.editorConfig.callbackUrl as string, key: r.data.config.document.key as string, file: home('ave-ed', name) }
  }

  test('an infected save answers error 1, quarantined as via office, the file stays', async () => {
    scanOn()
    const { cb, key, file } = await setup('inf.docx')
    const before = readdirSync(home('ave-ed')).sort()
    const res = await callback(cb, { key, status: 2, url: publish(`doc ${EICAR}`), filetype: 'docx' })
    expect(await res.json()).toEqual({ error: 1 })
    expect(read(file)).toBe('old version')
    const q = quarantined()
    expect(q.length).toBe(1)
    expect(q[0]).toMatchObject({ via: 'office', by: 'ave-ed', name: 'inf.docx', dest: '/users/ave-ed' })
    expect(versions.listVersions(file).length).toBe(0)
    expect(readdirSync(home('ave-ed')).sort()).toEqual(before)
    // the queue is free again: a clean save of the same file goes through
    const ok = await callback(cb, { key, status: 2, url: publish('clean doc'), filetype: 'docx' })
    expect(await ok.json()).toEqual({ error: 0 })
    expect(read(file)).toBe('clean doc')
  })

  test('a clean save goes through with the antivirus on', async () => {
    scanOn()
    const { cb, key, file } = await setup('clean.docx')
    const res = await callback(cb, { key, status: 2, url: publish('fine'), filetype: 'docx' })
    expect(await res.json()).toEqual({ error: 0 })
    expect(read(file)).toBe('fine')
    expect(quarantined().length).toBe(0)
  })
})
