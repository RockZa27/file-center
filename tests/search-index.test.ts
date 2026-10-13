/**
 * The search index (src/search-index.ts) and /api/search with its filters, in-process on the app of api.test.ts.
 * The storage is shared with the other test files, so every test works in its own folder and searches from there.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, linkSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { unzipSync } from 'fflate'
import { base } from './in-process-env'

let app: any
let idx: typeof import('../src/search-index')
let fsx: typeof import('../src/fsx')
let paths: typeof import('../src/config').paths

class Client {
  cookie = ''
  csrf = ''
  async raw(method: string, path: string, body?: any) {
    const h: Record<string, string> = {}
    if (this.cookie) h.cookie = this.cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    let payload: any = body
    if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json' }
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: payload }))
    const set = res.headers.get('set-cookie')
    if (set) this.cookie = set.split(';')[0]
    return res
  }
  async rawBytes(method: string, path: string, bytes: Uint8Array) {
    const h: Record<string, string> = { 'content-type': 'application/octet-stream', 'x-csrf-token': this.csrf, cookie: this.cookie }
    return (await app.handle(new Request('http://localhost' + path, { method, headers: h, body: bytes }))) as Response
  }
  async json(method: string, path: string, body?: any) {
    const res = await this.raw(method, path, body)
    return { status: res.status, data: (await res.json().catch(() => null)) as any }
  }
  async login(u: string, p: string) {
    this.csrf = (await this.json('GET', '/api/session')).data.csrf
    const r = await this.json('POST', '/api/login', { username: u, password: p })
    if (r.status === 200) this.csrf = r.data.csrf
    return r
  }
}

const storage = () => process.env.STORAGE_DIR!
const tag = () => randomBytes(3).toString('hex')
const touch = (abs: string, size: number, mtimeMs: number) => {
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, Buffer.alloc(size, 97))
  utimesSync(abs, mtimeMs / 1000, mtimeMs / 1000)
}
const q = (params: Record<string, string>) => '/api/search?' + new URLSearchParams(params).toString()
const names = (r: { data: any }) => r.data.results.map((e: any) => e.path)
const admin = new Client()

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  idx = await import('../src/search-index')
  fsx = await import('../src/fsx')
  ;({ paths } = await import('../src/config'))
  expect((await admin.login('admin', 'test-admin-pass')).status).toBe(200)
})
afterAll(() => idx.stopSearchIndex())

const day = 86_400_000
const T0 = Date.parse('2024-03-10T12:00:00Z')

/** a small tree with known sizes and times, in a folder of its own under the admin's storage */
function makeTree() {
  const top = `sx-${tag()}`
  const root = join(storage(), top)
  touch(join(root, 'report-a.pdf'), 100, T0)
  touch(join(root, 'report-b.txt'), 5000, T0 + 2 * day)
  touch(join(root, 'sub', 'Report-C.PDF'), 300, T0 + 4 * day)
  touch(join(root, 'sub', 'deep', 'report-d.md'), 20, T0 - 3 * day)
  mkdirSync(join(root, 'report-dir'), { recursive: true })
  touch(join(root, 'other.txt'), 1, T0)
  return { top, root }
}

describe('before the index is ready', () => {
  test('search walks the disk and says indexed: false, with the filters applied', async () => {
    idx.stopSearchIndex()
    const { top } = makeTree()
    const r = await admin.json('GET', q({ space: 'home', q: 'report', path: '/' + top, ext: 'pdf' }))
    expect(r.status).toBe(200)
    expect(r.data.indexed).toBe(false)
    expect(names(r)).toEqual([`/${top}/report-a.pdf`, `/${top}/sub/Report-C.PDF`])
  })
})

describe('the index', () => {
  beforeAll(async () => {
    idx.startSearchIndex()
    await idx.scanIndex()
  })

  test('answers like searchTree on the same tree', async () => {
    const { top, root } = makeTree()
    await idx.indexIdle()
    idx.indexTouched(root)
    await idx.indexIdle()
    const f = idx.parseFilters({ limit: '500' })
    for (const needle of ['report', 'sub', 'txt', 'zzz', 'r']) {
      const fromIndex = await idx.searchEntries(root, '/' + top, needle, f)
      expect(fromIndex.indexed).toBe(true)
      const walked = await fsx.searchTree(root, '/' + top, needle)
      const key = (e: any) => e.path
      expect(fromIndex.results.map(key).sort()).toEqual(walked.results.map(key).sort())
      expect(fromIndex.results.sort((a, b) => a.path.localeCompare(b.path))).toEqual(walked.results.sort((a, b) => a.path.localeCompare(b.path)))
      expect(fromIndex.truncated).toBe(false)
    }
    const r = await admin.json('GET', q({ space: 'home', q: 'REPORT', path: '/' + top }))
    expect(r.data.indexed).toBe(true)
    expect(r.data.results.length).toBe(5)
    expect(Object.keys(r.data).sort()).toEqual(['indexed', 'results', 'truncated'])
  })

  test('filters: type, ext, dates, sizes', async () => {
    const { top, root } = makeTree()
    idx.indexTouched(root)
    await idx.indexIdle()
    const p = (extra: Record<string, string>) => admin.json('GET', q({ space: 'home', q: 'report', path: '/' + top, ...extra }))
    const at = (s: string) => `/${top}${s}`
    expect(names(await p({ type: 'dir' }))).toEqual([at('/report-dir')])
    expect((await p({ type: 'file' })).data.results.length).toBe(4)
    expect(names(await p({ ext: '.PDF, md' }))).toEqual([at('/report-a.pdf'), at('/sub/Report-C.PDF'), at('/sub/deep/report-d.md')])
    expect(names(await p({ minSize: '100', maxSize: '300', type: 'file' }))).toEqual([at('/report-a.pdf'), at('/sub/Report-C.PDF')])
    expect(names(await p({ from: '2024-03-11', to: '2024-03-12' }))).toEqual([at('/report-b.txt')])
    // a date alone as `to` means the whole day
    expect(names(await p({ from: '2024-03-10', to: '2024-03-10', type: 'file' }))).toEqual([at('/report-a.pdf')])
    expect(names(await p({ from: '2024-03-14T00:00:00Z', type: 'file' }))).toEqual([at('/sub/Report-C.PDF')])
    for (const bad of [{ type: 'x' }, { from: 'nope' }, { minSize: '-1' }, { sort: 'x' }, { order: 'up' }, { limit: '0' }, { maxSize: 'big' }]) {
      const r = await p(bad)
      expect(r.status).toBe(400)
      expect(r.data.code).toBe('files.bad-filter')
    }
  })

  test('sort and order, limit', async () => {
    const { top } = makeTree()
    idx.indexTouched(join(storage(), top))
    await idx.indexIdle()
    const p = (extra: Record<string, string>) => admin.json('GET', q({ space: 'home', q: 'report', path: '/' + top, type: 'file', ...extra }))
    const at = (s: string) => `/${top}${s}`
    expect(names(await p({ sort: 'size', order: 'desc' }))).toEqual([at('/report-b.txt'), at('/sub/Report-C.PDF'), at('/report-a.pdf'), at('/sub/deep/report-d.md')])
    expect(names(await p({ sort: 'mtime' }))).toEqual([at('/sub/deep/report-d.md'), at('/report-a.pdf'), at('/report-b.txt'), at('/sub/Report-C.PDF')])
    expect(names(await p({ sort: 'mtime', order: 'desc' })).reverse()).toEqual(names(await p({ sort: 'mtime' })))
    expect(names(await p({ sort: 'name' }))).toEqual([at('/report-a.pdf'), at('/report-b.txt'), at('/sub/Report-C.PDF'), at('/sub/deep/report-d.md')])
    const two = await p({ limit: '2' })
    expect(two.data.results.length).toBe(2)
    expect(two.data.truncated).toBe(true)
    // the same answers from the walk of the disk
    const asked = { type: 'file', sort: 'size', order: 'desc', limit: '3' }
    const viaIndex = await p(asked)
    idx.stopSearchIndex()
    const viaWalk = await p(asked)
    expect(viaWalk.data.indexed).toBe(false)
    expect(viaIndex.data.indexed).toBe(true)
    expect(viaWalk.data.results).toEqual(viaIndex.data.results)
    idx.startSearchIndex()
    await idx.scanIndex()
  })

  test('a user never sees another home, a sibling folder or anything outside the start path', async () => {
    const a = `sxa${tag()}`
    const ab = `${a}b`
    for (const [name, perms] of [[a, ['read']], [ab, ['read']]] as const) {
      const r = await admin.json('POST', '/api/admin/users', { username: name, name, password: 'harbor-lamp-42', role: 'user', permissions: perms, publicPermissions: ['read'] })
      expect(r.status).toBe(200)
    }
    writeFileSync(join(storage(), 'users', a, 'mine-secret.txt'), 'x')
    mkdirSync(join(storage(), 'users', a, 'docs'))
    writeFileSync(join(storage(), 'users', a, 'docs', 'inside-secret.txt'), 'x')
    mkdirSync(join(storage(), 'users', a, 'docs2'))
    writeFileSync(join(storage(), 'users', a, 'docs2', 'sibling-secret.txt'), 'x')
    writeFileSync(join(storage(), 'users', ab, 'neighbour-secret.txt'), 'x')
    const pub = `pub-secret-${tag()}.txt`
    writeFileSync(join(paths.publicDir, pub), 'x')
    await idx.scanIndex()
    const c = new Client()
    expect((await c.login(a, 'harbor-lamp-42')).status).toBe(200)
    const all = await c.json('GET', q({ space: 'home', q: 'secret' }))
    expect(all.data.indexed).toBe(true)
    expect(names(all)).toEqual(['/docs/inside-secret.txt', '/mine-secret.txt', '/docs2/sibling-secret.txt'])
    // the start path is a prefix of whole segments: "docs" does not reach "docs2"
    expect(names(await c.json('GET', q({ space: 'home', q: 'secret', path: '/docs' })))).toEqual(['/docs/inside-secret.txt'])
    expect(names(await c.json('GET', q({ space: 'home', q: 'secret', path: '/docs/' })))).toEqual(['/docs/inside-secret.txt'])
    // crafted paths
    for (const path of ['/../' + ab, '/docs/../../' + ab, '/..', '..', '/docs/%2e%2e', '/docs\\..\\..', '/a\u0000']) {
      const r = await c.json('GET', q({ space: 'home', q: 'secret', path }))
      expect(r.status === 400 || (r.status === 200 && !names(r).some((p: string) => p.includes('neighbour')))).toBe(true)
      expect(JSON.stringify(r.data)).not.toContain('neighbour')
    }
    // the public space answers with the public folder only
    const inPub = await c.json('GET', q({ space: 'public', q: 'secret' }))
    expect(names(inPub)).toEqual(['/' + pub])
    // a space the caller can not read, or does not exist
    expect((await c.json('GET', q({ space: 'nope', q: 'secret' }))).status).toBeGreaterThanOrEqual(401)
    // the admin sees all of them from the storage root
    const adminAll = await admin.json('GET', q({ space: 'home', q: 'neighbour-secret', path: '/users' }))
    expect(names(adminAll)).toEqual([`/users/${ab}/neighbour-secret.txt`])
  })

  test('deleted, renamed, moved, new and copied files follow the index', async () => {
    const { top, root } = makeTree()
    idx.indexTouched(root)
    await idx.indexIdle()
    const find = async (needle: string) => names(await admin.json('GET', q({ space: 'home', q: needle, path: '/' + top })))
    const post = (p: string, b: any) => admin.json('POST', '/api/' + p, b)
    expect(await find('report-a')).toEqual([`/${top}/report-a.pdf`])
    // delete (to the trash): gone, and a folder takes everything under it along
    expect((await post('delete', { space: 'home', items: [`/${top}/report-a.pdf`, `/${top}/sub`] })).data.done).toBe(2)
    expect(await find('report-a')).toEqual([])
    expect(await find('report-d.md')).toEqual([])
    expect(await find('deep')).toEqual([])
    // rename a file
    expect((await post('rename', { space: 'home', path: `/${top}/report-b.txt`, name: 'renamed-b.txt' })).status).toBe(200)
    expect(await find('report-b')).toEqual([])
    expect(await find('renamed-b')).toEqual([`/${top}/renamed-b.txt`])
    // rename a folder with something inside, then move it
    touch(join(root, 'box', 'in', 'thing.dat'), 4, T0)
    idx.indexTouched(join(root, 'box'))
    await idx.indexIdle()
    expect(await find('thing')).toEqual([`/${top}/box/in/thing.dat`])
    expect((await post('rename', { space: 'home', path: `/${top}/box`, name: 'crate' })).status).toBe(200)
    await idx.indexIdle()
    expect(await find('thing')).toEqual([`/${top}/crate/in/thing.dat`])
    mkdirSync(join(root, 'dest'))
    expect((await post('mkdir', { space: 'home', path: `/${top}`, name: 'made' })).status).toBe(200)
    expect(await find('made')).toEqual([`/${top}/made`])
    expect((await post('move', { space: 'home', items: [`/${top}/crate`], dest: `/${top}/made` })).data.done).toBe(1)
    await idx.indexIdle()
    expect(await find('thing')).toEqual([`/${top}/made/crate/in/thing.dat`])
    expect(await find('crate')).toEqual([`/${top}/made/crate`])
    // copy
    expect((await post('copy', { space: 'home', items: [`/${top}/made/crate`], dest: `/${top}/dest` })).data.done).toBe(1)
    await idx.indexIdle()
    expect((await find('thing')).sort()).toEqual([`/${top}/dest/crate/in/thing.dat`, `/${top}/made/crate/in/thing.dat`])
    // new file, content save
    expect((await post('newfile', { space: 'home', path: `/${top}`, name: 'fresh.txt' })).status).toBe(200)
    expect(await find('fresh')).toEqual([`/${top}/fresh.txt`])
    const before = (await admin.json('GET', q({ space: 'home', q: 'fresh', path: '/' + top }))).data.results[0]
    expect(before.size).toBe(0)
    expect((await admin.json('PUT', '/api/content', { space: 'home', path: `/${top}/fresh.txt`, content: 'twelve bytes' })).status).toBe(200)
    expect((await admin.json('GET', q({ space: 'home', q: 'fresh', path: '/' + top }))).data.results[0].size).toBe(12)
    // zip and unzip
    expect((await post('zip', { space: 'home', path: `/${top}`, items: ['fresh.txt'], name: 'pack.zip' })).status).toBe(200)
    expect(await find('pack')).toEqual([`/${top}/pack.zip`])
    expect((await post('unzip', { space: 'home', path: `/${top}/pack.zip` })).status).toBe(200)
    await idx.indexIdle()
    expect(await find('fresh')).toEqual([`/${top}/fresh.txt`, `/${top}/pack/fresh.txt`])
    // upload in chunks
    const init = await post('upload', { space: 'home', path: `/${top}`, name: 'uploaded-file.bin', size: 3 })
    expect(init.status).toBe(200)
    const id = init.data.id
    expect((await admin.rawBytes('PUT', `/api/upload/${id}/0`, new Uint8Array([1, 2, 3]))).status).toBe(200)
    expect((await post(`upload/${id}/complete`, {})).status).toBe(200)
    expect(await find('uploaded-file')).toEqual([`/${top}/uploaded-file.bin`])
    // restore from the trash
    const trash = (await admin.json('GET', '/api/admin/trash')).data
    const item = trash.items.find((i: any) => i.name === 'sub' && i.originalPath === `/${top}/sub`)
    expect(item).toBeDefined()
    expect(await find('report-d.md')).toEqual([])
    const restored = await post('admin/trash/restore', { id: item.id })
    expect(restored.status).toBe(200)
    await idx.indexIdle()
    expect(await find('report-d.md')).toEqual([`/${top}/sub/deep/report-d.md`])
  })

  test('indexTouched removes a path and what is under it, by whole segments', async () => {
    const top = `sx-${tag()}`
    const root = join(storage(), top)
    for (const f of ['a/x.txt', 'a/b/y.txt', 'a2/z.txt', 'a.b/w.txt', 'a-c.txt']) touch(join(root, f), 1, T0)
    idx.indexTouched(root)
    await idx.indexIdle()
    const find = async () => (await idx.searchEntries(root, '/', '.txt', idx.parseFilters({}))).results.map(e => e.path).sort()
    expect((await find()).length).toBe(5)
    rmSync(join(root, 'a'), { recursive: true })
    idx.indexTouched(join(root, 'a'))
    expect(await find()).toEqual(['/a-c.txt', '/a.b/w.txt', '/a2/z.txt'])
    // % and _ in names are plain characters
    touch(join(root, '100%_done', 'p.txt'), 1, T0)
    touch(join(root, '100xx_done', 'q.txt'), 1, T0)
    idx.indexTouched(join(root, '100%_done'))
    idx.indexTouched(join(root, '100xx_done'))
    await idx.indexIdle()
    const sub = await idx.searchEntries(join(root, '100%_done'), '/100%_done', 'txt', idx.parseFilters({}))
    expect(sub.results.map(e => e.path)).toEqual(['/100%_done/p.txt'])
  })

  test('links are not followed, listed or indexed', async () => {
    const top = `sx-${tag()}`
    const root = join(storage(), top)
    touch(join(root, 'real', 'link-target-file.txt'), 1, T0)
    mkdirSync(join(base, 'outside-' + top), { recursive: true })
    writeFileSync(join(base, 'outside-' + top, 'link-outside.txt'), 'x')
    symlinkSync(join(base, 'outside-' + top), join(root, 'out-link'))
    symlinkSync(join(root, 'real'), join(root, 'in-link'))
    symlinkSync(join(root, 'real', 'link-target-file.txt'), join(root, 'file-link.txt'))
    await idx.scanIndex()
    const r = await admin.json('GET', q({ space: 'home', q: 'link', path: '/' + top }))
    expect(r.data.indexed).toBe(true)
    expect(names(r)).toEqual([`/${top}/real/link-target-file.txt`])
    const walked = await fsx.searchTree(root, '/' + top, 'link')
    expect(walked.results.map(e => e.path)).toEqual(names(r))
    // a start path through a link is answered by the walk, which is what the old search did
    const via = await admin.json('GET', q({ space: 'home', q: 'link', path: `/${top}/in-link` }))
    expect(via.status).toBe(200)
    expect(via.data.indexed).toBe(false)
    // touching a link adds nothing
    idx.indexTouched(join(root, 'out-link'))
    await idx.indexIdle()
    expect(names(await admin.json('GET', q({ space: 'home', q: 'link-outside', path: '/' + top })))).toEqual([])
    rmSync(join(base, 'outside-' + top), { recursive: true, force: true })
  })

  test('a damaged or old index file is deleted and built again', async () => {
    const { top } = makeTree()
    idx.stopSearchIndex()
    writeFileSync(paths.searchDb, 'this is not a database '.repeat(500))
    rmSync(paths.searchDb + '-wal', { force: true })
    idx.startSearchIndex()
    expect(idx.indexReady()).toBe(false)
    await idx.scanIndex()
    expect(idx.indexReady()).toBe(true)
    expect((await admin.json('GET', q({ space: 'home', q: 'report-a', path: '/' + top }))).data.indexed).toBe(true)
    // an older schema version
    idx.stopSearchIndex()
    const { Database } = await import('bun:sqlite')
    const old = new Database(paths.searchDb)
    old.exec('DROP TABLE entries; CREATE TABLE entries (old INTEGER); PRAGMA user_version = 7')
    old.close()
    idx.startSearchIndex()
    await idx.scanIndex()
    const r = await admin.json('GET', q({ space: 'home', q: 'report-a', path: '/' + top }))
    expect(r.data.indexed).toBe(true)
    expect(r.data.results.length).toBe(1)
  })

  test('a file that goes bad while running falls back to the disk and is built again', async () => {
    const { top } = makeTree()
    idx.stopSearchIndex()
    idx.startSearchIndex()
    await idx.scanIndex()
    const { Database } = await import('bun:sqlite')
    // break the table under the running index
    const other = new Database(paths.searchDb)
    other.exec('DROP INDEX entries_name; DROP TABLE entries')
    other.close()
    const r = await admin.json('GET', q({ space: 'home', q: 'report-a', path: '/' + top }))
    expect(r.status).toBe(200)
    expect(r.data.indexed).toBe(false)
    expect(names(r)).toEqual([`/${top}/report-a.pdf`])
    await idx.scanIndex()
    expect((await admin.json('GET', q({ space: 'home', q: 'report-a', path: '/' + top }))).data.indexed).toBe(true)
  })

  test('search.db is not in a backup', async () => {
    const { runBackup } = await import('../src/backup')
    expect(existsSync(paths.searchDb)).toBe(true)
    await runBackup()
    const list = (await admin.json('GET', '/api/admin/backups')).data
    const newest = (list.backups ?? list.items ?? list)[0].name
    const files = Object.keys(unzipSync(new Uint8Array(await (await admin.raw('GET', `/api/admin/backups/${newest}/download`)).arrayBuffer())))
    expect(files.length).toBeGreaterThan(0)
    expect(files.filter(f => f.includes('search.db'))).toEqual([])
  })

  test('20,000 files are answered in under 200 ms once indexed', async () => {
    const top = `sx-perf-${tag()}`
    const root = join(storage(), top)
    // hard links to one file: 20,000 real files take many seconds to make on a slow disk, links take a fraction
    const one = join(base, `one-${top}`)
    writeFileSync(one, '')
    for (let d = 0; d < 100; d++) {
      mkdirSync(join(root, `d${d}`), { recursive: true })
      for (let f = 0; f < 200; f++) linkSync(one, join(root, `d${d}`, `file-${d}-${f}${f % 7 === 0 ? '.log' : '.dat'}`))
    }
    await idx.scanIndex()
    const ask = () => admin.json('GET', q({ space: 'home', q: 'file-5', path: '/' + top, ext: 'log', sort: 'mtime', order: 'desc' }))
    const first = await ask()
    expect(first.data.indexed).toBe(true)
    expect(first.data.results.length).toBeGreaterThan(0)
    // the worst of five asks, so one slow moment can not hide a slow query
    let worst = 0
    for (let i = 0; i < 5; i++) {
      const t = performance.now()
      await ask()
      worst = Math.max(worst, performance.now() - t)
    }
    const direct = performance.now()
    const all = await idx.searchEntries(root, '/' + top, 'file-', idx.parseFilters({ limit: '500' }))
    const directMs = performance.now() - direct
    expect(all.results.length).toBe(500)
    expect(all.truncated).toBe(true)
    expect(worst).toBeLessThan(200)
    expect(directMs).toBeLessThan(200)
    rmSync(root, { recursive: true, force: true })
    rmSync(one, { force: true })
    idx.indexTouched(root)
  }, 120_000)
})
