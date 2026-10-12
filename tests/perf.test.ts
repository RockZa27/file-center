import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statfsSync, symlinkSync, truncateSync,
  writeFileSync,
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

// ───────────── copy and search, in-process ─────────────

/** every path under `dir` with its kind and content, to compare two trees */
function snapshot(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const n of readdirSync(dir).sort()) {
    const abs = join(dir, n)
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) out.push(`${rel}/${n} -> link`)
    else if (st.isDirectory()) out.push(`${rel}/${n}/`, ...snapshot(abs, `${rel}/${n}`))
    else out.push(`${rel}/${n} = ${readFileSync(abs, 'utf8')}`)
  }
  return out
}

describe('async copy and search', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fc-copy-'))
  const outside = join(dir, 'outside')
  const src = join(dir, 'src')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  beforeAll(() => {
    mkdirSync(join(outside, 'secret-dir'), { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    mkdirSync(join(src, 'a', 'b', 'c'), { recursive: true })
    mkdirSync(join(src, 'empty'))
    writeFileSync(join(src, 'top.txt'), 'top')
    writeFileSync(join(src, 'a', 'one.txt'), 'one')
    writeFileSync(join(src, 'a', 'b', 'two.txt'), 'two')
    writeFileSync(join(src, 'a', 'b', 'c', 'three.txt'), 'สาม')
    for (let i = 0; i < 300; i++) writeFileSync(join(src, 'a', `many-${i}.txt`), String(i))
    // links to a folder and a file outside: neither followed nor copied
    symlinkSync(outside, join(src, 'a', 'secret-link'))
    symlinkSync(join(outside, 'secret.txt'), join(src, 'secret-file-link'))
  })

  test('a copy is identical, without the links, and other work runs meanwhile', async () => {
    const { copyTree } = await import('../src/fsx')
    let ticks = 0
    const timer = setInterval(() => ticks++, 0)
    const p = copyTree(src, join(dir, 'copy'))
    expect(p).toBeInstanceOf(Promise)
    await p
    clearInterval(timer)
    expect(ticks).toBeGreaterThan(0)
    const want = snapshot(src).filter(l => !l.endsWith('-> link'))
    expect(want.length).toBe(308)
    expect(snapshot(join(dir, 'copy'))).toEqual(want)
    // one file
    await copyTree(join(src, 'a', 'b', 'c', 'three.txt'), join(dir, 'three.txt'))
    expect(readFileSync(join(dir, 'three.txt'), 'utf8')).toBe('สาม')
  })

  test('a copy never overwrites, never writes through a link, never goes into itself', async () => {
    const { copyTree, HttpError } = await import('../src/fsx')
    mkdirSync(join(dir, 'taken'))
    writeFileSync(join(dir, 'taken', 'keep.txt'), 'keep')
    await expect(copyTree(src, join(dir, 'taken'))).rejects.toMatchObject({ code: 'EEXIST' })
    expect(snapshot(join(dir, 'taken'))).toEqual(['/keep.txt = keep'])
    await expect(copyTree(join(src, 'top.txt'), join(dir, 'taken', 'keep.txt'))).rejects.toMatchObject({ code: 'EEXIST' })
    expect(readFileSync(join(dir, 'taken', 'keep.txt'), 'utf8')).toBe('keep')
    // a link where the copy would go: the file it points to stays as it is
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'trap.txt'))
    await expect(copyTree(join(src, 'top.txt'), join(dir, 'trap.txt'))).rejects.toMatchObject({ code: 'EEXIST' })
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret')
    // a link as the source is not copied
    await expect(copyTree(join(src, 'a', 'secret-link'), join(dir, 'via-link'))).rejects.toBeInstanceOf(HttpError)
    expect(existsSync(join(dir, 'via-link'))).toBe(false)
    const into = await copyTree(src, join(src, 'a', 'inside')).catch(e => e)
    expect(into).toBeInstanceOf(HttpError)
    expect(into.status).toBe(400)
    expect(existsSync(join(src, 'a', 'inside'))).toBe(false)
    // names that start with ".." are ordinary names: "..a" into "..a/..b" is still a copy into itself
    mkdirSync(join(dir, '..a', '..b'), { recursive: true })
    const dots = await copyTree(join(dir, '..a'), join(dir, '..a', '..b', '..a')).catch(e => e)
    expect(dots).toBeInstanceOf(HttpError)
    expect(dots.code).toBe('files.copy-into-self')
    expect(existsSync(join(dir, '..a', '..b', '..a'))).toBe(false)
  })

  test('a copy that fails half way leaves nothing behind', async () => {
    const { copyTree } = await import('../src/fsx')
    // a deep chain of folders: copied under a longer path, the deepest ones go past the 4,096 bytes a path may have
    const deep = join(dir, 'deep')
    mkdirSync(deep)
    for (let i = 0; i < 50; i++) writeFileSync(join(deep, `early-${i}.txt`), 'x')
    let p = deep
    while (p.length < 3700) { p = join(p, 'n'.repeat(200)); mkdirSync(p) }
    writeFileSync(join(p, 'last.txt'), 'x')
    const parent = join(dir, 'd'.repeat(250))
    mkdirSync(parent)
    const to = join(parent, 'e'.repeat(250))
    await expect(copyTree(deep, to)).rejects.toMatchObject({ code: 'ENAMETOOLONG' })
    expect(readdirSync(parent)).toEqual([])
  })

  test('search finds the same entries, skips links, keeps its limits and lets other work run', async () => {
    const { searchTree } = await import('../src/fsx')
    let ticks = 0
    const timer = setInterval(() => ticks++, 0)
    const all = await searchTree(src, '/', 'secret')
    clearInterval(timer)
    // neither the links themselves nor what is behind them
    expect(all).toEqual({ results: [], truncated: false })
    expect(ticks).toBeGreaterThan(0)
    const t = await searchTree(src, '/', 't', 50_000, 400)
    expect(t.truncated).toBe(false)
    expect(t.results.map(e => e.path).sort()).toEqual(
      ['/a/b/c/three.txt', '/a/b/two.txt', '/a/one.txt', '/empty', '/top.txt', ...Array.from({ length: 300 }, (_, i) => `/a/many-${i}.txt`)].sort(),
    )
    const three = (await searchTree(join(src, 'a'), '/x', 'three')).results
    expect(three).toEqual([{ name: 'three.txt', path: '/x/b/c/three.txt', type: 'file', size: 9, mtime: expect.any(Number) }])
    expect((await searchTree(src, '/', 'b')).results).toEqual([expect.objectContaining({ name: 'b', path: '/a/b', type: 'dir', size: 0 })])
    // 200 hits at most
    const capped = await searchTree(src, '/', 'many-', 50_000, 200)
    expect(capped.results.length).toBe(200)
    expect(capped.truncated).toBe(true)
    // entries looked at: the tree holds 308 real entries and 2 links
    expect(await searchTree(src, '/', 'zzz', 310)).toEqual({ results: [], truncated: false })
    expect(await searchTree(src, '/', 'zzz', 309)).toEqual({ results: [], truncated: true })
    expect(await searchTree(join(src, 'missing'), '/missing', 'a')).toEqual({ results: [], truncated: false })
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

  test('/api/list stays under 100 ms while 20,000 files are copied and 50,000 entries searched', async () => {
    const COPY_GROUPS = 20
    // a file of its own: a file system allows only so many links to one file (65,000 on ext4)
    writeFileSync(join(base, 'one-byte-2'), 'x')
    for (let g = 0; g < COPY_GROUPS; g++) {
      const d = join(dirs.storage, 'many', `g${g}`)
      mkdirSync(d, { recursive: true })
      for (let i = 0; i < PER_GROUP; i++) linkSync(join(base, 'one-byte-2'), join(d, `f${i}`))
    }
    const results: Record<string, Awaited<ReturnType<typeof api>>> = {}
    const work = Promise.all([
      api('POST', '/api/copy', { space: 'home', items: ['/many'], dest: '/' }).then(r => { results.copy = r }),
      // /big holds 49,050 entries now: all of them are looked at, none matches
      api('GET', '/api/search?space=home&path=/big&q=nothing-like-this').then(r => { results.search = r }),
    ])
    const latencies: number[] = []
    const until = Date.now() + 30_000
    while ((!results.copy || !results.search) && Date.now() < until) {
      const list = await api('GET', '/api/list?space=home&path=/big')
      expect(list.status).toBe(200)
      latencies.push(list.ms)
    }
    await work
    expect(results.copy.data).toEqual({ done: 1, failed: [] })
    expect(results.search.data).toEqual({ results: [], truncated: false })
    expect(latencies.length).toBeGreaterThan(2)
    expect(Math.max(...latencies)).toBeLessThan(100)

    // the copy is whole
    const copied = join(dirs.storage, 'many (1)')
    expect(readdirSync(copied).length).toBe(COPY_GROUPS)
    for (let g = 0; g < COPY_GROUPS; g++) expect(readdirSync(join(copied, `g${g}`)).length).toBe(PER_GROUP)
    expect(readFileSync(join(copied, 'g7', 'f123'), 'utf8')).toBe('x')
    // and the search found what it should: one hit per group, over 50,000 entries from the top it stops
    const hits = await api('GET', '/api/search?space=home&path=/big&q=F999')
    expect(hits.data.truncated).toBe(false)
    expect(hits.data.results.map((e: any) => e.path).sort()).toEqual(
      Array.from({ length: GROUPS - 1 }, (_, g) => `/big/g${g + 1}/f999`).sort(),
    )
    expect((await api('GET', '/api/search?space=home&q=nothing-like-this')).data).toEqual({ results: [], truncated: true })
  }, 60_000)
})
