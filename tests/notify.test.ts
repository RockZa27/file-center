/**
 * Notifications: the bell, e-mail (a stand-in SMTP server on this machine) and LINE (a stand-in for api.line.me).
 * Runs in-process on the same app as api.test.ts (see in-process-env.ts); every user here starts with "nt-".
 * The settings other files may rely on (SMTP_*, LINE_*, PUBLIC_URL) are set here and put back at the end.
 */
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tls from 'node:tls'
import './in-process-env'

let app: any
let config: typeof import('../src/config').config
let paths: typeof import('../src/config').paths
let notifyMod: typeof import('../src/notify')
let checks: typeof import('../src/notify-checks')
let mail: typeof import('../src/mail')
let line: typeof import('../src/line')
let deliver: typeof import('../src/deliver')
let shares: typeof import('../src/shares')
let quota: typeof import('../src/quota')
let alerts: typeof import('../src/alerts')
let compress: typeof import('../src/compress')

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
    if (set) this.cookie = set.split(';')[0]
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
const PERMS = ['read', 'write', 'upload', 'download', 'share']
const EN = { 'x-lang': 'en' }
const TH = { 'x-lang': 'th' }
const admin = new Client()
const home = (user: string, ...p: string[]) => join(process.env.STORAGE_DIR!, 'users', user, ...p)

async function userWith(username: string, permissions = PERMS, quotaBytes?: number) {
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', permissions, publicPermissions: [], quotaBytes })
  expect(r.status).toBe(200)
  return new Client().login(username, PW)
}

const bell = async (c: Client, query = '', headers: Record<string, string> = EN) => (await c.json('GET', `/api/me/notifications${query}`, undefined, headers)).data
const settle = async () => { await deliver.deliveryIdle(); await notifyMod.notifyIdle() }
const turnOn = (c: Client, kind: string, channels: Record<string, boolean>) => c.json('PUT', '/api/me/notify-prefs', { events: { [kind]: channels } })

// ───────────── a stand-in SMTP server ─────────────

type Mail = { from: string; to: string[]; raw: string; headers: Record<string, string>; subject: string; body: string; auth: string[] }
type Stub = {
  port: number; mails: Mail[]; connections: number
  /** replies used instead of "250" for the next messages (e.g. '451 try later'), first in first out */
  dataReplies: string[]
  stop(): void
}

function decodeWords(v: string): string {
  return v.replace(/\r?\n[ \t]+/g, ' ').replace(/=\?UTF-8\?B\?([^?]*)\?=\s*/gi, (_m, b) => Buffer.from(b, 'base64').toString('utf8'))
}
function parseMail(raw: string, from: string, to: string[], auth: string[]): Mail {
  const at = raw.indexOf('\r\n\r\n')
  const head = raw.slice(0, at).replace(/\r\n[ \t]+/g, ' ')
  const headers: Record<string, string> = {}
  for (const l of head.split('\r\n')) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim() }
  const body = Buffer.from(raw.slice(at + 4).replace(/\r\n/g, ''), 'base64').toString('utf8')
  return { from, to, raw, headers, subject: decodeWords(headers.subject ?? ''), body, auth }
}

/** one SMTP conversation on a socket; STARTTLS wraps the socket and goes on */
function session(sock: net.Socket | tls.TLSSocket, stub: Stub, opts: { key?: string; cert?: string; starttls: boolean; secure: boolean; auth: boolean }) {
  let buf = ''
  let inData = false
  let from = ''
  let to: string[] = []
  const auth: string[] = []
  let authStep: 'user' | 'pass' | null = null
  sock.on('error', () => {})
  const say = (s: string) => sock.write(`${s}\r\n`)
  sock.on('data', chunk => {
    buf += chunk.toString('latin1')
    for (;;) {
      if (inData) {
        const end = buf.indexOf('\r\n.\r\n')
        if (end < 0) return
        const raw = buf.slice(0, end).split('\r\n').map(l => (l.startsWith('..') ? l.slice(1) : l)).join('\r\n')
        buf = buf.slice(end + 5)
        inData = false
        const reply = stub.dataReplies.shift() ?? '250 queued'
        if (reply.startsWith('250')) stub.mails.push(parseMail(raw, from, to, auth.slice()))
        say(reply)
        continue
      }
      const nl = buf.indexOf('\r\n')
      if (nl < 0) return
      const cmd = buf.slice(0, nl)
      buf = buf.slice(nl + 2)
      if (authStep === 'user') { auth.push(Buffer.from(cmd, 'base64').toString()); authStep = 'pass'; say('334 UGFzc3dvcmQ6'); continue }
      if (authStep === 'pass') { auth.push(Buffer.from(cmd, 'base64').toString()); authStep = null; say('235 ok'); continue }
      const verb = cmd.split(' ')[0].toUpperCase()
      if (verb === 'EHLO') {
        const lines = ['stub.test', ...(opts.starttls && !opts.secure ? ['STARTTLS'] : []), ...(opts.auth ? ['AUTH PLAIN LOGIN'] : []), 'SIZE 1000000']
        lines.forEach((l, i) => say(`250${i === lines.length - 1 ? ' ' : '-'}${l}`))
      } else if (verb === 'STARTTLS') {
        say('220 go ahead')
        sock.removeAllListeners('data')
        const secured = new tls.TLSSocket(sock as net.Socket, { isServer: true, key: opts.key, cert: opts.cert })
        session(secured, stub, { ...opts, secure: true })
        return
      } else if (verb === 'AUTH') {
        const [, mech, arg] = cmd.split(' ')
        if (mech.toUpperCase() === 'PLAIN') { auth.push(Buffer.from(arg ?? '', 'base64').toString()); say('235 ok') } else { authStep = 'user'; say('334 VXNlcm5hbWU6') }
      } else if (verb === 'MAIL') { from = /<([^>]*)>/.exec(cmd)?.[1] ?? ''; to = []; say('250 ok') }
      else if (verb === 'RCPT') { to.push(/<([^>]*)>/.exec(cmd)?.[1] ?? ''); say('250 ok') }
      else if (verb === 'DATA') { inData = true; say('354 go') }
      else if (verb === 'QUIT') { say('221 bye'); sock.end() }
      else say('502 no')
    }
  })
  say('220 stub ESMTP')
}

function smtpStub(kind: 'plain' | 'starttls' | 'tls', cert?: { key: string; cert: string }, auth = false): Promise<Stub> {
  const stub: Stub = { port: 0, mails: [], connections: 0, dataReplies: [], stop() { server.close() } }
  const opts = { key: cert?.key, cert: cert?.cert, starttls: kind === 'starttls', secure: kind === 'tls', auth }
  const server: net.Server | tls.Server = kind === 'tls'
    ? tls.createServer({ key: cert!.key, cert: cert!.cert }, s => { stub.connections++; session(s, stub, opts) })
    : net.createServer(s => { stub.connections++; session(s, stub, opts) })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => { stub.port = (server.address() as net.AddressInfo).port; resolve(stub) }))
}

// ───────────── a stand-in for api.line.me ─────────────

type LineCall = { path: string; auth: string | null; body: any }
let lineCalls: LineCall[] = []
let lineStatuses: number[] = []
let lineServer: ReturnType<typeof Bun.serve>
const LINE_SECRET = 'line-secret-for-tests'
const sign = (body: string, secret = LINE_SECRET) => createHmac('sha256', secret).update(body).digest('base64')
async function webhook(events: unknown[], signature?: string | null, raw?: string) {
  const body = raw ?? JSON.stringify({ destination: 'U0', events })
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const sig = signature === undefined ? sign(body) : signature
  if (sig) headers['x-line-signature'] = sig
  const res: Response = await app.handle(new Request('http://localhost/api/line/webhook', { method: 'POST', headers, body }))
  return { status: res.status, data: await res.json().catch(() => null) }
}
const lineText = (userId: string, text: string) => ({ type: 'message', replyToken: 'reply-1', source: { type: 'user', userId }, message: { type: 'text', text } })

// ───────────── setup ─────────────

const saved = {} as Record<string, any>
const SETTINGS = ['smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser', 'smtpPass', 'smtpFrom', 'publicUrl', 'lineChannelToken', 'lineChannelSecret', 'lineGroupId', 'lineApiBase'] as const
let smtp: Stub
let alice: Client
let bob: Client

function useSmtp(stub: Stub, secure: 'none' | 'starttls' | 'tls' = 'none') {
  config.smtpHost = '127.0.0.1'
  config.smtpPort = stub.port
  config.smtpSecure = secure
  config.smtpUser = ''
  config.smtpPass = ''
  config.smtpFrom = 'File Center <files@example.com>'
  config.publicUrl = 'https://files.test'
}
const smtpOff = () => { config.smtpHost = '' }
const lineOn = () => {
  config.lineChannelToken = 'line-token-for-tests'
  config.lineChannelSecret = LINE_SECRET
  config.lineApiBase = `http://127.0.0.1:${lineServer.port}`
}
const lineOff = () => { config.lineChannelToken = ''; config.lineChannelSecret = ''; config.lineGroupId = '' }

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config, paths } = await import('../src/config'))
  notifyMod = await import('../src/notify')
  checks = await import('../src/notify-checks')
  mail = await import('../src/mail')
  line = await import('../src/line')
  deliver = await import('../src/deliver')
  shares = await import('../src/shares')
  quota = await import('../src/quota')
  alerts = await import('../src/alerts')
  compress = await import('../src/compress')
  for (const k of SETTINGS) saved[k] = (config as any)[k]
  deliver.DELIVERY_TIMING.backoffMs = [5, 5]
  mail.MAIL_TIMING.replyMs = 3000
  smtp = await smtpStub('plain')
  lineServer = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      lineCalls.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization'), body: await req.json().catch(() => null) })
      return new Response('{}', { status: lineStatuses.shift() ?? 200 })
    },
  })
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
  alice = await userWith('nt-alice')
  bob = await userWith('nt-bob')
  mkdirSync(home('nt-alice', 'inbox'), { recursive: true })
  writeFileSync(home('nt-alice', 'a.txt'), 'hello')
})

afterAll(() => {
  for (const k of SETTINGS) (config as any)[k] = saved[k]
  smtp.stop()
  lineServer.stop(true)
})

// ───────────── the bell ─────────────

describe('notifications: the bell', () => {
  test('a user reads, marks and deletes only their own; a visitor has none', async () => {
    notifyMod.notify('nt-alice', 'folder-shared', { from: 'carol', name: 'Plans' }, '/files?path=%2FPlans')
    notifyMod.notify('nt-bob', 'folder-shared', { from: 'dave', name: 'Budget' })
    const a = await bell(alice)
    const b = await bell(bob)
    expect(a.items.map((n: any) => n.params.name)).toEqual(['Plans'])
    expect(b.items.map((n: any) => n.params.name)).toEqual(['Budget'])
    expect(a.unread).toBe(1)
    const aliceId = a.items[0].id
    const bobId = b.items[0].id

    // bob names alice's id: nothing is marked, nothing is deleted, and he learns nothing
    expect((await bob.json('POST', '/api/me/notifications/read', { ids: [aliceId] })).data.unread).toBe(1)
    expect((await bell(alice)).unread).toBe(1)
    const del = await bob.json('DELETE', `/api/me/notifications/${aliceId}`)
    expect(del.status).toBe(404)
    expect(del.data.code).toBe('notify.not-found')
    expect((await bell(alice)).items).toHaveLength(1)
    // and the other way round, with no ids = all of his own
    expect((await alice.json('POST', '/api/me/notifications/read', {})).data.unread).toBe(0)
    expect((await bell(bob)).unread).toBe(1)
    expect((await bell(bob)).items[0].id).toBe(bobId)

    const visitor = new Client()
    visitor.csrf = (await visitor.json('GET', '/api/session')).data.csrf
    expect((await visitor.json('GET', '/api/me/notifications')).status).toBe(401)
    expect((await visitor.json('GET', '/api/me/notify-prefs')).status).toBe(401)
    expect((await visitor.json('DELETE', `/api/me/notifications/${aliceId}`)).status).toBe(401)
  })

  test('unreadOnly, ids, delete, and the text follows the language of the request', async () => {
    const c = await userWith('nt-reader')
    notifyMod.notify('nt-reader', 'link-expiring', { id: 'x1', name: 'Old.zip' }, '/links')
    notifyMod.notify('nt-reader', 'link-limit-reached', { id: 'x2', name: 'Big.zip', max: 5 }, '/links')
    const all = await bell(c)
    expect(all.items.map((n: any) => n.kind)).toEqual(['link-limit-reached', 'link-expiring']) // newest first
    expect(all.items[0]).toMatchObject({ read: false, link: '/links', text: 'Your share link "Big.zip" has reached its limit of 5 downloads.' })
    expect((await bell(c, '', TH)).items[0].text).toBe('ลิงก์แชร์ "Big.zip" ของคุณถูกดาวน์โหลดครบ 5 ครั้งแล้ว')

    const r = await c.json('POST', '/api/me/notifications/read', { ids: [all.items[1].id] })
    expect(r.data).toEqual({ ok: true, unread: 1 })
    const unread = await bell(c, '?unreadOnly=true')
    expect(unread.items.map((n: any) => n.kind)).toEqual(['link-limit-reached'])
    expect(unread.unread).toBe(1)
    expect((await c.json('DELETE', `/api/me/notifications/${all.items[0].id}`)).status).toBe(200)
    expect((await bell(c)).items.map((n: any) => n.kind)).toEqual(['link-expiring'])
  })

  test('text is not stored, only kind and params; no more than 100 are kept, the oldest go first', async () => {
    const c = await userWith('nt-many')
    for (let i = 1; i <= 105; i++) notifyMod.notify('nt-many', 'folder-shared', { from: 'carol', name: `Folder${i}` })
    const list = await bell(c)
    expect(list.items).toHaveLength(100)
    expect(list.items[0].params.name).toBe('Folder105')
    expect(list.items.at(-1).params.name).toBe('Folder6')
    await settle()
    const file = readFileSync(paths.notifications, 'utf8')
    expect(file).toContain('Folder105')
    expect(file).not.toContain('shared the folder')
    expect(file).not.toContain('แชร์โฟลเดอร์')
  })

  test('a link must stay inside the app, and a made-up kind or user is refused', () => {
    expect(notifyMod.cleanLink('/links')).toBe('/links')
    expect(notifyMod.cleanLink('/files?path=%2Fa')).toBe('/files?path=%2Fa')
    for (const bad of ['https://evil.example/', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/a\r\nSet-Cookie: x=1', '']) expect(notifyMod.cleanLink(bad)).toBeUndefined()
    expect(notifyMod.notify('nt-alice', 'made-up' as any)).toBe(false)
    expect(notifyMod.notify('nobody-here', 'folder-shared', {})).toBe(false)
    // an administrators' kind is for administrators
    expect(notifyMod.notify('nt-alice', 'system-alert', { code: 'update.available', version: '9' })).toBe(false)
  })

  test('a user called __proto__ does not break the store', async () => {
    const r = await admin.json('POST', '/api/admin/users', { username: '__proto__', name: 'p', password: PW, role: 'user', permissions: PERMS, publicPermissions: [] })
    expect(r.status).toBe(200)
    const c = await new Client().login('__proto__', PW)
    expect(notifyMod.notify('__proto__', 'folder-shared', { from: 'a', name: 'b' })).toBe(true)
    expect((await bell(c)).items).toHaveLength(1)
    expect(({} as any).length).toBeUndefined()
    expect((await bell(alice)).items.every((n: any) => n.kind === 'folder-shared')).toBe(true)
  })

  test('deleting an account removes its notifications', async () => {
    await userWith('nt-gone')
    notifyMod.notify('nt-gone', 'folder-shared', { from: 'a', name: 'b' })
    expect(notifyMod.listNotifications('nt-gone').items).toHaveLength(1)
    expect((await admin.json('DELETE', '/api/admin/users/nt-gone')).status).toBe(200)
    expect(notifyMod.listNotifications('nt-gone').items).toHaveLength(0)
  })

  test('the list may be compressed (it holds no secret), the settings are not on the list', () => {
    expect(compress.compressibleRoute('GET', '/api/me/notifications')).toBe(true)
    expect(compress.compressibleRoute('GET', '/api/me/notify-prefs')).toBe(false)
    expect(compress.compressibleRoute('GET', '/api/me/email/verify')).toBe(false)
  })
})

// ───────────── where they come from ─────────────

describe('notifications: events', () => {
  test('an upload through a request link tells its owner and nobody else, without the token', async () => {
    const mk = await alice.json('POST', '/api/shares', { space: 'home', path: '/inbox', days: 7, kind: 'upload' })
    expect(mk.status).toBe(200)
    const token = mk.data.token as string
    const before = (await bell(alice)).items.length
    const visitor = new Client()
    const a = await visitor.json('POST', `/api/s/${token}/upload`, { name: 'cv.pdf', size: 5 })
    expect(a.status).toBe(200)
    await visitor.raw('PUT', `/api/s/${token}/upload/${a.data.id}/0`, new TextEncoder().encode('12345'), { 'content-type': 'application/octet-stream' })
    expect((await visitor.json('POST', `/api/s/${token}/upload/${a.data.id}/complete`)).status).toBe(200)

    const list = await bell(alice)
    expect(list.items.length).toBe(before + 1)
    const n = list.items[0]
    expect(n).toMatchObject({ kind: 'upload-received', read: false, params: { file: 'cv.pdf', size: 5, link: 'inbox', linkId: mk.data.share.id } })
    expect(n.link).toBe('/files?path=%2Finbox')
    expect(n.text).toBe('Someone uploaded cv.pdf (5 B) through your upload link "inbox".')
    expect(JSON.stringify(list)).not.toContain(token)
    expect((await bell(bob)).items.some((x: any) => x.kind === 'upload-received')).toBe(false)
    await settle()
    expect(readFileSync(paths.notifications, 'utf8')).not.toContain(token)
  })

  test('a link used up tells its owner once', async () => {
    const owner = await userWith('nt-limit')
    writeFileSync(home('nt-limit', 'f.txt'), 'data')
    const mk = await owner.json('POST', '/api/shares', { space: 'home', path: '/f.txt', days: 7, maxDownloads: 2 })
    const token = mk.data.token as string
    const visitor = new Client()
    const get = async () => { const r = await visitor.raw('GET', `/api/s/${token}/download`); await r.arrayBuffer(); return r.status }
    expect(await get()).toBe(200)
    await Bun.sleep(20)
    expect((await bell(owner)).items).toHaveLength(0)
    expect(await get()).toBe(200)
    await Bun.sleep(20)
    expect(await get()).toBe(404)
    await Bun.sleep(20)
    const list = await bell(owner)
    expect(list.items).toHaveLength(1)
    expect(list.items[0]).toMatchObject({ kind: 'link-limit-reached', params: { name: 'f.txt', max: 2 }, link: '/links' })
    expect(JSON.stringify(list)).not.toContain(token)
  })

  test('a link that ends within 24 hours is told once; short-lived, far and revoked links are not', async () => {
    const owner = await userWith('nt-expiry')
    writeFileSync(home('nt-expiry', 'a.txt'), 'x')
    writeFileSync(home('nt-expiry', 'b.txt'), 'x')
    writeFileSync(home('nt-expiry', 'c.txt'), 'x')
    writeFileSync(home('nt-expiry', 'd.txt'), 'x')
    const make = async (path: string, days = 7) => (await owner.json('POST', '/api/shares', { space: 'home', path, days })).data.share.id as string
    const soon = shares.findShare(await make('/a.txt'))!
    soon.createdAt = new Date(Date.now() - 5 * 86400_000).toISOString()
    soon.expiresAt = new Date(Date.now() + 2 * 3600_000).toISOString()
    await make('/b.txt') // 7 days away
    await make('/c.txt', 1) // made for one day: the owner knows
    const revoked = shares.findShare(await make('/d.txt'))!
    revoked.createdAt = soon.createdAt
    revoked.expiresAt = soon.expiresAt
    revoked.revokedAt = new Date().toISOString()

    expect(checks.checkExpiringLinks()).toBe(1)
    expect(checks.checkExpiringLinks()).toBe(0)
    const list = await bell(owner)
    expect(list.items).toHaveLength(1)
    expect(list.items[0]).toMatchObject({ kind: 'link-expiring', params: { id: soon.id, name: 'a.txt' }, link: '/links' })
    // the link ends later still, the mark of a link that is gone is forgotten
    expect(checks.checkExpiringLinks(Date.now() + 3 * 3600_000)).toBe(0)
  })

  test('a home above 90% of its quota is told once, again after it fell below', async () => {
    const owner = await userWith('nt-quota', PERMS, 1000)
    const count = async () => (await bell(owner)).items.filter((n: any) => n.kind === 'quota-low').length
    writeFileSync(home('nt-quota', 'big.bin'), new Uint8Array(500))
    quota.forget('nt-quota')
    expect(await checks.checkQuotaLow()).toBe(0)
    writeFileSync(home('nt-quota', 'big.bin'), new Uint8Array(950))
    quota.forget('nt-quota')
    expect(await checks.checkQuotaLow()).toBe(1)
    expect(await checks.checkQuotaLow()).toBe(0)
    expect(await count()).toBe(1)
    const n = (await bell(owner)).items[0]
    expect(n.params).toMatchObject({ percent: 95, used: 950, quota: 1000 })
    expect(n.text).toBe('You have used 95% of your storage quota (950 B of 1000 B).')
    writeFileSync(home('nt-quota', 'big.bin'), new Uint8Array(100))
    quota.forget('nt-quota')
    expect(await checks.checkQuotaLow()).toBe(0)
    writeFileSync(home('nt-quota', 'big.bin'), new Uint8Array(990))
    quota.forget('nt-quota')
    expect(await checks.checkQuotaLow()).toBe(1)
    expect(await count()).toBe(2)
    // users without a limit are never asked
    expect((await bell(alice)).items.some((n: any) => n.kind === 'quota-low')).toBe(false)
  })

  test('what alerts.ts sends goes to the bell of every admin, once an hour per kind, and to no one else', async () => {
    alerts.resetAlerts()
    const adminBell = async () => (await bell(admin)).items.filter((n: any) => n.kind === 'system-alert')
    const before = (await adminBell()).length
    alerts.alert('backup-failed', 'backup.failed', { reasonCode: 'backup.busy', reason: 'x' })
    alerts.alert('backup-failed', 'backup.failed', { reasonCode: 'backup.busy', reason: 'x' })
    alerts.alert('lockout', 'admin.alert-login-locked', { user: 'somchai', ip: '10.0.0.9' })
    const items = await adminBell()
    expect(items.length).toBe(before + 2)
    expect(items.map((n: any) => n.params.code)).toContain('backup.failed')
    expect(items.find((n: any) => n.params.code === 'admin.alert-login-locked').text).toContain('somchai')
    expect(items[0].text.length).toBeGreaterThan(5)
    expect(JSON.stringify(items)).not.toMatch(/cookie|csrf|fc_sid/i)
    expect((await bell(alice)).items.some((n: any) => n.kind === 'system-alert')).toBe(false)
    expect((await alice.json('GET', '/api/me/notify-prefs')).data.events['system-alert']).toBeUndefined()
    expect((await admin.json('GET', '/api/me/notify-prefs')).data.events['system-alert']).toEqual({ web: true, email: false, line: false })
    alerts.resetAlerts()
  })
})

// ───────────── settings ─────────────

describe('notifications: settings', () => {
  test('defaults: the bell on, e-mail and LINE off; nothing is invented about other kinds', async () => {
    smtpOff()
    lineOff()
    const c = await userWith('nt-prefs')
    const p = (await c.json('GET', '/api/me/notify-prefs')).data
    expect(p.email).toEqual({ enabled: false, address: null, verified: false })
    expect(p.line).toEqual({ enabled: false, linked: false })
    expect(Object.keys(p.events).sort()).toEqual(['folder-shared', 'group-added', 'link-expiring', 'link-limit-reached', 'quota-low', 'upload-received'])
    for (const e of Object.values(p.events)) expect(e).toEqual({ web: true, email: false, line: false })
  })

  test('the bell can be turned off per kind, and then nothing is added', async () => {
    const c = await userWith('nt-quiet')
    const r = await turnOn(c, 'folder-shared', { web: false })
    expect(r.status).toBe(200)
    expect(r.data.events['folder-shared']).toEqual({ web: false, email: false, line: false })
    expect(r.data.events['quota-low'].web).toBe(true)
    expect(notifyMod.notify('nt-quiet', 'folder-shared', { from: 'a', name: 'b' })).toBe(false)
    expect((await bell(c)).items).toHaveLength(0)
    expect(notifyMod.notify('nt-quiet', 'quota-low', { percent: 91 })).toBe(true)
    await turnOn(c, 'folder-shared', { web: true })
    expect(notifyMod.notify('nt-quiet', 'folder-shared', { from: 'a', name: 'b' })).toBe(true)
  })

  test('an unknown kind or channel value is refused, and a user can not set an admin kind', async () => {
    const a = await alice.json('PUT', '/api/me/notify-prefs', { events: { nonsense: { web: true } } })
    expect(a.status).toBe(400)
    expect(a.data.code).toBe('notify.bad-kind')
    expect((await alice.json('PUT', '/api/me/notify-prefs', { events: { 'system-alert': { web: true } } })).data.code).toBe('notify.bad-kind')
    expect((await alice.json('PUT', '/api/me/notify-prefs', { events: { 'quota-low': { web: 'yes' } } })).status).toBe(422)
    expect((await admin.json('PUT', '/api/me/notify-prefs', { events: { 'system-alert': { web: true } } })).status).toBe(200)
  })

  test('the language of the settings is kept for e-mail and LINE', async () => {
    const c = await userWith('nt-lang')
    expect((await c.json('GET', '/api/me/notify-prefs')).data.lang).toBe('th')
    expect((await c.json('PUT', '/api/me/notify-prefs', { lang: 'en' })).data.lang).toBe('en')
    expect((await c.json('PUT', '/api/me/notify-prefs', { lang: 'fr' })).status).toBe(422)
  })
})

// ───────────── e-mail ─────────────

describe('notifications: e-mail', () => {
  test('without SMTP_HOST there is no e-mail', async () => {
    smtpOff()
    const r = await alice.json('PUT', '/api/me/email', { address: 'alice@example.com' }, EN)
    expect(r.status).toBe(409)
    expect(r.data.code).toBe('notify.email-off')
  })

  test('an address is mailed a link first; nothing else is mailed before it is opened', async () => {
    useSmtp(smtp)
    smtp.mails.length = 0
    notifyMod.resetNotifyLimits()
    const c = await userWith('nt-mail1')
    await turnOn(c, 'folder-shared', { email: true })
    const put = await c.json('PUT', '/api/me/email', { address: 'mail1@example.com' }, TH)
    expect(put.status).toBe(200)
    expect(put.data).toEqual({ address: 'mail1@example.com', verified: false })
    await settle()
    expect(smtp.mails).toHaveLength(1)
    const m = smtp.mails[0]
    expect(m.to).toEqual(['mail1@example.com'])
    expect(m.from).toBe('files@example.com')
    expect(m.subject).toContain('ยืนยันอีเมลสำหรับการแจ้งเตือน')
    expect(m.headers['content-type']).toBe('text/plain; charset=UTF-8')
    expect(m.raw).toMatch(/Subject: =\?UTF-8\?B\?/)
    const url = /https:\/\/files\.test\/api\/me\/email\/verify\?token=([A-Za-z0-9_-]+)/.exec(m.body)
    expect(url).not.toBeNull()
    const token = url![1]
    // the token is kept hashed
    expect(readFileSync(paths.notifyState, 'utf8').length).toBeGreaterThan(0)
    await notifyMod.notifyIdle()
    expect(readFileSync(paths.notifyState, 'utf8')).not.toContain(token)

    // unconfirmed: the bell gets the notification, the mailbox nothing
    expect(notifyMod.notify('nt-mail1', 'folder-shared', { from: 'a', name: 'Plans' })).toBe(true)
    await settle()
    expect(smtp.mails).toHaveLength(1)
    expect((await c.json('GET', '/api/me/notify-prefs')).data.email).toEqual({ enabled: true, address: 'mail1@example.com', verified: false })

    // a wrong, a short and a missing token confirm nothing
    for (const t of ['x'.repeat(43), 'short', '']) expect((await c.json('GET', `/api/me/email/verify?token=${t}`, undefined, EN)).data?.code).toBe('notify.bad-token')
    expect((await c.json('GET', '/api/me/email/verify', undefined, EN)).data?.code).toBe('notify.bad-token')
    expect((await c.json('GET', '/api/me/notify-prefs')).data.email.verified).toBe(false)

    // opened from the mail program: lands on the app; the token works once
    const nav = await new Client().raw('GET', `/api/me/email/verify?token=${token}`)
    expect(nav.status).toBe(302)
    expect(nav.headers.get('location')).toBe('/?emailVerified=1')
    expect((await c.json('GET', '/api/me/notify-prefs')).data.email).toEqual({ enabled: true, address: 'mail1@example.com', verified: true })
    const again = await new Client().raw('GET', `/api/me/email/verify?token=${token}`)
    expect(again.headers.get('location')).toBe('/?emailVerified=0')

    // now it is mailed
    expect(notifyMod.notify('nt-mail1', 'folder-shared', { from: 'carol', name: 'Plans' }, '/files?path=%2FPlans')).toBe(true)
    await settle()
    expect(smtp.mails).toHaveLength(2)
    const n = smtp.mails[1]
    expect(n.to).toEqual(['mail1@example.com'])
    expect(n.subject).toContain('carol')
    expect(n.body).toContain('https://files.test/files?path=%2FPlans')
    expect(n.body).not.toMatch(/token=/)
    // channel off again: no more mail
    await turnOn(c, 'folder-shared', { email: false })
    notifyMod.notify('nt-mail1', 'folder-shared', { from: 'a', name: 'b' })
    await settle()
    expect(smtp.mails).toHaveLength(2)
  })

  test('the page can confirm with fetch and gets JSON; an address change needs a new confirmation', async () => {
    useSmtp(smtp)
    smtp.mails.length = 0
    const c = await userWith('nt-mail2')
    await c.json('PUT', '/api/me/email', { address: 'one@example.com' })
    await settle()
    const token = /token=([A-Za-z0-9_-]+)/.exec(smtp.mails[0].body)![1]
    const ok = await new Client().json('GET', `/api/me/email/verify?token=${token}`, undefined, EN)
    expect(ok.status).toBe(200)
    expect(ok.data).toEqual({ ok: true, username: 'nt-mail2' })
    // the same confirmed address again: nothing to do, nothing mailed
    expect((await c.json('PUT', '/api/me/email', { address: 'ONE@example.com' })).data).toEqual({ address: 'one@example.com', verified: true })
    // another address: unconfirmed again, and the old one is not mailed any more
    notifyMod.resetNotifyLimits()
    const other = await c.json('PUT', '/api/me/email', { address: 'two@example.com' })
    expect(other.status).toBe(429) // a verification mail went out a moment ago
    expect(other.data.code).toBe('notify.verify-too-soon')
    expect(other.data.params.seconds).toBeGreaterThan(0)
    expect((await c.json('DELETE', '/api/me/email')).status).toBe(200)
    expect((await c.json('GET', '/api/me/notify-prefs')).data.email).toEqual({ enabled: true, address: null, verified: false })
  })

  test('at most one verification mail per two minutes', async () => {
    useSmtp(smtp)
    smtp.mails.length = 0
    const c = await userWith('nt-mail3')
    expect((await c.json('PUT', '/api/me/email', { address: 'three@example.com' })).status).toBe(200)
    const second = await c.json('PUT', '/api/me/email', { address: 'three-b@example.com' }, EN)
    expect(second.status).toBe(429)
    expect(second.data.code).toBe('notify.verify-too-soon')
    await settle()
    expect(smtp.mails).toHaveLength(1)
    expect(smtp.mails[0].to).toEqual(['three@example.com'])
  })

  test('at most 20 mails an hour per user', async () => {
    useSmtp(smtp)
    notifyMod.resetNotifyLimits()
    const c = await userWith('nt-mail4')
    await turnOn(c, 'folder-shared', { email: true, web: false })
    await c.json('PUT', '/api/me/email', { address: 'four@example.com' })
    await settle()
    const token = /token=([A-Za-z0-9_-]+)/.exec(smtp.mails.at(-1)!.body)![1]
    await new Client().raw('GET', `/api/me/email/verify?token=${token}`)
    smtp.mails.length = 0
    for (let i = 0; i < 30; i++) notifyMod.notify('nt-mail4', 'folder-shared', { from: 'carol', name: `F${i}` })
    await settle()
    // the verification mail has its own budget: all 20 are notifications
    expect(smtp.mails).toHaveLength(20)
    // the limit is per user: another user's mail goes
    const other = await userWith('nt-mail5')
    await turnOn(other, 'folder-shared', { email: true })
    await other.json('PUT', '/api/me/email', { address: 'five@example.com' })
    await settle()
    expect(smtp.mails).toHaveLength(21)
    notifyMod.resetNotifyLimits()
  })

  test('an address with a line break is refused, and nothing is sent', async () => {
    useSmtp(smtp)
    smtp.mails.length = 0
    const c = await userWith('nt-mail6')
    for (const address of ['a@example.com\r\nBcc: victim@example.com', 'a@example.com\nRCPT TO:<v@example.com>', 'a b@example.com', '<a@example.com>', 'a@example', '"a"@example.com', '']) {
      const r = await c.json('PUT', '/api/me/email', { address }, EN)
      expect(`${JSON.stringify(address)} ${r.status} ${r.data.code}`).toBe(`${JSON.stringify(address)} 400 notify.bad-address`)
    }
    await settle()
    expect(smtp.mails).toHaveLength(0)
    expect((await c.json('GET', '/api/me/notify-prefs')).data.email.address).toBeNull()
  })

  test('the message builder: a subject or address with CR/LF is refused, Thai is RFC 2047, dots are stuffed', async () => {
    const settings = { host: '127.0.0.1', port: smtp.port, secure: 'none' as const, user: '', pass: '', from: 'files@example.com' }
    smtp.mails.length = 0
    const before = smtp.connections
    await expect(mail.smtpSend(settings, { to: 'a@example.com', subject: 'hi\r\nBcc: v@example.com', text: 'x' })).rejects.toThrow(/line break/)
    await expect(mail.smtpSend(settings, { to: 'a@example.com\r\nBcc: v@example.com', subject: 'hi', text: 'x' })).rejects.toThrow(/recipient/)
    await expect(mail.smtpSend({ ...settings, from: 'files@example.com\r\nBcc: v@example.com' }, { to: 'a@example.com', subject: 'hi', text: 'x' })).rejects.toThrow(/sender/)
    // refused before any connection
    expect(smtp.connections).toBe(before)
    expect(mail.oneLine('a\r\nb c')).toBe('a b c')

    expect(mail.encodeHeader('plain subject')).toBe('plain subject')
    const thai = 'แจ้งเตือน: ลิงก์แชร์ของคุณจะหมดอายุภายใน 24 ชั่วโมง ' + 'ก'.repeat(40)
    const enc = mail.encodeHeader(thai)
    for (const word of enc.split('\r\n ')) expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/)
    expect(enc.split('\r\n ').every(w => w.length <= 75)).toBe(true)
    expect(decodeWords(enc)).toBe(thai)

    expect(mail.dotStuff('a\r\n.b\r\n..c\r\n.')).toBe('a\r\n..b\r\n...c\r\n..')
    // a body with lines of dots arrives as it was sent
    const body = 'first\r\n.\r\n.hidden\r\n..two\r\nสวัสดี'
    await mail.smtpSend(settings, { to: 'a@example.com', subject: thai, text: body })
    expect(smtp.mails).toHaveLength(1)
    expect(smtp.mails[0].subject).toBe(thai)
    expect(smtp.mails[0].body).toBe(body)
    expect(smtp.mails[0].raw.split('\r\n').every(l => l.length <= 998)).toBe(true)
    expect(smtp.mails[0].headers['content-transfer-encoding']).toBe('base64')
    expect(smtp.mails[0].raw).not.toMatch(/\nBcc:/i)
  })

  test('a name with a quote or line break in SMTP_FROM turns e-mail off instead of reaching a header', () => {
    config.smtpFrom = 'Evil "Name\r\nBcc: v@example.com" <files@example.com>'
    expect(mail.smtpConfig().enabled).toBe(false)
    config.smtpFrom = 'files@example.com'
    expect(mail.smtpConfig().enabled).toBe(true)
    config.smtpFrom = ''
    expect(mail.smtpConfig().enabled).toBe(false) // no sender
    config.smtpFrom = 'File Center <files@example.com>'
    config.publicUrl = ''
    expect(mail.smtpConfig().enabled).toBe(false) // no address for the link in the mail
    config.publicUrl = 'https://files.test'
    config.smtpPort = 0
    expect(mail.smtpConfig().error).toContain('SMTP_PORT')
    config.smtpPort = smtp.port
    config.smtpSecure = 'maybe'
    expect(mail.smtpConfig().enabled).toBe(false)
    config.smtpSecure = 'none'
    config.smtpHost = 'mail.example.com'
    config.smtpUser = 'u'
    config.smtpPass = 'p'
    expect(mail.smtpConfig().error).toContain('SMTP_SECURE=none') // a password in the clear to another machine
    config.smtpUser = ''
    config.smtpPass = ''
    config.smtpHost = '127.0.0.1'
    expect(mail.smtpConfig().enabled).toBe(true)
  })

  test('a temporary failure is tried again (up to 3 times), a final one only once, and the log holds no address', async () => {
    useSmtp(smtp)
    notifyMod.resetNotifyLimits()
    const c = await userWith('nt-retry')
    await turnOn(c, 'folder-shared', { email: true })
    await c.json('PUT', '/api/me/email', { address: 'retry@example.com' })
    await settle()
    const token = /token=([A-Za-z0-9_-]+)/.exec(smtp.mails.at(-1)!.body)![1]
    await new Client().raw('GET', `/api/me/email/verify?token=${token}`)

    smtp.mails.length = 0
    smtp.dataReplies.push('451 try later', '451 try later')
    const started = smtp.connections
    notifyMod.notify('nt-retry', 'folder-shared', { from: 'carol', name: 'Again' })
    await settle()
    expect(smtp.mails).toHaveLength(1)
    expect(smtp.connections - started).toBe(3)

    smtp.dataReplies.push('550 no such mailbox')
    const second = smtp.connections
    notifyMod.notify('nt-retry', 'folder-shared', { from: 'carol', name: 'Never' })
    await settle()
    expect(smtp.mails).toHaveLength(1)
    expect(smtp.connections - second).toBe(1)

    smtp.dataReplies.push('451 a', '451 b', '451 c')
    const third = smtp.connections
    notifyMod.notify('nt-retry', 'folder-shared', { from: 'carol', name: 'Gave up' })
    await settle()
    expect(smtp.connections - third).toBe(3)
    expect(smtp.mails).toHaveLength(1)
    smtp.dataReplies.length = 0
    const logText = readFileSync(paths.systemLog, 'utf8')
    expect(logText).toContain('notify-delivery-failed')
    expect(logText).not.toContain('retry@example.com')
    notifyMod.resetNotifyLimits()
  })

  test('a mail server that is down does not hold up the request, and is given up on after 3 tries', async () => {
    useSmtp(smtp)
    notifyMod.resetNotifyLimits()
    const c = await userWith('nt-down')
    await turnOn(c, 'folder-shared', { email: true })
    await c.json('PUT', '/api/me/email', { address: 'down@example.com' })
    await settle()
    const token = /token=([A-Za-z0-9_-]+)/.exec(smtp.mails.at(-1)!.body)![1]
    await new Client().raw('GET', `/api/me/email/verify?token=${token}`)
    // the server goes away
    const gone = await smtpStub('plain')
    const port = gone.port
    gone.stop()
    config.smtpPort = port
    const t0 = Date.now()
    expect(notifyMod.notify('nt-down', 'folder-shared', { from: 'carol', name: 'Lost' })).toBe(true)
    expect(Date.now() - t0).toBeLessThan(200) // queued, not sent
    const warnings = () => (readFileSync(paths.systemLog, 'utf8').match(/notify-delivery-failed/g) ?? []).length
    const before = warnings()
    await settle()
    expect(warnings()).toBe(before + 1)
    expect((await bell(c)).items.some((n: any) => n.params.name === 'Lost')).toBe(true) // the bell has it all the same
    config.smtpPort = smtp.port
    notifyMod.resetNotifyLimits()
  })

  test('AUTH PLAIN is used when the server offers it, with the password sent to this machine only', async () => {
    const auth = await smtpStub('plain', undefined, true)
    try {
      const s = { host: '127.0.0.1', port: auth.port, secure: 'none' as const, user: 'mailer', pass: 'p@ss word', from: 'files@example.com' }
      await mail.smtpSend(s, { to: 'a@example.com', subject: 'hi', text: 'x' })
      expect(auth.mails).toHaveLength(1)
      expect(auth.mails[0].auth).toEqual(['\0mailer\0p@ss word'])
      // not over a connection that is not encrypted to another machine, even if asked directly
      await expect(mail.smtpSend({ ...s, host: 'localhost.localdomain' }, { to: 'a@example.com', subject: 'hi', text: 'x' })).rejects.toThrow()
      expect(auth.mails).toHaveLength(1)
    } finally {
      auth.stop()
    }
  })
})

// ───────────── e-mail over TLS ─────────────

const openssl = (() => {
  try { return Bun.spawnSync(['openssl', 'version']).exitCode === 0 } catch { return false }
})()

describe('notifications: e-mail over TLS', () => {
  let cert: { key: string; cert: string }
  beforeAll(() => {
    if (!openssl) return
    const dir = join(tmpdir(), `fc-notify-cert-${process.pid}-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const r = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'])
    expect(r.exitCode).toBe(0)
    cert = { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') }
    rmSync(dir, { recursive: true, force: true })
  })

  for (const kind of ['starttls', 'tls'] as const) {
    test.if(openssl)(`${kind}: the password goes over the encrypted connection and the message arrives`, async () => {
      const stub = await smtpStub(kind, cert, true)
      try {
        const s = { host: '127.0.0.1', port: stub.port, secure: kind, user: 'mailer', pass: 'secret-pass', from: 'files@example.com', tls: { ca: cert.cert, serverName: 'localhost' } }
        await mail.smtpSend(s, { to: 'a@example.com', subject: 'สวัสดี', text: 'ข้อความ' })
        expect(stub.mails).toHaveLength(1)
        expect(stub.mails[0].subject).toBe('สวัสดี')
        expect(stub.mails[0].body).toBe('ข้อความ')
        expect(stub.mails[0].auth).toEqual(['\0mailer\0secret-pass'])
        // a certificate that is not trusted stops it before anything is sent
        await expect(mail.smtpSend({ ...s, tls: undefined }, { to: 'a@example.com', subject: 'x', text: 'x' })).rejects.toThrow()
        expect(stub.mails).toHaveLength(1)
      } finally {
        stub.stop()
      }
    })
  }

  test.if(openssl)('starttls with a server that does not offer it is refused (no downgrade)', async () => {
    const stub = await smtpStub('plain', undefined, true)
    try {
      const s = { host: '127.0.0.1', port: stub.port, secure: 'starttls' as const, user: 'mailer', pass: 'secret-pass', from: 'files@example.com' }
      await expect(mail.smtpSend(s, { to: 'a@example.com', subject: 'x', text: 'x' })).rejects.toThrow(/STARTTLS/)
      expect(stub.mails).toHaveLength(0)
    } finally {
      stub.stop()
    }
  })
})

// ───────────── LINE ─────────────

describe('notifications: LINE', () => {
  test('without a token there is no LINE', async () => {
    lineOff()
    const r = await alice.json('POST', '/api/me/line/link', undefined, EN)
    expect(r.status).toBe(409)
    expect(r.data.code).toBe('notify.line-off')
    expect((await webhook([], null)).status).toBe(401)
  })

  test('the API address is fixed; LINE_API_BASE only ever points at this machine', () => {
    config.lineApiBase = ''
    expect(line.lineBase()).toBe('https://api.line.me')
    for (const v of ['http://evil.example.com', 'https://evil.example.com', 'http://10.0.0.5:9', 'ftp://127.0.0.1', 'http://127.0.0.1.evil.com', 'not a url']) {
      config.lineApiBase = v
      expect(`${v} ${line.lineBase()}`).toBe(`${v} https://api.line.me`)
    }
    config.lineApiBase = 'http://127.0.0.1:4321/anything'
    expect(line.lineBase()).toBe('http://127.0.0.1:4321')
    config.lineApiBase = 'http://localhost:4321'
    expect(line.lineBase()).toBe('http://localhost:4321')
  })

  test('the webhook refuses a missing, wrong or foreign signature', async () => {
    lineOn()
    line.resetLineCodes()
    const events = [lineText('U-evil', '123456')]
    expect((await webhook(events, null)).status).toBe(401)
    expect((await webhook(events, 'AAAA')).status).toBe(401)
    expect((await webhook(events, sign(JSON.stringify({ destination: 'U0', events }), 'another-secret'))).status).toBe(401)
    const raw = JSON.stringify({ destination: 'U0', events })
    // a signature of other bytes
    expect((await webhook(events, sign(raw + ' '), raw)).status).toBe(401)
    expect((await webhook(events, sign(raw), raw)).status).toBe(200)
    // without a channel secret nothing can be checked, so nothing is accepted
    config.lineChannelSecret = ''
    expect((await webhook(events, sign(raw, ''), raw)).status).toBe(401)
    expect((await webhook(events, 'x', raw)).data.code).toBe('notify.bad-signature')
    config.lineChannelSecret = LINE_SECRET
  })

  test('the webhook needs no CSRF token and no session', async () => {
    lineOn()
    const body = JSON.stringify({ events: [] })
    const res: Response = await app.handle(new Request('http://localhost/api/line/webhook', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': sign(body) }, body,
    }))
    expect(res.status).toBe(200)
  })

  test('linking: a 6-digit code to the bot; wrong, used, expired and other accounts', async () => {
    lineOn()
    line.resetLineCodes()
    lineCalls = []
    const c = await userWith('nt-line1')
    const r = await c.json('POST', '/api/me/line/link')
    expect(r.status).toBe(200)
    expect(r.data.code).toMatch(/^\d{6}$/)
    expect(r.data.ttlSeconds).toBe(600)
    expect(Date.parse(r.data.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000)
    expect(Date.parse(r.data.expiresAt) - Date.now()).toBeLessThanOrEqual(10 * 60_000)

    // a wrong code links nothing
    const wrong = r.data.code === '000000' ? '000001' : '000000'
    await webhook([lineText('U-line1', wrong)])
    await webhook([lineText('U-line1', 'hello there')])
    expect((await c.json('GET', '/api/me/notify-prefs')).data.line).toEqual({ enabled: true, linked: false })
    // the right one does, and the bot answers
    await webhook([lineText('U-line1', ` ${r.data.code} `)])
    await settle()
    expect((await c.json('GET', '/api/me/notify-prefs')).data.line).toEqual({ enabled: true, linked: true })
    const reply = lineCalls.filter(x => x.path === '/v2/bot/message/reply')
    expect(reply.length).toBeGreaterThanOrEqual(2)
    expect(reply.at(-1)!.body.messages[0].text).toContain('nt-line1')
    expect(reply.at(-1)!.auth).toBe('Bearer line-token-for-tests')
    // a code works once
    await webhook([lineText('U-other', r.data.code)])
    expect(notifyMod.accountOfLine('U-other')).toBeNull()

    // someone else's LINE can not take over a linked LINE account
    const d = await userWith('nt-line2')
    const code2 = (await d.json('POST', '/api/me/line/link')).data.code
    await webhook([lineText('U-line1', code2)])
    await settle()
    expect((await d.json('GET', '/api/me/notify-prefs')).data.line.linked).toBe(false)
    // a new code replaces the old one
    const first = (await d.json('POST', '/api/me/line/link')).data.code
    const second = (await d.json('POST', '/api/me/line/link')).data.code
    if (first !== second) {
      await webhook([lineText('U-line2', first)])
      expect((await d.json('GET', '/api/me/notify-prefs')).data.line.linked).toBe(false)
    }
    await webhook([lineText('U-line2', second)])
    expect((await d.json('GET', '/api/me/notify-prefs')).data.line.linked).toBe(true)
  })

  test('a code expires after 10 minutes, and guessing is stopped', () => {
    line.resetLineCodes()
    const t0 = Date.now()
    const { code } = line.issueLinkCode('nt-line3', t0)
    expect(line.redeemLinkCode(code, 'U-x', t0 + 10 * 60_000 + 1)).toBeNull()
    const again = line.issueLinkCode('nt-line3', t0)
    const miss = again.code === '999999' ? '999998' : '999999'
    for (let i = 0; i < 5; i++) expect(line.redeemLinkCode(miss, 'U-guesser', t0 + i)).toBeNull()
    // after five wrong ones even the right code is not looked at
    expect(line.redeemLinkCode(again.code, 'U-guesser', t0 + 10)).toBe('locked')
    expect(line.redeemLinkCode(again.code, 'U-owner', t0 + 10)).toBe('nt-line3')
    line.resetLineCodes()
  })

  test('a notification is pushed to the linked account when LINE is on for its kind, and not before', async () => {
    lineOn()
    lineCalls = []
    notifyMod.resetNotifyLimits()
    expect(notifyMod.notify('nt-line1', 'folder-shared', { from: 'carol', name: 'Plans' }, '/files?path=%2FPlans')).toBe(true)
    await settle()
    expect(lineCalls.filter(x => x.path === '/v2/bot/message/push')).toHaveLength(0)

    const c = new Client()
    await c.login('nt-line1', PW)
    await turnOn(c, 'folder-shared', { line: true })
    config.publicUrl = 'https://files.test'
    expect(notifyMod.notify('nt-line1', 'folder-shared', { from: 'carol', name: 'Plans' }, '/files?path=%2FPlans')).toBe(true)
    await settle()
    const push = lineCalls.filter(x => x.path === '/v2/bot/message/push')
    expect(push).toHaveLength(1)
    expect(push[0].auth).toBe('Bearer line-token-for-tests')
    expect(push[0].body.to).toBe('U-line1')
    expect(push[0].body.messages[0].type).toBe('text')
    expect(push[0].body.messages[0].text).toContain('carol')
    expect(push[0].body.messages[0].text).toContain('https://files.test/files?path=%2FPlans')
  })

  test('LINE: a temporary failure is tried again, a refusal is not, and no token reaches the log', async () => {
    lineOn()
    lineCalls = []
    lineStatuses = [500, 429]
    notifyMod.notify('nt-line1', 'folder-shared', { from: 'carol', name: 'Retry' })
    await settle()
    expect(lineCalls.filter(x => x.path === '/v2/bot/message/push')).toHaveLength(3)
    lineCalls = []
    lineStatuses = [401]
    notifyMod.notify('nt-line1', 'folder-shared', { from: 'carol', name: 'Refused' })
    await settle()
    expect(lineCalls.filter(x => x.path === '/v2/bot/message/push')).toHaveLength(1)
    lineStatuses = [500, 500, 500]
    lineCalls = []
    notifyMod.notify('nt-line1', 'folder-shared', { from: 'carol', name: 'Gave up' })
    await settle()
    expect(lineCalls).toHaveLength(3)
    expect(readFileSync(paths.systemLog, 'utf8')).not.toContain('line-token-for-tests')
  })

  test('unlinking: DELETE /api/me/line, and unfollowing the bot', async () => {
    lineOn()
    const c = new Client()
    await c.login('nt-line1', PW)
    expect((await c.json('DELETE', '/api/me/line')).status).toBe(200)
    expect((await c.json('GET', '/api/me/notify-prefs')).data.line.linked).toBe(false)
    lineCalls = []
    notifyMod.notify('nt-line1', 'folder-shared', { from: 'carol', name: 'After' })
    await settle()
    expect(lineCalls).toHaveLength(0)

    const code = (await c.json('POST', '/api/me/line/link')).data.code
    await webhook([lineText('U-line1b', code)])
    expect((await c.json('GET', '/api/me/notify-prefs')).data.line.linked).toBe(true)
    await webhook([{ type: 'unfollow', source: { type: 'user', userId: 'U-line1b' } }])
    expect((await c.json('GET', '/api/me/notify-prefs')).data.line.linked).toBe(false)
  })

  test('LINE_GROUP_ID gets the admins\' system alerts', async () => {
    lineOn()
    config.lineGroupId = 'C-group-1'
    lineCalls = []
    alerts.resetAlerts()
    alerts.alert('backup-failed', 'backup.failed', { reason: 'disk' })
    await settle()
    const push = lineCalls.filter(x => x.path === '/v2/bot/message/push')
    expect(push).toHaveLength(1)
    expect(push[0].body.to).toBe('C-group-1')
    expect(push[0].body.messages[0].text).toContain('disk')
    config.lineGroupId = ''
    alerts.resetAlerts()
  })
})

// ───────────── floods (security review F5) ─────────────

describe('notifications: floods', () => {
  const upload = (user: string, linkId: string, file: string, size: number, link = 'inbox') =>
    notifyMod.notify(user, 'upload-received', { link, linkId, file, size }, '/files?path=%2Finbox')

  async function verifiedMailUser(name: string, address: string) {
    useSmtp(smtp)
    notifyMod.resetNotifyLimits()
    const c = await userWith(name)
    await c.json('PUT', '/api/me/email', { address })
    await settle()
    const token = /token=([A-Za-z0-9_-]+)/.exec(smtp.mails.at(-1)!.body)![1]
    await new Client().raw('GET', `/api/me/email/verify?token=${token}`)
    smtp.mails.length = 0
    return c
  }

  test('uploads through one link make one bell item that grows, until it is read', async () => {
    const c = await userWith('nt-flood1')
    upload('nt-flood1', 'link-a', 'one.pdf', 100)
    upload('nt-flood1', 'link-a', 'two.pdf', 200)
    upload('nt-flood1', 'link-a', 'three.pdf', 300)
    upload('nt-flood1', 'link-b', 'other.pdf', 5)
    const items = (await bell(c)).items
    expect(items).toHaveLength(2)
    const a = items.find((n: any) => n.params.linkId === 'link-a')
    expect(a.params).toMatchObject({ n: 3, file: 'three.pdf', size: 600 })
    expect(a.text).toBe('3 files (600 B in all) were uploaded through your upload link "inbox"; the latest is three.pdf.')
    expect((await bell(c, '', TH)).items.find((n: any) => n.params.linkId === 'link-a').text).toContain('3 ไฟล์')
    expect(items.find((n: any) => n.params.linkId === 'link-b').params.n).toBeUndefined()
    // once read, the next upload is a new item
    await c.json('POST', '/api/me/notifications/read', {})
    upload('nt-flood1', 'link-a', 'four.pdf', 1)
    const after = (await bell(c)).items
    expect(after).toHaveLength(3)
    expect(after[0].params).toMatchObject({ file: 'four.pdf', size: 1 })
    expect(after[0].params.n).toBeUndefined()
    // and after ten minutes it is a new item as well
    setSystemTime(new Date(Date.now() + 11 * 60_000))
    try {
      upload('nt-flood1', 'link-a', 'five.pdf', 1)
    } finally { setSystemTime() }
    expect((await bell(c)).items).toHaveLength(4)
  })

  test('mail about uploads through one link goes out once, not once per file', async () => {
    const c = await verifiedMailUser('nt-flood2', 'flood2@example.com')
    await turnOn(c, 'upload-received', { email: true })
    for (let i = 0; i < 6; i++) upload('nt-flood2', 'link-a', `f${i}.pdf`, 10)
    upload('nt-flood2', 'link-b', 'g.pdf', 10)
    await settle()
    expect(smtp.mails).toHaveLength(2)
  })

  test('LINE about uploads through one link goes out once, and a user gets 30 LINE messages an hour', async () => {
    lineOn()
    notifyMod.resetNotifyLimits()
    const c = await userWith('nt-flood3')
    const code = (await c.json('POST', '/api/me/line/link')).data.code
    await webhook([lineText('U-flood3', code)])
    expect(notifyMod.accountOfLine('U-flood3')).toBe('nt-flood3')
    await turnOn(c, 'upload-received', { line: true })
    await turnOn(c, 'folder-shared', { line: true })
    lineCalls = []
    for (let i = 0; i < 6; i++) upload('nt-flood3', 'link-a', `f${i}.pdf`, 10)
    await settle()
    expect(lineCalls.filter(x => x.path === '/v2/bot/message/push')).toHaveLength(1)
    lineCalls = []
    for (let i = 0; i < 40; i++) notifyMod.notify('nt-flood3', 'folder-shared', { from: 'carol', name: `F${i}` })
    await settle()
    // one went out above: 29 are left of the hour's 30
    expect(lineCalls.filter(x => x.path === '/v2/bot/message/push')).toHaveLength(29)
    // the bell has them all
    expect((await bell(c)).items.filter((n: any) => n.kind === 'folder-shared')).toHaveLength(40)
    // another user is not held up
    expect(notifyMod.notify('nt-line1', 'folder-shared', { from: 'carol', name: 'x' })).toBe(true)
    notifyMod.resetNotifyLimits()
    lineOff()
  })

  test('a visitor\'s file name is cut to 80 characters in a message', async () => {
    const c = await userWith('nt-flood4')
    upload('nt-flood4', 'link-a', 'x'.repeat(200) + '.pdf', 10, 'y'.repeat(200))
    const n = (await bell(c)).items[0]
    expect(n.params.file).toBe('x'.repeat(80) + '…')
    expect(n.params.link).toBe('y'.repeat(80) + '…')
    expect(n.text.length).toBeLessThan(260)
  })

  test('mail about notifications can not use up the budget of the verification mail', async () => {
    const c = await verifiedMailUser('nt-flood5', 'flood5@example.com')
    await turnOn(c, 'folder-shared', { email: true })
    for (let i = 0; i < 25; i++) notifyMod.notify('nt-flood5', 'folder-shared', { from: 'carol', name: `F${i}` })
    await settle()
    expect(smtp.mails).toHaveLength(20)
    smtp.mails.length = 0
    // the two minutes between verification mails have passed, the hour's notification mails are all used
    setSystemTime(new Date(Date.now() + 3 * 60_000))
    try {
      const r = await c.json('PUT', '/api/me/email', { address: 'flood5b@example.com' }, EN)
      expect(r.status).toBe(200)
    } finally { setSystemTime() }
    await settle()
    expect(smtp.mails).toHaveLength(1)
    expect(smtp.mails[0].to).toEqual(['flood5b@example.com'])
    notifyMod.resetNotifyLimits()
  })
})
