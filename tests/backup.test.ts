/**
 * Backups of the system data. The API tests run in this process on the same app as api.test.ts (bun test shares
 * modules between files, see in-process-env.ts), so they read the folders from config and expect other data
 * around. The restore test starts the real launcher, because a restore ends with a restart.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import './in-process-env'

const PASSWORD = process.env.ADMIN_PASSWORD!
const NAME_RE = /^file-center-backup-\d{8}-\d{6}\.zip$/

let app: any
let config: typeof import('../src/config').config
let paths: typeof import('../src/config').paths

class Client {
  cookie = ''
  csrf = ''
  async raw(method: string, path: string, body?: any) {
    const h: Record<string, string> = {}
    if (this.cookie) h.cookie = this.cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    if (body !== undefined) h['content-type'] = 'application/json'
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }))
    const set = res.headers.get('set-cookie')
    if (set) this.cookie = set.split(';')[0]
    return res
  }
  async json(method: string, path: string, body?: any) {
    const res = await this.raw(method, path, body)
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
const zipOf = async (c: Client, name: string) => unzipSync(new Uint8Array(await (await c.raw('GET', `/api/admin/backups/${name}/download`)).arrayBuffer()))
const onDisk = () => readdirSync(config.backupDir).sort()

describe('backups (API)', () => {
  beforeAll(async () => {
    ;({ app } = await import('../src/index'))
    ;({ config, paths } = await import('../src/config'))
    // the first start runs a backup in the background; let it finish so the tests below start from a quiet state
    const { backupRunning } = await import('../src/backup')
    while (backupRunning()) await Bun.sleep(50)
    await admin.login('admin', PASSWORD)
  })

  test('create, list and download a backup', async () => {
    writeFileSync(join(paths.logs, 'audit.log.1'), '{"rotated":true}\n')
    const made = await admin.json('POST', '/api/admin/backups')
    expect(made.status).toBe(200)
    expect(made.data.name).toMatch(NAME_RE)
    expect(made.data.size).toBeGreaterThan(0)

    const list = await admin.json('GET', '/api/admin/backups')
    expect(list.status).toBe(200)
    expect(list.data.items[0]).toEqual(made.data)
    expect(list.data.status).toMatchObject({ status: 'ok', file: made.data.name, size: made.data.size })
    expect(Date.parse(list.data.status.lastSuccess)).toBeGreaterThan(Date.now() - 60_000)
    expect(list.data.settings).toMatchObject({ dir: config.backupDir, keep: config.backupKeep, includesFiles: false, sameDisk: true })
    // the dashboard reads the same file
    expect(JSON.parse(readFileSync(paths.backupStatus, 'utf8'))).toMatchObject({ status: 'ok', file: made.data.name })

    const res = await admin.raw('GET', `/api/admin/backups/${made.data.name}/download`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-disposition')).toContain(made.data.name)
    const files = Object.keys(unzipSync(new Uint8Array(await res.arrayBuffer())))
    expect(files).toEqual(expect.arrayContaining(['users.json', 'settings.json', 'backup.json', 'logs/audit.log']))
    expect(files).not.toContain('sessions.json')
    expect(files).not.toContain('logs/audit.log.1')
    expect(files.filter(f => /^(tmp|trash|app|storage)\//.test(f))).toEqual([])
    const meta = JSON.parse(new TextDecoder().decode((await zipOf(admin, made.data.name))['backup.json']))
    expect(meta).toMatchObject({ version: config.version, includesFiles: false })
    expect(Date.parse(meta.createdAt)).toBeGreaterThan(0)

    const act = await admin.json('GET', '/api/admin/activity?action=backup-create')
    expect(act.data.items[0].target).toBe(made.data.name)
  })

  test('one backup at a time', async () => {
    const statuses = (await Promise.all([admin.raw('POST', '/api/admin/backups'), admin.raw('POST', '/api/admin/backups')])).map(r => r.status)
    expect(statuses.sort()).toEqual([200, 409])
  })

  test('keeps only the newest BACKUP_KEEP and never lists a half-written one', async () => {
    const keep = config.backupKeep
    config.backupKeep = 3
    try {
      for (let i = 0; i < 4; i++) writeFileSync(join(config.backupDir, `file-center-backup-20000101-00000${i}.zip`), 'old')
      writeFileSync(join(config.backupDir, 'file-center-backup-20000101-000009.zip.partial'), 'cut off')
      const made = await admin.json('POST', '/api/admin/backups')
      expect(made.status).toBe(200)
      const list = (await admin.json('GET', '/api/admin/backups')).data.items.map((i: any) => i.name)
      expect(list.length).toBe(3)
      expect(list[0]).toBe(made.data.name)
      expect(onDisk().length).toBe(3)
      expect(onDisk()).not.toContain('file-center-backup-20000101-000000.zip')
      expect(onDisk().some(n => n.endsWith('.partial'))).toBe(false)
    } finally {
      config.backupKeep = keep
    }
  })

  test('refuses names that are not backups, and deletes', async () => {
    for (const name of ['x.zip', '..%2Fusers.json', 'file-center-backup-20000101-000000.zip.partial', 'file-center-backup-2000-01-01.zip']) {
      expect((await admin.raw('GET', `/api/admin/backups/${name}/download`)).status).toBe(400)
      expect((await admin.raw('DELETE', `/api/admin/backups/${name}`)).status).toBe(400)
    }
    expect((await admin.raw('GET', '/api/admin/backups/file-center-backup-19990101-000000.zip/download')).status).toBe(404)
    expect((await admin.raw('DELETE', '/api/admin/backups/file-center-backup-19990101-000000.zip')).status).toBe(404)
    const [newest] = (await admin.json('GET', '/api/admin/backups')).data.items
    expect((await admin.json('DELETE', `/api/admin/backups/${newest.name}`)).status).toBe(200)
    expect(onDisk()).not.toContain(newest.name)
    expect((await admin.json('GET', '/api/admin/activity?action=backup-delete')).data.items[0].target).toBe(newest.name)
  })

  test('only admins may see, make, download, delete or restore backups', async () => {
    const r = await admin.json('POST', '/api/admin/users', { username: 'backup-user', name: 'x', password: 'harbor-lamp-42', role: 'user', permissions: ['read'], publicPermissions: [] })
    expect(r.status).toBe(200)
    const u = new Client()
    await u.login('backup-user', 'harbor-lamp-42')
    const guest = new Client()
    guest.csrf = (await guest.json('GET', '/api/session')).data.csrf
    const [item] = (await admin.json('GET', '/api/admin/backups')).data.items
    const calls: [string, string, any?][] = [
      ['GET', '/api/admin/backups'],
      ['POST', '/api/admin/backups'],
      ['GET', `/api/admin/backups/${item.name}/download`],
      ['DELETE', `/api/admin/backups/${item.name}`],
      ['POST', '/api/admin/backups/restore', { name: item.name, password: 'harbor-lamp-42' }],
    ]
    for (const [method, path, body] of calls) {
      expect(`${method} ${path} ${(await u.raw(method, path, body)).status}`).toBe(`${method} ${path} 403`)
      expect(`${method} ${path} ${(await guest.raw(method, path, body)).status}`).toBe(`${method} ${path} 401`)
    }
    expect(onDisk()).toContain(item.name)
  })

  test('restore needs the launcher and the password again', async () => {
    const [item] = (await admin.json('GET', '/api/admin/backups')).data.items
    const before = readFileSync(paths.users, 'utf8')
    const notSupervised = await admin.json('POST', '/api/admin/backups/restore', { name: item.name, password: PASSWORD })
    expect(notSupervised.status).toBe(409)
    expect(notSupervised.data.code).toBe('not-supervised')
    process.env.FC_SUPERVISED = '1'
    try {
      const wrong = await admin.json('POST', '/api/admin/backups/restore', { name: item.name, password: 'wrong-password' })
      expect(wrong.status).toBe(403)
      expect((await admin.json('GET', '/api/admin/activity?action=backup-restore-denied')).data.items.length).toBeGreaterThan(0)
      expect((await admin.json('POST', '/api/admin/backups/restore', { name: '../users.json', password: PASSWORD })).status).toBe(400)
      expect((await admin.json('POST', '/api/admin/backups/restore', { name: 'file-center-backup-19990101-000000.zip', password: PASSWORD })).status).toBe(404)
    } finally {
      delete process.env.FC_SUPERVISED
    }
    expect(readFileSync(paths.users, 'utf8')).toBe(before)
  })

  test('a backup without an admin, or a broken one, is never restored', async () => {
    const enc = new TextEncoder()
    const noAdmin = 'file-center-backup-20000102-000000.zip'
    writeFileSync(join(config.backupDir, noAdmin), zipSync({
      'users.json': enc.encode(JSON.stringify({ users: [{ username: 'only-user', role: 'user', passwordHash: 'x' }] })),
      'settings.json': enc.encode(JSON.stringify({ appName: 'hijacked' })),
    }))
    const broken = 'file-center-backup-20000103-000000.zip'
    writeFileSync(join(config.backupDir, broken), 'not a zip at all')
    const users = readFileSync(paths.users, 'utf8')
    const settings = readFileSync(paths.settings, 'utf8')
    process.env.FC_SUPERVISED = '1'
    try {
      const r = await admin.json('POST', '/api/admin/backups/restore', { name: noAdmin, password: PASSWORD })
      expect(r.status).toBe(400)
      expect(r.data.error).toContain('ผู้ดูแลระบบ')
      expect((await admin.json('POST', '/api/admin/backups/restore', { name: broken, password: PASSWORD })).status).toBe(400)
    } finally {
      delete process.env.FC_SUPERVISED
    }
    expect(readFileSync(paths.users, 'utf8')).toBe(users)
    expect(readFileSync(paths.settings, 'utf8')).toBe(settings)
    expect((await admin.json('GET', '/api/session')).data.user.username).toBe('admin')
  })

  test('BACKUP_INCLUDE_FILES adds the storage, after checking the free space', async () => {
    writeFileSync(join(config.storageDir, 'backup-me.txt'), 'in the backup')
    config.backupIncludeFiles = true
    try {
      const made = await admin.json('POST', '/api/admin/backups')
      expect(made.status).toBe(200)
      const zip = await zipOf(admin, made.data.name)
      expect(new TextDecoder().decode(zip['storage/backup-me.txt'])).toBe('in the backup')
      expect(JSON.parse(new TextDecoder().decode(zip['backup.json'])).includesFiles).toBe(true)
      expect(Object.keys(zip).some(f => f.startsWith('storage/') && f.includes('sessions.json'))).toBe(false)

      const lastSuccess = JSON.parse(readFileSync(paths.backupStatus, 'utf8')).lastSuccess
      const keep = config.minFreeSpace
      config.minFreeSpace = Number.MAX_SAFE_INTEGER
      try {
        const full = await admin.json('POST', '/api/admin/backups')
        expect(full.status).toBe(507)
      } finally {
        config.minFreeSpace = keep
      }
      // a failed attempt is reported, and the last success is kept
      const status = (await admin.json('GET', '/api/admin/backups')).data.status
      expect(status).toMatchObject({ status: 'failed', lastSuccess, file: null, size: null })
      expect(status.message).toContain('ไม่สำเร็จ')
      expect(JSON.parse(readFileSync(paths.backupStatus, 'utf8')).status).toBe('failed')
    } finally {
      config.backupIncludeFiles = false
      rmSync(join(config.storageDir, 'backup-me.txt'), { force: true })
    }
    expect((await admin.json('POST', '/api/admin/backups')).status).toBe(200)
  })

  test('the hourly schedule: once a day at BACKUP_HOUR, or when the last one is over 2 days old', async () => {
    const { backupDue } = await import('../src/backup')
    const saved = readFileSync(paths.backupStatus, 'utf8')
    const hour = config.backupHour
    const at = (h: number) => { const d = new Date(); d.setHours(h, 30, 0, 0); return d }
    const lastSuccessAgo = (now: Date, hours: number) =>
      writeFileSync(paths.backupStatus, JSON.stringify({ status: 'ok', lastSuccess: new Date(now.getTime() - hours * 3600_000).toISOString() }))
    try {
      config.backupHour = 3
      const three = at(3)
      const five = at(5)
      lastSuccessAgo(three, 21)
      expect(backupDue(three)).toBe(true)
      lastSuccessAgo(five, 21)
      expect(backupDue(five)).toBe(false)
      lastSuccessAgo(three, 10)
      expect(backupDue(three)).toBe(false)
      lastSuccessAgo(five, 49)
      expect(backupDue(five)).toBe(true)
      rmSync(paths.backupStatus)
      expect(backupDue(five)).toBe(true)
      config.backupHour = null
      expect(backupDue(five)).toBe(false)
    } finally {
      config.backupHour = hour
      writeFileSync(paths.backupStatus, saved)
    }
  })
})

// ───────────── end to end: the real launcher restarts the app after a restore ─────────────

const root = resolve(import.meta.dir, '..')
const base = mkdtempSync(join(tmpdir(), 'fc-restore-'))
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

describe('restore (end to end)', () => {
  beforeAll(async () => {
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
    port = probe.port!
    await probe.stop(true)
    launcher = Bun.spawn([process.execPath, join(root, 'src', 'launcher.ts')], {
      cwd: root,
      stdout: 'ignore',
      stderr: 'inherit',
      env: {
        PATH: process.env.PATH!, HOME: process.env.HOME ?? base, NODE_ENV: 'production',
        PORT: String(port), HOST: '127.0.0.1', STORAGE_DIR: e2e.storage, DATA_DIR: e2e.data, BACKUP_DIR: e2e.backups,
        BACKUP_HOUR: 'off', ADMIN_PASSWORD: E2E_PASSWORD, MIN_FREE_SPACE: '0', FC_STABLE_MS: '1500', FC_HEALTH_TIMEOUT_MS: '15000',
      },
    })
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

  test('back up, delete a user, restore: the user is back and the admin is still logged in', async () => {
    expect((await api('POST', '/api/admin/users', { username: 'carol', name: 'Carol', password: 'red-kite-flies-1', role: 'user', permissions: ['read'], publicPermissions: [] })).status).toBe(200)
    expect((await api('PUT', '/api/admin/settings', { appName: 'ก่อนกู้คืน' })).status).toBe(200)
    const made = await api('POST', '/api/admin/backups')
    expect(made.status).toBe(200)
    expect(existsSync(join(e2e.backups, made.data.name))).toBe(true)
    expect((await api('GET', '/api/admin/backups')).data.settings.dir).toBe(e2e.backups)

    expect((await api('DELETE', '/api/admin/users/carol')).status).toBe(200)
    expect((await api('PUT', '/api/admin/settings', { appName: 'หลังลบ' })).status).toBe(200)
    expect((await api('GET', '/api/admin/users')).data.users.map((u: any) => u.username)).not.toContain('carol')

    const before = (await health()).boot
    const r = await api('POST', '/api/admin/backups/restore', { name: made.data.name, password: E2E_PASSWORD })
    expect(r.status).toBe(200)
    expect(r.data.restarting).toBe(true)
    expect(r.data.safety).toMatch(NAME_RE)
    await until(async () => { const h = await health(); return h && h.boot !== before ? h : null }, 30_000, 'restart')

    expect((await api('GET', '/api/session')).data.user.username).toBe('admin')
    expect((await api('GET', '/api/admin/users')).data.users.map((u: any) => u.username)).toContain('carol')
    expect((await api('GET', '/api/admin/settings')).data.appName).toBe('ก่อนกู้คืน')
    // the state before the restore was kept as a backup of its own
    const names = (await api('GET', '/api/admin/backups')).data.items.map((i: any) => i.name)
    expect(names).toEqual(expect.arrayContaining([made.data.name, r.data.safety]))
    expect((await api('GET', '/api/admin/activity?action=backup-restore')).data.items[0].target).toBe(made.data.name)
    // carol can log in again with her old password
    const carol = await fetch(url('/api/session'))
    const cookie = carol.headers.get('set-cookie')!.split(';')[0]
    const csrf = ((await carol.json()) as any).csrf
    const login = await fetch(url('/api/login'), { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'carol', password: 'red-kite-flies-1' }) })
    expect(login.status).toBe(200)
  }, 60_000)
})
