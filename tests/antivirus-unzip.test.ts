/**
 * With the antivirus on, POST /api/unzip extracts into a private folder in paths.tmp, scans every file (via 'unzip') and
 * moves the tree into place only when all are clean. An infected or refused file stops it: nothing lands, the quarantine
 * holds the file, the quota hold is given back. Off, the extraction is direct as before. A stand-in clamd answers FOUND
 * when the bytes hold EICAR. In-process (see in-process-env.ts); the user starts with "avz-".
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import net from 'node:net'
import { existsSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import './in-process-env'

let app: any
let paths: typeof import('../src/config').paths
let settings: typeof import('../src/settings').settings
let av: typeof import('../src/antivirus')

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'

/** scans that wait before answering, in order: each test that queues one releases it */
const pauses: { reached: () => void; go: Promise<void> }[] = []
function pauseNextScan() {
  let reached!: () => void
  let release!: () => void
  const at = new Promise<void>(r => { reached = r })
  const go = new Promise<void>(r => { release = r })
  pauses.push({ reached, go })
  return { reached: at, release }
}

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
          const answer = () => sock.end(data.includes(Buffer.from(EICAR)) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0')
          const pause = pauses.shift()
          if (pause) { pause.reached(); pause.go.then(answer) } else answer()
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
const admin = new Client()
const home = (...p: string[]) => join(process.env.STORAGE_DIR!, 'users', 'avz-u', ...p)
const stagings = () => (existsSync(paths.tmp) ? readdirSync(paths.tmp).filter(n => n.startsWith('unzip-')) : [])
const enc = (s: string) => new TextEncoder().encode(s)
const put = (name: string, files: Record<string, string>) =>
  writeFileSync(home(name), zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, enc(v)]))))
const unzip = (name: string) => u.json('POST', '/api/unzip', { space: 'home', path: `/${name}` })
const folders = () => readdirSync(home()).filter(n => !n.endsWith('.zip'))

let server: net.Server
const port = () => (server.address() as net.AddressInfo).port
const scanOn = (over: Record<string, unknown> = {}) =>
  settings.update({ antivirus: { enabled: true, host: '127.0.0.1', port: port(), timeoutSeconds: 5, maxScanMb: 25, onErrorLinks: 'reject', onErrorUsers: 'reject', ...over } as any })
// back to no stored antivirus group at all, as other files expect
const scanOff = () => settings.update({ antivirus: undefined })
const deadPort = async () => {
  const dead = net.createServer()
  await new Promise<void>(r => dead.listen(0, '127.0.0.1', () => r()))
  const p = (dead.address() as net.AddressInfo).port
  await new Promise<void>(r => dead.close(() => r()))
  return p
}

let u: Client
beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ paths } = await import('../src/config'))
  ;({ settings } = await import('../src/settings'))
  av = await import('../src/antivirus')
  server = await clamd()
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
  const r = await admin.json('POST', '/api/admin/users', { username: 'avz-u', name: 'avz-u', password: PW, role: 'user', permissions: ['read', 'write', 'upload', 'download', 'zip'], publicPermissions: [], quotaBytes: 100_000 })
  expect(r.status).toBe(200)
  u = await new Client().login('avz-u', PW)
})

afterEach(() => {
  pauses.length = 0
  scanOff()
  for (const m of av.listQuarantine()) av.deleteQuarantined(m.id)
  if (existsSync(home())) for (const n of readdirSync(home())) rmSync(home(n), { recursive: true, force: true })
})

afterAll(async () => {
  await admin.json('DELETE', '/api/admin/users/avz-u')
  rmSync(home(), { recursive: true, force: true })
  scanOff()
  for (const m of av.listQuarantine()) av.deleteQuarantined(m.id)
  server?.close()
})

describe('unzip with the antivirus on', () => {
  test('one EICAR file stops everything: 422, nothing lands, quarantined as via unzip, quota and tmp untouched', async () => {
    scanOn()
    put('bad.zip', { 'a-clean.txt': 'hello', 'dir/sub/virus.exe': `MZ${EICAR}`, 'z-clean.txt': 'bye' })
    const r = await unzip('bad.zip')
    expect(r.status).toBe(422)
    expect(r.data.code).toBe('antivirus.infected')
    expect(folders()).toEqual([])
    const q = av.listQuarantine()
    expect(q.length).toBe(1)
    expect(q[0].via).toBe('unzip')
    expect(q[0].by).toBe('avz-u')
    expect(q[0].name).toBe('bad.zip/dir/sub/virus.exe')
    expect(readFileSync(paths.audit, 'utf8')).toMatch(/"action":"virus-found"[^\n]*bad\.zip\/dir\/sub\/virus\.exe \(unzip\)/)
    expect(stagings()).toEqual([])
    // the quota hold is given back: a file nearly as big as the whole quota still fits
    const up = await u.json('POST', '/api/upload', { space: 'home', path: '/', name: 'big.bin', size: 90_000 })
    expect(up.status).toBe(200)
    await u.json('DELETE', `/api/upload/${up.data.id}`)
  })

  test('a clean zip extracts as before and leaves nothing in tmp', async () => {
    scanOn()
    put('ok.zip', { 'a.txt': 'one', 'd/b.txt': 'two' })
    const r = await unzip('ok.zip')
    expect(r.status).toBe(200)
    expect(r.data).toMatchObject({ ok: true, folder: 'ok', files: 2 })
    expect(readFileSync(home('ok', 'a.txt'), 'utf8')).toBe('one')
    expect(readFileSync(home('ok', 'd', 'b.txt'), 'utf8')).toBe('two')
    expect(stagings()).toEqual([])
    expect(av.listQuarantine().length).toBe(0)
    // a second extraction does not overwrite the first
    const again = await unzip('ok.zip')
    expect(again.data.folder).toBe('ok (1)')
    expect(readFileSync(home('ok', 'a.txt'), 'utf8')).toBe('one')
  })

  test('a zip with no files extracts to an empty folder, as without the scan', async () => {
    scanOn()
    writeFileSync(home('empty.zip'), zipSync({}))
    const r = await unzip('empty.zip')
    expect(r.status).toBe(200)
    expect(r.data).toMatchObject({ ok: true, folder: 'empty', files: 0 })
    expect(readdirSync(home('empty'))).toEqual([])
    expect(stagings()).toEqual([])
  })

  test('a long scan keeps its staging folder fresh: the stale sweep of tmp does not take it', async () => {
    const { config } = await import('../src/config')
    const { cleanStaleUploads } = await import('../src/uploads')
    const keep = config.uploadStaleMs
    scanOn()
    put('long.zip', { 'a.txt': 'one', 'b.txt': 'two' })
    const first = pauseNextScan()
    const second = pauseNextScan()
    const done = unzip('long.zip')
    try {
      await first.reached
      // while the first file is scanned the folder is made to look two hours idle
      const [stage] = stagings()
      expect(stage).toBeDefined()
      const old = new Date(Date.now() - 2 * 3600_000)
      utimesSync(join(paths.tmp, stage), old, old)
      first.release()
      // the second file is being scanned: a sweep with a one-hour limit must leave the folder alone
      await second.reached
      config.uploadStaleMs = 3600_000
      cleanStaleUploads()
      expect(stagings()).toEqual([stage])
    } finally {
      config.uploadStaleMs = keep
      first.release()
      second.release()
    }
    const r = await done
    expect(r.status).toBe(200)
    expect(r.data).toMatchObject({ ok: true, folder: 'long', files: 2 })
    expect(stagings()).toEqual([])
  })

  test('clamd down: refused with onErrorUsers reject, extracted with allow', async () => {
    put('down.zip', { 'a.txt': 'one' })
    scanOn({ port: await deadPort(), onErrorUsers: 'reject' })
    const r = await unzip('down.zip')
    expect(r.status).toBe(503)
    expect(r.data.code).toBe('antivirus.unavailable')
    expect(folders()).toEqual([])
    expect(stagings()).toEqual([])
    scanOn({ port: await deadPort(), onErrorUsers: 'allow' })
    const ok = await unzip('down.zip')
    expect(ok.status).toBe(200)
    expect(readFileSync(home('down', 'a.txt'), 'utf8')).toBe('one')
    expect(stagings()).toEqual([])
  })
})

describe('unzip with the antivirus off', () => {
  test('the EICAR zip extracts directly, as before', async () => {
    put('off.zip', { 'e.txt': EICAR })
    const r = await unzip('off.zip')
    expect(r.status).toBe(200)
    expect(r.data.folder).toBe('off')
    expect(av.listQuarantine().length).toBe(0)
    expect(stagings()).toEqual([])
    // other files look for EICAR left in the storage: take it out again
    rmSync(home('off'), { recursive: true, force: true })
  })
})
