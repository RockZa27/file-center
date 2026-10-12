/**
 * The system log: logger.ts writes and rotates, errors reach the admin through the API, the logs and activity
 * can be downloaded, and no secret ever lands in a log file. Runs in-process on the same app as api.test.ts (see
 * in-process-env.ts); the crash handlers of index.ts are checked on a real process of their own.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { unzipSync } from 'fflate'
import './in-process-env'

const PASSWORD = process.env.ADMIN_PASSWORD!
// a password, a session and tokens that this file sends; none of them may be found in a log afterwards
const USER_PASSWORD = 'log-secret-Pw-8812'

let app: any
let config: typeof import('../src/config').config
let paths: typeof import('../src/config').paths
let logger: typeof import('../src/logger')

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
const secrets: string[] = [PASSWORD, USER_PASSWORD]
const readLines = (file: string) => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config, paths } = await import('../src/config'))
  logger = await import('../src/logger')
  const { backupRunning } = await import('../src/backup')
  while (backupRunning()) await Bun.sleep(50)
  await admin.login('admin', PASSWORD)
  secrets.push(admin.csrf, admin.cookie.split('=')[1])
})

describe('logger', () => {
  test('writes one JSON line per entry, and prints it too', () => {
    logger.log.info('log-test-info', 'สวัสดี')
    logger.log.warn('log-test-warn', { n: 1 })
    logger.log.error('log-test-error', new Error('พังแล้ว'))
    const last = readLines(paths.systemLog).slice(-3)
    expect(last.map(e => [e.level, e.event])).toEqual([['info', 'log-test-info'], ['warn', 'log-test-warn'], ['error', 'log-test-error']])
    expect(last[0].detail).toBe('สวัสดี')
    expect(last[1].detail).toEqual({ n: 1 })
    expect(last[2].detail.message).toBe('พังแล้ว')
    expect(last[2].detail.stack).toContain('logs.test.ts')
    expect(Date.parse(last[0].ts)).toBeGreaterThan(Date.now() - 60_000)
  })

  test('rotates at LOG_MAX_BYTES and keeps LOG_MAX_FILES files', () => {
    const keep = { bytes: config.logMaxBytes, files: config.logMaxFiles }
    config.logMaxBytes = 400
    config.logMaxFiles = 3
    try {
      for (let i = 0; i < 40; i++) logger.log.info('log-test-rotate', `entry ${i} ${'x'.repeat(60)}`)
      expect(existsSync(`${paths.systemLog}.1`)).toBe(true)
      expect(existsSync(`${paths.systemLog}.2`)).toBe(true)
      expect(existsSync(`${paths.systemLog}.3`)).toBe(false)
      for (const f of [paths.systemLog, `${paths.systemLog}.1`]) expect(readFileSync(f).length).toBeLessThan(400 + 200)
      // newest first, read across the rotated files
      const page = logger.queryLogs({ q: 'log-test-rotate', page: 1, pageSize: 5 })
      expect(page.items.map(e => e.detail)).toEqual(Array.from({ length: 5 }, (_, i) => `entry ${39 - i} ${'x'.repeat(60)}`))
      expect(page.hasMore).toBe(true)
    } finally {
      config.logMaxBytes = keep.bytes
      config.logMaxFiles = keep.files
    }
  })

  test('the activity log rotates the same way and is still read across its files', async () => {
    const { audit, queryAudit } = await import('../src/audit')
    const keep = config.auditMaxBytes
    config.auditMaxBytes = 300
    try {
      for (let i = 0; i < 12; i++) audit({ user: 'system', ip: '-', action: 'log-test-audit-rotate', target: `t${i}`, detail: 'y'.repeat(80) })
      expect(existsSync(`${paths.audit}.1`)).toBe(true)
      const r = queryAudit({ action: 'log-test-audit-rotate', page: 2, pageSize: 5 })
      expect(r.items.map(e => e.target)).toEqual(['t6', 't5', 't4', 't3', 't2'])
      expect(r.hasMore).toBe(true)
    } finally {
      config.auditMaxBytes = keep
    }
  })

  test('secret-looking fields, tokens in URLs and query strings are cut out', () => {
    logger.log.warn('log-test-secret', {
      password: 'hunter2-field', headers: { cookie: 'fc_sid=cookie-value-1', 'x-csrf-token': 'csrf-value-1' },
      url: 'http://localhost/api/batch/batch-token-1?space=home&path=/query-value-1',
      text: 'login failed password=hunter2-text cookie: fc_sid=cookie-value-2 csrf_token="csrf-value-2"',
      upload: '/api/upload/0123456789abcdef01234567/3',
    })
    const line = readFileSync(paths.systemLog, 'utf8').split('\n').filter(Boolean).at(-1)!
    for (const s of ['hunter2', 'cookie-value', 'csrf-value', 'batch-token-1', 'query-value-1', '0123456789abcdef01234567']) expect(line).not.toContain(s)
    const e = JSON.parse(line)
    expect(e.detail.url).toBe('http://localhost/api/batch/***')
    expect(e.detail.upload).toBe('/api/upload/***/3')
  })
})

describe('logs API', () => {
  test('a broken backup that an admin tries to restore shows up in /api/admin/logs', async () => {
    const broken = 'file-center-backup-20000104-000000.zip'
    writeFileSync(join(config.backupDir, broken), 'not a zip at all')
    process.env.FC_SUPERVISED = '1'
    try {
      expect((await admin.json('POST', '/api/admin/backups/restore', { name: broken, password: PASSWORD })).status).toBe(400)
    } finally {
      delete process.env.FC_SUPERVISED
      rmSync(join(config.backupDir, broken), { force: true })
    }
    const r = await admin.json('GET', '/api/admin/logs?level=warn&q=backup-restore-failed')
    expect(r.status).toBe(200)
    expect(r.data.items[0]).toMatchObject({ level: 'warn', event: 'backup-restore-failed', detail: { name: broken } })
    expect(r.data.items[0].detail.error.message).toContain('เสียหาย')
    expect(r.data.items.every((e: any) => e.level === 'warn')).toBe(true)
  })

  test('filters, pages and refuses an unknown level', async () => {
    for (let i = 0; i < 7; i++) logger.log.info('log-test-page', `page entry ${i}`)
    const p1 = await admin.json('GET', '/api/admin/logs?q=LOG-TEST-PAGE&pageSize=5')
    expect(p1.data.items.map((e: any) => e.detail)).toEqual([6, 5, 4, 3, 2].map(i => `page entry ${i}`))
    expect(p1.data.hasMore).toBe(true)
    const p2 = await admin.json('GET', '/api/admin/logs?q=log-test-page&pageSize=5&page=2')
    expect(p2.data.items.map((e: any) => e.detail)).toEqual(['page entry 1', 'page entry 0'])
    expect(p2.data.hasMore).toBe(false)
    expect((await admin.json('GET', '/api/admin/logs?level=error&q=log-test-page')).data.items).toEqual([])
    expect((await admin.json('GET', '/api/admin/logs?level=debug')).status).toBe(400)
  })

  test('the dashboard warns about errors of the last 24 hours', async () => {
    logger.log.error('log-test-dashboard', 'forced')
    const n = logger.errorsSince(Date.now() - 24 * 3600_000)
    expect(n).toBeGreaterThan(0)
    expect(logger.errorsSince(Date.now() + 60_000)).toBe(0)
    const status = await admin.json('GET', '/api/admin/status')
    expect(status.data.warnings).toContainEqual({ level: 'warning', code: 'errors', message: `มี error ${n} รายการใน 24 ชั่วโมงที่ผ่านมา`, params: { count: n } })
  })

  test('download: one zip with the system, launcher and activity logs', async () => {
    writeFileSync(paths.launcherLog, JSON.stringify({ ts: new Date().toISOString(), level: 'info', event: 'start', detail: 'เริ่มระบบ' }) + '\n')
    writeFileSync(paths.accessLog, '{"path":"/x"}\n')
    const res = await admin.raw('GET', '/api/admin/logs/download')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="file-center-logs-\d{8}-\d{6}\.zip"/)
    const zip = unzipSync(new Uint8Array(await res.arrayBuffer()))
    expect(Object.keys(zip)).toEqual(expect.arrayContaining(['system.log', 'system.log.1', 'launcher.log', 'audit.log']))
    expect(Object.keys(zip)).not.toContain('access.log')
    expect(new TextDecoder().decode(zip['launcher.log'])).toContain('เริ่มระบบ')
    expect((await admin.json('GET', '/api/admin/activity?action=logs-download')).data.items.length).toBe(1)
  })

  test('activity export: CSV with a BOM, the filters of the page, and formulas made harmless', async () => {
    const { audit } = await import('../src/audit')
    audit({ user: 'system', ip: '-1', action: 'log-test-csv', target: '=HYPERLINK("http://evil","คลิก")', detail: '@SUM(A1)' })
    audit({ user: 'system', ip: '+1', action: 'log-test-csv', target: '\tTab', detail: '\rCR' })
    audit({ user: 'system', ip: '127.0.0.1', action: 'log-test-csv', target: 'ไฟล์ "ปกติ".txt', detail: 'a,b\nc' })
    audit({ user: 'system', ip: '-', action: 'log-test-other', target: 'not exported' })
    const res = await admin.raw('GET', '/api/admin/activity/export?format=csv&action=log-test-csv')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="file-center-activity-\d{8}-\d{6}\.csv"/)
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(3))
    const lines = text.split('\r\n')
    expect(lines[0]).toBe('"เวลา","ผู้ใช้","IP","การกระทำ","รายการ","รายละเอียด"')
    expect(lines.length).toBe(5) // header, three rows, and the empty string after the last CRLF
    expect(lines[1]).toEndWith(`"system","127.0.0.1","log-test-csv","ไฟล์ ""ปกติ"".txt","a,b\nc"`)
    expect(lines[2]).toEndWith(`"system","'+1","log-test-csv","'\tTab","'\rCR"`)
    expect(lines[3]).toEndWith(`"system","'-1","log-test-csv","'=HYPERLINK(""http://evil"",""คลิก"")","'@SUM(A1)"`)
    expect(text).not.toContain('not exported')
    // no filter: everything, including what the page itself shows
    const all = await (await admin.raw('GET', '/api/admin/activity/export')).text()
    expect(all).toContain('not exported')
    expect((await admin.raw('GET', '/api/admin/activity/export?format=xlsx')).status).toBe(400)
    expect((await admin.json('GET', '/api/admin/activity?action=activity-export')).data.items.length).toBe(2)
  })
})

describe('access log and backups', () => {
  test('ACCESS_LOG=true writes one line per request, without tokens or query strings', async () => {
    rmSync(paths.accessLog, { force: true })
    config.accessLog = true
    let token = ''
    try {
      const r = await admin.json('POST', '/api/admin/users', { username: 'log-user', name: 'Log', password: USER_PASSWORD, role: 'user', permissions: ['read', 'download', 'batchdownload'], publicPermissions: [] })
      expect(r.status).toBe(200)
      const u = new Client()
      await u.login('log-user', USER_PASSWORD)
      secrets.push(u.csrf, u.cookie.split('=')[1])
      expect((await u.json('GET', '/api/list?space=home&path=/query-secret-dir')).status).toBe(404)
      writeFileSync(join(config.storageDir, 'users', 'log-user', 'a.txt'), 'a')
      token = (await u.json('POST', '/api/batch', { space: 'home', path: '/', items: ['a.txt'] })).data.token
      secrets.push(token)
      expect((await u.raw('GET', `/api/batch/${token}`)).status).toBe(200)
    } finally {
      config.accessLog = false
    }
    expect((await admin.json('GET', '/api/session')).status).toBe(200) // after switching off: not written
    await Bun.sleep(100) // the line is written after the response has gone out
    const lines = readLines(paths.accessLog)
    expect(lines.map(l => `${l.method} ${l.path} ${l.status} ${l.user}`)).toEqual([
      'POST /api/admin/users 200 admin',
      'GET /api/session 200 null',
      'POST /api/login 200 null',
      'GET /api/list 404 log-user',
      'POST /api/batch 200 log-user',
      'GET /api/batch/*** 200 log-user',
    ])
    for (const l of lines) {
      expect(typeof l.ms).toBe('number')
      expect(l.ip).toBeTruthy()
      expect(Date.parse(l.ts)).toBeGreaterThan(0)
    }
    expect(readFileSync(paths.accessLog, 'utf8')).not.toContain('query-secret-dir')
  })

  test('a backup holds logs/system.log, not the rotated, access or launcher logs', async () => {
    writeFileSync(`${paths.systemLog}.1`, '{"rotated":true}\n')
    const made = await admin.json('POST', '/api/admin/backups')
    expect(made.status).toBe(200)
    const zip = unzipSync(new Uint8Array(await (await admin.raw('GET', `/api/admin/backups/${made.data.name}/download`)).arrayBuffer()))
    const logs = Object.keys(zip).filter(n => n.startsWith('logs/')).sort()
    expect(logs).toEqual(['logs/', 'logs/audit.log', 'logs/system.log'])
  })

  test('no log file holds a password, session cookie, CSRF token or batch token', () => {
    expect(secrets.every(Boolean)).toBe(true)
    for (const name of readdirSync(paths.logs)) {
      const text = readFileSync(join(paths.logs, name), 'utf8')
      for (const s of secrets) expect(`${name}: ${text.includes(s)}`).toBe(`${name}: false`)
    }
  })
})

// ───────────── a real process: errors nobody caught ─────────────

describe('crash handlers (src/index.ts)', () => {
  test('an unhandled rejection is logged and the app goes on; an uncaught exception is logged and exits with 1', async () => {
    const root = resolve(import.meta.dir, '..')
    const dir = mkdtempSync(join(tmpdir(), 'fc-crash-'))
    try {
      // runs before src/index.ts; waits until index.ts has put its handlers in place, then misbehaves
      const preload = join(dir, 'misbehave.ts')
      writeFileSync(preload, `
        const t = setInterval(() => {
          if (!process.listenerCount('uncaughtException')) return
          clearInterval(t)
          Promise.reject(new Error('forced rejection password=crash-secret-1'))
          setTimeout(() => console.log('STILL-RUNNING'), 300)
          setTimeout(() => { throw new Error('forced crash') }, 600)
        }, 20)
      `)
      const p = Bun.spawn([process.execPath, '--preload', preload, join(root, 'src', 'index.ts')], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          PATH: process.env.PATH!, HOME: process.env.HOME ?? dir, PORT: '0', HOST: '127.0.0.1', BACKUP_HOUR: 'off',
          STORAGE_DIR: join(dir, 'storage'), DATA_DIR: join(dir, 'data'), BACKUP_DIR: join(dir, 'backups'), ADMIN_PASSWORD: 'crash-test-pass',
        },
      })
      const code = await Promise.race([p.exited, Bun.sleep(30_000).then(() => { p.kill('SIGKILL'); return 'timeout' })])
      const out = await new Response(p.stdout).text()
      expect(code).toBe(1)
      expect(out).toContain('STILL-RUNNING')
      const text = readFileSync(join(dir, 'data', 'logs', 'system.log'), 'utf8')
      expect(text).not.toContain('crash-secret-1')
      expect(text).not.toContain('crash-test-pass')
      const entries = text.split('\n').filter(Boolean).map(l => JSON.parse(l))
      expect(entries.find(e => e.event === 'unhandled-rejection')).toMatchObject({ level: 'error', detail: { message: 'forced rejection password=***' } })
      expect(entries.find(e => e.event === 'uncaught-exception')).toMatchObject({ level: 'error', detail: { message: 'forced crash' } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 40_000)
})
