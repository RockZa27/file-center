/**
 * Audit forwarding from .env (AUDIT_SYSLOG_*, AUDIT_WEBHOOK_URL / _SECRET): the fallback of the web settings, and the only
 * source while LOCK_OUTBOUND_SETTINGS is on. A bad AUDIT_WEBHOOK_SECRET stops the webhook (never unsigned sending), a lock
 * refusal is audited as settings-locked. Local receivers only. Runs in-process (see in-process-env.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createSocket, type Socket } from 'node:dgram'
import { createServer, type Server } from 'node:net'
import './in-process-env'

let app: any
let fwd: typeof import('../src/audit-forward')
let policy: typeof import('../src/policy')
let settingsMod: typeof import('../src/settings')
let secretBox: typeof import('../src/secret-box')
let cfg: any
let audit: typeof import('../src/audit').audit
let cookie = ''
let csrf = ''

const ENV_KEYS = ['auditSyslogHost', 'auditSyslogPort', 'auditSyslogProto', 'auditSyslogFacility', 'auditWebhookUrl', 'auditWebhookSecret', 'lockOutbound'] as const
const savedEnv: Record<string, unknown> = {}
let savedGroup: unknown
const savedTiming = {} as typeof fwd.FORWARD_TIMING

const ENV_SECRET = 'env-signing-secret-0123456789'
const WEB_SECRET = 'web-signing-secret-0123456789'
const udpGot: string[] = []
let udp: Socket
const tcpGot: Buffer[] = []
let tcpServer: Server
const hookGot: { path: string; raw: string; headers: Headers }[] = []
let hook: ReturnType<typeof Bun.serve>
const hookUrl = (p = '/env') => `http://127.0.0.1:${hook.port}${p}`
const wait = async (cond: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await Bun.sleep(10) }
/** forget what the setup itself forwarded */
const quiet = async () => { await fwd.forwardIdle(); fwd.resetForwarding(); udpGot.length = 0; tcpGot.length = 0; hookGot.length = 0 }

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

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  fwd = await import('../src/audit-forward')
  policy = await import('../src/policy')
  settingsMod = await import('../src/settings')
  secretBox = await import('../src/secret-box')
  cfg = (await import('../src/config')).config
  ;({ audit } = await import('../src/audit'))
  Object.assign(savedTiming, fwd.FORWARD_TIMING)
  fwd.FORWARD_TIMING.flushMs = 20
  for (const k of ENV_KEYS) savedEnv[k] = cfg[k]
  savedGroup = (settingsMod.settings.get() as any).auditForward
  udp = createSocket('udp4')
  udp.on('message', m => udpGot.push(m.toString('utf8')))
  await new Promise<void>(r => udp.bind(0, '127.0.0.1', r))
  tcpServer = createServer(s => s.on('data', d => tcpGot.push(d)))
  await new Promise<void>(r => tcpServer.listen(0, '127.0.0.1', r))
  hook = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { hookGot.push({ path: new URL(req.url).pathname, raw: await req.text(), headers: req.headers }); return new Response('ok') } })
  csrf = (await call('GET', '/api/session')).data.csrf
  const r = await call('POST', '/api/login', { username: 'admin', password: process.env.ADMIN_PASSWORD })
  expect(r.status).toBe(200)
  csrf = r.data.csrf
})

const restore = async () => {
  // env targets off first, so nothing queued later goes to a receiver that is about to close
  for (const k of ENV_KEYS) cfg[k] = savedEnv[k]
  settingsMod.settings.update({ auditForward: savedGroup } as any)
  await fwd.forwardIdle()
  fwd.resetForwarding()
  udpGot.length = 0; tcpGot.length = 0; hookGot.length = 0
}
afterEach(restore)
afterAll(async () => {
  await restore()
  Object.assign(fwd.FORWARD_TIMING, savedTiming)
  udp.close(); tcpServer.close(); void hook.stop(true)
})

const udpPort = () => (udp.address() as any).port
const tcpPort = () => (tcpServer.address() as any).port
const sign = (secret: string, ts: string, raw: string) => new Bun.CryptoHasher('sha256', secret).update(`${ts}.${raw}`).digest('hex')

describe('audit forwarding from .env', () => {
  test('locked: the webhook goes to AUDIT_WEBHOOK_URL, signed with AUDIT_WEBHOOK_SECRET, not to a stored web URL', async () => {
    // a stored web destination that is ignored while locked: it must receive nothing
    settingsMod.settings.update({ auditForward: { webhookSealed: secretBox.seal(hookUrl('/web')), webhookSecretSealed: secretBox.seal(WEB_SECRET) } } as any)
    cfg.lockOutbound = true
    cfg.auditWebhookUrl = hookUrl('/env')
    cfg.auditWebhookSecret = ENV_SECRET
    await quiet()
    audit({ user: 'tester', ip: '127.0.0.1', action: 'login' })
    await wait(() => hookGot.length > 0)
    expect(hookGot.map(h => h.path)).toEqual(['/env'])
    const h = hookGot[0]
    const ts = h.headers.get('x-fc-timestamp')!
    expect(h.headers.get('x-fc-signature')).toBe('sha256=' + sign(ENV_SECRET, ts, h.raw))
    expect(h.headers.get('x-fc-signature')).not.toBe('sha256=' + sign(WEB_SECRET, ts, h.raw))
    expect(JSON.parse(h.raw).entries[0].action).toBe('login')
  })

  test('locked: AUDIT_SYSLOG_HOST / PORT get the line over UDP and over TCP', async () => {
    cfg.lockOutbound = true
    cfg.auditSyslogHost = '127.0.0.1'
    cfg.auditSyslogPort = String(udpPort())
    await quiet()
    audit({ user: 'tester', ip: '127.0.0.1', action: 'login' })
    await wait(() => udpGot.length > 0)
    expect(udpGot[0]).toContain(' login ')
    expect(udpGot[0].startsWith('<110>1 ')).toBe(true)

    cfg.auditSyslogPort = String(tcpPort())
    cfg.auditSyslogProto = 'tcp'
    cfg.auditSyslogFacility = '5'
    await quiet()
    audit({ user: 'tester', ip: '127.0.0.1', action: 'logout' })
    await wait(() => tcpGot.length > 0)
    const text = Buffer.concat(tcpGot).toString('utf8')
    expect(text).toContain(' logout ')
    expect(text).toMatch(/^\d+ <46>1 /)
  })

  test('an invalid AUDIT_WEBHOOK_SECRET sends nothing (not unsigned) and its value is not echoed', async () => {
    cfg.auditWebhookUrl = hookUrl('/env')
    cfg.auditWebhookSecret = 'too short'
    await quiet()
    expect(policy.auditForwardValues()).toMatchObject({ webhookUrl: hookUrl('/env'), webhookSecretBroken: true })
    audit({ user: 'tester', ip: '127.0.0.1', action: 'login' })
    await fwd.forwardIdle()
    expect(hookGot.length).toBe(0)
    expect(fwd.forwardStats().failed).toBeGreaterThan(0)
    expect(policy.auditEnv().invalid).toEqual(['AUDIT_WEBHOOK_SECRET'])
    expect(JSON.stringify(policy.auditEnv().invalid)).not.toContain('too short')
  })

  test('bad values are ignored with their variable named; a bad URL is never used', () => {
    Object.assign(cfg, { auditSyslogHost: 'bad host!', auditSyslogPort: '70000', auditSyslogProto: 'icmp', auditSyslogFacility: '24', auditWebhookUrl: 'http://example.com/hook' })
    expect(policy.auditEnv().invalid).toEqual(['AUDIT_SYSLOG_HOST', 'AUDIT_SYSLOG_PORT', 'AUDIT_SYSLOG_PROTO', 'AUDIT_SYSLOG_FACILITY', 'AUDIT_WEBHOOK_URL'])
    expect(policy.auditForwardValues()).toMatchObject({ syslogHost: '', syslogPort: 514, syslogProto: 'udp', syslogFacility: 13, webhookUrl: '', webhookSecretBroken: false })
  })

  test('the view says env for these and never carries the secret or the URL path', () => {
    cfg.lockOutbound = true
    Object.assign(cfg, { auditSyslogHost: 'logs.example.com', auditSyslogPort: '1514', auditSyslogProto: 'tcp', auditWebhookUrl: 'https://hook.example.com/very/private/token', auditWebhookSecret: ENV_SECRET })
    const a = policy.policyView().auditForward as any
    expect(a.syslogHost).toMatchObject({ value: 'logs.example.com', source: 'env', locked: true })
    expect(a.syslogPort).toMatchObject({ value: 1514, source: 'env' })
    expect(a.syslogProto).toMatchObject({ value: 'tcp', source: 'env' })
    expect(a.syslogFacility.source).toBe('default')
    expect(a.webhookUrl).toMatchObject({ source: 'env' })
    expect(a.webhookSecretSet).toBe(true)
    expect(a.webhookSecretSource).toBe('env')
    const text = JSON.stringify(policy.policyView())
    expect(text).not.toContain(ENV_SECRET)
    expect(text).not.toContain('private/token')
  })

  test('not locked: a web value wins over .env, and .env is the fallback; nothing set = off as before', () => {
    cfg.lockOutbound = false
    settingsMod.settings.update({ auditForward: {} } as any)
    expect(policy.auditForwardValues()).toMatchObject({ syslogHost: '', webhookUrl: '', webhookSecret: '', webhookSecretBroken: false })
    cfg.auditSyslogHost = 'env-logs.example.com'
    cfg.auditWebhookUrl = 'https://env.example.com/h'
    expect(policy.auditForwardValues()).toMatchObject({ syslogHost: 'env-logs.example.com', webhookUrl: 'https://env.example.com/h' })
    settingsMod.settings.update({ auditForward: { syslogHost: 'web-logs.example.com', webhookSealed: secretBox.seal('https://web.example.com/h') } } as any)
    expect(policy.auditForwardValues()).toMatchObject({ syslogHost: 'web-logs.example.com', webhookUrl: 'https://web.example.com/h' })
    expect((policy.policyView().auditForward as any).syslogHost.source).toBe('web')
  })

  test('a refusal because of the lock is audited as settings-locked, not settings-denied', async () => {
    cfg.lockOutbound = true
    const r = await call('PUT', '/api/admin/settings', { auditForward: { syslogHost: 'logs.example.com' }, password: process.env.ADMIN_PASSWORD })
    expect([r.status, r.data.code]).toEqual([403, 'admin.setting-locked'])
    const a = await call('GET', '/api/admin/activity?action=settings-locked')
    expect(a.status).toBe(200)
    expect(a.data.items.some((e: any) => e.action === 'settings-locked' && e.detail === 'auditForward.syslogHost')).toBe(true)
  })
})
