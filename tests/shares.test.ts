/**
 * Share links: a signed-in user hands out a link so someone without an account can download one file or one folder.
 * Runs in-process on the same app as api.test.ts (see in-process-env.ts); every user here starts with "sh-".
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import './in-process-env'

let app: any
let shares: typeof import('../src/shares')
let config: typeof import('../src/config').config
let paths: typeof import('../src/config').paths
let logger: typeof import('../src/logger')

class Client {
  /** the session cookie only; a share cookie is passed by hand, like a browser would for its own path */
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
/** no session at all: what someone who only got the link has */
const anon = new Client()
/** every token handed out here, to make sure none of them lands in a log */
const tokens: string[] = []
const home = (user: string, ...p: string[]) => join(process.env.STORAGE_DIR!, 'users', user, ...p)

async function userWith(username: string, permissions: string[], publicPermissions: string[] = [], role = 'user') {
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role, permissions, publicPermissions })
  expect(r.status).toBe(200)
  return new Client().login(username, PW)
}

async function share(c: Client, body: Record<string, unknown>) {
  const r = await c.json('POST', '/api/shares', { space: 'home', days: 7, ...body })
  if (r.status === 200) tokens.push(r.data.token)
  return r
}

const info = (token: string, query = '', headers: Record<string, string> = {}) => anon.json('GET', `/api/s/${token}${query}`, undefined, headers)
const download = (token: string, query = '', headers: Record<string, string> = {}) => anon.raw('GET', `/api/s/${token}/download${query}`, undefined, headers)
const unlock = (token: string, password: string) => anon.raw('POST', `/api/s/${token}/unlock`, { password })
const statusOf = (token: string) => info(token).then(r => r.status)

let owner: Client

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config, paths } = await import('../src/config'))
  shares = await import('../src/shares')
  logger = await import('../src/logger')
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
  owner = await userWith('sh-owner', ['read', 'write', 'download', 'share'], ['read', 'download', 'share'])
  writeFileSync(home('sh-owner', 'report.txt'), 'report')
  mkdirSync(home('sh-owner', 'proj', 'sub'), { recursive: true })
  writeFileSync(home('sh-owner', 'proj', 'a.txt'), 'aaa')
  writeFileSync(home('sh-owner', 'proj', 'sub', 'b.txt'), 'bbb')
  mkdirSync(home('sh-owner', 'secret'))
  writeFileSync(home('sh-owner', 'secret', 's.txt'), 'top secret')
  // one link leaves the shared folder (still inside the owner's space), one stays inside it
  symlinkSync(home('sh-owner', 'secret'), home('sh-owner', 'proj', 'out-link'))
  symlinkSync(home('sh-owner', 'proj', 'sub'), home('sh-owner', 'proj', 'inner-link'))
  symlinkSync(home('sh-owner', 'report.txt'), home('sh-owner', 'report-link.txt'))
})

describe('share links: making and managing them', () => {
  test('create, list, download, revoke', async () => {
    const r = await share(owner, { path: '/report.txt' })
    expect(r.status).toBe(200)
    const { token, share: s } = r.data
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(r.data.url).toBe(`/s/${token}`)
    expect(s).toMatchObject({ owner: 'sh-owner', space: 'home', path: '/report.txt', type: 'file', downloads: 0, maxDownloads: null, hasPassword: false, state: 'active' })
    expect(Date.parse(s.expiresAt) - Date.now()).toBeGreaterThan(7 * 86_400_000 - 60_000)

    const mine = await owner.json('GET', '/api/shares')
    expect(mine.data.shares.map((x: any) => x.id)).toContain(s.id)
    const text = JSON.stringify(mine.data)
    expect(text).not.toContain('tokenHash')
    expect(text).not.toContain('passwordHash')
    expect(text).not.toContain(token)

    const pub = await info(token)
    expect(pub.status).toBe(200)
    expect(pub.data).toEqual({ name: 'report.txt', type: 'file', size: 6, expiresAt: s.expiresAt, needsPassword: false })
    const dl = await download(token)
    expect(dl.status).toBe(200)
    expect(await dl.text()).toBe('report')
    // the same locked-down headers as /api/download
    expect(dl.headers.get('content-security-policy')).toContain('sandbox')
    expect(dl.headers.get('content-disposition')).toStartWith('attachment;')
    expect(dl.headers.get('x-content-type-options')).toBe('nosniff')

    // someone else can not revoke it (and does not learn it exists), the owner can
    const other = await userWith('sh-other', ['read', 'download', 'share'])
    expect((await other.json('DELETE', `/api/shares/${s.id}`)).status).toBe(404)
    expect((await other.json('GET', '/api/shares')).data.shares).toEqual([])
    expect((await owner.json('DELETE', `/api/shares/${s.id}`)).status).toBe(200)
    const gone = await info(token)
    expect(gone.status).toBe(404)
    expect(gone.data.code).toBe('share.not-found')
    expect((await download(token)).status).toBe(404)
    expect((await owner.json('GET', '/api/shares')).data.shares.find((x: any) => x.id === s.id).state).toBe('revoked')

    // an admin may revoke anyone's link
    const second = await share(owner, { path: '/report.txt' })
    expect((await admin.json('DELETE', `/api/shares/${second.data.share.id}`)).status).toBe(200)
    expect(await statusOf(second.data.token)).toBe(404)
  })

  test('the store keeps the SHA-256 of the token, never the token', async () => {
    const r = await share(owner, { path: '/report.txt', password: 'open-sesame' })
    const { JsonStore } = await import('../src/store')
    await JsonStore.flushAll()
    const raw = readFileSync(paths.shares, 'utf8')
    expect(raw).not.toContain(r.data.token)
    expect(raw).not.toContain('open-sesame')
    const stored = JSON.parse(raw).shares.find((x: any) => x.id === r.data.share.id)
    expect(stored.tokenHash).toBe(createHash('sha256').update(r.data.token).digest('hex'))
    expect(stored.passwordHash).toStartWith('$argon2')
  })

  test('admins see every link, others may not ask', async () => {
    const a = await admin.json('GET', '/api/admin/shares')
    expect(a.status).toBe(200)
    expect(new Set(a.data.shares.map((x: any) => x.owner))).toContain('sh-owner')
    expect(JSON.stringify(a.data)).not.toContain('tokenHash')
    expect((await owner.json('GET', '/api/admin/shares')).status).toBe(403)
    expect((await anon.json('GET', '/api/admin/shares')).status).toBe(401)
    expect((await anon.json('GET', '/api/shares')).status).toBe(401)
  })

  test('what a link may be', async () => {
    const code = async (body: Record<string, unknown>) => {
      const r = await share(owner, { path: '/report.txt', ...body })
      return `${r.status} ${r.data?.code ?? ''}`.trim()
    }
    expect(await code({ days: 3 })).toBe('400 share.bad-days')
    expect(await code({ days: 31 })).toBe('400 share.bad-days')
    expect(await code({ days: 1 })).toBe('200')
    expect(await code({ days: 30 })).toBe('200')
    expect(await code({ maxDownloads: 0 })).toBe('400 share.bad-max-downloads')
    expect(await code({ maxDownloads: 1.5 })).toBe('400 share.bad-max-downloads')
    expect(await code({ password: '12345' })).toBe('400 share.password-too-short')
    expect(await code({ password: 'x'.repeat(201) })).toBe('400 auth.password-too-long')
    expect(await code({ path: '/' })).toBe('400 files.root-item')
    expect(await code({ path: '/missing.txt' })).toBe('404 request.not-found')
    expect(await code({ path: '/report-link.txt' })).toBe('404 request.not-found')
    expect(await code({ path: '/../../etc/passwd' })).toBe('400 fs.bad-path')
    // SHARE_MAX_DAYS takes the longer choices away
    const before = config.shareMaxDays
    config.shareMaxDays = 7
    try {
      const r = await share(owner, { path: '/report.txt', days: 30 })
      expect(r.status).toBe(400)
      expect(r.data.params).toEqual({ days: '1, 7' })
      expect(await code({ days: 7 })).toBe('200')
      // the share dialog learns the same choices from the session, so it never offers one the server refuses
      expect((await owner.json('GET', '/api/session')).data.config.shareDays).toEqual([1, 7])
    } finally {
      config.shareMaxDays = before
    }
    expect((await owner.json('GET', '/api/session')).data.config.shareDays).toEqual([1, 7, 30])
    // visitors cannot share, so they are not told
    expect((await new Client().json('GET', '/api/session')).data.config.shareDays).toBeUndefined()
  })
})

describe('share links: who may make them', () => {
  test('users need share AND download on the space of the item', async () => {
    const noShare = await userWith('sh-noshare', ['read', 'write', 'download'], ['read', 'download'])
    writeFileSync(home('sh-noshare', 'f.txt'), 'f')
    expect((await share(noShare, { path: '/f.txt' })).status).toBe(403)

    const noDownload = await userWith('sh-nodl', ['read', 'write', 'share'], ['read', 'share'])
    writeFileSync(home('sh-nodl', 'f.txt'), 'f')
    expect((await share(noDownload, { path: '/f.txt' })).status).toBe(403)

    // rights in one space say nothing about the other
    const homeOnly = await userWith('sh-homeonly', ['read', 'download', 'share'], ['read', 'download'])
    writeFileSync(home('sh-homeonly', 'f.txt'), 'f')
    writeFileSync(join(paths.publicDir, 'sh-pub.txt'), 'pub')
    expect((await share(homeOnly, { path: '/f.txt' })).status).toBe(200)
    expect((await share(homeOnly, { space: 'public', path: '/sh-pub.txt' })).status).toBe(403)
    const pub = await share(owner, { space: 'public', path: '/sh-pub.txt' })
    expect(pub.status).toBe(200)
    expect(await (await download(pub.data.token)).text()).toBe('pub')
  })

  test('visitors never, whatever the guest permissions say', async () => {
    writeFileSync(join(paths.publicDir, 'sh-guest.txt'), 'g')
    const before = (await admin.json('GET', '/api/admin/settings')).data.guestPermissions
    expect((await admin.json('PUT', '/api/admin/settings', { guestPermissions: ['read', 'download', 'share'] })).status).toBe(200)
    try {
      const visitor = new Client()
      visitor.csrf = (await visitor.json('GET', '/api/session')).data.csrf
      const r = await share(visitor, { space: 'public', path: '/sh-guest.txt' })
      expect(r.status).toBe(401)
      expect(r.data.code).toBe('auth.required')
    } finally {
      await admin.json('PUT', '/api/admin/settings', { guestPermissions: before })
    }
  })

  test('admins always may, even without share in their own list', async () => {
    const other = await userWith('sh-admin2', [], [], 'admin')
    expect((await share(other, { path: '/users/sh-owner/report.txt' })).status).toBe(200)
    expect((await share(admin, { space: 'public', path: '/sh-guest.txt' })).status).toBe(200)
  })
})

describe('share links: a shared folder', () => {
  let token = ''
  beforeAll(async () => {
    const r = await share(owner, { path: '/proj' })
    expect(r.status).toBe(200)
    token = r.data.token
  })

  test('lists its own content by path, links left out', async () => {
    const top = await info(token)
    expect(top.status).toBe(200)
    expect(top.data).toMatchObject({ name: 'proj', type: 'dir', size: 6, needsPassword: false, path: '/' })
    expect(top.data.entries.map((e: any) => e.name)).toEqual(['sub', 'a.txt'])
    const sub = await info(token, '?path=/sub')
    expect(sub.data.entries.map((e: any) => [e.name, e.path])).toEqual([['b.txt', '/sub/b.txt']])
  })

  test('never leaves the shared folder', async () => {
    const tricks = [
      '/..', '..', '%2e%2e', '%2E%2E%2Fsecret', '/sub/../../secret', '..%2fsecret', '..%5csecret', '/sub/..%2f..%2fsecret',
      '/out-link', '/out-link/', '%2fout-link', '/inner-link', '/a.txt',
    ]
    for (const p of tricks) {
      const r = await info(token, `?path=${p}`)
      expect(`${p} ${r.status}`).not.toBe(`${p} 200`)
      expect(JSON.stringify(r.data)).not.toContain('s.txt')
    }
    for (const p of ['/out-link/s.txt', '/../secret/s.txt', '..%2fsecret%2fs.txt', '%2e%2e/secret/s.txt', '/inner-link/b.txt', '/out-link']) {
      const r = await download(token, `?path=${p}`)
      expect(`${p} ${r.status}`).not.toBe(`${p} 200`)
      expect(await r.text()).not.toContain('top secret')
    }
  })

  test('downloads a file inside, a sub folder or the whole folder (as zip)', async () => {
    const f = await download(token, '?path=/sub/b.txt')
    expect(f.status).toBe(200)
    expect(await f.text()).toBe('bbb')

    const whole = await download(token)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-type')).toBe('application/zip')
    expect(whole.headers.get('content-disposition')).toContain('proj.zip')
    const all = unzipSync(new Uint8Array(await whole.arrayBuffer()))
    expect(Object.keys(all).filter(n => !n.endsWith('/')).sort()).toEqual(['proj/a.txt', 'proj/sub/b.txt'])
    expect(new TextDecoder().decode(all['proj/a.txt'])).toBe('aaa')

    const sub = await download(token, '?path=/sub')
    const part = unzipSync(new Uint8Array(await sub.arrayBuffer()))
    expect(Object.keys(part).filter(n => !n.endsWith('/'))).toEqual(['sub/b.txt'])

    // a file link has nothing inside
    const file = await share(owner, { path: '/report.txt' })
    expect((await download(file.data.token, '?path=/x')).status).toBe(404)
    expect((await download(file.data.token, '?path=/')).status).toBe(200)
  })

  test('a failed download in the tab gets the error page', async () => {
    const r = await download('A'.repeat(43), '', { 'sec-fetch-mode': 'navigate', accept: 'text/html' })
    expect(r.status).toBe(404)
    expect(r.headers.get('content-type')).toContain('text/html')
    // the internal code goes in a header, the page shows only the message and the status
    expect(r.headers.get('x-error-code')).toBe('share.not-found')
    expect(await r.text()).not.toContain('share.not-found')
  })
})

describe('share links: password', () => {
  test('a password opens only its own link, wrong guesses are locked out per link', async () => {
    const a = (await share(owner, { path: '/report.txt', password: 'open-sesame' })).data.token
    const b = (await share(owner, { path: '/proj', password: 'open-sesame' })).data.token

    const locked = await info(a)
    expect(locked.status).toBe(200)
    // nothing about the item before the password
    expect(locked.data).toEqual({ name: null, type: null, size: null, expiresAt: expect.any(String), needsPassword: true })
    const refused = await download(a)
    expect(refused.status).toBe(401)
    expect((await refused.json()).code).toBe('share.password-required')

    // no session, no CSRF token: the form works for someone who only has the link
    const wrong = await unlock(a, 'nope-nope')
    expect(wrong.status).toBe(403)
    expect((await wrong.json()).code).toBe('auth.wrong-password')
    const right = await unlock(a, 'open-sesame')
    expect(right.status).toBe(200)
    const setCookie = right.headers.get('set-cookie')!
    expect(setCookie).toContain(`Path=/api/s/${a}`)
    expect(setCookie).toContain('HttpOnly')
    const cookie = setCookie.split(';')[0]
    expect(cookie).toStartWith('fc_share=')

    expect((await info(a, '', { cookie })).data).toMatchObject({ name: 'report.txt', needsPassword: false })
    expect(await (await download(a, '', { cookie })).text()).toBe('report')
    // the same cookie does nothing for another link with the same password
    expect((await info(b, '', { cookie })).data.needsPassword).toBe(true)
    expect((await download(b, '', { cookie })).status).toBe(401)
    // nor does a made-up one
    expect((await download(a, '', { cookie: `fc_share=${Date.now() + 60_000}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` })).status).toBe(401)

    // 5 wrong tries lock that link for this address; the right password does not help then
    for (let i = 0; i < 5; i++) expect((await unlock(b, `guess-${i}xx`)).status).toBe(403)
    const lockedOut = await unlock(b, 'open-sesame')
    expect(lockedOut.status).toBe(429)
    const body = await lockedOut.json()
    expect(body.code).toBe('auth.confirm-locked')
    expect(body.params.seconds).toBeGreaterThan(14 * 60)
    // the other link is not affected
    expect((await unlock(a, 'open-sesame')).status).toBe(200)
    // a link without a password needs no unlocking
    const open = (await share(owner, { path: '/report.txt' })).data.token
    expect((await unlock(open, 'anything')).status).toBe(200)
  })
})

describe('share links: when they stop working', () => {
  test('expired links answer 404 and are cleaned from the store', async () => {
    const r = await share(owner, { path: '/report.txt', days: 1 })
    const s = shares.findShare(r.data.share.id)!
    s.expiresAt = new Date(Date.now() - 1000).toISOString()
    expect(await statusOf(r.data.token)).toBe(404)
    expect((await download(r.data.token)).status).toBe(404)
    expect((await owner.json('GET', '/api/shares')).data.shares.find((x: any) => x.id === s.id).state).toBe('expired')
    expect(shares.purgeExpiredShares()).toBeGreaterThanOrEqual(1)
    expect(shares.findShare(s.id)).toBeUndefined()
    // links still running stay
    expect(shares.allShares().length).toBeGreaterThan(0)
  })

  test('maxDownloads counts finished downloads only, once each', async () => {
    const r = await share(owner, { path: '/report.txt', maxDownloads: 2 })
    const token = r.data.token
    // with a limit, a Range request still gets (and counts) the whole file
    const first = await download(token, '', { range: 'bytes=0-1' })
    expect(first.status).toBe(200)
    expect(first.headers.get('accept-ranges')).toBe('none')
    expect(await first.text()).toBe('report')
    expect(shares.findShare(r.data.share.id)!.downloads).toBe(1)

    // a download under way holds the last place...
    const running = await download(token)
    expect(running.status).toBe(200)
    expect((await download(token)).status).toBe(404)
    // ...and gives it back when cancelled, without counting
    await running.body!.cancel()
    expect(shares.findShare(r.data.share.id)!.downloads).toBe(1)
    const last = await download(token)
    expect(await last.text()).toBe('report')
    expect(shares.findShare(r.data.share.id)!.downloads).toBe(2)

    expect(await statusOf(token)).toBe(404)
    expect((await download(token)).status).toBe(404)
    expect((await owner.json('GET', '/api/shares')).data.shares.find((x: any) => x.id === r.data.share.id)).toMatchObject({ downloads: 2, state: 'used-up' })
  })

  test('without a limit parts of a file may be fetched; only whole downloads count', async () => {
    const r = await share(owner, { path: '/report.txt' })
    const part = await download(r.data.token, '', { range: 'bytes=0-1' })
    expect(part.status).toBe(206)
    expect(await part.text()).toBe('re')
    expect(shares.findShare(r.data.share.id)!.downloads).toBe(0)
    await (await download(r.data.token)).text()
    expect(shares.findShare(r.data.share.id)!.downloads).toBe(1)
  })

  test('the item deleted, moved or turned into something else', async () => {
    mkdirSync(home('sh-owner', 'gone'))
    writeFileSync(home('sh-owner', 'gone', 'm.txt'), 'm')
    writeFileSync(home('sh-owner', 'gone', 't.txt'), 't')
    const moved = (await share(owner, { path: '/gone/m.txt' })).data.token
    const changed = (await share(owner, { path: '/gone/t.txt' })).data.token
    const deleted = (await share(owner, { path: '/gone' })).data.token
    for (const t of [moved, changed, deleted]) expect(await statusOf(t)).toBe(200)

    expect((await owner.json('POST', '/api/rename', { space: 'home', path: '/gone/m.txt', name: 'm2.txt' })).status).toBe(200)
    expect(await statusOf(moved)).toBe(404)
    rmSync(home('sh-owner', 'gone', 't.txt'))
    mkdirSync(home('sh-owner', 'gone', 't.txt'))
    expect(await statusOf(changed)).toBe(404)
    expect((await owner.json('POST', '/api/delete', { space: 'home', items: ['/gone'] })).data.done).toBe(1)
    expect(await statusOf(deleted)).toBe(404)
    expect((await download(deleted)).status).toBe(404)
  })

  test('the owner losing share or download, or deleted', async () => {
    const c = await userWith('sh-leaver', ['read', 'download', 'share'])
    writeFileSync(home('sh-leaver', 'l.txt'), 'l')
    const token = (await share(c, { path: '/l.txt' })).data.token
    expect(await statusOf(token)).toBe(200)
    await admin.json('PUT', '/api/admin/users/sh-leaver', { permissions: ['read', 'download'] })
    expect(await statusOf(token)).toBe(404)
    await admin.json('PUT', '/api/admin/users/sh-leaver', { permissions: ['read', 'share'] })
    expect(await statusOf(token)).toBe(404)
    await admin.json('PUT', '/api/admin/users/sh-leaver', { permissions: ['read', 'download', 'share'] })
    expect(await statusOf(token)).toBe(200)

    expect((await admin.json('DELETE', '/api/admin/users/sh-leaver')).status).toBe(200)
    expect(await statusOf(token)).toBe(404)
    // a new account by the same name does not bring the old links back
    await userWith('sh-leaver', ['read', 'download', 'share'])
    expect(await statusOf(token)).toBe(404)
    expect((await download(token)).status).toBe(404)
  })

  test('an unknown or malformed token gets the same answer', async () => {
    for (const t of ['A'.repeat(43), 'short', `${'A'.repeat(42)}~`, 'B'.repeat(44)]) {
      const r = await info(t)
      expect(`${t} ${r.status} ${r.data?.code}`).toBe(`${t} 404 share.not-found`)
    }
    expect((await unlock('A'.repeat(43), 'x')).status).toBe(404)
  })
})

describe('share links: audit and logs', () => {
  test('the audit trail has the path, never the token', async () => {
    const audit = readFileSync(paths.audit, 'utf8')
    const lines = audit.split('\n').filter(Boolean).map(l => JSON.parse(l))
    const of = (action: string) => lines.filter(l => l.action === action)
    expect(of('share-create').map(l => l.target)).toContain('/users/sh-owner/report.txt')
    expect(of('share-download').map(l => l.target)).toContain('/users/sh-owner/proj/sub/b.txt')
    expect(of('share-revoke').map(l => l.target)).toContain('/users/sh-owner/report.txt')
    expect(tokens.length).toBeGreaterThan(10)
    for (const t of tokens) expect(audit.includes(t) ? t : 'absent').toBe('absent')
  })

  test('share URLs are scrubbed from the system and access logs', async () => {
    const t = tokens[0]
    expect(logger.scrub(`GET /api/s/${t}/download?path=/secret`)).toBe('GET /api/s/***/download')
    expect(logger.safePath(`http://localhost/api/s/${t}`)).toBe('/api/s/***')
    expect(logger.safePath(`http://localhost/s/${t}`)).toBe('/s/***')
    // a folder that happens to be called "s" is left alone
    expect(logger.scrub('/users/bob/s/report.txt')).toBe('/users/bob/s/report.txt')

    logger.log.error('share-test', { url: `https://files.example/s/${t}`, path: `/api/s/${t}/unlock` })
    logger.accessLine({ method: 'GET', url: `http://localhost/api/s/${t}/download?path=/a`, status: 200, ms: 1, ip: '-', user: null })
    const system = readFileSync(paths.systemLog, 'utf8')
    const access = readFileSync(paths.accessLog, 'utf8')
    expect(system).toContain('share-test')
    expect(access).toContain('/api/s/***/download')
    for (const tok of tokens) {
      expect(system.includes(tok) ? tok : 'absent').toBe('absent')
      expect(access.includes(tok) ? tok : 'absent').toBe('absent')
    }
  })
})
