import { beforeAll, describe, expect, test } from 'bun:test'
// sets STORAGE_DIR, DATA_DIR, ADMIN_PASSWORD (test-admin-pass) and the other test settings
import './in-process-env'

// What the web framework does around the edges of a request that no route test asks for: HEAD, bodies of the wrong
// kind. They are answered the way the page and the monitors outside rely on.
let app: any
let cookie = ''
let csrf = ''

const call = (method: string, path: string, init: { body?: string; type?: string; auth?: boolean } = {}) => {
  const headers: Record<string, string> = {}
  if (init.auth !== false && cookie) headers.cookie = cookie
  if (init.type) headers['content-type'] = init.type
  if (method !== 'GET' && method !== 'HEAD' && csrf) headers['x-csrf-token'] = csrf
  return app.handle(new Request('http://localhost' + path, { method, headers, body: init.body })) as Promise<Response>
}

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  const first = await call('GET', '/api/session', { auth: false })
  csrf = (await first.json()).csrf
  cookie = first.headers.get('set-cookie')!.split(';')[0]
  const login = await call('POST', '/api/login', { type: 'application/json', body: JSON.stringify({ username: 'admin', password: 'test-admin-pass' }) })
  expect(login.status).toBe(200)
  cookie = login.headers.get('set-cookie')!.split(';')[0]
  csrf = (await login.json()).csrf
})

describe('HEAD', () => {
  test('a GET route answers HEAD with its status and headers (Bun leaves the body off the wire)', async () => {
    const get = await call('GET', '/api/health')
    const head = await call('HEAD', '/api/health')
    expect(head.status).toBe(200)
    expect(head.headers.get('cache-control')).toBe('no-store')
    expect(head.headers.get('x-content-type-options')).toBe('nosniff')
    expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'))
  })
  test('HEAD follows the same rules as GET: the page, a missing API route, a route that needs a session', async () => {
    expect((await call('HEAD', '/')).status).toBe(200)
    expect((await call('HEAD', '/api/nope')).status).toBe(404)
    expect((await call('HEAD', '/api/list?space=home&path=/')).status).toBe(200)
    expect((await call('HEAD', '/api/list?space=home&path=/', { auth: false })).status).toBe(401)
  })
})

describe('bodies that are not what the route takes', () => {
  const mkdir = (body: string | undefined, type?: string) => call('POST', '/api/mkdir', { body, type })
  const code = async (res: Response) => (await res.json()).code

  test('an empty body, or a body of another type, is an invalid request (422)', async () => {
    for (const res of [await mkdir(undefined, 'application/json'), await mkdir(undefined), await mkdir('hello', 'text/plain'), await mkdir('a=1', 'application/x-www-form-urlencoded')]) {
      expect(res.status).toBe(422)
      expect(await code(res)).toBe('request.invalid')
    }
  })
  test('JSON that does not parse is unreadable (400)', async () => {
    const res = await mkdir('{"space":', 'application/json')
    expect(res.status).toBe(400)
    expect(await code(res)).toBe('request.unreadable')
  })
  test('JSON of the wrong shape is an invalid request (422)', async () => {
    for (const body of ['null', '[]', '{"space":"home"}', '{"space":1,"path":"/","name":"x"}']) {
      const res = await mkdir(body, 'application/json')
      expect(res.status).toBe(422)
      expect(await code(res)).toBe('request.invalid')
    }
  })
})
