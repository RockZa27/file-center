/**
 * Runtime settings (src/policy.ts): what the admin saves on the settings page wins over the .env value, which wins over
 * the default; null goes back to the env value; risky groups ask for the password; and every change applies at once.
 * Runs in-process on the shared app (see in-process-env.ts), so whatever a test saves is cleared again in afterEach.
 * Users here start with "sp-".
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import net from 'node:net'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import './in-process-env'

let app: any
let config: typeof import('../src/config').config
let paths: typeof import('../src/config').paths
let settings: typeof import('../src/settings').settings
let policy: typeof import('../src/policy')
let alerts: typeof import('../src/alerts')
let secretBox: typeof import('../src/secret-box')
let auth: typeof import('../src/auth')
let totp: typeof import('../src/totp')
let backup: typeof import('../src/backup')

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
const ADMIN_PW = process.env.ADMIN_PASSWORD!
const admin = new Client()
const put = (body: any) => admin.json('PUT', '/api/admin/settings', body)
const get = async () => (await admin.json('GET', '/api/admin/settings')).data
const withPw = (body: any) => ({ ...body, password: ADMIN_PW })
const home = (user: string, ...p: string[]) => join(process.env.STORAGE_DIR!, 'users', user, ...p)

async function userWith(username: string, permissions: string[], role = 'user') {
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role, permissions, publicPermissions: [] })
  expect(r.status).toBe(200)
  return new Client().login(username, PW)
}

// a stand-in for a webhook: every body it gets
let hookBodies: string[] = []
let hook: ReturnType<typeof Bun.serve>
const HOOK_SECRET = 'bot123456:SECRET-TOKEN-PART'
const hookUrl = () => `http://127.0.0.1:${hook.port}/${HOOK_SECRET}/send`

// a stand-in for an SMTP server: the mails it got and what the client logged in with
type Mail = { to: string[]; auth: string[]; data: string }
let mails: Mail[] = []
let smtpServer: net.Server
function startSmtp(): Promise<number> {
  smtpServer = net.createServer(sock => {
    let buf = ''
    let inData = false
    let cur: Mail = { to: [], auth: [], data: '' }
    const say = (s: string) => sock.write(`${s}\r\n`)
    sock.on('error', () => {})
    sock.on('data', chunk => {
      buf += chunk.toString('latin1')
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n')
          if (end < 0) return
          cur.data = buf.slice(0, end)
          buf = buf.slice(end + 5)
          inData = false
          mails.push(cur)
          cur = { to: [], auth: [], data: '' }
          say('250 queued')
          continue
        }
        const nl = buf.indexOf('\r\n')
        if (nl < 0) return
        const cmd = buf.slice(0, nl)
        buf = buf.slice(nl + 2)
        const verb = cmd.split(' ')[0].toUpperCase()
        if (verb === 'EHLO') { say('250-stub.test'); say('250 AUTH PLAIN') }
        else if (verb === 'AUTH') { cur.auth.push(Buffer.from(cmd.split(' ')[2] ?? '', 'base64').toString()); say('235 ok') }
        else if (verb === 'MAIL') say('250 ok')
        else if (verb === 'RCPT') { cur.to.push(/<([^>]*)>/.exec(cmd)?.[1] ?? ''); say('250 ok') }
        else if (verb === 'DATA') { inData = true; say('354 go') }
        else if (verb === 'QUIT') { say('221 bye'); sock.end() }
        else say('502 no')
      }
    })
    say('220 stub ESMTP')
  })
  return new Promise(resolve => smtpServer.listen(0, '127.0.0.1', () => resolve((smtpServer.address() as net.AddressInfo).port)))
}

const saved: Record<string, any> = {}
const ENV_KEYS = ['TRASH_RETENTION_DAYS', 'SESSION_TTL_HOURS']

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config, paths } = await import('../src/config'))
  ;({ settings } = await import('../src/settings'))
  policy = await import('../src/policy')
  alerts = await import('../src/alerts')
  secretBox = await import('../src/secret-box')
  auth = await import('../src/auth')
  totp = await import('../src/totp')
  backup = await import('../src/backup')
  hook = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async req => { hookBodies.push(await req.text()); return new Response('ok') } })
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  Object.assign(saved, { publicUrl: config.publicUrl, trustProxy: config.trustProxy, secureCookie: config.secureCookie, unsigned: config.updateAllowUnsigned, trash: config.trashRetentionDays })
  await admin.login('admin', ADMIN_PW)
})

/** back to a settings.json from before these settings existed */
function clearPolicy() {
  settings.update({ share: undefined, security: undefined, files: undefined, mail: undefined, alerts: undefined, guestPermissions: ['read', 'download', 'batchdownload'] })
}

afterEach(async () => {
  // wrong passwords of the step-up tests must not lock the admin out of the next one
  auth.clearFailures('step-up|unknown|admin')
  await alerts.alertsIdle()
  alerts.resetAlerts()
  clearPolicy()
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  config.trashRetentionDays = saved.trash
  config.publicUrl = saved.publicUrl
  config.trustProxy = saved.trustProxy
  config.secureCookie = saved.secureCookie
  config.updateAllowUnsigned = saved.unsigned
  config.smtpHost = ''
  hookBodies = []
  mails = []
})

afterAll(() => {
  hook.stop(true)
  smtpServer?.close()
  clearPolicy()
})

describe('settings: precedence', () => {
  test('a settings.json without the new keys follows the env values, source env or default', async () => {
    clearPolicy()
    const s = await get()
    expect(s.share.maxDays).toEqual({ value: config.shareMaxDays, source: 'default' })
    expect(s.share.requirePassword).toEqual({ value: false, source: 'default' })
    expect(s.security.require2fa).toEqual({ value: 'none', source: 'default' })
    expect(s.files.trashRetentionDays.value).toBe(config.trashRetentionDays)
    expect(s.files.webdav).toEqual({ value: config.webdav, source: 'default' })
    expect(s.files.defaultQuotaBytes).toEqual({ value: null, source: 'default' })
    expect(policy.sessionTtlMs()).toBe(config.sessionTtlMs)
    expect(policy.loginMaxAttempts()).toBe(config.loginMaxAttempts)
    expect(policy.uploadMaxSize()).toBe(config.uploadMaxSize)
    expect(policy.versionsKeep()).toBe(config.versionsKeep)
    expect(policy.mail().host).toBe(config.smtpHost)
    expect(policy.alertValues().url).toBe(config.alertWebhookUrl)
    // the old fields are still there as they were
    expect(s.appName).toBeTruthy()
    expect(Array.isArray(s.guestPermissions)).toBe(true)
  })

  test('web wins over env, env wins over default, null goes back to env', async () => {
    process.env.TRASH_RETENTION_DAYS = '12'
    config.trashRetentionDays = 12
    expect((await get()).files.trashRetentionDays).toEqual({ value: 12, source: 'env' })
    let r = await put({ files: { trashRetentionDays: 5 } })
    expect(r.status).toBe(200)
    expect(r.data.files.trashRetentionDays).toEqual({ value: 5, source: 'web' })
    expect(policy.trashRetentionDays()).toBe(5)
    r = await put({ files: { trashRetentionDays: null } })
    expect(r.data.files.trashRetentionDays).toEqual({ value: 12, source: 'env' })
    expect(policy.trashRetentionDays()).toBe(12)
    // a key that was not named stays as it is
    await put({ files: { versionsKeep: 3 } })
    await put({ files: { versionsDays: 9 } })
    const f = (await get()).files
    expect([f.versionsKeep.value, f.versionsDays.value]).toEqual([3, 9])
  })

  test('the saved file holds only what was set', async () => {
    await put({ files: { thumbnails: false } })
    await settings.idle()
    const raw = JSON.parse(readFileSync(paths.settings, 'utf8'))
    expect(raw.files).toEqual({ thumbnails: false })
    expect(raw.share).toBeUndefined()
    expect(raw.mail).toBeUndefined()
    await put({ files: { thumbnails: null } })
    await settings.idle()
    expect(JSON.parse(readFileSync(paths.settings, 'utf8')).files).toBeUndefined()
  })
})

describe('settings: validation', () => {
  test('wrong values answer 400 and save nothing', async () => {
    const wrong: any[] = [
      { share: { defaultDays: 5 } }, { share: { maxDays: 2 } }, { share: { allowNever: 'yes' } }, { share: { requirePassword: 1 } },
      { share: { maxDays: 7, defaultDays: 14 } },
      { security: { require2fa: 'everyone' } }, { security: { sessionTtlHours: 0 } }, { security: { sessionTtlHours: 2161 } },
      { security: { loginMaxAttempts: 2 } }, { security: { loginMaxAttempts: 21 } },
      { security: { loginLockoutSeconds: 29 } }, { security: { loginLockoutSeconds: 3601 } }, { security: { loginLockoutSeconds: 60.5 } },
      { files: { trashRetentionDays: 0 } }, { files: { trashRetentionDays: 366 } }, { files: { versionsKeep: 101 } }, { files: { versionsKeep: -1 } },
      { files: { versionsDays: 0 } }, { files: { versionsDays: 366 } }, { files: { webdav: 'off' } }, { files: { thumbnails: 1 } },
      { files: { defaultQuotaBytes: -5 } }, { files: { uploadMaxSize: 0 } },
      { mail: { host: 'bad host!' } }, { mail: { port: 0 } }, { mail: { port: 70000 } }, { mail: { secure: 'ssl' } },
      { alerts: { webhookUrl: 'http://example.com/hook' } }, { alerts: { webhookUrl: 'nope' } }, { alerts: { kind: 'sms' } }, { alerts: { lang: 'fr' } },
      { files: { nothing: 1 } }, { share: [] }, { share: null },
    ]
    for (const body of wrong) {
      const r = await put(withPw(body))
      expect(`${JSON.stringify(body)} ${r.status}`).toBe(`${JSON.stringify(body)} 400`)
      expect(r.data.code).toBe('admin.bad-setting')
    }
    expect((await get()).files.thumbnails.source).not.toBe('web')
    // one wrong key keeps the good ones in the same request from being saved
    const mixed = await put({ files: { trashRetentionDays: 4, versionsKeep: 500 } })
    expect(mixed.status).toBe(400)
    expect((await get()).files.trashRetentionDays.source).not.toBe('web')
  })

  test('upload size: above the UPLOAD_MAX_SIZE of the process is refused, below it applies at once', async () => {
    const over = await put({ files: { uploadMaxSize: policy.UPLOAD_CEILING + 1 } })
    expect([over.status, over.data.code]).toEqual([400, 'admin.upload-over-ceiling'])
    expect((await put({ files: { uploadMaxSize: policy.UPLOAD_CEILING } })).status).toBe(200)
    expect((await put({ files: { uploadMaxSize: 1000 } })).status).toBe(200)
    expect((await admin.json('GET', '/api/session')).data.config.uploadMaxSize).toBe(1000)
    const init = await admin.json('POST', '/api/upload', { space: 'home', path: '/', name: 'sp-big.bin', size: 2000 })
    expect([init.status, init.data.code]).toEqual([413, 'upload.too-big'])
    expect((await get()).files.uploadMaxSizeCeiling).toBe(policy.UPLOAD_CEILING)
  })
})

describe('settings: step-up password', () => {
  test('security and mail changes need the admin password', async () => {
    for (const body of [{ security: { sessionTtlHours: 5 } }, { mail: { host: 'smtp.example.com' } }, { security: { require2fa: null } }]) {
      const none = await put(body)
      expect([none.status, none.data.code]).toEqual([403, 'auth.wrong-password'])
      const wrong = await put({ ...body, password: 'not-the-password' })
      expect([wrong.status, wrong.data.code]).toEqual([403, 'auth.wrong-password'])
      auth.clearFailures('step-up|unknown|admin')
    }
    expect((await get()).security.sessionTtlHours.source).not.toBe('web')
    const ok = await put(withPw({ security: { sessionTtlHours: 5 } }))
    expect(ok.status).toBe(200)
    expect(ok.data.security.sessionTtlHours).toEqual({ value: 5, source: 'web' })
  })

  test('visitors gaining write, upload or zip need it; read-only rights and share/files settings do not', async () => {
    for (const p of ['write', 'upload', 'zip']) {
      const r = await put({ guestPermissions: ['read', 'download', p] })
      expect([r.status, r.data.code]).toEqual([403, 'auth.wrong-password'])
      auth.clearFailures('step-up|unknown|admin')
    }
    expect((await put(withPw({ guestPermissions: ['read', 'upload'] }))).status).toBe(200)
    // dropping or keeping a right is not a widening
    expect((await put({ guestPermissions: ['read'] })).status).toBe(200)
    expect((await put({ guestPermissions: ['read', 'download'] })).status).toBe(200)
    expect((await put(withPw({ share: { requirePassword: true }, files: { thumbnails: false }, alerts: { lang: 'en' } }))).status).toBe(200)
  })

  test('a security change is in the activity log by key (no value) and goes out as an alert', async () => {
    expect((await put(withPw({ alerts: { webhookUrl: hookUrl() } }))).status).toBe(200)
    // saving the webhook raises the settings alert itself: let it go out, then start counting
    await alerts.alertsIdle()
    alerts.resetAlerts()
    hookBodies = []
    expect((await put(withPw({ security: { loginMaxAttempts: 9, sessionTtlHours: 77 } }))).status).toBe(200)
    await alerts.alertsIdle()
    expect(hookBodies.length).toBe(1)
    expect(hookBodies[0]).toContain('security.loginMaxAttempts')
    expect(hookBodies[0]).not.toContain('77')
    const log = (await admin.json('GET', '/api/admin/activity?action=settings-update')).data
    const line = JSON.stringify(log.items[0])
    expect(line).toContain('security.sessionTtlHours')
    expect(line).not.toContain('77')
    expect(line).not.toContain(HOOK_SECRET)
  })
})

describe('settings: 2FA required', () => {
  test('a manager without 2FA is held at the setup until it is on; admin level leaves them alone', async () => {
    const mgr = await userWith('sp-mgr', ['read'], 'manager')
    const plain = await userWith('sp-plain', ['read'])
    expect((await put(withPw({ security: { require2fa: 'admin' } }))).status).toBe(200)
    expect((await mgr.json('GET', '/api/me/notify-prefs')).status).toBe(200)
    expect((await mgr.json('GET', '/api/session')).data.mustSetup2fa).toBe(false)

    // staff = admin + manager; the admin has no 2FA either and is held from the first rule on, so this one is set directly
    expect((await admin.json('GET', '/api/admin/users')).data.code).toBe('auth.2fa-required')
    settings.update({ security: { require2fa: 'staff' } })
    const sess = (await mgr.json('GET', '/api/session')).data
    expect(sess.mustSetup2fa).toBe(true)
    expect(sess.user.mustSetup2fa).toBe(true)

    const blocked = await mgr.json('GET', '/api/me/notify-prefs')
    expect([blocked.status, blocked.data.code]).toEqual([403, 'auth.2fa-required'])
    for (const [m, p, b] of [['GET', '/api/admin/users'], ['GET', '/api/sessions'], ['GET', '/api/list?space=home&path=/'], ['DELETE', '/api/me/notifications/x']] as const) {
      const r = await mgr.json(m, p, b)
      expect(`${p} ${r.status} ${r.data.code}`).toBe(`${p} 403 auth.2fa-required`)
    }
    // the admin, who has none either, is held as well
    expect((await admin.json('GET', '/api/admin/users')).data.code).toBe('auth.2fa-required')

    // what is needed to finish: guide, 2FA setup, password change, session, logout
    expect((await mgr.json('GET', '/api/me/guide')).status).toBe(200)
    const setup = await mgr.json('POST', '/api/2fa/setup', { password: PW })
    expect(setup.status).toBe(200)
    expect((await mgr.json('POST', '/api/password', { current: 'wrong-one-123', next: 'another-long-pass-9' })).data.code).toBe('auth.wrong-current-password')
    const enable = await mgr.json('POST', '/api/2fa/enable', { code: totp.totpAt(setup.data.secret, totp.stepOf(Date.now())) })
    expect(enable.status).toBe(200)
    expect((await mgr.json('GET', '/api/me/notify-prefs')).status).toBe(200)
    expect((await mgr.json('GET', '/api/session')).data.mustSetup2fa).toBe(false)

    // an ordinary user is only held by "all"
    expect((await plain.json('GET', '/api/me/notify-prefs')).status).toBe(200)
    clearPolicy()
    settings.update({ security: { require2fa: 'all' } })
    expect((await plain.json('GET', '/api/me/notify-prefs')).data.code).toBe('auth.2fa-required')
    expect((await plain.json('POST', '/api/logout')).status).toBe(200)
    clearPolicy()
    // reachable again once the rule is off
    expect((await admin.json('GET', '/api/admin/users')).status).toBe(200)
  })
})

describe('settings: shares', () => {
  async function file(owner: string, name = 'sp-share.txt') {
    mkdirSync(home(owner), { recursive: true })
    writeFileSync(home(owner, name), 'hello')
    return name
  }

  test('requirePassword: a link without a password is refused on the server', async () => {
    const c = await userWith('sp-share1', ['read', 'download', 'share'])
    const name = await file('sp-share1')
    expect((await put({ share: { requirePassword: true } })).status).toBe(200)
    expect((await c.json('GET', '/api/session')).data.config.shareRequirePassword).toBe(true)
    const no = await c.json('POST', '/api/shares', { space: 'home', path: `/${name}`, days: 7 })
    expect([no.status, no.data.code]).toEqual([400, 'share.must-have-password'])
    const empty = await c.json('POST', '/api/shares', { space: 'home', path: `/${name}`, days: 7, password: '' })
    expect(empty.status).toBe(400)
    const ok = await c.json('POST', '/api/shares', { space: 'home', path: `/${name}`, days: 7, password: 'a-good-pass' })
    expect(ok.status).toBe(200)
    await put({ share: { requirePassword: null } })
    expect((await c.json('POST', '/api/shares', { space: 'home', path: `/${name}`, days: 7 })).status).toBe(200)
  })

  test('maxDays limits the choices; the session tells them with the default', async () => {
    const c = await userWith('sp-share2', ['read', 'download', 'share'])
    const name = await file('sp-share2')
    expect((await c.json('GET', '/api/session')).data.config.shareDays).toEqual([1, 3, 7, 14, 30])
    expect((await put({ share: { maxDays: 7, defaultDays: 3 } })).status).toBe(200)
    const cfg = (await c.json('GET', '/api/session')).data.config
    expect([cfg.shareDays, cfg.shareDefaultDays, cfg.shareAllowNever]).toEqual([[1, 3, 7], 3, false])
    for (const days of [14, 30, 90, 2, 0, -1]) {
      const r = await c.json('POST', '/api/shares', { space: 'home', path: `/${name}`, days })
      expect(`${days} ${r.status} ${r.data.code}`).toBe(`${days} 400 share.bad-days`)
    }
    const ok = await c.json('POST', '/api/shares', { space: 'home', path: `/${name}`, days: 3 })
    expect(ok.status).toBe(200)
    expect(ok.data.share.neverExpires).toBe(false)
    // a longer choice than maxDays can not be the default
    expect((await put({ share: { defaultDays: 14 } })).status).toBe(400)
    // the longer choices come back with a bigger maxDays
    await put({ share: { maxDays: 90 } })
    expect((await c.json('GET', '/api/session')).data.config.shareDays).toEqual([1, 3, 7, 14, 30, 90])
    expect((await c.json('POST', '/api/shares', { space: 'home', path: `/${name}`, days: 90 })).status).toBe(200)
  })

  test('no expiry only when allowNever is on', async () => {
    const c = await userWith('sp-share3', ['read', 'download', 'share'])
    const name = await file('sp-share3')
    expect((await c.json('POST', '/api/shares', { space: 'home', path: `/${name}`, days: 0 })).data.code).toBe('share.bad-days')
    expect((await put({ share: { allowNever: true } })).status).toBe(200)
    expect((await c.json('GET', '/api/session')).data.config.shareAllowNever).toBe(true)
    const r = await c.json('POST', '/api/shares', { space: 'home', path: `/${name}`, days: 0 })
    expect(r.status).toBe(200)
    expect(r.data.share.neverExpires).toBe(true)
    expect(r.data.share.state).toBe('active')
  })
})

describe('settings: secrets', () => {
  test('the SMTP password is sealed on disk, never in GET, logs, activity or alerts, and survives a backup with secret.key', async () => {
    const PASS = 'smtp-s3cret-pass-ZZ9'
    expect((await put(withPw({ alerts: { webhookUrl: hookUrl() } }))).status).toBe(200)
    alerts.resetAlerts()
    const r = await put(withPw({ mail: { host: 'smtp.example.com', port: 587, secure: 'starttls', user: 'mailer', pass: PASS, from: 'files@example.com' }, security: { loginMaxAttempts: 8 } }))
    expect(r.status).toBe(200)
    expect(r.data.mail.passSet).toBe(true)
    expect(r.data.mail.passSource).toBe('web')
    expect(JSON.stringify(r.data)).not.toContain(PASS)
    expect(JSON.stringify(await get())).not.toContain(PASS)
    expect(policy.mail().pass).toBe(PASS)

    await settings.idle()
    const raw = readFileSync(paths.settings, 'utf8')
    expect(raw).not.toContain(PASS)
    expect(JSON.parse(raw).mail.passSealed).toBeTruthy()

    await alerts.alertsIdle()
    for (const body of hookBodies) expect(body).not.toContain(PASS)
    const everything = [readFileSync(paths.audit, 'utf8'), readFileSync(paths.systemLog, 'utf8'), JSON.stringify((await admin.json('GET', '/api/admin/activity?pageSize=100')).data)]
    for (const text of everything) expect(text).not.toContain(PASS)
    expect(JSON.stringify((await admin.json('GET', '/api/admin/logs')).data)).not.toContain(PASS)

    // the value comes back from the file with the same secret.key (the way a restored backup does), not with another one
    secretBox.forgetKey()
    expect(policy.mail().pass).toBe(PASS)
    mkdirSync(config.backupDir, { recursive: true })
    const item = await backup.runBackup()
    const zip = unzipSync(new Uint8Array(readFileSync(join(config.backupDir, item.name))))
    const dec = new TextDecoder()
    expect(Object.keys(zip)).not.toContain('secret.key')
    const inBackup = JSON.parse(dec.decode(zip['settings.json']))
    expect(inBackup.mail.passSealed).toBe(JSON.parse(raw).mail.passSealed)
    expect(dec.decode(zip['settings.json'])).not.toContain(PASS)
    rmSync(join(config.backupDir, item.name), { force: true })

    // on a server whose secret.key differs the value is unreadable: mail stays off with no password, and the admin is told
    const sealed = settings.get().mail!.passSealed!
    settings.update({ mail: { ...settings.get().mail, passSealed: `${sealed.slice(0, -4)}AAAA` } })
    expect(policy.mail().pass).toBe('')
    const w = (await admin.json('GET', '/api/admin/config-warnings')).data.items
    expect(w.map((x: any) => x.code)).toContain('admin.config-secret-unreadable')

    // null takes the password away again
    settings.update({ mail: { ...settings.get().mail, passSealed: sealed } })
    const reset = await put(withPw({ mail: { pass: null } }))
    expect(reset.data.mail.passSet).toBe(!!config.smtpPass)
  })

  test('the webhook URL is masked in GET and the test button uses the saved one', async () => {
    const r = await put(withPw({ alerts: { webhookUrl: hookUrl(), kind: 'json', lang: 'en' } }))
    expect(r.status).toBe(200)
    expect(r.data.alerts.webhookUrl).toEqual({ value: `http://127.0.0.1:${hook.port}…`, source: 'web' })
    expect(JSON.stringify(r.data)).not.toContain(HOOK_SECRET)
    expect(JSON.stringify(await get())).not.toContain(HOOK_SECRET)
    expect((await settings.idle(), readFileSync(paths.settings, 'utf8'))).not.toContain(HOOK_SECRET)
    expect(JSON.stringify((await admin.json('GET', '/api/admin/alerts')).data)).not.toContain(HOOK_SECRET)

    // the save itself raised the settings alert: count from the test button on
    await alerts.alertsIdle()
    hookBodies = []
    const t = await admin.json('POST', '/api/admin/alerts/test')
    expect(t.status).toBe(200)
    expect(hookBodies.length).toBe(1)
    expect(JSON.parse(hookBodies[0]).lang).toBe('en')
    // back to the env value: no webhook in the test setup, so the button says alerts are off
    await put(withPw({ alerts: { webhookUrl: null, lang: null } }))
    expect((await admin.json('POST', '/api/admin/alerts/test')).data.code).toBe('admin.alert-off')
  })

  test('the test mail goes out with the saved settings, to the given address, and not twice in a row', async () => {
    config.publicUrl = 'https://files.test'
    const none = await admin.json('POST', '/api/admin/mail/test', {})
    expect([none.status, none.data.code]).toEqual([409, 'notify.email-off'])
    const port = await startSmtp()
    expect((await put(withPw({ mail: { host: '127.0.0.1', port, secure: 'none', user: 'mailer', pass: 'web-pass-1', from: 'File Center <files@example.com>' } }))).status).toBe(200)
    expect((await admin.json('POST', '/api/admin/mail/test', { to: 'not an address' })).data.code).toBe('notify.bad-address')
    expect((await admin.json('POST', '/api/admin/mail/test', {})).data.code).toBe('admin.mail-test-no-address')
    const ok = await admin.json('POST', '/api/admin/mail/test', { to: 'someone@example.com' })
    expect(ok.status).toBe(200)
    expect(mails.length).toBe(1)
    expect(mails[0].to).toEqual(['someone@example.com'])
    expect(mails[0].auth[0]).toContain('web-pass-1')
    const again = await admin.json('POST', '/api/admin/mail/test', { to: 'someone@example.com' })
    expect([again.status, again.data.code]).toEqual([429, 'admin.mail-test-wait'])
    expect(mails.length).toBe(1)
  })
})

describe('settings: effect without a restart', () => {
  test('session lifetime, trash retention and lock-out follow the saved values at once', async () => {
    expect((await put(withPw({ security: { sessionTtlHours: 2, loginMaxAttempts: 4, loginLockoutSeconds: 120 } }))).status).toBe(200)
    expect([policy.sessionTtlMs(), policy.loginMaxAttempts(), policy.loginLockoutMs()]).toEqual([7200_000, 4, 120_000])
    const c = new Client()
    c.csrf = (await c.json('GET', '/api/session')).data.csrf
    const login = await c.json('POST', '/api/login', { username: 'admin', password: ADMIN_PW })
    expect(login.status).toBe(200)
    expect(login.res.headers.get('set-cookie')).toContain('Max-Age=7200')

    expect((await put({ files: { trashRetentionDays: 11 } })).status).toBe(200)
    expect((await admin.json('GET', '/api/admin/trash')).data.retentionDays).toBe(11)
    expect((await admin.json('GET', '/api/session')).data.config.trashRetentionDays).toBe(11)
  })

  test('WebDAV off answers 404 and on answers again; thumbnails follow too', async () => {
    const dav = () => app.handle(new Request('http://localhost/dav/', { method: 'OPTIONS' })).then((r: Response) => r.status)
    expect(await dav()).not.toBe(404)
    expect((await put({ files: { webdav: false } })).status).toBe(200)
    expect(await dav()).toBe(404)
    expect((await admin.json('GET', '/api/session')).data.config.webdav).toBe(false)
    expect((await put({ files: { webdav: true } })).status).toBe(200)
    expect(await dav()).not.toBe(404)
    await put({ files: { thumbnails: false } })
    expect(policy.thumbnails()).toBe(false)
    await put({ files: { thumbnails: null } })
    expect(policy.thumbnails()).toBe(config.thumbnails)
  })

  test('the default quota is given to a new user that has none set, and an explicit value wins', async () => {
    expect((await put({ files: { defaultQuotaBytes: 5_000_000 } })).status).toBe(200)
    expect((await get()).files.defaultQuotaBytes).toEqual({ value: 5_000_000, source: 'web' })
    const mk = (username: string, extra: any = {}) => admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', permissions: ['read'], publicPermissions: [], ...extra })
    expect((await mk('sp-q1')).status).toBe(200)
    expect((await mk('sp-q2', { quotaBytes: 0 })).status).toBe(200)
    expect((await mk('sp-q3', { quotaBytes: 777 })).status).toBe(200)
    expect(auth.findUser('sp-q1')!.quotaBytes).toBe(5_000_000)
    expect(auth.findUser('sp-q2')!.quotaBytes).toBeUndefined()
    expect(auth.findUser('sp-q3')!.quotaBytes).toBe(777)
    // 0 means no limit
    await put({ files: { defaultQuotaBytes: 0 } })
    expect((await get()).files.defaultQuotaBytes.value).toBeNull()
    expect((await mk('sp-q4')).status).toBe(200)
    expect(auth.findUser('sp-q4')!.quotaBytes).toBeUndefined()
  })
})

describe('config warnings', () => {
  const codes = async (headers: Record<string, string> = {}) => ((await admin.json('GET', '/api/admin/config-warnings', undefined, headers)).data.items as any[]).map(w => w.code)

  test('only admins ask', async () => {
    const u = await userWith('sp-warn', ['read'])
    expect((await u.json('GET', '/api/admin/config-warnings')).status).toBe(403)
    expect((await new Client().json('GET', '/api/admin/config-warnings')).status).toBe(401)
  })

  test('each risky value is reported with a severity', async () => {
    config.updateAllowUnsigned = false
    config.secureCookie = false
    config.trustProxy = 'false'
    config.publicUrl = 'http://files.test'
    const base = await codes()
    expect(base).not.toContain('update.allow-unsigned')
    expect(base).not.toContain('admin.config-insecure-cookie')
    expect(base).not.toContain('admin.config-proxy-no-headers')
    // the test setup keeps ADMIN_PASSWORD in the env while the admin account exists
    expect(base).toContain('admin.config-admin-password-env')

    config.updateAllowUnsigned = true
    const items = (await admin.json('GET', '/api/admin/config-warnings')).data.items
    expect(items.find((w: any) => w.code === 'update.allow-unsigned')).toMatchObject({ severity: 'critical' })
    expect(items.every((w: any) => ['warning', 'critical'].includes(w.severity) && typeof w.message === 'string')).toBe(true)
    config.updateAllowUnsigned = false

    config.publicUrl = 'https://files.test'
    expect(await codes()).toContain('admin.config-insecure-cookie')
    config.secureCookie = true
    expect(await codes()).not.toContain('admin.config-insecure-cookie')
    config.secureCookie = false
    config.publicUrl = ''

    // behind a trusted proxy that says https
    config.trustProxy = 'true'
    expect(await codes({ 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' })).toContain('admin.config-insecure-cookie')
    // a proxy that is trusted but sent no headers
    expect(await codes()).toContain('admin.config-proxy-no-headers')
    expect(await codes({ 'x-forwarded-for': '203.0.113.9' })).not.toContain('admin.config-proxy-no-headers')
    config.trustProxy = 'cloudflare'
    expect(await codes()).toContain('admin.config-proxy-no-headers')
    expect(await codes({ 'cf-connecting-ip': '203.0.113.9' })).not.toContain('admin.config-proxy-no-headers')
    config.trustProxy = 'false'
    // untrusted, the header says nothing
    expect(await codes({ 'x-forwarded-proto': 'https' })).not.toContain('admin.config-insecure-cookie')

    // a second administrator that was handed a password and has not changed it (the first one would be held back itself)
    expect((await admin.json('POST', '/api/admin/users', { username: 'sp-adm2', name: 'x', password: PW, role: 'admin', permissions: [], publicPermissions: [] })).status).toBe(200)
    try {
      expect(await codes()).not.toContain('admin.config-admin-initial-password')
      auth.findUser('sp-adm2')!.mustChangePassword = true
      expect(await codes()).toContain('admin.config-admin-initial-password')
    } finally {
      expect((await admin.json('DELETE', '/api/admin/users/sp-adm2')).status).toBe(200)
    }
    expect(await codes()).not.toContain('admin.config-admin-initial-password')
    config.adminPassword = ''
    try {
      expect(await codes()).not.toContain('admin.config-admin-password-env')
    } finally {
      config.adminPassword = ADMIN_PW
    }
  })

  test('the start-up check sees only what the env alone shows', async () => {
    const { envWarnings } = await import('../src/config-warnings')
    config.updateAllowUnsigned = true
    config.publicUrl = 'https://files.test'
    config.secureCookie = false
    config.trustProxy = 'true'
    const codes = envWarnings().map(w => w.code)
    expect(codes).toContain('update.allow-unsigned')
    expect(codes).toContain('admin.config-insecure-cookie')
    expect(codes).not.toContain('admin.config-proxy-no-headers')
  })
})
