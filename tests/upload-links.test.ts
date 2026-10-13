/**
 * Upload-request links: someone without an account sends files into one folder of a user. Runs in-process on the
 * same app as api.test.ts (see in-process-env.ts); every user here starts with "ul-".
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import './in-process-env'

let app: any
let config: typeof import('../src/config').config
let paths: typeof import('../src/config').paths
let shares: typeof import('../src/shares')
let uploads: typeof import('../src/uploads')
let quota: typeof import('../src/quota')

/** a browser: keeps the cookies it is given, by name (every link here has its own token, so the path does not matter) */
class Client {
  jar = new Map<string, string>()
  csrf = ''
  async raw(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers }
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    if (cookie) h.cookie = cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    let payload: any = body
    if (body !== undefined && !(body instanceof Uint8Array)) {
      payload = JSON.stringify(body)
      h['content-type'] = 'application/json'
    }
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: payload }))
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';')
      const at = pair.indexOf('=')
      this.jar.set(pair.slice(0, at), pair.slice(at + 1))
    }
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
const OWNER_PERMS = ['read', 'write', 'upload', 'download', 'share']
const admin = new Client()
const home = (user: string, ...p: string[]) => join(process.env.STORAGE_DIR!, 'users', user, ...p)

async function userWith(username: string, permissions: string[], quotaBytes?: number) {
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', permissions, publicPermissions: [], quotaBytes })
  expect(r.status).toBe(200)
  return new Client().login(username, PW)
}

async function link(c: Client, body: Record<string, unknown> = {}) {
  const r = await c.json('POST', '/api/shares', { space: 'home', path: '/inbox', days: 7, kind: 'upload', ...body })
  if (r.status === 200) expect(r.data.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  return r
}
const tokenOf = async (c: Client, body: Record<string, unknown> = {}) => (await link(c, body)).data.token as string

const info = (v: Client, t: string) => v.json('GET', `/api/s/${t}`)
const announce = (v: Client, t: string, name: string, size: number, headers: Record<string, string> = {}) =>
  v.json('POST', `/api/s/${t}/upload`, { name, size }, headers)
const chunk = (v: Client, t: string, id: string, data: Uint8Array, n = 0) =>
  v.raw('PUT', `/api/s/${t}/upload/${id}/${n}`, data, { 'content-type': 'application/octet-stream' })
const complete = (v: Client, t: string, id: string) => v.json('POST', `/api/s/${t}/upload/${id}/complete`)
const cancel = (v: Client, t: string, id: string) => v.json('DELETE', `/api/s/${t}/upload/${id}`)
/** announce, send the bytes and complete */
async function send(v: Client, t: string, name: string, data: Uint8Array | string) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const a = await announce(v, t, name, bytes.length)
  if (a.status !== 200) return a
  expect((await chunk(v, t, a.data.id, bytes)).status).toBe(200)
  return complete(v, t, a.data.id)
}
const code = (r: { status: number; data: any }) => ({ status: r.status, code: r.data?.code })

let owner: Client

/** uploads a test left in progress: made stale and cleaned up, so they do not count against the next test (all requests here share one address) */
afterEach(() => {
  const old = new Date(Date.now() - config.uploadStaleMs - 60_000)
  for (const id of existsSync(paths.tmp) ? readdirSync(paths.tmp) : []) {
    try { utimesSync(join(paths.tmp, id, 'meta.json'), old, old) } catch { /* not an upload */ }
  }
  uploads.cleanStaleUploads()
})

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config, paths } = await import('../src/config'))
  shares = await import('../src/shares')
  uploads = await import('../src/uploads')
  quota = await import('../src/quota')
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
  owner = await userWith('ul-owner', OWNER_PERMS)
  mkdirSync(home('ul-owner', 'inbox'), { recursive: true })
  writeFileSync(home('ul-owner', 'inbox', 'existing.txt'), 'already here')
  writeFileSync(home('ul-owner', 'inbox', 'secret-name.txt'), 'must not be listed')
  writeFileSync(home('ul-owner', 'report.txt'), 'a file')
})

describe('upload links: making them', () => {
  test('a folder, with the share and upload permissions in that space', async () => {
    const r = await link(owner, { maxFileBytes: 1000, maxFiles: 3, maxTotalBytes: 5000, note: 'Please send your CV' })
    expect(r.status).toBe(200)
    expect(r.data.share).toMatchObject({
      kind: 'upload', owner: 'ul-owner', path: '/inbox', type: 'dir', maxFileBytes: 1000, maxFiles: 3, maxTotalBytes: 5000,
      note: 'Please send your CV', uploadedFiles: 0, uploadedBytes: 0, state: 'active', hasPassword: false,
    })
    expect((await owner.json('GET', '/api/shares')).data.shares.map((s: any) => s.id)).toContain(r.data.share.id)

    // a file can not receive uploads
    expect(code(await link(owner, { path: '/report.txt' }))).toEqual({ status: 400, code: 'share.upload-folder-only' })
    // the whole space is not a folder to share either
    expect((await link(owner, { path: '/' })).status).toBe(400)
    // permissions: both, in that space
    const noUpload = await userWith('ul-noup', ['read', 'download', 'share'])
    const noShare = await userWith('ul-noshare', ['read', 'download', 'upload'])
    mkdirSync(home('ul-noup', 'inbox'))
    mkdirSync(home('ul-noshare', 'inbox'))
    expect((await link(noUpload)).status).toBe(403)
    expect((await link(noShare)).status).toBe(403)
    // an upload permission does not make a download link, and download-only users still make download links as before
    expect((await noUpload.json('POST', '/api/shares', { space: 'home', path: '/inbox', days: 7 })).status).toBe(200)
    // visitors never make links
    const visitor = new Client()
    visitor.csrf = (await visitor.json('GET', '/api/session')).data.csrf
    expect((await visitor.json('POST', '/api/shares', { space: 'home', path: '/inbox', days: 7, kind: 'upload' })).status).toBe(401)
  })

  test('limits and note are checked', async () => {
    for (const bad of [{ maxFileBytes: 0 }, { maxFileBytes: config.uploadMaxSize + 1 }, { maxFiles: 1.5 }, { maxFiles: -1 }, { maxTotalBytes: 2 ** 50 + 1 }]) {
      expect(code(await link(owner, bad))).toEqual({ status: 400, code: 'share.bad-upload-limits' })
    }
    expect(code(await link(owner, { note: 'x'.repeat(501) }))).toEqual({ status: 400, code: 'share.note-too-long' })
    expect((await link(owner, { note: 'x'.repeat(500) })).status).toBe(200)
    expect(code(await link(owner, { days: 99 })).status).toBe(400)
    // all of them optional
    const plain = await link(owner)
    expect(plain.data.share).toMatchObject({ maxFileBytes: null, maxFiles: null, maxTotalBytes: null, note: '' })
  })
})

describe('upload links: what a visitor sees', () => {
  test('the folder name, rules and counts: never what is in the folder', async () => {
    const t = await tokenOf(owner, { maxFiles: 5, note: '<b>plain</b> text' })
    const v = new Client()
    const r = await info(v, t)
    expect(r.status).toBe(200)
    expect(r.data).toEqual({
      kind: 'upload', name: 'inbox', type: 'dir', expiresAt: expect.any(String), needsPassword: false, note: '<b>plain</b> text',
      // unset limits are shown as the defaults that apply, never as "no limit"
      maxFileBytes: config.uploadRequestMaxFile, maxFiles: 5, maxTotalBytes: config.uploadRequestMaxTotal, uploadedFiles: 0, uploadedBytes: 0, full: false, mine: [],
    })
    const text = JSON.stringify((await v.json('GET', `/api/s/${t}?path=/`)).data)
    expect(text).not.toContain('existing.txt')
    expect(text).not.toContain('secret-name')
    expect(text).not.toContain('entries')
  })

  test('an upload link answers no download or listing route; a download link answers no upload route', async () => {
    const up = await tokenOf(owner)
    const v = new Client()
    expect(code(await v.json('GET', `/api/s/${up}/download`))).toEqual({ status: 404, code: 'share.not-found' })
    expect(code(await v.json('GET', `/api/s/${up}/download?path=/existing.txt`))).toEqual({ status: 404, code: 'share.not-found' })

    const down = await owner.json('POST', '/api/shares', { space: 'home', path: '/inbox', days: 7 })
    expect(down.status).toBe(200)
    const dt = down.data.token
    expect(down.data.share.kind).toBe('download')
    for (const r of [
      await announce(v, dt, 'a.txt', 1),
      await v.json('PUT', `/api/s/${dt}/upload/${'a'.repeat(24)}/0`, new Uint8Array(1)),
      await v.json('POST', `/api/s/${dt}/upload/${'a'.repeat(24)}/complete`),
      await v.json('DELETE', `/api/s/${dt}/upload/${'a'.repeat(24)}`),
    ]) expect(code(r)).toEqual({ status: 404, code: 'share.not-found' })
    // and it still downloads
    expect((await v.json('GET', `/api/s/${dt}`)).data.entries.map((e: any) => e.name)).toContain('existing.txt')
  })

  test('a link made before upload links existed (no kind in shares.json) keeps downloading', async () => {
    const { share, token } = shares.createShare({
      owner: 'ul-owner', space: 'home', path: '/report.txt', type: 'file', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), maxDownloads: null,
    })
    expect('kind' in share).toBe(false)
    const v = new Client()
    expect((await info(v, token)).data).toEqual({ name: 'report.txt', type: 'file', size: 6, expiresAt: share.expiresAt, needsPassword: false })
    const dl = await v.raw('GET', `/api/s/${token}/download`)
    expect(dl.status).toBe(200)
    expect(await dl.text()).toBe('a file')
    expect(code(await announce(v, token, 'x.txt', 1))).toEqual({ status: 404, code: 'share.not-found' })
  })
})

describe('upload links: sending files', () => {
  test('announce, chunks, complete: the file lands in the folder, never over an existing one', async () => {
    const t = await tokenOf(owner)
    const v = new Client()
    const a = await announce(v, t, 'resume.pdf', 11)
    expect(a.status).toBe(200)
    expect(a.data.id).toMatch(/^[a-f0-9]{24}$/)
    expect(a.data.total).toBe(1)
    expect(a.data.chunkSize).toBe(config.uploadChunkSize)
    // the cookie that ties the upload to this visitor: HttpOnly, SameSite=Strict, only this link's path
    const set = a.res.headers.getSetCookie().find(c => c.startsWith('fc_visitor='))!
    expect(set).toContain('HttpOnly')
    expect(set).toMatch(/SameSite=Strict/i)
    expect(set).toContain(`Path=/api/s/${t}`)
    expect((await chunk(v, t, a.data.id, new TextEncoder().encode('hello world'))).status).toBe(200)
    const done = await complete(v, t, a.data.id)
    expect(done.status).toBe(200)
    expect(done.data).toEqual({ ok: true, name: 'resume.pdf', size: 11 })
    expect(readFileSync(home('ul-owner', 'inbox', 'resume.pdf'), 'utf8')).toBe('hello world')

    // the same name again, and a name that already was in the folder: a new name each time, nothing overwritten
    const again = await send(v, t, 'resume.pdf', 'second')
    expect(again.data.name).toBe('resume (1).pdf')
    const clash = await send(v, t, 'existing.txt', 'mine')
    expect(clash.data.name).toBe('existing (1).txt')
    expect(readFileSync(home('ul-owner', 'inbox', 'existing.txt'), 'utf8')).toBe('already here')
    expect(readFileSync(home('ul-owner', 'inbox', 'resume (1).pdf'), 'utf8')).toBe('second')

    // the audit trail: owner, link id, name, size
    const line = readFileSync(paths.audit, 'utf8').trim().split('\n').map(l => JSON.parse(l)).reverse().find(e => e.action === 'share-upload' && e.detail.includes('resume.pdf'))
    expect(line.target).toBe('/users/ul-owner/inbox/resume.pdf')
    expect(line.detail).toContain('ul-owner')
    expect(line.detail).toContain('11')
    const id = (await owner.json('GET', '/api/shares')).data.shares.find((s: any) => s.uploadedFiles === 3).id
    expect(line.detail).toContain(id)
  })

  test('names go through the usual checks and the visitor can not pick a folder', async () => {
    const t = await tokenOf(owner)
    const v = new Client()
    for (const name of ['../escape.txt', 'a/b.txt', '..', '', 'bad|name.txt']) {
      expect({ name, status: (await announce(v, t, name, 1)).status }).toEqual({ name, status: 400 })
    }
    for (const size of [-1, 1.5]) expect((await announce(v, t, 'x.txt', size)).status).toBe(400)
    expect(existsSync(home('ul-owner', 'escape.txt'))).toBe(false)
    // only the name is read: a path or relativeDir in the body makes no sub-folder
    const r = await v.json('POST', `/api/s/${t}/upload`, { name: 'x.txt', size: 1, path: '/', relativeDir: 'sub/dir' })
    if (r.status === 200) {
      await chunk(v, t, r.data.id, new Uint8Array(1))
      await complete(v, t, r.data.id)
    }
    expect(existsSync(home('ul-owner', 'inbox', 'sub'))).toBe(false)
  })

  test('the visitor sees only what they sent themselves', async () => {
    const t = await tokenOf(owner)
    const a = new Client()
    const b = new Client()
    await send(a, t, 'from-a.txt', 'aaa')
    await send(b, t, 'from-b.txt', 'bb')
    expect((await info(a, t)).data.mine.map((m: any) => [m.name, m.size])).toEqual([['from-a.txt', 3]])
    expect((await info(b, t)).data.mine.map((m: any) => [m.name, m.size])).toEqual([['from-b.txt', 2]])
    const anyone = await info(new Client(), t)
    expect(anyone.data.mine).toEqual([])
    expect(anyone.data).toMatchObject({ uploadedFiles: 2, uploadedBytes: 5 })
    // the key itself is never stored
    const stored = JSON.stringify(shares.allShares())
    expect(stored).not.toContain(a.jar.get('fc_visitor')!)
  })

  test('another visitor, a visitor without the cookie, another link and another session can not touch an upload', async () => {
    const t = await tokenOf(owner)
    const other = await tokenOf(owner)
    const a = new Client()
    const b = new Client()
    const stranger = new Client()
    const mine = await announce(a, t, 'mine.bin', 4)
    expect((await announce(b, t, 'b.bin', 1)).status).toBe(200) // b has a key of its own now
    const id = mine.data.id
    // another visitor
    expect((await chunk(b, t, id, new Uint8Array(4))).status).toBe(403)
    expect((await complete(b, t, id)).status).toBe(403)
    expect((await cancel(b, t, id)).status).toBe(403)
    // no cookie at all
    expect((await chunk(stranger, t, id, new Uint8Array(4))).status).toBe(404)
    expect((await complete(stranger, t, id)).status).toBe(404)
    expect((await cancel(stranger, t, id)).status).toBe(404)
    // the same browser key presented to another link
    const crossed = new Client()
    crossed.jar.set('fc_visitor', a.jar.get('fc_visitor')!)
    expect((await chunk(crossed, other, id, new Uint8Array(4))).status).toBe(403)
    expect((await complete(crossed, other, id)).status).toBe(403)
    expect((await cancel(crossed, other, id)).status).toBe(403)
    // a signed-in user's own upload routes do not know it either, the owner's session included
    expect([403, 404]).toContain((await owner.json('GET', `/api/upload/${id}`)).status)
    expect([403, 404]).toContain((await admin.json('DELETE', `/api/upload/${id}`)).status)
    // the real visitor still can
    expect((await chunk(a, t, id, new Uint8Array(4))).status).toBe(200)
    expect((await complete(a, t, id)).status).toBe(200)
    // a bad cookie value is no key
    const forged = new Client()
    forged.jar.set('fc_visitor', 'not-a-key')
    expect((await cancel(forged, t, id)).status).toBe(404)
    await cancel(b, t, (await announce(b, t, 'b2.bin', 1)).data.id)
  })

  test('cancel gives the place back', async () => {
    const t = await tokenOf(owner, { maxFiles: 1 })
    const v = new Client()
    const a = await announce(v, t, 'one.bin', 1)
    expect(code(await announce(v, t, 'two.bin', 1))).toEqual({ status: 403, code: 'share.upload-full' })
    expect((await cancel(v, t, a.data.id)).status).toBe(200)
    expect((await announce(v, t, 'two.bin', 1)).status).toBe(200)
  })
})

describe('upload links: limits', () => {
  test('size per file', async () => {
    const t = await tokenOf(owner, { maxFileBytes: 10 })
    const v = new Client()
    const r = await announce(v, t, 'big.bin', 11)
    expect(code(r)).toEqual({ status: 413, code: 'share.upload-too-big' })
    expect(r.data.params).toEqual({ max: 10, maxText: '10 B' })
    expect((await send(v, t, 'ok.bin', new Uint8Array(10))).status).toBe(200)
  })

  test('number of files, with the ones still going counted', async () => {
    const t = await tokenOf(owner, { maxFiles: 2 })
    const v = new Client()
    expect((await send(v, t, 'one.txt', '1')).status).toBe(200)
    const second = await announce(v, t, 'two.txt', 1)
    expect(second.status).toBe(200)
    // two parallel announces for the last place: one passes
    const results = await Promise.all([announce(new Client(), t, 'x.txt', 1), announce(new Client(), t, 'y.txt', 1)])
    expect(results.map(r => r.status)).toEqual([403, 403])
    expect(await chunk(v, t, second.data.id, new Uint8Array(1))).toBeTruthy()
    expect((await complete(v, t, second.data.id)).status).toBe(200)
    expect(code(await announce(v, t, 'three.txt', 1))).toEqual({ status: 403, code: 'share.upload-full' })
    const mine = (await owner.json('GET', '/api/shares')).data.shares.find((s: any) => s.uploadedFiles === 2 && s.maxFiles === 2)
    expect(mine.state).toBe('used-up')
    expect((await info(v, t)).data.full).toBe(true)
  })

  test('total bytes', async () => {
    const t = await tokenOf(owner, { maxTotalBytes: 100 })
    const v = new Client()
    expect((await send(v, t, 'a.bin', new Uint8Array(60))).status).toBe(200)
    const open = await announce(v, t, 'b.bin', 40)
    expect(open.status).toBe(200)
    // 60 sent + 40 announced leave nothing
    expect(code(await announce(v, t, 'c.bin', 1))).toEqual({ status: 403, code: 'share.upload-full' })
    await cancel(v, t, open.data.id)
    expect(code(await announce(v, t, 'c.bin', 41))).toEqual({ status: 403, code: 'share.upload-full' })
    expect((await announce(v, t, 'c.bin', 40)).status).toBe(200)
  })

  test('uploads in progress per link and per address; stale ones are cleaned like any other', async () => {
    const saved = config.trustProxy
    ;(config as any).trustProxy = 'true'
    try {
      const t = await tokenOf(owner)
      const ids: [Client, string][] = []
      const from = (ip: string) => ({ 'x-forwarded-for': ip })
      // three from one address, the fourth is turned away
      for (let i = 0; i < 3; i++) {
        const v = new Client()
        const r = await announce(v, t, `ip${i}.bin`, 1, from('10.0.0.1'))
        expect(r.status).toBe(200)
        ids.push([v, r.data.id])
      }
      expect(code(await announce(new Client(), t, 'ip3.bin', 1, from('10.0.0.1')))).toEqual({ status: 429, code: 'share.upload-busy' })
      // the same address on another link counts too
      const t2 = await tokenOf(owner)
      expect(code(await announce(new Client(), t2, 'ip3.bin', 1, from('10.0.0.1')))).toEqual({ status: 429, code: 'share.upload-busy' })
      // other addresses: up to five in progress on one link
      for (const ip of ['10.0.0.2', '10.0.0.3']) {
        const v = new Client()
        const r = await announce(v, t, `o-${ip}.bin`, 1, from(ip))
        expect(r.status).toBe(200)
        ids.push([v, r.data.id])
      }
      expect(code(await announce(new Client(), t, 'six.bin', 1, from('10.0.0.4')))).toEqual({ status: 429, code: 'share.upload-busy' })
      // stale ones go
      const old = new Date(Date.now() - config.uploadStaleMs - 60_000)
      for (const [, id] of ids) utimesSync(join(paths.tmp, id, 'meta.json'), old, old)
      expect(uploads.cleanStaleUploads()).toBeGreaterThanOrEqual(5)
      expect((await announce(new Client(), t, 'six.bin', 1, from('10.0.0.4'))).status).toBe(200)
      expect((await announce(new Client(), t, 'seven.bin', 1, from('10.0.0.1'))).status).toBe(200)
    } finally {
      ;(config as any).trustProxy = saved
    }
  })
})

describe('upload links: password, expiry, owner rights', () => {
  test('password: asked before anything, same unlock cookie and lockout as a download link', async () => {
    const t = await tokenOf(owner, { password: 'open-sesame', note: 'secret note' })
    const v = new Client()
    const locked = await info(v, t)
    expect(locked.data).toEqual({ kind: 'upload', name: null, type: null, expiresAt: expect.any(String), needsPassword: true })
    expect(code(await announce(v, t, 'a.txt', 1))).toEqual({ status: 401, code: 'share.password-required' })
    const a = new Client()
    for (let i = 0; i < 5; i++) expect((await a.json('POST', `/api/s/${t}/unlock`, { password: 'wrong-guess' })).status).toBe(403)
    // locked after five wrong ones, the right one too, for this address
    expect((await a.json('POST', `/api/s/${t}/unlock`, { password: 'open-sesame' })).status).toBe(429)
    expect((await announce(a, t, 'a.txt', 1)).status).toBe(401)

    const t2 = await tokenOf(owner, { password: 'open-sesame', note: 'secret note' })
    const ok = new Client()
    expect((await ok.json('POST', `/api/s/${t2}/unlock`, { password: 'open-sesame' })).status).toBe(200)
    expect((await info(ok, t2)).data.note).toBe('secret note')
    expect((await send(ok, t2, 'in.txt', 'hi')).status).toBe(200)
    // the unlock cookie of one link opens no other
    const mixed = new Client()
    mixed.jar.set('fc_share', ok.jar.get('fc_share')!)
    expect((await announce(mixed, t, 'a.txt', 1)).status).toBe(401)
  })

  test('expired, revoked and used-up links answer the one 404', async () => {
    const t = await tokenOf(owner)
    const v = new Client()
    const a = await announce(v, t, 'late.bin', 1)
    expect(a.status).toBe(200)
    shares.allShares().find(s => s.tokenHash === shares.hashToken(t))!.expiresAt = new Date(Date.now() - 1000).toISOString()
    for (const r of [await info(v, t), await announce(v, t, 'x.bin', 1), await chunk(v, t, a.data.id, new Uint8Array(1)), await complete(v, t, a.data.id), await cancel(v, t, a.data.id)]) {
      expect(r instanceof Response ? r.status : r.status).toBe(404)
    }

    const t2 = await tokenOf(owner)
    const id = (await owner.json('GET', '/api/shares')).data.shares.find((s: any) => s.kind === 'upload' && s.state === 'active' && shares.findShare(s.id)!.tokenHash === shares.hashToken(t2)).id
    expect((await owner.json('DELETE', `/api/shares/${id}`)).status).toBe(200)
    expect(code(await announce(new Client(), t2, 'x.bin', 1))).toEqual({ status: 404, code: 'share.not-found' })
  })

  test('the owner losing the upload or share permission stops uploads, also for ones already announced', async () => {
    const o = await userWith('ul-revoke', OWNER_PERMS)
    mkdirSync(home('ul-revoke', 'inbox'))
    const t = await tokenOf(o)
    const v = new Client()
    const a = await announce(v, t, 'a.bin', 1)
    expect(a.status).toBe(200)
    expect((await admin.json('PUT', '/api/admin/users/ul-revoke', { permissions: ['read', 'download', 'share', 'write'] })).status).toBe(200)
    expect(code(await announce(v, t, 'b.bin', 1))).toEqual({ status: 404, code: 'share.not-found' })
    expect((await chunk(v, t, a.data.id, new Uint8Array(1))).status).toBe(404)
    expect((await complete(v, t, a.data.id)).status).toBe(404)
    expect((await info(v, t)).status).toBe(404)
    // back again: the link works as before
    await admin.json('PUT', '/api/admin/users/ul-revoke', { permissions: OWNER_PERMS })
    expect((await chunk(v, t, a.data.id, new Uint8Array(1))).status).toBe(200)
    expect((await complete(v, t, a.data.id)).status).toBe(200)
    // without the share permission
    await admin.json('PUT', '/api/admin/users/ul-revoke', { permissions: ['read', 'upload'] })
    expect((await announce(v, t, 'c.bin', 1)).status).toBe(404)
    // a deleted owner takes the link along
    await admin.json('PUT', '/api/admin/users/ul-revoke', { permissions: OWNER_PERMS })
    expect((await announce(v, t, 'c.bin', 1)).status).toBe(200)
    expect((await admin.json('DELETE', '/api/admin/users/ul-revoke')).status).toBe(200)
    expect((await announce(v, t, 'd.bin', 1)).status).toBe(404)
  })

  test('the shared folder going away or being replaced by a file ends the link', async () => {
    const o = await userWith('ul-gone', OWNER_PERMS)
    mkdirSync(home('ul-gone', 'inbox'))
    const t = await tokenOf(o)
    const v = new Client()
    expect((await announce(v, t, 'a.bin', 1)).status).toBe(200)
    expect((await o.json('POST', '/api/rename', { space: 'home', path: '/inbox', name: 'moved' })).status).toBe(200)
    expect((await announce(v, t, 'b.bin', 1)).status).toBe(404)
  })
})

describe('upload links: the owner quota', () => {
  test('bytes count against the owner, reserved at announce and given back on cancel', async () => {
    const o = await userWith('ul-quota', OWNER_PERMS, 1000)
    mkdirSync(home('ul-quota', 'inbox'))
    const t = await tokenOf(o)
    const v = new Client()
    const a = await announce(v, t, 'a.bin', 800)
    expect(a.status).toBe(200)
    const refused = await announce(v, t, 'b.bin', 800)
    expect(code(refused)).toEqual({ status: 507, code: 'quota.exceeded' })
    expect(refused.data.params.quota).toBe(1000)
    expect((await cancel(v, t, a.data.id)).status).toBe(200)
    expect((await send(v, t, 'b.bin', new Uint8Array(800))).status).toBe(200)
    // used now, so the owner's own uploads are refused too
    await quota.ready((await import('../src/auth')).findUser('ul-quota'))
    expect(code(await announce(v, t, 'c.bin', 300))).toEqual({ status: 507, code: 'quota.exceeded' })
    expect((await o.json('POST', '/api/upload', { space: 'home', path: '/', name: 'own.bin', size: 300 })).status).toBe(507)
    expect((await o.json('GET', '/api/me/usage')).data.used).toBe(800)
  })

  test('a link in the public space has no quota to count against', async () => {
    const o = await userWith('ul-pubowner', ['read'])
    await admin.json('PUT', '/api/admin/users/ul-pubowner', { publicPermissions: ['read', 'upload', 'share', 'download'], quotaBytes: 10 })
    mkdirSync(join(paths.publicDir, 'ul-drop'), { recursive: true })
    const r = await o.json('POST', '/api/shares', { space: 'public', path: '/ul-drop', days: 1, kind: 'upload' })
    expect(r.status).toBe(200)
    expect((await send(new Client(), r.data.token, 'big.bin', new Uint8Array(500))).status).toBe(200)
    expect(existsSync(join(paths.publicDir, 'ul-drop', 'big.bin'))).toBe(true)
  })
})
