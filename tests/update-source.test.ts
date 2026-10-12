/**
 * Updates published on the web (UPDATE_SOURCE): checking latest.json and fetching the package it names, against a
 * local HTTP server that plays the `updates` branch (no internet). Runs in-process on the same app as api.test.ts
 * (see in-process-env.ts); FC_SUPERVISED=1 only unlocks the update routes, nothing is installed here. Installing a
 * fetched package for real, under the launcher, is in update.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { zipSync } from 'fflate'
import { base } from './in-process-env'

let app: any
let config: typeof import('../src/config').config
let paths: typeof import('../src/config').paths
let source: typeof import('../src/update-source')
let MESSAGES: typeof import('../src/messages').MESSAGES

class Client {
  cookie = ''
  csrf = ''
  async json(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers }
    if (this.cookie) h.cookie = this.cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    if (body !== undefined) h['content-type'] = 'application/json'
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }))
    const set = res.headers.get('set-cookie')
    if (set) this.cookie = set.split(';')[0]
    return { status: res.status, data: (await res.json().catch(() => null)) as any }
  }
  async login(username: string, password: string) {
    this.csrf = (await this.json('GET', '/api/session')).data.csrf
    const r = await this.json('POST', '/api/login', { username, password })
    expect(r.status).toBe(200)
    this.csrf = r.data.csrf
  }
}
const admin = new Client()
const EN = { 'x-lang': 'en' }

// ── the "updates branch": every path answers what `files` holds; `requests` records what was asked
type Handler = (req: Request) => Response | Promise<Response>
const files = new Map<string, Handler>()
const requests: string[] = []
let server: ReturnType<typeof Bun.serve>
const at = (p: string) => `http://127.0.0.1:${server.port}/fc/updates${p}`
const enc = new TextEncoder()
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/** a package as scripts/package.ts makes it; the server code never runs here */
function makePackage(version: string): Uint8Array {
  const content: Record<string, Uint8Array> = { 'server.js': enc.encode('console.log("hi")'), 'web/index.html': enc.encode('<html></html>') }
  const manifest = {
    name: 'file-center', version, builtAt: new Date().toISOString(), notes: 'from the source',
    files: Object.fromEntries(Object.entries(content).map(([p, d]) => [p, { size: d.length, sha256: sha(d) }])),
  }
  return zipSync({ 'manifest.json': enc.encode(JSON.stringify(manifest)), ...content })
}

/** publish `zip` as the latest version; `latest` overrides fields of latest.json */
function publish(version: string, zip: Uint8Array, latest: Record<string, unknown> = {}) {
  const file = `file-center-${version}.zip`
  const body = { version, file, sha256: sha(zip), size: zip.length, builtAt: '2026-10-12T00:00:00.000Z', commit: 'abc1234', notes: 'new things', signed: false, ...latest }
  files.clear()
  files.set('/latest.json', () => Response.json(body))
  files.set(`/${file}`, () => new Response(zip))
}

const incoming = () => {
  try { return readdirSync(join(paths.app, 'incoming')).filter(n => n.startsWith('fetch-')) } catch { return [] }
}
const saved = { limits: {} as typeof source.SOURCE_LIMITS, maxSize: 0, key: '' }

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config, paths } = await import('../src/config'))
  ;({ MESSAGES } = await import('../src/messages'))
  source = await import('../src/update-source')
  saved.limits = { ...source.SOURCE_LIMITS }
  saved.maxSize = config.updateMaxSize
  saved.key = config.updatePublicKey
  server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch: req => {
      const p = new URL(req.url).pathname
      requests.push(p)
      const h = p.startsWith('/fc/updates/') ? files.get(p.slice('/fc/updates'.length)) : undefined
      return h ? h(req) : new Response('not found', { status: 404 })
    },
  })
  process.env.FC_SUPERVISED = '1'
  config.updateSource = at('')
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
})

afterAll(() => {
  delete process.env.FC_SUPERVISED
  config.updateSource = ''
  server.stop(true)
})

afterEach(() => {
  Object.assign(source.SOURCE_LIMITS, saved.limits)
  config.updateMaxSize = saved.maxSize
  config.updatePublicKey = saved.key
  config.updateSource = at('')
  files.clear()
  requests.length = 0
})

describe('update source: configuration', () => {
  test('off without UPDATE_SOURCE: nothing is asked and fetching is refused', async () => {
    config.updateSource = ''
    const s = await admin.json('GET', '/api/admin/update')
    expect(s.data.source).toEqual({ enabled: false, url: null })
    const c = await admin.json('GET', '/api/admin/update/check')
    expect(c).toEqual({ status: 200, data: { enabled: false, current: config.version, latest: null, newer: false } })
    const f = await admin.json('POST', '/api/admin/update/fetch')
    expect([f.status, f.data.code]).toEqual([409, 'update.source-off'])
    expect(requests).toEqual([])
  })

  test('only https, or http to this machine; anything else stays off', async () => {
    for (const bad of ['http://example.com/updates', 'http://10.0.0.1/updates', 'ftp://127.0.0.1/updates', 'file:///etc', 'not a url', 'https://example.com/u?x=1']) {
      config.updateSource = bad
      expect(`${bad} ${typeof source.sourceConfig().error}`).toBe(`${bad} string`)
      expect((await admin.json('GET', '/api/admin/update')).data.source).toEqual({ enabled: false, url: null })
      expect((await admin.json('GET', '/api/admin/update/check')).data.enabled).toBe(false)
      expect((await admin.json('POST', '/api/admin/update/fetch')).data.code).toBe('update.source-off')
    }
    // the page shows where it fetches from, never a password
    config.updateSource = 'https://someone:s3cret@raw.example.com/owner/repo/updates/'
    expect(source.sourceConfig().error).toBeNull()
    expect((await admin.json('GET', '/api/admin/update')).data.source).toEqual({ enabled: true, url: 'https://raw.example.com/owner/repo/updates' })
    config.updateSource = 'http://localhost:1/updates'
    expect((await admin.json('GET', '/api/admin/update')).data.source.enabled).toBe(true)
    // WEB_UPDATE=false turns this off too
    config.webUpdate = false
    try {
      expect((await admin.json('GET', '/api/admin/update')).data.source.enabled).toBe(false)
    } finally {
      config.webUpdate = true
    }
  })

  test('a bad UPDATE_SOURCE is reported at startup without its password, and the app still starts', () => {
    const dir = mkdtempSync(join(base, 'source-start-'))
    const r = Bun.spawnSync([process.execPath, '-e', "await import('./src/index'); process.exit(0)"], {
      cwd: resolve(import.meta.dir, '..'),
      env: {
        PATH: process.env.PATH!, HOME: process.env.HOME ?? dir, STORAGE_DIR: join(dir, 's'), DATA_DIR: join(dir, 'd'),
        ADMIN_PASSWORD: 'startup-pass-1', UPDATE_SOURCE: 'http://someone:s3cret@example.com/updates',
      },
    })
    expect(r.exitCode).toBe(0)
    const logged = readFileSync(join(dir, 'd', 'logs', 'system.log'), 'utf8')
    const entry = logged.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(e => e.event === 'update-source-invalid')
    expect(entry?.level).toBe('warn')
    expect(entry.detail).toContain('http://example.com/updates')
    expect(logged).not.toContain('s3cret')
  })
})

describe('update source: check', () => {
  test('a newer version is reported with what the page shows', async () => {
    publish('9.1.0', makePackage('9.1.0'), { notes: 'faster search' })
    const c = await admin.json('GET', '/api/admin/update/check')
    expect(c.status).toBe(200)
    expect(c.data).toEqual({
      enabled: true, current: config.version,
      latest: { version: '9.1.0', notes: 'faster search', size: expect.any(Number), signed: false, builtAt: '2026-10-12T00:00:00.000Z' },
      newer: true,
    })
    expect(requests).toEqual(['/fc/updates/latest.json'])
  })

  test('the running version, or an older one, is not newer', async () => {
    for (const v of [config.version, '0.0.1']) {
      publish(v, makePackage(v))
      const c = await admin.json('GET', '/api/admin/update/check')
      expect([c.status, c.data.latest.version, c.data.newer]).toEqual([200, v, false])
    }
  })

  test('latest.json that is too big is not read to the end', async () => {
    publish('9.1.0', makePackage('9.1.0'), { notes: 'x'.repeat(70 * 1024) })
    let c = await admin.json('GET', '/api/admin/update/check', undefined, EN)
    expect([c.status, c.data.code, c.data.error]).toEqual([502, 'update.source-latest-too-big', MESSAGES['update.source-latest-too-big'].en])
    // the same without a Content-Length: counted while it arrives
    files.set('/latest.json', () => new Response(new ReadableStream({
      pull(ctl) { ctl.enqueue(enc.encode(' '.repeat(16 * 1024))) },
    })))
    c = await admin.json('GET', '/api/admin/update/check')
    expect([c.status, c.data.code]).toEqual([502, 'update.source-latest-too-big'])
  })

  test('latest.json that is not valid is refused', async () => {
    const zip = makePackage('9.1.0')
    const cases: Record<string, unknown>[] = [
      { version: 'v9.1' }, { version: undefined }, { sha256: 'abc' }, { sha256: 'A'.repeat(64) }, { size: -1 }, { size: '12' },
      { file: 42 }, { signed: 'yes' }, { notes: 7 },
    ]
    for (const bad of cases) {
      publish('9.1.0', zip, bad)
      const c = await admin.json('GET', '/api/admin/update/check')
      expect(`${JSON.stringify(bad)} ${c.status} ${c.data.code}`).toBe(`${JSON.stringify(bad)} 502 update.source-latest-invalid`)
    }
    for (const body of ['not json', '[1,2]', 'null']) {
      files.set('/latest.json', () => new Response(body))
      expect((await admin.json('GET', '/api/admin/update/check')).data.code).toBe('update.source-latest-invalid')
    }
  })

  test('a source that is missing, slow, redirects or is down says so', async () => {
    let c = await admin.json('GET', '/api/admin/update/check')
    expect([c.status, c.data.code, c.data.params]).toEqual([502, 'update.source-status', { status: 404 }])
    // a redirect could lead off https: not followed
    files.set('/latest.json', () => Response.redirect('http://example.com/latest.json', 302))
    c = await admin.json('GET', '/api/admin/update/check')
    expect([c.status, c.data.code]).toEqual([502, 'update.source-unreachable'])
    source.SOURCE_LIMITS.latestTimeoutMs = 200
    files.set('/latest.json', async () => { await Bun.sleep(1500); return Response.json({}) })
    c = await admin.json('GET', '/api/admin/update/check')
    expect([c.status, c.data.code]).toEqual([504, 'update.source-timeout'])
    config.updateSource = 'http://127.0.0.1:1/updates'
    c = await admin.json('GET', '/api/admin/update/check')
    expect([c.status, c.data.code]).toEqual([502, 'update.source-unreachable'])
  })
})

describe('update source: fetch', () => {
  test('a good package is staged exactly like an uploaded one, and audited', async () => {
    const zip = makePackage('9.1.0')
    publish('9.1.0', zip)
    const r = await admin.json('POST', '/api/admin/update/fetch')
    expect(r.status).toBe(200)
    expect(r.data).toEqual({
      id: expect.stringMatching(/^[a-f0-9]{16}$/), version: '9.1.0', builtAt: expect.any(String), notes: 'from the source', files: 2,
      bytes: expect.any(Number), serverSha256: expect.any(String), runningVersion: config.version, tested: false, signed: false, signatureVerified: false,
    })
    expect(requests).toEqual(['/fc/updates/latest.json', '/fc/updates/file-center-9.1.0.zip'])
    expect(existsSync(join(paths.app, 'staging', r.data.id, 'server.js'))).toBe(true)
    // the download itself is gone once staged
    expect(incoming()).toEqual([])
    const audit = await admin.json('GET', '/api/admin/activity?action=update-fetch')
    expect(audit.data.items[0]).toMatchObject({ user: 'admin', action: 'update-fetch', detail: '9.1.0' })
    expect((await admin.json('DELETE', `/api/admin/update/staged/${r.data.id}`)).status).toBe(200)
  })

  test('with UPDATE_PUBLIC_KEY set, a fetched package still needs its signature', async () => {
    config.updatePublicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    publish('9.1.0', makePackage('9.1.0'))
    const r = await admin.json('POST', '/api/admin/update/fetch')
    expect([r.status, r.data.code]).toEqual([400, 'update.unsigned'])
    expect(incoming()).toEqual([])
  })

  test('a version that is not newer is not downloaded', async () => {
    publish(config.version, makePackage(config.version))
    const r = await admin.json('POST', '/api/admin/update/fetch', undefined, EN)
    expect([r.status, r.data.code, r.data.params]).toEqual([400, 'update.source-not-newer', { version: config.version, running: config.version }])
    expect(requests).toEqual(['/fc/updates/latest.json'])
  })

  test('a package name that is not a plain file-center-x.y.z.zip is not asked for', async () => {
    const zip = makePackage('9.1.0')
    for (const file of ['../file-center-9.1.0.zip', 'sub/file-center-9.1.0.zip', 'evil.zip', 'file-center-9.1.0.zip?x=1', 'file-center-9.1.zip', '%2e%2e/file-center-9.1.0.zip', 'https://example.com/file-center-9.1.0.zip']) {
      requests.length = 0
      publish('9.1.0', zip, { file })
      const r = await admin.json('POST', '/api/admin/update/fetch')
      expect(`${file} ${r.status} ${r.data.code}`).toBe(`${file} 502 update.source-bad-file`)
      expect(requests).toEqual(['/fc/updates/latest.json'])
    }
  })

  test('a package bigger than UPDATE_MAX_SIZE is not downloaded', async () => {
    const zip = makePackage('9.1.0')
    publish('9.1.0', zip)
    config.updateMaxSize = zip.length - 1
    const r = await admin.json('POST', '/api/admin/update/fetch')
    expect([r.status, r.data.code]).toEqual([413, 'update.too-big'])
    expect(requests).toEqual(['/fc/updates/latest.json'])
    expect(incoming()).toEqual([])
  })

  test('a download that does not match the SHA-256 or size of latest.json is thrown away', async () => {
    const zip = makePackage('9.1.0')
    const other = makePackage('9.1.1')
    for (const [what, latest, served] of [
      ['other bytes', {}, other],
      ['wrong hash', { sha256: sha(enc.encode('something else')) }, zip],
      ['longer than promised', { size: zip.length - 10 }, zip],
      ['shorter than promised', { size: zip.length + 10 }, zip],
    ] as [string, Record<string, unknown>, Uint8Array][]) {
      publish('9.1.0', zip, latest)
      files.set('/file-center-9.1.0.zip', () => new Response(served))
      const r = await admin.json('POST', '/api/admin/update/fetch')
      expect(`${what} ${r.status} ${r.data.code}`).toBe(`${what} 502 update.source-mismatch`)
      expect(incoming()).toEqual([])
    }
    expect(readdirSync(join(paths.app, 'staging'))).toEqual([])
  })

  test('a download that stalls gives up', async () => {
    const zip = makePackage('9.1.0')
    publish('9.1.0', zip)
    source.SOURCE_LIMITS.idleTimeoutMs = 300
    files.set('/file-center-9.1.0.zip', () => new Response(new ReadableStream({
      async start(ctl) { ctl.enqueue(zip.slice(0, 100)); await Bun.sleep(3000); ctl.close() },
    }), { headers: { 'content-length': String(zip.length) } }))
    const r = await admin.json('POST', '/api/admin/update/fetch')
    expect([r.status, r.data.code]).toEqual([504, 'update.source-timeout'])
    expect(incoming()).toEqual([])
  })

  test('only admins, and only with the CSRF token', async () => {
    publish('9.1.0', makePackage('9.1.0'))
    expect((await admin.json('POST', '/api/admin/users', { username: 'src-user', name: 'x', password: 'quiet-river-stone-8', role: 'user', permissions: ['read'], publicPermissions: [] })).status).toBe(200)
    const user = new Client()
    await user.login('src-user', 'quiet-river-stone-8')
    expect((await user.json('GET', '/api/admin/update/check')).status).toBe(403)
    expect((await user.json('POST', '/api/admin/update/fetch')).status).toBe(403)
    const guest = new Client()
    expect((await guest.json('GET', '/api/admin/update/check')).status).toBe(401)
    const forged = new Client()
    forged.cookie = admin.cookie
    expect((await forged.json('POST', '/api/admin/update/fetch')).data.code).toBe('csrf')
    expect(requests).toEqual([])
  })
})

describe('update source: fetch and apply in one step', () => {
  const PASSWORD = () => process.env.ADMIN_PASSWORD!
  const staged = () => { try { return readdirSync(join(paths.app, 'staging')) } catch { return [] } }
  const lastAudit = async (action: string) => (await admin.json('GET', `/api/admin/activity?action=${action}`)).data.items[0]

  test('a wrong password downloads nothing, not even latest.json', async () => {
    publish('9.1.0', makePackage('9.1.0'))
    const r = await admin.json('POST', '/api/admin/update/fetch-and-apply', { password: 'wrong-password' })
    expect([r.status, r.data.code]).toEqual([403, 'auth.wrong-password'])
    expect(requests).toEqual([])
    expect((await lastAudit('update-denied')).user).toBe('admin')
    // and it is the step-up of /apply: the right one clears the count again (the source is down here: nothing to fetch)
    files.clear()
    expect((await admin.json('POST', '/api/admin/update/fetch-and-apply', { password: PASSWORD() })).data.params.step).toBe('check')
  })

  test('a version that is not newer stops at the check', async () => {
    publish(config.version, makePackage(config.version))
    const r = await admin.json('POST', '/api/admin/update/fetch-and-apply', { password: PASSWORD() }, EN)
    expect([r.status, r.data.code, r.data.params]).toEqual([400, 'update.source-not-newer', { version: config.version, running: config.version, step: 'check' }])
    expect(r.data.error).toBe(MESSAGES['update.source-not-newer'].en.replace('{version}', config.version).replace('{running}', config.version))
    expect(requests).toEqual(['/fc/updates/latest.json'])
  })

  test('without a source it says so at the check', async () => {
    config.updateSource = ''
    const r = await admin.json('POST', '/api/admin/update/fetch-and-apply', { password: PASSWORD() })
    expect([r.status, r.data.code, r.data.params]).toEqual([409, 'update.source-off', { step: 'check' }])
  })

  test('a download that does not match latest.json stops at fetch and leaves nothing behind', async () => {
    const zip = makePackage('9.1.0')
    publish('9.1.0', zip, { sha256: sha(enc.encode('something else')) })
    const r = await admin.json('POST', '/api/admin/update/fetch-and-apply', { password: PASSWORD() })
    expect([r.status, r.data.code, r.data.params]).toEqual([502, 'update.source-mismatch', { step: 'fetch' }])
    expect(incoming()).toEqual([])
    expect(staged()).toEqual([])
  })

  test('a package the static checks refuse stops at stage', async () => {
    config.updatePublicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    publish('9.1.0', makePackage('9.1.0'))
    const before = (await lastAudit('update-fetch'))?.ts
    const r = await admin.json('POST', '/api/admin/update/fetch-and-apply', { password: PASSWORD() })
    expect([r.status, r.data.code, r.data.params]).toEqual([400, 'update.unsigned', { step: 'stage' }])
    expect(incoming()).toEqual([])
    expect(staged()).toEqual([])
    expect((await lastAudit('update-fetch'))?.ts).toBe(before)
  })

  test('a package whose server does not start stops at apply: nothing installed, nothing left staged', async () => {
    // the server of makePackage only prints a line and exits: the test run catches it
    publish('9.1.0', makePackage('9.1.0'))
    const r = await admin.json('POST', '/api/admin/update/fetch-and-apply', { password: PASSWORD() })
    expect([r.status, r.data.code, r.data.params.step]).toEqual([400, 'update.start-failed', 'apply'])
    expect(requests).toEqual(['/fc/updates/latest.json', '/fc/updates/latest.json', '/fc/updates/file-center-9.1.0.zip'])
    expect(incoming()).toEqual([])
    expect(staged()).toEqual([])
    expect(existsSync(join(paths.app, 'releases'))).toBe(false)
    // fetched and staged like /fetch does it, but never installed
    expect(await lastAudit('update-fetch')).toMatchObject({ user: 'admin', detail: '9.1.0' })
    expect((await admin.json('GET', '/api/admin/update')).data.pending).toBeNull()
  }, 30_000)

  test('only admins, and only with the CSRF token', async () => {
    publish('9.1.0', makePackage('9.1.0'))
    const user = new Client()
    await user.login('src-user', 'quiet-river-stone-8')
    expect((await user.json('POST', '/api/admin/update/fetch-and-apply', { password: 'quiet-river-stone-8' })).status).toBe(403)
    const guest = new Client()
    guest.csrf = (await guest.json('GET', '/api/session')).data.csrf
    expect((await guest.json('POST', '/api/admin/update/fetch-and-apply', { password: 'x' })).status).toBe(401)
    const forged = new Client()
    forged.cookie = admin.cookie
    expect((await forged.json('POST', '/api/admin/update/fetch-and-apply', { password: PASSWORD() })).data.code).toBe('csrf')
    expect(requests).toEqual([])
  })
})

describe('result of the last update in the page language', () => {
  const stateFile = () => join(paths.app, 'state.json')
  const writeLast = (last: Record<string, unknown>) => {
    mkdirSync(paths.app, { recursive: true })
    writeFileSync(stateFile(), JSON.stringify({ schema: 1, current: null, history: [], pending: null, last: { dir: '9.9.8-deadbeef', version: '9.9.8', ok: false, at: new Date().toISOString(), ...last } }))
  }
  afterAll(() => rmSync(stateFile(), { force: true }))

  test('a launcher of 1.3.0 writes a code: the message follows x-lang', async () => {
    writeLast({ message: MESSAGES['update.exited-unconfirmed'].th.replace('{exit}', '3'), code: 'update.exited-unconfirmed', params: { exit: 3 } })
    const en = (await admin.json('GET', '/api/admin/update', undefined, EN)).data.last
    expect(en).toMatchObject({ version: '9.9.8', ok: false, code: 'update.exited-unconfirmed', message: 'The process stopped (code 3) before the update was confirmed.' })
    const th = (await admin.json('GET', '/api/admin/update', undefined, { 'x-lang': 'th' })).data.last
    expect(th.message).toBe('โปรเซสหยุดทำงาน (code 3) ก่อนยืนยันการติดตั้ง')
  })

  test('a state written by an older launcher (message only) keeps its message', async () => {
    writeLast({ message: 'โปรเซสหยุดทำงาน (code 1) ก่อนยืนยันการติดตั้ง' })
    for (const lang of ['en', 'th']) {
      expect((await admin.json('GET', '/api/admin/update', undefined, { 'x-lang': lang })).data.last.message).toBe('โปรเซสหยุดทำงาน (code 1) ก่อนยืนยันการติดตั้ง')
    }
    // a code this version does not know (a newer launcher), or broken params: the message as written
    writeLast({ message: 'ข้อความจากเวอร์ชันใหม่', code: 'update.from-the-future', params: {} })
    expect((await admin.json('GET', '/api/admin/update', undefined, EN)).data.last.message).toBe('ข้อความจากเวอร์ชันใหม่')
    writeLast({ message: 'x', code: 'update.installed', params: 'nonsense' })
    expect((await admin.json('GET', '/api/admin/update', undefined, EN)).data.last.message).toBe('Installed successfully.')
  })

  test('the state.json schema stays readable both ways', async () => {
    const { readState, writeState } = await import('../src/release')
    // what 1.3.0 writes still has every field 1.2.0 reads, with the same types
    writeLast({ message: 'ติดตั้งสำเร็จ', code: 'update.installed', params: {} })
    const s = readState(config.dataDir)
    expect(typeof s.last!.message).toBe('string')
    writeState(config.dataDir, s)
    const raw = JSON.parse(readFileSync(stateFile(), 'utf8'))
    expect(raw).toMatchObject({ schema: 1, current: null, history: [], pending: null, last: { message: 'ติดตั้งสำเร็จ', code: 'update.installed', ok: false } })
  })
})
