/**
 * Folder listing without blocking (listDirAsync, cached name order) and compressed JSON answers (src/compress.ts).
 * Every test fails on the code before these changes: neither listDirAsync nor the compression existed.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { base } from './in-process-env'

let app: any
let cookie = ''
let csrf = ''
const home = join(base, 'storage', 'speed-list')

const call = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
  app.handle(new Request('http://localhost' + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
  })) as Promise<Response>

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  const s = await call('GET', '/api/session')
  cookie = s.headers.get('set-cookie')!.split(';')[0]
  csrf = (await s.json() as any).csrf
  const r = await call('POST', '/api/login', {}, { username: 'admin', password: 'test-admin-pass' })
  expect(r.status).toBe(200)
  cookie = r.headers.get('set-cookie')?.split(';')[0] ?? cookie
  csrf = (await r.json() as any).csrf
  mkdirSync(home, { recursive: true })
})

const tmp = () => mkdtempSync(join(tmpdir(), 'fc-list-'))
const names = (es: { name: string }[]) => es.map(e => e.name)

describe('listDirAsync: the same answer as the blocking listDir', () => {
  test('folders first, Thai / English / numbers in the same order, the second (cached) listing too', async () => {
    const { listDir, listDirAsync } = await import('../src/fsx')
    const dir = tmp()
    try {
      const files = ['file10.txt', 'file2.txt', 'file1.txt', 'B.txt', 'a.txt', 'ก.txt', 'ข.txt', 'ไฟล์ 10.txt', 'ไฟล์ 9.txt', 'z.txt', '10.txt', '9.txt', 'Äpfel.txt']
      for (const n of files) writeFileSync(join(dir, n), 'x')
      for (const d of ['dir10', 'dir9', 'โฟลเดอร์ 2', 'โฟลเดอร์ 10', 'Alpha']) mkdirSync(join(dir, d))
      const want = listDir(dir, '/x')
      // folders first; numbers by value; the rest as the Thai collator says
      expect(names(want).slice(0, 5).sort()).toEqual(['Alpha', 'dir10', 'dir9', 'โฟลเดอร์ 10', 'โฟลเดอร์ 2'].sort())
      expect(names(want).indexOf('dir9')).toBeLessThan(names(want).indexOf('dir10'))
      expect(names(want).indexOf('โฟลเดอร์ 2')).toBeLessThan(names(want).indexOf('โฟลเดอร์ 10'))
      expect(names(want).indexOf('9.txt')).toBeLessThan(names(want).indexOf('10.txt'))
      expect(names(want).indexOf('file2.txt')).toBeLessThan(names(want).indexOf('file10.txt'))
      expect(await listDirAsync(dir, '/x')).toEqual(want)
      expect(await listDirAsync(dir, '/x')).toEqual(want)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('links are never listed, a vanishing entry is skipped, a missing folder is an error', async () => {
    const { listDir, listDirAsync } = await import('../src/fsx')
    const dir = tmp()
    try {
      writeFileSync(join(dir, 'real.txt'), 'x')
      mkdirSync(join(dir, 'sub'))
      symlinkSync(join(dir, 'real.txt'), join(dir, 'link-file'))
      symlinkSync(join(dir, 'sub'), join(dir, 'link-dir'))
      symlinkSync(join(dir, 'nowhere'), join(dir, 'dangling'))
      expect(names(await listDirAsync(dir, '/'))).toEqual(['sub', 'real.txt'])
      expect(await listDirAsync(dir, '/')).toEqual(listDir(dir, '/'))
      // 300 names, some deleted while the listing runs: no error, and what is left is still in order
      const big = join(dir, 'big')
      mkdirSync(big)
      for (let i = 0; i < 300; i++) writeFileSync(join(big, `f${String(i).padStart(3, '0')}`), 'x')
      let done = false
      const p = listDirAsync(big, '/big').finally(() => { done = true })
      for (let i = 299; i >= 150 && !done; i--) { unlinkSync(join(big, `f${String(i).padStart(3, '0')}`)); await new Promise(r => setImmediate(r)) }
      const got = names(await p)
      expect(got.length).toBeGreaterThanOrEqual(150)
      expect(got).toEqual([...got].sort())
      await expect(listDirAsync(join(dir, 'missing'), '/')).rejects.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('the other requests get their turn while 2,000 entries are read', async () => {
    const { listDirAsync } = await import('../src/fsx')
    const dir = tmp()
    try {
      for (let i = 0; i < 2000; i++) writeFileSync(join(dir, `e${i}`), 'x')
      let ticks = 0
      let running = true
      const spin = async () => { while (running) { await new Promise(r => setImmediate(r)); ticks++ } }
      const spinning = spin()
      const out = await listDirAsync(dir, '/')
      running = false
      await spinning
      expect(out.length).toBe(2000)
      expect(ticks).toBeGreaterThanOrEqual(20) // one turn per 64 names: ~31
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the cached name order never shows an old folder', () => {
  test('added, removed, renamed, replaced by a folder, and size changes show at once', async () => {
    const { listDirAsync } = await import('../src/fsx')
    const dir = tmp()
    try {
      for (const n of ['b', 'a', 'c']) writeFileSync(join(dir, n), 'x')
      expect(names(await listDirAsync(dir, '/'))).toEqual(['a', 'b', 'c']) // order now cached
      writeFileSync(join(dir, 'a3'), 'x')
      expect(names(await listDirAsync(dir, '/'))).toEqual(['a', 'a3', 'b', 'c'])
      unlinkSync(join(dir, 'b'))
      expect(names(await listDirAsync(dir, '/'))).toEqual(['a', 'a3', 'c'])
      renameSync(join(dir, 'c'), join(dir, 'A0'))
      expect(names(await listDirAsync(dir, '/'))).toEqual(['a', 'A0', 'a3'])
      // same name, now a folder: it moves to the front although the number of names did not change
      unlinkSync(join(dir, 'a3'))
      mkdirSync(join(dir, 'a3'))
      expect(names(await listDirAsync(dir, '/'))).toEqual(['a3', 'a', 'A0'])
      // sizes and times are read every time, the folder's own timestamp does not matter
      writeFileSync(join(dir, 'a'), 'x'.repeat(1234))
      expect((await listDirAsync(dir, '/')).find(e => e.name === 'a')!.size).toBe(1234)
      writeFileSync(join(dir, 'a'), 'xy')
      expect((await listDirAsync(dir, '/')).find(e => e.name === 'a')!.size).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('more folders than the cache holds still list correctly', async () => {
    const { listDirAsync } = await import('../src/fsx')
    const root = tmp()
    try {
      for (let i = 0; i < 230; i++) {
        mkdirSync(join(root, `d${i}`))
        writeFileSync(join(root, `d${i}`, 'two'), 'x')
        writeFileSync(join(root, `d${i}`, 'one'), 'x')
      }
      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < 230; i++) expect(names(await listDirAsync(join(root, `d${i}`), '/'))).toEqual(['one', 'two'])
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test('over HTTP: a file added to the folder and a size change show on the next /api/list', async () => {
    mkdirSync(join(home, 'live'), { recursive: true })
    writeFileSync(join(home, 'live', 'one.txt'), 'x')
    const list = async () => (await (await call('GET', '/api/list?space=home&path=/speed-list/live')).json() as any).entries
    expect(names(await list())).toEqual(['one.txt'])
    writeFileSync(join(home, 'live', 'two.txt'), 'xxxx')
    const after = await list()
    expect(names(after)).toEqual(['one.txt', 'two.txt'])
    expect(after[1].size).toBe(4)
    writeFileSync(join(home, 'live', 'two.txt'), 'x'.repeat(99))
    expect((await list())[1].size).toBe(99)
  })
})

describe('compressed JSON answers', () => {
  beforeAll(() => {
    mkdirSync(join(home, 'many'), { recursive: true })
    for (let i = 0; i < 300; i++) writeFileSync(join(home, 'many', i % 2 ? `ไฟล์ ${i}.txt` : `file ${i}.txt`), 'x')
    mkdirSync(join(home, 'few'), { recursive: true })
    writeFileSync(join(home, 'few', 'a.txt'), 'x')
  })
  const URL_BIG = '/api/list?space=home&path=/speed-list/many'

  test('no Accept-Encoding: plain JSON, with Vary', async () => {
    const r = await call('GET', URL_BIG)
    expect(r.headers.get('content-encoding')).toBeNull()
    expect(r.headers.get('vary')).toContain('Accept-Encoding')
    expect(r.headers.get('content-type')).toContain('application/json')
    expect((await r.json() as any).entries.length).toBe(300)
  })
  test('br and gzip decode to exactly the plain answer; Cache-Control and the security headers stay', async () => {
    const plain = await (await call('GET', URL_BIG)).text()
    const br = await call('GET', URL_BIG, { 'accept-encoding': 'gzip, br' })
    expect(br.status).toBe(200)
    expect(br.headers.get('content-encoding')).toBe('br')
    expect(br.headers.get('vary')).toContain('Accept-Encoding')
    expect(br.headers.get('cache-control')).toBe('no-store')
    expect(br.headers.get('x-content-type-options')).toBe('nosniff')
    expect(br.headers.get('content-type')).toContain('application/json')
    const body = Buffer.from(await br.arrayBuffer())
    expect(Number(br.headers.get('content-length'))).toBe(body.length)
    expect(body.length).toBeLessThan(plain.length / 4)
    expect(brotliDecompressSync(body).toString()).toBe(plain)
    const gz = await call('GET', URL_BIG, { 'accept-encoding': 'gzip' })
    expect(gz.headers.get('content-encoding')).toBe('gzip')
    expect(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString()).toBe(plain)
    for (const ae of ['identity', 'deflate', 'br;q=0, gzip;q=0']) {
      expect((await call('GET', URL_BIG, { 'accept-encoding': ae })).headers.get('content-encoding')).toBeNull()
    }
  })
  test('an answer under 1 KB is not compressed (and still carries Vary)', async () => {
    const r = await call('GET', '/api/list?space=home&path=/speed-list/few', { 'accept-encoding': 'br' })
    expect(r.headers.get('content-encoding')).toBeNull()
    expect(r.headers.get('vary')).toContain('Accept-Encoding')
    expect((await r.json() as any).entries.length).toBe(1)
  })
  test('/api/folders is compressed as well', async () => {
    for (let i = 0; i < 80; i++) mkdirSync(join(home, 'many', `sub-folder-number-${i}`), { recursive: true })
    const r = await call('GET', '/api/folders?space=home&path=/speed-list/many', { 'accept-encoding': 'br' })
    expect(r.headers.get('content-encoding')).toBe('br')
    expect((JSON.parse(brotliDecompressSync(Buffer.from(await r.arrayBuffer())).toString()) as any).entries.length).toBe(80)
  })
  test('routes that carry tokens, codes or non-JSON are never compressed', async () => {
    const { compressibleRoute } = await import('../src/compress')
    for (const p of ['/api/session', '/api/login', '/api/login/2fa', '/api/2fa/setup', '/api/2fa/backup-codes', '/api/password', '/api/shares', '/api/admin/shares',
      '/api/download', '/api/zip', '/api/batch', '/api/content', '/api/upload', '/api/versions/x/download', '/api/admin/logs/download', '/api/activity/export',
      '/api/s/sometoken', '/api/backups', '/api/update', '/api/office/config', '/api/health', '/api/sessions']) {
      expect(`${p} ${compressibleRoute('GET', p)}`).toBe(`${p} false`)
    }
    // only reads: a POST to an allowed path is not on the list
    expect(compressibleRoute('POST', '/api/list')).toBe(false)
    // the real answers, with a client that accepts br
    const ae = { 'accept-encoding': 'br, gzip' }
    for (const p of ['/api/session', '/api/shares', '/api/sessions', '/api/admin/shares']) {
      const r = await call('GET', p, ae)
      expect(`${p} ${r.headers.get('content-encoding')}`).toBe(`${p} null`)
      expect(r.headers.get('cache-control')).toBe('no-store')
    }
    // a JSON file that is downloaded stays as it is
    writeFileSync(join(home, 'big.json'), JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => ({ i, text: 'hello world' })) }))
    const d = await call('GET', '/api/download?space=home&path=/speed-list/big.json', ae)
    expect(d.headers.get('content-encoding')).toBeNull()
  })
  test('admin lists (users, activity, logs) and search answer compressed and decode to the plain answer', async () => {
    for (const p of ['/api/admin/activity?pageSize=100', '/api/admin/logs?pageSize=200', '/api/me/recent', '/api/search?space=home&q=file&path=/speed-list']) {
      const plain = await call('GET', p)
      const text = await plain.text()
      const r = await call('GET', p, { 'accept-encoding': 'br' })
      expect(r.status).toBe(plain.status)
      expect(r.headers.get('vary')).toContain('Accept-Encoding')
      const enc = r.headers.get('content-encoding')
      const out = Buffer.from(await r.arrayBuffer())
      if (enc) expect(JSON.parse(brotliDecompressSync(out).toString())).toEqual(JSON.parse(text))
      else expect(text.length).toBeLessThan(1024 + 1) // small answers stay plain
    }
  })
})
