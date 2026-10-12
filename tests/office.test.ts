/**
 * Office documents through ONLYOFFICE Docs, and safer text saving. No real document server: a fake one here checks
 * the signed editor config the page would hand it, fetches the file with its own JWT the way ONLYOFFICE does, serves
 * the "saved" versions over HTTP and calls back. Runs in-process on the same app as api.test.ts (see
 * in-process-env.ts); every user here starts with "of-", and every OFFICE_* setting is put back afterwards.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import './in-process-env'

let app: any
let config: typeof import('../src/config').config
let paths: typeof import('../src/config').paths
let office: typeof import('../src/office')
let logger: typeof import('../src/logger')

class Client {
  cookie = ''
  csrf = ''
  async raw(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers }
    if (this.cookie) h.cookie = this.cookie
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
    return { status: res.status, data: (await res.json().catch(() => null)) as any }
  }
  async start() {
    this.csrf = (await this.json('GET', '/api/session')).data.csrf
    return this
  }
  async login(username: string, password: string) {
    await this.start()
    const r = await this.json('POST', '/api/login', { username, password })
    expect(r.status).toBe(200)
    this.csrf = r.data.csrf
    return this
  }
}

const PW = 'harbor-lamp-42'
const SECRET = randomBytes(24).toString('base64url') // 32 characters
const INTERNAL = 'http://file-center.internal:3000'
const admin = new Client()
const home = (user: string, ...p: string[]) => join(process.env.STORAGE_DIR!, 'users', user, ...p)

async function userWith(username: string, permissions: string[], publicPermissions: string[] = []) {
  const r = await admin.json('POST', '/api/admin/users', { username, name: `Name ${username}`, password: PW, role: 'user', permissions, publicPermissions })
  expect(r.status).toBe(200)
  return new Client().login(username, PW)
}

// ── JWT as the document server does it, written apart from src/office.ts so the two must agree
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url')
function sign(payload: object, secret = SECRET, alg = 'HS256') {
  const head = b64(JSON.stringify({ alg, typ: 'JWT' }))
  const body = b64(JSON.stringify(payload))
  return `${head}.${body}.${b64(createHmac('sha256', secret).update(`${head}.${body}`).digest())}`
}
function verify(token: string, secret = SECRET): any {
  const [head, body, mac] = token.split('.')
  if (JSON.parse(Buffer.from(head, 'base64url').toString()).alg !== 'HS256') return null
  if (b64(createHmac('sha256', secret).update(`${head}.${body}`).digest()) !== mac) return null
  return JSON.parse(Buffer.from(body, 'base64url').toString())
}

// ── the fake document server: serves saved versions under /cache/files/, records every request
const savedFiles = new Map<string, Uint8Array>()
const docRequests: string[] = []
let docServer: ReturnType<typeof Bun.serve>
const DOC = () => `http://127.0.0.1:${docServer.port}`

/** File Center as the document server reaches it (OFFICE_INTERNAL_URL): the same app, in-process */
function fc(url: string, init: RequestInit = {}) {
  expect(url.startsWith(`${INTERNAL}/`)).toBe(true)
  return app.handle(new Request('http://localhost' + url.slice(INTERNAL.length), init)) as Promise<Response>
}

/** what ONLYOFFICE does with the config the page hands it: check its signature, then fetch document.url with its own JWT */
async function openInDocServer(answer: any): Promise<Uint8Array> {
  const { token, ...rest } = answer.config
  expect(verify(token)).toEqual(JSON.parse(JSON.stringify(rest)))
  const res = await fc(rest.document.url, { headers: { authorization: `Bearer ${sign({ payload: { url: rest.document.url } })}` } })
  expect(res.status).toBe(200)
  return new Uint8Array(await res.arrayBuffer())
}

/** the document server reporting to callbackUrl; the JWT in the body (default) or in the Authorization header */
function callback(url: string, data: Record<string, unknown>, how: 'body' | 'header' | 'none' = 'body', secret = SECRET) {
  const body = how === 'body' ? { ...data, token: sign(data, secret) } : data
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (how === 'header') headers.authorization = `Bearer ${sign({ payload: data }, secret)}`
  return fc(url, { method: 'POST', headers, body: JSON.stringify(body) })
}

/** a new version on the document server, as a status-2 callback names it */
function publishSaved(bytes: Uint8Array, name = 'output.docx') {
  const id = randomBytes(6).toString('hex')
  savedFiles.set(`/cache/files/${id}/${name}`, bytes)
  return `${DOC()}/cache/files/${id}/${name}`
}

const saved = { url: '', internal: '', server: '', secret: '', max: 0, ttl: 0, timeout: 0 }
function enable(over: Partial<{ officeUrl: string; officeInternalUrl: string; officeServerInternalUrl: string; officeJwtSecret: string }> = {}) {
  Object.assign(config, { officeUrl: DOC(), officeInternalUrl: INTERNAL, officeServerInternalUrl: '', officeJwtSecret: SECRET, ...over })
}
function disable() {
  Object.assign(config, { officeUrl: '', officeInternalUrl: '', officeServerInternalUrl: '', officeJwtSecret: '' })
}

const trashOf = (originalPath: string) =>
  readdirSync(paths.trash)
    .map(id => ({ id, meta: JSON.parse(readFileSync(join(paths.trash, id, 'meta.json'), 'utf8')) }))
    .filter(t => t.meta.originalPath === originalPath)

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config, paths } = await import('../src/config'))
  office = await import('../src/office')
  logger = await import('../src/logger')
  Object.assign(saved, {
    url: config.officeUrl, internal: config.officeInternalUrl, server: config.officeServerInternalUrl, secret: config.officeJwtSecret,
    max: config.officeMaxSize, ttl: office.OFFICE_LIMITS.tokenTtlMs, timeout: office.OFFICE_LIMITS.downloadTimeoutMs,
  })
  docServer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const { pathname } = new URL(req.url)
      docRequests.push(pathname)
      const bytes = savedFiles.get(pathname)
      return bytes ? new Response(bytes) : new Response('not found', { status: 404 })
    },
  })
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
})

afterAll(() => {
  Object.assign(config, {
    officeUrl: saved.url, officeInternalUrl: saved.internal, officeServerInternalUrl: saved.server, officeJwtSecret: saved.secret, officeMaxSize: saved.max,
  })
  office.OFFICE_LIMITS.tokenTtlMs = saved.ttl
  office.OFFICE_LIMITS.downloadTimeoutMs = saved.timeout
  docServer?.stop(true)
})

describe('office: switched on only when configured', () => {
  test('off without the OFFICE_* settings, with a short secret or a bad URL', async () => {
    disable()
    const u = await userWith('of-off', ['read', 'download', 'write'])
    writeFileSync(home('of-off', 'a.docx'), 'doc')
    expect((await u.json('GET', '/api/session')).data.config.office).toEqual({ enabled: false, edit: [], view: [] })
    const r = await u.json('POST', '/api/office/config', { space: 'home', path: '/a.docx', mode: 'edit' })
    expect([r.status, r.data.code]).toEqual([404, 'office.disabled'])
    expect((await fc(`${INTERNAL}/api/office/file/x.y`)).status).toBe(404)
    expect((await callback(`${INTERNAL}/api/office/callback/x.y`, { status: 2 })).status).toBe(404)

    for (const [over, reason] of [
      [{ officeJwtSecret: '' }, 'OFFICE_JWT_SECRET'],
      [{ officeJwtSecret: 'x'.repeat(31) }, 'OFFICE_JWT_SECRET'],
      [{ officeUrl: 'http://office.example.com' }, 'OFFICE_URL'],
      [{ officeUrl: 'not a url' }, 'OFFICE_URL'],
      [{ officeInternalUrl: '' }, 'OFFICE_INTERNAL_URL'],
      [{ officeServerInternalUrl: 'ftp://office' }, 'OFFICE_SERVER_INTERNAL_URL'],
    ] as const) {
      enable(over)
      expect(office.officeConfig().enabled).toBe(false)
      expect(office.officeConfig().error).toContain(reason)
      expect((await u.json('POST', '/api/office/config', { space: 'home', path: '/a.docx', mode: 'edit' })).status).toBe(404)
    }

    enable({ officeJwtSecret: 'x'.repeat(32) })
    expect(office.officeConfig()).toMatchObject({ enabled: true, error: null })
    const s = (await u.json('GET', '/api/session')).data.config.office
    expect(s.enabled).toBe(true)
    expect(s.edit).toContain('docx')
    expect(s.edit).not.toContain('doc')
    expect(s.view).toEqual(expect.arrayContaining(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'doc', 'xls', 'ppt', 'csv', 'txt']))
    // visitors are not told
    expect((await new Client().json('GET', '/api/session')).data.config.office).toBeUndefined()
  })

  test('the page CSP names the document server only when office editing is on', async () => {
    disable()
    const before = (await app.handle(new Request('http://localhost/'))).headers.get('content-security-policy') as string
    expect(before).toContain("script-src 'self';")
    enable()
    const origin = DOC()
    const after = (await app.handle(new Request('http://localhost/'))).headers.get('content-security-policy') as string
    expect(after).toContain(`script-src 'self' ${origin};`)
    expect(after).toContain(`frame-src 'self' ${origin};`)
    // nothing else changes
    expect(after.replaceAll(` ${origin}`, '')).toBe(before)
    // a path under OFFICE_URL is not part of the origin
    enable({ officeUrl: 'https://office.example.com/docs/' })
    const sub = (await app.handle(new Request('http://localhost/'))).headers.get('content-security-policy') as string
    expect(sub).toContain("frame-src 'self' https://office.example.com;")
    disable()
    expect((await app.handle(new Request('http://localhost/'))).headers.get('content-security-policy')).toBe(before)
  })
})

describe('office: editor config', () => {
  test('an editor gets a signed config for exactly that file', async () => {
    enable()
    const u = await userWith('of-ed', ['read', 'download', 'write'])
    writeFileSync(home('of-ed', 'report.docx'), 'original report')
    const r = await u.json('POST', '/api/office/config', { space: 'home', path: '/report.docx', mode: 'edit' }, { 'x-lang': 'en' })
    expect(r.status).toBe(200)
    expect(r.data.apiUrl).toBe(`${DOC()}/web-apps/apps/api/documents/api.js`)
    const c = r.data.config
    expect(c.documentType).toBe('word')
    expect(c.document).toMatchObject({ fileType: 'docx', title: 'report.docx', permissions: { edit: true } })
    expect(c.document.key).toMatch(/^[0-9A-Za-z_-]{20,128}$/)
    expect(c.document.url).toStartWith(`${INTERNAL}/api/office/file/`)
    expect(c.editorConfig).toMatchObject({ mode: 'edit', lang: 'en', user: { id: 'of-ed', name: 'Name of-ed' } })
    expect(c.editorConfig.callbackUrl).toStartWith(`${INTERNAL}/api/office/callback/`)
    // signed with OFFICE_JWT_SECRET, and the signature covers the whole config
    const { token, ...unsigned } = c
    expect(verify(token)).toEqual(unsigned)
    expect(verify(c.token, 'another-secret-another-secret-123')).toBeNull()
    // the document server can fetch it
    expect(new TextDecoder().decode(await openInDocServer(r.data))).toBe('original report')

    // the key changes with the file, the same file keeps it
    const again = await u.json('POST', '/api/office/config', { space: 'home', path: '/report.docx', mode: 'view' })
    expect(again.data.config.document.key).toBe(c.document.key)
    writeFileSync(home('of-ed', 'report.docx'), 'changed report, longer')
    const changed = await u.json('POST', '/api/office/config', { space: 'home', path: '/report.docx', mode: 'edit' })
    expect(changed.data.config.document.key).not.toBe(c.document.key)
    // the same path of another user is another file: another key
    const o = await userWith('of-ed2', ['read', 'download', 'write'])
    writeFileSync(home('of-ed2', 'report.docx'), 'changed report, longer')
    const other = await o.json('POST', '/api/office/config', { space: 'home', path: '/report.docx', mode: 'edit' })
    expect(other.data.config.document.key).not.toBe(changed.data.config.document.key)
  })

  test('view mode: no callback, no editing', async () => {
    enable()
    const u = await userWith('of-view', ['read', 'download'])
    writeFileSync(home('of-view', 'sheet.xlsx'), 'cells')
    const r = await u.json('POST', '/api/office/config', { space: 'home', path: '/sheet.xlsx', mode: 'view' })
    expect(r.status).toBe(200)
    expect(r.data.config.documentType).toBe('cell')
    expect(r.data.config.document.permissions.edit).toBe(false)
    expect(r.data.config.editorConfig.mode).toBe('view')
    expect(r.data.config.editorConfig.callbackUrl).toBeUndefined()
    expect(new TextDecoder().decode(await openInDocServer(r.data))).toBe('cells')
  })

  test('rights, visitors, file types and size decide', async () => {
    enable()
    const reader = await userWith('of-reader', ['read', 'download'])
    const writer = await userWith('of-writer', ['write'])
    const noDl = await userWith('of-nodl', ['read', 'write'])
    for (const n of ['of-reader', 'of-writer', 'of-nodl']) {
      writeFileSync(home(n, 'a.docx'), 'doc')
      writeFileSync(home(n, 'old.doc'), 'doc')
      writeFileSync(home(n, 'notes.pdf'), 'pdf')
    }
    const cfg = (c: Client, path: string, mode: string, space = 'home') => c.json('POST', '/api/office/config', { space, path, mode })
    const code = async (p: Promise<{ status: number; data: any }>) => { const r = await p; return `${r.status} ${r.data?.code ?? ''}`.trim() }

    // no write: viewing only
    expect(await code(cfg(reader, '/a.docx', 'edit'))).toBe('403 auth.forbidden')
    expect((await cfg(reader, '/a.docx', 'view')).status).toBe(200)
    // write without read/download does not show the file either
    expect(await code(cfg(writer, '/a.docx', 'edit'))).toBe('403 auth.forbidden')
    expect(await code(cfg(writer, '/a.docx', 'view'))).toBe('403 auth.forbidden')
    expect(await code(cfg(noDl, '/a.docx', 'view'))).toBe('403 auth.forbidden')
    // the public folder follows its own rights (none here)
    writeFileSync(join(paths.publicDir, 'pub.docx'), 'pub')
    expect(await code(cfg(reader, '/pub.docx', 'view', 'public'))).toBe('403 auth.forbidden')
    // visitors never, whatever the guest permissions say
    const guest = await new Client().start()
    expect(await code(cfg(guest, '/pub.docx', 'view', 'public'))).toBe('401 auth.required')
    // only office types; legacy formats open for reading only
    expect(await code(cfg(reader, '/notes.pdf', 'view'))).toBe('400 office.bad-type')
    expect((await cfg(reader, '/old.doc', 'view')).status).toBe(200)
    const editor = await userWith('of-editor', ['read', 'download', 'write'])
    writeFileSync(home('of-editor', 'old.doc'), 'doc')
    writeFileSync(home('of-editor', 'list.csv'), 'a,b')
    expect(await code(cfg(editor, '/old.doc', 'edit'))).toBe('400 office.bad-type')
    expect((await cfg(editor, '/list.csv', 'edit')).status).toBe(200)
    // missing, folders, bad modes and paths
    expect((await cfg(editor, '/missing.docx', 'edit')).status).toBe(404)
    expect((await cfg(editor, '/', 'edit')).status).toBe(404)
    expect((await cfg(editor, '/list.csv', 'write')).status).toBe(422)
    expect((await cfg(editor, '/../../etc/passwd', 'view')).status).toBe(400)
    // too big
    config.officeMaxSize = 2
    try {
      expect(await code(cfg(editor, '/list.csv', 'edit'))).toBe('413 office.too-big')
    } finally {
      config.officeMaxSize = saved.max
    }
  })
})

describe('office: the links the document server uses', () => {
  test('the file link needs the document server JWT and names one file', async () => {
    enable()
    const u = await userWith('of-file', ['read', 'download', 'write'])
    writeFileSync(home('of-file', 'a.docx'), 'AAA')
    writeFileSync(home('of-file', 'b.docx'), 'BBB')
    const r = await u.json('POST', '/api/office/config', { space: 'home', path: '/a.docx', mode: 'edit' })
    const url: string = r.data.config.document.url
    const token = url.split('/').at(-1)!
    const get = (path: string, auth?: string) => fc(path, { headers: auth === undefined ? {} : { authorization: auth } })
    const good = `Bearer ${sign({ payload: { url } })}`

    const status = async (p: Promise<Response>) => { const res = await p; return `${res.status} ${(await res.json().catch(() => null))?.code ?? ''}`.trim() }
    expect(await status(get(url))).toBe('403 office.bad-jwt')
    expect(await status(get(url, 'Bearer nonsense'))).toBe('403 office.bad-jwt')
    expect(await status(get(url, `Bearer ${sign({ payload: { url } }, 'x'.repeat(40))}`))).toBe('403 office.bad-jwt')
    expect(await status(get(url, `Bearer ${sign({ payload: { url } }, SECRET, 'none')}`))).toBe('403 office.bad-jwt')
    expect(await status(get(url, `Bearer ${sign({ payload: { url }, exp: Math.floor(Date.now() / 1000) - 10 })}`))).toBe('403 office.bad-jwt')
    const ok = await get(url, good)
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('AAA')

    // another path in the token: the signature no longer fits
    const [body, mac] = token.split('.')
    const forged = { ...JSON.parse(Buffer.from(body, 'base64url').toString()), p: '/b.docx', f: '/users/of-file/b.docx' }
    expect(await status(get(`${INTERNAL}/api/office/file/${b64(JSON.stringify(forged))}.${mac}`, good))).toBe('403 office.bad-token')
    expect(await status(get(`${INTERNAL}/api/office/file/${token}x`, good))).toBe('403 office.bad-token')
    expect(await status(get(`${INTERNAL}/api/office/file/garbage`, good))).toBe('403 office.bad-token')
    // run out
    const expired = office.makeToken({ s: 'home', p: '/a.docx', f: '/users/of-file/a.docx', u: 'of-file', m: 'view' }, -1000)
    expect(await status(get(`${INTERNAL}/api/office/file/${expired}`, good))).toBe('403 office.bad-token')
    // the user lost the right to download: the link stops working too
    await admin.json('PUT', '/api/admin/users/of-file', { permissions: ['read', 'write'] })
    expect((await get(url, good)).status).toBe(403)
    await admin.json('PUT', '/api/admin/users/of-file', { permissions: ['read', 'download', 'write'] })
    expect((await get(url, good)).status).toBe(200)
    // the file is gone
    writeFileSync(home('of-file', 'a.docx'), 'AAA')
    rmSync(home('of-file', 'a.docx'))
    expect((await get(url, good)).status).toBe(404)
  })

  test('tokens stay out of the logs', () => {
    expect(logger.safePath('http://x/api/office/file/eyJzIjoi.abc_-123?x=1')).toBe('/api/office/file/***')
    expect(logger.scrub('POST /api/office/callback/eyJzIjoi.abc_-123 failed')).toBe('POST /api/office/callback/*** failed')
  })
})

describe('office: saving through the callback', () => {
  async function setup(name: string, perms = ['read', 'download', 'write']) {
    enable()
    const u = await userWith(name, perms)
    writeFileSync(home(name, 'doc.docx'), 'old version')
    const r = await u.json('POST', '/api/office/config', { space: 'home', path: '/doc.docx', mode: 'edit' })
    expect(r.status).toBe(200)
    return { u, cb: r.data.config.editorConfig.callbackUrl as string, key: r.data.config.document.key as string, file: home(name, 'doc.docx') }
  }
  const read = (f: string) => readFileSync(f, 'utf8')

  test('status 2 puts the old version in the trash and the new bytes in place', async () => {
    const { cb, key, file } = await setup('of-save')
    const url = publishSaved(new TextEncoder().encode('new version from the editor'))
    const res = await callback(cb, { key, status: 2, url, filetype: 'docx', users: ['of-save'] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ error: 0 })
    expect(read(file)).toBe('new version from the editor')
    const trashed = trashOf('/users/of-save/doc.docx')
    expect(trashed.length).toBe(1)
    expect(readFileSync(join(paths.trash, trashed[0].id, 'item'), 'utf8')).toBe('old version')
    expect(trashed[0].meta.deletedBy).toBe('of-save')
    // no leftovers next to the file
    expect(readdirSync(home('of-save'))).toEqual(['doc.docx'])
    const auditLog = readFileSync(paths.audit, 'utf8')
    expect(auditLog).toMatch(/"user":"of-save","ip":"[^"]*","action":"office-save","target":"\/users\/of-save\/doc.docx"/)
    // the old version can be restored from the trash as usual
    const restored = await admin.json('POST', '/api/admin/trash/restore', { id: trashed[0].id })
    expect(restored.data.restoredTo).toBe('/users/of-save/doc (1).docx')
    expect(read(home('of-save', 'doc (1).docx'))).toBe('old version')
  })

  test('status 6 (forced save) with the JWT in the Authorization header saves too', async () => {
    const { cb, key, file } = await setup('of-force')
    const url = publishSaved(new TextEncoder().encode('forced'))
    const res = await callback(cb, { key, status: 6, url, filetype: 'docx' }, 'header')
    expect(await res.json()).toEqual({ error: 0 })
    expect(read(file)).toBe('forced')
    expect(trashOf('/users/of-force/doc.docx').length).toBe(1)
  })

  test('a callback without the right JWT is refused', async () => {
    const { cb, key, file } = await setup('of-jwt')
    const url = publishSaved(new TextEncoder().encode('forged'))
    const before = docRequests.length
    for (const r of [
      await callback(cb, { key, status: 2, url }, 'none'),
      await callback(cb, { key, status: 2, url }, 'body', 'y'.repeat(40)),
      await callback(cb, { key, status: 2, url }, 'header', 'y'.repeat(40)),
      // something that is not a JWT at all
      await fc(cb, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, status: 2, url, token: 'a.b.c' }) }),
    ]) {
      expect(r.status).toBe(403)
      expect((await r.json()).code).toBe('office.bad-jwt')
    }
    // the plain fields next to a valid token are not what counts: the token says status 4
    const signed4 = sign({ key, status: 4 })
    const mixed = await fc(cb, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, status: 2, url, token: signed4 }) })
    expect(await mixed.json()).toEqual({ error: 0 })
    expect(read(file)).toBe('old version')
    expect(docRequests.length).toBe(before)
    expect(trashOf('/users/of-jwt/doc.docx').length).toBe(0)
  })

  test('a saved file is fetched only from the document server', async () => {
    const { cb, key, file } = await setup('of-origin')
    const url = publishSaved(new TextEncoder().encode('from elsewhere'))
    const before = docRequests.length
    // the same server under another name is another origin
    for (const bad of [url.replace('127.0.0.1', 'localhost'), 'https://evil.example.com/cache/x.docx', 'file:///etc/passwd', 'not a url', 42]) {
      const res = await callback(cb, { key, status: 2, url: bad })
      expect(await res.json()).toEqual({ error: 1 })
    }
    expect(docRequests.length).toBe(before)
    expect(read(file)).toBe('old version')
    expect(trashOf('/users/of-origin/doc.docx').length).toBe(0)
  })

  test('a link under the public OFFICE_URL is fetched through OFFICE_SERVER_INTERNAL_URL', async () => {
    const { cb, key, file } = await setup('of-internal')
    enable({ officeUrl: 'https://office.example.test', officeServerInternalUrl: DOC() })
    const url = publishSaved(new TextEncoder().encode('via the internal address'))
    const pub = url.replace(DOC(), 'https://office.example.test')
    expect(await (await callback(cb, { key, status: 2, url: pub })).json()).toEqual({ error: 0 })
    expect(read(file)).toBe('via the internal address')
  })

  test('the user who lost write, a view link, another file type or a too big file save nothing', async () => {
    const { cb, key, file } = await setup('of-lost')
    await admin.json('PUT', '/api/admin/users/of-lost', { permissions: ['read', 'download'] })
    const url = publishSaved(new TextEncoder().encode('should not land'))
    expect(await (await callback(cb, { key, status: 2, url })).json()).toEqual({ error: 1 })
    expect(read(file)).toBe('old version')
    await admin.json('PUT', '/api/admin/users/of-lost', { permissions: ['read', 'download', 'write'] })

    // a view config's link can not be used to save, even by a user who may write
    const u = await new Client().login('of-lost', PW)
    const view = await u.json('POST', '/api/office/config', { space: 'home', path: '/doc.docx', mode: 'view' })
    const viewToken = view.data.config.document.url.split('/').at(-1)
    const res = await callback(`${INTERNAL}/api/office/callback/${viewToken}`, { key, status: 2, url })
    expect([res.status, (await res.json()).code]).toEqual([403, 'office.bad-token'])
    // an expired edit link neither
    const expired = office.makeToken({ s: 'home', p: '/doc.docx', f: '/users/of-lost/doc.docx', u: 'of-lost', m: 'edit' }, -1)
    expect((await callback(`${INTERNAL}/api/office/callback/${expired}`, { key, status: 2, url })).status).toBe(403)
    // a version in another format is not written under the old name
    expect(await (await callback(cb, { key, status: 2, url, filetype: 'pdf' })).json()).toEqual({ error: 1 })
    // bigger than OFFICE_MAX_SIZE
    config.officeMaxSize = 5
    try {
      expect(await (await callback(cb, { key, status: 2, url })).json()).toEqual({ error: 1 })
    } finally {
      config.officeMaxSize = saved.max
    }
    // the document server does not have it (404)
    expect(await (await callback(cb, { key, status: 2, url: `${DOC()}/cache/files/missing/output.docx` })).json()).toEqual({ error: 1 })
    expect(read(file)).toBe('old version')
    expect(trashOf('/users/of-lost/doc.docx').length).toBe(0)
    expect(readdirSync(home('of-lost'))).toEqual(['doc.docx'])
    // and the failures are in the system log, without the tokens
    const sys = readFileSync(paths.systemLog, 'utf8')
    expect(sys).toContain('office-save-refused')
    expect(sys).not.toContain(viewToken)
    expect(sys).not.toContain(cb.split('/').at(-1))
  })

  test('status 1 (editing) and 4 (closed without changes) change nothing', async () => {
    const { cb, key, file } = await setup('of-noop')
    const url = publishSaved(new TextEncoder().encode('never fetched'))
    const before = docRequests.length
    for (const status of [1, 3, 4, 7]) {
      const res = await callback(cb, { key, status, url, users: ['of-noop'] })
      expect(await res.json()).toEqual({ error: 0 })
    }
    expect(docRequests.length).toBe(before)
    expect(read(file)).toBe('old version')
    expect(trashOf('/users/of-noop/doc.docx').length).toBe(0)
  })

  test('the File Center key lives in DATA_DIR, readable by its owner only', () => {
    const key = join(process.env.DATA_DIR!, 'office-links.key')
    expect(existsSync(key)).toBe(true)
    if (process.platform !== 'win32') expect(statSync(key).mode & 0o077).toBe(0)
  })
})

describe('text saving with expectedMtime', () => {
  test('a save over a newer version is refused, the answer gives the new mtime', async () => {
    const u = await userWith('of-text', ['read', 'download', 'write'])
    writeFileSync(home('of-text', 'notes.txt'), 'first')
    const opened = await u.json('GET', '/api/content?space=home&path=/notes.txt')
    const mtime = opened.data.mtime
    expect(typeof mtime).toBe('number')

    const first = await u.json('PUT', '/api/content', { space: 'home', path: '/notes.txt', content: 'mine', expectedMtime: mtime })
    expect(first.status).toBe(200)
    expect(first.data.mtime).toBe((await u.json('GET', '/api/content?space=home&path=/notes.txt')).data.mtime)

    // someone else saved meanwhile (another tab, another user): the old mtime no longer matches
    utimesSync(home('of-text', 'notes.txt'), new Date(), new Date(Date.now() + 5000))
    const stale = await u.json('PUT', '/api/content', { space: 'home', path: '/notes.txt', content: 'overwrite', expectedMtime: first.data.mtime })
    expect([stale.status, stale.data.code]).toEqual([409, 'files.changed-elsewhere'])
    expect(readFileSync(home('of-text', 'notes.txt'), 'utf8')).toBe('mine')

    // with the current mtime it saves; without expectedMtime it saves as before
    const now = (await u.json('GET', '/api/content?space=home&path=/notes.txt')).data.mtime
    expect((await u.json('PUT', '/api/content', { space: 'home', path: '/notes.txt', content: 'second', expectedMtime: now })).status).toBe(200)
    const plain = await u.json('PUT', '/api/content', { space: 'home', path: '/notes.txt', content: 'third' })
    expect(plain.status).toBe(200)
    expect(typeof plain.data.mtime).toBe('number')
    expect(readFileSync(home('of-text', 'notes.txt'), 'utf8')).toBe('third')
  })
})

describe('office: saving counts against the quota', () => {
  test('a saved version that makes the home bigger than its quota is refused; the old file stays', async () => {
    enable()
    const u = await userWith('of-quota', ['read', 'download', 'write'])
    writeFileSync(home('of-quota', 'doc.docx'), 'old version')
    // 11 bytes used, room for 39 more
    expect((await admin.json('PUT', '/api/admin/users/of-quota', { quotaBytes: 50 })).status).toBe(200)
    const r = await u.json('POST', '/api/office/config', { space: 'home', path: '/doc.docx', mode: 'edit' })
    const cb = r.data.config.editorConfig.callbackUrl as string
    const key = r.data.config.document.key as string

    const tooBig = publishSaved(new TextEncoder().encode('x'.repeat(100)))
    expect(await (await callback(cb, { key, status: 2, url: tooBig, filetype: 'docx' })).json()).toEqual({ error: 1 })
    expect(readFileSync(home('of-quota', 'doc.docx'), 'utf8')).toBe('old version')
    expect(trashOf('/users/of-quota/doc.docx').length).toBe(0)

    // only the growth counts (the old version goes to the trash, outside the home)
    const fits = publishSaved(new TextEncoder().encode('y'.repeat(45)))
    expect(await (await callback(cb, { key, status: 2, url: fits, filetype: 'docx' })).json()).toEqual({ error: 0 })
    expect(readFileSync(home('of-quota', 'doc.docx'), 'utf8')).toBe('y'.repeat(45))
  })
})
