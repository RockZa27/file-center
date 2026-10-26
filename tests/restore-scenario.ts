/**
 * Child process of tests/security-1132-restore.test.ts (not a test itself): a restore freezes the stores of the
 * process that runs it, so the scenario runs in its own process and is checked in a second one (the restart).
 *   bun tests/restore-scenario.ts setup <recreate|control> <dir>   then   bun tests/restore-scenario.ts check <mode> <dir>
 * recreate: bob#1 is backed up and deleted, bob#2 (same name) gets sessions, app password, share, grant, group; then restore.
 * control: bob is never re-created; the same records exist when the backup is restored.
 * Prints one JSON line with what a client sees.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [phase, mode, base] = process.argv.slice(2) as [string, 'recreate' | 'control', string]
if (phase === 'setup') { rmSync(base, { recursive: true, force: true }); mkdirSync(base, { recursive: true }) }
process.env.STORAGE_DIR = join(base, 'storage')
process.env.DATA_DIR = join(base, 'data')
process.env.BACKUP_DIR = join(base, 'backups')
process.env.ADMIN_PASSWORD = 'scenario-admin-pass-1'
process.env.UPDATE_SOURCE = 'off'
process.env.WEBDAV = '1'
const { app } = await import('../src/index')

class Client {
  cookie = ''
  csrf = ''
  async j(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = {}
    if (this.cookie) headers.cookie = this.cookie
    if (this.csrf) headers['x-csrf-token'] = this.csrf
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await app.handle(new Request('http://localhost' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }))
    const set = res.headers.get('set-cookie')
    if (set) this.cookie = set.split(';')[0]
    return { status: res.status, data: (await res.json().catch(() => null)) as any }
  }
  async login(username: string, password: string) {
    this.csrf = (await this.j('GET', '/api/session')).data.csrf
    const r = await this.j('POST', '/api/login', { username, password })
    if (r.status === 200) this.csrf = r.data.csrf
    return r
  }
}

const PERMS = ['read', 'write', 'upload', 'download', 'batchdownload', 'zip', 'share']
const make = (a: Client, username: string, password: string) =>
  a.j('POST', '/api/admin/users', { username, name: username, password, role: 'user', homedir: `/users/${username}`, permissions: PERMS, publicPermissions: ['read'] })
const ADMIN = 'scenario-admin-pass-1'
const FIRST = 'First-Orchid-Pass-91'
const SECOND = 'Second-Quartz-Pass-47'
const CAROL = 'Maple-Drift-Walnut-5839'
const state = join(base, 'state.json')
const put = (rel: string, text: string) => {
  const p = join(process.env.STORAGE_DIR!, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

if (phase === 'setup') {
  const admin = new Client()
  await admin.login('admin', ADMIN)
  await make(admin, 'carol', CAROL)
  await make(admin, 'bob', FIRST)
  const given = await make(admin, 'dora', 'Granite-Drift-Walnut-7731')
  const { runBackup, restoreBackup } = await import('../src/backup')
  const backup = await runBackup()
  await sleep(30)
  if (mode === 'recreate') {
    await admin.j('DELETE', '/api/admin/users/bob')
    await sleep(30)
    await make(admin, 'bob', SECOND)
  }
  put('users/bob/shared.txt', 'BOB-FILE')
  put('users/bob/pub/p.txt', 'BOB-PUB')
  const bob = new Client()
  await bob.login('bob', mode === 'recreate' ? SECOND : FIRST)
  const ap = await bob.j('POST', '/api/me/app-passwords', { name: 'dav', scope: 'read', password: mode === 'recreate' ? SECOND : FIRST })
  const share = await bob.j('POST', '/api/shares', { space: 'home', path: '/shared.txt', days: 7 })
  const grant = await bob.j('POST', '/api/grants', { space: 'home', path: '/pub', to: 'carol', perms: 'view' })
  const group = await admin.j('POST', '/api/admin/groups', { name: 'team-x' })
  const member = await admin.j('PUT', `/api/admin/groups/${group.data.group.id}/members`, { username: 'bob', perms: 'edit' })
  // a grant bob RECEIVES, to see that grants in both directions go
  put('users/dora/d/d.txt', 'DORA')
  const dora = new Client()
  await dora.login('dora', 'Granite-Drift-Walnut-7731')
  const received = await dora.j('POST', '/api/grants', { space: 'home', path: '/d', to: 'bob', perms: 'view' })
  const statuses = { ap: ap.status, share: share.status, grant: grant.status, group: group.status, member: member.status, given: given.status, received: received.status }
  writeFileSync(state, JSON.stringify({ cookie: bob.cookie, csrf: bob.csrf, secret: ap.data.secret, token: share.data.token, statuses }))
  await restoreBackup(backup.name)
  console.log(JSON.stringify({ statuses }))
  process.exit(0)
}

const s = JSON.parse(readFileSync(state, 'utf8'))
const basic = 'Basic ' + Buffer.from('bob:' + s.secret).toString('base64')
const bob = new Client()
bob.cookie = s.cookie
bob.csrf = s.csrf
const session = await bob.j('GET', '/api/session')
const dav = await app.handle(new Request('http://localhost/dav/home/shared.txt', { headers: { authorization: basic } }))
const link = await app.handle(new Request(`http://localhost/api/s/${s.token}/download`))
const carol = new Client()
await carol.login('carol', CAROL)
const toMe = await carol.j('GET', '/api/grants/to-me')
const fresh = new Client()
const login = await fresh.login('bob', FIRST)
const mine = login.status === 200 ? await fresh.j('GET', '/api/groups/mine') : null
const myGrants = login.status === 200 ? await fresh.j('GET', '/api/grants/to-me') : null
console.log(JSON.stringify({
  sessionUser: session.data?.user?.username ?? null,
  dav: dav.status,
  share: link.status,
  carolSees: (toMe.data?.items ?? []).map((i: any) => i.owner),
  firstPasswordLogin: login.status,
  groups: (mine?.data?.items ?? []).map((g: any) => g.name),
  bobReceived: (myGrants?.data?.items ?? []).map((i: any) => i.owner),
}))
process.exit(0)
