/**
 * Alerts (src/alerts.ts) against a local HTTP server that plays Discord, Slack, Telegram or a JSON webhook (no
 * internet): the body of each kind, the hourly limit, what is cut out of the text, the URLs refused, the test
 * endpoint, the events that send one (backup failed, lockouts, errors per hour, a newer version), and that a slow
 * webhook never holds up a request. Runs in-process on the same app as api.test.ts (see in-process-env.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { base } from './in-process-env'

let app: any
let config: typeof import('../src/config').config
let paths: typeof import('../src/config').paths
let alerts: typeof import('../src/alerts')
let MESSAGES: typeof import('../src/messages').MESSAGES
/** every alert starts with the app name of the settings (other test files of the run may have changed it) */
let prefix = ''

class Client {
  cookie = ''
  csrf = ''
  async json(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers }
    if (this.cookie) h.cookie = this.cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    if (body !== undefined) h['content-type'] = 'application/json'
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }))
    const set = res.headers.get('set-cookie')
    if (set) this.cookie = set.split(';')[0]
    return { status: res.status, data: (await res.json().catch(() => null)) as any }
  }
  async login(username: string, password: string) {
    this.csrf = (await this.json('GET', '/api/session')).data.csrf
    const r = await this.json('POST', '/api/login', { username, password })
    expect(r.status).toBe(200)
    this.csrf = r.data.csrf
  }
}
const admin = new Client()

// ── the webhook: records every POST; `answer` decides the reply
type Got = { path: string; body: any }
const got: Got[] = []
let answer: () => Response | Promise<Response> = () => new Response('ok')
let hook: ReturnType<typeof Bun.serve>
const hookUrl = (p = '/hook') => `http://127.0.0.1:${hook.port}${p}`

// ── the `updates` branch for the daily version check
let latest: Record<string, unknown> | null = null
const sourceAsked: string[] = []
let source: ReturnType<typeof Bun.serve>

const saved = { timing: {} as typeof alerts.ALERT_TIMING, backupDir: '', status: null as string | null }

/** set the webhook and start from a clean slate */
function useHook(kind: string, extra: Partial<typeof config> = {}) {
  Object.assign(config, { alertWebhookUrl: hookUrl(), alertWebhookKind: kind, alertTelegramChatId: '', alertLang: 'th', ...extra })
  alerts.resetAlerts()
  got.length = 0
}

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config, paths } = await import('../src/config'))
  ;({ MESSAGES } = await import('../src/messages'))
  alerts = await import('../src/alerts')
  saved.timing = { ...alerts.ALERT_TIMING }
  saved.backupDir = config.backupDir
  saved.status = existsSync(paths.backupStatus) ? readFileSync(paths.backupStatus, 'utf8') : null
  hook = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch: async req => {
      got.push({ path: new URL(req.url).pathname, body: await req.json().catch(() => null) })
      return answer()
    },
  })
  source = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch: req => {
      sourceAsked.push(new URL(req.url).pathname)
      return latest ? Response.json(latest) : new Response('not found', { status: 404 })
    },
  })
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
  prefix = `[${(await import('../src/settings')).settings.get().appName}] `
})

afterEach(async () => {
  await alerts.alertsIdle()
  Object.assign(alerts.ALERT_TIMING, saved.timing)
  answer = () => new Response('ok')
  config.alertWebhookUrl = ''
  config.alertWebhookKind = 'json'
  config.alertLang = 'th'
  config.alertErrorsPerHour = 20
  config.backupDir = saved.backupDir
})

afterAll(async () => {
  // the version found stays in memory: leave none behind for the other files of the run
  config.updateSource = ''
  await alerts.checkForNewVersion()
  alerts.resetAlerts()
  if (saved.status === null) rmSync(paths.backupStatus, { force: true })
  else writeFileSync(paths.backupStatus, saved.status)
  hook.stop(true)
  source.stop(true)
})

/** until the webhook has `n` messages (alerts go out in the background) */
async function received(n: number) {
  await alerts.alertsIdle()
  const end = Date.now() + 3000
  while (got.length < n && Date.now() < end) await Bun.sleep(20)
  return got
}

const systemLog = () => readFileSync(paths.systemLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))

describe('alerts: configuration', () => {
  test('off without ALERT_WEBHOOK_URL: nothing is sent and the test button says so', async () => {
    config.alertWebhookUrl = ''
    expect((await admin.json('GET', '/api/admin/alerts')).data).toEqual({ enabled: false, kind: 'json', host: null, lastSent: {} })
    expect(alerts.alert('errors', 'admin.alert-errors', { count: 1, max: 1 })).toBe(false)
    const r = await admin.json('POST', '/api/admin/alerts/test')
    expect([r.status, r.data.code]).toEqual([409, 'admin.alert-off'])
    expect(got).toEqual([])
  })

  test('only https, or http to this machine; anything else stays off', async () => {
    for (const bad of ['http://example.com/hook', 'http://10.0.0.1/hook', 'ftp://127.0.0.1/hook', 'file:///etc/passwd', 'not a url']) {
      config.alertWebhookUrl = bad
      expect(`${bad} ${typeof alerts.alertTarget().error}`).toBe(`${bad} string`)
      expect(`${bad} ${(await admin.json('GET', '/api/admin/alerts')).data.enabled}`).toBe(`${bad} false`)
      expect(alerts.alert('errors', 'admin.alert-errors', { count: 1, max: 1 })).toBe(false)
      expect((await admin.json('POST', '/api/admin/alerts/test')).data.code).toBe('admin.alert-off')
    }
    expect(got).toEqual([])
    // a kind that does not exist, and Telegram without a chat
    useHook('teams')
    expect(alerts.alertTarget().error).toContain('ALERT_WEBHOOK_KIND')
    useHook('telegram')
    expect(alerts.alertTarget().error).toContain('ALERT_TELEGRAM_CHAT_ID')
    expect((await admin.json('POST', '/api/admin/alerts/test')).status).toBe(409)
    expect(got).toEqual([])
  })

  test('the page sees the host only, never the secret in the URL', async () => {
    config.alertWebhookUrl = 'https://someone:pw-s3cret@hooks.example.com/services/T000/B000/XXSECRETXX'
    config.alertWebhookKind = 'slack'
    const s = await admin.json('GET', '/api/admin/alerts')
    expect(s.data).toEqual({ enabled: true, kind: 'slack', host: 'hooks.example.com', lastSent: {} })
    expect(JSON.stringify(s.data)).not.toContain('SECRET')
    expect(JSON.stringify(s.data)).not.toContain('s3cret')
  })

  test('a wrong setting is reported at startup without its secret, and the app still starts', () => {
    const dir = mkdtempSync(join(base, 'alerts-start-'))
    const r = Bun.spawnSync([process.execPath, '-e', "const a = await import('./src/alerts'); a.startAlerts(); process.exit(0)"], {
      cwd: resolve(import.meta.dir, '..'),
      env: {
        PATH: process.env.PATH!, HOME: process.env.HOME ?? dir, STORAGE_DIR: join(dir, 's'), DATA_DIR: join(dir, 'd'),
        ADMIN_PASSWORD: 'startup-pass-1', ALERT_WEBHOOK_URL: 'http://example.com/hooks/XXSECRETXX',
      },
    })
    expect(r.exitCode).toBe(0)
    const logged = readFileSync(join(dir, 'd', 'logs', 'system.log'), 'utf8')
    const entry = logged.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(e => e.event === 'alerts-invalid')
    expect(entry?.level).toBe('warn')
    expect(entry.detail).toContain('example.com')
    expect(logged).not.toContain('XXSECRETXX')
  })
})

describe('alerts: what is sent', () => {
  test('each kind gets the body its service expects', async () => {
    const th = `${prefix}${MESSAGES['admin.alert-test'].th}`
    useHook('discord')
    expect((await admin.json('POST', '/api/admin/alerts/test')).data).toEqual({ ok: true })
    useHook('slack')
    expect((await admin.json('POST', '/api/admin/alerts/test')).status).toBe(200)
    // the bot token is part of a Telegram URL
    useHook('telegram', { alertTelegramChatId: '-100123', alertWebhookUrl: hookUrl('/bot123:TOKEN/sendMessage') })
    expect((await admin.json('POST', '/api/admin/alerts/test')).status).toBe(200)
    useHook('json', { alertLang: 'en' })
    expect((await admin.json('POST', '/api/admin/alerts/test')).status).toBe(200)
    expect(got).toEqual([{ path: '/hook', body: { event: 'test', code: 'admin.alert-test', message: `${prefix}${MESSAGES['admin.alert-test'].en}`, params: {}, lang: 'en', version: config.version, time: expect.any(String) } }])
    // the earlier three were cleared by useHook: send them again side by side
    const bodies: Record<string, any> = {}
    for (const [kind, extra] of [['discord', {}], ['slack', {}], ['telegram', { alertTelegramChatId: '-100123', alertWebhookUrl: hookUrl('/bot123:TOKEN/sendMessage') }]] as const) {
      useHook(kind, extra)
      await admin.json('POST', '/api/admin/alerts/test')
      bodies[kind] = got[0]
    }
    expect(bodies.discord).toEqual({ path: '/hook', body: { content: th, allowed_mentions: { parse: [] } } })
    expect(bodies.slack).toEqual({ path: '/hook', body: { text: th } })
    expect(bodies.telegram).toEqual({ path: '/bot123:TOKEN/sendMessage', body: { chat_id: '-100123', text: th, disable_web_page_preview: true } })
    // the test is in the activity log, and the time it went out is on the page
    expect((await admin.json('GET', '/api/admin/activity?action=alert-test')).data.items[0]).toMatchObject({ user: 'admin', action: 'alert-test', detail: 'ok' })
    expect((await admin.json('GET', '/api/admin/alerts')).data.lastSent.test).toEqual(expect.any(String))
  })

  test('a failed test answers why', async () => {
    useHook('json')
    answer = () => new Response('no', { status: 500 })
    let r = await admin.json('POST', '/api/admin/alerts/test', undefined, { 'x-lang': 'en' })
    expect([r.status, r.data.code, r.data.params, r.data.error]).toEqual([502, 'admin.alert-status', { status: 500 }, 'The alert destination answered HTTP 500.'])
    expect((await admin.json('GET', '/api/admin/activity?action=alert-test')).data.items[0].detail).toBe('admin.alert-status')
    // a redirect could lead off https: not followed
    answer = () => Response.redirect('http://example.com/hook', 302)
    r = await admin.json('POST', '/api/admin/alerts/test')
    expect([r.status, r.data.code]).toEqual([502, 'admin.alert-unreachable'])
    config.alertWebhookUrl = 'http://127.0.0.1:1/hook'
    r = await admin.json('POST', '/api/admin/alerts/test')
    expect([r.status, r.data.code]).toEqual([502, 'admin.alert-unreachable'])
    useHook('json')
    alerts.ALERT_TIMING.sendTimeoutMs = 300
    answer = async () => { await Bun.sleep(1500); return new Response('late') }
    r = await admin.json('POST', '/api/admin/alerts/test')
    expect([r.status, r.data.code]).toEqual([504, 'admin.alert-timeout'])
  })

  test('each kind goes out at most once per hour', async () => {
    useHook('json')
    expect(alerts.alert('errors', 'admin.alert-errors', { count: 30, max: 20 })).toBe(true)
    expect(alerts.alert('errors', 'admin.alert-errors', { count: 31, max: 20 })).toBe(false)
    // another kind is not held back
    expect(alerts.alert('lockout', 'admin.alert-login-locked', { user: 'x', ip: '1.2.3.4' })).toBe(true)
    expect((await received(2)).map(g => g.body.event)).toEqual(['errors', 'lockout'])
    expect(got[0].body.params).toEqual({ count: 30, max: 20 })
    // once the hour is over (shortened here) it goes out again
    alerts.ALERT_TIMING.perKindMs = 100
    await Bun.sleep(150)
    expect(alerts.alert('errors', 'admin.alert-errors', { count: 32, max: 20 })).toBe(true)
    expect((await received(3)).length).toBe(3)
    expect((await admin.json('GET', '/api/admin/alerts')).data.lastSent).toEqual({ errors: expect.any(String), lockout: expect.any(String) })
  })

  test('no password, token or cookie leaves; names typed by visitors can not ping a channel', async () => {
    const token = 'A'.repeat(43)
    const user = `x password=hunter2 /s/${token} /api/batch/tok123 fc_sid=abc123 @everyone <!channel>`
    for (const kind of ['json', 'discord', 'slack', 'telegram']) {
      useHook(kind, { alertTelegramChatId: '1' })
      alerts.alert('lockout', 'admin.alert-login-locked', { user, ip: '203.0.113.9', password: 'hunter2', token: 'tok-secret' })
      const [g] = await received(1)
      const raw = JSON.stringify(g.body)
      for (const secret of ['hunter2', token, 'tok123', 'abc123', 'tok-secret']) expect(`${kind} ${raw.includes(secret)}`).toBe(`${kind} false`)
      // the IP is shown, as in the activity log
      expect(raw).toContain('203.0.113.9')
      if (kind === 'discord') expect(g.body.allowed_mentions).toEqual({ parse: [] })
      if (kind === 'slack') expect(g.body.text).toContain('&lt;!channel&gt;')
    }
  })

  test('a slow webhook does not hold up the request that raised the alert', async () => {
    useHook('json')
    alerts.ALERT_TIMING.sendTimeoutMs = 1000
    answer = async () => { await Bun.sleep(2500); return new Response('late') }
    const guest = new Client()
    guest.csrf = (await guest.json('GET', '/api/session')).data.csrf
    // LOGIN_MAX_ATTEMPTS=3 in tests: the third wrong password locks
    for (let i = 0; i < 2; i++) await guest.json('POST', '/api/login', { username: 'slow-hook-user', password: 'wrong' })
    const t0 = performance.now()
    const r = await guest.json('POST', '/api/login', { username: 'slow-hook-user', password: 'wrong' })
    expect(r.status).toBe(401)
    expect(performance.now() - t0).toBeLessThan(800)
    // it gave up after the time limit; only a warning in the log
    await alerts.alertsIdle()
    expect(got.map(g => g.body.code)).toEqual(['admin.alert-login-locked'])
    const failed = systemLog().filter(e => e.event === 'alert-failed').at(-1)
    expect(failed.level).toBe('warn')
    expect(JSON.stringify(failed.detail)).toContain(MESSAGES['admin.alert-timeout'].th.replace('{seconds}', '1'))
  })
})

describe('alerts: events', () => {
  test('a failed backup sends one, with the reason in ALERT_LANG', async () => {
    useHook('json', { alertLang: 'en' })
    const notADir = join(base, 'alerts-backup-target')
    writeFileSync(notADir, 'a file where the backup folder should be')
    config.backupDir = join(notADir, 'backups')
    const r = await admin.json('POST', '/api/admin/backups')
    expect(r.status).toBeGreaterThanOrEqual(400)
    const [g] = await received(1)
    expect(g.body).toMatchObject({ event: 'backup-failed', code: 'backup.failed' })
    expect(g.body.message).toStartWith(`${prefix}The backup failed: `)
  })

  test('an account locked for wrong passwords sends one: sign-in and password confirmation', async () => {
    useHook('json')
    const guest = new Client()
    guest.csrf = (await guest.json('GET', '/api/session')).data.csrf
    for (let i = 0; i < 2; i++) await guest.json('POST', '/api/login', { username: 'locked-out-user', password: 'wrong' })
    expect(got).toEqual([])
    await guest.json('POST', '/api/login', { username: 'locked-out-user', password: 'wrong' })
    const [g] = await received(1)
    expect(g.body).toMatchObject({ event: 'lockout', code: 'admin.alert-login-locked', params: { user: 'locked-out-user', ip: expect.any(String) } })
    // more tries while locked send nothing more
    await guest.json('POST', '/api/login', { username: 'locked-out-user', password: 'wrong' })
    await alerts.alertsIdle()
    expect(got.length).toBe(1)

    // the password step-up of install/restore, on an admin of its own (the counter is per user)
    expect((await admin.json('POST', '/api/admin/users', { username: 'alert-admin', name: 'x', password: 'copper-kettle-77', role: 'admin', permissions: [], publicPermissions: [] })).status).toBe(200)
    const other = new Client()
    await other.login('alert-admin', 'copper-kettle-77')
    useHook('json')
    // the route needs the launcher; a wrong password never gets as far as a restart
    process.env.FC_SUPERVISED = '1'
    try {
      for (let i = 0; i < 3; i++) {
        const r = await other.json('POST', '/api/admin/backups/restore', { name: 'file-center-backup-20000101-000000.zip', password: 'wrong-password' })
        expect(r.status).toBe(403)
      }
    } finally {
      delete process.env.FC_SUPERVISED
    }
    const [c] = await received(1)
    expect(c.body).toMatchObject({ event: 'lockout', code: 'admin.alert-confirm-locked', params: { user: 'alert-admin' } })
    expect(JSON.stringify(c.body)).not.toContain('wrong-password')
  })

  test('a share link locked for wrong passwords sends one', async () => {
    writeFileSync(join(config.storageDir, 'alert-share.txt'), 'x')
    const s = await admin.json('POST', '/api/shares', { space: 'home', path: '/alert-share.txt', days: 1, password: 'share-pass-1' })
    expect(s.status).toBe(200)
    useHook('json')
    const guest = new Client()
    for (let i = 0; i < 5; i++) expect((await guest.json('POST', `/api/s/${s.data.token}/unlock`, { password: 'nope-nope' })).status).toBe(403)
    const [g] = await received(1)
    expect(g.body).toMatchObject({ event: 'lockout', code: 'admin.alert-share-locked', params: { share: s.data.share.id, owner: 'admin' } })
    expect(JSON.stringify(g.body)).not.toContain(s.data.token)
    await admin.json('DELETE', `/api/shares/${s.data.share.id}`)
  })

  test('more errors in an hour than ALERT_ERRORS_PER_HOUR sends one', async () => {
    const { log, errorsSince } = await import('../src/logger')
    useHook('json')
    log.error('alerts-test-error', 'one')
    config.alertErrorsPerHour = errorsSince(Date.now() - 3600_000)
    alerts.checkHealth()
    await alerts.alertsIdle()
    expect(got).toEqual([])
    log.error('alerts-test-error', 'two')
    alerts.checkHealth()
    const [g] = await received(1)
    expect(g.body).toMatchObject({ event: 'errors', code: 'admin.alert-errors', params: { count: config.alertErrorsPerHour + 1, max: config.alertErrorsPerHour } })
  })
})

describe('new version notice', () => {
  const statusWarnings = async () => (await admin.json('GET', '/api/admin/status', undefined, { 'x-lang': 'en' })).data.warnings as any[]
  const publish = (version: string) => {
    latest = { version, file: `file-center-${version}.zip`, sha256: 'a'.repeat(64), size: 100, builtAt: '', notes: '', signed: false }
  }
  afterEach(() => {
    config.updateSource = ''
    latest = null
    sourceAsked.length = 0
  })

  test('the daily check puts a warning on the dashboard and sends one alert per new version', async () => {
    useHook('json')
    config.updateSource = `http://127.0.0.1:${source.port}/updates`
    publish('9.1.0')
    expect((await statusWarnings()).some(w => w.code === 'update.available')).toBe(false)
    await alerts.checkForNewVersion()
    expect(sourceAsked).toEqual(['/updates/latest.json'])
    expect(await statusWarnings()).toContainEqual({ level: 'info', code: 'update.available', message: 'Version 9.1.0 is available on the update page.', params: { version: '9.1.0' } })
    const [g] = await received(1)
    expect(g.body).toMatchObject({ event: 'update-available', code: 'update.available', params: { version: '9.1.0' } })
    // the same version again: no second alert, even after the hour
    alerts.ALERT_TIMING.perKindMs = 0
    await alerts.checkForNewVersion()
    await alerts.alertsIdle()
    expect(got.length).toBe(1)
    publish('9.2.0')
    await alerts.checkForNewVersion()
    expect((await received(2))[1].body.params).toEqual({ version: '9.2.0' })
    // nothing newer any more: the warning goes
    publish(config.version)
    await alerts.checkForNewVersion()
    expect((await statusWarnings()).some(w => w.code === 'update.available')).toBe(false)
    // only admins see it
    publish('9.3.0')
    await alerts.checkForNewVersion()
    const guest = new Client()
    expect((await guest.json('GET', '/api/admin/status')).status).toBe(401)
  })

  test('a source that is down only leaves a warning in the log; the version found before stays', async () => {
    config.updateSource = `http://127.0.0.1:${source.port}/updates`
    publish('9.5.0')
    await alerts.checkForNewVersion()
    latest = null
    await alerts.checkForNewVersion()
    expect(systemLog().filter(e => e.event === 'update-check-failed').at(-1).level).toBe('warn')
    expect((await statusWarnings()).find(w => w.code === 'update.available')?.params).toEqual({ version: '9.5.0' })
    // with UPDATE_SOURCE off, so is the warning
    config.updateSource = ''
    expect((await statusWarnings()).some(w => w.code === 'update.available')).toBe(false)
  })

  test('with UPDATE_SOURCE off nothing is asked', async () => {
    await alerts.checkForNewVersion()
    expect(sourceAsked).toEqual([])
  })

  test('startAlerts looks soon after start, then keeps looking', async () => {
    config.updateSource = `http://127.0.0.1:${source.port}/updates`
    publish('9.4.0')
    Object.assign(alerts.ALERT_TIMING, { firstVersionCheckMs: 50, versionCheckEveryMs: 100 })
    const stop = alerts.startAlerts()
    try {
      const end = Date.now() + 3000
      while (sourceAsked.length < 2 && Date.now() < end) await Bun.sleep(20)
      expect(sourceAsked.length).toBeGreaterThanOrEqual(2)
      expect((await statusWarnings()).find(w => w.code === 'update.available')?.params).toEqual({ version: '9.4.0' })
    } finally {
      stop()
    }
  })
})
