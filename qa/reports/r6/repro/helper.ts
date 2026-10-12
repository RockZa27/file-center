import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'

export const ADMIN_PASSWORD = 'adminPW-correct-123456'

/** Set required env BEFORE importing the app. Call optional extra to add OFFICE_* etc. */
export function prepEnv(extra: Record<string, string> = {}) {
  const base = mkdtempSync(join(tmpdir(), 'fc-repro-'))
  process.env.STORAGE_DIR = join(base, 'storage')
  process.env.DATA_DIR = join(base, 'data')
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD
  process.env.FC_SUPERVISED = process.env.FC_SUPERVISED ?? '0'
  for (const [k, v] of Object.entries(extra)) process.env[k] = v
  return base
}

export async function importApp() {
  const mod = await import('../../src/index')
  return mod.app as { handle: (r: Request) => Promise<Response> }
}

function cookieFrom(res: Response): string {
  const sc = res.headers.get('set-cookie') ?? ''
  const m = /fc_sid=([^;]+)/.exec(sc)
  if (!m) throw new Error('no fc_sid cookie in response')
  return `fc_sid=${m[1]}`
}

export type Sess = { cookie: string; csrf: string }

export async function anonSession(app: { handle: (r: Request) => Promise<Response> }): Promise<Sess> {
  const res = await app.handle(new Request('http://localhost/api/session'))
  const body = await res.json()
  return { cookie: cookieFrom(res), csrf: body.csrf }
}

export async function login(app: { handle: (r: Request) => Promise<Response> }, username: string, password: string): Promise<Sess> {
  const anon = await anonSession(app)
  const res = await app.handle(new Request('http://localhost/api/login', {
    method: 'POST',
    headers: { cookie: anon.cookie, 'x-csrf-token': anon.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }))
  if (res.status !== 200) throw new Error(`login failed ${res.status}: ${await res.text()}`)
  const body = await res.json()
  return { cookie: cookieFrom(res), csrf: body.csrf }
}

export async function loginAdmin(app: { handle: (r: Request) => Promise<Response> }): Promise<Sess> {
  return login(app, 'admin', ADMIN_PASSWORD)
}

export async function createUser(app: { handle: (r: Request) => Promise<Response> }, admin: Sess, u: Record<string, unknown>) {
  const res = await app.handle(new Request('http://localhost/api/admin/users', {
    method: 'POST',
    headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'application/json' },
    body: JSON.stringify(u),
  }))
  if (res.status !== 200) throw new Error(`createUser failed ${res.status}: ${await res.text()}`)
  return res.json()
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url')
/** HS256 JWT exactly like ONLYOFFICE uses */
export function signJwt(payload: object, secret: string): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  const mac = createHmac('sha256', secret).update(`${head}.${body}`).digest()
  return `${head}.${body}.${b64url(mac)}`
}
