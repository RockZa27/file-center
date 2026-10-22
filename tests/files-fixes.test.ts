/**
 * Fixes of the 1.12.1 file review: unzip limits and slots, an upload whose folder went away, a retried "complete",
 * a move that must not replace a file, the quota counts after an admin's move, an atomic save, and zip names that are not
 * UTF-8. Runs in-process on the same app as api.test.ts (see in-process-env.ts); every user and folder here starts with
 * "fx" so no other file's names are touched.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import './in-process-env'

let app: any
let config: typeof import('../src/config').config
let fsx: typeof import('../src/fsx')
let zipMod: typeof import('../src/zip')
let archive: typeof import('../src/archive')
let quota: typeof import('../src/quota')
let auth: typeof import('../src/auth')

class Client {
  cookie = ''
  csrf = ''
  async raw(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers }
    if (this.cookie) h.cookie = this.cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    let payload: any = body
    if (body !== undefined && !(body instanceof Uint8Array)) {
      payload = JSON.stringify(body)
      h['content-type'] = 'application/json'
    }
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: payload }))
    const set = res.headers.get('set-cookie')
    if (set?.startsWith('fc_sid=')) this.cookie = set.split(';')[0]
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
    return this
  }
}

const PW = 'harbor-lamp-42'
const PERMS = ['read', 'write', 'upload', 'download', 'zip', 'share', 'batchdownload']
const admin = new Client()
const store = (...p: string[]) => join(process.env.STORAGE_DIR!, ...p)
const home = (user: string, ...p: string[]) => store('users', user, ...p)
const enc = (s: string) => new TextEncoder().encode(s)

async function userWith(username: string, extra: Record<string, unknown> = {}) {
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', permissions: PERMS, publicPermissions: [], ...extra })
  expect(r.status).toBe(200)
  mkdirSync(home(username), { recursive: true })
  return new Client().login(username, PW)
}

const scratch = mkdtempSync(join(tmpdir(), 'fc-fx-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let n = 0
const box = () => {
  const d = join(scratch, `t${n++}`)
  mkdirSync(d)
  return d
}

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config } = await import('../src/config'))
  fsx = await import('../src/fsx')
  zipMod = await import('../src/zip')
  archive = await import('../src/archive')
  quota = await import('../src/quota')
  auth = await import('../src/auth')
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
})

/** announce, send in one chunk, (not complete) */
async function startUpload(c: Client, space: string, path: string, name: string, content: Uint8Array) {
  const init = await c.json('POST', '/api/upload', { space, path, name, size: content.length })
  expect(init.status).toBe(200)
  const put = await c.raw('PUT', `/api/upload/${init.data.id}/0`, content, { 'content-type': 'application/octet-stream' })
  expect(put.status).toBe(200)
  return init.data.id as string
}

// ───────────── 1. unzip ─────────────

/** a zip whose end record claims `claimed` entries, while the directory holds only one */
function lyingZip(claimed: number): Uint8Array {
  const z = zipSync({ 'a.txt': new Uint8Array(1) })
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength)
  const eocd = z.length - 22
  expect(dv.getUint32(eocd, true)).toBe(0x06054b50)
  dv.setUint16(eocd + 8, claimed, true)
  dv.setUint16(eocd + 10, claimed, true)
  return z
}

describe('unzip refuses before it reads the entries', () => {
  test('a directory that claims more entries than the file cap is refused unread', async () => {
    const zip = join(box(), 'lie.zip')
    writeFileSync(zip, lyingZip(60_000))
    const dest = join(box(), 'out')
    mkdirSync(dest)
    // before the fix zip.js tried to read 60,000 entries and failed with a raw error half way
    const err: any = await zipMod.unzipTo(zip, dest, { maxBytes: 1e9, maxFiles: 50_000 }).then(() => null, e => e)
    expect(err?.code).toBe('zip.too-many-files')
    expect(readdirSync(dest)).toEqual([])
    // a lower cap is used as it is
    const small: any = await zipMod.unzipTo(zip, dest, { maxBytes: 1e9, maxFiles: 100 }).then(() => null, e => e)
    expect(small?.code).toBe('zip.too-many-files')
  })

  test('many empty entries, more than the cap, are refused with the same message; fewer are extracted', async () => {
    const files: Record<string, Uint8Array> = {}
    for (let i = 0; i < 300; i++) files[`e${i}.txt`] = new Uint8Array(0)
    const zip = join(box(), 'many.zip')
    writeFileSync(zip, zipSync(files))
    const dest = join(box(), 'out')
    mkdirSync(dest)
    const err: any = await zipMod.unzipTo(zip, dest, { maxBytes: 1e9, maxFiles: 100 }).then(() => null, e => e)
    expect(err?.code).toBe('zip.too-many-files')
    expect(readdirSync(dest)).toEqual([])
    expect(await zipMod.unzipTo(zip, dest, { maxBytes: 1e9, maxFiles: 300 })).toBe(300)
  })

  test('POST /api/unzip answers 400 zip.too-many-files for it', async () => {
    mkdirSync(store('fx-unzip'), { recursive: true })
    writeFileSync(store('fx-unzip', 'lie.zip'), lyingZip(config.unzipMaxFiles + 10))
    const r = await admin.json('POST', '/api/unzip', { space: 'home', path: '/fx-unzip/lie.zip' })
    expect(`${r.status} ${r.data.code}`).toBe('400 zip.too-many-files')
    expect(readdirSync(store('fx-unzip'))).toEqual(['lie.zip'])
  })

  test('only a few extractions run at once, apart from the viewer\'s places', async () => {
    const taken: (() => void)[] = []
    try {
      for (let i = 0; i < archive.UNZIP_MAX_CONCURRENT; i++) taken.push(archive.takeUnzipSlot())
      expect(archive.unzipBusy()).toBe(archive.UNZIP_MAX_CONCURRENT)
      expect(archive.archiveBusy()).toBe(0)
      expect(() => archive.takeUnzipSlot()).toThrow(expect.objectContaining({ status: 503, code: 'archive.busy' }))
      // the route says so too, and gives nothing away: no folder, no hold
      writeFileSync(store('fx-unzip', 'ok.zip'), zipSync({ 'a.txt': enc('a') }))
      const r = await admin.json('POST', '/api/unzip', { space: 'home', path: '/fx-unzip/ok.zip' })
      expect(`${r.status} ${r.data.code}`).toBe('503 archive.busy')
      expect(existsSync(store('fx-unzip', 'ok'))).toBe(false)
      taken[0]()
      taken[0]() // twice is the same as once
      const again = await admin.json('POST', '/api/unzip', { space: 'home', path: '/fx-unzip/ok.zip' })
      expect(again.status).toBe(200)
    } finally {
      for (const release of taken) release()
    }
    expect(archive.unzipBusy()).toBe(0)
  })
})

// ───────────── 2 + 4. uploads ─────────────

describe('uploads', () => {
  test('into a folder that still exists it works, and the folder is not touched', async () => {
    await admin.json('POST', '/api/mkdir', { space: 'home', path: '/', name: 'fx-up-ok' })
    const id = await startUpload(admin, 'home', '/fx-up-ok', 'a.txt', enc('hello'))
    const done = await admin.json('POST', `/api/upload/${id}/complete`)
    expect(done.status).toBe(200)
    expect(readFileSync(store('fx-up-ok', 'a.txt'), 'utf8')).toBe('hello')
  })

  for (const how of ['renamed', 'deleted', 'moved'] as const) {
    test(`completing after the folder was ${how} is refused and does not make the old folder again`, async () => {
      const name = `fx-up-${how}`
      await admin.json('POST', '/api/mkdir', { space: 'home', path: '/', name })
      await admin.json('POST', '/api/mkdir', { space: 'home', path: '/', name: `${name}-elsewhere` })
      const id = await startUpload(admin, 'home', `/${name}`, 'late.txt', enc('late'))
      if (how === 'renamed') expect((await admin.json('POST', '/api/rename', { space: 'home', path: `/${name}`, name: `${name}-new` })).status).toBe(200)
      if (how === 'deleted') expect((await admin.json('POST', '/api/delete', { space: 'home', items: [`/${name}`] })).status).toBe(200)
      if (how === 'moved') expect((await admin.json('POST', '/api/move', { space: 'home', items: [`/${name}`], dest: `/${name}-elsewhere` })).status).toBe(200)
      const done = await admin.json('POST', `/api/upload/${id}/complete`)
      expect(`${done.status} ${done.data.code}`).toBe('409 upload.dest-gone')
      expect(existsSync(store(name))).toBe(false)
      // the upload is dropped
      expect((await admin.json('GET', `/api/upload/${id}`)).status).toBe(404)
      expect(existsSync(join(config.dataDir, 'tmp', id))).toBe(false)
    })
  }

  test('the next chunk of such an upload is refused early, and the quota hold is given back', async () => {
    const u = await userWith('fx-quota1', { quotaBytes: 1000 })
    await u.json('POST', '/api/mkdir', { space: 'home', path: '/', name: 'gone' })
    const big = new Uint8Array(800)
    const init = await u.json('POST', '/api/upload', { space: 'home', path: '/gone', name: 'big.bin', size: 800 })
    expect(init.status).toBe(200)
    // 800 of 1000 are held: a second one of that size does not fit
    expect((await u.json('POST', '/api/upload', { space: 'home', path: '/', name: 'two.bin', size: 800 })).data.code).toBe('quota.exceeded')
    await u.json('POST', '/api/delete', { space: 'home', items: ['/gone'] })
    const put = await u.raw('PUT', `/api/upload/${init.data.id}/0`, big, { 'content-type': 'application/octet-stream' })
    expect(put.status).toBe(409)
    expect(existsSync(home('fx-quota1', 'gone'))).toBe(false)
    // the hold is free again
    const second = await u.json('POST', '/api/upload', { space: 'home', path: '/', name: 'two.bin', size: 800 })
    expect(second.status).toBe(200)
    await u.json('DELETE', `/api/upload/${second.data.id}`)
  })

  test('a second "complete" for the same upload (a lost answer) gives the same success and no copy', async () => {
    await admin.json('POST', '/api/mkdir', { space: 'home', path: '/', name: 'fx-up-retry' })
    const id = await startUpload(admin, 'home', '/fx-up-retry', 'r.txt', enc('once'))
    const first = await admin.json('POST', `/api/upload/${id}/complete`)
    const second = await admin.json('POST', `/api/upload/${id}/complete`)
    expect(first).toEqual({ status: 200, data: { ok: true, size: 4 } })
    expect(second).toEqual(first)
    expect(readdirSync(store('fx-up-retry'))).toEqual(['r.txt'])
    // not somebody else's
    const other = await userWith('fx-other1')
    expect((await other.json('POST', `/api/upload/${id}/complete`)).status).toBe(404)
  })

  test('two "complete" calls at the same time make one file', async () => {
    await admin.json('POST', '/api/mkdir', { space: 'home', path: '/', name: 'fx-up-twice' })
    const id = await startUpload(admin, 'home', '/fx-up-twice', 't.txt', enc('twice'))
    const [a, b] = await Promise.all([admin.json('POST', `/api/upload/${id}/complete`), admin.json('POST', `/api/upload/${id}/complete`)])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(readdirSync(store('fx-up-twice'))).toEqual(['t.txt'])
  })

  test('a file that is already there is never replaced by the upload', async () => {
    await admin.json('POST', '/api/mkdir', { space: 'home', path: '/', name: 'fx-up-same' })
    writeFileSync(store('fx-up-same', 'x.txt'), 'old')
    const id = await startUpload(admin, 'home', '/fx-up-same', 'x.txt', enc('new'))
    expect((await admin.json('POST', `/api/upload/${id}/complete`)).status).toBe(200)
    expect(readFileSync(store('fx-up-same', 'x.txt'), 'utf8')).toBe('old')
    expect(readFileSync(store('fx-up-same', 'x (1).txt'), 'utf8')).toBe('new')
  })
})

// ───────────── 3. move ─────────────

describe('moveTree never replaces what is at the destination', () => {
  test('a file onto an existing file throws and leaves both as they were', async () => {
    const d = box()
    writeFileSync(join(d, 'from.txt'), 'from')
    writeFileSync(join(d, 'to.txt'), 'to')
    const err: any = await fsx.moveTree(join(d, 'from.txt'), join(d, 'to.txt')).then(() => null, e => e)
    expect(err?.code).toBe('EEXIST')
    expect(readFileSync(join(d, 'from.txt'), 'utf8')).toBe('from')
    expect(readFileSync(join(d, 'to.txt'), 'utf8')).toBe('to')
    expect(readdirSync(d).sort()).toEqual(['from.txt', 'to.txt'])
  })

  test('a link onto an existing name, a file onto a folder and a folder onto a file or a full folder throw', async () => {
    const d = box()
    writeFileSync(join(d, 'f'), 'f')
    writeFileSync(join(d, 'taken'), 'taken')
    symlinkSync('f', join(d, 'l'))
    mkdirSync(join(d, 'dir'))
    mkdirSync(join(d, 'full'))
    writeFileSync(join(d, 'full', 'x'), 'x')
    mkdirSync(join(d, 'src'))
    writeFileSync(join(d, 'src', 'y'), 'y')
    const codes: Record<string, string> = {}
    for (const [from, to] of [['l', 'taken'], ['f', 'dir'], ['src', 'taken'], ['src', 'full']]) {
      codes[`${from}>${to}`] = await fsx.moveTree(join(d, from), join(d, to)).then(() => 'moved', (e: any) => e.code)
    }
    expect(codes['l>taken']).toBe('EEXIST')
    expect(codes['f>dir']).toBe('EEXIST')
    expect(['ENOTDIR', 'EEXIST']).toContain(codes['src>taken'])
    expect(['ENOTEMPTY', 'EEXIST']).toContain(codes['src>full'])
    expect(readFileSync(join(d, 'taken'), 'utf8')).toBe('taken')
    expect(readFileSync(join(d, 'full', 'x'), 'utf8')).toBe('x')
    expect(readFileSync(join(d, 'src', 'y'), 'utf8')).toBe('y')
    expect(lstatSync(join(d, 'l')).isSymbolicLink()).toBe(true)
  })

  test('a move to a free name still works: the source is gone, one name, links stay links, folders move whole', async () => {
    const d = box()
    writeFileSync(join(d, 'a.txt'), 'a')
    await fsx.moveTree(join(d, 'a.txt'), join(d, 'b.txt'))
    expect(existsSync(join(d, 'a.txt'))).toBe(false)
    expect(readFileSync(join(d, 'b.txt'), 'utf8')).toBe('a')
    expect(statSync(join(d, 'b.txt')).nlink).toBe(1)
    symlinkSync('b.txt', join(d, 'l'))
    await fsx.moveTree(join(d, 'l'), join(d, 'l2'))
    expect(lstatSync(join(d, 'l2')).isSymbolicLink()).toBe(true)
    mkdirSync(join(d, 'dir'))
    writeFileSync(join(d, 'dir', 'x'), 'x')
    await fsx.moveTree(join(d, 'dir'), join(d, 'dir2'))
    expect(readFileSync(join(d, 'dir2', 'x'), 'utf8')).toBe('x')
    // a folder may still take the place of an empty one
    mkdirSync(join(d, 'empty'))
    await fsx.moveTree(join(d, 'dir2'), join(d, 'empty'))
    expect(readFileSync(join(d, 'empty', 'x'), 'utf8')).toBe('x')
  })

  test('overwrite: true is the explicit way to replace (the same file under another case)', async () => {
    const d = box()
    writeFileSync(join(d, 'a'), 'a')
    writeFileSync(join(d, 'b'), 'b')
    await fsx.moveTree(join(d, 'a'), join(d, 'b'), null, { overwrite: true })
    expect(readFileSync(join(d, 'b'), 'utf8')).toBe('a')
    expect(existsSync(join(d, 'a'))).toBe(false)
  })

  test('across disks the copy does not replace a file either', async () => {
    const d = box()
    writeFileSync(join(d, 'a'), 'a')
    writeFileSync(join(d, 'b'), 'b')
    const otherDisk = async () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }) }
    const err: any = await fsx.moveTree(join(d, 'a'), join(d, 'b'), otherDisk).then(() => null, e => e)
    expect(err?.code).toBe('EEXIST')
    expect(readFileSync(join(d, 'a'), 'utf8')).toBe('a')
    expect(readFileSync(join(d, 'b'), 'utf8')).toBe('b')
  })

  test('POST /api/rename and /api/move answer 409 when the name is taken', async () => {
    await admin.json('POST', '/api/mkdir', { space: 'home', path: '/', name: 'fx-mv' })
    writeFileSync(store('fx-mv', 'a.txt'), 'a')
    writeFileSync(store('fx-mv', 'b.txt'), 'b')
    expect((await admin.json('POST', '/api/rename', { space: 'home', path: '/fx-mv/a.txt', name: 'b.txt' })).status).toBe(409)
    expect(readFileSync(store('fx-mv', 'b.txt'), 'utf8')).toBe('b')
  })
})

// ───────────── 7. quota counts after an admin's move ─────────────

describe('quota counts', () => {
  test('an admin moving a file between two homes marks both counts out of date', async () => {
    await userWith('fx-qa', { quotaBytes: 10_000 })
    await userWith('fx-qb', { quotaBytes: 10_000 })
    writeFileSync(home('fx-qa', 'big.bin'), new Uint8Array(500))
    const [a, b] = ['fx-qa', 'fx-qb'].map(name => auth.allUsers().find(u => u.username === name)!)
    // both counted and fresh
    await quota.ready(a)
    await quota.ready(b)
    expect([quota.usage(a).used, quota.usage(b).used]).toEqual([500, 0])
    const r = await admin.json('POST', '/api/move', { space: 'home', items: ['/users/fx-qa/big.bin'], dest: '/users/fx-qb' })
    expect(r.data).toEqual({ done: 1, failed: [] })
    await quota.ready(a)
    await quota.ready(b)
    expect([quota.usage(a).used, quota.usage(b).used]).toEqual([0, 500])
  })

  test('markStaleBetween ignores paths outside every home', () => {
    expect(() => quota.markStaleBetween(store('fx-nobody-a'), store('fx-nobody-b'))).not.toThrow()
  })
})

// ───────────── 8. atomic save ─────────────

describe('PUT /api/content writes the file in one step', () => {
  test('the content is replaced by a rename: a new file, same mode, no temp file left', async () => {
    await admin.json('POST', '/api/mkdir', { space: 'home', path: '/', name: 'fx-save' })
    const file = store('fx-save', 'note.txt')
    writeFileSync(file, 'old')
    chmodSync(file, 0o640)
    const inode = statSync(file).ino
    const held = join(scratch, 'held-old') // a reader that opened the old file keeps seeing the old content
    linkSync(file, held)
    const r = await admin.json('PUT', '/api/content', { space: 'home', path: '/fx-save/note.txt', content: 'new content' })
    expect(r.status).toBe(200)
    expect(readFileSync(file, 'utf8')).toBe('new content')
    expect(readFileSync(held, 'utf8')).toBe('old')
    expect(statSync(file).ino).not.toBe(inode)
    expect(statSync(file).mode & 0o777).toBe(0o640)
    expect(readdirSync(store('fx-save'))).toEqual(['note.txt'])
    // the old content is still kept as a version
    const versions = await admin.json('GET', `/api/versions?space=home&path=${encodeURIComponent('/fx-save/note.txt')}`)
    expect(versions.status).toBe(200)
    expect(JSON.stringify(versions.data)).toContain('edit')
  })

  test('writeFileAtomic writes through a link and cleans up when it fails', () => {
    const d = box()
    writeFileSync(join(d, 'real.txt'), 'old')
    symlinkSync('real.txt', join(d, 'link.txt'))
    fsx.writeFileAtomic(join(d, 'link.txt'), 'via link')
    expect(lstatSync(join(d, 'link.txt')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(d, 'real.txt'), 'utf8')).toBe('via link')
    expect(() => fsx.writeFileAtomic(join(d, 'missing.txt'), 'x')).toThrow()
    expect(readdirSync(d).sort()).toEqual(['link.txt', 'real.txt'])
  })
})

// ───────────── 9. zip names that are not UTF-8 ─────────────

/** windows-874: the Thai letters U+0E01..U+0E3A are 0xA1..0xDA, U+0E3F..U+0E5B are 0xDF..0xFB */
function cp874(s: string): Uint8Array {
  const out: number[] = []
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (c < 0x80) out.push(c)
    else if (c >= 0x0e01 && c <= 0x0e3a) out.push(c - 0x0e01 + 0xa1)
    else if (c >= 0x0e3f && c <= 0x0e5b) out.push(c - 0x0e3f + 0xdf)
    else throw new Error('not in the test table')
  }
  return Uint8Array.from(out)
}

/** a stored (not compressed) zip of {raw name bytes: content}; the UTF-8 flag (bit 11) is never set */
function handZip(entries: { name: Uint8Array; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const { name, data } of entries) {
    const crc = Bun.hash.crc32(data)
    const local = new Uint8Array(30 + name.length)
    const l = new DataView(local.buffer)
    l.setUint32(0, 0x04034b50, true)
    l.setUint16(4, 20, true)
    l.setUint32(14, crc, true)
    l.setUint32(18, data.length, true)
    l.setUint32(22, data.length, true)
    l.setUint16(26, name.length, true)
    local.set(name, 30)
    const head = new Uint8Array(46 + name.length)
    const c = new DataView(head.buffer)
    c.setUint32(0, 0x02014b50, true)
    c.setUint16(4, 20, true)
    c.setUint16(6, 20, true)
    c.setUint32(16, crc, true)
    c.setUint32(20, data.length, true)
    c.setUint32(24, data.length, true)
    c.setUint16(28, name.length, true)
    c.setUint32(42, offset, true)
    head.set(name, 46)
    parts.push(local, data)
    central.push(head)
    offset += local.length + data.length
  }
  const size = central.reduce((s, x) => s + x.length, 0)
  const end = new Uint8Array(22)
  const e = new DataView(end.buffer)
  e.setUint32(0, 0x06054b50, true)
  e.setUint16(8, entries.length, true)
  e.setUint16(10, entries.length, true)
  e.setUint32(12, size, true)
  e.setUint32(16, offset, true)
  return Buffer.concat([...parts, ...central, end])
}

describe('zip names without the UTF-8 flag', () => {
  const thai = 'ไทย.txt'
  const legacy = () => handZip([{ name: cp874(thai), data: enc('thai') }])

  test('the viewer reads a windows-874 name as Thai, not as CP437', async () => {
    const zip = join(box(), 'thai874.zip')
    writeFileSync(zip, legacy())
    expect(config.zipLegacyEncoding).toBe('cp874')
    const { entries } = await archive.listArchive(zip)
    expect(entries.map(e => e.name)).toEqual([thai])
  })

  test('unzipTo makes the file with the Thai name', async () => {
    const zip = join(box(), 'thai874.zip')
    writeFileSync(zip, legacy())
    const dest = join(box(), 'out')
    mkdirSync(dest)
    expect(await zipMod.unzipTo(zip, dest, { maxBytes: 1e6, maxFiles: 10 })).toBe(1)
    expect(readdirSync(dest)).toEqual([thai])
    expect(readFileSync(join(dest, thai), 'utf8')).toBe('thai')
  })

  test('bytes that are valid UTF-8 stay UTF-8 even without the flag', async () => {
    const zip = join(box(), 'utf8.zip')
    writeFileSync(zip, handZip([{ name: enc('ภาษาไทย.txt'), data: enc('x') }]))
    expect((await archive.listArchive(zip)).entries.map(e => e.name)).toEqual(['ภาษาไทย.txt'])
  })

  test('ZIP_LEGACY_ENCODING picks the code page (cp437 = what zip.js does alone)', async () => {
    const zip = join(box(), 'other.zip')
    writeFileSync(zip, handZip([{ name: Uint8Array.from([0x61, 0xe9]), data: enc('x') }])) // "a" + 0xE9
    const was = config.zipLegacyEncoding
    try {
      const names: Record<string, string> = {}
      for (const code of ['cp437', 'cp1252', 'windows-1251', 'cp874', 'no-such-page']) {
        config.zipLegacyEncoding = code
        names[code] = (await archive.listArchive(zip)).entries[0].name
      }
      expect(names).toEqual({ cp437: 'aΘ', cp1252: 'aé', 'windows-1251': 'aй', cp874: 'a้', 'no-such-page': 'a้' })
    } finally {
      config.zipLegacyEncoding = was
    }
  })
})
