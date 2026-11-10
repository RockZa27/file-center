/**
 * LOCK_OUTBOUND_SETTINGS: the settings that choose where data leaves the server (ClamAV, audit forwarding, alerts, SMTP)
 * come from .env only. A body naming one is refused whole (403 admin.setting-locked) before the password is asked, stored
 * web values are ignored by every reader (and kept), the view marks the locked keys. Runs in-process (see in-process-env.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import './in-process-env'

let app: any
let policy: typeof import('../src/policy')
let settingsMod: typeof import('../src/settings')
let secret: typeof import('../src/secret-box')
let cfg: any
let cookie = ''
let csrf = ''

const GROUPS = ['mail', 'alerts', 'auditForward', 'antivirus'] as const
const ENV_KEYS = ['smtpHost', 'smtpPort', 'clamavHost', 'clamavPort', 'alertWebhookUrl', 'alertWebhookKind', 'lockOutbound'] as const
const savedSettings: Record<string, unknown> = {}
const savedEnv: Record<string, unknown> = {}
let savedName = ''

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
const put = (body: Record<string, unknown>) => call('PUT', '/api/admin/settings', body)
const pw = () => process.env.ADMIN_PASSWORD!
const raw = () => JSON.stringify(settingsMod.settings.get())

/** every locked key with a value that passes validation */
const LOCKED_BODIES: [string, Record<string, unknown>][] = [
  ['antivirus.host', { antivirus: { host: 'av.example.com' } }],
  ['antivirus.port', { antivirus: { port: 3311 } }],
  ['auditForward.syslogHost', { auditForward: { syslogHost: 'logs.example.com' } }],
  ['auditForward.syslogPort', { auditForward: { syslogPort: 1514 } }],
  ['auditForward.syslogProto', { auditForward: { syslogProto: 'tcp' } }],
  ['auditForward.webhookUrl', { auditForward: { webhookUrl: 'https://hook.example.com/x' } }],
  ['auditForward.webhookSecret', { auditForward: { webhookSecret: 'a-secret-of-16-chars-or-more' } }],
  ['alerts.webhookUrl', { alerts: { webhookUrl: 'https://hook.example.com/a' } }],
  ['alerts.kind', { alerts: { kind: 'slack' } }],
  ['alerts.telegramChatId', { alerts: { telegramChatId: '12345' } }],
  ['mail.host', { mail: { host: 'smtp.example.com' } }],
  ['mail.port', { mail: { port: 2525 } }],
  ['mail.secure', { mail: { secure: 'tls' } }],
  ['mail.user', { mail: { user: 'someone' } }],
  ['mail.pass', { mail: { pass: 'a-password' } }],
]

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  policy = await import('../src/policy')
  settingsMod = await import('../src/settings')
  secret = await import('../src/secret-box')
  cfg = (await import('../src/config')).config
  csrf = (await call('GET', '/api/session')).data.csrf
  const r = await call('POST', '/api/login', { username: 'admin', password: pw() })
  expect(r.status).toBe(200)
  csrf = r.data.csrf
  for (const g of GROUPS) savedSettings[g] = (settingsMod.settings.get() as any)[g]
  for (const k of ENV_KEYS) savedEnv[k] = cfg[k]
  savedName = settingsMod.settings.get().appName
})

const restore = () => {
  for (const k of ENV_KEYS) cfg[k] = savedEnv[k]
  settingsMod.settings.update({ ...Object.fromEntries(GROUPS.map(g => [g, savedSettings[g]])), appName: savedName } as any)
}
afterEach(restore)
afterAll(restore)

describe('LOCK_OUTBOUND_SETTINGS', () => {
  test('every locked key is refused with 403 before the password step-up, nothing is saved', async () => {
    cfg.lockOutbound = true
    const before = raw()
    for (const [key, body] of LOCKED_BODIES) {
      const [g, k] = key.split('.')
      // a wrong password: the refusal comes first, so it is not a password failure
      for (const b of [{ ...body, password: 'wrong-password' }, { [g]: { [k]: null }, password: 'wrong-password' }, body]) {
        const r = await put(b)
        expect([key, r.status, r.data.code]).toEqual([key, 403, 'admin.setting-locked'])
        expect(r.data.params.key).toContain(key)
      }
    }
    expect(raw()).toBe(before)
  })

  test('a mixed body saves nothing, an unlocked key of the same group still saves', async () => {
    cfg.lockOutbound = true
    const before = raw()
    const mixed = await put({ antivirus: { maxScanMb: 77, host: 'av.example.com' }, appName: 'Locked Mixed', password: pw() })
    expect([mixed.status, mixed.data.code]).toEqual([403, 'admin.setting-locked'])
    expect(raw()).toBe(before)

    for (const body of [{ antivirus: { maxScanMb: 77 } }, { alerts: { lang: 'en' } }, { mail: { from: 'Files <files@example.com>' } }, { auditForward: { syslogFacility: 5 } }]) {
      const r = await put({ ...body, password: pw() })
      expect([r.status, JSON.stringify(body)]).toEqual([200, JSON.stringify(body)])
    }
    expect(settingsMod.settings.get().antivirus?.maxScanMb).toBe(77)
    expect(settingsMod.settings.get().appName).toBe(savedName)
  })

  test('without the lock every locked key saves with the password as before', async () => {
    cfg.lockOutbound = false
    const r = await put({ antivirus: { host: 'av.example.com', port: 3311 }, mail: { host: 'smtp.example.com' }, password: pw() })
    expect(r.status).toBe(200)
    expect(settingsMod.settings.get().antivirus?.host).toBe('av.example.com')
    expect(r.data.antivirus.host.locked).toBeUndefined()
  })

  test('stored web values are ignored while locked (and kept), and back when unlocked', () => {
    settingsMod.settings.update({
      antivirus: { host: 'web-av.example.com', port: 9999 },
      mail: { host: 'web-smtp.example.com', port: 2525, secure: 'none', user: 'web-user', passSealed: secret.seal('web-pass') },
      alerts: { webhookSealed: secret.seal('https://web.example.com/hook'), kind: 'slack', telegramChatId: 'web-chat' },
      auditForward: { syslogHost: 'web-logs.example.com', syslogPort: 1514, syslogProto: 'tcp', webhookSealed: secret.seal('https://web.example.com/audit'), webhookSecretSealed: secret.seal('web-secret-0123456789') },
    })
    cfg.clamavHost = 'env-av'; cfg.clamavPort = 3310; cfg.smtpHost = 'env-smtp'; cfg.smtpPort = 587
    cfg.alertWebhookUrl = ''; cfg.alertWebhookKind = 'json'

    cfg.lockOutbound = true
    expect(policy.antivirusValues()).toMatchObject({ host: 'env-av', port: 3310 })
    expect(policy.mail()).toMatchObject({ host: 'env-smtp', port: 587, pass: cfg.smtpPass })
    expect(policy.alertValues()).toMatchObject({ url: '', kind: 'json', chatId: cfg.alertTelegramChatId })
    expect(policy.auditForwardValues()).toMatchObject({ syslogHost: '', syslogPort: 514, syslogProto: 'udp', webhookUrl: '', webhookSecret: '' })
    expect(policy.ignoredLockedKeys().sort()).toEqual(policy.LOCKED_WHEN_OUTBOUND_LOCK.slice().sort())
    // kept in settings.json
    expect(settingsMod.settings.get().antivirus?.host).toBe('web-av.example.com')

    cfg.lockOutbound = false
    expect(policy.antivirusValues()).toMatchObject({ host: 'web-av.example.com', port: 9999 })
    expect(policy.mail()).toMatchObject({ host: 'web-smtp.example.com', pass: 'web-pass' })
    expect(policy.alertValues()).toMatchObject({ url: 'https://web.example.com/hook', kind: 'slack' })
    expect(policy.auditForwardValues()).toMatchObject({ syslogHost: 'web-logs.example.com', webhookUrl: 'https://web.example.com/audit' })
    expect(policy.ignoredLockedKeys()).toEqual([])
  })

  test('a real alert goes to the env target, not the stored web one', async () => {
    const got: string[] = []
    const web = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => { got.push('web'); return new Response('ok') } })
    const env = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => { got.push('env'); return new Response('ok') } })
    try {
      settingsMod.settings.update({ alerts: { webhookSealed: secret.seal(`http://127.0.0.1:${web.port}/web`), kind: 'json' } })
      cfg.alertWebhookUrl = `http://127.0.0.1:${env.port}/env`
      cfg.alertWebhookKind = 'json'
      cfg.lockOutbound = true
      const r = await call('POST', '/api/admin/alerts/test', {})
      expect(r.status).toBe(200)
      expect(got).toEqual(['env'])
    } finally { web.stop(true); env.stop(true) }
  })

  test('a locked key\'s unreadable stored secret is not reported', () => {
    settingsMod.settings.update({ mail: { passSealed: 'not-a-sealed-value' }, alerts: { webhookSealed: 'garbage' }, auditForward: { webhookSealed: 'garbage', webhookSecretSealed: 'garbage' } })
    cfg.lockOutbound = false
    expect(policy.unreadableSecrets().length).toBe(4)
    cfg.lockOutbound = true
    expect(policy.unreadableSecrets()).toEqual([])
  })

  test('the view marks exactly the locked keys while on, nothing when off', async () => {
    cfg.lockOutbound = true
    const on = (await call('GET', '/api/admin/settings')).data
    const flagged: string[] = []
    for (const g of GROUPS) {
      for (const [k, v] of Object.entries<any>(on[g])) {
        if (v?.locked) {
          flagged.push(`${g}.${k}`)
          expect(v.source).not.toBe('web')
        }
      }
    }
    // the two write-only secrets carry their flag next to passSet / webhookSecretSet
    expect(on.mail.passLocked).toBe(true)
    expect(on.auditForward.webhookSecretLocked).toBe(true)
    const keys = policy.LOCKED_WHEN_OUTBOUND_LOCK.filter(p => p !== 'mail.pass' && p !== 'auditForward.webhookSecret')
    expect(flagged.sort()).toEqual(keys.sort())
    expect(on.antivirus.maxScanMb.locked).toBeUndefined()
    expect(on.alerts.lang.locked).toBeUndefined()
    expect(on.mail.from.locked).toBeUndefined()

    cfg.lockOutbound = false
    const off = JSON.stringify((await call('GET', '/api/admin/settings')).data)
    expect(off).not.toContain('"locked"')
    expect(off).not.toContain('passLocked')
    expect(off).not.toContain('webhookSecretLocked')
  })
})
