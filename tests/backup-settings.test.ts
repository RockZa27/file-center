/**
 * Backup settings (compression, schedule, copies to keep, files included) and the disk-full guard. Runs the app in
 * this process like backup.test.ts; the free space is faked through `backupDeps.free`, so no disk is filled. Whatever a
 * test saves is cleared again, because the settings are shared with the other files of the run.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import './in-process-env'

const PASSWORD = process.env.ADMIN_PASSWORD!
const NAME_RE = /^file-center-backup-\d{8}-\d{6}\.zip$/

let app: any
let config: typeof import('../src/config').config
let paths: typeof import('../src/config').paths
let backup: typeof import('../src/backup')
let zip: typeof import('../src/zip')
let settings: typeof import('../src/settings').settings

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
const dec = new TextDecoder()
const put = (body: any) => admin.json('PUT', '/api/admin/backups/settings', body)
const metaOf = async (name: string) => JSON.parse(dec.decode(unzipSync(new Uint8Array(await (await admin.raw('GET', `/api/admin/backups/${name}/download`)).arrayBuffer()))['backup.json']))
const zipsOnDisk = () => readdirSync(config.backupDir).filter(n => NAME_RE.test(n)).sort()
const clearBackups = () => { for (const n of readdirSync(config.backupDir)) rmSync(join(config.backupDir, n), { force: true }) }

/** a local date-time: month is 1-12 */
const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0) => new Date(y, mo - 1, d, h, mi, s)
const ago = (now: Date, hours: number) => new Date(now.getTime() - hours * 3600_000).toISOString()
const statusFile = (lastSuccess: string | null, lastAttempt = lastSuccess) =>
  writeFileSync(paths.backupStatus, JSON.stringify({ status: 'ok', lastSuccess, lastAttempt, code: 'backup.done', params: {}, message: '', file: null, size: null }))

let savedStatus: string | null = null
const realFree = () => backup.backupDeps.free
let realFreeFn: (abs: string) => number | null
let realLimits: { margin: number; safety: number; checkEvery: number }

describe('backup settings and the disk guard', () => {
  beforeAll(async () => {
    ;({ app } = await import('../src/index'))
    ;({ config, paths } = await import('../src/config'))
    backup = await import('../src/backup')
    zip = await import('../src/zip')
    ;({ settings } = await import('../src/settings'))
    while (backup.backupRunning()) await Bun.sleep(50)
    await admin.login('admin', PASSWORD)
    savedStatus = (() => { try { return readFileSync(paths.backupStatus, 'utf8') } catch { return null } })()
    realFreeFn = realFree()
    realLimits = { ...backup.backupLimits }
    mkdirSync(config.backupDir, { recursive: true })
  })

  afterEach(() => {
    backup.backupDeps.free = realFreeFn
    Object.assign(backup.backupLimits, realLimits)
    settings.update({ backup: {} })
  })

  afterAll(() => {
    if (savedStatus !== null) writeFileSync(paths.backupStatus, savedStatus)
  })

  // ───────────── compression ─────────────

  test('level 9 makes logs and json smaller than level 1; downloads of users stay at level 1', async () => {
    const dir = join(config.dataDir, 'tmp', 'level-test')
    mkdirSync(dir, { recursive: true })
    try {
      let log = ''
      for (let i = 0; log.length < 2_000_000; i++) log += JSON.stringify({ ts: 1_700_000_000_000 + i * 7311, user: `user${i % 50}`, action: ['upload', 'login', 'delete'][i % 3], target: `/users/u${i % 50}/f${i}.pdf` }) + '\n'
      writeFileSync(join(dir, 'audit.log'), log)
      writeFileSync(join(dir, 'picture.png'), log) // compressible bytes, but a name that is stored as it is
      const sized = async (level?: number) => {
        const sizes: Record<string, { uncompressed: number; compressed: number }> = {}
        const bytes = new Uint8Array(await new Response(zip.zipStream(zip.collectZipItems(dir, ['audit.log', 'picture.png']), { level, onEntry: (i, s) => { sizes[i.name] = s } })).arrayBuffer())
        return { total: bytes.length, sizes, files: unzipSync(bytes) }
      }
      const one = await sized(1)
      const nine = await sized(9)
      const none = await sized() // no option = level 1, as every other zip of the app
      expect(nine.sizes['audit.log'].compressed).toBeLessThan(one.sizes['audit.log'].compressed)
      expect(nine.total).toBeLessThan(one.total)
      expect(none.sizes['audit.log'].compressed).toBe(one.sizes['audit.log'].compressed)
      // already-compressed kinds of file stay stored whatever the level
      expect(nine.sizes['picture.png'].compressed).toBe(nine.sizes['picture.png'].uncompressed)
      expect(dec.decode(nine.files['audit.log'])).toBe(log)
      expect(dec.decode(one.files['audit.log'])).toBe(log)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the compression chosen on the page is the one the backup uses', async () => {
    const big = join(config.dataDir, 'compress-me.json')
    let log = ''
    for (let i = 0; log.length < 3_000_000; i++) log += JSON.stringify({ ts: 1_700_000_000_000 + i * 7311, user: `user${i % 50}`, target: `/users/u${i % 50}/f${i}.pdf` }) + '\n'
    writeFileSync(big, log)
    try {
      expect((await admin.json('GET', '/api/admin/backups')).data.settings.compression).toBe('smallest')
      const sizes: Record<string, number> = {}
      for (const c of ['fast', 'balanced', 'smallest']) {
        expect((await put({ compression: c })).data.compression).toBe(c)
        const made = await admin.json('POST', '/api/admin/backups')
        expect(made.status).toBe(200)
        sizes[c] = made.data.size
        const meta = await metaOf(made.data.name)
        expect(meta).toMatchObject({ compression: c, level: { fast: 1, balanced: 6, smallest: 9 }[c] })
        expect(dec.decode(unzipSync(new Uint8Array(await (await admin.raw('GET', `/api/admin/backups/${made.data.name}/download`)).arrayBuffer()))['compress-me.json'])).toBe(log)
        await Bun.sleep(1100) // names have one-second precision
      }
      expect(sizes.smallest).toBeLessThan(sizes.fast)
      expect(sizes.balanced).toBeLessThan(sizes.fast)
    } finally {
      rmSync(big, { force: true })
    }
  }, 30_000)

  // ───────────── the schedule ─────────────

  test('off never runs, whatever the last backup', () => {
    settings.update({ backup: { schedule: { mode: 'off' } } })
    const now = at(2026, 3, 10, 3, 0)
    statusFile(ago(now, 24 * 400))
    expect(backup.backupDue(now)).toBe(false)
    rmSync(paths.backupStatus)
    expect(backup.backupDue(now)).toBe(false)
  })

  test('daily: runs in the hour after the chosen time, to the minute', () => {
    settings.update({ backup: { schedule: { mode: 'daily', time: '14:30' } } })
    const last = at(2026, 3, 9, 14, 30)
    statusFile(last.toISOString())
    expect(backup.backupDue(at(2026, 3, 10, 14, 29, 59))).toBe(false)
    expect(backup.backupDue(at(2026, 3, 10, 14, 30))).toBe(true)
    expect(backup.backupDue(at(2026, 3, 10, 15, 29))).toBe(true)
    expect(backup.backupDue(at(2026, 3, 10, 15, 30))).toBe(false)
    // the chosen time decides, not another hour
    expect(backup.backupDue(at(2026, 3, 10, 3, 0))).toBe(false)
    expect(backup.backupDue(at(2026, 3, 10, 14, 0))).toBe(false)
    // one already made this morning counts as the day's backup; one that failed a minute ago is not retried at once
    const nowT = at(2026, 3, 10, 14, 31)
    statusFile(ago(nowT, 5))
    expect(backup.backupDue(nowT)).toBe(false)
    statusFile(last.toISOString(), ago(nowT, 0.02))
    expect(backup.backupDue(nowT)).toBe(false)
  })

  test('a schedule saved after a time does not run that time', async () => {
    const now = new Date()
    statusFile(ago(now, 30))
    expect((await put({ schedule: { mode: 'daily', time: '00:00' } })).status).toBe(200)
    // today's 00:00 is before the change
    expect(backup.backupDue(at(now.getFullYear(), now.getMonth() + 1, now.getDate(), 0, 10))).toBe(false)
    expect(backup.backupDue(at(now.getFullYear(), now.getMonth() + 1, now.getDate() + 1, 0, 10))).toBe(true)
  })

  test('weekly: only the chosen days', () => {
    // 5 January 2026 is a Monday
    expect(at(2026, 1, 5, 9, 0).getDay()).toBe(1)
    settings.update({ backup: { schedule: { mode: 'weekly', days: [1, 3], time: '09:00' } } })
    statusFile(at(2026, 1, 3, 9, 0).toISOString()) // the Saturday before
    expect(backup.backupDue(at(2026, 1, 5, 8, 59))).toBe(false)
    expect(backup.backupDue(at(2026, 1, 5, 9, 0))).toBe(true)
    expect(backup.backupDue(at(2026, 1, 6, 9, 0))).toBe(false) // Tuesday
    statusFile(at(2026, 1, 5, 9, 1).toISOString())
    expect(backup.backupDue(at(2026, 1, 6, 9, 5))).toBe(false)
    expect(backup.backupDue(at(2026, 1, 7, 9, 0))).toBe(true) // Wednesday
    expect(backup.backupDue(at(2026, 1, 8, 9, 0))).toBe(false) // Thursday
    expect(backup.backupDue(at(2026, 1, 11, 9, 0))).toBe(false) // Sunday
    // a weekly schedule is not rushed by the 2-day net: a gap of 5 days is its own rhythm
    expect(backup.backupDue(at(2026, 1, 10, 15, 0))).toBe(false)
  })

  test('interval: when that many hours passed since the last backup', () => {
    settings.update({ backup: { schedule: { mode: 'interval', hours: 6 } } })
    const now = at(2026, 3, 10, 13, 17)
    statusFile(ago(now, 5.99))
    expect(backup.backupDue(now)).toBe(false)
    statusFile(ago(now, 6))
    expect(backup.backupDue(now)).toBe(true)
    statusFile(ago(now, 7), ago(now, 1)) // a failed attempt an hour ago counts as the last one
    expect(backup.backupDue(now)).toBe(false)
    rmSync(paths.backupStatus)
    expect(backup.backupDue(now)).toBe(true)
  })

  test('the safety net: no success for 2 days runs a backup, at most once an hour, unless off', () => {
    settings.update({ backup: { schedule: { mode: 'daily', time: '03:00' } } })
    const now = at(2026, 3, 10, 16, 0) // far from 03:00
    statusFile(ago(now, 47))
    expect(backup.backupDue(now)).toBe(false)
    statusFile(ago(now, 49))
    expect(backup.backupDue(now)).toBe(true)
    statusFile(ago(now, 49), ago(now, 0.5))
    expect(backup.backupDue(now)).toBe(false)
    statusFile(ago(now, 49), ago(now, 2))
    expect(backup.backupDue(now)).toBe(true)
    settings.update({ backup: { schedule: { mode: 'off' } } })
    expect(backup.backupDue(now)).toBe(false)
  })

  test('without a saved schedule BACKUP_HOUR is the daily default', async () => {
    const hour = config.backupHour
    try {
      config.backupHour = 5
      expect((await admin.json('GET', '/api/admin/backups')).data.settings).toMatchObject({ schedule: { mode: 'daily', time: '05:00' }, hour: 5, saved: {} })
      config.backupHour = null
      expect((await admin.json('GET', '/api/admin/backups')).data.settings.schedule).toEqual({ mode: 'off' })
    } finally {
      config.backupHour = hour
    }
  })

  // ───────────── saving the settings ─────────────

  test('bad values are refused and nothing is saved', async () => {
    const bad: any[] = [
      { schedule: { mode: 'daily', time: '24:00' } }, { schedule: { mode: 'daily', time: '9:05' } }, { schedule: { mode: 'daily', time: '12:60' } },
      { schedule: { mode: 'daily' } }, { schedule: { mode: 'weekly', days: [7], time: '03:00' } }, { schedule: { mode: 'weekly', days: [-1], time: '03:00' } },
      { schedule: { mode: 'weekly', days: [], time: '03:00' } }, { schedule: { mode: 'weekly', days: [1.5], time: '03:00' } },
      { schedule: { mode: 'weekly', time: '03:00' } }, { schedule: { mode: 'interval', hours: 0 } }, { schedule: { mode: 'interval', hours: 169 } },
      { schedule: { mode: 'interval', hours: 1.5 } }, { schedule: { mode: 'hourly' } }, { schedule: 'daily' },
      { keep: 0 }, { keep: 31 }, { keep: 1.5 }, { compression: 'max' }, { compression: '' },
      // one bad value stops the others from being saved as well
      { compression: 'fast', keep: 0 },
    ]
    for (const body of bad) {
      const r = await put(body)
      expect(`${JSON.stringify(body)} ${r.status}`).toBe(`${JSON.stringify(body)} 400`)
      expect(typeof r.data.code).toBe('string')
    }
    expect(settings.get().backup).toEqual({})
    expect(await put({ keep: 'x' })).toMatchObject({ status: 422 })
  })

  test('good values are saved, shown back with the time zone, and null goes back to the default', async () => {
    const r = await put({ compression: 'balanced', keep: 30, schedule: { mode: 'weekly', days: [3, 1, 3], time: '23:59' } })
    expect(r.status).toBe(200)
    expect(r.data).toMatchObject({
      compression: 'balanced', keep: 30, schedule: { mode: 'weekly', days: [1, 3], time: '23:59' }, includeFiles: false, hour: null,
      saved: { compression: 'balanced', keep: 30, schedule: { mode: 'weekly', days: [1, 3], time: '23:59' } },
      timezone: { offsetMinutes: -new Date().getTimezoneOffset() || 0 },
    })
    expect(typeof r.data.timezone.name).toBe('string')
    expect(Date.parse(r.data.nextRun)).toBeGreaterThan(Date.now())
    expect(new Date(r.data.nextRun).getHours()).toBe(23)
    expect([1, 3]).toContain(new Date(r.data.nextRun).getDay())
    expect((await admin.json('GET', '/api/admin/backups')).data.settings).toMatchObject({ compression: 'balanced', keep: 30 })
    expect((await put({ keep: 1 })).data).toMatchObject({ keep: 1, compression: 'balanced' }) // a key left out stays
    const reset = await put({ compression: null, keep: null, schedule: null })
    expect(reset.data).toMatchObject({ compression: 'smallest', keep: config.backupKeep, saved: {} })
    expect((await put({ schedule: { mode: 'off' } })).data.nextRun).toBeNull()
    expect((await put({ schedule: { mode: 'interval', hours: 168 } })).data.schedule).toEqual({ mode: 'interval', hours: 168 })
    const act = (await admin.json('GET', '/api/admin/activity?action=backup-settings')).data.items
    expect(act.length).toBeGreaterThanOrEqual(5)
    expect(act[0].detail).toContain('schedule=')
  })

  test('turning the files on needs the password again, and then keeps 2 copies unless a number was saved', async () => {
    // (one wrong try only: three in a row lock the step-up for every test file that runs after this one)
    expect((await put({ includeFiles: true })).status).toBe(403)
    expect(settings.get().backup.includeFiles).toBeUndefined()
    expect((await admin.json('GET', '/api/admin/activity?action=backup-settings-denied')).data.items.length).toBeGreaterThan(0)
    const on = await put({ includeFiles: true, password: PASSWORD })
    expect(on.status).toBe(200)
    expect(on.data).toMatchObject({ includeFiles: true, includesFiles: true, keep: 2 })
    // already on: no password for other changes, and a saved number wins
    expect((await put({ keep: 5 })).data).toMatchObject({ keep: 5, includeFiles: true })
    // turning off needs none
    const off = await put({ includeFiles: false })
    expect(off.status).toBe(200)
    expect(off.data).toMatchObject({ includeFiles: false, keep: 5 })
  })

  test('only admins use the settings and the estimate', async () => {
    expect((await admin.json('POST', '/api/admin/users', { username: 'bk-settings-user', name: 'x', password: 'harbor-lamp-42', role: 'user', permissions: ['read'], publicPermissions: [] })).status).toBe(200)
    const u = new Client()
    await u.login('bk-settings-user', 'harbor-lamp-42')
    const guest = new Client()
    guest.csrf = (await guest.json('GET', '/api/session')).data.csrf
    for (const [method, path, body] of [['PUT', '/api/admin/backups/settings', { keep: 3 }], ['GET', '/api/admin/backups/estimate']] as const) {
      expect((await u.raw(method, path, body)).status).toBe(403)
      expect((await guest.raw(method, path, body)).status).toBe(401)
    }
    expect(settings.get().backup).toEqual({})
  })

  // ───────────── sizes of the parts ─────────────

  test('backup.json and the listing tell the size of each part; an old backup has none', async () => {
    clearBackups()
    const made = await admin.json('POST', '/api/admin/backups')
    expect(made.status).toBe(200)
    const meta = await metaOf(made.data.name)
    expect(meta.parts).toEqual(made.data.parts)
    for (const part of ['data', 'logs', 'storage']) expect(Object.keys(made.data.parts[part]).sort()).toEqual(['compressed', 'files', 'size'])
    expect(made.data.parts.data.size).toBeGreaterThan(0)
    expect(made.data.parts.data.compressed).toBeGreaterThan(0)
    expect(made.data.parts.logs.size).toBeGreaterThan(0)
    expect(made.data.parts.storage).toEqual({ files: 0, size: 0, compressed: 0 })

    // one made before this version: its backup.json has no sizes
    const old = 'file-center-backup-20000101-000000.zip'
    const { zipSync } = await import('fflate')
    writeFileSync(join(config.backupDir, old), zipSync({ 'users.json': new Uint8Array([123, 125]), 'backup.json': new TextEncoder().encode(JSON.stringify({ version: '1.9.1', createdAt: '2000-01-01T00:00:00Z', includesFiles: false })) }))
    writeFileSync(join(config.backupDir, 'file-center-backup-20000102-000000.zip'), 'not a zip at all')
    const items = (await admin.json('GET', '/api/admin/backups')).data.items
    expect(items.map((i: any) => i.name)).toEqual([made.data.name, 'file-center-backup-20000102-000000.zip', old])
    expect(items[0]).toEqual(made.data)
    expect(items[1].parts).toBeNull()
    expect(items[2].parts).toBeNull()
    expect(items[2].size).toBe(statSync(join(config.backupDir, old)).size)
    clearBackups()
  })

  // ───────────── the disk guard ─────────────

  test('the estimate: sizes of the parts, 5% and 1 GB on top, and whether it fits', async () => {
    const r = await admin.json('GET', '/api/admin/backups/estimate')
    expect(r.status).toBe(200)
    expect(Object.keys(r.data).sort()).toEqual(['estimate', 'free', 'needed', 'ok', 'parts'])
    expect(r.data.parts.storage).toBe(0) // the files are not in the backup
    expect(r.data.estimate).toBe(r.data.parts.data + r.data.parts.logs + r.data.parts.storage)
    expect(r.data.needed).toBe(Math.ceil(r.data.estimate * 1.05) + 1024 ** 3)
    expect(r.data.ok).toBe(r.data.free >= r.data.needed)

    // (the real count comes from the dashboard's numbers, up to a minute old; here it is a known size)
    const realSize = backup.backupDeps.storageSize
    try {
      settings.update({ backup: { includeFiles: true } })
      backup.backupDeps.storageSize = async () => 777_000
      backup.backupDeps.free = () => 5 * 1024 ** 3
      const withFiles = (await admin.json('GET', '/api/admin/backups/estimate')).data
      expect(withFiles.parts.storage).toBe(777_000)
      expect(withFiles.estimate).toBe(withFiles.parts.data + withFiles.parts.logs + 777_000)
      expect(withFiles).toMatchObject({ free: 5 * 1024 ** 3, ok: true })
      backup.backupDeps.free = () => 1024 ** 3
      expect((await admin.json('GET', '/api/admin/backups/estimate')).data.ok).toBe(false)
    } finally {
      backup.backupDeps.storageSize = realSize
    }
  }, 30_000)

  /** a disk of `room` bytes beyond what a backup needs, shared with the files in the backup folder */
  async function fakeDisk(roomBeyondNeeded: number) {
    const { needed } = await backup.estimateBackup(false)
    const used = () => readdirSync(config.backupDir).reduce((sum, n) => sum + statSync(join(config.backupDir, n)).size, 0)
    backup.backupDeps.free = () => needed + roomBeyondNeeded - used()
    return needed
  }
  const plant = (n: number, bytes: number) => {
    for (let i = 1; i <= n; i++) writeFileSync(join(config.backupDir, `file-center-backup-2000010${i}-000000.zip`), Buffer.alloc(bytes, i))
  }

  test('too little room: the oldest backups go one by one, the newest stays, then the backup is made', async () => {
    clearBackups()
    plant(4, 4 * 1024 * 1024) // 16 MB
    await put({ keep: 30 })
    await fakeDisk(9 * 1024 * 1024) // fits once two of them are gone
    const made = await admin.json('POST', '/api/admin/backups')
    expect(made.status).toBe(200)
    expect(zipsOnDisk()).toEqual(['file-center-backup-20000103-000000.zip', 'file-center-backup-20000104-000000.zip', made.data.name])
    const removed = (await admin.json('GET', '/api/admin/activity?action=backup-delete')).data.items.slice(0, 2).map((i: any) => i.target)
    expect(removed.sort()).toEqual(['file-center-backup-20000101-000000.zip', 'file-center-backup-20000102-000000.zip'])
    clearBackups()
  })

  test('still too little after deleting: nothing starts, the last good backup is kept, and the status and alert say how much', async () => {
    clearBackups()
    plant(3, 1024)
    const hooks: any[] = []
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { hooks.push(await req.json()); return new Response('ok') } })
    const alerts = await import('../src/alerts')
    const saved = { url: config.alertWebhookUrl, kind: config.alertWebhookKind }
    try {
      config.alertWebhookUrl = `http://127.0.0.1:${server.port}/hook`
      config.alertWebhookKind = 'json'
      alerts.resetAlerts()
      backup.backupDeps.free = () => 1000 // never enough
      const r = await admin.json('POST', '/api/admin/backups')
      expect(r.status).toBe(507)
      expect(r.data.code).toBe('backup.no-space')
      expect(r.data.params.freeBytes).toBe(1000)
      expect(r.data.params.neededBytes).toBeGreaterThan(1024 ** 3)
      // the older ones were tried, the newest stays and no half-written file is left
      expect(readdirSync(config.backupDir)).toEqual(['file-center-backup-20000103-000000.zip'])
      const status = (await admin.json('GET', '/api/admin/backups')).data.status
      expect(status).toMatchObject({ status: 'failed', code: 'backup.no-space', file: null })
      expect(status.params.neededBytes).toBe(r.data.params.neededBytes)
      expect(status.message).toContain('พื้นที่ว่าง')
      expect((await admin.json('GET', '/api/admin/backups', undefined)).data.status.message).toBeTruthy()
      await alerts.alertsIdle()
      expect(hooks.length).toBe(1)
      expect(hooks[0]).toMatchObject({ event: 'backup-failed', code: 'backup.no-space' })
      // a single backup is never deleted to make room
      expect((await admin.json('POST', '/api/admin/backups')).status).toBe(507)
      expect(readdirSync(config.backupDir)).toEqual(['file-center-backup-20000103-000000.zip'])
    } finally {
      config.alertWebhookUrl = saved.url
      config.alertWebhookKind = saved.kind
      alerts.resetAlerts()
      await server.stop(true)
      clearBackups()
    }
  })

  test('the status text is in the language of the request', async () => {
    clearBackups()
    backup.backupDeps.free = () => 1000
    expect((await admin.json('POST', '/api/admin/backups')).status).toBe(507)
    const res = await app.handle(new Request('http://localhost/api/admin/backups', { headers: { cookie: admin.cookie, 'x-lang': 'en' } }))
    expect(((await res.json()) as any).status.message).toStartWith('Not enough free space for the backup: ')
  })

  test('the free space falling while writing stops the backup and deletes the unfinished file', async () => {
    clearBackups()
    plant(1, 10)
    let calls = 0
    // the first look (before the backup) has room; the next one, while it is being written, does not
    backup.backupDeps.free = () => (++calls === 1 ? 1e12 : 10)
    backup.backupLimits.checkEvery = 1
    const r = await admin.json('POST', '/api/admin/backups')
    expect(r.status).toBe(507)
    expect(r.data.code).toBe('backup.aborted-no-space')
    expect(readdirSync(config.backupDir)).toEqual(['file-center-backup-20000101-000000.zip']) // no .partial, no new zip
    expect((await admin.json('GET', '/api/admin/backups')).data.status).toMatchObject({ status: 'failed', code: 'backup.aborted-no-space' })
    expect(backup.backupRunning()).toBe(false)
    clearBackups()
  })

  test('an ordinary backup passes the guard and the look while writing', async () => {
    clearBackups()
    backup.backupDeps.free = () => 1e12
    backup.backupLimits.checkEvery = 1
    const made = await admin.json('POST', '/api/admin/backups')
    expect(made.status).toBe(200)
    expect(zipsOnDisk()).toEqual([made.data.name])
  })
})
