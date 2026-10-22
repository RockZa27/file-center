/**
 * Onboarding state (src/guide.ts, /api/me/guide). Runs in-process on the shared app (see in-process-env.ts); every
 * user here starts with "gd-" and each test makes its own, so the order of the files does not matter.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import './in-process-env'

let app: any
let guide: typeof import('../src/guide')
let n = 0

class Client {
  cookie = ''
  csrf = ''
  async json(method: string, path: string, body?: any, withCsrf = true) {
    const h: Record<string, string> = {}
    if (this.cookie) h.cookie = this.cookie
    if (withCsrf && this.csrf) h['x-csrf-token'] = this.csrf
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
    return this
  }
}

const PW = 'harbor-lamp-42'
let admin: Client

async function makeUser(prefix = 'gd-u') {
  const username = `${prefix}${++n}-${Math.random().toString(36).slice(2, 6)}`
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', permissions: ['read'], publicPermissions: [] })
  expect(r.status).toBe(200)
  return { username, client: await new Client().login(username, PW) }
}

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  guide = await import('../src/guide')
  admin = await new Client().login('admin', 'test-admin-pass')
})

describe('guide', () => {
  test('a new user has no record: seenVersion null, no tours', async () => {
    const { client } = await makeUser()
    const r = await client.json('GET', '/api/me/guide')
    expect(r.status).toBe(200)
    expect(r.data).toEqual({ seenVersion: null, toursDone: [] })
  })

  test('PUT merges: a field that is not sent stays; tours are deduped', async () => {
    const { client } = await makeUser()
    expect((await client.json('PUT', '/api/me/guide', { seenVersion: '1.12.0' })).data).toEqual({ seenVersion: '1.12.0', toursDone: [] })
    const r = await client.json('PUT', '/api/me/guide', { toursDone: ['intro', 'share-1', 'intro'] })
    expect(r.data).toEqual({ seenVersion: '1.12.0', toursDone: ['intro', 'share-1'] })
    expect((await client.json('PUT', '/api/me/guide', { seenVersion: '1.13.0-beta.2' })).data.toursDone).toEqual(['intro', 'share-1'])
    expect((await client.json('GET', '/api/me/guide')).data).toEqual({ seenVersion: '1.13.0-beta.2', toursDone: ['intro', 'share-1'] })
  })

  test('a PUT changes only the signed-in user, even if the body names someone else', async () => {
    const a = await makeUser()
    const b = await makeUser()
    await b.client.json('PUT', '/api/me/guide', { seenVersion: '1.2.3', toursDone: ['mine'] })
    const r = await a.client.json('PUT', '/api/me/guide', { seenVersion: '1.12.0', username: b.username })
    expect(r.status).toBe(200)
    expect((await b.client.json('GET', '/api/me/guide')).data).toEqual({ seenVersion: '1.2.3', toursDone: ['mine'] })
    expect((await a.client.json('GET', '/api/me/guide')).data.seenVersion).toBe('1.12.0')
    expect(Object.hasOwn(guide.guideStore.value.users, b.username)).toBe(true)
  })

  test('bad values answer 400 with a catalog code and change nothing', async () => {
    const { client } = await makeUser()
    await client.json('PUT', '/api/me/guide', { seenVersion: '1.0.0', toursDone: ['ok'] })
    const bads: any[] = [
      { seenVersion: 'v1.2.3' }, { seenVersion: '1.2' }, { seenVersion: '' }, { seenVersion: '1.2.3-' },
      { seenVersion: '1.2.3-' + 'a'.repeat(30) }, { seenVersion: 12 }, { seenVersion: '1.2.3\n' },
    ]
    for (const body of bads) {
      const r = await client.json('PUT', '/api/me/guide', body)
      expect(`${JSON.stringify(body)} ${r.status} ${r.data?.code}`).toBe(`${JSON.stringify(body)} 400 guide.bad-version`)
    }
    const tours: any[] = [
      { toursDone: ['Upper'] }, { toursDone: ['a b'] }, { toursDone: [''] }, { toursDone: ['a'.repeat(41)] },
      { toursDone: Array.from({ length: 51 }, (_, i) => `t${i}`) }, { toursDone: ['../x'] },
    ]
    for (const body of tours) {
      const r = await client.json('PUT', '/api/me/guide', body)
      expect(`${JSON.stringify(body).slice(0, 40)} ${r.status} ${r.data?.code}`).toBe(`${JSON.stringify(body).slice(0, 40)} 400 guide.bad-tours`)
    }
    // wrong JSON types are refused too
    expect((await client.json('PUT', '/api/me/guide', { toursDone: 'intro' })).status).toBe(400)
    // exactly 50 is fine, and the longest legal version
    expect((await client.json('PUT', '/api/me/guide', { toursDone: Array.from({ length: 50 }, (_, i) => `t${i}`) })).status).toBe(200)
    expect((await client.json('PUT', '/api/me/guide', { seenVersion: '1.2.3-' + 'a'.repeat(26) })).status).toBe(200)
    expect((await client.json('GET', '/api/me/guide')).data.seenVersion).toBe('1.2.3-' + 'a'.repeat(26))
  })

  test('no session: 401; no CSRF token: 403', async () => {
    const guest = new Client()
    guest.csrf = (await guest.json('GET', '/api/session')).data.csrf // a visitor has a token too, but no account
    expect((await guest.json('GET', '/api/me/guide')).status).toBe(401)
    expect((await guest.json('PUT', '/api/me/guide', { seenVersion: '1.12.0' })).status).toBe(401)
    const { client } = await makeUser()
    const r = await client.json('PUT', '/api/me/guide', { seenVersion: '1.12.0' }, false)
    expect(r.status).toBe(403)
    expect(r.data.code).toBe('csrf')
    expect((await client.json('GET', '/api/me/guide')).data.seenVersion).toBeNull()
  })

  test('migration: existing users get the previous version, once; later users get null', async () => {
    const old = await makeUser('gd-old')
    const kept = await makeUser('gd-kept')
    // as if the store had never been made: no marker and no record of these two
    guide.guideStore.update(d => { delete d.migrated; delete d.users[old.username]; delete d.users[kept.username] })
    expect(guide.migrateGuide()).toBe(true)
    expect((await old.client.json('GET', '/api/me/guide')).data).toEqual({ seenVersion: guide.PREVIOUS_VERSION, toursDone: [] })
    expect(guide.PREVIOUS_VERSION).toBe('1.11.0')
    // the user moves on; a second run (the next start) must not move them back
    await kept.client.json('PUT', '/api/me/guide', { seenVersion: '1.12.0', toursDone: ['intro'] })
    expect(guide.migrateGuide()).toBe(false)
    expect((await kept.client.json('GET', '/api/me/guide')).data).toEqual({ seenVersion: '1.12.0', toursDone: ['intro'] })
    // someone made after the migration has no record
    const late = await makeUser('gd-late')
    expect((await late.client.json('GET', '/api/me/guide')).data.seenVersion).toBeNull()
    expect(guide.migrateGuide()).toBe(false)
    expect((await late.client.json('GET', '/api/me/guide')).data.seenVersion).toBeNull()
  })

  test('migration on a fresh install (no accounts yet) leaves nobody marked, and still records that it ran', () => {
    const saved = JSON.parse(JSON.stringify(guide.guideStore.value))
    try {
      guide.guideStore.update(d => { delete d.migrated })
      expect(guide.migrateGuide([])).toBe(true)
      expect(guide.guideStore.value.migrated).toBeTruthy()
      expect(guide.migrateGuide([{ username: 'gd-ghost' }])).toBe(false)
      expect(Object.hasOwn(guide.guideStore.value.users, 'gd-ghost')).toBe(false)
    } finally {
      guide.guideStore.update(d => { d.migrated = saved.migrated })
    }
  })

  test('deleting a user removes their record; a new account of the same name starts empty', async () => {
    const { username, client } = await makeUser('gd-del')
    await client.json('PUT', '/api/me/guide', { seenVersion: '1.12.0', toursDone: ['intro'] })
    expect(Object.hasOwn(guide.guideStore.value.users, username)).toBe(true)
    const r = await admin.json('DELETE', `/api/admin/users/${username}`, { password: 'test-admin-pass' })
    expect(r.status).toBe(200)
    expect(Object.hasOwn(guide.guideStore.value.users, username)).toBe(false)
    const again = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', permissions: ['read'], publicPermissions: [] })
    expect(again.status).toBe(200)
    const c = await new Client().login(username, PW)
    expect((await c.json('GET', '/api/me/guide')).data).toEqual({ seenVersion: null, toursDone: [] })
  })

  test('guide.json is part of a backup (not on the list of skipped files)', async () => {
    const src = await Bun.file(new URL('../src/backup.ts', import.meta.url)).text()
    expect(src.match(/const SKIP = new Set\(\[[^\]]*\]/)![0]).not.toContain('guide')
  })
})
