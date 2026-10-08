import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { unzipSync, zipSync } from 'fflate'

const base = mkdtempSync(join(tmpdir(), 'fc-test-'))
process.env.STORAGE_DIR = join(base, 'storage')
process.env.DATA_DIR = join(base, 'data')
process.env.ADMIN_PASSWORD = 'test-admin-pass'
process.env.UPLOAD_CHUNK_SIZE = String(1024 * 1024) // 1 MB chunks keep the test fast
process.env.LOGIN_MAX_ATTEMPTS = '3'

let app: any
class Client {
  cookie = ''
  csrf = ''
  async raw(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers }
    if (this.cookie) h.cookie = this.cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    let payload: any = body
    if (body !== undefined && !(body instanceof ArrayBuffer) && !(body instanceof Uint8Array) && typeof body !== 'string') {
      payload = JSON.stringify(body)
      h['content-type'] = 'application/json'
    }
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: payload }))
    const set = res.headers.get('set-cookie')
    if (set) this.cookie = set.split(';')[0]
    return res
  }
  async json(method: string, path: string, body?: any) {
    const res = await this.raw(method, path, body)
    const data = await res.json().catch(() => null)
    return { status: res.status, data }
  }
  async start() {
    const r = await this.json('GET', '/api/session')
    this.csrf = r.data.csrf
    return r.data
  }
  async login(u: string, p: string) {
    const r = await this.json('POST', '/api/login', { username: u, password: p })
    if (r.status === 200) this.csrf = r.data.csrf
    return r
  }
}

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
})

const admin = new Client()
const guest = new Client()

describe('session & auth', () => {
  test('anonymous session exposes only the public space', async () => {
    const s = await guest.start()
    expect(s.user).toBeNull()
    expect(Object.keys(s.spaces)).toEqual(['public'])
    expect(s.spaces.public).toContain('download')
    expect(s.spaces.public).not.toContain('write')
  })
  test('mutations need the CSRF token', async () => {
    const c = new Client()
    await c.start()
    c.csrf = 'wrong'
    const r = await c.json('POST', '/api/login', { username: 'admin', password: 'x' })
    expect(r.status).toBe(403)
    expect(r.data.code).toBe('csrf')
  })
  test('visitor sessions are not written to disk', async () => {
    const { readFileSync } = await import('node:fs')
    const before = readFileSync(join(process.env.DATA_DIR!, 'sessions.json'), 'utf8')
    for (let i = 0; i < 5; i++) await new Client().start()
    expect(readFileSync(join(process.env.DATA_DIR!, 'sessions.json'), 'utf8')).toBe(before)
  })
  test('wrong password, lockout, then success', async () => {
    const c = new Client()
    await c.start()
    for (let i = 0; i < 3; i++) expect((await c.login('ghost', 'nope')).status).toBe(401)
    expect((await c.login('ghost', 'nope')).status).toBe(429)
    // another account from the same address is not affected
    expect((await c.login('admin', 'wrong')).status).toBe(401)
  })
  test('admin logs in', async () => {
    await admin.start()
    const r = await admin.login('admin', 'test-admin-pass')
    expect(r.status).toBe(200)
    expect(r.data.user.role).toBe('admin')
    expect(Object.keys(r.data.spaces).sort()).toEqual(['home', 'public'])
  })
  test('unauthenticated admin API is refused', async () => {
    expect((await guest.json('GET', '/api/admin/users')).status).toBe(401)
  })
})

describe('files', () => {
  test('mkdir, newfile, edit, read, list', async () => {
    expect((await admin.json('POST', '/api/mkdir', { space: 'home', path: '/', name: 'docs' })).status).toBe(200)
    expect((await admin.json('POST', '/api/mkdir', { space: 'home', path: '/', name: 'docs' })).status).toBe(409)
    expect((await admin.json('POST', '/api/newfile', { space: 'home', path: '/docs', name: 'a.txt' })).status).toBe(200)
    expect((await admin.json('PUT', '/api/content', { space: 'home', path: '/docs/a.txt', content: 'สวัสดี hello' })).status).toBe(200)
    expect((await admin.json('GET', '/api/content?space=home&path=/docs/a.txt')).data.content).toBe('สวัสดี hello')
    const list = await admin.json('GET', '/api/list?space=home&path=/docs')
    expect(list.data.entries.map((e: any) => e.name)).toEqual(['a.txt'])
    expect(list.data.entries[0].size).toBeGreaterThan(0)
  })
  test('rejects traversal and bad names', async () => {
    expect((await admin.json('GET', '/api/list?space=home&path=/../..')).status).toBe(400)
    expect((await admin.json('POST', '/api/mkdir', { space: 'home', path: '/', name: '../x' })).status).toBe(400)
    expect((await admin.json('POST', '/api/mkdir', { space: 'home', path: '/', name: 'a:b' })).status).toBe(400)
  })
  test('symlink pointing outside the storage is not followed', async () => {
    const outside = join(base, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(outside, join(process.env.STORAGE_DIR!, 'docs', 'link'))
    const list = await admin.json('GET', '/api/list?space=home&path=/docs')
    expect(list.data.entries.map((e: any) => e.name)).not.toContain('link')
    expect((await admin.json('GET', '/api/list?space=home&path=/docs/link')).status).toBe(403)
    expect((await admin.raw('GET', '/api/download?space=home&path=/docs/link/secret.txt')).status).toBe(403)
  })
  test('rename, copy, move', async () => {
    expect((await admin.json('POST', '/api/rename', { space: 'home', path: '/docs/a.txt', name: 'b.txt' })).status).toBe(200)
    expect((await admin.json('POST', '/api/mkdir', { space: 'home', path: '/', name: 'other' })).status).toBe(200)
    const cp = await admin.json('POST', '/api/copy', { space: 'home', items: ['/docs/b.txt'], dest: '/other' })
    expect(cp.data.done).toBe(1)
    const cp2 = await admin.json('POST', '/api/copy', { space: 'home', items: ['/docs/b.txt'], dest: '/other' })
    expect(cp2.data.done).toBe(1) // becomes "b (1).txt"
    const mv = await admin.json('POST', '/api/move', { space: 'home', items: ['/other/b.txt'], dest: '/' })
    expect(mv.data.done).toBe(1)
    const bad = await admin.json('POST', '/api/move', { space: 'home', items: ['/docs'], dest: '/docs' })
    expect(bad.data.failed.length).toBe(1)
  })
  test('search finds files in sub folders', async () => {
    const r = await admin.json('GET', '/api/search?space=home&q=b%20(1)')
    expect(r.data.results.map((e: any) => e.name)).toContain('b (1).txt')
  })
  test('delete goes to trash and can be restored', async () => {
    const del = await admin.json('POST', '/api/delete', { space: 'home', items: ['/b.txt'] })
    expect(del.data.done).toBe(1)
    const trash = await admin.json('GET', '/api/admin/trash')
    expect(trash.data.items.length).toBe(1)
    expect(trash.data.items[0].originalPath).toBe('/b.txt')
    const res = await admin.json('POST', '/api/admin/trash/restore', { id: trash.data.items[0].id })
    expect(res.data.restoredTo).toBe('/b.txt')
    expect((await admin.json('GET', '/api/admin/trash')).data.items.length).toBe(0)
  })
})

describe('upload & download', () => {
  const size = 3 * 1024 * 1024 + 12345 // 4 chunks of 1 MB
  const data = randomBytes(size)
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

  test('chunked upload (out of order) rebuilds the exact file', async () => {
    const init = await admin.json('POST', '/api/upload', { space: 'home', path: '/docs', name: 'big.bin', size, relativeDir: 'sub/inner' })
    expect(init.status).toBe(200)
    const { id, chunkSize, total } = init.data
    expect(total).toBe(4)
    // wrong chunk size is refused
    expect((await admin.json('PUT', `/api/upload/${id}/0`, new Uint8Array(10))).status).toBe(400)
    for (const i of [2, 0, 3, 1]) {
      const part = data.subarray(i * chunkSize, Math.min(size, (i + 1) * chunkSize))
      const res = await admin.raw('PUT', `/api/upload/${id}/${i}`, part, { 'content-type': 'application/octet-stream' })
      expect(res.status).toBe(200)
    }
    const status = await admin.json('GET', `/api/upload/${id}`)
    expect(status.data.received).toEqual([0, 1, 2, 3])
    const done = await admin.json('POST', `/api/upload/${id}/complete`)
    expect(done.data.size).toBe(size)

    const res = await admin.raw('GET', '/api/download?space=home&path=/docs/sub/inner/big.bin')
    expect(res.status).toBe(200)
    expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(sha(data))
  })
  test('same name is not overwritten', async () => {
    const init = await admin.json('POST', '/api/upload', { space: 'home', path: '/docs/sub/inner', name: 'big.bin', size: 5 })
    await admin.raw('PUT', `/api/upload/${init.data.id}/0`, new Uint8Array([1, 2, 3, 4, 5]), { 'content-type': 'application/octet-stream' })
    await admin.json('POST', `/api/upload/${init.data.id}/complete`)
    const list = await admin.json('GET', '/api/list?space=home&path=/docs/sub/inner')
    expect(list.data.entries.map((e: any) => e.name).sort()).toEqual(['big (1).bin', 'big.bin'])
  })
  test('range requests', async () => {
    const res = await admin.raw('GET', '/api/download?space=home&path=/docs/sub/inner/big.bin', undefined, { range: 'bytes=100-199' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 100-199/${size}`)
    expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(sha(data.subarray(100, 200)))
  })
  test('thai file names download with a proper header', async () => {
    await admin.json('POST', '/api/newfile', { space: 'home', path: '/', name: 'รายงาน.txt' })
    const res = await admin.raw('GET', '/api/download?space=home&path=/รายงาน.txt'.replace('รายงาน.txt', encodeURIComponent('รายงาน.txt')))
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''%E0%B8%A3")
  })
  test('html is always an attachment (no stored XSS)', async () => {
    await admin.json('POST', '/api/newfile', { space: 'home', path: '/', name: 'x.html' })
    const res = await admin.raw('GET', '/api/download?space=home&path=/x.html&inline=1')
    expect(res.headers.get('content-disposition')).toStartWith('attachment')
  })
})

describe('zip', () => {
  test('zip then unzip round trip + batch download', async () => {
    const z = await admin.json('POST', '/api/zip', { space: 'home', path: '/', items: ['docs'], name: 'docs' })
    expect(z.data.name).toBe('docs.zip')
    const u = await admin.json('POST', '/api/unzip', { space: 'home', path: '/docs.zip' })
    expect(u.status).toBe(200)
    expect(u.data.files).toBeGreaterThan(0)
    const list = await admin.json('GET', '/api/list?space=home&path=/docs (1)/docs/sub/inner'.replace(/ /g, '%20'))
    expect(list.status).toBe(200)

    const b = await admin.json('POST', '/api/batch', { space: 'home', path: '/', items: ['docs'] })
    const res = await admin.raw('GET', `/api/batch/${b.data.token}`)
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()))
    expect(Object.keys(files)).toContain('docs/sub/inner/big.bin')
    expect(files['docs/sub/inner/big.bin'].length).toBe(3 * 1024 * 1024 + 12345)
  })
  test('zip-slip archive is rejected', async () => {
    const evil = zipSync({ '../../evil.txt': new Uint8Array([1]) })
    writeFileSync(join(process.env.STORAGE_DIR!, 'evil.zip'), evil)
    const u = await admin.json('POST', '/api/unzip', { space: 'home', path: '/evil.zip' })
    expect(u.status).toBe(400)
  })
})

describe('users & permissions', () => {
  const user = new Client()
  test('admin creates a user with their own folder', async () => {
    const c = await admin.json('POST', '/api/admin/users', {
      username: 'somchai', name: 'สมชาย', password: 'password123', role: 'user',
      permissions: ['read', 'write', 'upload', 'download'], publicPermissions: ['read', 'download', 'upload'],
    })
    expect(c.status).toBe(200)
    expect((await admin.json('POST', '/api/admin/users', { username: 'somchai', name: 'x', password: 'password123', role: 'user', permissions: [], publicPermissions: [] })).status).toBe(409)
    expect((await admin.json('POST', '/api/admin/users', { username: 'shortpw', name: 'x', password: '123', role: 'user', permissions: [], publicPermissions: [] })).status).toBe(400)
  })
  test('user sees only their folder and cannot escape', async () => {
    await user.start()
    expect((await user.login('somchai', 'password123')).status).toBe(200)
    expect((await user.json('POST', '/api/mkdir', { space: 'home', path: '/', name: 'mine' })).status).toBe(200)
    const list = await user.json('GET', '/api/list?space=home&path=/')
    expect(list.data.entries.map((e: any) => e.name)).toEqual(['mine'])
    expect((await user.json('GET', '/api/list?space=home&path=/../..')).status).toBe(400)
    expect((await user.json('GET', '/api/admin/users')).status).toBe(403)
    expect((await user.json('POST', '/api/zip', { space: 'home', path: '/', items: ['mine'] })).status).toBe(403)
  })
  test('user can upload to the public folder but not delete there', async () => {
    const init = await user.json('POST', '/api/upload', { space: 'public', path: '/', name: 'hi.txt', size: 2 })
    expect(init.status).toBe(200)
    await user.raw('PUT', `/api/upload/${init.data.id}/0`, new Uint8Array([104, 105]), { 'content-type': 'application/octet-stream' })
    expect((await user.json('POST', `/api/upload/${init.data.id}/complete`)).status).toBe(200)
    expect((await user.json('POST', '/api/delete', { space: 'public', items: ['/hi.txt'] })).status).toBe(403)
  })
  test('visitor can download from public but not upload or see home', async () => {
    const dl = await guest.raw('GET', '/api/download?space=public&path=/hi.txt')
    expect(dl.status).toBe(200)
    expect(await dl.text()).toBe('hi')
    expect((await guest.json('POST', '/api/upload', { space: 'public', path: '/', name: 'x', size: 1 })).status).toBe(401)
    expect((await guest.json('GET', '/api/list?space=home&path=/')).status).toBe(401)
  })
  test('upload ids belong to their owner', async () => {
    const init = await user.json('POST', '/api/upload', { space: 'home', path: '/', name: 'p.txt', size: 1 })
    expect((await admin.json('GET', `/api/upload/${init.data.id}`)).status).toBe(403)
  })
  test('closing public access hides the folder from visitors', async () => {
    await admin.json('PUT', '/api/admin/settings', { publicEnabled: false })
    expect((await guest.json('GET', '/api/list?space=public&path=/')).status).toBe(401)
    await admin.json('PUT', '/api/admin/settings', { publicEnabled: true })
  })
  test('cannot delete the last admin or yourself', async () => {
    expect((await admin.json('DELETE', '/api/admin/users/admin')).status).toBe(400)
  })
  test('password change invalidates other sessions', async () => {
    const other = new Client()
    await other.start()
    await other.login('somchai', 'password123')
    expect((await user.json('POST', '/api/password', { current: 'password123', next: 'new-password-456' })).status).toBe(200)
    expect((await other.json('GET', '/api/list?space=home&path=/')).status).toBe(401)
    expect((await user.json('GET', '/api/list?space=home&path=/')).status).toBe(200)
  })
})

describe('proxy & disk space', () => {
  const failLogin = (c: Client, username: string, headers: Record<string, string>) =>
    c.raw('POST', '/api/login', { username, password: 'nope' }, headers).then(r => r.status)

  test('behind a proxy a faked X-Forwarded-For does not dodge the lockout', async () => {
    const { config } = await import('../src/config')
    const c = new Client()
    await c.start()
    config.trustProxy = 'true'
    try {
      // the client controls the first entries, the proxy appends the real address last
      for (let i = 0; i < 3; i++) expect(await failLogin(c, 'proxied', { 'x-forwarded-for': `10.0.0.${i}, 198.51.100.7` })).toBe(401)
      expect(await failLogin(c, 'proxied', { 'x-forwarded-for': '10.0.0.99, 198.51.100.7' })).toBe(429)
    } finally {
      config.trustProxy = 'false'
    }
  })
  test('with Cloudflare the address comes from CF-Connecting-IP', async () => {
    const { config } = await import('../src/config')
    const c = new Client()
    await c.start()
    config.trustProxy = 'cloudflare'
    try {
      for (let i = 0; i < 3; i++) {
        expect(await failLogin(c, 'tunneled', { 'cf-connecting-ip': '203.0.113.5', 'x-forwarded-for': `10.1.0.${i}` })).toBe(401)
      }
      expect(await failLogin(c, 'tunneled', { 'cf-connecting-ip': '203.0.113.5', 'x-forwarded-for': '10.1.0.99' })).toBe(429)
    } finally {
      config.trustProxy = 'false'
    }
    const act = await admin.json('GET', '/api/admin/activity?action=login-failed&q=tunneled')
    expect(act.data.items[0].ip).toBe('203.0.113.5')
  })
  test('uploads are refused when the disk would run too low', async () => {
    const { config } = await import('../src/config')
    const keep = config.minFreeSpace
    const init = await admin.json('POST', '/api/upload', { space: 'home', path: '/', name: 'reserve.bin', size: 4 })
    expect(init.status).toBe(200)
    config.minFreeSpace = Number.MAX_SAFE_INTEGER
    try {
      const r = await admin.json('POST', '/api/upload', { space: 'home', path: '/', name: 'reserve.bin', size: 4 })
      expect(r.status).toBe(507)
      expect(r.data.code).toBe('disk-full')
      // an upload that was already announced is stopped at its next chunk too
      expect((await admin.raw('PUT', `/api/upload/${init.data.id}/0`, new Uint8Array(4), { 'content-type': 'application/octet-stream' })).status).toBe(507)
    } finally {
      config.minFreeSpace = keep
    }
  })
  test('completing an upload moves the file instead of copying it', async () => {
    const { readdirSync } = await import('node:fs')
    const init = await admin.json('POST', '/api/upload', { space: 'home', path: '/', name: 'moved.bin', size: 4 })
    await admin.raw('PUT', `/api/upload/${init.data.id}/0`, new Uint8Array([9, 8, 7, 6]), { 'content-type': 'application/octet-stream' })
    expect((await admin.json('POST', `/api/upload/${init.data.id}/complete`)).status).toBe(200)
    expect(readdirSync(join(process.env.DATA_DIR!, 'tmp'))).not.toContain(init.data.id)
    const res = await admin.raw('GET', '/api/download?space=home&path=/moved.bin')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([9, 8, 7, 6])
  })
})

describe('regressions found in QA', () => {
  const storage = () => process.env.STORAGE_DIR!
  const write = (c: Client, path: string, content: string) => c.json('PUT', '/api/content', { space: 'home', path, content })
  const read = async (c: Client, path: string) =>
    (await c.json('GET', `/api/content?space=home&path=${encodeURIComponent(path)}`)).data?.content
  const names = async (c: Client, space: string, path: string) =>
    (await c.json('GET', `/api/list?space=${space}&path=${encodeURIComponent(path)}`)).data.entries.map((e: any) => e.name).sort()

  test('renaming to a name that differs only in case never overwrites another file', async () => {
    await admin.json('POST', '/api/mkdir', { space: 'home', path: '/', name: 'case' })
    for (const [name, text] of [['note.txt', 'lower'], ['NOTE.txt', 'upper']]) {
      await admin.json('POST', '/api/newfile', { space: 'home', path: '/case', name })
      await write(admin, `/case/${name}`, text)
    }
    expect((await admin.json('POST', '/api/rename', { space: 'home', path: '/case/note.txt', name: 'NOTE.txt' })).status).toBe(409)
    expect(await read(admin, '/case/NOTE.txt')).toBe('upper')
    expect(await read(admin, '/case/note.txt')).toBe('lower')
    // changing only the case of a name is still fine
    expect((await admin.json('POST', '/api/rename', { space: 'home', path: '/case/note.txt', name: 'Note.txt' })).status).toBe(200)
    expect(await read(admin, '/case/Note.txt')).toBe('lower')
  })
  test('the /public and /users system folders can not be deleted, moved or renamed', async () => {
    await admin.json('POST', '/api/mkdir', { space: 'home', path: '/', name: 'holder' })
    const del = await admin.json('POST', '/api/delete', { space: 'home', items: ['/public', '/users'] })
    expect(del.data.done).toBe(0)
    expect(del.data.failed.length).toBe(2)
    expect((await admin.json('POST', '/api/rename', { space: 'home', path: '/public', name: 'pub2' })).status).toBe(403)
    expect((await admin.json('POST', '/api/move', { space: 'home', items: ['/users'], dest: '/holder' })).data.done).toBe(0)
    expect((await guest.json('GET', '/api/list?space=public&path=/')).status).toBe(200)
    // copying them is harmless and still allowed
    expect((await admin.json('POST', '/api/copy', { space: 'home', items: ['/public'], dest: '/holder' })).data.done).toBe(1)
  })
  test('a user who must change their password can do nothing else first', async () => {
    const { findUser } = await import('../src/auth')
    await admin.json('POST', '/api/admin/users', {
      username: 'newbie', name: 'มือใหม่', password: 'first-pass-1', role: 'user', permissions: ['read'], publicPermissions: [],
    })
    findUser('newbie')!.mustChangePassword = true
    const c = new Client()
    await c.start()
    expect((await c.login('newbie', 'first-pass-1')).status).toBe(200)
    const blocked = await c.json('GET', '/api/list?space=home&path=/')
    expect(blocked.status).toBe(403)
    expect(blocked.data.code).toBe('must-change-password')
    expect((await c.json('GET', '/api/session')).status).toBe(200)
    expect((await c.json('POST', '/api/password', { current: 'first-pass-1', next: 'second-pass-2' })).status).toBe(200)
    expect((await c.json('GET', '/api/list?space=home&path=/')).status).toBe(200)
  })
  test('a failed unzip leaves nothing behind, not even in the trash', async () => {
    const { config } = await import('../src/config')
    const keep = config.unzipMaxBytes
    config.unzipMaxBytes = 1000
    try {
      writeFileSync(join(storage(), 'toobig.zip'), zipSync({ 'a.bin': new Uint8Array(5000) }))
      const before = (await admin.json('GET', '/api/admin/trash')).data.items.length
      expect((await admin.json('POST', '/api/unzip', { space: 'home', path: '/toobig.zip' })).status).toBe(400)
      expect((await admin.json('GET', '/api/admin/trash')).data.items.length).toBe(before)
      expect(await names(admin, 'home', '/')).not.toContain('toobig')
    } finally {
      config.unzipMaxBytes = keep
    }
  })
  test('unzip cleans unsafe entry names and limits the number of files', async () => {
    const { config } = await import('../src/config')
    writeFileSync(join(storage(), 'names.zip'), zipSync({
      'bad:name?.txt': new Uint8Array([1]), 'ctl\u0001x.txt': new Uint8Array([2]), 'ok/fine.txt': new Uint8Array([3]),
    }))
    expect((await admin.json('POST', '/api/unzip', { space: 'home', path: '/names.zip' })).status).toBe(200)
    const got = await names(admin, 'home', '/names')
    expect(got.length).toBe(3)
    expect(got).toContain('bad_name_.txt')
    expect(got).toContain('ok')
    // a byte 0x01 in a name without the UTF-8 flag is read as CP437 ("☺"); no control character survives either way
    expect(got.some((n: string) => /[\u0000-\u001f]/.test(n))).toBe(false)
    const keep = config.unzipMaxFiles
    config.unzipMaxFiles = 2
    try {
      writeFileSync(join(storage(), 'many.zip'), zipSync({ a: new Uint8Array(1), b: new Uint8Array(1), c: new Uint8Array(1) }))
      expect((await admin.json('POST', '/api/unzip', { space: 'home', path: '/many.zip' })).status).toBe(400)
      expect(await names(admin, 'home', '/')).not.toContain('many')
    } finally {
      config.unzipMaxFiles = keep
    }
  })
  test('a broken data file stops the start instead of silently resetting it', async () => {
    const { JsonStore } = await import('../src/store')
    const file = join(base, 'broken.json')
    writeFileSync(file, '{ not json')
    expect(() => new JsonStore(file, () => ({}), { onCorrupt: 'fail' })).toThrow()
    expect(existsSync(file)).toBe(true)
    // stores that may be rebuilt (sessions) still start fresh
    expect(new JsonStore<Record<string, number>>(file, () => ({ fresh: 1 })).value).toEqual({ fresh: 1 })
  })
  test('the activity log records the real storage path', async () => {
    const c = new Client()
    await c.start()
    expect((await c.login('somchai', 'new-password-456')).status).toBe(200)
    await c.json('POST', '/api/mkdir', { space: 'home', path: '/', name: 'audited' })
    const mk = await admin.json('GET', '/api/admin/activity?action=mkdir&q=audited')
    expect(mk.data.items[0].target).toBe('/users/somchai/audited')
    await guest.raw('GET', '/api/download?space=public&path=/hi.txt')
    const dl = await admin.json('GET', '/api/admin/activity?action=download&user=guest')
    expect(dl.data.items[0].target).toBe('/public/hi.txt')
  })
  test('upload sizes must be whole numbers', async () => {
    expect((await admin.json('POST', '/api/upload', { space: 'home', path: '/', name: 'half.bin', size: 10.5 })).status).toBe(400)
  })
  test('oversized login fields are refused before hashing or logging', async () => {
    const c = new Client()
    await c.start()
    expect((await c.json('POST', '/api/login', { username: 'x'.repeat(5000), password: 'y' })).status).toBe(422)
    const act = await admin.json('GET', '/api/admin/activity?action=login-failed&pageSize=100')
    expect(act.data.items.every((i: any) => i.user.length <= 64)).toBe(true)
  })
  test('expired login attempts are forgotten', async () => {
    const auth = await import('../src/auth')
    const { config } = await import('../src/config')
    const keep = config.loginLockoutMs
    config.loginLockoutMs = 1
    try {
      auth.recordFailure('192.0.2.1|prune-me')
      await Bun.sleep(5)
      expect(auth.pruneLoginAttempts()).toBeGreaterThan(0)
    } finally {
      config.loginLockoutMs = keep
    }
  })
  test('a user folder can not be placed inside the public folder', async () => {
    const make = (homedir: string) => admin.json('POST', '/api/admin/users', {
      username: 'pubhome', name: 'x', password: 'password123', role: 'user', homedir, permissions: ['read'], publicPermissions: [],
    })
    expect((await make('/public')).status).toBe(400)
    expect((await make('/public/inside')).status).toBe(400)
    expect((await admin.json('PUT', '/api/admin/users/somchai', { homedir: '/public' })).status).toBe(400)
  })
  test('zip archives keep thai names and empty folders', async () => {
    await admin.json('POST', '/api/mkdir', { space: 'home', path: '/', name: 'งาน' })
    await admin.json('POST', '/api/mkdir', { space: 'home', path: '/งาน', name: 'ว่าง' })
    await admin.json('POST', '/api/newfile', { space: 'home', path: '/งาน', name: 'บันทึก.txt' })
    await write(admin, '/งาน/บันทึก.txt', 'สวัสดี')
    const b = await admin.json('POST', '/api/batch', { space: 'home', path: '/', items: ['งาน'] })
    const files = unzipSync(new Uint8Array(await (await admin.raw('GET', `/api/batch/${b.data.token}`)).arrayBuffer()))
    expect(Object.keys(files).sort()).toEqual(['งาน/', 'งาน/บันทึก.txt', 'งาน/ว่าง/'])
    expect(new TextDecoder().decode(files['งาน/บันทึก.txt'])).toBe('สวัสดี')
  })
  test('archives made here unzip again, including files stored without compression', async () => {
    await admin.json('POST', '/api/mkdir', { space: 'home', path: '/', name: 'media' })
    const photo = randomBytes(300_000)
    writeFileSync(join(storage(), 'media', 'photo.jpg'), photo)
    writeFileSync(join(storage(), 'media', 'clip.mp4'), randomBytes(70_000))
    writeFileSync(join(storage(), 'media', 'notes.txt'), 'hello '.repeat(1000))
    expect((await admin.json('POST', '/api/zip', { space: 'home', path: '/', items: ['media'], name: 'media.zip' })).status).toBe(200)
    const u = await admin.json('POST', '/api/unzip', { space: 'home', path: '/media.zip' })
    expect(u.status).toBe(200)
    expect(u.data.files).toBe(3)
    expect(await names(admin, 'home', '/media (1)/media')).toEqual(['clip.mp4', 'notes.txt', 'photo.jpg'])
    const back = new Uint8Array(await (await admin.raw('GET', `/api/download?space=home&path=${encodeURIComponent('/media (1)/media/photo.jpg')}`)).arrayBuffer())
    expect(Buffer.compare(back, photo)).toBe(0)
  })
  test.skipIf(!process.env.SLOW_TESTS)('zip archives of files over 4 GB use ZIP64', async () => {
    const { collectZipItems, zipStream } = await import('../src/zip')
    const dir = join(base, 'huge')
    mkdirSync(dir)
    writeFileSync(join(dir, 'movie.mp4'), '')
    truncateSync(join(dir, 'movie.mp4'), 4_400_000_000) // sparse: takes no disk space
    try {
      let tail = new Uint8Array(0)
      let total = 0
      const reader = zipStream(collectZipItems(dir, ['movie.mp4'])).getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        total += value.length
        const joined = new Uint8Array(tail.length + value.length)
        joined.set(tail)
        joined.set(value, tail.length)
        tail = joined.slice(-65536)
      }
      const dv = new DataView(tail.buffer)
      const last = (sig: number) => { for (let i = tail.length - 4; i >= 0; i--) if (dv.getUint32(i, true) === sig) return i; return -1 }
      expect(total).toBeGreaterThan(4_400_000_000)
      expect(last(0x06064b50)).toBeGreaterThanOrEqual(0) // zip64 end of central directory
      const cd = last(0x02014b50)
      expect(dv.getUint32(cd + 24, true)).toBe(0xffffffff) // real size lives in the zip64 extra field
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 600_000)
})

// ───────────────────────── full system ─────────────────────────
const PERMS = ['read', 'write', 'upload', 'download', 'batchdownload', 'zip']
const MB = 1024 * 1024
const storageAbs = (...p: string[]) => join(process.env.STORAGE_DIR!, ...p)
const statusOf = (p: Promise<{ status: number }>) => p.then(r => r.status)
const tag = () => randomBytes(3).toString('hex')
const putChunk = (c: Client, id: string, i: number | string, bytes: Uint8Array) =>
  c.raw('PUT', `/api/upload/${id}/${i}`, bytes, { 'content-type': 'application/octet-stream' })
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/** admin creates a user, drops matrix.txt into their folder and returns a logged-in client */
async function userWith(username: string, permissions: string[], publicPermissions: string[], role = 'user') {
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: 'password123', role, permissions, publicPermissions })
  expect(r.status).toBe(200)
  if (role === 'user') writeFileSync(storageAbs('users', username, 'matrix.txt'), 'matrix')
  const c = new Client()
  await c.start()
  expect((await c.login(username, 'password123')).status).toBe(200)
  return c
}

describe('full system: permission matrix', () => {
  // every call is harmless when allowed: it reads, aims at something missing, or makes a throw-away item
  const calls: Record<string, (c: Client, s: string) => Promise<number>> = {
    list: (c, s) => statusOf(c.json('GET', `/api/list?space=${s}&path=/`)),
    folders: (c, s) => statusOf(c.json('GET', `/api/folders?space=${s}&path=/`)),
    search: (c, s) => statusOf(c.json('GET', `/api/search?space=${s}&q=matrix`)),
    content: (c, s) => statusOf(c.json('GET', `/api/content?space=${s}&path=/matrix.txt`)),
    download: (c, s) => c.raw('GET', `/api/download?space=${s}&path=/matrix.txt`).then(r => r.status),
    batch: (c, s) => statusOf(c.json('POST', '/api/batch', { space: s, path: '/', items: ['matrix.txt'] })),
    mkdir: (c, s) => statusOf(c.json('POST', '/api/mkdir', { space: s, path: '/', name: `m-${tag()}` })),
    newfile: (c, s) => statusOf(c.json('POST', '/api/newfile', { space: s, path: '/', name: `n-${tag()}.txt` })),
    edit: (c, s) => statusOf(c.json('PUT', '/api/content', { space: s, path: '/missing.txt', content: 'x' })),
    rename: (c, s) => statusOf(c.json('POST', '/api/rename', { space: s, path: '/missing.txt', name: 'y.txt' })),
    copy: (c, s) => statusOf(c.json('POST', '/api/copy', { space: s, items: ['/missing.txt'], dest: '/' })),
    move: (c, s) => statusOf(c.json('POST', '/api/move', { space: s, items: ['/missing.txt'], dest: '/' })),
    delete: (c, s) => statusOf(c.json('POST', '/api/delete', { space: s, items: ['/missing.txt'] })),
    zip: (c, s) => statusOf(c.json('POST', '/api/zip', { space: s, path: '/', items: ['missing.txt'] })),
    unzip: (c, s) => statusOf(c.json('POST', '/api/unzip', { space: s, path: '/missing.zip' })),
    upload: (c, s) => statusOf(c.json('POST', '/api/upload', { space: s, path: '/', name: 'u.bin', size: 1 })),
  }
  const ALLOWED: Record<string, number> = {
    list: 200, folders: 200, search: 200, content: 200, download: 200, batch: 200, mkdir: 200, newfile: 200,
    edit: 404, rename: 404, copy: 200, move: 200, delete: 200, zip: 404, unzip: 400, upload: 200,
  }
  // the permission model: what each action needs
  const NEEDS: Record<string, string[]> = {
    list: ['read'], folders: ['read'], search: ['read'], content: ['read', 'download'], download: ['download'],
    batch: ['download', 'batchdownload'], mkdir: ['write'], newfile: ['write'], edit: ['write'], rename: ['write'],
    copy: ['write'], move: ['write'], delete: ['write'], zip: ['zip', 'write'], unzip: ['zip', 'write'], upload: ['upload'],
  }
  const expected = (perms: string[], denied: number) =>
    Object.fromEntries(Object.keys(calls).map(k => [k, NEEDS[k].every(p => perms.includes(p)) ? ALLOWED[k] : denied]))
  const run = async (c: Client, space: string) => {
    const out: Record<string, number> = {}
    for (const [k, f] of Object.entries(calls)) out[k] = await f(c, space)
    return out
  }

  test('each permission unlocks exactly its own actions', async () => {
    writeFileSync(storageAbs('public', 'matrix.txt'), 'matrix')
    for (const p of PERMS) {
      const c = await userWith(`only-${p}`, [p], [])
      expect({ p, ...(await run(c, 'home')) }).toEqual({ p, ...expected([p], 403) })
      expect({ p, ...(await run(c, 'public')) }).toEqual({ p, ...expected([], 403) })
    }
  })
  test('public folder rights are separate from the home rights', async () => {
    const c = await userWith('pub-mixed', PERMS, ['read', 'upload'])
    expect(await run(c, 'home')).toEqual(expected(PERMS, 403))
    expect(await run(c, 'public')).toEqual(expected(['read', 'upload'], 403))
  })
  test('visitors follow the guest permissions and nothing else', async () => {
    const v = new Client()
    await v.start()
    expect(await run(v, 'home')).toEqual(expected([], 401))
    expect(await run(v, 'public')).toEqual(expected(['read', 'download', 'batchdownload'], 401))
    await admin.json('PUT', '/api/admin/settings', { guestPermissions: ['read'] })
    expect(await run(v, 'public')).toEqual(expected(['read'], 401))
    await admin.json('PUT', '/api/admin/settings', { publicEnabled: false })
    expect(await run(v, 'public')).toEqual(expected([], 401))
    await admin.json('PUT', '/api/admin/settings', { publicEnabled: true, guestPermissions: ['read', 'download', 'batchdownload'] })
  })
  test('admins may do everything, unknown spaces are refused', async () => {
    writeFileSync(storageAbs('matrix.txt'), 'matrix')
    expect(await run(admin, 'home')).toEqual(expected(PERMS, 403))
    expect(await run(admin, 'public')).toEqual(expected(PERMS, 403))
    expect(await run(admin, 'nowhere')).toEqual(expected([], 403))
    expect(await run(guest, 'nowhere')).toEqual(expected([], 401))
  })
  test('admin endpoints refuse users (403) and visitors (401)', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const adminCalls: [string, string, any?][] = [
      ['GET', '/api/admin/users'],
      ['POST', '/api/admin/users', { username: 'sneaky', name: 'x', password: 'password123', role: 'admin', permissions: [], publicPermissions: [] }],
      ['PUT', '/api/admin/users/:username', { role: 'admin' }],
      ['DELETE', '/api/admin/users/:username'],
      ['GET', '/api/admin/folders'],
      ['GET', '/api/admin/status'],
      ['GET', '/api/admin/activity'],
      ['GET', '/api/admin/trash'],
      ['POST', '/api/admin/trash/restore', { id: '0000000000000_00000000' }],
      ['POST', '/api/admin/trash/purge', {}],
      ['GET', '/api/admin/settings'],
      ['PUT', '/api/admin/settings', { publicEnabled: false }],
      ['PUT', '/api/admin/logo', png],
      ['DELETE', '/api/admin/logo'],
    ]
    const routes = app.routes.filter((r: any) => r.path.startsWith('/api/admin')).map((r: any) => `${r.method} ${r.path}`)
    expect(routes.filter((r: string) => !adminCalls.some(([m, p]) => `${m} ${p}` === r))).toEqual([])
    const u = await userWith('not-admin', PERMS, PERMS)
    for (const [method, pattern, body] of adminCalls) {
      const path = pattern.replace(':username', 'not-admin')
      const call = (c: Client) => (body instanceof Uint8Array ? c.raw(method, path, body, { 'content-type': 'image/png' }) : c.raw(method, path, body))
      expect(`${method} ${path} ${(await call(u)).status}`).toBe(`${method} ${path} 403`)
      expect(`${method} ${path} ${(await call(guest)).status}`).toBe(`${method} ${path} 401`)
    }
    const { findUser } = await import('../src/auth')
    expect(findUser('not-admin')?.role).toBe('user')
    expect(findUser('sneaky')).toBeUndefined()
  })
})

describe('full system: CSRF', () => {
  test('every state-changing route refuses a request without the right token', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const files = { space: 'home' }
    const mutating: [string, string, any?][] = [
      ['POST', '/api/login', { username: 'admin', password: 'x' }],
      ['POST', '/api/logout'],
      ['POST', '/api/password', { current: 'test-admin-pass', next: 'hijacked-password' }],
      ['POST', '/api/admin/users', { username: 'csrf-user', name: 'x', password: 'password123', role: 'admin', permissions: [], publicPermissions: [] }],
      ['PUT', '/api/admin/users/:username', { role: 'admin' }],
      ['DELETE', '/api/admin/users/:username'],
      ['POST', '/api/admin/trash/restore', { id: '0000000000000_00000000' }],
      ['POST', '/api/admin/trash/purge', {}],
      ['PUT', '/api/admin/settings', { appName: 'pwned' }],
      ['PUT', '/api/admin/logo', png],
      ['DELETE', '/api/admin/logo'],
      ['POST', '/api/mkdir', { ...files, path: '/', name: 'csrf-dir' }],
      ['POST', '/api/newfile', { ...files, path: '/', name: 'csrf.txt' }],
      ['PUT', '/api/content', { ...files, path: '/matrix.txt', content: 'pwned' }],
      ['POST', '/api/rename', { ...files, path: '/matrix.txt', name: 'pwned.txt' }],
      ['POST', '/api/copy', { ...files, items: ['/matrix.txt'], dest: '/public' }],
      ['POST', '/api/move', { ...files, items: ['/matrix.txt'], dest: '/public' }],
      ['POST', '/api/delete', { ...files, items: ['/matrix.txt'] }],
      ['POST', '/api/zip', { ...files, path: '/', items: ['matrix.txt'] }],
      ['POST', '/api/unzip', { ...files, path: '/docs.zip' }],
      ['POST', '/api/batch', { ...files, path: '/', items: ['matrix.txt'] }],
      ['POST', '/api/upload/', { ...files, path: '/', name: 'csrf.bin', size: 1 }],
      ['PUT', '/api/upload/:id/:index', new Uint8Array(1)],
      ['POST', '/api/upload/:id/complete'],
      ['DELETE', '/api/upload/:id'],
    ]
    const routes = app.routes.filter((r: any) => !['GET', 'HEAD'].includes(r.method)).map((r: any) => `${r.method} ${r.path}`)
    expect(routes.filter((r: string) => !mutating.some(([m, p]) => `${m} ${p}` === r))).toEqual([])

    const init = await admin.json('POST', '/api/upload', { space: 'home', path: '/', name: 'csrf-target.bin', size: 1 })
    for (const token of ['', 'wrong', guest.csrf]) {
      const c = new Client()
      c.cookie = admin.cookie // the victim's cookie travels along, the token does not
      c.csrf = token
      for (const [method, pattern, body] of mutating) {
        const path = pattern.replace(':username', 'somchai').replace(':id', init.data.id).replace(':index', '0')
        const res = body instanceof Uint8Array
          ? await c.raw(method, path, body, { 'content-type': 'application/octet-stream' })
          : await c.raw(method, path, body)
        const data = await res.json().catch(() => null)
        expect(`${method} ${path} ${res.status} ${data?.code}`).toBe(`${method} ${path} 403 csrf`)
      }
    }
    // nothing happened
    expect((await admin.json('GET', '/api/session')).data.user?.username).toBe('admin')
    expect((await admin.json('GET', '/api/admin/settings')).data.appName).not.toBe('pwned')
    expect(await Bun.file(storageAbs('matrix.txt')).text()).toBe('matrix')
    expect((await admin.json('GET', `/api/upload/${init.data.id}`)).status).toBe(200)
    expect((await admin.json('GET', '/api/admin/users')).data.users.map((u: any) => u.username)).toContain('somchai')
  })
})

describe('full system: uploads', () => {
  const init = (c: Client, body: Record<string, unknown>) => c.json('POST', '/api/upload', { space: 'home', path: '/', ...body })
  const complete = (c: Client, id: string) => c.json('POST', `/api/upload/${id}/complete`)

  test('an empty file is one empty chunk', async () => {
    const r = await init(admin, { name: 'empty.bin', size: 0 })
    expect(r.data.total).toBe(1)
    expect((await putChunk(admin, r.data.id, 0, new Uint8Array(0))).status).toBe(200)
    expect((await complete(admin, r.data.id)).status).toBe(200)
    const res = await admin.raw('GET', '/api/download?space=home&path=/empty.bin')
    expect(res.status).toBe(200)
    expect((await res.arrayBuffer()).byteLength).toBe(0)
  })
  test('repeated chunks, bad indexes and missing chunks', async () => {
    const data = randomBytes(MB + 10)
    const { id } = (await init(admin, { name: 'twice.bin', size: data.length })).data
    expect((await putChunk(admin, id, 0, data.subarray(0, MB))).status).toBe(200)
    expect((await putChunk(admin, id, 0, data.subarray(0, MB))).status).toBe(200) // a retry is fine
    for (const i of [2, -1, 'x', '1.5']) expect((await putChunk(admin, id, i, new Uint8Array(10))).status).toBe(400)
    expect((await complete(admin, id)).status).toBe(400) // chunk 2 of 2 is missing
    expect((await putChunk(admin, id, 1, data.subarray(MB))).status).toBe(200)
    expect((await admin.json('GET', `/api/upload/${id}`)).data.received).toEqual([0, 1])
    expect((await complete(admin, id)).status).toBe(200)
    // a finished upload is gone
    expect((await complete(admin, id)).status).toBe(404)
    expect((await putChunk(admin, id, 0, data.subarray(0, MB))).status).toBe(404)
    const res = await admin.raw('GET', '/api/download?space=home&path=/twice.bin')
    expect(sha256(new Uint8Array(await res.arrayBuffer()))).toBe(sha256(data))
  })
  test('chunks sent in parallel land in the right place', async () => {
    const data = randomBytes(4 * MB + 7)
    const r = await init(admin, { name: 'parallel.bin', size: data.length })
    const sent = await Promise.all(Array.from({ length: r.data.total }, (_, i) => putChunk(admin, r.data.id, i, data.subarray(i * MB, (i + 1) * MB))))
    expect(sent.map(s => s.status)).toEqual([200, 200, 200, 200, 200])
    expect((await complete(admin, r.data.id)).status).toBe(200)
    const res = await admin.raw('GET', '/api/download?space=home&path=/parallel.bin')
    expect(sha256(new Uint8Array(await res.arrayBuffer()))).toBe(sha256(data))
  })
  test('only the owner can feed, finish or cancel an upload', async () => {
    const u = new Client()
    await u.start()
    expect((await u.login('somchai', 'new-password-456')).status).toBe(200)
    const { id } = (await init(u, { name: 'cancel.bin', size: 4 })).data
    expect((await putChunk(admin, id, 0, new Uint8Array(4))).status).toBe(403)
    expect((await complete(admin, id)).status).toBe(403)
    expect((await admin.json('DELETE', `/api/upload/${id}`)).status).toBe(403)
    expect((await guest.json('DELETE', `/api/upload/${id}`)).status).toBe(403)
    expect((await u.json('DELETE', `/api/upload/${id}`)).status).toBe(200)
    expect(existsSync(join(process.env.DATA_DIR!, 'tmp', id))).toBe(false)
    expect((await u.json('GET', `/api/upload/${id}`)).status).toBe(404)
    for (const bad of ['zz', 'g'.repeat(24), 'A'.repeat(24)]) expect((await u.json('GET', `/api/upload/${bad}`)).status).toBe(404)
  })
  test('bad upload requests are refused up front', async () => {
    expect((await init(admin, { name: '../x', size: 1 })).status).toBe(400)
    expect((await init(admin, { name: 'ok.bin', size: 1, relativeDir: 'a/../../b' })).status).toBe(400)
    expect((await init(admin, { name: 'ok.bin', size: 1, relativeDir: Array(31).fill('d').join('/') })).status).toBe(400)
    expect((await init(admin, { name: 'ok.bin', size: -1 })).status).toBe(400)
    expect((await init(admin, { name: 'ok.bin', size: 11 * 1024 ** 3 })).status).toBe(413)
    expect((await init(admin, { name: 'ok.bin', size: 1, path: '/../..' })).status).toBe(400)
  })
  test('stale uploads are cleaned up', async () => {
    const { cleanStaleUploads } = await import('../src/uploads')
    const { config } = await import('../src/config')
    const { id } = (await init(admin, { name: 'stale.bin', size: 4 })).data
    const keep = config.uploadStaleMs
    config.uploadStaleMs = -1
    try {
      expect(cleanStaleUploads()).toBeGreaterThan(0)
    } finally {
      config.uploadStaleMs = keep
    }
    expect((await admin.json('GET', `/api/upload/${id}`)).status).toBe(404)
  })
})

describe('full system: downloads', () => {
  const body = randomBytes(1000)
  const get = (range?: string) => admin.raw('GET', '/api/download?space=home&path=/range.bin', undefined, range ? { range } : {})

  test('range variants', async () => {
    writeFileSync(storageAbs('range.bin'), body)
    const cases: [string, number, string | null, [number, number] | null][] = [
      ['bytes=-100', 206, 'bytes 900-999/1000', [900, 1000]],
      ['bytes=990-', 206, 'bytes 990-999/1000', [990, 1000]],
      ['bytes=900-5000', 206, 'bytes 900-999/1000', [900, 1000]],
      ['bytes=-5000', 206, 'bytes 0-999/1000', [0, 1000]],
      ['bytes=1000-', 416, 'bytes */1000', null],
      ['bytes=-0', 416, 'bytes */1000', null],
      ['bytes=-', 200, null, [0, 1000]], // not a valid range: the whole file
      ['bytes=0-1,5-6', 200, null, [0, 1000]], // several ranges are not supported: the whole file
      ['items=0-1', 200, null, [0, 1000]],
    ]
    for (const [range, status, contentRange, slice] of cases) {
      const res = await get(range)
      expect(`${range} ${res.status}`).toBe(`${range} ${status}`)
      expect(res.headers.get('content-range')).toBe(contentRange)
      const got = new Uint8Array(await res.arrayBuffer())
      if (slice) expect(sha256(got)).toBe(sha256(body.subarray(...slice)))
    }
  })
  test('empty files download fine, with or without a range', async () => {
    writeFileSync(storageAbs('zero.bin'), '')
    for (const headers of [{}, { range: 'bytes=0-' }]) {
      const res = await admin.raw('GET', '/api/download?space=home&path=/zero.bin', undefined, headers)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-length')).toBe('0')
    }
  })
  test('file names can not break the response headers', async () => {
    const name = 'evil"\r\nX-Injected: yes.txt'
    writeFileSync(storageAbs(name), 'x')
    const res = await admin.raw('GET', `/api/download?space=home&path=${encodeURIComponent('/' + name)}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-injected')).toBeNull()
    const cd = res.headers.get('content-disposition')!
    expect(cd).not.toMatch(/[\r\n]/)
    expect(cd).toMatch(/^attachment; filename="[^"]*"; filename\*=UTF-8''\S+$/)
  })
  test('active content never renders inline', async () => {
    for (const name of ['page.svg', 'page.htm', 'script.js', 'notes.md']) {
      writeFileSync(storageAbs(name), '<script>alert(1)</script>')
      const res = await admin.raw('GET', `/api/download?space=home&path=/${name}&inline=1`)
      expect(`${name} ${res.headers.get('content-disposition')?.split(';')[0]}`).toBe(`${name} attachment`)
      expect(res.headers.get('content-security-policy')).toContain('sandbox')
    }
  })
  test('path tricks never leave the space', async () => {
    const u = new Client()
    await u.start()
    expect((await u.login('somchai', 'new-password-456')).status).toBe(200)
    symlinkSync(process.env.STORAGE_DIR!, storageAbs('users', 'somchai', 'peek'))
    const tricks = [
      '/../matrix.txt', '../../matrix.txt', '..\\..\\matrix.txt', '%2e%2e/%2e%2e/matrix.txt', '....//....//matrix.txt',
      '/etc/passwd', 'C:\\Windows\\win.ini', '/matrix.txt\u0000.png', '/peek/matrix.txt', '/peek', '//users/../matrix.txt',
    ]
    for (const p of tricks) {
      const q = encodeURIComponent(p)
      for (const [kind, res] of [
        ['download', await u.raw('GET', `/api/download?space=home&path=${q}`)],
        ['content', await u.raw('GET', `/api/content?space=home&path=${q}`)],
        ['list', await u.raw('GET', `/api/list?space=home&path=${q}`)],
      ] as const) {
        expect(`${kind} ${p} ${[400, 403, 404].includes(res.status)}`).toBe(`${kind} ${p} true`)
      }
    }
    expect((await u.json('POST', '/api/copy', { space: 'home', items: ['/peek/matrix.txt'], dest: '/' })).data.done).toBe(0)
    expect((await u.json('POST', '/api/delete', { space: 'home', items: ['/peek'] })).data.done).toBe(0)
    rmSync(storageAbs('users', 'somchai', 'peek'))
  })
  test('the static file server stays inside the web folder', async () => {
    for (const p of ['/%2e%2e/package.json', '/..%2fpackage.json', '/assets/..%2f..%2f..%2fpackage.json', '/%2e%2e%2f%2e%2e%2fsrc%2fconfig.ts']) {
      const res: Response = await app.handle(new Request('http://localhost' + p))
      const text = await res.text()
      expect(text).not.toContain('"name": "file-center"')
      expect(text).not.toContain('export const config')
    }
  })
})

describe('full system: file operations', () => {
  const ok = (r: { status: number }) => expect(r.status).toBe(200)
  const names = async (path: string) =>
    (await admin.json('GET', `/api/list?space=home&path=${encodeURIComponent(path)}`)).data.entries.map((e: any) => e.name).sort()

  test('creating inside a missing folder or a file is a clean 404', async () => {
    writeFileSync(storageAbs('plain.txt'), 'plain')
    for (const path of ['/no/such', '/plain.txt']) {
      expect((await admin.json('POST', '/api/mkdir', { space: 'home', path, name: 'x' })).status).toBe(404)
      expect((await admin.json('POST', '/api/newfile', { space: 'home', path, name: 'x.txt' })).status).toBe(404)
    }
  })
  test('copy and move edge cases', async () => {
    ok(await admin.json('POST', '/api/mkdir', { space: 'home', path: '/', name: 'ops' }))
    for (const n of ['a', 'b']) ok(await admin.json('POST', '/api/mkdir', { space: 'home', path: '/ops', name: n }))
    ok(await admin.json('POST', '/api/mkdir', { space: 'home', path: '/ops/a', name: 'inner' }))
    writeFileSync(storageAbs('ops', 'a', 'f.txt'), 'from a')
    writeFileSync(storageAbs('ops', 'b', 'f.txt'), 'from b')
    const copy = (items: string[], dest: string) => admin.json('POST', '/api/copy', { space: 'home', items, dest })
    const move = (items: string[], dest: string) => admin.json('POST', '/api/move', { space: 'home', items, dest })

    expect((await copy(['/ops/a'], '/ops/a/inner')).data.done).toBe(0) // into itself
    expect((await move(['/ops/a'], '/ops/a/inner')).data.done).toBe(0)
    expect((await move(['/ops/a/f.txt'], '/ops/a')).data.done).toBe(0) // same folder
    expect((await move(['/ops/a/f.txt'], '/ops/b')).data.done).toBe(0) // name taken: nothing is overwritten
    expect(await Bun.file(storageAbs('ops', 'b', 'f.txt')).text()).toBe('from b')
    expect(existsSync(storageAbs('ops', 'a', 'f.txt'))).toBe(true)
    expect((await copy(['/ops/a/f.txt'], '/ops/b')).data.done).toBe(1)
    expect(await names('/ops/b')).toEqual(['f (1).txt', 'f.txt'])
    expect((await copy(['/ops/a/f.txt'], '/ops/missing')).status).toBe(404)
    expect((await move(['/ops/a'], '/ops/b')).data.done).toBe(1)
    expect(await names('/ops/b/a')).toEqual(['f.txt', 'inner'])
  })
  test('names may be 255 bytes at most, which is 85 Thai letters', async () => {
    const fits = 'ก'.repeat(85)
    const tooLong = 'ก'.repeat(86)
    ok(await admin.json('POST', '/api/mkdir', { space: 'home', path: '/ops', name: fits }))
    expect((await admin.json('POST', '/api/mkdir', { space: 'home', path: '/ops', name: tooLong })).status).toBe(400)
    expect((await admin.json('POST', '/api/newfile', { space: 'home', path: '/ops', name: `${tooLong}.txt` })).status).toBe(400)
    expect((await admin.json('POST', '/api/rename', { space: 'home', path: `/ops/${fits}`, name: tooLong })).status).toBe(400)
    // refused before any byte is sent, not after the whole file is up
    expect((await admin.json('POST', '/api/upload', { space: 'home', path: '/ops', name: `${tooLong}.mp4`, size: 1 })).status).toBe(400)
    // a copy of a name that already fills the limit still gets a free name
    expect((await admin.json('POST', '/api/copy', { space: 'home', items: [`/ops/${fits}`], dest: '/ops' })).data.done).toBe(1)
    const copies = (await names('/ops')).filter((n: string) => n.startsWith('กกก'))
    expect(copies.length).toBe(2)
    for (const n of copies) expect(Buffer.byteLength(n)).toBeLessThanOrEqual(255)
    // over-long names inside a zip are shortened, keeping the extension
    writeFileSync(storageAbs('ops', 'long.zip'), zipSync({ [`${tooLong}.txt`]: new Uint8Array([1]) }))
    ok(await admin.json('POST', '/api/unzip', { space: 'home', path: '/ops/long.zip' }))
    const [inside] = await names('/ops/long')
    expect(Buffer.byteLength(inside)).toBeLessThanOrEqual(255)
    expect(inside.endsWith('.txt')).toBe(true)
  })
  test('paths that get too deep fail cleanly, without showing server paths', async () => {
    const seg = 'd'.repeat(250)
    let deepest = '/ops'
    let status = 200
    for (let i = 0; i < 20; i++) {
      status = (await admin.json('POST', '/api/mkdir', { space: 'home', path: deepest, name: seg })).status
      if (status !== 200) break
      deepest += `/${seg}`
    }
    expect(status).toBe(400)
    const copy = await admin.json('POST', '/api/copy', { space: 'home', items: [`/ops/${'ก'.repeat(85)}`], dest: deepest })
    expect(copy.data.done).toBe(0)
    expect(copy.data.failed[0].error).not.toContain(process.env.STORAGE_DIR!)
  })
  test('large text stays out of the editor', async () => {
    writeFileSync(storageAbs('ops', 'big.txt'), 'x'.repeat(2 * MB + 1))
    expect((await admin.json('GET', '/api/content?space=home&path=/ops/big.txt')).status).toBe(413)
    expect((await admin.json('PUT', '/api/content', { space: 'home', path: '/ops/b/f.txt', content: 'x'.repeat(2 * MB + 1) })).status).toBe(413)
  })
  test('item lists are bounded', async () => {
    expect((await admin.json('POST', '/api/delete', { space: 'home', items: [] })).status).toBe(400)
    expect((await admin.json('POST', '/api/delete', { space: 'home', items: Array(2001).fill('/x') })).status).toBe(400)
    expect((await admin.json('POST', '/api/delete', { space: 'home', items: ['/'] })).status).toBe(400)
    expect((await admin.json('POST', '/api/move', { space: 'home', items: ['//'], dest: '/ops' })).status).toBe(400)
  })
  test('search is case-insensitive and capped', async () => {
    mkdirSync(storageAbs('ops', 'many'))
    for (let i = 0; i < 210; i++) writeFileSync(storageAbs('ops', 'many', `Hit-${i}.txt`), '')
    const capped = await admin.json('GET', '/api/search?space=home&path=/ops/many&q=hit-')
    expect(capped.data.results.length).toBe(200)
    expect(capped.data.truncated).toBe(true)
    const one = await admin.json('GET', '/api/search?space=home&path=/ops/many&q=HIT-209')
    expect(one.data.results.map((e: any) => e.path)).toEqual(['/ops/many/Hit-209.txt'])
    expect((await admin.json('GET', '/api/search?space=home&q=%20%20')).data.results).toEqual([])
  })
  test('zip and copy keep the disk reserve', async () => {
    const { config } = await import('../src/config')
    const keep = config.minFreeSpace
    const before = await names('/ops')
    config.minFreeSpace = Number.MAX_SAFE_INTEGER
    try {
      const z = await admin.json('POST', '/api/zip', { space: 'home', path: '/ops', items: ['b'], name: 'reserve.zip' })
      expect(z.status).toBe(507)
      expect(z.data.code).toBe('disk-full')
      const c = await admin.json('POST', '/api/copy', { space: 'home', items: ['/ops/b'], dest: '/ops' })
      expect(c.data.done).toBe(0)
    } finally {
      config.minFreeSpace = keep
    }
    expect(await names('/ops')).toEqual(before)
  })
})

describe('full system: zip archives', () => {
  test('ZIP64 archives made by this system unzip again', async () => {
    const { zipStream } = await import('../src/zip')
    mkdirSync(storageAbs('z64src'))
    writeFileSync(storageAbs('z64src', 'big.txt'), 'x'.repeat(100_000))
    writeFileSync(storageAbs('z64src', 'clip.mp4'), randomBytes(5000))
    // claim a size past the ZIP64 threshold so the small test files get the same records as a 5 GB one
    const huge = 0xf000_0000
    const items = [
      { name: 'ใหญ่/', abs: storageAbs('z64src'), dir: true, mtime: Date.now(), size: 0 },
      { name: 'ใหญ่/big.txt', abs: storageAbs('z64src', 'big.txt'), dir: false, mtime: Date.now(), size: huge },
      { name: 'ใหญ่/clip.mp4', abs: storageAbs('z64src', 'clip.mp4'), dir: false, mtime: Date.now(), size: huge },
    ]
    await Bun.write(storageAbs('z64.zip'), new Response(zipStream(items)))
    const u = await admin.json('POST', '/api/unzip', { space: 'home', path: '/z64.zip' })
    expect(u.status).toBe(200)
    expect(u.data.files).toBe(2)
    expect(await Bun.file(storageAbs('z64', 'ใหญ่', 'big.txt')).text()).toBe('x'.repeat(100_000))
    expect(Buffer.compare(new Uint8Array(await Bun.file(storageAbs('z64', 'ใหญ่', 'clip.mp4')).arrayBuffer()), new Uint8Array(await Bun.file(storageAbs('z64src', 'clip.mp4')).arrayBuffer()))).toBe(0)
  })
  test('UTF-8 names without the UTF-8 flag (macOS and older tools) keep their Thai letters', async () => {
    const zip = zipSync({ 'รายงาน.txt': new TextEncoder().encode('ok') })
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    for (let i = 0; i < zip.length - 4; i++) {
      const sig = dv.getUint32(i, true)
      const at = sig === 0x04034b50 ? i + 6 : sig === 0x02014b50 ? i + 8 : -1
      if (at >= 0) dv.setUint16(at, dv.getUint16(at, true) & ~0x800, true)
    }
    writeFileSync(storageAbs('noflag.zip'), zip)
    expect((await admin.json('POST', '/api/unzip', { space: 'home', path: '/noflag.zip' })).status).toBe(200)
    expect(existsSync(storageAbs('noflag', 'รายงาน.txt'))).toBe(true)
  })
  test('big files that do not shrink are stored, text is still compressed', async () => {
    const { BlobReader, ZipReader } = await import('@zip.js/zip.js')
    mkdirSync(storageAbs('mixed'))
    writeFileSync(storageAbs('mixed', 'noise.bin'), randomBytes(3 * MB))
    writeFileSync(storageAbs('mixed', 'log.txt'), 'GET /api/list 200 12ms\n'.repeat(150_000))
    const b = await admin.json('POST', '/api/batch', { space: 'home', path: '/', items: ['mixed'] })
    const zip = await (await admin.raw('GET', `/api/batch/${b.data.token}`)).blob()
    const entries = Object.fromEntries((await new ZipReader(new BlobReader(zip)).getEntries()).map(e => [e.filename, e]))
    expect(entries['mixed/noise.bin'].compressedSize).toBe(3 * MB)
    expect(entries['mixed/log.txt'].compressedSize).toBeLessThan(entries['mixed/log.txt'].uncompressedSize / 10)
  })
  test('a damaged archive is refused and leaves nothing behind', async () => {
    const zip = zipSync({ 'data.bin': new Uint8Array(4000).fill(7) }, { level: 0 })
    zip[100] ^= 0xff // flip a byte of the stored file data: the CRC no longer matches
    writeFileSync(storageAbs('damaged.zip'), zip)
    expect((await admin.json('POST', '/api/unzip', { space: 'home', path: '/damaged.zip' })).status).toBe(400)
    expect(existsSync(storageAbs('damaged'))).toBe(false)
  })
})

describe('full system: trash', () => {
  const trash = async () => (await admin.json('GET', '/api/admin/trash')).data.items as any[]
  const del = (c: Client, items: string[]) => c.json('POST', '/api/delete', { space: 'home', items })

  test('restore brings back a missing parent and never overwrites', async () => {
    await admin.json('POST', '/api/mkdir', { space: 'home', path: '/', name: 'tr' })
    await admin.json('POST', '/api/mkdir', { space: 'home', path: '/tr', name: 'sub' })
    writeFileSync(storageAbs('tr', 'sub', 'x.txt'), 'x')
    writeFileSync(storageAbs('tr', 'sub', 'y.txt'), 'old y')
    expect((await del(admin, ['/tr/sub/x.txt', '/tr/sub/y.txt'])).data.done).toBe(2)
    expect((await del(admin, ['/tr'])).data.done).toBe(1)
    const x = (await trash()).find(i => i.originalPath === '/tr/sub/x.txt')
    expect((await admin.json('POST', '/api/admin/trash/restore', { id: x.id })).data.restoredTo).toBe('/tr/sub/x.txt')
    writeFileSync(storageAbs('tr', 'sub', 'y.txt'), 'new y')
    const y = (await trash()).find(i => i.originalPath === '/tr/sub/y.txt')
    expect((await admin.json('POST', '/api/admin/trash/restore', { id: y.id })).data.restoredTo).toBe('/tr/sub/y (1).txt')
    expect(await Bun.file(storageAbs('tr', 'sub', 'y.txt')).text()).toBe('new y')
  })
  test('a user deletion keeps who and where', async () => {
    const u = new Client()
    await u.start()
    expect((await u.login('somchai', 'new-password-456')).status).toBe(200)
    await u.json('POST', '/api/newfile', { space: 'home', path: '/', name: 'mine.txt' })
    expect((await del(u, ['/mine.txt'])).data.done).toBe(1)
    const item = (await trash()).find(i => i.originalPath === '/users/somchai/mine.txt')
    expect(item?.deletedBy).toBe('somchai')
  })
  test('bad ids, single purge and empty trash', async () => {
    for (const id of ['../../etc', 'nope', '0000000000000_00000000']) {
      expect((await admin.json('POST', '/api/admin/trash/restore', { id })).status).toBe(404)
      expect((await admin.json('POST', '/api/admin/trash/purge', { id })).status).toBe(404)
    }
    const [first] = await trash()
    expect((await admin.json('POST', '/api/admin/trash/purge', { id: first.id })).data.removed).toBe(1)
    expect((await trash()).some(i => i.id === first.id)).toBe(false)
    const left = (await trash()).length
    expect((await admin.json('POST', '/api/admin/trash/purge', {})).data.removed).toBe(left)
    expect(await trash()).toEqual([])
  })
})

describe('full system: users', () => {
  const update = (username: string, body: Record<string, unknown>) => admin.json('PUT', `/api/admin/users/${username}`, body)
  const users = async () => (await admin.json('GET', '/api/admin/users')).data.users as any[]

  test('promote, demote and move a user folder; changes apply at once', async () => {
    const c = await userWith('lifecycle', ['read'], [])
    expect((await update('lifecycle', { role: 'admin' })).status).toBe(200)
    expect((await c.json('GET', '/api/admin/users')).status).toBe(200)
    expect((await c.json('GET', '/api/list?space=home&path=/')).data.entries.map((e: any) => e.name)).toContain('users')
    expect((await update('lifecycle', { role: 'user' })).status).toBe(200)
    expect((await users()).find(u => u.username === 'lifecycle').homedir).toBe('/users/lifecycle')
    expect((await c.json('GET', '/api/admin/users')).status).toBe(403)
    await admin.json('POST', '/api/mkdir', { space: 'home', path: '/', name: 'elsewhere' })
    writeFileSync(storageAbs('elsewhere', 'moved-in.txt'), '')
    expect((await update('lifecycle', { homedir: '/elsewhere' })).status).toBe(200)
    expect((await c.json('GET', '/api/list?space=home&path=/')).data.entries.map((e: any) => e.name)).toEqual(['moved-in.txt'])
  })
  test('invalid changes are refused', async () => {
    for (const body of [{ homedir: '/../x' }, { homedir: '/' }, { name: '' }, { name: 'x'.repeat(61) }, { password: 'short' }]) {
      expect(`${JSON.stringify(body)} ${(await update('lifecycle', body)).status}`).toBe(`${JSON.stringify(body)} 400`)
    }
    // a refused change leaves the other fields of the same request untouched
    expect((await update('lifecycle', { name: 'Changed', password: 'short' })).status).toBe(400)
    expect((await users()).find(u => u.username === 'lifecycle').name).toBe('lifecycle')
    expect((await update('ghost-user', { name: 'x' })).status).toBe(404)
    // the only admin stays an admin
    expect((await update('admin', { role: 'user' })).status).toBe(400)
    const make = (username: string, name = 'x') =>
      admin.json('POST', '/api/admin/users', { username, name, password: 'password123', role: 'user', permissions: [], publicPermissions: [] })
    for (const username of ['ab', 'bad name', 'x'.repeat(33), 'ไทย', '../up']) expect((await make(username)).status).toBe(400)
    expect((await make('SOMCHAI')).status).toBe(409)
    expect((await make('okname', 'x'.repeat(61))).status).toBe(400)
  })
  test('a password reset or deletion ends the sessions of that user', async () => {
    const c = new Client()
    await c.start()
    expect((await c.login('lifecycle', 'password123')).status).toBe(200)
    expect((await update('lifecycle', { password: 'reset-pass-99' })).status).toBe(200)
    expect((await c.json('GET', '/api/list?space=home&path=/')).status).toBe(401)
    await c.start() // the old session is gone, fetch a fresh one like the web app does
    expect((await c.login('lifecycle', 'reset-pass-99')).status).toBe(200)
    expect((await admin.json('DELETE', '/api/admin/users/lifecycle')).status).toBe(200)
    expect((await c.json('GET', '/api/list?space=home&path=/')).status).toBe(401)
    await c.start()
    expect((await c.login('lifecycle', 'reset-pass-99')).status).toBe(401)
  })
})

describe('full system: sessions & links', () => {
  test('logging in gives a new session id (no fixation)', async () => {
    const c = new Client()
    await c.start()
    const before = c.cookie
    expect((await c.login('somchai', 'new-password-456')).status).toBe(200)
    expect(c.cookie).not.toBe(before)
    const old = new Client()
    old.cookie = before
    expect((await old.json('GET', '/api/session')).data.user).toBeNull()
  })
  test('forged session ids are plain visitors', async () => {
    const c = new Client()
    c.cookie = 'fc_sid=forged-value'
    const s = await c.json('GET', '/api/session')
    expect(s.data.user).toBeNull()
    expect(c.cookie).not.toBe('fc_sid=forged-value')
  })
  test('cookies and headers', async () => {
    const res = await new Client().raw('GET', '/api/session')
    const cookie = res.headers.get('set-cookie')!
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toMatch(/SameSite=Lax/i)
    for (const path of ['/api/health', '/api/list?space=home&path=/']) {
      const r = await guest.raw('GET', path)
      expect(r.headers.get('x-content-type-options')).toBe('nosniff')
      expect(r.headers.get('x-frame-options')).toBe('SAMEORIGIN')
      expect(r.headers.get('referrer-policy')).toBe('same-origin')
    }
  })
  test('a download link only works for its owner, and only while they keep the right', async () => {
    const c = await userWith('batcher', ['read', 'download', 'batchdownload'], [])
    const { token } = (await c.json('POST', '/api/batch', { space: 'home', path: '/', items: ['matrix.txt'] })).data
    expect((await admin.raw('GET', `/api/batch/${token}`)).status).toBe(403)
    expect((await guest.raw('GET', `/api/batch/${token}`)).status).toBe(403)
    expect((await admin.json('PUT', '/api/admin/users/batcher', { permissions: ['read', 'download'] })).status).toBe(200)
    expect((await c.raw('GET', `/api/batch/${token}`)).status).toBe(403)
    // the same goes for visitors once the public page is closed
    const v = (await guest.json('POST', '/api/batch', { space: 'public', path: '/', items: ['matrix.txt'] })).data.token
    await admin.json('PUT', '/api/admin/settings', { publicEnabled: false })
    try {
      expect((await guest.raw('GET', `/api/batch/${v}`)).status).toBe(401)
    } finally {
      await admin.json('PUT', '/api/admin/settings', { publicEnabled: true })
    }
  })
  test('the logo still loads while a password change is pending', async () => {
    const { findUser } = await import('../src/auth')
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    expect((await admin.raw('PUT', '/api/admin/logo', png, { 'content-type': 'image/png' })).status).toBe(200)
    const c = await userWith('pending', ['read'], [])
    findUser('pending')!.mustChangePassword = true
    expect((await c.raw('GET', '/api/branding/logo')).status).toBe(200)
    expect((await c.json('GET', '/api/list?space=home&path=/')).status).toBe(403)
  })
})

describe('admin', () => {
  test('status, activity, settings, logo', async () => {
    const st = await admin.json('GET', '/api/admin/status')
    expect(st.status).toBe(200)
    expect(st.data.storage.files).toBeGreaterThan(0)
    const act = await admin.json('GET', '/api/admin/activity?action=upload')
    expect(act.data.items.length).toBeGreaterThan(0)
    expect(act.data.items.every((r: any) => r.action === 'upload')).toBe(true)
    const set = await admin.json('PUT', '/api/admin/settings', { appName: 'ศูนย์ไฟล์', primaryColor: '#16a34a' })
    expect(set.data.appName).toBe('ศูนย์ไฟล์')
    expect((await admin.json('PUT', '/api/admin/settings', { primaryColor: 'red' })).status).toBe(400)
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    expect((await admin.raw('PUT', '/api/admin/logo', png, { 'content-type': 'image/png' })).status).toBe(200)
    expect((await guest.raw('GET', '/api/branding/logo')).status).toBe(200)
    expect((await admin.raw('PUT', '/api/admin/logo', png, { 'content-type': 'text/html' })).status).toBe(400)
  })
  test('health and unknown api', async () => {
    expect((await guest.json('GET', '/api/health')).data.status).toBe('ok')
    expect((await guest.json('GET', '/api/nope')).status).toBe(404)
  })
  test('logout ends the session', async () => {
    const r = await admin.json('POST', '/api/logout')
    expect(r.status).toBe(200)
    expect(r.data.user).toBeNull()
    admin.csrf = r.data.csrf
    expect((await admin.json('GET', '/api/admin/users')).status).toBe(401)
  })
})
