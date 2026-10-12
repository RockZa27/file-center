/**
 * Server messages in Thai and English: every error and dashboard warning has a stable code from src/messages.ts,
 * and its text follows the language of the request (x-lang, else Accept-Language, else Thai).
 * Runs in-process on the same app as api.test.ts (see in-process-env.ts).
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { zipSync } from 'fflate'
import './in-process-env'
import { langOf, MESSAGES, text, type MessageCode } from '../src/messages'

const SRC = resolve(import.meta.dir, '..', 'src')
const AREAS = ['auth', 'files', 'upload', 'zip', 'admin', 'update', 'backup', 'logs', 'fs', 'request']
// codes the web page checked before there was a catalog; they stay as they are
const LEGACY = ['csrf', 'must-change-password', 'disk-full', 'not-supervised', 'errors']

let app: any
let config: typeof import('../src/config').config
let logger: typeof import('../src/logger')

class Client {
  cookie = ''
  csrf = ''
  async json(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
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
    return { status: res.status, data: (await res.json().catch(() => null)) as any }
  }
  async start() {
    this.csrf = (await this.json('GET', '/api/session')).data.csrf
  }
  async login(username: string, password: string, headers: Record<string, string> = {}) {
    const r = await this.json('POST', '/api/login', { username, password }, headers)
    if (r.status === 200) this.csrf = r.data.csrf
    return r
  }
}

const EN = { 'x-lang': 'en' }
const admin = new Client()

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ config } = await import('../src/config'))
  logger = await import('../src/logger')
  await admin.start()
  expect((await admin.login('admin', process.env.ADMIN_PASSWORD!)).status).toBe(200)
})

/** every .ts file under src/ except the catalog itself, as [relative name, source] */
function sources(): [string, string][] {
  const out: [string, string][] = []
  const visit = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const abs = join(dir, n)
      if (statSync(abs).isDirectory()) visit(abs)
      else if (n.endsWith('.ts') && abs !== join(SRC, 'messages.ts')) out.push([abs.slice(SRC.length + 1), readFileSync(abs, 'utf8')])
    }
  }
  visit(SRC)
  return out
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()

describe('message catalog', () => {
  test('every entry has Thai and English with the same placeholders', () => {
    const entries = Object.entries(MESSAGES) as [string, { th: string; en: string }][]
    expect(entries.length).toBeGreaterThan(100)
    for (const [code, m] of entries) {
      expect(`${code}: ${typeof m.th} ${typeof m.en}`).toBe(`${code}: string string`)
      expect(m.th.trim().length && m.en.trim().length ? code : `${code} is empty`).toBe(code)
      // Thai text in the Thai entry, none in the English one
      expect(`${code} ${/[฀-๿]/.test(m.th)}`).toBe(`${code} true`)
      expect(`${code} ${/[฀-๿]/.test(m.en)}`).toBe(`${code} false`)
      expect(`${code} ${placeholders(m.en).join(',')}`).toBe(`${code} ${placeholders(m.th).join(',')}`)
    }
  })

  test('codes are dotted by area, apart from the ones the web page already relies on', () => {
    for (const code of Object.keys(MESSAGES)) {
      const ok = LEGACY.includes(code) || new RegExp(`^(${AREAS.join('|')})\\.[a-z][a-z0-9-]*$`).test(code)
      expect(ok ? code : `${code} is not <area>.<name>`).toBe(code)
    }
    for (const code of LEGACY) expect(MESSAGES).toHaveProperty([code])
  })

  test('every code used in src/ is in the catalog, and every entry is used', () => {
    const shaped = new RegExp(`'((?:${AREAS.join('|')})\\.[a-z][a-z0-9.-]*|${LEGACY.join('|')})'`, 'g')
    const used = new Set<string>()
    for (const [file, src] of sources()) {
      for (const m of src.matchAll(shaped)) {
        // file names such as 'update.zip' look like codes but are not
        if (/\.(zip|json|js|ts|log|sig|html)$/.test(m[1])) continue
        used.add(m[1])
        expect(`${file}: ${m[1]} ${m[1] in MESSAGES}`).toBe(`${file}: ${m[1]} true`)
      }
    }
    for (const code of Object.keys(MESSAGES)) expect(`${code} used ${used.has(code)}`).toBe(`${code} used true`)
  })

  test('every error thrown in src/ names a code, not a sentence', () => {
    let calls = 0
    for (const [file, src] of sources()) {
      const lines = src.split('\n')
      lines.forEach((line, i) => {
        // bad('x'), notFound(), forbidden(code) ... and new HttpError(400, 'x'): never a Thai sentence or a template
        for (const m of line.matchAll(/\b(?:bad|notFound|conflict|forbidden)\(([^)]*)|new HttpError\(\s*\d+\s*,\s*([^,)]*)/g)) {
          const arg = (m[1] ?? m[2]).trim()
          calls++
          const ok = arg === '' || /^'[a-z][a-z0-9.-]*'/.test(arg) || /^[\w.!]+$/.test(arg.split(',')[0])
          expect(ok && !/[฀-๿`]/.test(arg) ? 'ok' : `${file}:${i + 1} ${line.trim()}`).toBe('ok')
        }
      })
    }
    expect(calls).toBeGreaterThan(130)
  })

  test('text fills the placeholders once and keeps unknown ones', () => {
    expect(text('en', 'auth.locked', { seconds: 30 })).toBe('Too many failed sign-ins. Wait 30 seconds and try again.')
    expect(text('th', 'auth.locked', { seconds: 30 })).toBe('พยายามเข้าสู่ระบบผิดหลายครั้ง กรุณารอ 30 วินาทีแล้วลองใหม่')
    // a file name that looks like a placeholder is shown as it is
    expect(text('en', 'files.item-missing', { name: '{name}' })).toBe('{name} was not found.')
    expect(text('en', 'files.item-missing')).toBe('{name} was not found.')
  })
})

describe('language of a request', () => {
  const req = (headers: Record<string, string>) => new Request('http://localhost/', { headers })
  test('x-lang first, then Accept-Language, then Thai', () => {
    expect(langOf(req({}))).toBe('th')
    expect(langOf(req({ 'x-lang': 'en' }))).toBe('en')
    expect(langOf(req({ 'x-lang': 'EN' }))).toBe('en')
    expect(langOf(req({ 'x-lang': 'th', 'accept-language': 'en-US,en;q=0.9' }))).toBe('th')
    expect(langOf(req({ 'x-lang': 'de', 'accept-language': 'en-US' }))).toBe('en')
    expect(langOf(req({ 'accept-language': 'en-US,en;q=0.9,th;q=0.8' }))).toBe('en')
    expect(langOf(req({ 'accept-language': 'th-TH,th;q=0.9,en;q=0.8' }))).toBe('th')
    expect(langOf(req({ 'accept-language': 'en;q=0.3, th;q=0.7' }))).toBe('th')
    expect(langOf(req({ 'accept-language': 'fr-FR,fr;q=0.9,en;q=0.5' }))).toBe('en')
    expect(langOf(req({ 'accept-language': 'fr-FR,de;q=0.9' }))).toBe('th')
    expect(langOf(req({ 'accept-language': 'en;q=0' }))).toBe('th')
  })
})

describe('errors follow the language of the request', () => {
  test('locked login', async () => {
    const c = new Client()
    await c.start()
    for (let i = 0; i < 3; i++) {
      const r = await c.login('lang-locked', 'nope', EN)
      expect(r.status).toBe(401)
      expect(r.data).toEqual({ error: 'Wrong username or password.', code: 'auth.bad-credentials', params: {} })
    }
    const en = await c.login('lang-locked', 'nope', EN)
    expect(en.status).toBe(429)
    expect(en.data.code).toBe('auth.locked')
    const seconds = en.data.params.seconds
    expect(seconds).toBeGreaterThan(0)
    expect(en.data.error).toBe(`Too many failed sign-ins. Wait ${seconds} seconds and try again.`)
    // Thai stays the default
    const th = await c.login('lang-locked', 'nope')
    expect(th.status).toBe(429)
    expect(th.data.code).toBe('auth.locked')
    expect(th.data.error).toBe(`พยายามเข้าสู่ระบบผิดหลายครั้ง กรุณารอ ${th.data.params.seconds} วินาทีแล้วลองใหม่`)
  })

  test('bad file name', async () => {
    const body = { space: 'home', path: '/', name: 'a:b' }
    const en = await admin.json('POST', '/api/mkdir', body, EN)
    expect(en.status).toBe(400)
    expect(en.data).toEqual({ error: 'A name may not contain \\ / : * ? " < > |', code: 'fs.name-bad-chars', params: {} })
    // the browser's language counts when the page does not say
    const browser = await admin.json('POST', '/api/mkdir', body, { 'accept-language': 'en-US,en;q=0.9' })
    expect(browser.data.error).toBe(en.data.error)
    const th = await admin.json('POST', '/api/mkdir', body)
    expect(th.data).toEqual({ error: 'ชื่อห้ามมีอักขระ \\ / : * ? " < > |', code: 'fs.name-bad-chars', params: {} })
    expect((await admin.json('POST', '/api/mkdir', body, { 'x-lang': 'th', 'accept-language': 'en' })).data.error).toBe(th.data.error)
  })

  test('not found', async () => {
    const folder = await admin.json('GET', '/api/list?space=home&path=/no-such-folder-lang', undefined, EN)
    expect(folder.status).toBe(404)
    expect(folder.data).toEqual({ error: 'The folder was not found.', code: 'files.folder-not-found', params: {} })
    expect((await admin.json('GET', '/api/list?space=home&path=/no-such-folder-lang')).data.error).toBe('ไม่พบโฟลเดอร์นี้')

    const api = await admin.json('GET', '/api/no-such-api', undefined, EN)
    expect(api.status).toBe(404)
    expect(api.data).toEqual({ error: 'API not found.', code: 'request.no-api', params: {} })
    expect((await admin.json('GET', '/api/no-such-api')).data.error).toBe('ไม่พบ API ที่เรียก')

    // one failed item of a batch is told in the same language
    const del = await admin.json('POST', '/api/delete', { space: 'home', items: ['/no-such-item-lang'] }, EN)
    expect(del.data).toEqual({ done: 0, failed: [{ path: '/no-such-item-lang', error: 'The item was not found.' }] })
    expect((await admin.json('POST', '/api/delete', { space: 'home', items: ['/no-such-item-lang'] })).data.failed[0].error).toBe('ไม่พบรายการที่ระบุ')
  })

  test('sign-in, security token and invalid data', async () => {
    const guest = new Client()
    await guest.start()
    expect((await guest.json('GET', '/api/admin/users', undefined, EN)).data).toEqual({ error: 'Please sign in.', code: 'auth.required', params: {} })
    guest.csrf = 'wrong'
    const csrf = await guest.json('POST', '/api/logout', undefined, EN)
    expect(csrf.status).toBe(403)
    expect(csrf.data).toEqual({ error: 'The security token is invalid. Please reload the page.', code: 'csrf', params: {} })
    const invalid = await admin.json('POST', '/api/mkdir', { space: 'home' }, EN)
    expect(invalid.status).toBe(422)
    expect(invalid.data).toEqual({ error: 'The data sent is not valid.', code: 'request.invalid', params: {} })
    expect((await admin.json('POST', '/api/mkdir', { space: 'home' })).data.error).toBe('ข้อมูลที่ส่งมาไม่ถูกต้อง')
  })

  test('update package without a signature', async () => {
    const { publicKey } = generateKeyPairSync('ed25519')
    const keep = { key: config.updatePublicKey, minFree: config.minFreeSpace, supervised: process.env.FC_SUPERVISED }
    config.updatePublicKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    config.minFreeSpace = 0
    process.env.FC_SUPERVISED = '1'
    try {
      const pkg = zipSync({ 'manifest.json': new TextEncoder().encode(JSON.stringify({ name: 'file-center', version: '99.0.0', files: {} })) })
      const stage = async (headers: Record<string, string>) => {
        const init = await admin.json('POST', '/api/admin/update/upload', { size: pkg.length })
        expect(init.status).toBe(200)
        expect((await admin.json('PUT', `/api/upload/${init.data.id}/0`, pkg)).status).toBe(200)
        return admin.json('POST', '/api/admin/update/stage', { id: init.data.id }, headers)
      }
      const en = await stage(EN)
      expect(en.status).toBe(400)
      expect(en.data).toEqual({ error: MESSAGES['update.unsigned'].en, code: 'update.unsigned', params: {} })
      expect(en.data.error).toContain('This package has no signature (manifest.sig)')
      const th = await stage({})
      expect(th.status).toBe(400)
      expect(th.data.error).toContain('ไม่มีลายเซ็น')
      expect(th.data.code).toBe('update.unsigned')
    } finally {
      config.updatePublicKey = keep.key
      config.minFreeSpace = keep.minFree
      if (keep.supervised === undefined) delete process.env.FC_SUPERVISED
      else process.env.FC_SUPERVISED = keep.supervised
    }
  })
})

describe('dashboard warnings', () => {
  test('have a code per message, params, and the text in the request language', async () => {
    logger.log.error('messages-test-dashboard', 'forced')
    const n = logger.errorsSince(Date.now() - 24 * 3600_000)
    const en = (await admin.json('GET', '/api/admin/status', undefined, EN)).data.warnings
    expect(en).toContainEqual({ level: 'warning', code: 'errors', message: `${n} errors in the last 24 hours`, params: { count: n } })
    const th = (await admin.json('GET', '/api/admin/status')).data.warnings
    expect(th).toContainEqual({ level: 'warning', code: 'errors', message: `มี error ${n} รายการใน 24 ชั่วโมงที่ผ่านมา`, params: { count: n } })
    for (const [lang, list] of [['en', en], ['th', th]] as const) {
      for (const w of list) {
        expect(w.code in MESSAGES).toBe(true)
        expect(w.message).toBe(text(lang, w.code as MessageCode, w.params))
      }
    }
  })

  test('the disk and backup warnings are told apart by their codes', () => {
    const codes = ['admin.disk-critical', 'admin.disk-low', 'backup.never', 'backup.last-failed', 'backup.stale', 'admin.default-password', 'errors']
    const src = readFileSync(join(SRC, 'routes', 'admin.ts'), 'utf8')
    for (const code of codes) {
      expect(MESSAGES).toHaveProperty([code])
      expect(src).toContain(`'${code}'`)
    }
    expect(new Set(codes.map(c => MESSAGES[c as MessageCode].th)).size).toBe(codes.length)
  })
})
