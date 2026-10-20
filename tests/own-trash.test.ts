/**
 * Each user's own trash: GET/DELETE /api/me/trash, POST /api/me/trash/:id/restore, and the trash ids the delete answer carries.
 * Runs in-process on the same app as api.test.ts (see in-process-env.ts); every user here starts with "ot-".
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import './in-process-env'

let app: any
let paths: typeof import('../src/config').paths
let quota: typeof import('../src/quota')

class Client {
  cookie = ''
  csrf = ''
  async json(method: string, path: string, body?: any) {
    const h: Record<string, string> = {}
    if (this.cookie) h.cookie = this.cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    let payload: any
    if (body !== undefined) {
      payload = JSON.stringify(body)
      h['content-type'] = 'application/json'
    }
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
const PERMS = ['read', 'write', 'upload', 'download', 'zip', 'share', 'batchdownload']
const admin = new Client()
const home = (user: string, ...p: string[]) => join(process.env.STORAGE_DIR!, 'users', user, ...p)

async function userWith(username: string, extra: Record<string, unknown> = {}) {
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', permissions: PERMS, publicPermissions: [], ...extra })
  expect(r.status).toBe(200)
  return new Client().login(username, PW)
}

const del = (c: Client, ...items: string[]) => c.json('POST', '/api/delete', { space: 'home', items, withTrash: true })
const list = async (c: Client) => (await c.json('GET', '/api/me/trash')).data.items as any[]
const names = async (c: Client) => (await list(c)).map(i => i.name).sort()

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ paths } = await import('../src/config'))
  quota = await import('../src/quota')
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
})

describe('own trash: who sees what', () => {
  test('a delete answers with the trash id, and the owner sees the entry in their own terms', async () => {
    const alice = await userWith('ot-alice')
    writeFileSync(home('ot-alice', 'a.txt'), 'aaa')
    // without asking for the ids the answer is the one it always was
    writeFileSync(home('ot-alice', 'plain.txt'), 'p')
    expect((await alice.json('POST', '/api/delete', { space: 'home', items: ['/plain.txt'] })).data).toEqual({ done: 1, failed: [] })
    await alice.json('DELETE', '/api/me/trash')
    const r = await del(alice, '/a.txt', '/missing.txt')
    expect(r.status).toBe(200)
    expect(r.data.done).toBe(1)
    expect(r.data.failed.map((f: any) => f.path)).toEqual(['/missing.txt'])
    expect(r.data.trashed).toEqual([{ path: '/a.txt', id: expect.stringMatching(/^\d{13}_[a-f0-9]{8}$/) }])
    const items = await list(alice)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: r.data.trashed[0].id, name: 'a.txt', type: 'file', size: 3, owner: 'ot-alice', deletedBy: 'ot-alice',
      space: 'home', path: '/a.txt', restorable: true,
    })
    // no server path in what a user gets
    expect(JSON.stringify(items)).not.toContain('originalPath')
    expect(JSON.stringify(items)).not.toContain('/users/')
    expect(existsSync(paths.trash)).toBe(true)
  })

  test("a user sees only their own, and can not restore or delete another's (404 like an unknown id)", async () => {
    const alice = await userWith('ot-alice2')
    const bob = await userWith('ot-bob2')
    writeFileSync(home('ot-alice2', 'secret.txt'), 's')
    writeFileSync(home('ot-bob2', 'mine.txt'), 'm')
    const id = (await del(alice, '/secret.txt')).data.trashed[0].id
    await del(bob, '/mine.txt')
    expect(await names(alice)).toEqual(['secret.txt'])
    expect(await names(bob)).toEqual(['mine.txt'])
    const unknown = await bob.json('POST', '/api/me/trash/0000000000000_00000000/restore')
    const foreign = await bob.json('POST', `/api/me/trash/${id}/restore`)
    expect(foreign.status).toBe(404)
    expect(foreign.data).toEqual(unknown.data)
    expect((await bob.json('DELETE', `/api/me/trash/${id}`)).status).toBe(404)
    expect(existsSync(home('ot-alice2', 'secret.txt'))).toBe(false)
    expect(await names(alice)).toEqual(['secret.txt'])
    // a visitor has no trash
    expect((await new Client().json('GET', '/api/me/trash')).status).toBe(401)
  })

  test('entries from before 1.10 (no owner, no space) belong to whoever home held the path', async () => {
    const alice = await userWith('ot-old')
    const bob = await userWith('ot-old-other')
    const id = '1700000000000_abcdef01'
    mkdirSync(join(paths.trash, id, 'item'), { recursive: true })
    writeFileSync(join(paths.trash, id, 'item', 'x'), 'old')
    // the file itself is stored as the "item"
    writeFileSync(join(paths.trash, id, 'meta.json'), JSON.stringify({
      id, name: 'x', type: 'dir', size: 3, originalPath: '/users/ot-old/legacy', deletedAt: '2023-11-14T00:00:00.000Z', deletedBy: 'admin',
    }))
    const found = (await list(alice)).find(i => i.id === id)
    expect(found).toMatchObject({ owner: 'ot-old', space: 'home', path: '/legacy' })
    expect((await list(bob)).find(i => i.id === id)).toBeUndefined()
    expect((await bob.json('POST', `/api/me/trash/${id}/restore`)).status).toBe(404)
    const r = await alice.json('POST', `/api/me/trash/${id}/restore`)
    expect(r.status).toBe(200)
    expect(readFileSync(home('ot-old', 'legacy', 'x'), 'utf8')).toBe('old')
  })

  test('the admin trash still lists everything, and a restore there works as before', async () => {
    const alice = await userWith('ot-adm')
    writeFileSync(home('ot-adm', 'k.txt'), 'k')
    const id = (await del(alice, '/k.txt')).data.trashed[0].id
    const all = (await admin.json('GET', '/api/admin/trash')).data
    expect(all.items.find((i: any) => i.id === id)).toMatchObject({ originalPath: '/users/ot-adm/k.txt', owner: 'ot-adm', space: 'home' })
    expect((await admin.json('POST', '/api/admin/trash/restore', { id })).status).toBe(200)
    expect(readFileSync(home('ot-adm', 'k.txt'), 'utf8')).toBe('k')
    expect(await names(alice)).toEqual([])
  })
})

describe('own trash: restore (undo)', () => {
  test('undo right after a delete puts the file back, and the entry is gone', async () => {
    const c = await userWith('ot-undo')
    mkdirSync(home('ot-undo', 'docs'))
    writeFileSync(home('ot-undo', 'docs', 'd.txt'), 'dd')
    const id = (await del(c, '/docs')).data.trashed[0].id
    expect(existsSync(home('ot-undo', 'docs'))).toBe(false)
    const r = await c.json('POST', `/api/me/trash/${id}/restore`)
    expect(r.status).toBe(200)
    expect(r.data).toMatchObject({ ok: true, space: 'home', path: '/docs' })
    expect(readFileSync(home('ot-undo', 'docs', 'd.txt'), 'utf8')).toBe('dd')
    expect(await list(c)).toEqual([])
    // a second restore finds nothing
    expect((await c.json('POST', `/api/me/trash/${id}/restore`)).status).toBe(404)
  })

  test('a name that is taken now gets a free one, and the earlier versions come back with the file', async () => {
    const c = await userWith('ot-clash')
    writeFileSync(home('ot-clash', 'n.txt'), 'one')
    // an edit keeps the old content as a version
    expect((await c.json('PUT', '/api/content', { space: 'home', path: '/n.txt', content: 'two' })).status).toBe(200)
    const id = (await del(c, '/n.txt')).data.trashed[0].id
    writeFileSync(home('ot-clash', 'n.txt'), 'new one')
    const r = await c.json('POST', `/api/me/trash/${id}/restore`)
    expect(r.status).toBe(200)
    expect(r.data.path).toBe('/n (1).txt')
    expect(readFileSync(home('ot-clash', 'n.txt'), 'utf8')).toBe('new one')
    expect(readFileSync(home('ot-clash', 'n (1).txt'), 'utf8')).toBe('two')
    const versions = await c.json('GET', '/api/versions?space=home&path=/n%20(1).txt')
    expect(versions.status).toBe(200)
    expect(versions.data.items.length).toBeGreaterThan(0)
  })

  test('after the home moved, the item can not go back (and says so in the list)', async () => {
    const c = await userWith('ot-moved')
    writeFileSync(home('ot-moved', 'm.txt'), 'm')
    const id = (await del(c, '/m.txt')).data.trashed[0].id
    expect((await admin.json('PUT', '/api/admin/users/ot-moved', { homedir: '/elsewhere/ot-moved' })).status).toBe(200)
    const item = (await list(c)).find(i => i.id === id)
    expect(item).toMatchObject({ owner: 'ot-moved', space: null, path: null, restorable: false })
    const r = await c.json('POST', `/api/me/trash/${id}/restore`)
    expect(r.status).toBe(403)
    expect(r.data.code).toBe('trash.cannot-restore-here')
    // nothing was written outside the new home, and the entry is still there
    expect(existsSync(home('ot-moved', 'm.txt'))).toBe(false)
    expect((await list(c)).map(i => i.id)).toContain(id)
    // the owner can still throw it away for good
    expect((await c.json('DELETE', `/api/me/trash/${id}`)).status).toBe(200)
  })

  test('public items: the one who deleted them sees them while they can write there, and no one else', async () => {
    const writer = await userWith('ot-pub-w', { publicPermissions: ['read', 'write', 'upload', 'download'] })
    const reader = await userWith('ot-pub-r', { publicPermissions: ['read', 'download'] })
    writeFileSync(join(paths.publicDir, 'ot-pub.txt'), 'p')
    const r = await writer.json('POST', '/api/delete', { space: 'public', items: ['/ot-pub.txt'], withTrash: true })
    expect(r.status).toBe(200)
    const id = r.data.trashed[0].id
    expect((await list(writer)).find(i => i.id === id)).toMatchObject({ owner: null, space: 'public', path: '/ot-pub.txt', restorable: true })
    expect((await list(reader)).find(i => i.id === id)).toBeUndefined()
    expect((await reader.json('POST', `/api/me/trash/${id}/restore`)).status).toBe(404)
    // the write right goes: the entry is no longer theirs to see
    expect((await admin.json('PUT', '/api/admin/users/ot-pub-w', { publicPermissions: ['read'] })).status).toBe(200)
    expect((await list(writer)).find(i => i.id === id)).toBeUndefined()
    expect((await writer.json('POST', `/api/me/trash/${id}/restore`)).status).toBe(404)
    expect((await admin.json('PUT', '/api/admin/users/ot-pub-w', { publicPermissions: ['read', 'write'] })).status).toBe(200)
    const back = await writer.json('POST', `/api/me/trash/${id}/restore`)
    expect(back.status).toBe(200)
    expect(back.data).toMatchObject({ space: 'public', path: '/ot-pub.txt' })
    expect(readFileSync(join(paths.publicDir, 'ot-pub.txt'), 'utf8')).toBe('p')
  })

  test('a restore counts against the quota like any other write', async () => {
    const c = await userWith('ot-quota', { quotaBytes: 10_000 })
    writeFileSync(home('ot-quota', 'big.bin'), new Uint8Array(6000))
    quota.markStale('ot-quota')
    const id = (await del(c, '/big.bin')).data.trashed[0].id
    writeFileSync(home('ot-quota', 'other.bin'), new Uint8Array(6000))
    quota.markStale('ot-quota')
    const r = await c.json('POST', `/api/me/trash/${id}/restore`)
    expect(r.status).toBe(507)
    expect(r.data.code).toBe('quota.exceeded')
    expect((await list(c)).map(i => i.id)).toContain(id)
    expect(existsSync(home('ot-quota', 'big.bin'))).toBe(false)
    // with room it works, and the bytes are counted again
    await del(c, '/other.bin')
    expect((await c.json('POST', `/api/me/trash/${id}/restore`)).status).toBe(200)
    await quota.ready((await import('../src/auth')).findUser('ot-quota'))
    expect((await c.json('GET', '/api/me/usage')).data.used).toBe(6000)
  })
})

describe('own trash: deleting for good', () => {
  test('one entry, then the whole own trash; other people keep theirs; both leave a line in the audit trail', async () => {
    const a = await userWith('ot-purge-a')
    const b = await userWith('ot-purge-b')
    for (const n of ['1.txt', '2.txt', '3.txt']) writeFileSync(home('ot-purge-a', n), n)
    writeFileSync(home('ot-purge-b', 'b.txt'), 'b')
    const ids = (await del(a, '/1.txt', '/2.txt', '/3.txt')).data.trashed.map((t: any) => t.id)
    await del(b, '/b.txt')
    const one = await a.json('DELETE', `/api/me/trash/${ids[0]}`)
    expect(one.data).toEqual({ ok: true, removed: 1 })
    expect(existsSync(join(paths.trash, ids[0]))).toBe(false)
    expect((await a.json('DELETE', `/api/me/trash/${ids[0]}`)).status).toBe(404)
    const all = await a.json('DELETE', '/api/me/trash')
    expect(all.data).toEqual({ ok: true, removed: 2 })
    expect(await list(a)).toEqual([])
    expect(await names(b)).toEqual(['b.txt'])
    const log = (await admin.json('GET', '/api/admin/activity?action=trash-delete-own&pageSize=50')).data
    expect(log.items.filter((r: any) => r.user === 'ot-purge-a').length).toBe(2)
  })
})
