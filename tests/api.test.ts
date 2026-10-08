import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
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
