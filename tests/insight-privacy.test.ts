/**
 * Storage insight, privacy and fair use: a cached result lists only files that are still there, it is forgotten with
 * the account, staff reading another user's result leave an audit line, a rescan pause that a delete cannot skip, and a
 * cooldown for plain users. Runs in-process (see in-process-env.ts); users start with "ins-".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import './in-process-env'

let app: any
let ins: typeof import('../src/insight')
let auditMod: typeof import('../src/audit')

class Client {
  cookie = ''
  csrf = ''
  async json(method: string, path: string, body?: any) {
    const h: Record<string, string> = {}
    if (this.cookie) h.cookie = this.cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    if (body !== undefined) h['content-type'] = 'application/json'
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }))
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
const PERMS = ['read', 'write', 'upload', 'download', 'zip', 'share', 'batchdownload']
const admin = new Client()
const home = (user: string, ...p: string[]) => join(process.env.STORAGE_DIR!, 'users', user, ...p)
const saved = {} as typeof ins.INSIGHT_LIMITS
const made: string[] = []

async function user(username: string, role = 'user') {
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role, permissions: PERMS, publicPermissions: [] })
  expect(r.status).toBe(200)
  made.push(username)
  return new Client().login(username, PW)
}

async function scan(c: Client, scope = 'me') {
  const r = await c.json('POST', '/api/insight/scan', { scope })
  if (r.status !== 202 && r.status !== 200) return r
  await ins.insightIdle()
  return c.json('GET', `/api/insight?scope=${encodeURIComponent(scope)}`)
}
const names = (r: any) => [...r.data.result.largest.map((f: any) => f.path), ...r.data.result.duplicates.groups.flatMap((g: any) => g.files.map((f: any) => f.path))]
const insightLines = (target: string) => [...auditMod.auditEntries()].filter(e => e.action === 'browse' && e.detail === 'insight' && e.target === target)

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ins = await import('../src/insight')
  auditMod = await import('../src/audit')
  Object.assign(saved, ins.INSIGHT_LIMITS)
  ins.INSIGHT_LIMITS.rescanMs = 0
  ins.INSIGHT_LIMITS.userCooldownMs = 0
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
})
afterAll(async () => {
  Object.assign(ins.INSIGHT_LIMITS, saved)
  ins.forgetInsight()
  for (const u of made) {
    await admin.json('DELETE', `/api/admin/users/${u}`, { deleteFiles: true, password: process.env.ADMIN_PASSWORD })
    rmSync(home(u), { recursive: true, force: true })
  }
})

describe('a cached result shows only files that are still there', () => {
  test('a rename through the API takes the old name out of the next read', async () => {
    const c = await user('ins-stale')
    writeFileSync(home('ins-stale', 'secret-name.txt'), 'x'.repeat(5000))
    writeFileSync(home('ins-stale', 'keep-me.txt'), 'y'.repeat(4000))
    expect(names(await scan(c))).toContain('/secret-name.txt')
    const r = await c.json('POST', '/api/rename', { space: 'home', path: '/secret-name.txt', name: 'renamed-away.txt' })
    expect(r.status).toBe(200)
    const after = await c.json('GET', '/api/insight?scope=me')
    expect(after.data.state).toBe('done')
    expect(names(after)).not.toContain('/secret-name.txt')
    expect(names(after)).toContain('/keep-me.txt')
  })

  test('a duplicate group with one copy left is dropped, the count follows', async () => {
    const c = await user('ins-dup')
    for (const n of ['a.bin', 'b.bin', 'c.bin']) writeFileSync(home('ins-dup', n), 'd'.repeat(3000))
    const r = await scan(c)
    expect(r.data.result.duplicates.groups[0].count).toBe(3)
    rmSync(home('ins-dup', 'c.bin'))
    let now = await c.json('GET', '/api/insight?scope=me')
    expect(now.data.result.duplicates.groups[0].count).toBe(2)
    expect(now.data.result.duplicates.groups[0].wasted).toBe(3000)
    rmSync(home('ins-dup', 'b.bin'))
    now = await c.json('GET', '/api/insight?scope=me')
    expect(now.data.result.duplicates.groups).toHaveLength(0)
    expect(now.data.result.files).toBe(3) // totals stay as scanned
  })

  test('a deleted account with files and a new one of the same name: no old names', async () => {
    const c = await user('ins-reborn')
    writeFileSync(home('ins-reborn', 'Somchai-medical-record.pdf'), 'm'.repeat(5000))
    expect(names(await scan(c))).toContain('/Somchai-medical-record.pdf')
    const d = await admin.json('DELETE', '/api/admin/users/ins-reborn', { deleteFiles: true, password: process.env.ADMIN_PASSWORD })
    expect(d.status).toBe(200)
    made.pop()
    // the old home may come back as the same path with the same file, which is what a stale cache would show
    const again = await user('ins-reborn')
    writeFileSync(home('ins-reborn', 'Somchai-medical-record.pdf'), 'm'.repeat(5000))
    const r = await again.json('GET', '/api/insight?scope=me')
    expect(r.data.state).toBe('none')
    expect(r.data.result).toBeUndefined()
  })
})

describe('staff reading a result leave an audit line', () => {
  test('once a minute for a foreign scope, never for your own', async () => {
    const c = await user('ins-watched')
    writeFileSync(home('ins-watched', 'w.txt'), 'w'.repeat(2000))
    await scan(c)
    const scope = 'user:ins-watched'
    expect(insightLines(scope)).toHaveLength(0)
    expect((await c.json('GET', '/api/insight?scope=me')).status).toBe(200)
    expect(insightLines(scope)).toHaveLength(0)
    expect((await admin.json('GET', `/api/insight?scope=${scope}`)).status).toBe(200)
    expect(insightLines(scope)).toHaveLength(1)
    expect(insightLines(scope)[0].user).toBe('admin')
    expect((await admin.json('GET', `/api/insight?scope=${scope}`)).status).toBe(200)
    expect(insightLines(scope)).toHaveLength(1)
    expect((await c.json('GET', '/api/insight?scope=me')).status).toBe(200)
    expect(insightLines(scope)).toHaveLength(1)
  })
})

describe('fair use of the one scanner', () => {
  test('a plain user waits after a finished scan, an admin does not', async () => {
    ins.INSIGHT_LIMITS.userCooldownMs = 60_000
    try {
      const c = await user('ins-eager')
      writeFileSync(home('ins-eager', 'e.txt'), 'e'.repeat(2000))
      expect((await scan(c)).status).toBe(200)
      const second = await c.json('POST', '/api/insight/scan', {})
      expect(second.status).toBe(429)
      expect(second.data.code).toBe('insight.cooldown')
      expect(second.data.params.seconds).toBeGreaterThan(0)
      expect(second.data.params.seconds).toBeLessThanOrEqual(60)
      // another plain user is not held by it
      const other = await user('ins-patient')
      expect((await scan(other)).status).toBe(200)
      // an admin is not limited
      expect((await scan(admin, 'me')).status).toBe(200)
      expect((await scan(admin, 'all')).status).toBe(200)
      expect((await scan(admin, 'me')).status).toBe(200)
    } finally { ins.INSIGHT_LIMITS.userCooldownMs = 0 }
  })

  test('forgetting results does not allow an earlier rescan of the folder', async () => {
    ins.INSIGHT_LIMITS.rescanMs = 60_000
    try {
      const dir = home('ins-eager')
      expect(ins.startInsight('ins-guard-key', dir)).toBe('started')
      await ins.insightIdle()
      ins.forgetInsight()
      expect(ins.insightState('ins-guard-key').state).toBe('none')
      expect(ins.startInsight('ins-guard-key', dir)).toBe('recent')
      ins.forgetInsight('ins-guard-key')
      expect(ins.startInsight('ins-guard-key', dir)).toBe('recent')
    } finally { ins.INSIGHT_LIMITS.rescanMs = 0 }
  })

  test('a scan that was running when everything was forgotten does not put its result back', async () => {
    const dir = home('ins-eager')
    expect(ins.startInsight('ins-late-key', dir)).toBe('started')
    // an account deleted or made while it runs: its result may be the old account's
    ins.forgetInsight()
    await ins.insightIdle()
    expect(ins.insightState('ins-late-key').state).toBe('none')
  })

  test('a new account of a deleted name does not inherit the cooldown', async () => {
    const { forgetAccount } = await import('../src/account-records')
    ins.INSIGHT_LIMITS.userCooldownMs = 60_000
    try {
      expect(ins.startInsight('ins-cool-key', home('ins-eager'), 'ins-reborn')).toBe('started')
      await ins.insightIdle()
      expect(ins.cooldownLeft('ins-reborn')).toBeGreaterThan(0)
      forgetAccount('INS-REBORN')
      expect(ins.cooldownLeft('ins-reborn')).toBe(0)
    } finally { ins.INSIGHT_LIMITS.userCooldownMs = 0 }
  })
})
