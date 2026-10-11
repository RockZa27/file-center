import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, symlinkSync, truncateSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
// the counter is imported in-process below: fix the app's folders first, like the other test files
import './in-process-env'

// ───────────── the counter itself ─────────────

describe('async tree counter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fc-count-'))
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(`${dir}.src`, { force: true })
  })

  test('counts sizes and files, skips links, stops at the limit, and lets other work run meanwhile', async () => {
    const { treeStats } = await import('../src/fsx')
    // hard links of one file: each one counts as a file of its own, and they are made much faster than new files
    const src = `${dir}.src`
    writeFileSync(src, 'ab')
    for (let d = 0; d < 3; d++) {
      mkdirSync(join(dir, `d${d}`, 'sub'), { recursive: true })
      for (let i = 0; i < 1500; i++) linkSync(src, join(dir, `d${d}`, `f${i}`))
      writeFileSync(join(dir, `d${d}`, 'sub', 'deep.txt'), 'abcd')
    }
    symlinkSync(join(dir, 'd0'), join(dir, 'link'))
    let ticks = 0
    const timer = setInterval(() => ticks++, 0)
    const p = treeStats(dir)
    expect(p).toBeInstanceOf(Promise)
    const all = await p
    clearInterval(timer)
    expect(all).toEqual({ size: 3 * (1500 * 2 + 4), files: 3 * 1501, truncated: false })
    // the event loop ran timers while the 4,500 files were counted
    expect(ticks).toBeGreaterThan(0)
    // 4 entries at the top (3 folders + the link) and 1,502 in each folder
    expect(await treeStats(dir, 4 + 3 * 1502)).toMatchObject({ files: 3 * 1501, truncated: false })
    const cut = await treeStats(dir, 2000)
    expect(cut.truncated).toBe(true)
    expect(cut.files).toBeLessThan(2000)
    expect(await treeStats(join(dir, 'missing'))).toEqual({ size: 0, files: 0, truncated: false })
  })

  test('one count at a time: a second caller gets the count that already runs', async () => {
    // in a process of its own: the cached numbers of the app shared by the other test files stay untouched
    const own = mkdtempSync(join(tmpdir(), 'fc-recount-'))
    mkdirSync(join(own, 'storage', 'public'), { recursive: true })
    writeFileSync(join(own, 'storage', 'a.txt'), 'abc')
    writeFileSync(join(own, 'storage', 'public', 'b.txt'), 'de')
    const script = `
      const { recountStorage, storageStats } = await import('./src/stats')
      const { JsonStore } = await import('./src/store')
      const first = storageStats()
      const a = recountStorage()
      const same = a === recountStorage()
      await a
      const after = storageStats()
      const again = recountStorage() !== a
      await JsonStore.flushAll()
      console.log('RESULT' + JSON.stringify({ first, same, after, again }))`
    const p = Bun.spawn([process.execPath, '-e', script], {
      cwd: resolve(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'inherit',
      env: { PATH: process.env.PATH!, STORAGE_DIR: join(own, 'storage'), DATA_DIR: join(own, 'data'), ADMIN_PASSWORD: 'recount-test-pass' },
    })
    const out = await new Response(p.stdout).text()
    await p.exited
    try {
      const r = JSON.parse(/RESULT(.*)/.exec(out)![1])
      expect(r.first).toEqual({ storage: null, stale: true })
      expect(r.same).toBe(true)
      expect(r.after).toMatchObject({ stale: false, storage: { files: 2, size: 5, truncated: false, public: { files: 1, size: 2 } } })
      expect(r.again).toBe(true)
      expect(JSON.parse(readFileSync(join(own, 'data', 'stats-cache.json'), 'utf8'))).toMatchObject({ files: 2, size: 5 })
    } finally {
      rmSync(own, { recursive: true, force: true })
    }
  })
})

// ───────────── end to end: a separate server with ~50,000 files ─────────────

const root = resolve(import.meta.dir, '..')
const base = mkdtempSync(join(tmpdir(), 'fc-perf-'))
const dirs = { storage: join(base, 'storage'), data: join(base, 'data') }
const PASSWORD = 'perf-test-password'
const GROUPS = 50
const PER_GROUP = 1000
let port = 0
let server: ReturnType<typeof Bun.spawn> | undefined
const live = { cookie: '', csrf: '' }

async function api(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { cookie: live.cookie, 'x-csrf-token': live.csrf }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const t0 = performance.now()
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = (await res.json().catch(() => null)) as any
  const ms = performance.now() - t0
  const set = res.headers.get('set-cookie')
  if (set) live.cookie = set.split(';')[0]
  return { status: res.status, data, ms }
}

async function start(env: Record<string, string> = {}) {
  server = Bun.spawn([process.execPath, join(root, 'src', 'index.ts')], {
    cwd: root,
    stdout: 'ignore',
    stderr: 'inherit',
    env: {
      PATH: process.env.PATH!, HOME: process.env.HOME ?? base, PORT: String(port), HOST: '127.0.0.1',
      STORAGE_DIR: dirs.storage, DATA_DIR: dirs.data, ADMIN_PASSWORD: PASSWORD, MIN_FREE_SPACE: '0', BACKUP_HOUR: 'off', ...env,
    },
  })
  const end = Date.now() + 15_000
  while (Date.now() < end) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break } catch { /* not up yet */ }
    await Bun.sleep(50)
  }
  live.cookie = ''
  live.csrf = (await api('GET', '/api/session')).data.csrf
  const r = await api('POST', '/api/login', { username: 'admin', password: PASSWORD })
  expect(r.status).toBe(200)
  live.csrf = r.data.csrf
}

async function stop() {
  server?.kill('SIGTERM')
  await Promise.race([server?.exited, Bun.sleep(10_000)])
}

describe('dashboard counting does not hold up other requests', () => {
  beforeAll(async () => {
    // hard links of one file outside the storage: 50,000 files of 1 byte each, made in a fraction of a second
    writeFileSync(join(base, 'one-byte'), 'x')
    for (let g = 0; g < GROUPS; g++) {
      const d = join(dirs.storage, 'big', `g${g}`)
      mkdirSync(d, { recursive: true })
      for (let i = 0; i < PER_GROUP; i++) linkSync(join(base, 'one-byte'), join(d, `f${i}`))
    }
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
    port = probe.port!
    await probe.stop(true)
    await start()
  }, 30_000)

  afterAll(async () => {
    await stop()
    rmSync(base, { recursive: true, force: true })
  })

  test('status answers at once, /api/list stays under 100 ms while 50,000 files are counted', async () => {
    // no numbers yet: the first call starts the count and does not wait for it
    const pending = api('GET', '/api/admin/status')
    const latencies: number[] = []
    let first: Awaited<typeof pending> | null = null
    pending.then(r => { first = r })
    let done = false
    const until = Date.now() + 15_000
    while (!done && Date.now() < until) {
      const list = await api('GET', '/api/list?space=home&path=/big')
      expect(list.status).toBe(200)
      latencies.push(list.ms)
      if (first) done = !(await api('GET', '/api/admin/status')).data.stale
    }
    expect(first!.status).toBe(200)
    expect(first!.data.storage).toBeNull()
    expect(first!.data.stale).toBe(true)
    expect(first!.ms).toBeLessThan(100)
    expect(latencies.length).toBeGreaterThan(0)
    expect(Math.max(...latencies)).toBeLessThan(100)

    const st = await api('GET', '/api/admin/status')
    expect(st.data.stale).toBe(false)
    expect(st.data.storage).toMatchObject({ files: GROUPS * PER_GROUP, size: GROUPS * PER_GROUP, truncated: false, public: { files: 0 } })
  }, 20_000)

  test('the numbers survive a restart, so the dashboard has them at once', async () => {
    const file = join(dirs.data, 'stats-cache.json')
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).files).toBe(GROUPS * PER_GROUP)
    await stop()
    // from here on: 64 MB more on the disk would go below the reserve (for the copy check below)
    const fs = statfsSync(dirs.storage)
    await start({ MIN_FREE_SPACE: String(Number(fs.bavail) * Number(fs.bsize) - 64 * 1024 ** 2) })
    const st = await api('GET', '/api/admin/status')
    expect(st.data.storage.files).toBe(GROUPS * PER_GROUP)
  }, 20_000)

  test('deleting a folder still records its size in the trash, copying a folder still checks the space', async () => {
    const copy = await api('POST', '/api/copy', { space: 'home', items: ['/big/g1'], dest: '/' })
    expect(copy.data).toEqual({ done: 1, failed: [] })
    const del = await api('POST', '/api/delete', { space: 'home', items: ['/big/g0'] })
    expect(del.data).toEqual({ done: 1, failed: [] })
    const item = (await api('GET', '/api/admin/trash')).data.items.find((i: any) => i.originalPath === '/big/g0')
    expect(item).toMatchObject({ type: 'dir', size: PER_GROUP })
    expect(readFileSync(join(dirs.data, 'trash', item.id, 'meta.json'), 'utf8')).toContain('"size":1000')
    // a folder holding a 1 GB file (sparse: it takes no real space) does not fit above the reserve
    mkdirSync(join(dirs.storage, 'space'))
    writeFileSync(join(dirs.storage, 'space', 'huge.bin'), '')
    truncateSync(join(dirs.storage, 'space', 'huge.bin'), 1024 ** 3)
    const full = await api('POST', '/api/copy', { space: 'home', items: ['/space'], dest: '/big' })
    expect(full.data).toEqual({ done: 0, failed: [{ path: '/space', error: expect.stringContaining('พื้นที่') }] })
    expect(existsSync(join(dirs.storage, 'big', 'space'))).toBe(false)
  }, 20_000)
})
