/**
 * A failed sign-in must not record what was typed in the name box when no account has that name (people paste their
 * password there): the audit log, the forwarded copy, the lockout alerts and the admins' bell get the canonical name of
 * an existing account, or a label ?xxxxxxxx (keyed hash, never a real user name). Web login and WebDAV. In-process.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import './in-process-env'

let app: any
let auth: typeof import('../src/auth')
let alerts: typeof import('../src/alerts')
let fwd: typeof import('../src/audit-forward')
let config: typeof import('../src/config').config
let paths: typeof import('../src/config').paths
let notify: typeof import('../src/notify')
let audit: typeof import('../src/audit')

// letters and symbols that no hex digit, timestamp or id holds
const TYPED = 'Zq!Hunter2~Pw-Secret#'
const TYPED2 = 'Qz!Other~Pw-Phrase#'
const TYPED3 = 'Wx!Broken~Key-Pass#'
// an account of this file only: a failed sign-in is written once a minute per name, so a shared name ('admin') could
// already have been written by another file in the same minute
const CASE_USER = 'lnp-case-user'
const IP = 'unknown'

const got: { path: string; raw: string }[] = []
let hook: ReturnType<typeof Bun.serve>
const hookUrl = (p: string) => `http://127.0.0.1:${hook.port}${p}`
const wait = async (cond: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await Bun.sleep(10) }

let cookie = ''
let csrf = ''
async function json(method: string, path: string, body?: any) {
  const h: Record<string, string> = {}
  if (cookie) h.cookie = cookie
  if (csrf) h['x-csrf-token'] = csrf
  if (body !== undefined) h['content-type'] = 'application/json'
  const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }))
  const set = res.headers.get('set-cookie')
  if (set?.startsWith('fc_sid=')) cookie = set.split(';')[0]
  return { status: res.status, data: (await res.json().catch(() => null)) as any }
}
const fail = (username: string) => json('POST', '/api/login', { username, password: 'definitely-wrong-pass' })
const dav = (username: string) => app.handle(new Request('http://localhost/dav/', {
  method: 'PROPFIND', headers: { authorization: `Basic ${Buffer.from(`${username}:wrong-secret`).toString('base64')}`, depth: '0' },
}))
const auditText = () => readFileSync(paths.audit, 'utf8')
const newestFailure = () => audit.auditEntries().find(e => e.action === 'login-failed')
const bellIds = () => notify.listNotifications('admin').items.map((n: any) => n.id)

function clearCounters() {
  for (const n of [TYPED, TYPED2, TYPED3, CASE_USER]) {
    for (const k of [`${IP}|${n.toLowerCase()}`, `login-account|${n.toLowerCase()}`, `dav|${IP}|${n.toLowerCase()}`]) auth.clearFailures(k)
  }
  auth.clearFailures(`login-address|${IP}`)
  auth.clearFailures(`dav-address|${IP}`)
}

const saved = { url: '', kind: '', lang: 'th' as 'th' | 'en' }

// the admin's own requests, apart from the visitor's cookie above
const adm = { cookie: '', csrf: '' }
async function asAdmin(method: string, path: string, body?: any) {
  const h: Record<string, string> = {}
  if (adm.cookie) h.cookie = adm.cookie
  if (adm.csrf) h['x-csrf-token'] = adm.csrf
  if (body !== undefined) h['content-type'] = 'application/json'
  const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }))
  const set = res.headers.get('set-cookie')
  if (set?.startsWith('fc_sid=')) adm.cookie = set.split(';')[0]
  return { status: res.status, data: (await res.json().catch(() => null)) as any }
}
beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config, paths } = await import('../src/config'))
  auth = await import('../src/auth')
  alerts = await import('../src/alerts')
  fwd = await import('../src/audit-forward')
  notify = await import('../src/notify')
  audit = await import('../src/audit')
  saved.url = config.alertWebhookUrl
  saved.kind = config.alertWebhookKind
  saved.lang = config.alertLang
  hook = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async req => { got.push({ path: new URL(req.url).pathname, raw: await req.text() }); return new Response('ok') } })
  csrf = (await json('GET', '/api/session')).data.csrf
  adm.csrf = (await asAdmin('GET', '/api/session')).data.csrf
  const login = await asAdmin('POST', '/api/login', { username: 'admin', password: process.env.ADMIN_PASSWORD })
  expect(login.status).toBe(200)
  adm.csrf = login.data.csrf
  const made = await asAdmin('POST', '/api/admin/users', { username: CASE_USER, name: CASE_USER, password: 'harbor-lamp-42', role: 'user', permissions: ['read'], publicPermissions: [] })
  expect(made.status).toBe(200)
  clearCounters()
})
afterAll(async () => {
  await asAdmin('DELETE', `/api/admin/users/${CASE_USER}`)
  rmSync(join(process.env.STORAGE_DIR!, 'users', CASE_USER), { recursive: true, force: true })
  await asAdmin('POST', '/api/logout')
  clearCounters()
  config.alertWebhookUrl = saved.url
  config.alertWebhookKind = saved.kind
  config.alertLang = saved.lang
  alerts.resetAlerts()
  hook.stop(true)
})

describe('failed sign-in: what is recorded for the typed name', () => {
  test('web: an unknown name that looks like a password is not in the audit log; the user is a label', async () => {
    expect((await fail(TYPED)).status).toBe(401)
    expect(auditText()).not.toContain(TYPED)
    expect(auditText()).not.toContain(TYPED.toLowerCase())
    const e = newestFailure()!
    expect(e.user).toMatch(/^\?[0-9a-f]{8}$/)
    expect(e.user).toBe(auth.recordedName(TYPED))
    // the user filter of the activity page works with the raw label
    expect(audit.queryAudit({ page: 1, pageSize: 10, user: e.user }).items.some(i => i.action === 'login-failed')).toBe(true)
    clearCounters()
  })

  test('the label is a keyed hash: same name (any case, spaces) same label, another name another label, never a user name', () => {
    const a = auth.recordedName(TYPED)
    expect(auth.recordedName(`  ${TYPED.toUpperCase()} `)).toBe(a)
    expect(auth.recordedName(TYPED2)).not.toBe(a)
    expect(auth.USERNAME_RE.test(a)).toBe(false)
    expect(auth.UNKNOWN_NAME_RE.test(a)).toBe(true)
    expect(auth.recordedName('')).toBe('-')
    expect(auth.recordedName('   ')).toBe('-')
    // not a plain hash of the name: the key of the server is in it
    const plain = new Bun.CryptoHasher('sha256').update(TYPED.toLowerCase()).digest('hex').slice(0, 8)
    expect(a).not.toBe('?' + plain)
  })

  test('an existing account typed in another case is recorded with its canonical name', async () => {
    expect(auth.recordedName('ADMIN')).toBe('admin')
    expect(auth.recordedName(CASE_USER.toUpperCase())).toBe(CASE_USER)
    expect((await fail(CASE_USER.toUpperCase())).status).toBe(401)
    expect(newestFailure()!.user).toBe(CASE_USER)
    clearCounters()
  })

  test('a lockout with an unknown name: the alert and the admins\' bell do not hold the typed text', async () => {
    alerts.resetAlerts()
    Object.assign(config, { alertWebhookUrl: hookUrl('/alert'), alertWebhookKind: 'json', alertLang: 'en' })
    got.length = 0
    const before = new Set(bellIds())
    let locked = false
    for (let i = 0; i < 20 && !locked; i++) locked = (await fail(TYPED)).status === 429
    expect(locked).toBe(true)
    await alerts.alertsIdle()
    await wait(() => got.some(g => g.path === '/alert'))
    const sent = got.filter(g => g.path === '/alert')
    expect(sent.length).toBeGreaterThan(0)
    // the label is told as what it is in the alert language (en here), not as a bare ?xxxxxxxx
    expect(sent[0].raw).toContain(`a name that is no account (#${auth.recordedName(TYPED).slice(1)})`)
    for (const g of sent) expect(g.raw).not.toContain(TYPED)
    for (const g of sent) expect(g.raw).not.toContain(TYPED.toLowerCase())
    const fresh = notify.listNotifications('admin').items.filter((n: any) => !before.has(n.id))
    expect(fresh.length).toBeGreaterThan(0)
    expect(JSON.stringify(fresh)).not.toContain(TYPED)
    expect(JSON.stringify(fresh)).not.toContain(TYPED.toLowerCase())
    // the bell keeps the label and tells it as what it is in the reader's language
    expect(JSON.stringify(fresh)).toContain(auth.recordedName(TYPED))
    expect(notify.describe('en', 'system-alert', (fresh[0] as any).params)).toContain(`a name that is no account (#${auth.recordedName(TYPED).slice(1)})`)
    expect(notify.describe('th', 'system-alert', (fresh[0] as any).params)).toContain(`ชื่อที่ไม่มีในระบบ (#${auth.recordedName(TYPED).slice(1)})`)
    for (const n of fresh) notify.removeNotification('admin', (n as any).id)
    expect(auditText()).not.toContain(TYPED)
    expect(auditText()).not.toContain(TYPED.toLowerCase())
    config.alertWebhookUrl = saved.url
    config.alertWebhookKind = saved.kind
    alerts.resetAlerts()
    clearCounters()
  })

  test('the forwarded audit copy does not hold the typed text', async () => {
    csrf = (await json('GET', '/api/session')).data.csrf
    const r = await json('POST', '/api/login', { username: 'admin', password: process.env.ADMIN_PASSWORD })
    expect(r.status).toBe(200)
    csrf = r.data.csrf
    const set = (auditForward: Record<string, unknown>) => json('PUT', '/api/admin/settings', { auditForward, password: process.env.ADMIN_PASSWORD })
    try {
      expect((await set({ webhookUrl: hookUrl('/fwd') })).status).toBe(200)
      await fwd.forwardIdle(); await Bun.sleep(50)
      got.length = 0
      // a new session: the failure comes from a visitor
      const keep = { cookie, csrf }
      cookie = ''; csrf = (await json('GET', '/api/session')).data.csrf
      expect((await fail(TYPED2)).status).toBe(401)
      cookie = keep.cookie; csrf = keep.csrf
      await fwd.forwardIdle()
      await wait(() => got.some(g => g.path === '/fwd' && g.raw.includes('login-failed')))
      const line = got.find(g => g.path === '/fwd' && g.raw.includes('login-failed'))
      expect(line).toBeDefined()
      expect(line!.raw).toContain(auth.recordedName(TYPED2))
      for (const g of got) expect(g.raw).not.toContain(TYPED2)
      for (const g of got) expect(g.raw).not.toContain(TYPED2.toLowerCase())
    } finally {
      await set({ webhookUrl: null, webhookSecret: null })
      await fwd.forwardIdle()
      fwd.resetForwarding()
      await json('POST', '/api/logout', {})
      cookie = ''; csrf = (await json('GET', '/api/session')).data.csrf
      clearCounters()
    }
  })

  test('WebDAV Basic auth with an unknown name: audit log and alert hold the label, not the typed text', async () => {
    alerts.resetAlerts()
    Object.assign(config, { alertWebhookUrl: hookUrl('/alert'), alertWebhookKind: 'json' })
    got.length = 0
    const before = new Set(bellIds())
    let locked = false
    for (let i = 0; i < 20 && !locked; i++) locked = (await dav(TYPED)).status === 429
    expect(locked).toBe(true)
    await alerts.alertsIdle()
    await wait(() => got.some(g => g.path === '/alert'))
    expect(auditText()).not.toContain(TYPED)
    expect(auditText()).not.toContain(TYPED.toLowerCase())
    const e = newestFailure()!
    expect(e.user).toBe(auth.recordedName(TYPED))
    expect(e.detail).toBe('WebDAV')
    const sent = got.filter(g => g.path === '/alert')
    expect(sent.length).toBeGreaterThan(0)
    for (const g of sent) expect(g.raw).not.toContain(TYPED)
    for (const g of sent) expect(g.raw).not.toContain(TYPED.toLowerCase())
    const fresh = notify.listNotifications('admin').items.filter((n: any) => !before.has(n.id))
    expect(JSON.stringify(fresh)).not.toContain(TYPED)
    expect(JSON.stringify(fresh)).not.toContain(TYPED.toLowerCase())
    for (const n of fresh) notify.removeNotification('admin', (n as any).id)
    config.alertWebhookUrl = saved.url
    config.alertWebhookKind = saved.kind
    alerts.resetAlerts()
    clearCounters()
  })

  test('WebDAV: an existing account typed in another case is recorded with its canonical name', async () => {
    expect((await dav(CASE_USER.toUpperCase())).status).toBe(401)
    expect(newestFailure()!.user).toBe(CASE_USER)
    clearCounters()
  })

  test('a secret.key that can not be read: the failure is still a 401, counted, and recorded as a label', async () => {
    const box = await import('../src/secret-box')
    box.subKey('make-sure-the-key-exists')
    const original = readFileSync(paths.secretKey, 'utf8')
    const before = new Set(bellIds())
    try {
      writeFileSync(paths.secretKey, 'damaged')
      box.forgetKey()
      expect(() => box.subKey('login-name-label')).toThrow()
      expect((await fail(TYPED3)).status).toBe(401)
      const e = newestFailure()!
      expect(e.user).toMatch(/^\?[0-9a-f]{8}$/)
      expect(auditText()).not.toContain(TYPED3)
      expect(auditText()).not.toContain(TYPED3.toLowerCase())
      // counted toward the lockout like any failure: the tries end in 429
      let locked = false
      for (let i = 0; i < 20 && !locked; i++) locked = (await fail(TYPED3)).status === 429
      expect(locked).toBe(true)
    } finally {
      writeFileSync(paths.secretKey, original, { mode: 0o600 })
      box.forgetKey()
      // the lockout told the admins: their bell is left as it was
      for (const n of notify.listNotifications('admin').items.filter((n: any) => !before.has(n.id))) notify.removeNotification('admin', (n as any).id)
      alerts.resetAlerts()
      clearCounters()
    }
  })
})
