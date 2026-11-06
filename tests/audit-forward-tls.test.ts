/**
 * Audit forwarding to syslog over TLS (src/audit-forward.ts): same octet-counted framing as TCP, certificate always verified
 * (system CAs plus AUDIT_SYSLOG_CA), nothing sent when verification fails, no plain-text warning for tls, and the web / .env
 * values accept `tls`. The server certificate is a fixed self-signed test pair (tests/fixtures, SAN localhost + 127.0.0.1).
 * Local receivers only. Runs in-process (see in-process-env.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:tls'
import './in-process-env'

let app: any
let fwd: typeof import('../src/audit-forward')
let policy: typeof import('../src/policy')
let cfg: any
let audit: typeof import('../src/audit').audit
let cookie = ''
let csrf = ''

const CERT = join(import.meta.dir, 'fixtures', 'syslog-tls-cert.pem')
const KEY = join(import.meta.dir, 'fixtures', 'syslog-tls-key.pem')
const got: Buffer[] = []
let handshakes = 0
let server: Server
const port = () => (server.address() as any).port
const text = () => Buffer.concat(got).toString('utf8')
const wait = async (cond: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await Bun.sleep(10) }
const savedTiming = {} as typeof fwd.FORWARD_TIMING
const savedCfg = {} as Record<string, unknown>

async function call(method: string, path: string, body?: any) {
  const h: Record<string, string> = {}
  if (cookie) h.cookie = cookie
  if (csrf) h['x-csrf-token'] = csrf
  if (body !== undefined) h['content-type'] = 'application/json'
  const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }))
  const set = res.headers.get('set-cookie')
  if (set?.startsWith('fc_sid=')) cookie = set.split(';')[0]
  return { status: res.status, data: (await res.json().catch(() => null)) as any }
}
const save = (auditForward: Record<string, unknown>) => call('PUT', '/api/admin/settings', { auditForward, password: process.env.ADMIN_PASSWORD })
const clear = () => save({ syslogHost: null, syslogPort: null, syslogProto: null, syslogFacility: null, webhookUrl: null, webhookSecret: null })
/** save the destination, then forget the settings-update entry that this very save forwarded */
const use = async (c: Record<string, unknown>) => { await save(c); await fwd.forwardIdle(); fwd.resetForwarding(); await Bun.sleep(50); got.length = 0; handshakes = 0 }

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  fwd = await import('../src/audit-forward')
  policy = await import('../src/policy')
  cfg = (await import('../src/config')).config
  ;({ audit } = await import('../src/audit'))
  Object.assign(savedTiming, fwd.FORWARD_TIMING)
  for (const k of ['auditSyslogCa', 'auditSyslogProto']) savedCfg[k] = cfg[k]
  fwd.FORWARD_TIMING.flushMs = 20
  server = createServer({ cert: readFileSync(CERT), key: readFileSync(KEY) }, s => { handshakes++; s.on('data', d => got.push(d)); s.on('error', () => {}) })
  server.on('tlsClientError', () => {})
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  csrf = (await call('GET', '/api/session')).data.csrf
  const r = await call('POST', '/api/login', { username: 'admin', password: process.env.ADMIN_PASSWORD })
  expect(r.status).toBe(200)
  csrf = r.data.csrf
})
afterEach(async () => {
  await clear()
  fwd.resetForwarding()
  Object.assign(fwd.FORWARD_TIMING, savedTiming, { flushMs: 20 })
  Object.assign(cfg, savedCfg)
  got.length = 0; handshakes = 0
})
afterAll(() => { server.close() })

describe('syslog over TLS', () => {
  test('with AUDIT_SYSLOG_CA the entry arrives encrypted, octet-counted like TCP', async () => {
    cfg.auditSyslogCa = CERT
    await use({ syslogHost: '127.0.0.1', syslogPort: port(), syslogProto: 'tls' })
    audit({ user: 'bob', ip: '10.1.2.3', action: 'rename', target: '/a b.txt', detail: 'to c.txt' })
    await fwd.forwardIdle()
    await wait(() => text().includes(' rename '))
    const m = text().match(/^(\d+) (<110>1 \S+ \S+ file-center \d+ rename \[fc@32473 user="bob" ip="10\.1\.2\.3" target="\/a b\.txt"\] to c\.txt)$/)
    expect(m).not.toBeNull()
    expect(Buffer.byteLength(m![2])).toBe(+m![1])
    expect(handshakes).toBe(1)
    expect(fwd.forwardStats().sent).toBeGreaterThan(0)
  })

  test('a host name is checked against the certificate name, and one connection is reused', async () => {
    cfg.auditSyslogCa = CERT
    await use({ syslogHost: 'localhost', syslogPort: port(), syslogProto: 'tls' })
    audit({ user: 'a', ip: '1.1.1.1', action: 'one' })
    await fwd.forwardIdle()
    audit({ user: 'a', ip: '1.1.1.1', action: 'two' })
    await fwd.forwardIdle()
    await wait(() => text().includes(' two '))
    expect(text()).toContain(' one ')
    expect(handshakes).toBe(1)
  })

  test('without the CA the certificate is refused: nothing is sent, the failure is counted and warned about', async () => {
    cfg.auditSyslogCa = ''
    await use({ syslogHost: '127.0.0.1', syslogPort: port(), syslogProto: 'tls' })
    audit({ user: 'carol', ip: '10.9.9.9', action: 'secret-action' })
    await fwd.forwardIdle()
    await Bun.sleep(100)
    expect(text()).toBe('')
    const st = fwd.forwardStats()
    expect(st.sent).toBe(0)
    expect(st.failed).toBeGreaterThan(0)
    expect(st.lastError).toMatch(/^syslog: /)
    expect(fwd.forwardFailing()).toBe(true)
    const w = (await call('GET', '/api/admin/config-warnings')).data.items.map((i: any) => i.code)
    expect(w).toContain('admin.config-audit-forward-failing')
  })

  test('an unreadable or invalid AUDIT_SYSLOG_CA is reported and does not make the connection trusted', async () => {
    cfg.auditSyslogCa = '/nonexistent/ca.pem'
    expect(fwd.syslogCa().state).toBe('invalid')
    const bad = join(process.env.DATA_DIR!, 'not-a-ca.pem')
    writeFileSync(bad, 'hello\n')
    try {
      cfg.auditSyslogCa = bad
      expect(fwd.syslogCa()).toMatchObject({ pem: '', state: 'invalid' })
      cfg.auditSyslogCa = CERT
      expect(fwd.syslogCa().state).toBe('ok')
      cfg.auditSyslogCa = ''
      expect(fwd.syslogCa().state).toBe('none')
      cfg.auditSyslogCa = bad
      await use({ syslogHost: '127.0.0.1', syslogPort: port(), syslogProto: 'tls' })
      audit({ user: 'x', ip: '1.1.1.1', action: 'nope' })
      await fwd.forwardIdle()
      await Bun.sleep(50)
      expect(text()).toBe('')
      expect(fwd.forwardStats().failed).toBeGreaterThan(0)
    } finally { rmSync(bad, { force: true }) }
  })
})

describe('settings and warnings for tls', () => {
  test('the web setting accepts tls and refuses an unknown protocol', async () => {
    expect((await save({ syslogProto: 'http' })).status).toBe(400)
    expect((await save({ syslogProto: 'ssl' })).status).toBe(400)
    const ok = await save({ syslogHost: '127.0.0.1', syslogProto: 'tls', syslogPort: 6514 })
    expect(ok.status).toBe(200)
    expect(ok.data.auditForward.syslogProto).toMatchObject({ value: 'tls', source: 'web' })
    expect(policy.auditForwardValues().syslogPort).toBe(6514)
  })

  test('AUDIT_SYSLOG_PROTO=tls is accepted, an invalid one still falls back and is named', () => {
    cfg.auditSyslogProto = 'tls'
    expect(policy.auditEnv().proto).toEqual({ value: 'tls', set: true })
    expect(policy.auditEnv().invalid).not.toContain('AUDIT_SYSLOG_PROTO')
    cfg.auditSyslogProto = 'tlss'
    expect(policy.auditEnv().proto).toEqual({ value: 'udp', set: false })
    expect(policy.auditEnv().invalid).toContain('AUDIT_SYSLOG_PROTO')
  })

  test('the plain-text warning is for udp / tcp to another host, not for tls', async () => {
    fwd.FORWARD_TIMING.timeoutMs = 200
    const codes = async () => (await call('GET', '/api/admin/config-warnings')).data.items.map((i: any) => i.code)
    await save({ syslogHost: '192.0.2.1', syslogProto: 'tls', syslogPort: 6514 })
    expect(await codes()).not.toContain('admin.config-audit-syslog-plain')
    await save({ syslogProto: 'tcp' })
    expect(await codes()).toContain('admin.config-audit-syslog-plain')
    await save({ syslogProto: 'udp' })
    expect(await codes()).toContain('admin.config-audit-syslog-plain')
    await save({ syslogProto: 'tls' })
    expect(await codes()).not.toContain('admin.config-audit-syslog-plain')
  })
})
