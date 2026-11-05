import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// sets STORAGE_DIR, DATA_DIR, ADMIN_PASSWORD (test-admin-pass)
import './in-process-env'

let app: any
beforeAll(async () => {
  ;({ app } = await import('../src/index'))
})

async function post(cookie: string, token?: string) {
  const headers: Record<string, string> = { cookie, 'content-type': 'application/json' }
  if (token !== undefined) headers['x-csrf-token'] = token
  const res: Response = await app.handle(new Request('http://localhost/api/mkdir', { method: 'POST', headers, body: JSON.stringify({ space: 'home', path: '/', name: 'csrf-cmp' }) }))
  return { status: res.status, data: await res.json().catch(() => null) }
}

describe('CSRF token compare', () => {
  test('right token passes; same-length wrong, other-length, empty and missing are refused', async () => {
    const s = await app.handle(new Request('http://localhost/api/session'))
    let cookie = s.headers.get('set-cookie')!.split(';')[0]
    const first = (await s.json()).csrf
    const login = await app.handle(new Request('http://localhost/api/login', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': first },
      body: JSON.stringify({ username: 'admin', password: 'test-admin-pass' }),
    }))
    expect(login.status).toBe(200)
    cookie = login.headers.get('set-cookie')?.split(';')[0] ?? cookie
    const { csrf } = await login.json()
    const flipped = (csrf[0] === 'a' ? 'b' : 'a') + csrf.slice(1)
    for (const bad of [flipped, csrf.slice(0, -1), csrf + 'x', '']) {
      const r = await post(cookie, bad)
      expect(`${r.status} ${r.data?.code}`).toBe('403 csrf')
    }
    expect((await post(cookie)).data?.code).toBe('csrf')
    expect((await post(cookie, csrf)).status).toBe(200)
  })
  test('the compare goes through timingSafeEqual', () => {
    const src = readFileSync(join(import.meta.dir, '../src/context.ts'), 'utf8')
    expect(src).toContain('timingSafeEqual')
    expect(src).not.toMatch(/token\s*!==\s*session\.csrf/)
  })
})
