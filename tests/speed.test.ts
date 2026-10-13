/**
 * Speed work (round 9): compressed static files with validators, one collator for folder listings, and the delayed JsonStore write
 * (updateSoon). Each test would fail on the code before these changes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import './in-process-env'

let app: any
let config: any
const web = mkdtempSync(join(tmpdir(), 'fc-speed-web-'))
let keep = ''
const JS = 'export const answer = () => 42\n'.repeat(400)
const PNG = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 31) % 251))

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config } = await import('../src/config'))
  keep = config.webDir
  mkdirSync(join(web, 'assets'), { recursive: true })
  writeFileSync(join(web, 'assets', 'app-abc123.js'), JS)
  writeFileSync(join(web, 'assets', 'tiny.js'), 'x=1')
  writeFileSync(join(web, 'assets', 'logo.png'), PNG)
  writeFileSync(join(web, 'plain.txt'), 'hello\n'.repeat(500))
  config.webDir = web
})
afterAll(() => {
  config.webDir = keep
  rmSync(web, { recursive: true, force: true })
})

const get = (path: string, headers: Record<string, string> = {}) => app.handle(new Request('http://localhost' + path, { headers })) as Promise<Response>
const bytes = async (r: Response) => Buffer.from(await r.arrayBuffer())

describe('static files: compression', () => {
  test('brotli when accepted, and the same bytes after decoding', async () => {
    const r = await get('/assets/app-abc123.js', { 'accept-encoding': 'gzip, br' })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-encoding')).toBe('br')
    expect(r.headers.get('vary')).toBe('Accept-Encoding')
    expect(r.headers.get('content-type')).toContain('javascript')
    const body = await bytes(r)
    expect(body.length).toBeLessThan(JS.length / 5)
    expect(Number(r.headers.get('content-length'))).toBe(body.length)
    expect(brotliDecompressSync(body).toString()).toBe(JS)
  })
  test('gzip when brotli is not accepted', async () => {
    const r = await get('/assets/app-abc123.js', { 'accept-encoding': 'gzip' })
    expect(r.headers.get('content-encoding')).toBe('gzip')
    expect(gunzipSync(await bytes(r)).toString()).toBe(JS)
  })
  test('plain bytes without Accept-Encoding, with q=0, or for an unknown coding; Vary stays', async () => {
    for (const ae of [undefined, 'br;q=0, gzip;q=0', 'identity', 'deflate']) {
      const r = await get('/assets/app-abc123.js', ae === undefined ? {} : { 'accept-encoding': ae })
      expect(r.headers.get('content-encoding')).toBeNull()
      expect(r.headers.get('vary')).toBe('Accept-Encoding')
      expect((await bytes(r)).toString()).toBe(JS)
    }
    // q=0 on br only: gzip still goes
    expect((await get('/assets/app-abc123.js', { 'accept-encoding': 'br;q=0, gzip' })).headers.get('content-encoding')).toBe('gzip')
  })
  test('images and tiny files are not compressed', async () => {
    for (const path of ['/assets/logo.png', '/assets/tiny.js']) {
      const r = await get(path, { 'accept-encoding': 'br, gzip' })
      expect(`${path} ${r.headers.get('content-encoding')}`).toBe(`${path} null`)
    }
    expect(await bytes(await get('/assets/logo.png', { 'accept-encoding': 'br' }))).toEqual(PNG)
  })
  test('cache headers: hashed assets immutable, other files revalidated', async () => {
    expect((await get('/assets/app-abc123.js')).headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect((await get('/plain.txt')).headers.get('cache-control')).toBe('no-cache')
  })
  test('the page itself is compressed too (when the build exists)', async () => {
    if (!existsSync(join(keep, 'index.html'))) return
    const r = await get('/some/client/route', { 'accept-encoding': 'br' })
    // under 1 KB it is sent as it is (the compression would not pay)
    if (statSync(join(keep, 'index.html')).size < 1024) return
    expect(r.headers.get('content-encoding')).toBe('br')
    expect(r.headers.get('content-type')).toContain('text/html')
    expect(r.headers.get('cache-control')).toBe('no-cache')
    expect(brotliDecompressSync(await bytes(r)).toString()).toBe(readFileSync(join(keep, 'index.html'), 'utf8'))
  })
  test('the security headers survive on compressed and 304 answers', async () => {
    const first = await get('/assets/app-abc123.js', { 'accept-encoding': 'br' })
    expect(first.headers.get('content-security-policy')).toContain("default-src 'self'")
    const again = await get('/assets/app-abc123.js', { 'accept-encoding': 'br', 'if-none-match': first.headers.get('etag')! })
    expect(again.status).toBe(304)
    expect(again.headers.get('content-security-policy')).toContain("default-src 'self'")
  })
})

describe('static files: ETag and 304', () => {
  test('a matching If-None-Match gets 304 without a body; another one gets the file', async () => {
    const r = await get('/assets/app-abc123.js', { 'accept-encoding': 'br' })
    const etag = r.headers.get('etag')!
    expect(etag).toBeTruthy()
    const hit = await get('/assets/app-abc123.js', { 'accept-encoding': 'br', 'if-none-match': etag })
    expect(hit.status).toBe(304)
    expect((await bytes(hit)).length).toBe(0)
    expect(hit.headers.get('etag')).toBe(etag)
    expect(hit.headers.get('vary')).toBe('Accept-Encoding')
    // a list, a strong form of the same tag, and *
    expect((await get('/assets/app-abc123.js', { 'accept-encoding': 'br', 'if-none-match': `"nope", ${etag}` })).status).toBe(304)
    expect((await get('/assets/app-abc123.js', { 'accept-encoding': 'br', 'if-none-match': '*' })).status).toBe(304)
    const miss = await get('/assets/app-abc123.js', { 'accept-encoding': 'br', 'if-none-match': 'W/"other"' })
    expect(miss.status).toBe(200)
    expect((await bytes(miss)).length).toBeGreaterThan(0)
  })
  test('the tag differs per encoding, so a cache never hands out the wrong body', async () => {
    const tags = await Promise.all(['br', 'gzip', 'identity'].map(async ae => (await get('/assets/app-abc123.js', { 'accept-encoding': ae })).headers.get('etag')))
    expect(new Set(tags).size).toBe(3)
    // the gzip tag does not match a request that wants brotli
    expect((await get('/assets/app-abc123.js', { 'accept-encoding': 'br', 'if-none-match': tags[1]! })).status).toBe(200)
  })
  test('a changed file gets a new tag and new compressed bytes', async () => {
    const file = join(web, 'plain.txt')
    const a = await get('/plain.txt', { 'accept-encoding': 'gzip' })
    const tag = a.headers.get('etag')!
    expect(gunzipSync(await bytes(a)).toString()).toBe('hello\n'.repeat(500))
    writeFileSync(file, 'changed\n'.repeat(700))
    utimesSync(file, new Date(), new Date(Date.now() + 5000))
    const b = await get('/plain.txt', { 'accept-encoding': 'gzip', 'if-none-match': tag })
    expect(b.status).toBe(200)
    expect(b.headers.get('etag')).not.toBe(tag)
    expect(gunzipSync(await bytes(b)).toString()).toBe('changed\n'.repeat(700))
  })
  test('a missing asset stays 404 and a path outside the folder is refused', async () => {
    expect((await get('/assets/missing.js', { 'accept-encoding': 'br' })).status).toBe(404)
    expect((await get('/..%2f..%2fpackage.json')).status).not.toBe(200)
  })
})

describe('folder listing order', () => {
  test('folders first, then names with numbers in numeric order (same as localeCompare th numeric)', async () => {
    const { listDir } = await import('../src/fsx')
    const dir = mkdtempSync(join(tmpdir(), 'fc-speed-list-'))
    try {
      const names = ['file10.txt', 'file2.txt', 'file1.txt', 'B.txt', 'a.txt', 'ก.txt', 'ข.txt', 'z.txt']
      for (const n of names) writeFileSync(join(dir, n), 'x')
      mkdirSync(join(dir, 'dir10'))
      mkdirSync(join(dir, 'dir9'))
      const got = listDir(dir, '/').map(e => e.name)
      const files = names.slice().sort((a, b) => a.localeCompare(b, 'th', { numeric: true }))
      expect(got).toEqual(['dir9', 'dir10', ...files])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('2,000 entries are sorted in well under the time the per-comparison collator needed', async () => {
    const { listDir } = await import('../src/fsx')
    const dir = mkdtempSync(join(tmpdir(), 'fc-speed-big-'))
    try {
      for (let i = 0; i < 2000; i++) writeFileSync(join(dir, `entry-${String(i).padStart(4, '0')}.txt`), 'x')
      listDir(dir, '/') // warm
      const t0 = performance.now()
      const out = listDir(dir, '/')
      const ms = performance.now() - t0
      expect(out.length).toBe(2000)
      expect(out[0].name).toBe('entry-0000.txt')
      // sorting alone took ~60 ms before; the 2,000 lstat calls are most of what is left. Generous: shared CI machines.
      expect(ms).toBeLessThan(60)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('JsonStore.updateSoon', () => {
  test('many updates are one write; the file is current after idle() (the shutdown path)', async () => {
    const { JsonStore } = await import('../src/store')
    const dir = mkdtempSync(join(tmpdir(), 'fc-speed-store-'))
    const file = join(dir, 's.json')
    try {
      const s = new JsonStore<{ n: number }>(file, () => ({ n: 0 }))
      expect(JSON.parse(readFileSync(file, 'utf8')).n).toBe(0)
      for (let i = 1; i <= 50; i++) s.updateSoon(d => { d.n = i }, 60_000)
      await Bun.sleep(20)
      // still waiting: nothing was written per update
      expect(JSON.parse(readFileSync(file, 'utf8')).n).toBe(0)
      await JsonStore.flushAll()
      expect(JSON.parse(readFileSync(file, 'utf8')).n).toBe(50)
      expect(existsSync(`${file}.tmp`)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('the timer writes it by itself, and update() still writes at once', async () => {
    const { JsonStore } = await import('../src/store')
    const dir = mkdtempSync(join(tmpdir(), 'fc-speed-store2-'))
    try {
      const slow = new JsonStore<{ n: number }>(join(dir, 'a.json'), () => ({ n: 0 }))
      const now = new JsonStore<{ n: number }>(join(dir, 'b.json'), () => ({ n: 0 }))
      slow.updateSoon(d => { d.n = 7 }, 30)
      now.update(d => { d.n = 8 })
      await now.idle()
      expect(JSON.parse(readFileSync(join(dir, 'b.json'), 'utf8')).n).toBe(8)
      expect(JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8')).n).toBe(0)
      await Bun.sleep(150)
      await slow.idle()
      expect(JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8')).n).toBe(7)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('frozen stores (after a restore) are never written by a waiting timer', async () => {
    const { JsonStore } = await import('../src/store')
    const dir = mkdtempSync(join(tmpdir(), 'fc-speed-store3-'))
    const file = join(dir, 'f.json')
    try {
      const s = new JsonStore<{ n: number }>(file, () => ({ n: 0 }))
      s.updateSoon(d => { d.n = 5 }, 20)
      JsonStore.freeze()
      await Bun.sleep(80)
      await s.idle()
      expect(JSON.parse(readFileSync(file, 'utf8')).n).toBe(0)
    } finally {
      JsonStore.frozen = false
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('recent files (updateSoon in favorites.ts) reach the disk at shutdown', async () => {
    const { JsonStore } = await import('../src/store')
    const { recordRecent } = await import('../src/favorites')
    const { paths } = await import('../src/config')
    const { findUser } = await import('../src/auth')
    const admin = findUser('admin')!
    recordRecent(admin, 'home', '/speed-recent.txt')
    await JsonStore.flushAll()
    const state = JSON.parse(readFileSync(paths.userState, 'utf8'))
    expect(state.admin.recent.some((r: any) => r.path === '/speed-recent.txt')).toBe(true)
  })
})
