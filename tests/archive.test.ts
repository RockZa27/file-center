/**
 * Looking inside a zip without extracting it (src/archive.ts: GET /api/archive/list and /api/archive/file, and the same
 * two under /api/s/:token for folder links). Runs in-process on the same app as api.test.ts (see in-process-env.ts);
 * every user here starts with "ar-".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js'
import { zipSync } from 'fflate'
import './in-process-env'

let app: any
let config: typeof import('../src/config').config
let audit: typeof import('../src/audit')

class Client {
  cookie = ''
  csrf = ''
  async raw(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers }
    const cookies = [this.cookie, headers.cookie].filter(Boolean)
    if (cookies.length) h.cookie = cookies.join('; ')
    if (this.csrf) h['x-csrf-token'] = this.csrf
    let payload: any = body
    if (body !== undefined) {
      payload = JSON.stringify(body)
      h['content-type'] = 'application/json'
    }
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: payload }))
    const set = res.headers.get('set-cookie')
    if (set?.startsWith('fc_sid=')) this.cookie = set.split(';')[0]
    return res
  }
  async json(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const res = await this.raw(method, path, body, headers)
    return { status: res.status, data: (await res.json().catch(() => null)) as any, res }
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
const admin = new Client()
const anon = new Client()
const home = (user: string, ...p: string[]) => join(process.env.STORAGE_DIR!, 'users', user, ...p)
const q = (o: Record<string, string>) => new URLSearchParams(o).toString()
const enc = (s: string) => new TextEncoder().encode(s)

let owner: Client

async function userWith(username: string, permissions: string[]) {
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', permissions, publicPermissions: [] })
  expect(r.status).toBe(200)
  return new Client().login(username, PW)
}

const list = (c: Client, path: string) => c.json('GET', `/api/archive/list?${q({ space: 'home', path })}`)
const file = (c: Client, path: string, entry: string, extra: Record<string, string> = {}) =>
  c.raw('GET', `/api/archive/file?${q({ space: 'home', path, entry, ...extra })}`)

/** the whole body, or null when the answer broke off in the middle */
async function bodyOf(res: Response): Promise<Uint8Array | null> {
  try { return new Uint8Array(await res.arrayBuffer()) } catch { return null }
}

const random = (n: number) => { const b = new Uint8Array(n); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536))); return b }

async function zipJs(entries: { name: string; data: string | Uint8Array; zip64?: boolean; password?: string }[]): Promise<Uint8Array> {
  const w = new ZipWriter(new BlobWriter('application/zip'))
  for (const e of entries) {
    const reader = typeof e.data === 'string' ? new TextReader(e.data) : new Uint8ArrayReader(e.data)
    await w.add(e.name, reader, { zip64: e.zip64, password: e.password })
  }
  return new Uint8Array(await (await w.close()).arrayBuffer())
}

const BIG = random(3 * 1024 * 1024 + 17)
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config } = await import('../src/config'))
  audit = await import('../src/audit')
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
  owner = await userWith('ar-owner', ['read', 'write', 'download', 'share'])
  mkdirSync(home('ar-owner', 'proj'), { recursive: true })
  mkdirSync(home('ar-owner', 'outside'), { recursive: true })

  writeFileSync(home('ar-owner', 'main.zip'), zipSync({
    'readme.txt': enc('hello'),
    'เอกสาร/รายงาน ประจำปี.txt': enc('สวัสดี'),
    'เอกสาร/ย่อย/ลึก.txt': enc('deep'),
    'เอกสาร/ว่าง/': new Uint8Array(0),
    'pic.png': PNG_BYTES,
    'page.html': enc('<script>alert(1)</script>'),
    'note.txt': enc('plain text'),
    'big.bin': BIG,
    'icon.svg': enc('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  }))
  // names that point out of a folder if anyone ever used them as a path
  writeFileSync(home('ar-owner', 'evil.zip'), zipSync({ '../evil.txt': enc('escaped'), 'a/../../b.txt': enc('b'), '/abs.txt': enc('abs'), 'ok.txt': enc('ok'), 'x\\y.txt': enc('backslash') }))
  writeFileSync(home('ar-owner', 'zip64.zip'), await zipJs([{ name: 'one.txt', data: 'zip64 entry', zip64: true }, { name: 'two.txt', data: 'normal' }]))
  writeFileSync(home('ar-owner', 'crypt.zip'), await zipJs([{ name: 'secret.txt', data: 'top secret', password: 'pw' }, { name: 'open.txt', data: 'open' }]))
  writeFileSync(home('ar-owner', 'plain.txt'), 'not a zip at all')
  writeFileSync(home('ar-owner', 'fake.zip'), 'PK\x03\x04 and then rubbish that is not a central directory')
  writeFileSync(home('ar-owner', 'cut.zip'), zipSync({ 'a.txt': enc('a'.repeat(5000)) }).subarray(0, 60))
  writeFileSync(home('ar-owner', 'empty.zip'), zipSync({}))

  const many: Record<string, Uint8Array> = {}
  for (let i = 0; i < 10_001; i++) many[`f/${i}.txt`] = new Uint8Array(0)
  writeFileSync(home('ar-owner', 'many.zip'), zipSync(many, { level: 0 }))

  // 120 MB of zeros packs to about 120 KB: over 100 MB and far over 100:1
  writeFileSync(home('ar-owner', 'bomb.zip'), zipSync({ 'bomb.bin': new Uint8Array(120 * 1024 * 1024), 'small.txt': enc('fine') }, { level: 1 }))
  writeFileSync(home('ar-owner', 'sizes.zip'), zipSync({ 'five-k.bin': new Uint8Array(5000).fill(7), 'one-k.bin': random(1000) }, { level: 1 }))
  // the central directory says 1000 bytes, the data is 100000 (once packed, once stored)
  const lying = (data: Uint8Array, level: 0 | 1) => {
    const z = zipSync({ 'lie.bin': data }, { level })
    const dv = new DataView(z.buffer, z.byteOffset, z.byteLength)
    for (let i = 0; i < z.length - 28; i++) if (dv.getUint32(i, true) === 0x02014b50) { dv.setUint32(i + 24, 1000, true); break }
    return z
  }
  writeFileSync(home('ar-owner', 'lie.zip'), lying(new Uint8Array(100_000).fill(9), 1))
  writeFileSync(home('ar-owner', 'lie-stored.zip'), lying(random(100_000), 0))

  writeFileSync(home('ar-owner', 'proj', 'in.zip'), zipSync({ 'inside.txt': enc('inside the share') }))
  writeFileSync(home('ar-owner', 'proj', 'sub.txt'), 'x')
  symlinkSync(home('ar-owner', 'main.zip'), home('ar-owner', 'proj', 'link.zip'))
  writeFileSync(home('ar-owner', 'outside', 'o.zip'), zipSync({ 'o.txt': enc('outside') }))
})

// other test files count the files in the homes of the users: leave none behind
afterAll(() => {
  for (const u of ['ar-owner', 'ar-nodl', 'ar-noread', 'ar-other']) rmSync(home(u), { recursive: true, force: true })
})

describe('listing', () => {
  test('the entries come from the central directory: Thai names, folders, sizes, times', async () => {
    const r = await list(owner, '/main.zip')
    expect(r.status).toBe(200)
    expect(r.data.truncated).toBe(false)
    const byName = new Map(r.data.entries.map((e: any) => [e.name, e]))
    expect(byName.get('เอกสาร/รายงาน ประจำปี.txt')).toMatchObject({ dir: false, size: enc('สวัสดี').length, encrypted: false })
    expect(byName.get('เอกสาร/ย่อย/ลึก.txt')).toMatchObject({ dir: false, size: 4 })
    expect(byName.get('เอกสาร/ว่าง/')).toMatchObject({ dir: true, size: 0 })
    expect(byName.get('big.bin')).toMatchObject({ size: BIG.length })
    const e: any = byName.get('readme.txt')
    expect(typeof e.compressed).toBe('number')
    expect(e.modified).toBeGreaterThan(Date.parse('2000-01-01'))
    expect(Object.keys(e).sort()).toEqual(['compressed', 'dir', 'encrypted', 'modified', 'name', 'size'])
  })

  test('ZIP64 entries are read; an encrypted entry says so; an empty zip is an empty list', async () => {
    const z = await list(owner, '/zip64.zip')
    expect(z.data.entries.map((e: any) => e.name)).toEqual(['one.txt', 'two.txt'])
    expect(z.data.entries[0].size).toBe(11)
    const c = await list(owner, '/crypt.zip')
    expect(Object.fromEntries(c.data.entries.map((e: any) => [e.name, e.encrypted]))).toEqual({ 'secret.txt': true, 'open.txt': false })
    expect((await list(owner, '/empty.zip')).data).toEqual({ entries: [], truncated: false })
  })

  test('more than 10,000 entries are cut off and say so', async () => {
    const r = await list(owner, '/many.zip')
    expect(r.status).toBe(200)
    expect(r.data.entries.length).toBe(10_000)
    expect(r.data.truncated).toBe(true)
  })

  test('what is not a zip is refused with archive.not-zip', async () => {
    for (const name of ['/plain.txt', '/fake.zip', '/cut.zip']) {
      const r = await list(owner, name)
      expect([name, r.status, r.data.code]).toEqual([name, 400, 'archive.not-zip'])
    }
    expect((await list(owner, '/nothing.zip')).status).toBe(404)
    expect((await list(owner, '/proj')).status).toBe(404)
  })
})

describe('taking one entry out', () => {
  test('the bytes are exactly the entry, with a length and the locked-down headers', async () => {
    const r = await file(owner, '/main.zip', 'big.bin')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-length')).toBe(String(BIG.length))
    expect(r.headers.get('content-disposition')).toStartWith('attachment;')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(await bodyOf(r)).toEqual(BIG)
    const thai = await file(owner, '/main.zip', 'เอกสาร/รายงาน ประจำปี.txt')
    expect(new TextDecoder().decode((await bodyOf(thai))!)).toBe('สวัสดี')
    expect(decodeURIComponent(thai.headers.get('content-disposition')!.split("filename*=UTF-8''")[1])).toBe('รายงาน ประจำปี.txt')
    const z64 = await file(owner, '/zip64.zip', 'one.txt')
    expect(new TextDecoder().decode((await bodyOf(z64))!)).toBe('zip64 entry')
  })

  test('only images, PDF and plain text may open in the tab, and only when asked; the rest downloads', async () => {
    const png = await file(owner, '/main.zip', 'pic.png', { inline: '1' })
    expect(png.headers.get('content-disposition')).toStartWith('inline;')
    expect(png.headers.get('content-type')).toBe('image/png')
    expect(png.headers.get('content-security-policy')).toContain('sandbox')
    expect(await bodyOf(png)).toEqual(PNG_BYTES)
    expect((await file(owner, '/main.zip', 'pic.png')).headers.get('content-disposition')).toStartWith('attachment;')
    const txt = await file(owner, '/main.zip', 'note.txt', { inline: '1' })
    expect(txt.headers.get('content-disposition')).toStartWith('inline;')
    expect(txt.headers.get('content-type')).toStartWith('text/plain')
    for (const name of ['page.html', 'icon.svg', 'big.bin']) {
      const r = await file(owner, '/main.zip', name, { inline: '1' })
      expect([name, r.headers.get('content-disposition')!.startsWith('attachment;')]).toEqual([name, true])
      expect(r.headers.get('content-security-policy')).toContain('sandbox')
      expect(r.headers.get('content-type')).not.toContain('html')
      await bodyOf(r)
    }
    // text that is not asked to be shown is not sent as text either
    expect((await file(owner, '/main.zip', 'note.txt')).headers.get('content-type')).toBe('application/octet-stream')
  })

  test('names that could leave a folder are refused, whether or not the zip has an entry of that name', async () => {
    for (const entry of ['../evil.txt', 'a/../../b.txt', '/abs.txt', 'x\\y.txt', '..', 'C:/x.txt', 'ok/../../x']) {
      const r = await owner.json('GET', `/api/archive/file?${q({ space: 'home', path: '/evil.zip', entry })}`)
      expect([entry, r.status, r.data.code]).toEqual([entry, 400, 'archive.bad-entry'])
    }
    const nul = await owner.json('GET', `/api/archive/file?space=home&path=/evil.zip&entry=ok.txt%00`)
    expect([nul.status, nul.data.code]).toEqual([400, 'archive.bad-entry'])
    expect((await owner.json('GET', `/api/archive/file?${q({ space: 'home', path: '/evil.zip', entry: '' })}`)).status).toBe(400)
    // the archive can still be looked into: the names are shown, they are only never taken out
    expect((await list(owner, '/evil.zip')).data.entries.map((e: any) => e.name)).toContain('../evil.txt')
    // a harmless name of the same zip still works
    expect(new TextDecoder().decode((await bodyOf(await file(owner, '/evil.zip', 'ok.txt')))!)).toBe('ok')
  })

  test('a folder entry or a name that is not there is 404; an entry without a name is a bad request', async () => {
    expect((await owner.json('GET', `/api/archive/file?${q({ space: 'home', path: '/main.zip', entry: 'เอกสาร/' })}`)).data.code).toBe('archive.entry-not-found')
    expect((await owner.json('GET', `/api/archive/file?${q({ space: 'home', path: '/main.zip', entry: 'none.txt' })}`)).status).toBe(404)
    expect((await owner.json('GET', `/api/archive/file?${q({ space: 'home', path: '/main.zip' })}`)).status).toBe(422)
    const bad = await owner.json('GET', `/api/archive/file?${q({ space: 'home', path: '/plain.txt', entry: 'a' })}`)
    expect([bad.status, bad.data.code]).toEqual([400, 'archive.not-zip'])
  })

  test('an encrypted entry is 422 archive.encrypted; the others of that zip open', async () => {
    const r = await owner.json('GET', `/api/archive/file?${q({ space: 'home', path: '/crypt.zip', entry: 'secret.txt' })}`)
    expect([r.status, r.data.code]).toEqual([422, 'archive.encrypted'])
    expect(new TextDecoder().decode((await bodyOf(await file(owner, '/crypt.zip', 'open.txt')))!)).toBe('open')
  })
})

describe('zip bombs', () => {
  test('more than 100 MB packed tighter than 100:1 is 413 archive.too-big before a byte is unpacked', async () => {
    const r = await owner.json('GET', `/api/archive/file?${q({ space: 'home', path: '/bomb.zip', entry: 'bomb.bin' })}`)
    expect([r.status, r.data.code]).toEqual([413, 'archive.too-big'])
    // the small entry of the same zip is fine
    expect(new TextDecoder().decode((await bodyOf(await file(owner, '/bomb.zip', 'small.txt')))!)).toBe('fine')
    // the list is only the central directory: no unpacking
    const l = await list(owner, '/bomb.zip')
    expect(l.status).toBe(200)
  })

  test('an entry that says it is bigger than UPLOAD_MAX_SIZE is refused', async () => {
    const was = config.uploadMaxSize
    config.uploadMaxSize = 2000
    try {
      const r = await owner.json('GET', `/api/archive/file?${q({ space: 'home', path: '/sizes.zip', entry: 'five-k.bin' })}`)
      expect([r.status, r.data.code]).toEqual([413, 'archive.too-big'])
      expect((await bodyOf(await file(owner, '/sizes.zip', 'one-k.bin')))!.length).toBe(1000)
    } finally { config.uploadMaxSize = was }
  })

  test('a header that lies about the size does not get more bytes out than it declared', async () => {
    for (const name of ['/lie.zip', '/lie-stored.zip']) {
      const r = await file(owner, name, 'lie.bin')
      const body = r.status === 200 ? await bodyOf(r) : null
      // refused outright, or cut off: never the 100,000 bytes
      expect([name, body === null || body.length <= 1000]).toEqual([name, true])
    }
  })
})

describe('who may', () => {
  test('a visitor, a user without download, and another user are refused', async () => {
    expect((await list(anon, '/main.zip')).status).toBe(401)
    expect((await file(anon, '/main.zip', 'readme.txt')).status).toBe(401)
    const noDl = await userWith('ar-nodl', ['read'])
    writeFileSync(home('ar-nodl', 'mine.zip'), zipSync({ 'a.txt': enc('a') }))
    expect((await list(noDl, '/mine.zip')).status).toBe(403)
    expect((await file(noDl, '/mine.zip', 'a.txt')).status).toBe(403)
    const noRead = await userWith('ar-noread', ['download'])
    expect((await list(noRead, '/mine.zip')).status).toBe(403)
    const other = await userWith('ar-other', ['read', 'download'])
    expect((await list(other, '/main.zip')).status).toBe(404)
    expect((await other.raw('GET', `/api/archive/file?${q({ space: 'user:ar-owner', path: '/main.zip', entry: 'readme.txt' })}`)).status).toBe(403)
  })

  test('taking an entry out is on the activity trail like a download, once a minute per entry', async () => {
    await bodyOf(await file(owner, '/main.zip', 'readme.txt'))
    await bodyOf(await file(owner, '/main.zip', 'readme.txt'))
    const lines = [...audit.auditEntries()].filter(e => e.user === 'ar-owner' && e.action === 'download' && (e.detail ?? '').includes('readme.txt'))
    expect(lines.length).toBe(1)
    expect(lines[0].target).toBe('/users/ar-owner/main.zip')
    expect(lines[0].detail).toContain('ในไฟล์ zip')
  })

  test('staff looking into a managed user leave a line in the trail', async () => {
    const r = await admin.json('GET', `/api/archive/list?${q({ space: 'user:ar-owner', path: '/main.zip' })}`)
    expect(r.status).toBe(200)
    expect([...audit.auditEntries()].some(e => e.user === 'admin' && e.action === 'browse' && e.target === '/users/ar-owner/main.zip')).toBe(true)
    await bodyOf(await admin.raw('GET', `/api/archive/file?${q({ space: 'user:ar-owner', path: '/main.zip', entry: 'note.txt' })}`))
    expect([...audit.auditEntries()].some(e => e.user === 'admin' && e.action === 'download' && (e.detail ?? '').includes('user:ar-owner'))).toBe(true)
  })
})

describe('folder links', () => {
  const shareOf = async (body: Record<string, unknown>) => (await owner.json('POST', '/api/shares', { space: 'home', days: 7, ...body })).data
  const sList = (token: string, path?: string, headers: Record<string, string> = {}) => anon.json('GET', `/api/s/${token}/archive/list${path === undefined ? '' : '?' + q({ path })}`, undefined, headers)
  const sFile = (token: string, path: string | undefined, entry: string, headers: Record<string, string> = {}) =>
    anon.raw('GET', `/api/s/${token}/archive/file?${q({ ...(path === undefined ? {} : { path }), entry })}`, undefined, headers)

  test('inside the shared folder the zip can be looked into and an entry taken, and nothing outside it', async () => {
    const { token, share } = await shareOf({ path: '/proj' })
    const l = await sList(token, '/in.zip')
    expect(l.status).toBe(200)
    expect(l.data.entries.map((e: any) => e.name)).toEqual(['inside.txt'])
    const f = await sFile(token, '/in.zip', 'inside.txt')
    expect(f.status).toBe(200)
    expect(new TextDecoder().decode((await bodyOf(f))!)).toBe('inside the share')
    expect(f.headers.get('content-security-policy')).toContain('sandbox')
    // out of the folder: by "..", through a link inside it, a file that is no zip, a missing one
    expect((await sList(token, '/../outside/o.zip')).status).toBe(400)
    expect([403, 404]).toContain((await sList(token, '/link.zip')).status)
    expect((await sFile(token, '/../outside/o.zip', 'o.txt')).status).toBe(400)
    expect((await sList(token, '/sub.txt')).data.code).toBe('archive.not-zip')
    expect((await sList(token, '/nope.zip')).status).toBe(404)
    expect((await sFile(token, '/in.zip', '../x')).status).toBe(400)
    // taking an entry out is a download of the link
    const mine = await owner.json('GET', '/api/shares')
    expect(mine.data.shares.find((s: any) => s.id === share.id).downloads).toBe(1)
    await owner.json('DELETE', `/api/shares/${share.id}`)
    expect((await sList(token, '/in.zip')).status).toBe(404)
  })

  test('a link with a download limit counts each entry, and stops at the limit', async () => {
    const { token } = await shareOf({ path: '/proj', maxDownloads: 1 })
    expect((await sList(token, '/in.zip')).status).toBe(200)
    expect(await bodyOf(await sFile(token, '/in.zip', 'inside.txt'))).not.toBeNull()
    expect((await sFile(token, '/in.zip', 'inside.txt')).status).toBe(404)
    expect((await sList(token, '/in.zip')).status).toBe(404)
  })

  test('a link with a password, an upload link, a link to a single zip and a made-up token', async () => {
    const locked = await shareOf({ path: '/proj', password: 'secret-pass-1' })
    expect((await sList(locked.token, '/in.zip')).status).toBe(401)
    const unlock = await anon.raw('POST', `/api/s/${locked.token}/unlock`, { password: 'secret-pass-1' })
    const cookie = unlock.headers.get('set-cookie')!.split(';')[0]
    expect((await sList(locked.token, '/in.zip', { cookie })).status).toBe(200)
    expect((await sFile(locked.token, '/in.zip', 'inside.txt', { cookie })).status).toBe(200)

    const up = await shareOf({ path: '/proj', kind: 'upload' })
    expect((await sList(up.token, '/in.zip')).status).toBe(404)

    const single = await shareOf({ path: '/proj/in.zip' })
    expect((await sList(single.token)).data.entries.length).toBe(1)
    expect((await sList(single.token, '/other.zip')).status).toBe(404)
    expect((await sFile(single.token, undefined, 'inside.txt')).status).toBe(200)

    expect((await sList('a'.repeat(43), '/in.zip')).status).toBe(404)
  })
})

/** a zip that is only an end record: it says what it says about its central directory, and holds none of it */
function eocdOnly(entries: number, dirBytes: number, zip64 = false): Uint8Array {
  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true)
  if (!zip64) {
    eocd.setUint16(10, entries, true)
    eocd.setUint32(12, dirBytes, true)
    return new Uint8Array(eocd.buffer)
  }
  eocd.setUint16(8, 0xffff, true); eocd.setUint16(10, 0xffff, true)
  eocd.setUint32(12, 0xffffffff, true); eocd.setUint32(16, 0xffffffff, true)
  const rec = new DataView(new ArrayBuffer(56))
  rec.setUint32(0, 0x06064b50, true); rec.setBigUint64(4, 44n, true)
  rec.setBigUint64(24, BigInt(entries), true); rec.setBigUint64(32, BigInt(entries), true); rec.setBigUint64(40, BigInt(dirBytes), true)
  const loc = new DataView(new ArrayBuffer(20))
  loc.setUint32(0, 0x07064b50, true); loc.setBigUint64(8, 4n, true); loc.setUint32(16, 1, true)
  return new Uint8Array([0x50, 0x4b, 3, 4, ...new Uint8Array(rec.buffer), ...new Uint8Array(loc.buffer), ...new Uint8Array(eocd.buffer)])
}

describe('a central directory that is too big is refused unread', () => {
  const GB = 1024 ** 3
  test('the end record says 1 GB (plain, with a comment after it, and ZIP64): 413 archive.directory-too-big', async () => {
    writeFileSync(home('ar-owner', 'huge.zip'), eocdOnly(10, GB))
    const withComment = eocdOnly(10, GB)
    withComment.set([30, 0], 20) // comment length
    writeFileSync(home('ar-owner', 'huge-comment.zip'), new Uint8Array([...withComment, ...new Uint8Array(30).fill(65)]))
    writeFileSync(home('ar-owner', 'huge64.zip'), eocdOnly(10, 2 * GB, true))
    writeFileSync(home('ar-owner', 'proj', 'huge.zip'), eocdOnly(10, GB))
    for (const name of ['/huge.zip', '/huge-comment.zip', '/huge64.zip']) {
      const l = await list(owner, name)
      expect([name, l.status, l.data.code]).toEqual([name, 413, 'archive.directory-too-big'])
      const f = await file(owner, name, 'a.txt')
      expect([name, f.status]).toEqual([name, 413])
    }
    const { token } = (await owner.json('POST', '/api/shares', { space: 'home', days: 7, path: '/proj' })).data
    expect((await anon.json('GET', `/api/s/${token}/archive/list?${q({ path: '/huge.zip' })}`)).status).toBe(413)
    expect((await anon.raw('GET', `/api/s/${token}/archive/file?${q({ path: '/huge.zip', entry: 'a.txt' })}`)).status).toBe(413)
  })

  test('more than 100,000 entries are refused, 100,000 are not', async () => {
    writeFileSync(home('ar-owner', 'count.zip'), eocdOnly(100_001, 1000, true))
    const l = await list(owner, '/count.zip')
    expect([l.status, l.data.code]).toEqual([413, 'archive.directory-too-big'])
    writeFileSync(home('ar-owner', 'small-count.zip'), eocdOnly(100_000, 1000, true))
    // past the size check: zip.js finds no directory there and says not-zip
    expect((await list(owner, '/small-count.zip')).data.code).toBe('archive.not-zip')
  })

  test('a normal ZIP64 file still works', async () => {
    const z = await list(owner, '/zip64.zip')
    expect(z.status).toBe(200)
    expect(z.data.entries.length).toBe(2)
  })
})

describe('only a few archives are opened at a time', () => {
  test('the ones past the limit wait outside: 503 archive.busy with Retry-After, and the places come back', async () => {
    const results = await Promise.all(Array.from({ length: 14 }, () => owner.raw('GET', `/api/archive/list?${q({ space: 'home', path: '/many.zip' })}`)))
    const codes = results.map(r => r.status)
    expect(codes.filter(c => c === 200).length).toBeGreaterThan(0)
    const busy = results.filter(r => r.status === 503)
    expect(busy.length).toBeGreaterThan(0)
    expect(busy[0].headers.get('retry-after')).toBeTruthy()
    expect((await busy[0].json()).code).toBe('archive.busy')
    expect(codes.every(c => c === 200 || c === 503)).toBe(true)
    expect((await import('../src/archive')).archiveBusy()).toBe(0)
    expect((await list(owner, '/main.zip')).status).toBe(200)
  })
})

describe('extracting a zip with password-protected files', () => {
  test('is refused before anything is written, naming how many files are locked', async () => {
    const u = await userWith('ar-unzip', ['read', 'write', 'download', 'zip', 'upload'])
    mkdirSync(home('ar-unzip'), { recursive: true })
    writeFileSync(home('ar-unzip', 'locked.zip'), await zipJs([{ name: 'secret.txt', data: 'top secret', password: 'pw' }, { name: 'open.txt', data: 'open' }]))
    const r = await u.json('POST', '/api/unzip', { space: 'home', path: '/locked.zip' })
    expect(r.status).toBe(400)
    expect(r.data.code).toBe('zip.encrypted')
    expect(r.data.params).toEqual({ n: 1, name: 'secret.txt' })
    expect(readdirSync(home('ar-unzip')).sort()).toEqual(['locked.zip'])
    rmSync(home('ar-unzip'), { recursive: true, force: true })
  })
})
