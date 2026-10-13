/**
 * Signed update packages (UPDATE_PUBLIC_KEY, the built-in key, UPDATE_ALLOW_UNSIGNED). Runs the app as child processes with different keys and stages
 * packages through the HTTP API the way the web page does. Staging and the signature checks run none of the
 * package's code, so no launcher is needed: FC_SUPERVISED=1 only unlocks the update routes.
 * Needs web/dist (bun --bun run build): the signed package is built by the real scripts/package.ts --skip-web.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import { BUILTIN_UPDATE_KEY } from '../src/update-key'

const root = resolve(import.meta.dir, '..')
const base = mkdtempSync(join(tmpdir(), 'fc-sign-'))
const PASSWORD = 'sign-test-pass'
const enc = new TextEncoder()

/** the key the server trusts, made by the real script; another one for "signed by someone else" */
let trustedPublic = ''
let trustedPrivate: KeyObject
const other = generateKeyPairSync('ed25519')

type Server = { port: number; data: string; proc: ReturnType<typeof Bun.spawn>; stderr: () => string; cookie: string; csrf: string }

async function startServer(name: string, publicKey: string, extraEnv: Record<string, string> = {}): Promise<Server> {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const port = probe.port!
  await probe.stop(true)
  const dir = join(base, name)
  const proc = Bun.spawn([process.execPath, join(root, 'src', 'index.ts')], {
    cwd: root,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH!, HOME: process.env.HOME ?? base, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1',
      STORAGE_DIR: join(dir, 'storage'), DATA_DIR: join(dir, 'data'), ADMIN_PASSWORD: PASSWORD, MIN_FREE_SPACE: '0',
      FC_SUPERVISED: '1', UPDATE_PUBLIC_KEY: publicKey, ...extraEnv,
    },
  })
  let log = ''
  void (async () => {
    const dec = new TextDecoder()
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) log += dec.decode(chunk)
  })()
  const s: Server = { port, data: join(dir, 'data'), proc, stderr: () => log, cookie: '', csrf: '' }
  const end = Date.now() + 30_000
  while (Date.now() < end) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })).ok) break
    } catch { /* not up yet */ }
    if (proc.exitCode !== null) throw new Error(`server ${name} exited: ${log}`)
    await Bun.sleep(200)
  }
  s.csrf = (await api(s, 'GET', '/api/session')).data.csrf
  const r = await api(s, 'POST', '/api/login', { username: 'admin', password: PASSWORD })
  expect(r.status).toBe(200)
  s.csrf = r.data.csrf
  return s
}

async function api(s: Server, method: string, path: string, body?: any) {
  const headers: Record<string, string> = { cookie: s.cookie, 'x-csrf-token': s.csrf }
  let payload: any = body
  if (body !== undefined && !(body instanceof Uint8Array)) {
    payload = JSON.stringify(body)
    headers['content-type'] = 'application/json'
  }
  const res = await fetch(`http://127.0.0.1:${s.port}${path}`, { method, headers, body: payload })
  const set = res.headers.get('set-cookie')
  if (set) s.cookie = set.split(';')[0]
  return { status: res.status, data: (await res.json().catch(() => null)) as any }
}

async function stage(s: Server, zip: Uint8Array) {
  const init = await api(s, 'POST', '/api/admin/update/upload', { size: zip.length })
  expect(init.status).toBe(200)
  const { id, chunkSize, total } = init.data
  for (let i = 0; i < total; i++) expect((await api(s, 'PUT', `/api/upload/${id}/${i}`, zip.slice(i * chunkSize, (i + 1) * chunkSize))).status).toBe(200)
  return api(s, 'POST', '/api/admin/update/stage', { id })
}

/** a package like scripts/package.ts makes, from hand-made files; `sig` replaces the signature with any text */
function makePackage(opts: { version: string; key?: KeyObject; sig?: string; editAfterSigning?: boolean }) {
  const files: Record<string, Uint8Array> = {
    'server.js': enc.encode('console.log("hello")'),
    'web/index.html': enc.encode('<!doctype html><title>test</title>'),
  }
  const manifest = {
    name: 'file-center', version: opts.version, builtAt: new Date().toISOString(), notes: 'signed test',
    files: Object.fromEntries(Object.entries(files).map(([p, d]) => [p, { size: d.length, sha256: createHash('sha256').update(d).digest('hex') }])),
  }
  const bytes = enc.encode(JSON.stringify(manifest))
  const entries: Record<string, Uint8Array> = { 'manifest.json': bytes, ...files }
  if (opts.key) entries['manifest.sig'] = enc.encode(sign(null, bytes, opts.key).toString('base64'))
  if (opts.sig !== undefined) entries['manifest.sig'] = enc.encode(opts.sig)
  // still a valid manifest for the files, only the notes differ from what was signed
  if (opts.editAfterSigning) entries['manifest.json'] = enc.encode(JSON.stringify({ ...manifest, notes: 'changed after signing' }))
  return zipSync(entries)
}

const servers: Server[] = []

describe('signed update packages', () => {
  let keyed: Server
  let realSigned: Uint8Array

  beforeAll(async () => {
    if (!existsSync(join(root, 'web', 'dist', 'index.html'))) throw new Error('web/dist is missing: run "bun --bun run build" first')
    const keys = join(base, 'keys')
    const gen = Bun.spawnSync([process.execPath, join(root, 'scripts', 'package.ts'), '--gen-key', keys], { cwd: root })
    expect(gen.exitCode).toBe(0)
    trustedPublic = gen.stdout.toString().trim()
    trustedPrivate = createPrivateKey(readFileSync(join(keys, 'update-signing.key')))
    const built = Bun.spawnSync([
      process.execPath, join(root, 'scripts', 'package.ts'), '--skip-web', '--version', '9.9.9', '--out', join(base, 'real'),
      '--sign', join(keys, 'update-signing.key'),
    ], { cwd: root })
    expect(built.exitCode).toBe(0)
    realSigned = new Uint8Array(readFileSync(join(base, 'real', 'file-center-9.9.9.zip')))
    keyed = await startServer('keyed', trustedPublic)
    servers.push(keyed)
  }, 60_000)

  afterAll(async () => {
    for (const s of servers) {
      s.proc.kill('SIGTERM')
      await Promise.race([s.proc.exited, Bun.sleep(10_000)])
    }
    rmSync(base, { recursive: true, force: true })
  })

  describe('bun run package', () => {
    test('--gen-key writes a private key only its owner can read and prints the public key on one line', () => {
      const file = join(base, 'keys', 'update-signing.key')
      expect(readFileSync(file, 'utf8')).toContain('-----BEGIN PRIVATE KEY-----')
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(trustedPublic).toMatch(/^[A-Za-z0-9+/=]+$/)
      const pub = createPublicKey({ key: Buffer.from(trustedPublic, 'base64'), format: 'der', type: 'spki' })
      expect(pub.asymmetricKeyType).toBe('ed25519')
      expect(createPublicKey(trustedPrivate).export({ type: 'spki', format: 'der' }).toString('base64')).toBe(trustedPublic)
    })

    test('--gen-key never overwrites an existing key', () => {
      const file = join(base, 'keys', 'update-signing.key')
      const before = readFileSync(file, 'utf8')
      const again = Bun.spawnSync([process.execPath, join(root, 'scripts', 'package.ts'), '--gen-key', join(base, 'keys')], { cwd: root })
      expect(again.exitCode).not.toBe(0)
      expect(readFileSync(file, 'utf8')).toBe(before)
      expect(readdirSync(join(base, 'keys'))).toEqual(['update-signing.key'])
    })

    test('--sign adds manifest.sig, the signature of the exact manifest.json bytes', () => {
      const entries = unzipSync(realSigned)
      expect(Object.keys(entries)).toContain('manifest.sig')
      const sig = Buffer.from(new TextDecoder().decode(entries['manifest.sig']), 'base64')
      const pub = createPublicKey({ key: Buffer.from(trustedPublic, 'base64'), format: 'der', type: 'spki' })
      expect(verify(null, entries['manifest.json'], pub, sig)).toBe(true)
    })
  })

  describe('with UPDATE_PUBLIC_KEY set', () => {
    test('the update page knows a signature is required', async () => {
      const s = await api(keyed, 'GET', '/api/admin/update')
      expect(s.status).toBe(200)
      expect(s.data).toMatchObject({ signatureRequired: true, allowUnsigned: false, builtinKey: false })
    })

    test('a package signed with the key is accepted', async () => {
      const r = await stage(keyed, realSigned)
      expect(r.status).toBe(200)
      expect(r.data).toMatchObject({ version: '9.9.9', signed: true, signatureVerified: true, tested: false })
      expect((await api(keyed, 'DELETE', `/api/admin/update/staged/${r.data.id}`)).status).toBe(200)
    }, 20_000)

    test('an unsigned package is refused', async () => {
      const r = await stage(keyed, makePackage({ version: '9.1.0' }))
      expect(r.status).toBe(400)
      expect(r.data.error).toContain('ไม่มีลายเซ็น')
    })

    test('a package signed with another key is refused', async () => {
      const r = await stage(keyed, makePackage({ version: '9.1.0', key: other.privateKey }))
      expect(r.status).toBe(400)
      expect(r.data.error).toContain('ลายเซ็นของแพ็กเกจไม่ถูกต้อง')
    })

    test('a manifest changed after signing is refused', async () => {
      const r = await stage(keyed, makePackage({ version: '9.1.0', key: trustedPrivate, editAfterSigning: true }))
      expect(r.status).toBe(400)
      expect(r.data.error).toContain('ลายเซ็นของแพ็กเกจไม่ถูกต้อง')
    })

    test('a signature that is not a signature at all is refused', async () => {
      for (const sig of ['', 'not base64 at all!!', 'A'.repeat(5000)]) {
        const r = await stage(keyed, makePackage({ version: '9.1.0', sig }))
        expect(r.status).toBe(400)
        expect(r.data.error).toContain('ลายเซ็น')
      }
    })

    test('installing checks the signature again', async () => {
      const staged = await stage(keyed, makePackage({ version: '9.1.0', key: trustedPrivate }))
      expect(staged.status).toBe(200)
      expect(staged.data.signatureVerified).toBe(true)
      // someone with access to the disk swaps the manifest between staging and installing
      const file = join(keyed.data, 'app', 'staging', staged.data.id, 'manifest.json')
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), notes: 'swapped' }))
      const r = await api(keyed, 'POST', '/api/admin/update/apply', { id: staged.data.id, password: PASSWORD })
      expect(r.status).toBe(400)
      expect(r.data.error).toContain('ลายเซ็นของแพ็กเกจไม่ถูกต้อง')
      expect(existsSync(join(keyed.data, 'app', 'releases'))).toBe(false)
      expect(keyed.proc.exitCode).toBeNull()
    })
  })

  test('an invalid UPDATE_PUBLIC_KEY does not stop the app, it refuses every package', async () => {
    const bad = await startServer('bad-key', 'this-is-not-a-key')
    servers.push(bad)
    expect(bad.proc.exitCode).toBeNull()
    expect(bad.stderr()).toContain('UPDATE_PUBLIC_KEY')
    expect((await api(bad, 'GET', '/api/admin/update')).data.signatureRequired).toBe(true)
    for (const zip of [realSigned, makePackage({ version: '9.1.0' })]) {
      const r = await stage(bad, zip)
      expect(r.status).toBe(400)
      expect(r.data.error).toContain('UPDATE_PUBLIC_KEY ไม่ถูกต้อง')
    }
    // a key of the wrong kind is just as unusable
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const wrongKind = await startServer('rsa-key', rsa)
    servers.push(wrongKind)
    const r = await stage(wrongKind, realSigned)
    expect(r.status).toBe(400)
    expect(r.data.error).toContain('Ed25519')
  }, 60_000)

  describe('without UPDATE_PUBLIC_KEY the key built into File Center is used', () => {
    let builtin: Server

    test('the built-in key is a readable Ed25519 public key', () => {
      const pub = createPublicKey({ key: Buffer.from(BUILTIN_UPDATE_KEY, 'base64'), format: 'der', type: 'spki' })
      expect(pub.asymmetricKeyType).toBe('ed25519')
    })

    test('a package signed with a throw-away key or not at all is refused', async () => {
      builtin = await startServer('builtin', '')
      servers.push(builtin)
      expect(builtin.stderr()).not.toContain('update-key-invalid')
      const s = (await api(builtin, 'GET', '/api/admin/update')).data
      expect(s).toMatchObject({ signatureRequired: true, allowUnsigned: false, builtinKey: true })
      const wrong = await stage(builtin, realSigned)
      expect(wrong.status).toBe(400)
      expect(wrong.data.error).toContain('ลายเซ็นของแพ็กเกจไม่ถูกต้อง')
      const none = await stage(builtin, makePackage({ version: '9.1.0' }))
      expect(none.status).toBe(400)
      expect(none.data.error).toContain('ไม่มีลายเซ็น')
    }, 40_000)
  })

  // kept under its old name: what changed is that "without a key" means the built-in key, so only UPDATE_ALLOW_UNSIGNED lets unsigned in
  test('without a key, unsigned and signed packages are both accepted; the signature is not checked', async () => {
    const open = await startServer('no-key', '', { UPDATE_ALLOW_UNSIGNED: 'true' })
    servers.push(open)
    expect((await api(open, 'GET', '/api/admin/update')).data).toMatchObject({ signatureRequired: false, builtinKey: true })
    const unsigned = await stage(open, makePackage({ version: '9.1.0' }))
    expect(unsigned.status).toBe(200)
    expect(unsigned.data).toMatchObject({ signed: false, signatureVerified: false })
    // a signature that is there is still checked, against the built-in key
    expect((await stage(open, realSigned)).status).toBe(400)
  }, 40_000)

  describe('UPDATE_ALLOW_UNSIGNED=true', () => {
    test('accepts an unsigned package, still checks a signature that is there, warns, and audits the install', async () => {
      const open = await startServer('allow-unsigned', trustedPublic, { UPDATE_ALLOW_UNSIGNED: 'true' })
      servers.push(open)
      // warned at startup, on the update page and on the dashboard
      expect(open.stderr()).toContain('update-allow-unsigned')
      const s = (await api(open, 'GET', '/api/admin/update')).data
      expect(s).toMatchObject({ signatureRequired: false, allowUnsigned: true })
      const warnings = (await api(open, 'GET', '/api/admin/status')).data.warnings as { code: string }[]
      expect(warnings.map(w => w.code)).toContain('update.allow-unsigned')

      // a signature that is there must still verify
      const wrong = await stage(open, makePackage({ version: '9.1.0', key: other.privateKey }))
      expect(wrong.status).toBe(400)
      expect(wrong.data.error).toContain('ลายเซ็นของแพ็กเกจไม่ถูกต้อง')
      const good = await stage(open, realSigned)
      expect(good.data).toMatchObject({ signed: true, signatureVerified: true })

      // an unsigned one is staged, installed after the password, and the install is audited as unsigned
      const built = Bun.spawnSync([process.execPath, join(root, 'scripts', 'package.ts'), '--skip-web', '--version', '9.9.8', '--out', join(base, 'unsigned')], { cwd: root })
      expect(built.exitCode).toBe(0)
      const staged = await stage(open, new Uint8Array(readFileSync(join(base, 'unsigned', 'file-center-9.9.8.zip'))))
      expect(staged.status).toBe(200)
      expect(staged.data).toMatchObject({ version: '9.9.8', signed: false, signatureVerified: false })
      const r = await api(open, 'POST', '/api/admin/update/apply', { id: staged.data.id, password: PASSWORD })
      expect(r.status).toBe(200)
      const entries = (await api(open, 'GET', '/api/admin/activity?action=update-apply-unsigned')).data.items
      expect(entries[0]).toMatchObject({ user: 'admin', detail: '9.9.8' })
    }, 90_000)
  })
})
