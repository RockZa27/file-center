/**
 * Safer defaults for new installs: REQUIRE_2FA (default of security.require2fa, the web setting wins), PUBLIC_PAGE (only the
 * first value of publicEnabled) and the warning shown while admins need no 2FA. Env parsing and fresh installs run in a
 * subprocess with their own DATA_DIR (config and settings load once per process). Users here start with "sd-".
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './in-process-env'

let app: any
let config: typeof import('../src/config').config
let settings: typeof import('../src/settings').settings
let policy: typeof import('../src/policy')
let configWarnings: typeof import('../src/config-warnings').configWarnings

class Client {
  cookie = ''
  csrf = ''
  async json(method: string, path: string, body?: any) {
    const h: Record<string, string> = {}
    if (this.cookie) h.cookie = this.cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    let payload: any = body
    if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json' }
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: payload }))
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

const PW = 'harbor-lamp-42'
const boss = new Client()
let savedEnv: string | undefined
let savedCfg: 'none' | 'admin' | 'staff' | 'all'
let savedSec: any

const setEnv2fa = (v: 'none' | 'admin' | 'staff' | 'all' | undefined) => {
  if (v === undefined) delete process.env.REQUIRE_2FA; else process.env.REQUIRE_2FA = v
  config.require2fa = v ?? 'none'
}

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config } = await import('../src/config'))
  ;({ settings } = await import('../src/settings'))
  policy = await import('../src/policy')
  ;({ configWarnings } = await import('../src/config-warnings'))
  savedEnv = process.env.REQUIRE_2FA
  savedCfg = config.require2fa
  savedSec = settings.get().security
  await boss.login('admin', process.env.ADMIN_PASSWORD!)
  const r = await boss.json('POST', '/api/admin/users', { username: 'sd-admin', name: 'sd', password: PW, role: 'admin', permissions: ['read'], publicPermissions: [] })
  expect(r.status).toBe(200)
})

afterEach(() => {
  settings.update({ security: savedSec })
  setEnv2fa(undefined)
})

afterAll(() => {
  if (savedEnv === undefined) delete process.env.REQUIRE_2FA; else process.env.REQUIRE_2FA = savedEnv
  config.require2fa = savedCfg
  settings.update({ security: savedSec })
})

describe('REQUIRE_2FA', () => {
  test('the env value holds an admin without 2FA at the setup, the web setting overrides it', async () => {
    setEnv2fa('staff')
    const a = await new Client().login('sd-admin', PW)
    const blocked = await a.json('GET', '/api/me/notify-prefs')
    expect([blocked.status, blocked.data.code]).toEqual([403, 'auth.2fa-required'])
    expect((await a.json('GET', '/api/session')).data.mustSetup2fa).toBe(true)
    expect((await a.json('POST', '/api/2fa/setup', { password: PW })).status).toBe(200)

    // (the bootstrap admin has no 2FA either and is held now, so the view is read from the policy itself)
    expect(policy.policyView().security.require2fa).toEqual({ value: 'staff', source: 'env' })

    settings.update({ security: { ...settings.get().security, require2fa: 'none' } })
    expect((await a.json('GET', '/api/me/notify-prefs')).status).toBe(200)
    expect(policy.policyView().security.require2fa).toEqual({ value: 'none', source: 'web' })
    expect((await boss.json('GET', '/api/admin/settings')).data.security.require2fa).toEqual({ value: 'none', source: 'web' })
  })

  test('without env or web setting nothing is required, source default', async () => {
    expect(policy.require2fa()).toBe('none')
    expect((await boss.json('GET', '/api/admin/settings')).data.security.require2fa).toEqual({ value: 'none', source: 'default' })
  })

  test('an invalid value is none and the start logs one Thai warning', async () => {
    const r = await probe({ REQUIRE_2FA: 'everyone' })
    expect(r.require2fa).toBe('none')
    expect(r.log.filter((l: string) => l.includes('require-2fa-invalid')).length).toBe(1)
    expect(r.log.join('\n')).toContain('REQUIRE_2FA everyone ไม่ถูกต้อง')
    expect((await probe({ REQUIRE_2FA: 'admin' })).require2fa).toBe('admin')
    expect((await probe({})).log.filter((l: string) => l.includes('require-2fa-invalid')).length).toBe(0)
  })
})

describe('config warning: admins need no 2FA', () => {
  // the route is for signed-in admins, who are held by the requirement itself: the function behind it is read directly
  const items = async () => configWarnings(new Request('http://localhost/'))
  test('fires while the requirement is none and not once it covers admins', async () => {
    expect((await boss.json('GET', '/api/admin/config-warnings')).data.items.map((i: any) => i.code)).toContain('admin.config-no-2fa')
    const first = (await items()).find((i: any) => i.code === 'admin.config-no-2fa')
    expect(first.severity).toBe('warning')
    for (const v of ['admin', 'staff', 'all'] as const) {
      setEnv2fa(v)
      expect((await items()).map((i: any) => i.code)).not.toContain('admin.config-no-2fa')
    }
    // the web setting wins over the env in the warning too
    setEnv2fa('staff')
    settings.update({ security: { ...settings.get().security, require2fa: 'none' } })
    expect((await items()).map((i: any) => i.code)).toContain('admin.config-no-2fa')
  })
})

describe('PUBLIC_PAGE', () => {
  test('a fresh install follows the env, an existing settings.json keeps its stored value', async () => {
    const off = await probe({ PUBLIC_PAGE: 'off' })
    expect([off.publicEnabled, off.visitorList]).toEqual([false, 401])
    const unset = await probe({})
    expect([unset.publicEnabled, unset.visitorList]).toEqual([true, 200])
    const bad = await probe({ PUBLIC_PAGE: 'maybe' })
    expect([bad.publicEnabled, bad.visitorList]).toEqual([true, 200])
    expect(bad.log.filter((l: string) => l.includes('public-page-invalid')).length).toBe(1)

    // existing installs: the stored value wins either way
    const keepOpen = await probe({ PUBLIC_PAGE: 'off' }, { publicEnabled: true })
    expect([keepOpen.publicEnabled, keepOpen.visitorList]).toEqual([true, 200])
    const keepClosed = await probe({}, { publicEnabled: false })
    expect([keepClosed.publicEnabled, keepClosed.visitorList]).toEqual([false, 401])
    // a settings.json from before the key existed only gets the default for the MISSING key
    const missing = await probe({ PUBLIC_PAGE: 'off' }, { appName: 'Old' })
    expect(missing.publicEnabled).toBe(false)
  })
})

/** start the app in a fresh process (own DATA_DIR, optional stored settings.json) and report what it did */
async function probe(env: Record<string, string>, stored?: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'fc-sd-'))
  try {
    if (stored) {
      mkdirSync(join(dir, 'data'), { recursive: true })
      writeFileSync(join(dir, 'data', 'settings.json'), JSON.stringify(stored))
    }
    const repo = join(import.meta.dir, '..')
    const script = join(dir, 'probe.ts')
    writeFileSync(script, `
      const lines: string[] = []
      const o = process.stdout.write.bind(process.stdout)
      const grab = (c: any) => { lines.push(String(c)); return true }
      process.stderr.write = grab as any; process.stdout.write = grab as any
      console.warn = console.log = console.error = (...a: any[]) => { lines.push(a.join(' ')) }
      const { app } = await import(${JSON.stringify(join(repo, 'src/index'))})
      const { config } = await import(${JSON.stringify(join(repo, 'src/config'))})
      const { settings } = await import(${JSON.stringify(join(repo, 'src/settings'))})
      const r = await app.handle(new Request('http://localhost/api/list?space=public'))
      o(JSON.stringify({ require2fa: config.require2fa, publicEnabled: settings.get().publicEnabled, visitorList: r.status, log: lines.join('\\n').split('\\n').filter(Boolean) }) + '\\n')
      process.exit(0)
    `)
    const proc = Bun.spawn([process.execPath, script], {
      cwd: repo,
      env: { ...process.env, DATA_DIR: join(dir, 'data'), STORAGE_DIR: join(dir, 'storage'), ADMIN_PASSWORD: 'probe-admin-pass-1', REQUIRE_2FA: '', PUBLIC_PAGE: '', ...env },
      stdout: 'pipe', stderr: 'pipe',
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    const line = out.split('\n').reverse().find(l => l.startsWith('{"require2fa"'))
    if (!line) throw new Error('probe gave no result: ' + out + await new Response(proc.stderr).text())
    return JSON.parse(line)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
