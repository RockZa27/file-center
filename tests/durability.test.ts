/**
 * Durability fixes of 1.12.1: the stores are flushed before the server is waited for, a failed write is retried and
 * reported, a corrupt data file stops the start, a crash while trashing leaves nothing invisible, backups keep their
 * old copies until the new one is complete, a slow release is not deleted, a restore on another host says that 2FA
 * secrets can not be opened. Runs in-process on the same app as api.test.ts (see in-process-env.ts); the parts that
 * end the process or fail at import time run in a child process of their own.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
      const { s } = broken()
      s.update(d => { d.n = 1 })
      await s.idle()
      await alerts.alertsIdle()
      expect(got.map(g => g.event)).toEqual(['store-write-failed'])
      expect(got[0].code).toBe('admin.alert-store-write')
      expect(got[0].message).toContain('disk-full-demo.json')
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

afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })
