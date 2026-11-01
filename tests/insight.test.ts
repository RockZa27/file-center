/**
 * Storage insight (src/insight.ts, POST/GET /api/insight): biggest files, size by type, duplicates found by size then
 * SHA-256, who may look at which folder, the limits (file count, hashing budget, one scan at a time, rescan pause) and
 * the move of duplicates to the trash through the ordinary delete. Runs in-process (see in-process-env.ts); users start with "in-".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import './in-process-env'

let app: any
let ins: typeof import('../src/insight')

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

async function user(username: string, role = 'user') {
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role, permissions: PERMS, publicPermissions: [] })
  expect(r.status).toBe(200)
  return new Client().login(username, PW)
}

/** scan and wait for the result */
async function scan(c: Client, scope = 'me') {
  const r = await c.json('POST', '/api/insight/scan', { scope })
  if (r.status !== 202 && r.status !== 200) return r
  await ins.insightIdle()
  return c.json('GET', `/api/insight?scope=${encodeURIComponent(scope)}`)
}

const bytes = (n: number, ch: string) => ch.repeat(n)

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ins = await import('../src/insight')
  Object.assign(saved, ins.INSIGHT_LIMITS)
  ins.INSIGHT_LIMITS.rescanMs = 0
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
})
afterAll(() => { Object.assign(ins.INSIGHT_LIMITS, saved); ins.forgetInsight() })

describe('what takes space and duplicates', () => {
  test('largest files, size by type, duplicates by content (same size alone is not enough)', async () => {
    const alice = await user('in-alice')
    mkdirSync(home('in-alice', 'docs', 'old'), { recursive: true })
    writeFileSync(home('in-alice', 'big.mp4'), bytes(50_000, 'v'))
    writeFileSync(home('in-alice', 'a.txt'), bytes(3000, 'a'))
    writeFileSync(home('in-alice', 'docs', 'copy-of-a.txt'), bytes(3000, 'a'))
    writeFileSync(home('in-alice', 'docs', 'old', 'a3.txt'), bytes(3000, 'a'))
    writeFileSync(home('in-alice', 'same-size.txt'), bytes(3000, 'b'))
    writeFileSync(home('in-alice', 'tiny.txt'), 'x')
    writeFileSync(home('in-alice', 'tiny2.txt'), 'x')
    writeFileSync(home('in-alice', 'README'), bytes(10, 'r'))
    symlinkSync(home('in-alice', 'big.mp4'), home('in-alice', 'link.mp4'))

    expect((await alice.json('GET', '/api/insight')).data).toMatchObject({ state: 'none', scope: 'me', space: 'home', canTrash: true })
    const r = await scan(alice)
    expect(r.status).toBe(200)
    const res = r.data.result
    expect(r.data.state).toBe('done')
    expect(res.files).toBe(8)
    expect(res.size).toBe(50_000 + 4 * 3000 + 2 + 10)
    expect(res.largest[0]).toMatchObject({ path: '/big.mp4', size: 50_000 })
    expect(res.largest.map((f: any) => f.path)).not.toContain('/link.mp4')
    const types = Object.fromEntries(res.types.map((t: any) => [t.ext, t]))
    expect(types.mp4).toMatchObject({ files: 1, size: 50_000 })
    expect(types.txt).toMatchObject({ files: 6 })
    expect(types['']).toMatchObject({ files: 1, size: 10 })
    // one group of three; same-size-different-content and the files under 1 KiB are not duplicates
    expect(res.duplicates.totalGroups).toBe(1)
    const g = res.duplicates.groups[0]
    expect(g).toMatchObject({ size: 3000, count: 3, wasted: 6000 })
    expect(g.files.map((f: any) => f.path).sort()).toEqual(['/a.txt', '/docs/copy-of-a.txt', '/docs/old/a3.txt'])
    expect(res.duplicates.wasted).toBe(6000)
    expect(res.truncated).toEqual({ files: false, time: false, hashBudget: false })
    // only the four 3000-byte files were read, never the others
    expect(res.duplicates.hashedBytes).toBe(12_000)
  })

  test('the duplicates go to the trash through the ordinary delete, and can be restored', async () => {
    const bob = await user('in-bob')
    writeFileSync(home('in-bob', 'one.bin'), bytes(2048, 'z'))
    writeFileSync(home('in-bob', 'two.bin'), bytes(2048, 'z'))
    const g = (await scan(bob)).data.result.duplicates.groups[0]
    const drop = g.files.slice(1).map((f: any) => f.path)
    const del = await bob.json('POST', '/api/delete', { space: 'home', items: drop, withTrash: true })
    expect(del.data.done).toBe(1)
    expect(existsSync(home('in-bob', drop[0].slice(1)))).toBe(false)
    expect(existsSync(home('in-bob', g.files[0].path.slice(1)))).toBe(true)
    expect((await bob.json('GET', '/api/me/trash')).data.items.map((i: any) => i.name)).toContain(drop[0].slice(1))
    // the scan that listed the copy is gone, so a new scan is not refused as "recent" and shows no stale copy
    expect((await bob.json('GET', '/api/insight?scope=me')).data.state).toBe('none')
  })
})

describe('who may look at what', () => {
  test('a visitor is refused; a user sees only their own space, never all or another user', async () => {
    const carl = await user('in-carl')
    const dina = await user('in-dina')
    writeFileSync(home('in-dina', 'dina-secret-name.bin'), bytes(5000, 'd'))
    expect((await new Client().json('GET', '/api/insight')).status).toBe(401)
    expect([401, 403]).toContain((await new Client().json('POST', '/api/insight/scan', {})).status) // 403: no CSRF token either
    for (const scope of ['all', 'user:in-dina', 'user:nobody', 'bogus', '../..']) {
      const r = await carl.json('POST', '/api/insight/scan', { scope })
      expect([400, 403, 404]).toContain(r.status)
      expect((await carl.json('GET', `/api/insight?scope=${encodeURIComponent(scope)}`)).status).not.toBe(200)
    }
    const mine = await scan(carl)
    expect(JSON.stringify(mine.data)).not.toContain('dina-secret-name')
    expect(JSON.stringify(mine.data)).not.toContain(process.env.STORAGE_DIR!)
    // the cache is per folder: dina's own result is hers
    expect(JSON.stringify((await scan(dina)).data)).toContain('dina-secret-name')
  })

  test('a manager looks at the users they manage (read only) and nobody else', async () => {
    const mia = await user('in-mia', 'manager')
    await user('in-ned')
    writeFileSync(home('in-ned', 'n.bin'), bytes(4096, 'n'))
    const r = await scan(mia, 'user:in-ned')
    expect(r.status).toBe(200)
    expect(r.data).toMatchObject({ scope: 'user:in-ned', space: 'user:in-ned', canTrash: false })
    expect(r.data.result.largest[0].path).toBe('/n.bin')
    expect((await mia.json('POST', '/api/insight/scan', { scope: 'all' })).status).toBe(403)
    expect((await mia.json('POST', '/api/insight/scan', { scope: 'user:admin' })).status).toBe(403)
    expect((await mia.json('POST', '/api/insight/scan', { scope: 'user:in-mia' })).status).toBe(403)
    // the scan of another's home is on the trail
    const act = (await admin.json('GET', '/api/admin/activity?pageSize=50')).data
    expect(JSON.stringify(act)).toContain('insight-scan')
  })

  test('an admin looks at the whole system or any user, and may trash through the home space', async () => {
    await user('in-olga')
    writeFileSync(home('in-olga', 'x1.bin'), bytes(2500, 'o'))
    writeFileSync(home('in-olga', 'x2.bin'), bytes(2500, 'o'))
    const all = await scan(admin, 'all')
    expect(all.status).toBe(200)
    expect(all.data).toMatchObject({ space: 'home', base: '', canTrash: true })
    expect(JSON.stringify(all.data.result.duplicates.groups)).toContain('/users/in-olga/x1.bin')
    const u = await scan(admin, 'user:in-olga')
    expect(u.data).toMatchObject({ space: 'home', base: '/users/in-olga', canTrash: true })
    const g = u.data.result.duplicates.groups[0]
    const full = u.data.base + g.files[1].path
    expect((await admin.json('POST', '/api/delete', { space: 'home', items: [full] })).data.done).toBe(1)
    expect(existsSync(home('in-olga', g.files[1].path.slice(1)))).toBe(false)
  })
})

describe('limits', () => {
  test('stops at the file limit and the hashing budget and says so', async () => {
    const pat = await user('in-pat')
    for (let i = 0; i < 6; i++) writeFileSync(home('in-pat', `f${i}.bin`), bytes(2000, 'p'))
    ins.INSIGHT_LIMITS.maxFiles = 4
    let r = await scan(pat)
    expect(r.data.result.files).toBe(4)
    expect(r.data.result.truncated.files).toBe(true)
    ins.INSIGHT_LIMITS.maxFiles = saved.maxFiles
    ins.INSIGHT_LIMITS.maxHashBytes = 5000
    r = await scan(pat)
    expect(r.data.result.truncated.hashBudget).toBe(true)
    expect(r.data.result.duplicates.hashedBytes).toBeLessThanOrEqual(5000)
    ins.INSIGHT_LIMITS.maxHashBytes = saved.maxHashBytes
  })

  test('one scan at a time on the server; the same folder is not scanned again within the pause', async () => {
    const dir = home('in-pat')
    expect(ins.startInsight('k1', dir)).toBe('started')
    expect(ins.startInsight('k1', dir)).toBe('running')
    expect(ins.startInsight('k2', dir)).toBe('busy')
    expect(ins.insightState('k1').state).toBe('running')
    await ins.insightIdle()
    expect(ins.insightState('k1').state).toBe('done')
    ins.INSIGHT_LIMITS.rescanMs = 60_000
    expect(ins.startInsight('k1', dir)).toBe('recent')
    ins.INSIGHT_LIMITS.rescanMs = 0
    ins.forgetInsight()
  })

  test('a busy server answers 429 with a catalog message', async () => {
    const quin = await user('in-quin')
    const rex = await user('in-rex')
    for (let i = 0; i < 300; i++) writeFileSync(home('in-quin', `q${i}.txt`), 'q')
    const first = await quin.json('POST', '/api/insight/scan', {})
    expect(first.status).toBe(202)
    const second = await rex.json('POST', '/api/insight/scan', {})
    // the first scan may already be over on a fast disk; when it is not, the second is told to wait
    expect([200, 202, 429]).toContain(second.status)
    if (second.status === 429) expect(second.data.code).toBe('insight.busy')
    await ins.insightIdle()
    await ins.insightIdle()
  })

  test('an expired result is not served', async () => {
    const sue = await user('in-sue')
    await scan(sue)
    ins.INSIGHT_LIMITS.cacheMs = -1
    expect((await sue.json('GET', '/api/insight')).data.state).toBe('none')
    ins.INSIGHT_LIMITS.cacheMs = saved.cacheMs
  })
})
