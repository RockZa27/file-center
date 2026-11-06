/**
 * A chunk must not change a file while the virus scan reads it (or after): once completion has started, a further chunk
 * is refused with 409 `upload.completing`, and a write already in flight finishes before completion looks at the file.
 * A stand-in clamd answers only when the test lets it, so no timing is guessed. In-process on the shared app (see
 * in-process-env.ts); users start with "usr-".
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import net from 'node:net'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import './in-process-env'

let app: any
let config: typeof import('../src/config').config
let paths: typeof import('../src/config').paths
let settings: typeof import('../src/settings').settings
let av: typeof import('../src/antivirus')
let uploads: typeof import('../src/uploads')
let auth: typeof import('../src/auth')

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'

// ───────────── a stand-in clamd that answers when told ─────────────

type Gate = { promise: Promise<void>; open: () => void }
const gate = (): Gate => { let open!: () => void; const promise = new Promise<void>(r => { open = r }); return { promise, open } }

/** every scan: the bytes it got, `got` opens when the whole stream is in, the answer waits for `hold` */
const fake = { hold: gate(), got: gate(), seen: [] as Buffer[] }
const resetFake = () => { fake.hold = gate(); fake.got = gate(); fake.seen = [] }

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
          fake.seen.push(data)
          fake.got.open()
          fake.hold.promise.then(() => sock.end(data.includes(Buffer.from(EICAR)) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0'))
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

let server: net.Server

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
const PERMS = ['read', 'write', 'upload', 'download', 'share']
const admin = new Client()
const home = (user: string, ...p: string[]) => join(process.env.STORAGE_DIR!, 'users', user, ...p)
const OCTET = { 'content-type': 'application/octet-stream' }
const CHUNK = () => config.uploadChunkSize
const fill = (byte: number) => new Uint8Array(CHUNK()).fill(byte)
const evil = () => { const b = new Uint8Array(CHUNK()); b.set(Buffer.from(EICAR)); return b }
const cat = (...parts: Uint8Array[]) => Buffer.concat(parts)
const quarantined = () => (existsSync(paths.quarantine) ? readdirSync(paths.quarantine) : [])

const scanOn = () => settings.update({ antivirus: { enabled: true, host: '127.0.0.1', port: (server.address() as net.AddressInfo).port, timeoutSeconds: 20, maxScanMb: 25, onErrorLinks: 'reject', onErrorUsers: 'reject' } as any })

let user: Client
let visitor: Client
let token = ''
let shareId = ''
const created: string[] = []
const who = () => auth.findUser('usr-race')!

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config, paths } = await import('../src/config'))
  ;({ settings } = await import('../src/settings'))
  av = await import('../src/antivirus')
  uploads = await import('../src/uploads')
  auth = await import('../src/auth')
  server = await clamd()
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
  const r = await admin.json('POST', '/api/admin/users', { username: 'usr-race', name: 'usr-race', password: PW, role: 'user', permissions: PERMS, publicPermissions: [] })
  expect(r.status).toBe(200)
  mkdirSync(home('usr-race', 'inbox'), { recursive: true })
  user = await new Client().login('usr-race', PW)
  const l = await user.json('POST', '/api/shares', { space: 'home', path: '/inbox', days: 7, kind: 'upload' })
  expect(l.status).toBe(200)
  token = l.data.token
  shareId = l.data.share.id
  visitor = new Client()
  visitor.csrf = (await visitor.json('GET', '/api/session')).data.csrf
})

afterEach(() => {
  settings.update({ antivirus: undefined })
  fake.hold.open() // nothing may stay waiting for an answer
  resetFake()
  for (const m of av.listQuarantine()) av.deleteQuarantined(m.id)
  for (const f of created.splice(0)) rmSync(f, { force: true })
})

afterAll(async () => {
  await user.json('DELETE', `/api/shares/${shareId}`)
  await admin.json('DELETE', '/api/admin/users/usr-race')
  rmSync(home('usr-race'), { recursive: true, force: true })
  await new Promise(r => server.close(r))
})

/** the file a finished upload left under the home, by name; remembered so afterEach removes it */
function landed(dir: string, name: string): Buffer {
  const path = home('usr-race', dir, name)
  created.push(path)
  return readFileSync(path)
}

describe('a chunk sent after complete started is refused', () => {
  test('signed-in user: 409 upload.completing, the clean bytes are what lands', async () => {
    scanOn()
    const a = await user.json('POST', '/api/upload', { space: 'home', path: '/', name: 'race-user.bin', size: CHUNK() * 2 })
    expect(a.status).toBe(200)
    const id = a.data.id as string
    for (const i of [0, 1]) expect((await user.raw('PUT', `/api/upload/${id}/${i}`, fill(65), OCTET)).status).toBe(200)
    const done = user.json('POST', `/api/upload/${id}/complete`)
    await fake.got.promise // clamd has the whole stream and is "scanning"
    const late = await user.json('PUT', `/api/upload/${id}/0`, evil(), OCTET)
    expect(late.status).toBe(409)
    expect(late.data.code).toBe('upload.completing')
    fake.hold.open()
    const r = await done
    expect(r.status).toBe(200)
    const stored = landed('', 'race-user.bin')
    expect(stored.equals(cat(fill(65), fill(65)))).toBe(true)
    expect(stored.includes(Buffer.from(EICAR))).toBe(false)
    expect(fake.seen.length).toBe(1)
    expect(fake.seen[0].equals(stored)).toBe(true)
    expect(quarantined().length).toBe(0)
  })

  test('visitor of an upload-request link: the same', async () => {
    scanOn()
    const a = await visitor.json('POST', `/api/s/${token}/upload`, { name: 'race-link.bin', size: CHUNK() * 2 })
    expect(a.status).toBe(200)
    const id = a.data.id as string
    for (const i of [0, 1]) expect((await visitor.raw('PUT', `/api/s/${token}/upload/${id}/${i}`, fill(66), OCTET)).status).toBe(200)
    const done = visitor.json('POST', `/api/s/${token}/upload/${id}/complete`)
    await fake.got.promise
    const late = await visitor.json('PUT', `/api/s/${token}/upload/${id}/1`, evil(), OCTET)
    expect(late.status).toBe(409)
    expect(late.data.code).toBe('upload.completing')
    fake.hold.open()
    const r = await done
    expect(r.status).toBe(200)
    const stored = landed('inbox', r.data.name)
    expect(stored.equals(cat(fill(66), fill(66)))).toBe(true)
    expect(fake.seen[0].equals(stored)).toBe(true)
    expect(quarantined().length).toBe(0)
  })

  test('with the antivirus off the refusal is the same (the stored file is what was checked)', async () => {
    const a = await user.json('POST', '/api/upload', { space: 'home', path: '/', name: 'race-off.bin', size: CHUNK() * 2 })
    const id = a.data.id as string
    for (const i of [0, 1]) expect((await user.raw('PUT', `/api/upload/${id}/${i}`, fill(67), OCTET)).status).toBe(200)
    const done = uploads.completeUpload(id, 'usr-race', who())
    const late = await user.json('PUT', `/api/upload/${id}/0`, fill(68), OCTET)
    expect(late.status).toBe(409)
    expect(late.data.code).toBe('upload.completing')
    const r = await done
    created.push(r.path)
    expect(readFileSync(r.path).equals(cat(fill(67), fill(67)))).toBe(true)
  })
})

describe('a chunk write already in flight', () => {
  test('finishes before completion checks and scans the file', async () => {
    scanOn()
    const a = await user.json('POST', '/api/upload', { space: 'home', path: '/', name: 'race-flight.bin', size: CHUNK() * 2 })
    const id = a.data.id as string
    expect((await user.raw('PUT', `/api/upload/${id}/0`, fill(70), OCTET)).status).toBe(200)
    // chunk 1 is on its way (its slot is taken before the first wait) when complete starts: complete must not
    // report it missing, and the scan must read it
    const write = uploads.saveChunk(id, 'usr-race', 1, fill(71).buffer as ArrayBuffer, who())
    const done = uploads.completeUpload(id, 'usr-race', who())
    await write
    await fake.got.promise
    fake.hold.open()
    const r = await done
    created.push(r.path)
    const stored = readFileSync(r.path)
    expect(stored.equals(cat(fill(70), fill(71)))).toBe(true)
    expect(fake.seen.length).toBe(1)
    expect(fake.seen[0].equals(stored)).toBe(true)
  })

  test('no per-upload state is left once the writes are over', async () => {
    const a = await user.json('POST', '/api/upload', { space: 'home', path: '/', name: 'race-clean.bin', size: 10 })
    const id = a.data.id as string
    await Promise.all([0, 0, 0].map(() => uploads.saveChunk(id, 'usr-race', 0, new Uint8Array(10).buffer as ArrayBuffer, who())))
    const r = await uploads.completeUpload(id, 'usr-race', who())
    created.push(r.path)
    // a later chunk of a finished upload finds nothing (404), not a stale "completing"
    await expect(uploads.saveChunk(id, 'usr-race', 0, new Uint8Array(10).buffer as ArrayBuffer, who())).rejects.toMatchObject({ status: 404 })
  })
})

describe('the normal flow is unchanged', () => {
  test('chunk, the same chunk again before complete, complete, retry of complete', async () => {
    const a = await user.json('POST', '/api/upload', { space: 'home', path: '/', name: 'race-normal.bin', size: CHUNK() + 5 })
    const id = a.data.id as string
    const tail = new Uint8Array(5).fill(9)
    expect((await user.raw('PUT', `/api/upload/${id}/0`, fill(1), OCTET)).status).toBe(200)
    expect((await user.raw('PUT', `/api/upload/${id}/0`, fill(2), OCTET)).status).toBe(200) // a retry before complete
    expect((await user.json('GET', `/api/upload/${id}`)).data.received).toEqual([0])
    expect((await user.raw('PUT', `/api/upload/${id}/1`, tail, OCTET)).status).toBe(200)
    const first = await user.json('POST', `/api/upload/${id}/complete`)
    const again = await user.json('POST', `/api/upload/${id}/complete`)
    expect(first.status).toBe(200)
    expect(again).toMatchObject({ status: 200, data: first.data })
    expect(landed('', 'race-normal.bin').equals(cat(fill(2), tail))).toBe(true)
    expect(existsSync(home('usr-race', 'race-normal (1).bin'))).toBe(false)
  })

  test('a complete that fails (a chunk missing) frees the upload for the chunk again', async () => {
    const a = await user.json('POST', '/api/upload', { space: 'home', path: '/', name: 'race-retry.bin', size: CHUNK() + 5 })
    const id = a.data.id as string
    expect((await user.raw('PUT', `/api/upload/${id}/0`, fill(3), OCTET)).status).toBe(200)
    expect((await user.json('POST', `/api/upload/${id}/complete`)).data.code).toBe('upload.missing-chunk')
    expect((await user.raw('PUT', `/api/upload/${id}/1`, new Uint8Array(5).fill(4), OCTET)).status).toBe(200)
    expect((await user.json('POST', `/api/upload/${id}/complete`)).status).toBe(200)
    landed('', 'race-retry.bin')
  })
})
