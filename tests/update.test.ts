/**
 * End to end: the real launcher runs the real app as child processes, and updates are installed through the HTTP API
 * the way the web page does it. Needs web/dist (bun --bun run build).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { zipSync } from 'fflate'
import { makeTestKey, signManifest, writeKeyFile } from './update-keys'

const root = resolve(import.meta.dir, '..')
const hasWeb = existsSync(join(root, 'web', 'dist', 'index.html'))
const base = mkdtempSync(join(tmpdir(), 'fc-update-'))
const dirs = { storage: join(base, 'storage'), data: join(base, 'data'), pkgs: join(base, 'pkgs') }
const PASSWORD = 'update-test-pass'
// packages must be signed: this file signs with a throw-away key and the launcher trusts its public key
const testKey = makeTestKey()
const keyFile = join(base, 'update-signing.key')
const BUILTIN = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string

let port = 0
let launcher: ReturnType<typeof Bun.spawn> | undefined
const url = (p: string) => `http://127.0.0.1:${port}${p}`

/** UPDATE_SOURCE of the launcher: plays the `updates` branch, serving whatever is in `published` */
const published = new Map<string, Uint8Array | string>()
const source = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  fetch: req => {
    const body = published.get(new URL(req.url).pathname)
    return body === undefined ? new Response('not found', { status: 404 }) : new Response(body)
  },
})

class Session {
  cookie = ''
  csrf = ''
}
const admin = new Session()

async function api(method: string, path: string, body?: any, raw = false, who = admin, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra, cookie: who.cookie, 'x-csrf-token': who.csrf }
  let payload: any = body
  if (body !== undefined && !(body instanceof Uint8Array)) {
    payload = JSON.stringify(body)
    headers['content-type'] = 'application/json'
  }
  const res = await fetch(url(path), { method, headers, body: payload })
  const set = res.headers.get('set-cookie')
  if (set) who.cookie = set.split(';')[0]
  if (raw) return res
  return { status: res.status, data: (await res.json().catch(() => null)) as any }
}

const health = async () => {
  try { return (await (await fetch(url('/api/health'), { signal: AbortSignal.timeout(1500) })).json()) as any } catch { return null }
}

async function until<T>(fn: () => Promise<T | null | false>, ms = 60_000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await Bun.sleep(300)
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function startLauncher() {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  port = probe.port!
  await probe.stop(true)
  launcher = Bun.spawn([process.execPath, join(root, 'src', 'launcher.ts')], {
    cwd: root,
    stdout: 'ignore',
    stderr: 'inherit',
    env: {
      PATH: process.env.PATH!, HOME: process.env.HOME ?? base, NODE_ENV: 'production',
      PORT: String(port), HOST: '127.0.0.1', STORAGE_DIR: dirs.storage, DATA_DIR: dirs.data,
      ADMIN_PASSWORD: PASSWORD, UPLOAD_CHUNK_SIZE: String(1024 * 1024), MIN_FREE_SPACE: '0',
      FC_STABLE_MS: '1500', FC_HEALTH_TIMEOUT_MS: '15000', LOGIN_MAX_ATTEMPTS: '3', LOGIN_LOCKOUT_SECONDS: '3',
      UPDATE_PUBLIC_KEY: testKey.publicKey, UPDATE_SOURCE: `http://127.0.0.1:${source.port}/updates`,
    },
  })
  await until(async () => (await health())?.status === 'ok', 30_000, 'app start')
}

async function login(who: Session, username: string, password: string) {
  who.cookie = ''
  who.csrf = ''
  who.csrf = (await api('GET', '/api/session', undefined, false, who)).data.csrf
  const r = await api('POST', '/api/login', { username, password }, false, who)
  expect(r.status).toBe(200)
  who.csrf = r.data.csrf
}

/** build a package the way scripts/package.ts does, but from hand-made files */
function makePackage(name: string, opts: { version: string; server: string; extra?: Record<string, string>; tamper?: boolean; tamperSameSize?: boolean }) {
  const enc = new TextEncoder()
  const files: Record<string, Uint8Array> = {
    'server.js': enc.encode(opts.server),
    'web/index.html': readFileSync(join(root, 'web', 'dist', 'index.html')),
  }
  const manifest = {
    name: 'file-center', version: opts.version, builtAt: new Date().toISOString(), notes: 'test',
    files: Object.fromEntries(Object.entries(files).map(([p, d]) => [p, { size: d.length, sha256: createHash('sha256').update(d).digest('hex') }])),
  }
  const manifestBytes = enc.encode(JSON.stringify(manifest))
  const entries: Record<string, Uint8Array> = { 'manifest.json': manifestBytes, 'manifest.sig': enc.encode(signManifest(manifestBytes, testKey)), ...files }
  if (opts.tamper) entries['server.js'] = enc.encode('console.log("evil")')
  // same length, different bytes: only the SHA-256 can tell
  if (opts.tamperSameSize) entries['server.js'] = enc.encode(opts.server.replace(/1/g, '2'))
  for (const [p, c] of Object.entries(opts.extra ?? {})) entries[p] = enc.encode(c)
  const file = join(dirs.pkgs, name)
  writeFileSync(file, zipSync(entries))
  return file
}

async function sendPackage(file: string) {
  const bytes = new Uint8Array(readFileSync(file))
  const init = await api('POST', '/api/admin/update/upload', { size: bytes.length })
  expect(init.status).toBe(200)
  const { id, chunkSize, total } = init.data
  for (let i = 0; i < total; i++) {
    const r = await api('PUT', `/api/upload/${id}/${i}`, bytes.slice(i * chunkSize, (i + 1) * chunkSize), true) as Response
    expect(r.status).toBe(200)
  }
  return api('POST', '/api/admin/update/stage', { id })
}

// on CI a missing build is a broken setup, not a reason to skip: these tests guard the update path
if (!hasWeb && process.env.CI) throw new Error('web/dist is missing: run `bun --bun run build` before the tests')
const suite = hasWeb ? describe : describe.skip

suite('update from the web', () => {
  beforeAll(async () => {
    mkdirSync(dirs.pkgs, { recursive: true })
    writeKeyFile(testKey, keyFile)
    // the real thing: bundle this source tree as version 9.9.9
    const built = Bun.spawnSync([process.execPath, join(root, 'scripts', 'package.ts'), '--skip-web', '--version', '9.9.9', '--out', join(dirs.pkgs, 'real'), '--notes', 'e2e', '--sign', keyFile], { cwd: root })
    expect(built.exitCode).toBe(0)
    await startLauncher()
    await login(admin, 'admin', PASSWORD)
  }, 60_000)

  afterAll(async () => {
    launcher?.kill('SIGTERM')
    await Promise.race([launcher?.exited, Bun.sleep(15_000)])
    source.stop(true)
    rmSync(base, { recursive: true, force: true })
  })

  test('starts on the built-in version and reports update status', async () => {
    const h = await health()
    expect(h.version).toBe(BUILTIN)
    expect(h.release).toBeNull()
    const s = await api('GET', '/api/admin/update')
    expect(s.status).toBe(200)
    expect(s.data).toMatchObject({ enabled: true, supervised: true, runningVersion: BUILTIN, runningRelease: null, history: [] })
  })

  test('only an admin may use it', async () => {
    expect((await fetch(url('/api/admin/update'))).status).toBe(401)
    const made = await api('POST', '/api/admin/users', { username: 'bob', name: 'Bob', password: 'tall-oak-tree-1', role: 'user', permissions: ['read', 'upload', 'write'], publicPermissions: [] })
    expect(made.status).toBe(200)
    const bob = new Session()
    await login(bob, 'bob', 'tall-oak-tree-1')
    expect((await api('GET', '/api/admin/update', undefined, false, bob)).status).toBe(403)
    expect((await api('POST', '/api/admin/update/upload', { size: 10 }, false, bob)).status).toBe(403)
    expect((await api('POST', '/api/admin/update/apply', { id: 'x', password: 'tall-oak-tree-1' }, false, bob)).status).toBe(403)
  })

  test('staging runs none of the package\'s code; that waits for the password', async () => {
    const marker = join(base, 'stage-ran-code')
    const server = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`
    const staged = await sendPackage(makePackage('marker.zip', { version: '9.3.0', server }))
    expect(staged.status).toBe(200)
    expect(staged.data).toMatchObject({ version: '9.3.0', runningVersion: BUILTIN, tested: false })
    await Bun.sleep(1000)
    expect(existsSync(marker)).toBe(false)
    expect((await api('DELETE', `/api/admin/update/staged/${staged.data.id}`)).status).toBe(200)
  })

  describe('rejects bad packages', () => {
    test('not a zip', async () => {
      const f = join(dirs.pkgs, 'junk.zip')
      writeFileSync(f, 'this is not a zip file')
      const r = await sendPackage(f)
      expect(r.status).toBe(400)
    })
    test('files that do not match the manifest', async () => {
      const r = await sendPackage(makePackage('tamper.zip', { version: '9.1.0', server: 'console.log(1)', tamper: true }))
      expect(r.status).toBe(400)
      expect(r.data.error).toContain('server.js')
    })
    test('a file with the listed size but different content', async () => {
      const r = await sendPackage(makePackage('same-size.zip', { version: '9.1.0', server: 'console.log(1)', tamperSameSize: true }))
      expect(r.status).toBe(400)
      expect(r.data.error).toContain('server.js')
    })
    test('files the manifest does not list', async () => {
      const r = await sendPackage(makePackage('extra.zip', { version: '9.1.0', server: 'console.log(1)', extra: { 'web/extra.js': 'x' } }))
      expect(r.status).toBe(400)
    })
    test('paths that climb out of the package', async () => {
      const r = await sendPackage(makePackage('slip.zip', { version: '9.1.0', server: 'console.log(1)', extra: { '../../evil.js': 'x' } }))
      expect(r.status).toBe(400)
      expect(existsSync(join(base, 'evil.js'))).toBe(false)
    })
    test('a version that is not newer', async () => {
      const r = await sendPackage(makePackage('old.zip', { version: BUILTIN, server: 'console.log(1)' }))
      expect(r.status).toBe(400)
      expect(r.data.error).toContain('ไม่ใหม่กว่า')
    })
    test('a server that does not start is caught before installing', async () => {
      const staged = await sendPackage(makePackage('broken.zip', { version: '9.2.0', server: 'throw new Error("boom from the new version")' }))
      expect(staged.status).toBe(200)
      expect(staged.data.tested).toBe(false)
      const before = (await health()).boot
      // the test run happens on install, after the password
      const r = await api('POST', '/api/admin/update/apply', { id: staged.data.id, password: PASSWORD })
      expect(r.status).toBe(400)
      expect(r.data.error).toContain('เริ่มทำงานไม่สำเร็จ')
      expect(r.data.error).toContain('boom')
      const h = await health()
      expect(h.version).toBe(BUILTIN)
      expect(h.boot).toBe(before)
      const s = (await api('GET', '/api/admin/update')).data
      expect(s).toMatchObject({ runningVersion: BUILTIN, pending: null, history: [] })
      expect(existsSync(join(dirs.data, 'app', 'releases'))).toBe(false)
      // and it is gone: it can not be tried again
      expect((await api('POST', '/api/admin/update/apply', { id: staged.data.id, password: PASSWORD })).status).toBe(404)
    }, 40_000)
  })

  test('installing needs the password again, and wrong guesses lock it', async () => {
    const staged = await sendPackage(join(dirs.pkgs, 'real', 'file-center-9.9.9.zip'))
    expect(staged.status).toBe(200)
    expect(staged.data).toMatchObject({ version: '9.9.9', runningVersion: BUILTIN })
    const before = (await health()).boot
    for (let i = 0; i < 3; i++) {
      expect((await api('POST', '/api/admin/update/apply', { id: staged.data.id, password: 'wrong-password' })).status).toBe(403)
    }
    // locked: even the right password has to wait
    expect((await api('POST', '/api/admin/update/apply', { id: staged.data.id, password: PASSWORD })).status).toBe(429)
    expect((await health()).boot).toBe(before)
    await api('DELETE', `/api/admin/update/staged/${staged.data.id}`)
    // a discarded package can not be installed
    await Bun.sleep(3500)
    const gone = await api('POST', '/api/admin/update/apply', { id: staged.data.id, password: PASSWORD })
    expect(gone.status).toBe(404)
  }, 40_000)

  test('a good update goes live, keeps the data, and can be rolled back', async () => {
    const staged = await sendPackage(join(dirs.pkgs, 'real', 'file-center-9.9.9.zip'))
    expect(staged.status).toBe(200)
    const before = (await health()).boot
    const r = await api('POST', '/api/admin/update/apply', { id: staged.data.id, password: PASSWORD })
    expect(r.status).toBe(200)
    expect(r.data.restarting).toBe(true)

    const after = await until(async () => {
      const h = await health()
      return h && h.boot !== before ? h : null
    }, 40_000, 'restart')
    expect(after.version).toBe('9.9.9')
    expect(after.release).toMatch(/^9\.9\.9-/)

    // the login survived the restart
    const me = await api('GET', '/api/session')
    expect(me.data.user.username).toBe('admin')
    expect(me.data.config.version).toBe('9.9.9')
    expect((await fetch(url('/'))).status).toBe(200)

    // the launcher confirms the update once it has been stable for a moment
    const status = await until(async () => {
      const s = await api('GET', '/api/admin/update')
      return s.data.last?.ok ? s.data : null
    }, 20_000, 'confirmation')
    expect(status.pending).toBeNull()
    expect(status.runningVersion).toBe('9.9.9')

    // the SHA-256 of the installed server.js is recorded for the launcher to check at the next start
    const installed = JSON.parse(readFileSync(join(dirs.data, 'app', 'state.json'), 'utf8'))
    expect(installed.serverHashes[after.release]).toBe(new Bun.CryptoHasher('sha256').update(readFileSync(join(dirs.data, 'app', 'releases', after.release, 'server.js'))).digest('hex'))

    // back to what came with the image
    const back = await api('POST', '/api/admin/update/rollback', { dir: 'builtin', password: PASSWORD })
    expect(back.status).toBe(200)
    const h = await until(async () => {
      const x = await health()
      return x && x.version === BUILTIN ? x : null
    }, 40_000, 'rollback')
    expect(h.release).toBeNull()
    const s2 = (await api('GET', '/api/admin/update')).data
    expect(s2.history.map((x: any) => x.version)).toEqual(['9.9.9'])
  }, 120_000)

  test('the launcher itself goes back when an installed update will not start', async () => {
    // simulate an update that passed the check but fails on the real data: install it by hand, as the API would
    const dir = join(dirs.data, 'app', 'releases', '9.9.8-deadbeef')
    mkdirSync(join(dir, 'web'), { recursive: true })
    writeFileSync(join(dir, 'server.js'), 'console.error("cannot open users.json"); process.exit(3)')
    writeFileSync(join(dir, 'web', 'index.html'), '<html></html>')
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'file-center', version: '9.9.8', builtAt: '', files: {} }))
    const state = JSON.parse(readFileSync(join(dirs.data, 'app', 'state.json'), 'utf8'))
    writeFileSync(join(dirs.data, 'app', 'state.json'), JSON.stringify({ ...state, current: '9.9.8-deadbeef', pending: { dir: '9.9.8-deadbeef', previous: null, at: new Date().toISOString() }, last: null }))

    // crash the app: the launcher restarts it, picks up the new state, and 9.9.8 must be rejected
    // the launcher's own child only: matching by command line could hit another app run from this folder
    const pid = (await Bun.$`pgrep -P ${launcher!.pid}`.nothrow().text()).trim().split('\n')[0]
    expect(pid).toBeTruthy()
    process.kill(Number(pid), 'SIGKILL')

    const s = await until(async () => {
      const x = await api('GET', '/api/admin/update').catch(() => null)
      return x?.status === 200 && x.data.last && !x.data.last.ok ? x.data : null
    }, 60_000, 'rollback by the launcher')
    expect(s.last.version).toBe('9.9.8')
    expect(s.last.message).toContain('code 3')
    // the launcher wrote a code, so the page gets it in its own language
    const en = (await api('GET', '/api/admin/update', undefined, false, admin, { 'x-lang': 'en' })).data.last
    expect(en.message).toBe('The process stopped (code 3) before the update was confirmed.')
    expect(s.runningVersion).toBe(BUILTIN)
    expect(existsSync(dir)).toBe(false)
  }, 90_000)

  test('a package published at UPDATE_SOURCE is fetched, staged and installed', async () => {
    const zip = new Uint8Array(readFileSync(join(dirs.pkgs, 'real', 'file-center-9.9.9.zip')))
    published.set('/updates/file-center-9.9.9.zip', zip)
    published.set('/updates/latest.json', JSON.stringify({
      version: '9.9.9', file: 'file-center-9.9.9.zip', sha256: createHash('sha256').update(zip).digest('hex'), size: zip.length,
      builtAt: new Date().toISOString(), commit: 'abc1234', notes: 'e2e', signed: true,
    }))
    const status = (await api('GET', '/api/admin/update')).data
    expect(status.source).toEqual({ enabled: true, url: `http://127.0.0.1:${source.port}/updates` })
    const check = await api('GET', '/api/admin/update/check')
    expect(check.data).toMatchObject({ enabled: true, current: BUILTIN, latest: { version: '9.9.9', signed: true }, newer: true })

    const staged = await api('POST', '/api/admin/update/fetch')
    expect(staged.status).toBe(200)
    expect(staged.data).toMatchObject({ version: '9.9.9', runningVersion: BUILTIN, tested: false })
    const before = (await health()).boot
    // installing is the same as for an uploaded package: the password again
    expect((await api('POST', '/api/admin/update/apply', { id: staged.data.id, password: 'wrong-password' })).status).toBe(403)
    const r = await api('POST', '/api/admin/update/apply', { id: staged.data.id, password: PASSWORD })
    expect(r.status).toBe(200)
    const after = await until(async () => {
      const h = await health()
      return h && h.boot !== before && h.version === '9.9.9' ? h : null
    }, 40_000, 'restart onto the fetched version')
    expect(after.release).toMatch(/^9\.9\.9-/)
    // confirmed by the launcher, and told in the page's language
    const done = await until(async () => {
      const s = await api('GET', '/api/admin/update', undefined, false, admin, { 'x-lang': 'en' })
      return s.data?.last?.ok ? s.data : null
    }, 20_000, 'confirmation')
    expect(done.last).toMatchObject({ version: '9.9.9', ok: true, code: 'update.installed', message: 'Installed successfully.' })
    expect((await api('GET', '/api/admin/update', undefined, false, admin, { 'x-lang': 'th' })).data.last.message).toBe('ติดตั้งสำเร็จ')
    // nothing newer is left to fetch
    expect((await api('GET', '/api/admin/update/check')).data).toMatchObject({ current: '9.9.9', newer: false })
  }, 90_000)

  test('one step: the published version is checked, fetched, staged, tested and installed after one password', async () => {
    // runs on 9.9.9 from the test before; the next version is this source tree again, as 9.9.10
    const built = Bun.spawnSync([process.execPath, join(root, 'scripts', 'package.ts'), '--skip-web', '--version', '9.9.10', '--out', join(dirs.pkgs, 'next'), '--notes', 'one step', '--sign', keyFile], { cwd: root })
    expect(built.exitCode).toBe(0)
    const zip = new Uint8Array(readFileSync(join(dirs.pkgs, 'next', 'file-center-9.9.10.zip')))
    published.set('/updates/file-center-9.9.10.zip', zip)
    published.set('/updates/latest.json', JSON.stringify({
      version: '9.9.10', file: 'file-center-9.9.10.zip', sha256: createHash('sha256').update(zip).digest('hex'), size: zip.length,
      builtAt: new Date().toISOString(), commit: 'abc1234', notes: 'one step', signed: true,
    }))
    const before = (await health()).boot
    const denied = await api('POST', '/api/admin/update/fetch-and-apply', { password: 'wrong-password' })
    expect([denied.status, denied.data.code]).toEqual([403, 'auth.wrong-password'])
    const r = await api('POST', '/api/admin/update/fetch-and-apply', { password: PASSWORD })
    expect([r.status, r.data]).toEqual([200, { ok: true, version: '9.9.10', restarting: true }])
    const after = await until(async () => {
      const h = await health()
      return h && h.boot !== before && h.version === '9.9.10' ? h : null
    }, 40_000, 'restart onto 9.9.10')
    expect(after.release).toMatch(/^9\.9\.10-/)
    const done = await until(async () => {
      const s = await api('GET', '/api/admin/update')
      return s.data?.last?.ok ? s.data : null
    }, 20_000, 'confirmation')
    expect(done).toMatchObject({ runningVersion: '9.9.10', pending: null, last: { version: '9.9.10', ok: true } })
    // both halves are in the activity log, as when done one by one
    const audit = async (action: string) => (await api('GET', `/api/admin/activity?action=${action}`)).data.items[0]
    expect(await audit('update-fetch')).toMatchObject({ user: 'admin', detail: '9.9.10' })
    expect(await audit('update-apply')).toMatchObject({ user: 'admin', detail: '9.9.10' })
    // nothing was left staged, and once more there is nothing newer
    expect(existsSync(join(dirs.data, 'app', 'staging')) ? readdirSync(join(dirs.data, 'app', 'staging')) : []).toEqual([])
    const again = await api('POST', '/api/admin/update/fetch-and-apply', { password: PASSWORD })
    expect([again.status, again.data.code, again.data.params.step]).toEqual([400, 'update.source-not-newer', 'check'])
  }, 120_000)
})
