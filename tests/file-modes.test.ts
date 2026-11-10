/**
 * What the app writes is private to its own account (FC_UMASK, default 077): state files, uploads and backups carry
 * no group/other bits, and the top-level DATA_DIR / BACKUP_DIR of an older install are tightened at start.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import './in-process-env'

const PASSWORD = process.env.ADMIN_PASSWORD!
const mode = (p: string) => statSync(p).mode & 0o777

let app: any
let cfg: typeof import('../src/config')
let cookie = ''
let csrf = ''
async function call(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers }
  if (cookie) h.cookie = cookie
  if (csrf) h['x-csrf-token'] = csrf
  const isJson = body !== undefined && !(body instanceof Uint8Array)
  if (isJson) h['content-type'] = 'application/json'
  const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: body === undefined ? undefined : isJson ? JSON.stringify(body) : body }))
  const set = res.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]
  return { status: res.status, data: (await res.json().catch(() => null)) as any }
}

describe('FC_UMASK', () => {
  beforeAll(async () => {
    ;({ app } = await import('../src/index'))
    cfg = await import('../src/config')
    const { backupRunning } = await import('../src/backup')
    while (backupRunning()) await Bun.sleep(50)
    csrf = (await call('GET', '/api/session')).data.csrf
    const r = await call('POST', '/api/login', { username: 'admin', password: PASSWORD })
    expect(r.status).toBe(200)
    csrf = r.data.csrf
  })

  test('parseUmask: three octal digits, anything else gives 077', () => {
    const { parseUmask } = cfg
    expect(parseUmask('077')).toEqual({ mask: 0o077, invalid: false })
    expect(parseUmask('027').mask).toBe(0o027)
    expect(parseUmask('022').mask).toBe(0o022)
    expect(parseUmask(undefined)).toEqual({ mask: 0o077, invalid: false })
    for (const bad of ['', '0999', 'abc', '77', '0077', '-1', '08']) expect(parseUmask(bad).mask).toBe(0o077)
    for (const bad of ['0999', 'abc', '77']) expect(parseUmask(bad).invalid).toBe(true)
    expect(parseUmask('').invalid).toBe(false)
  })

  test('the process umask is set before anything is written', () => {
    expect(process.umask()).toBe(cfg.umask)
    expect(cfg.umask & 0o077).toBe(0o077) // the test run uses the default
  })

  test('users.json and sessions.json carry no group or other bits', async () => {
    const c = await call('POST', '/api/admin/users', { username: 'modeuser', name: 'x', password: 'harbor-lamp-42', role: 'user', permissions: [], publicPermissions: [] })
    expect(c.status).toBe(200)
    const { JsonStore } = await import('../src/store')
    await JsonStore.flushAll()
    expect(mode(cfg.paths.users) & 0o077).toBe(0)
    expect(mode(cfg.paths.sessions) & 0o077).toBe(0)
  })

  test('an uploaded file is private', async () => {
    const bytes = new Uint8Array(100).fill(7)
    const a = await call('POST', '/api/upload', { space: 'home', path: '/', name: 'mode.bin', size: bytes.length })
    expect(a.status).toBe(200)
    expect((await call('PUT', `/api/upload/${a.data.id}/0`, bytes, { 'content-type': 'application/octet-stream' })).status).toBe(200)
    expect((await call('POST', `/api/upload/${a.data.id}/complete`)).status).toBe(200)
    const found: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name))
        else if (e.name === 'mode.bin') found.push(join(d, e.name))
      }
    }
    walk(cfg.config.storageDir)
    expect(found.length).toBe(1)
    expect(mode(found[0]) & 0o077).toBe(0)
  })

  test('a backup zip is private, and DATA_DIR / BACKUP_DIR of an older install are tightened', async () => {
    chmodSync(cfg.config.dataDir, 0o755)
    cfg.ensureDirs()
    expect(mode(cfg.config.dataDir)).toBe(0o700)

    chmodSync(cfg.config.backupDir, 0o755)
    const made = await call('POST', '/api/admin/backups')
    expect(made.status).toBe(200)
    expect(mode(cfg.config.backupDir)).toBe(0o700)
    expect(mode(join(cfg.config.backupDir, made.data.name)) & 0o077).toBe(0)
  })

  test('tightenDir leaves a folder that is already private alone and never throws', () => {
    expect(() => cfg.tightenDir(join(cfg.config.dataDir, 'does-not-exist'))).not.toThrow()
    chmodSync(cfg.config.dataDir, 0o700)
    cfg.tightenDir(cfg.config.dataDir)
    expect(mode(cfg.config.dataDir)).toBe(0o700)
  })
})
