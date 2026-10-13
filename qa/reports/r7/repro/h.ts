import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
export const PW = 'Zx9!kLm2#qWe7vB'
export async function boot(extraEnv: Record<string, string> = {}) {
  const base = mkdtempSync(join(tmpdir(), 'fcrepro-'))
  mkdirSync(join(base, 'storage')); mkdirSync(join(base, 'data'))
  process.env.STORAGE_DIR = join(base, 'storage')
  process.env.DATA_DIR = join(base, 'data')
  process.env.BACKUP_DIR = join(base, 'backups')
  process.env.ADMIN_PASSWORD = PW
  Object.assign(process.env, extraEnv)
  const { app } = await import('../../src/index')
  return { app, base, storage: join(base, 'storage'), data: join(base, 'data') }
}
export class Client {
  cookie = ''; csrf = ''
  constructor(public app: any, public headers: Record<string, string> = {}) {}
  private take(res: Response) {
    const sc = res.headers.getSetCookie?.() ?? []
    for (const c of sc) {
      const [kv] = c.split(';'); const [k, v] = kv.split('=')
      const jar = Object.fromEntries(this.cookie.split('; ').filter(Boolean).map(s => s.split('=') as [string, string]))
      jar[k] = v
      this.cookie = Object.entries(jar).map(([a, b]) => `${a}=${b}`).join('; ')
    }
  }
  async req(method: string, path: string, body?: any, extra: Record<string, string> = {}) {
    const h: Record<string, string> = { ...this.headers, ...extra }
    if (this.cookie) h.cookie = this.cookie
    if (this.csrf) h['x-csrf-token'] = this.csrf
    let b: any = undefined
    if (body !== undefined) {
      if (body instanceof Uint8Array || body instanceof ArrayBuffer) b = body
      else { b = JSON.stringify(body); h['content-type'] = 'application/json' }
    }
    const res = await this.app.handle(new Request('http://localhost' + path, { method, headers: h, body: b }))
    this.take(res)
    const text = await res.text()
    let json: any = null; try { json = JSON.parse(text) } catch {}
    return { status: res.status, json, text }
  }
  async session() { const r = await this.req('GET', '/api/session'); this.csrf = r.json.csrf; return r }
  async login(u: string, p: string) {
    await this.session()
    const r = await this.req('POST', '/api/login', { username: u, password: p })
    if (r.json?.csrf) this.csrf = r.json.csrf
    return r
  }
}
export async function admin(app: any) { const c = new Client(app); const r = await c.login('admin', PW); if (r.status !== 200) throw new Error('admin login ' + r.status + r.text); return c }
export async function mkUser(adm: Client, username: string, perms = ['read','write','upload','download','batchdownload','zip','share'], extra: any = {}) {
  const r = await adm.req('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', homedir: '/' + username, permissions: perms, publicPermissions: [], ...extra })
  if (r.status !== 200) throw new Error('mkUser ' + r.status + r.text)
  const c = new Client(adm.app); const l = await c.login(username, PW)
  if (l.status !== 200) throw new Error('user login ' + l.status + l.text)
  return c
}
export const sha = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex')
export const verdict = (present: boolean, msg: string): never => { console.log((present ? 'PRESENT: ' : 'SAFE: ') + msg); process.exit(present ? 42 : 0) }
