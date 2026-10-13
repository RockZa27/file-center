/**
 * The beta update channel (x.y.z-beta.N, latest-beta.json): version ordering, what /check offers, what /fetch and
 * /fetch-and-apply need to take a beta, and that the daily look and the alert stay with stable versions. Runs
 * in-process against a local HTTP server that plays the `updates` branch, like update-source.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { zipSync } from 'fflate'
import { compareVersions, isBeta, isVersion } from '../src/release'
import { base as _base, updateTestKey } from './in-process-env'
import { signManifest } from './update-keys'

void _base
let app: any
let config: typeof import('../src/config').config
let source: typeof import('../src/update-source')
let alerts: typeof import('../src/alerts')

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
const PASSWORD = () => process.env.ADMIN_PASSWORD!

describe('versions: x.y.z and x.y.z-beta.N', () => {
  test('only those two forms are versions', () => {
    for (const v of ['1.9.0', '1.9.0-beta.1', '10.20.30-beta.12']) expect(isVersion(v)).toBe(true)
    for (const v of ['1.9', '1.9.0-beta', '1.9.0-beta.', '1.9.0-rc.1', '1.9.0-alpha.1', '1.9.0-beta.1.2', '1.9.0+build', '1.9.0-beta.1+x', 'v1.9.0', '1.9.0-Beta.1', '1.9.0-beta.-1', '']) {
      expect(`${v} ${isVersion(v)}`).toBe(`${v} false`)
    }
    expect([isBeta('1.9.0-beta.1'), isBeta('1.9.0'), isBeta('nonsense')]).toEqual([true, false, false])
  })

  test('semver order: beta.1 < beta.2 < beta.10 < release < next release', () => {
    const order = ['1.8.9', '1.9.0-beta.1', '1.9.0-beta.2', '1.9.0-beta.10', '1.9.0', '1.9.1-beta.1', '1.9.1', '1.10.0-beta.1', '2.0.0']
    expect([...order].reverse().sort(compareVersions)).toEqual(order)
    expect(Math.sign(compareVersions('1.9.0-beta.2', '1.9.0'))).toBe(-1)
    expect(Math.sign(compareVersions('1.9.0', '1.9.0-beta.2'))).toBe(1)
    expect(compareVersions('1.9.0-beta.3', '1.9.0-beta.3')).toBe(0)
    expect(Math.sign(compareVersions('1.9.0-beta.9', '1.8.9'))).toBe(1)
  })
})

// ── the "updates branch"
const files = new Map<string, () => Response>()
const requests: string[] = []
let server: ReturnType<typeof Bun.serve>
const at = (p: string) => `http://127.0.0.1:${server.port}/fc/updates${p}`
const enc = new TextEncoder()
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

function makePackage(version: string, signed = true): Uint8Array {
  const content: Record<string, Uint8Array> = { 'server.js': enc.encode('console.log("hi")'), 'web/index.html': enc.encode('<html></html>') }
  const manifest = {
    name: 'file-center', version, builtAt: new Date().toISOString(), notes: 'from the source',
    files: Object.fromEntries(Object.entries(content).map(([p, d]) => [p, { size: d.length, sha256: sha(d) }])),
  }
  const manifestBytes = enc.encode(JSON.stringify(manifest))
  return zipSync({ 'manifest.json': manifestBytes, ...(signed ? { 'manifest.sig': enc.encode(signManifest(manifestBytes, updateTestKey)) } : {}), ...content })
}

/** put a version in latest.json (stable) or latest-beta.json (beta) and its package next to it */
function publish(version: string, opts: { zip?: Uint8Array; latest?: Record<string, unknown> } = {}) {
  const beta = isBeta(version)
  const zip = opts.zip ?? makePackage(version)
  const file = `file-center-${version}.zip`
  const body = {
    version, file, sha256: sha(zip), size: zip.length, builtAt: '2026-10-12T00:00:00.000Z', commit: 'abc1234', notes: `notes ${version}`, signed: true,
    ...(beta ? { channel: 'beta' } : {}), ...opts.latest,
  }
  files.set(beta ? '/latest-beta.json' : '/latest.json', () => Response.json(body))
  files.set(`/${file}`, () => new Response(zip))
}

const saved = { version: '', allowUnsigned: false }
const staged: string[] = []

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config } = await import('../src/config'))
  source = await import('../src/update-source')
  alerts = await import('../src/alerts')
  saved.version = config.version
  saved.allowUnsigned = config.updateAllowUnsigned
  server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch: req => {
      const p = new URL(req.url).pathname
      requests.push(p)
      const h = p.startsWith('/fc/updates/') ? files.get(p.slice('/fc/updates'.length)) : undefined
      return h ? h() : new Response('not found', { status: 404 })
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

afterEach(async () => {
  config.version = saved.version
  config.updateAllowUnsigned = saved.allowUnsigned
  config.updateSource = at('')
  for (const id of staged.splice(0)) await admin.json('DELETE', `/api/admin/update/staged/${id}`)
  files.clear()
  requests.length = 0
})

const check = async () => (await admin.json('GET', '/api/admin/update/check')).data
const warnings = async () => (await admin.json('GET', '/api/admin/status', undefined, { 'x-lang': 'en' })).data.warnings as any[]
const lastAudit = async (action: string) => (await admin.json('GET', `/api/admin/activity?action=${action}`)).data.items[0]

describe('update check: the beta answer', () => {
  test('a beta newer than the running version and the newest stable is offered; latest/newer stay as they are', async () => {
    config.version = '1.8.0'
    publish('1.8.0')
    publish('1.9.0-beta.2', { latest: { notes: 'try me', size: 1234 } })
    const c = await check()
    expect(c.beta).toEqual({ version: '1.9.0-beta.2', notes: 'try me', size: 1234, signed: true, builtAt: '2026-10-12T00:00:00.000Z' })
    expect(c).toMatchObject({ enabled: true, current: '1.8.0', latest: { version: '1.8.0' }, newer: false, refused: false })
    expect(requests).toEqual(['/fc/updates/latest.json', '/fc/updates/latest-beta.json'])
  })

  test('not offered when not newer than the newest stable (equal base version included) or than the running version', async () => {
    config.version = '1.8.0'
    publish('1.9.0')
    publish('1.9.0-beta.2')
    expect((await check()).beta).toBeNull()
    publish('1.9.1-beta.1')
    expect((await check()).beta).toMatchObject({ version: '1.9.1-beta.1' })
    // running a newer beta already
    config.version = '1.9.1-beta.1'
    expect((await check()).beta).toBeNull()
    config.version = '1.9.1-beta.0'
    expect((await check()).beta).toMatchObject({ version: '1.9.1-beta.1' })
  })

  test('no latest-beta.json is null, with no error and no warning in the log', async () => {
    publish('9.1.0')
    const c = await admin.json('GET', '/api/admin/update/check')
    expect([c.status, c.data.beta, c.data.newer, c.data.latest.version]).toEqual([200, null, true, '9.1.0'])
    const logged = (await admin.json('GET', '/api/admin/logs?q=update-beta-check-failed')).data
    expect(JSON.stringify(logged ?? '')).not.toContain('update-beta-check-failed')
  })

  test('a broken latest-beta.json, or a stable version in it, is null: the stable answer still works', async () => {
    publish('9.1.0')
    files.set('/latest-beta.json', () => new Response('{ nope'))
    expect((await check()).beta).toBeNull()
    publish('9.5.0', { latest: { file: 'file-center-9.5.0.zip' } })
    files.set('/latest-beta.json', files.get('/latest.json')!)
    const c = await check()
    expect([c.beta, c.latest.version]).toEqual([null, '9.5.0'])
    // and a beta in latest.json is not a stable release
    files.set('/latest.json', () => Response.json({ version: '9.9.0-beta.1', file: 'file-center-9.9.0-beta.1.zip', sha256: 'a'.repeat(64), size: 5, signed: true }))
    const bad = await admin.json('GET', '/api/admin/update/check')
    expect([bad.status, bad.data.code]).toEqual([502, 'update.source-latest-invalid'])
  })

  test('with the source off the answer still has beta: null', async () => {
    config.updateSource = ''
    expect((await admin.json('GET', '/api/admin/update/check')).data).toEqual({ enabled: false, current: config.version, latest: null, newer: false, refused: false, beta: null })
  })
})

describe('fetching a beta', () => {
  test('without acceptBetaRisk: 400 update.beta-not-accepted, before the password and before anything is asked', async () => {
    publish('9.1.0-beta.1')
    for (const body of [{ password: PASSWORD(), channel: 'beta' }, { password: PASSWORD(), channel: 'beta', acceptBetaRisk: false }]) {
      const r = await admin.json('POST', '/api/admin/update/fetch-and-apply', body, { 'x-lang': 'en' })
      expect([r.status, r.data.code]).toEqual([400, 'update.beta-not-accepted'])
    }
    for (const body of [{ channel: 'beta' }, { channel: 'beta', acceptBetaRisk: false }]) {
      const r = await admin.json('POST', '/api/admin/update/fetch', body)
      expect([r.status, r.data.code]).toEqual([400, 'update.beta-not-accepted'])
    }
    expect(requests).toEqual([])
  })

  test('the stable channel is the default and ignores a beta', async () => {
    publish('9.1.0-beta.1')
    files.set('/latest.json', () => new Response('x', { status: 404 }))
    const r = await admin.json('POST', '/api/admin/update/fetch', {})
    expect(r.status).toBe(502)
    expect(requests).toEqual(['/fc/updates/latest.json'])
    expect((await admin.json('POST', '/api/admin/update/fetch', { channel: 'nightly' })).status).toBe(422)
  })

  test('with acceptBetaRisk a signed beta is downloaded and staged by /fetch', async () => {
    publish('9.0.0')
    publish('9.1.0-beta.1')
    const r = await admin.json('POST', '/api/admin/update/fetch', { channel: 'beta', acceptBetaRisk: true })
    expect([r.status, r.data.version, r.data.signed]).toEqual([200, '9.1.0-beta.1', true])
    staged.push(r.data.id)
    expect(requests).toContain('/fc/updates/file-center-9.1.0-beta.1.zip')
  })

  test('a beta that is not newer than the stable one, or that does not exist, is not fetched', async () => {
    publish('9.1.0')
    publish('9.1.0-beta.2')
    const old = await admin.json('POST', '/api/admin/update/fetch', { channel: 'beta', acceptBetaRisk: true })
    expect([old.status, old.data.code]).toEqual([400, 'update.source-not-newer'])
    files.delete('/latest-beta.json')
    const none = await admin.json('POST', '/api/admin/update/fetch', { channel: 'beta', acceptBetaRisk: true })
    expect([none.status, none.data.code]).toEqual([400, 'update.beta-none'])
    expect(requests.some(p => p.endsWith('.zip'))).toBe(false)
    const both = await admin.json('POST', '/api/admin/update/fetch-and-apply', { password: PASSWORD(), channel: 'beta', acceptBetaRisk: true })
    expect([both.status, both.data.code, both.data.params.step]).toEqual([400, 'update.beta-none', 'check'])
  })

  test('an unsigned beta is refused like an unsigned stable package, with no exception', async () => {
    publish('9.0.0')
    publish('9.1.0-beta.1', { zip: makePackage('9.1.0-beta.1', false), latest: { signed: false } })
    const r = await admin.json('POST', '/api/admin/update/fetch-and-apply', { password: PASSWORD(), channel: 'beta', acceptBetaRisk: true })
    expect([r.status, r.data.code, r.data.params.step]).toEqual([400, 'update.unsigned', 'fetch'])
    // latest-beta.json claims it is signed: staging catches it
    publish('9.1.0-beta.1', { zip: makePackage('9.1.0-beta.1', false) })
    const lie = await admin.json('POST', '/api/admin/update/fetch-and-apply', { password: PASSWORD(), channel: 'beta', acceptBetaRisk: true })
    expect([lie.status, lie.data.code, lie.data.params.step]).toEqual([400, 'update.unsigned', 'stage'])
  })

  test('a damaged beta package fails the sha256 check', async () => {
    publish('9.0.0')
    publish('9.1.0-beta.1', { latest: { sha256: 'b'.repeat(64) } })
    const r = await admin.json('POST', '/api/admin/update/fetch', { channel: 'beta', acceptBetaRisk: true })
    expect([r.status, r.data.code]).toEqual([502, 'update.source-mismatch'])
  })

  test('a wrong password still stops /fetch-and-apply for a beta', async () => {
    publish('9.1.0-beta.1')
    const r = await admin.json('POST', '/api/admin/update/fetch-and-apply', { password: 'wrong-password', channel: 'beta', acceptBetaRisk: true })
    expect([r.status, r.data.code]).toEqual([403, 'auth.wrong-password'])
    expect(requests).toEqual([])
  })
})

describe('running a beta, and the daily look', () => {
  test('on a beta the dashboard warns update.on-beta (th and en) and a newer stable is offered normally', async () => {
    config.version = '1.9.0-beta.2'
    const w = (await warnings()).find(x => x.code === 'update.on-beta')
    expect(w).toEqual({ level: 'warning', code: 'update.on-beta', message: expect.stringContaining('1.9.0-beta.2'), params: { version: '1.9.0-beta.2' } })
    const th = (await admin.json('GET', '/api/admin/status', undefined, { 'x-lang': 'th' })).data.warnings.find((x: any) => x.code === 'update.on-beta')
    expect(th.message).toContain('เบตา')
    publish('1.9.0')
    const c = await check()
    expect([c.newer, c.latest.version, c.beta]).toEqual([true, '1.9.0', null])
    expect(await source.lookForNewVersion()).toBe('1.9.0')
    expect((await warnings()).find(x => x.code === 'update.available')?.params).toEqual({ version: '1.9.0' })
  })

  test('on a stable version there is no on-beta warning', async () => {
    config.version = '1.9.0'
    expect((await warnings()).some(x => x.code === 'update.on-beta')).toBe(false)
  })

  test('the daily look and its alert are stable only: a beta is neither asked for nor announced', async () => {
    config.version = '1.8.0'
    publish('1.8.0')
    publish('1.9.0-beta.1')
    expect(await source.lookForNewVersion()).toBeNull()
    await alerts.checkForNewVersion()
    expect(requests).toEqual(['/fc/updates/latest.json', '/fc/updates/latest.json'])
    expect((await warnings()).some(x => x.code === 'update.available')).toBe(false)
    expect(source.availableVersion()).toBeNull()
  })
})
