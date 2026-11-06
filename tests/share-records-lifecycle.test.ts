/**
 * What happens to share links when their account goes, and how long a revoked one is kept.
 * Runs in-process on the same app as api.test.ts (see in-process-env.ts); every user here starts with "srl-".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import './in-process-env'

let JsonStore: typeof import('../src/store').JsonStore

let app: any
let shares: typeof import('../src/shares')
let records: typeof import('../src/account-records')
let paths: typeof import('../src/config').paths

const PW = 'harbor-lamp-42'
const NOTE = 'srl-note Send ID-card scans for client Somchai here'
const DAY = 86_400_000

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

const admin = new Client()
const anon = new Client()
const home = (user: string) => join(process.env.STORAGE_DIR!, 'users', user)
const made: string[] = []
const dirs: string[] = []

async function userWith(username: string) {
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', permissions: ['read', 'write', 'download', 'upload', 'share'], publicPermissions: [] })
  expect(r.status).toBe(200)
  if (!made.includes(username)) made.push(username)
  return new Client().login(username, PW)
}
const remove = (username: string) => admin.json('DELETE', `/api/admin/users/${username}`)
const stored = async () => {
  await JsonStore.flushAll()
  return JSON.parse(readFileSync(paths.shares, 'utf8')).shares as any[]
}
/** a link written straight into the store, as a test of the purge needs it */
function plain(owner: string, extra: Record<string, unknown> = {}) {
  const { share } = shares.createShare({
    owner, space: 'home', path: '/f.txt', type: 'file', expiresAt: new Date(Date.now() + 7 * DAY).toISOString(), maxDownloads: null,
  } as any)
  Object.assign(share, extra)
  return share
}

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ JsonStore } = await import('../src/store'))
  ;({ paths } = await import('../src/config'))
  shares = await import('../src/shares')
  records = await import('../src/account-records')
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
})

afterAll(async () => {
  for (const u of made) {
    await remove(u)
    rmSync(home(u), { recursive: true, force: true })
  }
  for (const s of [...shares.allShares()]) if (s.owner.startsWith('srl-')) shares.removeSharesOf(s.owner)
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe('share links of a deleted account', () => {
  test('are removed, and a new account of the same name sees none of them', async () => {
    const old = await userWith('srl-alice')
    writeFileSync(join(home('srl-alice'), 'f.txt'), 'x')
    mkdirSync(join(home('srl-alice'), 'inbox'))
    const down = await old.json('POST', '/api/shares', { space: 'home', path: '/f.txt', days: 7 })
    const up = await old.json('POST', '/api/shares', { space: 'home', path: '/inbox', days: 7, kind: 'upload', note: NOTE })
    expect(down.status).toBe(200)
    expect(up.status).toBe(200)
    const ids = [down.data.share.id, up.data.share.id]
    const tokens = [down.data.token, up.data.token]
    expect((await anon.json('GET', `/api/s/${tokens[0]}`)).status).toBe(200)

    expect((await remove('srl-alice')).status).toBe(200)
    expect(shares.sharesOf('srl-alice')).toEqual([])
    expect((await stored()).filter(s => ids.includes(s.id))).toEqual([])
    await JsonStore.flushAll()
    expect(readFileSync(paths.shares, 'utf8')).not.toContain('Somchai')

    // a visitor with an old token gets what a link that never existed gets
    const missing = await anon.json('GET', `/api/s/${'A'.repeat(43)}`)
    expect(missing.status).toBe(404)
    for (const t of tokens) {
      const r = await anon.json('GET', `/api/s/${t}`)
      expect(r.status).toBe(missing.status)
      expect(r.data).toEqual(missing.data)
      expect(JSON.stringify(r.data)).not.toContain('srl-alice')
      expect((await anon.json('GET', `/api/s/${t}/download`)).status).toBe(missing.status)
    }

    const fresh = await userWith('srl-alice')
    expect((await fresh.json('GET', '/api/shares')).data.shares).toEqual([])
    const staff = (await admin.json('GET', '/api/admin/shares')).data.shares as any[]
    expect(staff.filter(s => s.owner.toLowerCase() === 'srl-alice')).toEqual([])
    expect(JSON.stringify(staff)).not.toContain('Somchai')
  })
})

describe('the housekeeping purge', () => {
  test('keeps a revoked link for 30 days, then removes it whatever its expiry; keeps a live never-expiring one', async () => {
    await userWith('srl-bob')
    const old = plain('srl-bob', { revokedAt: new Date(Date.now() - 31 * DAY).toISOString() })
    const recent = plain('srl-bob', { revokedAt: new Date(Date.now() - 29 * DAY).toISOString() })
    const never = plain('srl-bob', { expiresAt: '9999-12-31T23:59:59.999Z' })
    const neverRevoked = plain('srl-bob', { expiresAt: '9999-12-31T23:59:59.999Z', revokedAt: new Date(Date.now() - 40 * DAY).toISOString() })
    expect(shares.purgeExpiredShares()).toBeGreaterThanOrEqual(2)
    expect(shares.findShare(old.id)).toBeUndefined()
    expect(shares.findShare(neverRevoked.id)).toBeUndefined()
    expect(shares.findShare(recent.id)).toBeDefined()
    expect(shares.findShare(never.id)).toBeDefined()
    expect((await stored()).map(s => s.id)).toContain(recent.id)
    expect((await stored()).map(s => s.id)).not.toContain(old.id)
  })

  test('removes a link whose owner account does not exist', () => {
    const orphan = plain('srl-nobody')
    expect(shares.findShare(orphan.id)).toBeDefined()
    expect(shares.purgeExpiredShares()).toBeGreaterThanOrEqual(1)
    expect(shares.findShare(orphan.id)).toBeUndefined()
  })
})

describe('a restore that drops an account', () => {
  test('removes its links from the file instead of revoking them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'srl-'))
    dirs.push(dir)
    const file = join(dir, 'shares.json')
    writeFileSync(file, JSON.stringify({ shares: [
      { id: '1', owner: 'SRL-Gone', note: NOTE }, { id: '2', owner: 'srl-kept' }, { id: '3', owner: 'srl-gone', revokedAt: 'x' },
    ] }))
    records.dropRecordsOnDisk({ same: new Map([['srl-kept', Date.now()]]), drop: new Set(['srl-gone']) }, { shares: file } as any)
    const left = JSON.parse(readFileSync(file, 'utf8')).shares
    expect(left.map((s: any) => s.id)).toEqual(['2'])
    expect(readFileSync(file, 'utf8')).not.toContain('Somchai')
  })
})
