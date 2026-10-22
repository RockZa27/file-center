/**
 * Durability fixes of 1.12.1: the stores are flushed before the server is waited for, a failed write is retried and
 * reported, a corrupt data file stops the start, a crash while trashing leaves nothing invisible, backups keep their
 * old copies until the new one is complete, a slow release is not deleted, a restore on another host says that 2FA
 * secrets can not be opened. Runs in-process on the same app as api.test.ts (see in-process-env.ts); the parts that
 * end the process or fail at import time run in a child process of their own.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { base } from './in-process-env'

const ROOT = resolve(import.meta.dir, '..')
const scratch = mkdtempSync(join(base, 'durability-'))
let n = 0
const fresh = (name: string) => { const d = join(scratch, `${name}-${++n}`); mkdirSync(d, { recursive: true }); return d }

/** run a script in a child bun with its own data folders; returns exit code and what it printed */
async function child(script: string, env: Record<string, string> = {}) {
  const dir = fresh('child')
  const file = join(dir, 'run.ts')
  writeFileSync(file, script)
  const proc = Bun.spawn([process.execPath, file], {
    cwd: dir, stdout: 'pipe', stderr: 'pipe',
    env: { PATH: process.env.PATH!, HOME: dir, DATA_DIR: join(dir, 'data'), STORAGE_DIR: join(dir, 'storage'), ADMIN_PASSWORD: 'x-test-pass-1', UPDATE_SOURCE: 'off', ...env },
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, out, err, dir }
}
const src = (name: string) => JSON.stringify(join(ROOT, 'src', name))

describe('shutdown writes the stores before it waits for the server', () => {
  test('a server that never stops (a long transfer) does not cost the queued changes', async () => {
    const file = join(fresh('shutdown'), 'a.json')
    const r = await child(`
      import { JsonStore } from ${src('store')}
      import { onStop, shutdown } from ${src('lifecycle')}
      const s = new JsonStore<{ n: number }>(${JSON.stringify(file)}, () => ({ n: 0 }))
      s.updateSoon(d => { d.n = 5 }, 60_000)
      onStop(() => new Promise(() => {}))
      await shutdown(0, 2000, 200)
    `)
    expect(r.code).toBe(0)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ n: 5 })
  })

  test('a change made while the server drains is written too', async () => {
    const file = join(fresh('shutdown'), 'a.json')
    const r = await child(`
      import { JsonStore } from ${src('store')}
      import { onStop, shutdown } from ${src('lifecycle')}
      const s = new JsonStore<{ n: number }>(${JSON.stringify(file)}, () => ({ n: 0 }))
      onStop(async () => { s.updateSoon(d => { d.n = 9 }, 60_000); await new Promise(() => {}) })
      await shutdown(0, 3000, 200)
    `)
    expect(r.code).toBe(0)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ n: 9 })
  })

  test('when the time runs out first, what is only in memory is written before the exit', async () => {
    const file = join(fresh('shutdown'), 'a.json')
    const r = await child(`
      import { JsonStore } from ${src('store')}
      import { onStop, shutdown } from ${src('lifecycle')}
      const s = new JsonStore<{ n: number }>(${JSON.stringify(file)}, () => ({ n: 0 }))
      onStop(async () => { s.updateSoon(d => { d.n = 7 }, 60_000); await new Promise(() => {}) })
      await shutdown(3, 500, 60_000)
    `)
    expect(r.code).toBe(3)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ n: 7 })
  })
})

describe('JsonStore: a write that fails', () => {
  let JsonStore: typeof import('../src/store').JsonStore
  let keep: typeof JsonStore.retry
  let keepHook: typeof JsonStore.onWriteFailed
  beforeAll(async () => {
    ;({ JsonStore } = await import('../src/store'))
    await import('../src/alerts') // registers the hook the last test looks at
    keep = { ...JsonStore.retry, delaysMs: [...JsonStore.retry.delaysMs] }
    keepHook = JsonStore.onWriteFailed
  })
  afterEach(() => {
    JsonStore.retry = { ...keep, delaysMs: [...keep.delaysMs] }
    JsonStore.onWriteFailed = keepHook
  })

  /** a store whose folder is gone, so every write fails */
  function broken() {
    const dir = fresh('store')
    const file = join(dir, 'disk-full-demo.json')
    const s = new JsonStore<{ n: number }>(file, () => ({ n: 0 }))
    rmSync(dir, { recursive: true, force: true })
    return { dir, file, s }
  }

  test('is retried, reported once when the tries run out, and written once the disk works again', async () => {
    JsonStore.retry = { delaysMs: [1, 1], laterMs: 60_000 }
    const reports: string[] = []
    JsonStore.onWriteFailed = file => { reports.push(file) }
    const { dir, file, s } = broken()
    s.update(d => { d.n = 1 })
    await s.idle()
    expect(reports).toEqual([file])
    mkdirSync(dir, { recursive: true })
    s.update(d => { d.n = 2 })
    await s.idle()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ n: 2 })
    expect(reports.length).toBe(1)
  })

  test('a store whose tries ran out tries again by itself', async () => {
    JsonStore.retry = { delaysMs: [], laterMs: 20 }
    JsonStore.onWriteFailed = () => {}
    const { dir, file, s } = broken()
    s.update(d => { d.n = 4 })
    await s.idle()
    expect(existsSync(file)).toBe(false)
    mkdirSync(dir, { recursive: true })
    const until = Date.now() + 10_000
    while (!existsSync(file) && Date.now() < until) await Bun.sleep(10)
    await s.idle()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ n: 4 })
  })

  test('the admin is alerted (alerts.ts registers itself on the store)', async () => {
    const alerts = await import('../src/alerts')
    const { config } = await import('../src/config')
    const got: any[] = []
    const hook = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async req => { got.push(await req.json()); return new Response('ok') } })
    const saved = { url: config.alertWebhookUrl, kind: config.alertWebhookKind }
    try {
      Object.assign(config, { alertWebhookUrl: `http://127.0.0.1:${hook.port}/h`, alertWebhookKind: 'json' })
      alerts.resetAlerts()
      JsonStore.retry = { delaysMs: [], laterMs: 60_000 }
      const { dir, s } = broken()
      s.update(d => { d.n = 1 })
      await s.idle()
      await alerts.alertsIdle()
      expect(got.map(g => g.event)).toEqual(['store-write-failed'])
      expect(got[0].code).toBe('admin.alert-store-write')
      expect(got[0].message).toContain('disk-full-demo.json')
      // the "disk" works again: nothing is left that would try (and fail, and alert) minutes into another test file
      mkdirSync(dir, { recursive: true })
      s.save()
      await s.idle()
    } finally {
      Object.assign(config, { alertWebhookUrl: saved.url, alertWebhookKind: saved.kind })
      alerts.resetAlerts()
      hook.stop(true)
    }
  })
})

describe('a corrupt data file stops the start', () => {
  for (const [module, file] of [['groups', 'groups.json'], ['grants', 'grants.json'], ['shares', 'shares.json'], ['app-passwords', 'app-passwords.json']] as const) {
    test(`${file} is not reset to empty`, async () => {
      const dir = fresh('corrupt')
      const data = join(dir, 'data')
      mkdirSync(data, { recursive: true })
      writeFileSync(join(data, file), '{ "broken": ')
      const r = await child(`await import(${src(module)}); console.log('started')`, { DATA_DIR: data, STORAGE_DIR: join(dir, 'storage') })
      expect(r.code).not.toBe(0)
      expect(r.out).not.toContain('started')
      // the file is still the broken one, one copy is kept, and the message says what to do
      expect(readFileSync(join(data, file), 'utf8')).toBe('{ "broken": ')
      expect(readdirSync(data).filter(f => f.startsWith(`${file}.broken-`)).length).toBe(1)
      expect(r.err).toContain(file)
      expect(r.err).toContain('To recover')
      expect(r.err).toContain('วิธีแก้')
    })
  }

  test('favorites and recents still start fresh', async () => {
    const { JsonStore } = await import('../src/store')
    const file = join(fresh('corrupt'), 'user-state.json')
    writeFileSync(file, 'nope')
    expect(new JsonStore<Record<string, number>>(file, () => ({ fresh: 1 })).value).toEqual({ fresh: 1 })
    expect(readdirSync(join(file, '..')).some(f => f.startsWith('user-state.json.broken-'))).toBe(true)
  })
})

describe('trash: a crash between the move and the record', () => {
  let trash: typeof import('../src/trash')
  let paths: typeof import('../src/config').paths
  let config: typeof import('../src/config').config
  beforeAll(async () => {
    trash = await import('../src/trash')
    ;({ paths, config } = await import('../src/config'))
  })
  const ids: string[] = []
  const newId = () => { const id = `${String(9_000_000_000_000 + ++n)}_${(0xabc00000 + n).toString(16)}`; ids.push(id); return id }
  afterEach(() => { for (const id of ids.splice(0)) rmSync(join(paths.trash, id), { recursive: true, force: true }) })

  test('the record is on disk before the item moves, and a crash in the move loses nothing', async () => {
    // the process "dies" right after the item moved: a child runs the real code against a data folder of its own
    const dir = fresh('trash-crash')
    const data = join(dir, 'data')
    const storage = join(dir, 'storage')
    mkdirSync(storage, { recursive: true })
    writeFileSync(join(storage, 'precious.txt'), 'keep me')
    const r = await child(`
      import { rename } from 'node:fs/promises'
      import { ensureDirs } from ${src('config')}
      ensureDirs()
      const trash = await import(${src('trash')})
      trash.trashDeps.move = async (from, to) => { await rename(from, to); process.exit(9) }
      await trash.moveToTrash(${JSON.stringify(join(storage, 'precious.txt'))}, 'tester')
    `, { DATA_DIR: data, STORAGE_DIR: storage })
    expect(r.code).toBe(9)
    const [id] = readdirSync(join(data, 'trash'))
    expect(existsSync(join(data, 'trash', id, 'item'))).toBe(true)
    expect(JSON.parse(readFileSync(join(data, 'trash', id, 'meta.json'), 'utf8'))).toMatchObject({ id, name: 'precious.txt', originalPath: '/precious.txt' })
  })

  test('an item without a record (an older version crashed there) is adopted, owner nobody', async () => {
    const id = newId()
    mkdirSync(join(paths.trash, id, 'item'), { recursive: true })
    writeFileSync(join(paths.trash, id, 'item', 'a.txt'), 'abcd')
    expect(trash.listTrash().some(m => m.id === id)).toBe(false)
    expect(trash.repairTrash().adopted).toBe(1)
    const meta = trash.listTrash().find(m => m.id === id)!
    expect(meta).toMatchObject({ type: 'dir', size: 4, owner: null, space: 'other', deletedBy: 'system' })
    expect(Date.now() - Date.parse(meta.deletedAt)).toBeLessThan(60_000)
    // an adopted entry is whole now
    expect(trash.repairTrash()).toEqual({ adopted: 0, purged: 0 })
    const back = await trash.restore(id)
    try {
      expect(back.restoredTo).toBe(`/recovered-from-trash/${id}`)
      expect(readFileSync(join(config.storageDir, 'recovered-from-trash', id, 'a.txt'), 'utf8')).toBe('abcd')
    } finally {
      rmSync(join(config.storageDir, 'recovered-from-trash'), { recursive: true, force: true })
    }
  })

  test('a record without an item is removed; a complete entry is left alone', () => {
    const record = (id: string, name: string) => JSON.stringify({ id, name, type: 'file', size: 1, originalPath: name, deletedAt: new Date().toISOString(), deletedBy: 'u' })
    const lonely = newId()
    mkdirSync(join(paths.trash, lonely), { recursive: true })
    writeFileSync(join(paths.trash, lonely, 'meta.json'), record(lonely, 'x'))
    const whole = newId()
    mkdirSync(join(paths.trash, whole), { recursive: true })
    writeFileSync(join(paths.trash, whole, 'item'), 'x')
    writeFileSync(join(paths.trash, whole, 'meta.json'), record(whole, 'y'))
    expect(trash.repairTrash().purged).toBe(1)
    expect(existsSync(join(paths.trash, lonely))).toBe(false)
    expect(existsSync(join(paths.trash, whole, 'item'))).toBe(true)
    expect(trash.listTrash().some(m => m.id === whole)).toBe(true)
  })

  test('an entry being made right now is not touched', async () => {
    const file = join(config.storageDir, `durability-slow-${++n}.txt`)
    mkdirSync(config.storageDir, { recursive: true })
    writeFileSync(file, 'slow')
    let seen: { adopted: number; purged: number } | null = null
    let listed = true
    const real = trash.trashDeps.move
    trash.trashDeps.move = async (from, to) => {
      // the record is there, the item is not yet: neither repair nor the list may act on it
      seen = trash.repairTrash()
      listed = trash.listTrash().some(m => to.includes(m.id))
      await real(from, to)
    }
    try {
      const meta = await trash.moveToTrash(file, 'tester')
      ids.push(meta.id)
      expect(seen).toEqual({ adopted: 0, purged: 0 })
      expect(listed).toBe(false)
      expect(existsSync(join(paths.trash, meta.id, 'item'))).toBe(true)
      expect(trash.listTrash().some(m => m.id === meta.id)).toBe(true)
    } finally {
      trash.trashDeps.move = real
    }
  })
})

describe('backups: names, order and what is deleted when', () => {
  let backup: typeof import('../src/backup')
  let config: typeof import('../src/config').config
  let alerts: typeof import('../src/alerts')
  let notify: typeof import('../src/notify')
  const keep = { dir: '', free: null as any, limits: null as any, keepSetting: undefined as number | undefined }
  const enc = new TextEncoder()

  beforeAll(async () => {
    await import('../src/index') // the admin account
    backup = await import('../src/backup')
    ;({ config } = await import('../src/config'))
    alerts = await import('../src/alerts')
    notify = await import('../src/notify')
  })
  beforeEach(() => {
    keep.dir = config.backupDir
    keep.free = backup.backupDeps.free
    keep.limits = { ...backup.backupLimits }
    config.backupDir = fresh('backups')
  })
  afterEach(() => {
    config.backupDir = keep.dir
    backup.backupDeps.free = keep.free
    Object.assign(backup.backupLimits, keep.limits)
    backup.saveBackupSettings({ keep: null })
    setSystemTime()
  })

  /** a zip that looks like a backup of `createdAt`, whatever its name says; `pad` bytes of filler so it takes room */
  async function plant(name: string, createdAt: string, pad = 0) {
    const { zipSync } = await import('fflate')
    const files: Record<string, Uint8Array> = { 'users.json': enc.encode('{}'), 'backup.json': enc.encode(JSON.stringify({ version: '1.9.1', createdAt })) }
    if (pad) files['pad.bin'] = new Uint8Array(pad)
    writeFileSync(join(config.backupDir, name), zipSync(files, { level: 0 }))
  }
  const zips = () => readdirSync(config.backupDir).filter(f => f.endsWith('.zip')).sort()

  test('a new backup is named in UTC, whatever the zone of the server', async () => {
    const dir = fresh('tz')
    const r = await child(`
      import { ensureDirs } from ${src('config')}
      ensureDirs()
      await import(${src('auth')})
      const { runBackup } = await import(${src('backup')})
      const b = await runBackup()
      console.log(JSON.stringify(b))
    `, { TZ: 'Asia/Bangkok', DATA_DIR: join(dir, 'data'), STORAGE_DIR: join(dir, 'storage') })
    expect(r.code).toBe(0)
    const b = JSON.parse(r.out.trim().split('\n').at(-1)!)
    const utc = new Date(b.createdAt).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    // the name is the second of createdAt (or a few later if the name was taken), in UTC
    const stamp = b.name.slice('file-center-backup-'.length, -'.zip'.length)
    expect(Date.parse(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`) - Date.parse(b.createdAt)).toBeLessThan(5000)
    expect(stamp.slice(0, 15)).toBe(utc)
  })

  test('two backups in the same second get two names at once (no waiting for the clock)', async () => {
    setSystemTime(new Date('2031-05-06T07:08:09Z'))
    const a = await backup.runBackup()
    const b = await backup.runBackup()
    expect(a.name).toBe('file-center-backup-20310506-070809.zip')
    expect(b.name).toBe('file-center-backup-20310506-070810.zip')
    expect(zips()).toEqual([a.name, b.name])
  })

  test('the list is ordered by the time in backup.json, not by the name', async () => {
    await plant('file-center-backup-20990101-000000.zip', '2001-01-01T00:00:00Z')
    await plant('file-center-backup-20000101-000000.zip', '2020-01-01T00:00:00Z')
    writeFileSync(join(config.backupDir, 'file-center-backup-20100101-000000.zip'), 'not a zip: its name is all there is')
    const names = (await backup.listBackupsDetailed()).map(b => b.name)
    // 2020 (backup.json), then the unreadable one by its name (2010), then 2001
    expect(names).toEqual(['file-center-backup-20000101-000000.zip', 'file-center-backup-20100101-000000.zip', 'file-center-backup-20990101-000000.zip'])
    expect((await backup.listBackupsDetailed())[0].createdAt).toBe('2020-01-01T00:00:00.000Z')
  })

  test('only after the new backup is complete do the oldest beyond "keep" go, and by age, not by name', async () => {
    await plant('file-center-backup-20990101-000000.zip', '2001-01-01T00:00:00Z')
    await plant('file-center-backup-20000101-000000.zip', '2002-01-01T00:00:00Z')
    backup.saveBackupSettings({ keep: 1 })
    const made = await backup.runBackup()
    expect(zips()).toEqual([made.name])
  })

  test('a backup that fails deletes nothing for "keep"', async () => {
    await plant('file-center-backup-20000101-000000.zip', '2001-01-01T00:00:00Z')
    await plant('file-center-backup-20000102-000000.zip', '2002-01-01T00:00:00Z')
    backup.saveBackupSettings({ keep: 1 })
    let calls = 0
    backup.backupDeps.free = () => (++calls === 1 ? 1e12 : 10)
    backup.backupLimits.checkEvery = 1
    await expect(backup.runBackup()).rejects.toThrow()
    expect(zips()).toEqual(['file-center-backup-20000101-000000.zip', 'file-center-backup-20000102-000000.zip'])
  })

  test('room is made from the oldest by age; if the new backup then fails the admin is told how many went', async () => {
    const MB = 1024 * 1024
    await plant('file-center-backup-20000103-000000.zip', '2003-01-01T00:00:00Z', 4 * MB)
    await plant('file-center-backup-20000101-000000.zip', '2005-01-01T00:00:00Z', 4 * MB) // newest by age, though the name is the oldest
    await plant('file-center-backup-20000102-000000.zip', '2001-01-01T00:00:00Z', 4 * MB) // oldest by age
    backup.saveBackupSettings({ keep: 30 })
    const { needed } = await backup.estimateBackup(false)
    const used = () => readdirSync(config.backupDir).reduce((sum, f) => sum + statSync(join(config.backupDir, f)).size, 0)
    let calls = 0
    // two looks before the backup (one backup has to go), then the disk is full while writing
    backup.backupDeps.free = () => (++calls <= 2 ? needed + 9 * MB - used() : 10)
    backup.backupLimits.checkEvery = 1
    alerts.resetAlerts()
    await expect(backup.runBackup()).rejects.toThrow()
    // the oldest by age is the one that went; the other two are still there
    expect(zips()).toEqual(['file-center-backup-20000101-000000.zip', 'file-center-backup-20000103-000000.zip'])
    const bell = notify.listNotifications('admin').items.filter(n => n.kind === 'system-alert' && n.params.code === 'backup.pruned-then-failed')
    expect(bell.length).toBeGreaterThan(0)
    expect(bell[0].params.count).toBe(1)
    expect(String(bell[0].params.names)).toContain('file-center-backup-20000102-000000.zip')
    alerts.resetAlerts()
  })

  test('the last complete backup is never deleted to make room for a new one', async () => {
    await plant('file-center-backup-20000101-000000.zip', '2001-01-01T00:00:00Z', 1024)
    backup.backupDeps.free = () => 1000 // never enough
    await expect(backup.runBackup()).rejects.toMatchObject({ code: 'backup.no-space' })
    expect(zips()).toEqual(['file-center-backup-20000101-000000.zip'])
  })

  test('backups made by older versions (local time in the name) are listed and can be found by their name', async () => {
    await plant('file-center-backup-20240310-023000.zip', '2024-03-10T02:30:00Z')
    const [item] = await backup.listBackupsDetailed()
    expect(item.name).toBe('file-center-backup-20240310-023000.zip')
    expect(backup.backupPath(item.name)).toBe(join(config.backupDir, item.name))
  })
})

describe('launcher: a release that boots too slowly', () => {
  test('is rolled back but its directory is kept, and it is first in the history for a retry', async () => {
    const dir = fresh('launcher')
    const data = join(dir, 'data')
    const release = join(data, 'app', 'releases', '9.9.7-slowboot')
    mkdirSync(join(release, 'web'), { recursive: true })
    // alive but never answering /api/health
    writeFileSync(join(release, 'server.js'), 'setInterval(() => {}, 1000)')
    writeFileSync(join(release, 'web', 'index.html'), '<html></html>')
    writeFileSync(join(release, 'manifest.json'), JSON.stringify({ name: 'file-center', version: '9.9.7', builtAt: '', files: {} }))
    const stateFile = join(data, 'app', 'state.json')
    writeFileSync(stateFile, JSON.stringify({ schema: 1, current: '9.9.7-slowboot', history: [], pending: { dir: '9.9.7-slowboot', previous: null, at: new Date().toISOString() }, last: null }))
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
    const port = probe.port!
    await probe.stop(true)
    const launcher = Bun.spawn([process.execPath, join(ROOT, 'src', 'launcher.ts')], {
      cwd: ROOT, stdout: 'ignore', stderr: 'ignore',
      env: {
        PATH: process.env.PATH!, HOME: dir, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1',
        STORAGE_DIR: join(dir, 'storage'), DATA_DIR: data, ADMIN_PASSWORD: 'x-test-pass-1', MIN_FREE_SPACE: '0',
        FC_HEALTH_TIMEOUT_MS: '1500', FC_STABLE_MS: '500', UPDATE_SOURCE: 'off',
      },
    })
    try {
      const until = Date.now() + 60_000
      let state: any = null
      while (Date.now() < until) {
        try { state = JSON.parse(readFileSync(stateFile, 'utf8')) } catch { /* being written */ }
        if (state?.last) break
        await Bun.sleep(100)
      }
      expect(state.last).toMatchObject({ dir: '9.9.7-slowboot', version: '9.9.7', ok: false, code: 'update.health-timeout', params: { seconds: 2 } })
      expect(state.current).toBeNull()
      expect(state.pending).toBeNull()
      expect(state.history).toEqual(['9.9.7-slowboot'])
      expect(existsSync(release)).toBe(true)
    } finally {
      launcher.kill('SIGTERM')
      await Promise.race([launcher.exited, Bun.sleep(15_000)])
    }
  }, 90_000)
})

describe('restore onto another host: 2FA secrets that this secret.key can not open', () => {
  /** restore a hand-made backup in a child with its own data folder; `withKey`: this host already has a secret.key */
  async function restoreInChild(withKey: boolean) {
    const dir = fresh('restore2fa')
    const r = await child(`
      import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      import { zipSync } from ${JSON.stringify(join(ROOT, 'node_modules/fflate'))}
      import { config, ensureDirs, paths } from ${src('config')}
      ensureDirs()
      const { seal } = await import(${src('secret-box')})
      ${withKey ? '' : '/* no secret.key on this host */'}
      const mine = ${withKey} ? seal('JBSWY3DPEHPK3PXP') : null
      await import(${src('auth')})
      const { restoreBackup } = await import(${src('backup')})
      const enc = new TextEncoder()
      const tf = (secret) => ({ secret, enabledAt: '2026-01-01T00:00:00Z', lastStep: 0, backup: [] })
      const users = [
        { username: 'boss', role: 'admin', passwordHash: 'x', twoFactor: tf('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA') },
        { username: 'plain', role: 'user', passwordHash: 'x' },
        ...(mine ? [{ username: 'mine', role: 'user', passwordHash: 'x', twoFactor: tf(mine) }] : []),
      ]
      mkdirSync(config.backupDir, { recursive: true })
      const name = 'file-center-backup-20000101-000000.zip'
      writeFileSync(join(config.backupDir, name), zipSync({ 'users.json': enc.encode(JSON.stringify({ users })), 'backup.json': enc.encode('{}') }))
      const r = await restoreBackup(name)
      console.log(JSON.stringify({ lost: r.twoFactorLost, keyMade: existsSync(paths.secretKey) }))
    `, { DATA_DIR: join(dir, 'data'), STORAGE_DIR: join(dir, 'storage') })
    expect(r.err).not.toContain('error:')
    expect(r.code).toBe(0)
    return JSON.parse(r.out.trim().split('\n').at(-1)!) as { lost: string[]; keyMade: boolean }
  }

  test('a secret sealed with another key is reported; one this key opens is not', async () => {
    const r = await restoreInChild(true)
    expect(r.lost).toEqual(['boss'])
  })

  test('with no secret.key at all every user with 2FA is reported, and no key is made by looking', async () => {
    const r = await restoreInChild(false)
    expect(r.lost).toEqual(['boss'])
    expect(r.keyMade).toBe(false)
  })

  test('the message tells both languages how to recover', async () => {
    const { text } = await import('../src/messages')
    for (const lang of ['th', 'en'] as const) {
      const t = text(lang, 'backup.restore-2fa-lost', { count: 1, users: 'boss' })
      expect(t).toContain('boss')
      expect(t).toContain('secret.key')
      expect(t).toContain('reset-2fa')
    }
  })
})

afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })
