/**
 * Encrypted backups (BACKUP_ENCRYPTION_KEY, src/backup-crypt.ts). The stream tests need no app; the API tests run on the
 * shared in-process app with their own backup folder (config.backupDir is swapped and put back) and a lowered chunk size,
 * and the one restore that ends in a restart runs against a real launcher, as in backup.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { unzipSync, zipSync } from 'fflate'
import './in-process-env'
import { backupKeyState, BackupCryptError, CHUNK, decryptFile, decryptStream, encryptStream, newBackupKey } from '../src/backup-crypt'

const PASSWORD = process.env.ADMIN_PASSWORD!
const KEY = newBackupKey()
const OTHER_KEY = newBackupKey()
const keyOf = (k: string) => Buffer.from(k, 'base64url')
const ENC_RE = /^file-center-backup-\d{8}-\d{6}\.zip\.enc$/

const streamOf = (bytes: Uint8Array, piece = 7) => new ReadableStream<Uint8Array>({
  start(c) { for (let i = 0; i < bytes.length; i += piece) c.enqueue(bytes.subarray(i, i + piece)); c.close() },
})
const collect = async (s: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(s).arrayBuffer())
const seal = async (plain: Uint8Array, key = KEY) => collect(encryptStream(streamOf(plain), keyOf(key)))
const open = async (sealed: Uint8Array, key = KEY) => collect(decryptStream(streamOf(sealed, 11), keyOf(key)))
const errorOf = async (p: Promise<unknown>) => { try { await p } catch (e) { return e as any } return null }

describe('backup-crypt streams', () => {
  const size = CHUNK.size
  beforeAll(() => { CHUNK.size = 16 })
  afterAll(() => { CHUNK.size = size })

  test('round-trips byte for byte: empty, short, exact multiples of the chunk size, long', async () => {
    for (const n of [0, 1, 15, 16, 17, 32, 33, 64, 1000]) {
      const plain = randomBytes(n)
      const sealed = await seal(plain)
      expect(sealed.length).toBe(21 + n + 16 * Math.max(1, Math.ceil(n / 16)))
      expect(Buffer.from(await open(sealed)).equals(plain)).toBe(true)
    }
  })

  test('a file is not the plain text, and two seals of the same bytes differ', async () => {
    const plain = new TextEncoder().encode('PK\x03\x04 users.json users.json users.json')
    const a = await seal(plain)
    expect(Buffer.from(a).includes('users.json')).toBe(false)
    expect(Buffer.from(a).equals(Buffer.from(await seal(plain)))).toBe(false)
  })

  test('a changed byte, a dropped last chunk, extra bytes, a cut file and reordered chunks do not open', async () => {
    const sealed = await seal(randomBytes(100)) // 7 chunks
    const block = 16 + 16
    const flipped = Uint8Array.from(sealed)
    flipped[21 + block * 3 + 5] ^= 1
    const headerFlip = Uint8Array.from(sealed)
    headerFlip[17] ^= 1 // the nonce prefix is part of the header
    const swapped = Uint8Array.from(sealed)
    swapped.set(sealed.subarray(21 + block, 21 + 2 * block), 21)
    swapped.set(sealed.subarray(21, 21 + block), 21 + block)
    const repeated = Buffer.concat([sealed.subarray(0, 21 + block), sealed.subarray(21, 21 + block), sealed.subarray(21 + block)])
    for (const bad of [
      flipped, headerFlip, swapped, repeated,
      sealed.subarray(0, sealed.length - (100 % 16 + 16)), // last chunk dropped
      sealed.subarray(0, sealed.length - 1), // one byte short
      sealed.subarray(0, 21 + block * 2), // cut on a chunk border
      sealed.subarray(0, 10), // cut in the header
      Buffer.concat([sealed, Buffer.from([0])]),
      Buffer.concat([sealed, sealed.subarray(21)]), // a whole chunk appended
      new Uint8Array(0),
    ]) {
      const err = await errorOf(open(bad))
      expect(err).toBeInstanceOf(BackupCryptError)
      expect(err.code).toBe('backup.damaged')
    }
  })

  test('another key is told apart from damage, and encrypting does not read ahead without limit', async () => {
    const sealed = await seal(randomBytes(40))
    expect((await errorOf(open(sealed, OTHER_KEY))).code).toBe('backup.key-wrong')
    // pulls from the source one piece at a time: a 1 MB source never sits in memory at once
    let pulled = 0
    const source = new ReadableStream<Uint8Array>({ pull(c) { pulled++; pulled > 50 ? c.close() : c.enqueue(new Uint8Array(1000)) } })
    const reader = encryptStream(source, keyOf(KEY)).getReader()
    await reader.read() // header
    await reader.read() // first chunk
    expect(pulled).toBeLessThan(5)
    await reader.cancel()
  })

  test('key states: unset, malformed, and a valid one', () => {
    const was = process.env.BACKUP_ENCRYPTION_KEY
    try {
      delete process.env.BACKUP_ENCRYPTION_KEY
      expect(backupKeyState().state).toBe('off')
      for (const bad of ['short', 'x'.repeat(44), `${'A'.repeat(42)}=`, '!'.repeat(43), 'B'.repeat(43)]) {
        process.env.BACKUP_ENCRYPTION_KEY = bad
        expect(backupKeyState().state).toBe('invalid')
      }
      process.env.BACKUP_ENCRYPTION_KEY = KEY
      expect(backupKeyState().state).toBe('on')
      expect(KEY).toHaveLength(43)
    } finally {
      if (was === undefined) delete process.env.BACKUP_ENCRYPTION_KEY
      else process.env.BACKUP_ENCRYPTION_KEY = was
    }
  })
})

// ───────────── the CLI ─────────────

describe('bun src/cli.ts backup-key / backup-decrypt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fc-bk-cli-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const cli = (args: string[], key?: string) => Bun.spawnSync([process.execPath, resolve(import.meta.dir, '../src/cli.ts'), ...args], {
    env: { PATH: process.env.PATH!, HOME: process.env.HOME ?? dir, ...(key ? { BACKUP_ENCRYPTION_KEY: key } : {}) }, cwd: dir,
  })

  test('backup-key prints a usable key and says where to keep it', () => {
    const r = cli(['backup-key'])
    expect(r.exitCode).toBe(0)
    const key = r.stdout.toString().trim()
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(keyOf(key)).toHaveLength(32)
    const said = r.stderr.toString()
    expect(said).toContain('.env')
    expect(said).toContain('second safe place')
    expect(said).toContain('ที่ปลอดภัยอีกแห่ง')
    expect(said).not.toContain(key)
  })

  test('backup-decrypt opens a backup, refuses a wrong key, a damaged file and an existing out file', async () => {
    const zip = zipSync({ 'users.json': new TextEncoder().encode('{"users":[]}') })
    const enc = join(dir, 'a.zip.enc')
    writeFileSync(enc, await seal(zip))
    const out = join(dir, 'out.zip')

    const wrong = cli(['backup-decrypt', enc, out], OTHER_KEY)
    expect(wrong.exitCode).not.toBe(0)
    expect(wrong.stderr.toString()).toContain('Wrong key')
    expect(existsSync(out)).toBe(false)
    expect(cli(['backup-decrypt', enc, out]).exitCode).not.toBe(0) // no key at all

    const damaged = join(dir, 'b.zip.enc')
    const bytes = Uint8Array.from(await seal(zip))
    bytes[bytes.length - 20] ^= 1
    writeFileSync(damaged, bytes)
    const bad = cli(['backup-decrypt', damaged, out], KEY)
    expect(bad.exitCode).not.toBe(0)
    expect(bad.stderr.toString()).toContain('damaged')
    expect(existsSync(out)).toBe(false) // no partial file stays

    writeFileSync(out, 'mine')
    const exists = cli(['backup-decrypt', enc, out], KEY)
    expect(exists.exitCode).not.toBe(0)
    expect(readFileSync(out, 'utf8')).toBe('mine')
    rmSync(out)

    const ok = cli(['backup-decrypt', enc, out], KEY)
    expect(ok.exitCode).toBe(0)
    expect(Buffer.from(readFileSync(out)).equals(Buffer.from(zip))).toBe(true)
    expect(Object.keys(unzipSync(new Uint8Array(readFileSync(out))))).toEqual(['users.json'])
    // decryptFile itself never overwrites either
    expect((await errorOf(decryptFile(enc, out, keyOf(KEY)))).code).toBe('EEXIST')
  })
})

// ───────────── the app ─────────────

let app: any
let config: typeof import('../src/config').config
let paths: typeof import('../src/config').paths

class Client {
  cookie = ''
  csrf = ''
  async raw(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers }
    if (this.cookie) h.cookie = this.cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    if (body !== undefined) h['content-type'] = 'application/json'
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }))
    const set = res.headers.get('set-cookie')
    if (set) this.cookie = set.split(';')[0]
    return res
  }
  async json(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const res = await this.raw(method, path, body, headers)
    return { status: res.status, data: (await res.json().catch(() => null)) as any }
  }
}
const admin = new Client()

describe('encrypted backups (API)', () => {
  const was = { key: process.env.BACKUP_ENCRYPTION_KEY, dir: '', keep: 0, chunk: CHUNK.size }
  let dir = ''
  const names = () => readdirSync(dir).sort()
  const restore = (name: string) => admin.json('POST', '/api/admin/backups/restore', { name, password: PASSWORD })
  const supervised = async <T>(fn: () => Promise<T>) => {
    process.env.FC_SUPERVISED = '1'
    try { return await fn() } finally { delete process.env.FC_SUPERVISED }
  }

  beforeAll(async () => {
    ;({ app } = await import('../src/index'))
    ;({ config, paths } = await import('../src/config'))
    const { backupRunning } = await import('../src/backup')
    while (backupRunning()) await Bun.sleep(50)
    admin.csrf = (await admin.json('GET', '/api/session')).data.csrf
    const r = await admin.json('POST', '/api/login', { username: 'admin', password: PASSWORD })
    expect(r.status).toBe(200)
    admin.csrf = r.data.csrf
    dir = mkdtempSync(join(tmpdir(), 'fc-enc-backups-'))
    was.dir = config.backupDir
    was.keep = config.backupKeep
    config.backupDir = dir
    process.env.BACKUP_ENCRYPTION_KEY = KEY
    CHUNK.size = 512 // a backup is a few KB: several chunks
  })

  beforeEach(() => { for (const n of readdirSync(dir)) rmSync(join(dir, n), { force: true }) })

  afterAll(() => {
    config.backupDir = was.dir
    config.backupKeep = was.keep
    CHUNK.size = was.chunk
    if (was.key === undefined) delete process.env.BACKUP_ENCRYPTION_KEY
    else process.env.BACKUP_ENCRYPTION_KEY = was.key
    rmSync(dir, { recursive: true, force: true })
  })

  test('with a key a new backup is a .zip.enc with no plain zip in it, a sidecar, and lists as encrypted', async () => {
    const made = await admin.json('POST', '/api/admin/backups')
    expect(made.status).toBe(200)
    expect(made.data.name).toMatch(ENC_RE)
    expect(made.data.encrypted).toBe(true)
    expect(names()).toEqual([made.data.name, `${made.data.name}.json`].sort())
    expect(names().some(n => n.endsWith('.partial'))).toBe(false)

    const bytes = readFileSync(join(dir, made.data.name))
    expect(bytes.length).toBe(made.data.size)
    expect(bytes.includes(Buffer.from('PK\x03\x04', 'latin1'))).toBe(false)
    for (const word of ['users.json', 'settings.json', 'backup.json', 'argon2', 'admin']) expect(bytes.includes(word)).toBe(false)
    expect(bytes.length).toBeGreaterThan(3 * CHUNK.size) // several chunks
    // the overhead is the header and 16 bytes a chunk: the zip inside has the same size as the file minus these
    const out = join(dir, 'check.zip.tmp')
    await decryptFile(join(dir, made.data.name), out, keyOf(KEY))
    const zipBytes = readFileSync(out)
    const zip = unzipSync(new Uint8Array(zipBytes))
    rmSync(out)
    expect(Object.keys(zip)).toEqual(expect.arrayContaining(['users.json', 'settings.json', 'backup.json']))
    expect(bytes.length).toBe(21 + zipBytes.length + 16 * Math.ceil(zipBytes.length / CHUNK.size))

    // the list reads the sidecar, not the file: the numbers are those of backup.json
    const side = JSON.parse(readFileSync(join(dir, `${made.data.name}.json`), 'utf8'))
    expect(side).toEqual(JSON.parse(new TextDecoder().decode(zip['backup.json'])))
    expect(Object.keys(side)).toEqual(expect.arrayContaining(['version', 'createdAt', 'includesFiles', 'parts']))
    expect(JSON.stringify(side)).not.toContain(KEY)
    const list = await admin.json('GET', '/api/admin/backups')
    expect(list.data.items).toHaveLength(1)
    expect(list.data.items[0]).toEqual(made.data)
    expect(list.data.items[0].parts.data.files).toBeGreaterThan(0)
    expect(list.data.items[0].parts.data.size).toBeGreaterThan(0)
    expect(list.data.items[0].parts).toEqual(side.parts)
    expect(list.data.settings.encryption).toBe(true)
    expect(list.data.status).toMatchObject({ status: 'ok', file: made.data.name, size: made.data.size })
    expect(JSON.parse(readFileSync(paths.backupStatus, 'utf8'))).toMatchObject({ status: 'ok', file: made.data.name })
    expect((await admin.json('GET', '/api/admin/activity?action=backup-create')).data.items[0].target).toBe(made.data.name)
    // FC_UMASK applies to the new files like to the rest
    for (const f of [made.data.name, `${made.data.name}.json`]) expect(statSync(join(dir, f)).mode & 0o077).toBe(0)

    // download: octet-stream, ranges and validators as for a zip
    const res = await admin.raw('GET', `/api/admin/backups/${made.data.name}/download`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toContain(made.data.name)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const whole = Buffer.from(await res.arrayBuffer())
    expect(whole.equals(bytes)).toBe(true)
    const rest = await admin.raw('GET', `/api/admin/backups/${made.data.name}/download`, undefined, { range: 'bytes=100-', 'if-range': res.headers.get('etag')! })
    expect(rest.status).toBe(206)
    expect(Buffer.from(await rest.arrayBuffer()).equals(whole.subarray(100))).toBe(true)
    // the sidecar is not a backup
    expect((await admin.raw('GET', `/api/admin/backups/${made.data.name}.json/download`)).status).toBe(400)

    // a file without sidecar still lists, with the date of its name
    rmSync(join(dir, `${made.data.name}.json`))
    const bare = (await admin.json('GET', '/api/admin/backups')).data.items[0]
    expect(bare).toMatchObject({ name: made.data.name, encrypted: true, parts: null })
    expect(Date.parse(bare.createdAt)).toBeGreaterThan(0)

    // delete takes the sidecar along
    writeFileSync(join(dir, `${made.data.name}.json`), '{}')
    expect((await admin.json('DELETE', `/api/admin/backups/${made.data.name}`)).status).toBe(200)
    expect(names()).toEqual([])
  })

  test('a plain backup (no key set) is the same as before, and lists as not encrypted', async () => {
    delete process.env.BACKUP_ENCRYPTION_KEY
    try {
      const made = await admin.json('POST', '/api/admin/backups')
      expect(made.data.name).toMatch(/\.zip$/)
      expect(made.data.encrypted).toBe(false)
      expect(names()).toEqual([made.data.name])
      expect(readFileSync(join(dir, made.data.name)).subarray(0, 4).toString('latin1')).toBe('PK\x03\x04')
      const list = await admin.json('GET', '/api/admin/backups')
      expect(list.data.settings.encryption).toBe(false)
      expect(list.data.items[0].encrypted).toBe(false)
      const res = await admin.raw('GET', `/api/admin/backups/${made.data.name}/download`)
      expect(res.headers.get('content-type')).toBe('application/zip')
    } finally {
      process.env.BACKUP_ENCRYPTION_KEY = KEY
      for (const n of names()) rmSync(join(dir, n))
    }
  })

  test('a damaged, cut, extended or foreign-key file is refused with nothing changed; no key or a wrong key says so', async () => {
    const made = await admin.json('POST', '/api/admin/backups')
    const good = readFileSync(join(dir, made.data.name))
    const chunk = CHUNK.size + 16
    // the test is only worth something with a middle to change
    expect(good.length).toBeGreaterThan(21 + chunk * 2)
    const flip = Buffer.from(good)
    flip[21 + chunk + 100] ^= 1
    const variants: Record<string, Buffer> = {
      flipped: flip,
      'last chunk dropped': good.subarray(0, 21 + chunk * (Math.ceil((good.length - 21) / chunk) - 1)),
      appended: Buffer.concat([good, Buffer.from('more')]),
      cut: good.subarray(0, good.length - 3),
    }
    const users = readFileSync(paths.users, 'utf8')
    const settings = readFileSync(paths.settings, 'utf8')
    const before = names()
    await supervised(async () => {
      let n = 0
      for (const [what, bytes] of Object.entries(variants)) {
        const name = `file-center-backup-2000010${++n}-000000.zip.enc`
        writeFileSync(join(dir, name), bytes)
        const r = await restore(name)
        expect([what, r.status, r.data.code]).toEqual([what, 400, 'backup.damaged'])
        rmSync(join(dir, name))
      }
      // another key
      process.env.BACKUP_ENCRYPTION_KEY = OTHER_KEY
      const wrong = await restore(made.data.name)
      expect([wrong.status, wrong.data.code]).toEqual([400, 'backup.key-wrong'])
      expect(wrong.data.error).toContain('BACKUP_ENCRYPTION_KEY')
      // no key
      delete process.env.BACKUP_ENCRYPTION_KEY
      const none = await restore(made.data.name)
      expect([none.status, none.data.code]).toEqual([400, 'backup.key-missing'])
      // the error is in the reader's language too
      const en = await admin.json('POST', '/api/admin/backups/restore', { name: made.data.name, password: PASSWORD }, { 'x-lang': 'en' })
      expect(en.data.error).toContain('is not set')
      process.env.BACKUP_ENCRYPTION_KEY = KEY

    })
    expect(names()).toEqual(before) // no safety copy, no temporary zip
    expect(readFileSync(paths.users, 'utf8')).toBe(users)
    expect(readFileSync(paths.settings, 'utf8')).toBe(settings)
    expect((await admin.json('GET', '/api/session')).data.user.username).toBe('admin')
  })

  test('a plain backup is handled by the old path whether or not a key is set', async () => {
    const enc = new TextEncoder()
    const name = 'file-center-backup-20000109-000000.zip'
    writeFileSync(join(dir, name), zipSync({ 'users.json': enc.encode(JSON.stringify({ users: [{ username: 'u', role: 'user', passwordHash: 'x' }] })) }))
    const users = readFileSync(paths.users, 'utf8')
    await supervised(async () => {
      // it gets as far as the content check: the key plays no part
      const flagged = await admin.json('POST', '/api/admin/backups/restore', { name, password: PASSWORD, allowUnencrypted: true })
      expect([flagged.status, flagged.data.code]).toEqual([400, 'backup.no-admin'])
      // without a key it needs no flag
      delete process.env.BACKUP_ENCRYPTION_KEY
      try {
        const r = await restore(name)
        expect([r.status, r.data.code]).toEqual([400, 'backup.no-admin'])
      } finally { process.env.BACKUP_ENCRYPTION_KEY = KEY }
    })
    expect(readFileSync(paths.users, 'utf8')).toBe(users)
    expect(names().filter(n => n.includes('.tmp'))).toEqual([])
  })

  test('a valid key: a plain zip is not restored without allowUnencrypted, and nothing changes (no safety copy either)', async () => {
    const name = 'file-center-backup-20000110-000000.zip'
    writeFileSync(join(dir, name), zipSync({ 'users.json': new TextEncoder().encode(JSON.stringify({ users: [{ username: 'u', role: 'user', passwordHash: 'x' }] })) }))
    const users = readFileSync(paths.users, 'utf8')
    const settings = readFileSync(paths.settings, 'utf8')
    const before = names()
    await supervised(async () => {
      for (const body of [{}, { allowUnencrypted: false }]) {
        const r = await admin.json('POST', '/api/admin/backups/restore', { name, password: PASSWORD, ...body })
        expect([r.status, r.data.code]).toEqual([400, 'backup.restore-unencrypted'])
      }
    })
    expect(names()).toEqual(before)
    expect(readFileSync(paths.users, 'utf8')).toBe(users)
    expect(readFileSync(paths.settings, 'utf8')).toBe(settings)
  })

  test('an invalid key: no backup of any kind is written, the scheduled run alerts with the reason, a restore is refused', async () => {
    const plain = 'file-center-backup-20000111-000000.zip'
    writeFileSync(join(dir, plain), zipSync({ 'users.json': new TextEncoder().encode('{}') }))
    const users = readFileSync(paths.users, 'utf8')
    const before = names()
    const hooks: any[] = []
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { hooks.push(await req.json()); return new Response('ok') } })
    const alerts = await import('../src/alerts')
    const { runBackup } = await import('../src/backup')
    const saved = { url: config.alertWebhookUrl, kind: config.alertWebhookKind }
    process.env.BACKUP_ENCRYPTION_KEY = KEY.slice(0, -1) // one character missing
    try {
      config.alertWebhookUrl = `http://127.0.0.1:${server.port}/hook`
      config.alertWebhookKind = 'json'
      alerts.resetAlerts()
      // what the scheduler calls
      const err = await runBackup().then(() => null, e => e)
      expect(err?.code).toBe('backup.key-invalid')
      await alerts.alertsIdle()
      expect(hooks.length).toBe(1)
      expect(hooks[0]).toMatchObject({ event: 'backup-failed', code: 'backup.key-invalid' })
      expect(hooks[0].message).toContain('BACKUP_ENCRYPTION_KEY')
      expect(JSON.stringify(hooks[0]).includes(KEY.slice(0, -1))).toBe(false)
      const status = (await admin.json('GET', '/api/admin/backups')).data.status
      expect(status).toMatchObject({ status: 'failed', code: 'backup.key-invalid' })
      // the safety backup of a restore fails first: the restore is refused, nothing changes (the old copies are not pruned either)
      const keep = config.backupKeep
      config.backupKeep = 1
      await supervised(async () => {
        const r = await admin.json('POST', '/api/admin/backups/restore', { name: plain, password: PASSWORD, allowUnencrypted: true })
        expect([r.status, r.data.code]).toEqual([400, 'backup.key-invalid'])
      })
      config.backupKeep = keep
      expect(names()).toEqual(before)
      expect(readFileSync(paths.users, 'utf8')).toBe(users)
    } finally {
      process.env.BACKUP_ENCRYPTION_KEY = KEY
      config.alertWebhookUrl = saved.url
      config.alertWebhookKind = saved.kind
      alerts.resetAlerts()
      await server.stop(true)
    }
  })

  test('the invalid-key warning on the system page is critical and says that no backups are made', async () => {
    const { envWarnings: configWarnings } = await import('../src/config-warnings')
    const { MESSAGES } = await import('../src/messages')
    process.env.BACKUP_ENCRYPTION_KEY = 'x'.repeat(42)
    try {
      expect(configWarnings().filter(w => w.code === 'admin.config-backup-key-invalid')).toEqual([{ code: 'admin.config-backup-key-invalid', severity: 'critical' }])
    } finally { process.env.BACKUP_ENCRYPTION_KEY = KEY }
    expect(configWarnings().some(w => w.code === 'admin.config-backup-key-invalid')).toBe(false)
    expect(MESSAGES['admin.config-backup-key-invalid'].en).toContain('NO backups')
  })

  test('pruning counts both kinds together and takes sidecars with the backups', async () => {
    config.backupKeep = 3
    const fake = (name: string, side: boolean) => {
      writeFileSync(join(dir, name), 'old')
      if (side) writeFileSync(join(dir, `${name}.json`), '{}')
    }
    fake('file-center-backup-20000101-000000.zip', false)
    fake('file-center-backup-20000102-000000.zip.enc', true)
    fake('file-center-backup-20000103-000000.zip', false)
    fake('file-center-backup-20000104-000000.zip.enc', true)
    writeFileSync(join(dir, 'file-center-backup-20000105-000000.zip.enc.json'), '{}') // a sidecar without its backup
    writeFileSync(join(dir, 'file-center-backup-20000106-000000.zip.partial'), 'cut off')
    const made = await admin.json('POST', '/api/admin/backups')
    expect(made.status).toBe(200)
    const list = (await admin.json('GET', '/api/admin/backups')).data.items.map((i: any) => i.name)
    // the sidecars are never listed
    expect(list.every((n: string) => !n.endsWith('.json'))).toBe(true)
    expect(list).toEqual([made.data.name, 'file-center-backup-20000104-000000.zip.enc', 'file-center-backup-20000103-000000.zip'])
    expect(names()).toEqual([
      made.data.name, `${made.data.name}.json`,
      'file-center-backup-20000103-000000.zip',
      'file-center-backup-20000104-000000.zip.enc', 'file-center-backup-20000104-000000.zip.enc.json',
    ].sort())
    for (const n of names()) rmSync(join(dir, n))
  })

  test('the key is in no answer, no backup, no log and no file of the data folder', async () => {
    const made = await admin.json('POST', '/api/admin/backups')
    const out = join(dir, 'k.zip.tmp')
    await decryptFile(join(dir, made.data.name), out, keyOf(KEY))
    const zipBytes = Buffer.from(readFileSync(out))
    rmSync(out)
    const seen = [
      JSON.stringify(made.data),
      JSON.stringify((await admin.json('GET', '/api/admin/backups')).data),
      JSON.stringify((await admin.json('GET', '/api/admin/backups/estimate')).data),
      JSON.stringify((await admin.json('GET', '/api/admin/config-warnings')).data),
      JSON.stringify((await admin.json('GET', '/api/admin/settings')).data),
      readFileSync(join(dir, `${made.data.name}.json`), 'utf8'),
    ]
    for (const s of seen) expect(s.includes(KEY)).toBe(false)
    for (const k of [KEY, keyOf(KEY).toString('hex'), keyOf(KEY).toString('base64')]) {
      expect(zipBytes.includes(k)).toBe(false)
      for (const f of [paths.systemLog, paths.settings, paths.users, paths.backupStatus]) {
        if (existsSync(f)) expect(readFileSync(f, 'utf8').includes(k)).toBe(false)
      }
    }
    // an invalid key: the app runs, the system page warns (critical), backups are refused, and the bad value is not echoed
    const bad = 'not-a-valid-key-SECRETISH'
    process.env.BACKUP_ENCRYPTION_KEY = bad
    try {
      const warnings = await admin.json('GET', '/api/admin/config-warnings')
      expect(warnings.data.items.map((w: any) => w.code)).toContain('admin.config-backup-key-invalid')
      expect(JSON.stringify(warnings.data).includes(bad)).toBe(false)
      const refused = await admin.json('POST', '/api/admin/backups')
      expect(refused.status).toBe(400)
      expect(refused.data.code).toBe('backup.key-invalid')
      expect(JSON.stringify(refused.data).includes(bad)).toBe(false)
      expect((await admin.json('GET', '/api/admin/backups')).data.settings.encryption).toBe(false)
    } finally {
      process.env.BACKUP_ENCRYPTION_KEY = KEY
    }
    for (const n of names()) rmSync(join(dir, n))
  })
})

// ───────────── end to end: the real launcher restarts the app after restoring an encrypted backup ─────────────

describe('restore of an encrypted backup (end to end)', () => {
  const root = resolve(import.meta.dir, '..')
  const base = mkdtempSync(join(tmpdir(), 'fc-enc-restore-'))
  const e2e = { storage: join(base, 'storage'), data: join(base, 'data'), backups: join(base, 'backups') }
  const E2E_PASSWORD = 'restore-test-pass'
  let port = 0
  let launcher: ReturnType<typeof Bun.spawn> | undefined
  const url = (p: string) => `http://127.0.0.1:${port}${p}`
  const live = { cookie: '', csrf: '' }

  async function api(method: string, path: string, body?: any) {
    const headers: Record<string, string> = { cookie: live.cookie, 'x-csrf-token': live.csrf }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(url(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const set = res.headers.get('set-cookie')
    if (set) live.cookie = set.split(';')[0]
    return { status: res.status, data: (await res.json().catch(() => null)) as any }
  }
  const health = async () => {
    try { return (await (await fetch(url('/api/health'), { signal: AbortSignal.timeout(1500) })).json()) as any } catch { return null }
  }
  async function until<T>(fn: () => Promise<T | null | false>, ms: number, what: string): Promise<T> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const v = await fn()
      if (v) return v
      await Bun.sleep(200)
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  beforeAll(async () => {
    mkdirSync(base, { recursive: true })
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
    port = probe.port!
    await probe.stop(true)
    launcher = Bun.spawn([process.execPath, join(root, 'src', 'launcher.ts')], {
      cwd: root,
      stdout: 'ignore',
      stderr: Bun.file(join(base, 'launcher-stderr.log')),
      env: {
        PATH: process.env.PATH!, HOME: process.env.HOME ?? base, NODE_ENV: 'production',
        PORT: String(port), HOST: '127.0.0.1', STORAGE_DIR: e2e.storage, DATA_DIR: e2e.data, BACKUP_DIR: e2e.backups,
        BACKUP_HOUR: 'off', ADMIN_PASSWORD: E2E_PASSWORD, MIN_FREE_SPACE: '0', FC_STABLE_MS: '1500', FC_HEALTH_TIMEOUT_MS: '15000',
        BACKUP_ENCRYPTION_KEY: KEY,
      },
    })
    process.once('exit', () => launcher?.kill('SIGTERM'))
    await until(async () => (await health())?.status === 'ok', 30_000, 'app start')
    live.csrf = (await api('GET', '/api/session')).data.csrf
    const r = await api('POST', '/api/login', { username: 'admin', password: E2E_PASSWORD })
    expect(r.status).toBe(200)
    live.csrf = r.data.csrf
  }, 40_000)

  afterAll(async () => {
    launcher?.kill('SIGTERM')
    await Promise.race([launcher?.exited, Bun.sleep(15_000)])
    rmSync(base, { recursive: true, force: true })
  })

  test('back up (encrypted), delete a user, restore: the user is back, the safety copy is encrypted, no temporary zip is left', async () => {
    expect((await api('POST', '/api/admin/users', { username: 'carol', name: 'Carol', password: 'red-kite-flies-1', role: 'user', permissions: ['read'], publicPermissions: [] })).status).toBe(200)
    expect((await api('PUT', '/api/admin/settings', { appName: 'ก่อนกู้คืน' })).status).toBe(200)
    const made = await api('POST', '/api/admin/backups')
    expect(made.status).toBe(200)
    expect(made.data.name).toMatch(ENC_RE)
    expect((await api('GET', '/api/admin/backups')).data.settings.encryption).toBe(true)
    expect((await api('DELETE', '/api/admin/users/carol')).status).toBe(200)
    expect((await api('PUT', '/api/admin/settings', { appName: 'หลังลบ' })).status).toBe(200)

    const before = (await health()).boot
    const r = await api('POST', '/api/admin/backups/restore', { name: made.data.name, password: E2E_PASSWORD })
    expect(r.status).toBe(200)
    expect(r.data.safety).toMatch(ENC_RE)
    await until(async () => { const h = await health(); return h && h.boot !== before ? h : null }, 30_000, 'restart')
    expect((await api('GET', '/api/admin/users')).data.users.map((u: any) => u.username)).toContain('carol')
    expect((await api('GET', '/api/admin/settings')).data.appName).toBe('ก่อนกู้คืน')
    const files = readdirSync(e2e.backups)
    expect(files).toEqual(expect.arrayContaining([made.data.name, r.data.safety, `${r.data.safety}.json`]))
    expect(files.filter(f => f.includes('restore') || f.endsWith('.tmp') || f.endsWith('.partial'))).toEqual([])
    const items = (await api('GET', '/api/admin/backups')).data.items
    expect(items.every((i: any) => i.encrypted === true)).toBe(true)
  }, 60_000)
})
