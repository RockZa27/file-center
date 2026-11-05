import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// sets STORAGE_DIR, DATA_DIR, ADMIN_PASSWORD (test-admin-pass)
import './in-process-env'

/**
 * The hooks in context.ts and index.ts are `global`: they must reach the routes of every other plugin. These tests
 * pin that down for routes outside context.ts, and keep the legacy `{ as: ... }` option (deprecated in Elysia 2) out.
 */
let app: any
beforeAll(async () => {
  ;({ app } = await import('../src/index'))
})

const srcDir = join(import.meta.dir, '..', 'src')
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') ? [p] : []
  })
}

async function call(cookie: string, csrf: string | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { cookie, 'content-type': 'application/json' }
  if (csrf) headers['x-csrf-token'] = csrf
  const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }))
  return { status: res.status, data: await res.json().catch(() => null) }
}

async function loginAs(username: string, password: string) {
  const s = await app.handle(new Request('http://localhost/api/session'))
  let cookie = s.headers.get('set-cookie')!.split(';')[0]
  const first = (await s.json()).csrf
  const r: Response = await app.handle(new Request('http://localhost/api/login', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': first }, body: JSON.stringify({ username, password }),
  }))
  expect(r.status).toBe(200)
  cookie = r.headers.get('set-cookie')?.split(';')[0] ?? cookie
  return { cookie, csrf: (await r.json()).csrf as string }
}

describe('hook scope', () => {
  test('no legacy { as: ... } hook option is left in src/', () => {
    const left = sources(srcDir).filter(f => /\{\s*as\s*:/.test(readFileSync(f, 'utf8')))
    expect(left).toEqual([])
  })

  test('the CSRF check reaches routes of other plugins', async () => {
    const a = await loginAs('admin', 'test-admin-pass')
    const routes: [string, string, unknown][] = [
      ['POST', '/api/mkdir', { space: 'home', path: '/', name: 'hs-dir' }], // routes/files.ts
      ['POST', '/api/shares', { space: 'home', path: '/x.txt', days: 7 }], // routes/shares.ts
      ['POST', '/api/admin/groups', { name: 'hs group' }], // routes/groups.ts
      ['PUT', '/api/me/email', { address: 'hs@example.com' }], // routes/me.ts
      ['POST', '/api/admin/backups'], // routes/backup.ts
    ]
    for (const [method, path, body] of routes) {
      const r = await call(a.cookie, null, method, path, body)
      expect(`${method} ${path} ${r.status} ${r.data?.code}`).toBe(`${method} ${path} 403 csrf`)
    }
    // and with the token the request gets past the check
    expect((await call(a.cookie, a.csrf, 'POST', '/api/mkdir', { space: 'home', path: '/', name: 'hs-dir' })).status).toBe(200)
  })

  test('the must-change-password gate and the derive reach routes of other plugins', async () => {
    const a = await loginAs('admin', 'test-admin-pass')
    const made = await call(a.cookie, a.csrf, 'POST', '/api/admin/users', {
      username: 'hs-must', name: 'hs', password: 'harbor-lamp-42', role: 'user', permissions: ['read', 'write'], publicPermissions: [],
    })
    expect(made.status).toBe(200)
    const { findUser } = await import('../src/auth')
    findUser('hs-must')!.mustChangePassword = true
    const u = await loginAs('hs-must', 'harbor-lamp-42')
    for (const [method, path, body] of [
      ['GET', '/api/list?space=home&path=/', undefined], // routes/files.ts
      ['POST', '/api/mkdir', { space: 'home', path: '/', name: 'hs-x' }],
      ['GET', '/api/admin/groups', undefined], // routes/groups.ts
    ] as [string, string, unknown][]) {
      const r = await call(u.cookie, u.csrf, method, path, body)
      expect(`${method} ${path} ${r.status} ${r.data?.code}`).toBe(`${method} ${path} 403 must-change-password`)
    }
    // the derive resolved the user: the same admin-only route answers an admin
    expect((await call(a.cookie, a.csrf, 'GET', '/api/admin/groups')).status).toBe(200)
  })

  test('errors thrown in other plugins come back in the uniform JSON shape', async () => {
    const a = await loginAs('admin', 'test-admin-pass')
    const missing = await call(a.cookie, a.csrf, 'GET', '/api/list?space=home&path=/hs-no-such-folder')
    expect(missing.status).toBe(404)
    expect(Object.keys(missing.data).sort()).toEqual(['code', 'error', 'params'])
    expect(typeof missing.data.error).toBe('string')
    const invalid = await call(a.cookie, a.csrf, 'POST', '/api/mkdir', { space: 1 })
    expect(invalid.status).toBe(422)
    expect(invalid.data.code).toBe('request.invalid')
    expect(Object.keys(invalid.data).sort()).toEqual(['code', 'error', 'params'])
    const anon = await app.handle(new Request('http://localhost/api/admin/groups'))
    expect(anon.status).toBe(401)
    expect(Object.keys(await anon.json()).sort()).toEqual(['code', 'error', 'params'])
  })

  test('importing the app prints no deprecation warning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-scope-'))
    try {
      const proc = Bun.spawn([process.execPath, '-e', `await import(${JSON.stringify(join(srcDir, 'index.ts'))}); process.exit(0)`], {
        env: { ...process.env, DATA_DIR: join(dir, 'data'), STORAGE_DIR: join(dir, 'storage'), BACKUP_DIR: join(dir, 'backups'), ADMIN_PASSWORD: 'test-admin-pass' },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      expect(out + err).not.toContain('is deprecated')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
