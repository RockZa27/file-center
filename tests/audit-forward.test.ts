/**
 * Audit forwarding (src/audit-forward.ts) against local receivers (no internet): a UDP and a TCP syslog server (RFC 5424
 * lines, octet-counted over TCP, values escaped) and an HTTP webhook. Also that a dead, slow or redirecting destination
 * never delays or breaks the request, the queue is bounded, and that the settings are admin-only, ask for the password,
 * refuse unsafe URLs and never show the URL back. Runs in-process (see in-process-env.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createSocket, type Socket } from 'node:dgram'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import './in-process-env'

let app: any
let fwd: typeof import('../src/audit-forward')
let audit: typeof import('../src/audit').audit

class Client {
  cookie = ''
  csrf = ''
  async json(method: string, path: string, body?: any) {
    const h: Record<string, string> = {}
    if (this.cookie) h.cookie = this.cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    if (body !== undefined) h['content-type'] = 'application/json'
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }))
    const set = res.headers.get('set-cookie')
    if (set?.startsWith('fc_sid=')) this.cookie = set.split(';')[0]
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
const admin = new Client()
const save = (auditForward: Record<string, unknown>, password: string | null = process.env.ADMIN_PASSWORD!) =>
  admin.json('PUT', '/api/admin/settings', { auditForward, ...(password ? { password } : {}) })
/** save the destination, then forget the settings-update entry that this very save forwarded */
const use = async (cfg: Record<string, unknown>) => { const r = await save(cfg); await fwd.forwardIdle(); await Bun.sleep(30); fwd.resetForwarding(); udpGot.length = 0; tcpGot.length = 0; hookGot.length = 0; return r }
const clear = () => save({ syslogHost: null, syslogPort: null, syslogProto: null, syslogFacility: null, webhookUrl: null, webhookSecret: null })
const wait = async (cond: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await Bun.sleep(10) }

// ── receivers
const udpGot: string[] = []
let udp: Socket
const tcpGot: Buffer[] = []
let tcpServer: Server
const hookGot: any[] = []
let hookAnswer: () => Response | Promise<Response> = () => new Response('ok')
let hook: ReturnType<typeof Bun.serve>
const hookUrl = (p = '/h') => `http://127.0.0.1:${hook.port}${p}`
const saved = {} as typeof fwd.FORWARD_TIMING

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  fwd = await import('../src/audit-forward')
  ;({ audit } = await import('../src/audit'))
  Object.assign(saved, fwd.FORWARD_TIMING)
  fwd.FORWARD_TIMING.flushMs = 20
  udp = createSocket('udp4')
  udp.on('message', m => udpGot.push(m.toString('utf8')))
  await new Promise<void>(r => udp.bind(0, '127.0.0.1', r))
  tcpServer = createServer(s => s.on('data', d => tcpGot.push(d)))
  await new Promise<void>(r => tcpServer.listen(0, '127.0.0.1', r))
  hook = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/redirect') return new Response(null, { status: 302, headers: { location: hookUrl('/h') } })
      const raw = await req.text()
      hookGot.push({ path: url.pathname, raw, headers: req.headers, body: (() => { try { return JSON.parse(raw) } catch { return null } })() })
      return hookAnswer()
    },
  })
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
})
afterEach(async () => {
  await clear()
  fwd.resetForwarding()
  Object.assign(fwd.FORWARD_TIMING, saved, { flushMs: 20 })
  hookAnswer = () => new Response('ok')
  udpGot.length = 0; tcpGot.length = 0; hookGot.length = 0
})
afterAll(() => { udp.close(); tcpServer.close(); void hook.stop(true) })

const udpPort = () => (udp.address() as any).port
const tcpPort = () => (tcpServer.address() as any).port
const text = () => Buffer.concat(tcpGot).toString('utf8')

describe('syslog (RFC 5424)', () => {
  test('UDP: one datagram per entry, with priority, timestamp, app name, msgid and structured data', async () => {
    expect((await save({ syslogHost: '127.0.0.1', syslogPort: udpPort(), syslogProto: 'udp' })).status).toBe(200)
    audit({ user: 'bob', ip: '10.1.2.3', action: 'rename', target: '/a b.txt', detail: 'to c.txt' })
    await fwd.forwardIdle()
    await wait(() => udpGot.some(l => l.includes(' rename ')))
    const line = udpGot.find(l => l.includes(' rename '))!
    // facility 13 (log audit) * 8 + severity 6; version 1; ISO time; hostname; app; pid; msgid; SD; message
    expect(line).toMatch(/^<110>1 \d{4}-\d\d-\d\dT[\d:.]+Z \S+ file-center \d+ rename \[fc@32473 user="bob" ip="10\.1\.2\.3" target="\/a b\.txt"\] to c\.txt$/)
  })

  test('facility is configurable; a name that tries to break out of the structured data is escaped', async () => {
    await use({ syslogHost: '127.0.0.1', syslogPort: udpPort(), syslogFacility: 4 })
    audit({ user: 'evil"] x="1', ip: '1.1.1.1', action: 'we ird\naction', target: 'a\\b\r\nFAKE', detail: 'line1\nline2' })
    await fwd.forwardIdle()
    await wait(() => udpGot.length > 0)
    const line = udpGot[0]
    expect(line.startsWith('<38>1 ')).toBe(true)
    expect(line).not.toMatch(/[\r\n]/)
    expect(line).toContain('user="evil\\"\\] x=\\"1"')
    expect(line).toContain('target="a\\\\b  FAKE"')
    expect(line).toContain(' weirdaction [fc@')
    expect(line.endsWith('line1 line2')).toBe(true)
  })

  test('TCP: octet-counted frames, one connection reused', async () => {
    await use({ syslogHost: '127.0.0.1', syslogPort: tcpPort(), syslogProto: 'tcp' })
    audit({ user: 'amy', ip: '2.2.2.2', action: 'upload', detail: 'ไฟล์.txt' })
    audit({ user: 'amy', ip: '2.2.2.2', action: 'delete', target: '/x' })
    await fwd.forwardIdle()
    await wait(() => text().includes(' delete '))
    const buf = Buffer.concat(tcpGot)
    const frames: string[] = []
    for (let i = 0; i < buf.length;) {
      const sp = buf.indexOf(0x20, i)
      const n = Number(buf.subarray(i, sp).toString())
      frames.push(buf.subarray(sp + 1, sp + 1 + n).toString('utf8'))
      i = sp + 1 + n
    }
    expect(frames).toHaveLength(2)
    expect(frames[0]).toContain('upload [fc@32473 user="amy" ip="2.2.2.2"] ไฟล์.txt')
    expect(frames[1]).toContain('delete [fc@32473 user="amy" ip="2.2.2.2" target="/x"]')
    expect(fwd.forwardStats().sent).toBeGreaterThan(0)
  })

  test('a TCP server that is down never breaks audit(), is counted, and is retried only after a pause', async () => {
    const dead = createServer()
    await new Promise<void>(r => dead.listen(0, '127.0.0.1', r))
    const port = (dead.address() as any).port
    await new Promise<void>(r => dead.close(() => r()))
    await save({ syslogHost: '127.0.0.1', syslogPort: port, syslogProto: 'tcp' })
    const t0 = performance.now()
    for (let i = 0; i < 20; i++) audit({ user: 'amy', ip: '1.1.1.1', action: 'x' })
    expect(performance.now() - t0).toBeLessThan(200)
    await fwd.forwardIdle()
    expect(fwd.forwardStats().failed).toBeGreaterThan(0)
    expect(fwd.forwardStats().lastError).toContain('syslog')
    // the config page warns about a destination that fails
    const w = (await admin.json('GET', '/api/admin/config-warnings')).data.items.map((i: any) => i.code)
    expect(w).toContain('admin.config-audit-forward-failing')
    expect(w).not.toContain('admin.config-audit-syslog-plain')
  })
})

describe('webhook', () => {
  test('entries are POSTed as JSON in batches, with secrets scrubbed', async () => {
    expect((await save({ webhookUrl: hookUrl() })).status).toBe(200)
    audit({ user: 'bob', ip: '3.3.3.3', action: 'share-create', target: '/f', detail: 'http://x/api/s/SECRETTOKEN123/download' })
    audit({ user: 'bob', ip: '3.3.3.3', action: 'delete', target: '/g' })
    await fwd.forwardIdle()
    await wait(() => hookGot.length > 0)
    const entries = hookGot.flatMap(g => g.body.entries).filter((e: any) => e.action !== 'settings-update')
    expect(hookGot[0].body).toMatchObject({ event: 'audit', source: 'file-center' })
    expect(entries.map((e: any) => e.action)).toContain('delete')
    expect(JSON.stringify(entries)).not.toContain('SECRETTOKEN123')
    expect(entries.find((e: any) => e.action === 'share-create')).toMatchObject({ user: 'bob', ip: '3.3.3.3', action: 'share-create' })
  })

  test('an error status, a redirect and a slow server are counted as failures; audit() never waits for them', async () => {
    await save({ webhookUrl: hookUrl() })
    hookAnswer = () => new Response('no', { status: 500 })
    audit({ user: 'a', ip: 'i', action: 'one' })
    await fwd.forwardIdle()
    expect(fwd.forwardStats().lastError).toBe('webhook: HTTP 500')

    await save({ webhookUrl: hookUrl('/redirect') })
    audit({ user: 'a', ip: 'i', action: 'two' })
    await fwd.forwardIdle()
    expect(fwd.forwardStats().lastError).toBe('webhook: unreachable')
    expect(hookGot.every(g => g.path !== '/h' || g.body.entries[0].action !== 'two')).toBe(true)

    fwd.FORWARD_TIMING.timeoutMs = 100
    await save({ webhookUrl: hookUrl() })
    hookAnswer = () => new Promise<Response>(r => setTimeout(() => r(new Response('late')), 1000))
    const t0 = performance.now()
    audit({ user: 'a', ip: 'i', action: 'three' })
    expect(performance.now() - t0).toBeLessThan(50)
    await fwd.forwardIdle()
    expect(fwd.forwardStats().lastError).toBe('webhook: timeout')
    expect(performance.now() - t0).toBeLessThan(900)
  })

  test('the queue is bounded: a flood is dropped and counted, not kept', async () => {
    await save({ webhookUrl: hookUrl() })
    fwd.resetForwarding() // the settings-update entry above was forwarded too
    fwd.FORWARD_TIMING.maxQueue = 10
    fwd.FORWARD_TIMING.flushMs = 60_000
    for (let i = 0; i < 100; i++) audit({ user: 'a', ip: 'i', action: `f${i}` })
    expect(fwd.forwardStats().dropped).toBe(90)
    await fwd.forwardIdle()
    expect(hookGot.flatMap(g => g.body.entries)).toHaveLength(10)
  })

  test('nothing is queued or sent while no destination is set', async () => {
    audit({ user: 'a', ip: 'i', action: 'quiet' })
    expect(fwd.forwardStats().queued).toBe(0)
    await fwd.forwardIdle()
    expect(hookGot).toHaveLength(0)
    expect(udpGot).toHaveLength(0)
  })
})

describe('webhook signature', () => {
  const SECRET = 'hmac-s3cret-for-the-siem-ZZ9'
  /** what a receiver does: recompute over the raw body, constant-time compare, reject an old timestamp */
  const verifies = (g: any, secret: string) => {
    const ts = g.headers.get('x-fc-timestamp') as string
    const sig = Buffer.from(g.headers.get('x-fc-signature') ?? '')
    const want = Buffer.from('sha256=' + createHmac('sha256', secret).update(`${ts}.${g.raw}`).digest('hex'))
    return /^\d+$/.test(ts) && Math.abs(Date.now() / 1000 - Number(ts)) < 300 && sig.length === want.length && timingSafeEqual(sig, want)
  }

  test('with a secret every batch carries X-FC-Timestamp and an X-FC-Signature that verifies against the raw body', async () => {
    expect((await save({ webhookUrl: hookUrl(), webhookSecret: SECRET })).status).toBe(200)
    audit({ user: 'bob', ip: '3.3.3.3', action: 'delete', target: '/g' })
    await fwd.forwardIdle()
    await wait(() => hookGot.some(g => g.raw.includes('"delete"')))
    const g = hookGot.find(x => x.raw.includes('"delete"'))
    expect(g.headers.get('x-fc-signature')).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(verifies(g, SECRET)).toBe(true)
    expect(verifies(g, SECRET + 'x')).toBe(false)
    expect(verifies({ ...g, raw: g.raw.replace('delete', 'forged') }, SECRET)).toBe(false)
  })

  test('without a secret there are no signature headers', async () => {
    expect((await save({ webhookUrl: hookUrl() })).status).toBe(200)
    audit({ user: 'bob', ip: '3.3.3.3', action: 'delete', target: '/g' })
    await fwd.forwardIdle()
    await wait(() => hookGot.length > 0)
    expect(hookGot.length).toBeGreaterThan(0)
    for (const g of hookGot) {
      expect(g.headers.get('x-fc-signature')).toBeNull()
      expect(g.headers.get('x-fc-timestamp')).toBeNull()
    }
  })

  test('the secret is never shown, stored in clear text or logged; a short or odd one is refused', async () => {
    for (const bad of ['short', 'a'.repeat(15), 'a'.repeat(201), 'tab\there-is-long-enough', 'é'.repeat(20), 5, true]) {
      const r = await save({ webhookSecret: bad })
      expect(r.status).toBe(400)
      expect(r.data.code).toBe('admin.bad-setting')
    }
    const ok = await save({ webhookUrl: hookUrl(), webhookSecret: SECRET })
    expect(ok.status).toBe(200)
    expect(ok.data.auditForward.webhookSecretSet).toBe(true)
    expect(JSON.stringify(ok.data)).not.toContain(SECRET)
    expect(JSON.stringify((await admin.json('GET', '/api/admin/settings')).data)).not.toContain(SECRET)
    audit({ user: 'bob', ip: '3.3.3.3', action: 'delete', target: '/g' })
    await fwd.forwardIdle()
    const { paths } = await import('../src/config')
    await (await import('../src/settings')).settings.idle()
    const raw = readFileSync(paths.settings, 'utf8')
    expect(raw).not.toContain(SECRET)
    expect(JSON.parse(raw).auditForward.webhookSecretSealed).toBeTruthy()
    const all = [readFileSync(paths.audit, 'utf8'), readFileSync(paths.systemLog, 'utf8'), JSON.stringify((await admin.json('GET', '/api/admin/activity?pageSize=100')).data), JSON.stringify((await admin.json('GET', '/api/admin/logs')).data)]
    for (const t of all) expect(t).not.toContain(SECRET)
    expect(all[2]).toContain('auditForward.webhookSecret')
    expect(JSON.stringify(hookGot.map(g => g.raw))).not.toContain(SECRET)
    // resetting removes it: unsigned again
    expect((await save({ webhookSecret: null })).status).toBe(200)
    expect((await admin.json('GET', '/api/admin/settings')).data.auditForward.webhookSecretSet).toBe(false)
  })

  test('the view tells where the secret comes from, so the page can offer a reset; after a reset the next POST is unsigned', async () => {
    const view = async () => (await admin.json('GET', '/api/admin/settings')).data.auditForward
    expect((await save({ webhookUrl: hookUrl(), webhookSecret: SECRET })).data.auditForward.webhookSecretSource).toBe('web')
    expect((await view()).webhookSecretSource).toBe('web')
    expect((await save({ webhookSecret: null })).status).toBe(200)
    expect((await view()).webhookSecretSource).toBe('default')
    hookGot.length = 0
    audit({ user: 'bob', ip: '3.3.3.3', action: 'delete', target: '/g' })
    await fwd.forwardIdle()
    await wait(() => hookGot.length > 0)
    expect(hookGot.length).toBeGreaterThan(0)
    for (const g of hookGot) {
      expect(g.headers.get('x-fc-signature')).toBeNull()
      expect(g.headers.get('x-fc-timestamp')).toBeNull()
    }
  })

  test('a secret sealed under another key is warned about once, not for every audit entry (and not at all while no URL is set)', async () => {
    const { settings } = await import('../src/settings')
    const { paths } = await import('../src/config')
    const lines = () => readFileSync(paths.systemLog, 'utf8').split('\n').filter(l => l.includes('settings-secret-unreadable')).length
    const burst = async () => {
      for (let i = 0; i < 25; i++) audit({ user: 'bob', ip: '3.3.3.3', action: 'login', target: `/n${i}` })
      await fwd.forwardIdle()
      await Bun.sleep(50)
    }
    await use({ webhookUrl: hookUrl(), webhookSecret: SECRET })
    const sealed = settings.get().auditForward!.webhookSecretSealed!
    settings.update({ auditForward: { ...settings.get().auditForward, webhookSecretSealed: `${sealed.slice(0, -4)}BBBB` } })
    const before = lines()
    await burst()
    expect(lines() - before).toBeLessThanOrEqual(1)
    // still nothing goes out while the saved secret can not be opened
    expect(hookGot.length).toBe(0)
    expect(fwd.forwardStats().lastError).toBe('webhook: secret unreadable')
    // no URL: the secret is not even opened
    settings.update({ auditForward: { ...settings.get().auditForward, webhookUrl: undefined, webhookSealed: undefined, webhookSecretSealed: `${sealed.slice(0, -4)}CCCC` } })
    const mid = lines()
    await burst()
    expect(lines()).toBe(mid)
  })

  test('a secret this server can not open: nothing is sent (not even unsigned), it is counted, and the warning lists it', async () => {
    const { settings } = await import('../src/settings')
    await use({ webhookUrl: hookUrl(), webhookSecret: SECRET })
    const sealed = settings.get().auditForward!.webhookSecretSealed!
    settings.update({ auditForward: { ...settings.get().auditForward, webhookSecretSealed: `${sealed.slice(0, -4)}AAAA` } })
    audit({ user: 'bob', ip: '3.3.3.3', action: 'delete', target: '/g' })
    await fwd.forwardIdle()
    await Bun.sleep(50)
    expect(hookGot.length).toBe(0)
    expect(fwd.forwardStats().failed).toBeGreaterThan(0)
    expect(fwd.forwardStats().lastError).toBe('webhook: secret unreadable')
    const w = (await admin.json('GET', '/api/admin/config-warnings')).data.items.map((i: any) => i.code)
    expect(w).toContain('admin.config-secret-unreadable')
    expect(w).toContain('admin.config-audit-forward-failing')
  })
})

describe('settings', () => {
  test('admin only, password required, unsafe URLs and odd values refused, the URL never shown back', async () => {
    expect((await save({ webhookUrl: hookUrl() }, null)).status).toBe(403)
    expect((await save({ webhookUrl: hookUrl() }, 'wrong-password')).status).toBeGreaterThanOrEqual(400)
    for (const bad of ['http://example.com/x', 'ftp://x/y', 'javascript:alert(1)', 'not a url', 'https://']) {
      const r = await save({ webhookUrl: bad })
      expect(r.status).toBe(400)
      expect(r.data.code).toBe('admin.bad-setting')
    }
    for (const bad of [{ syslogHost: 'a b' }, { syslogHost: 'x;rm' }, { syslogPort: 0 }, { syslogPort: 70000 }, { syslogProto: 'http' }, { syslogFacility: 24 }, { unknown: 1 }]) {
      expect((await save(bad)).status).toBe(400)
    }
    const ok = await save({ webhookUrl: 'https://logs.example.com/ingest?token=TOPSECRET', syslogHost: 'logs.example.com' })
    expect(ok.status).toBe(200)
    expect(JSON.stringify(ok.data)).not.toContain('TOPSECRET')
    expect(ok.data.auditForward.webhookUrl.value).toBe('https://logs.example.com…')
    expect(ok.data.auditForward.syslogHost).toMatchObject({ value: 'logs.example.com', source: 'web' })
    const raw = await Bun.file(`${process.env.DATA_DIR}/settings.json`).text()
    expect(raw).not.toContain('TOPSECRET')
    // a plain-text syslog link to another host is warned about
    const w = (await admin.json('GET', '/api/admin/config-warnings')).data.items.map((i: any) => i.code)
    expect(w).toContain('admin.config-audit-syslog-plain')
    // the change itself is on the trail by key name, and the admins are told like for any destination change
    const act = JSON.stringify((await admin.json('GET', '/api/admin/activity?pageSize=20')).data)
    expect(act).toContain('auditForward.webhookUrl')
    expect(act).not.toContain('TOPSECRET')
  })

  test('another role can not read or change them', async () => {
    const mk = await admin.json('POST', '/api/admin/users', { username: 'af-man', name: 'm', password: 'harbor-lamp-42', role: 'manager', permissions: ['read'], publicPermissions: [] })
    expect(mk.status).toBe(200)
    const man = await new Client().login('af-man', 'harbor-lamp-42')
    expect((await man.json('GET', '/api/admin/settings')).status).toBe(403)
    expect((await man.json('PUT', '/api/admin/settings', { auditForward: { syslogHost: 'x.example' }, password: 'harbor-lamp-42' })).status).toBe(403)
  })
})
