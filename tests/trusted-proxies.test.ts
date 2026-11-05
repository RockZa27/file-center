/**
 * TRUSTED_PROXIES: the client-IP headers (CF-Connecting-IP, X-Forwarded-For/-Host/-Proto) are believed only from the
 * proxy's own address. The matcher is tested alone, `clientIp` with a socket address given, and the lockouts and the WebDAV
 * Destination over a real connection from 127.0.0.1 (app.handle() has no socket, its address is 'unknown').
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import './in-process-env'
import { ipInRules, parseIpList, parseIpRule } from '../src/config'

const inList = (ip: string, list: string) => ipInRules(ip, parseIpList(list).rules)

describe('TRUSTED_PROXIES matcher', () => {
  test('IPv4 addresses and ranges', () => {
    expect(inList('127.0.0.1', '127.0.0.1')).toBe(true)
    expect(inList('127.0.0.2', '127.0.0.1')).toBe(false)
    expect(inList('172.18.0.3', '172.16.0.0/12')).toBe(true)
    expect(inList('172.31.255.255', '172.16.0.0/12')).toBe(true)
    expect(inList('172.32.0.1', '172.16.0.0/12')).toBe(false)
    expect(inList('172.15.255.255', '172.16.0.0/12')).toBe(false)
    expect(inList('8.8.8.8', '10.0.0.0/8, 127.0.0.1, 192.168.0.0/16')).toBe(false)
    expect(inList('192.168.5.5', '10.0.0.0/8, 127.0.0.1, 192.168.0.0/16')).toBe(true)
  })
  test('IPv6 addresses and ranges', () => {
    expect(inList('::1', '::1')).toBe(true)
    expect(inList('::2', '::1')).toBe(false)
    expect(inList('fd00::5', 'fd00::/8')).toBe(true)
    expect(inList('fe80::5', 'fd00::/8')).toBe(false)
    expect(inList('2001:db8:0:1::7', '2001:db8::/32')).toBe(true)
    expect(inList('2001:db9::1', '2001:db8::/32')).toBe(false)
    expect(inList('2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1')).toBe(true)
  })
  test('an IPv4-mapped IPv6 address matches an IPv4 range, and is the same address as the IPv4 one', () => {
    expect(inList('::ffff:172.18.0.3', '172.16.0.0/12')).toBe(true)
    expect(inList('::ffff:ac12:3', '172.16.0.0/12')).toBe(true)
    expect(inList('::ffff:8.8.8.8', '172.16.0.0/12')).toBe(false)
    expect(inList('::ffff:127.0.0.1', '127.0.0.1')).toBe(true)
    expect(inList('127.0.0.1', '::ffff:127.0.0.1')).toBe(true)
    expect(inList('::ffff:10.1.2.3', '::ffff:10.0.0.0/104')).toBe(true)
    // an IPv4 address is not inside an IPv6 range, nor the other way round
    expect(inList('10.0.0.1', 'fd00::/8')).toBe(false)
    expect(inList('fd00::1', '10.0.0.0/8')).toBe(false)
  })
  test('prefix edge cases', () => {
    expect(inList('203.0.113.9', '0.0.0.0/0')).toBe(true)
    expect(inList('2001:db8::1', '::/0')).toBe(true)
    expect(inList('203.0.113.9', '203.0.113.9/32')).toBe(true)
    expect(inList('203.0.113.10', '203.0.113.9/32')).toBe(false)
    expect(inList('::1', '::1/128')).toBe(true)
    expect(inList('::2', '::1/128')).toBe(false)
    expect(parseIpRule('1.2.3.4/33')).toBeNull()
    expect(parseIpRule('::1/129')).toBeNull()
    expect(parseIpRule('1.2.3.4/-1')).toBeNull()
    expect(parseIpRule('1.2.3.4/8/8')).toBeNull()
  })
  test('junk entries are reported and never match', () => {
    const { rules, invalid } = parseIpList(' 127.0.0.1 ,, nope, 10.0.0.0/x, 300.1.1.1, 1.2.3, ::g, 172.16.0.0/12 ')
    expect(rules.length).toBe(2)
    expect(invalid).toEqual(['nope', '10.0.0.0/x', '300.1.1.1', '1.2.3', '::g'])
    expect(parseIpList('').rules).toEqual([])
    expect(inList('unknown', '0.0.0.0/0')).toBe(false)
    expect(inList('', '::/0')).toBe(false)
  })
})

describe('TRUSTED_PROXIES: who is believed', () => {
  const req = (h: Record<string, string>) => new Request('http://localhost/x', { headers: h })
  const h = { 'cf-connecting-ip': '203.0.113.5', 'x-forwarded-for': '10.9.9.9, 198.51.100.7' }
  let config: typeof import('../src/config').config
  let clientIp: typeof import('../src/context').clientIp
  let proxyTrusted: typeof import('../src/config').proxyTrusted
  const set = (mode: 'false' | 'true' | 'cloudflare', list: string) => {
    config.trustProxy = mode
    config.trustedProxies = parseIpList(list).rules
  }
  beforeAll(async () => {
    ;({ config, proxyTrusted } = await import('../src/config'))
    ;({ clientIp } = await import('../src/context'))
  })
  afterAll(() => set('false', ''))

  test('a socket in the list is believed, one outside it is not', () => {
    set('cloudflare', '127.0.0.1,172.16.0.0/12')
    expect(clientIp(req(h), '127.0.0.1')).toBe('203.0.113.5')
    expect(clientIp(req(h), '::ffff:172.18.0.3')).toBe('203.0.113.5')
    expect(clientIp(req(h), '192.168.1.50')).toBe('192.168.1.50')
    expect(clientIp(req(h), 'unknown')).toBe('unknown')
    set('true', '127.0.0.1,172.16.0.0/12')
    expect(clientIp(req(h), '172.18.0.3')).toBe('198.51.100.7')
    expect(clientIp(req(h), '192.168.1.50')).toBe('192.168.1.50')
  })
  test('an empty list believes every socket, as before', () => {
    set('cloudflare', '')
    expect(clientIp(req(h), '192.168.1.50')).toBe('203.0.113.5')
    set('true', ' , ,')
    expect(clientIp(req(h), 'unknown')).toBe('198.51.100.7')
    expect(proxyTrusted('192.168.1.50')).toBe(true)
  })
  test('without TRUST_PROXY nobody is believed, list or not', () => {
    set('false', '127.0.0.1')
    expect(clientIp(req(h), '127.0.0.1')).toBe('127.0.0.1')
    expect(proxyTrusted('127.0.0.1')).toBe(false)
  })
  test('a trusted socket without the header gets its own address', () => {
    set('cloudflare', '127.0.0.1')
    expect(clientIp(req({}), '127.0.0.1')).toBe('127.0.0.1')
  })
})

describe('TRUSTED_PROXIES over a real connection', () => {
  let app: any
  let config: typeof import('../src/config').config
  let base = ''
  let adminSecret = ''
  const set = (mode: 'false' | 'true', list: string) => {
    config.trustProxy = mode
    config.trustedProxies = parseIpList(list).rules
  }
  const failLogin = async (username: string, xff: string) => {
    const s = await fetch(`${base}/api/session`)
    const csrf = ((await s.json()) as any).csrf
    const cookie = s.headers.get('set-cookie')!.split(';')[0]
    const r = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, cookie, 'x-forwarded-for': xff },
      body: JSON.stringify({ username, password: 'wrong-pass' }),
    })
    return r.status
  }
  const move = (to: string, host: string) => {
    const name = `Basic ${Buffer.from(`admin:${adminSecret}`).toString('base64')}`
    return fetch(`${base}/dav/home/tp-a.txt`, { method: 'MOVE', headers: { authorization: name, destination: to, 'x-forwarded-host': host } })
  }

  beforeAll(async () => {
    ;({ app } = await import('../src/index'))
    ;({ config } = await import('../src/config'))
    app.listen({ port: 0, hostname: '127.0.0.1' })
    base = `http://127.0.0.1:${app.server.port}`
    const s = await fetch(`${base}/api/session`)
    let csrf = ((await s.json()) as any).csrf
    const cookie = s.headers.get('set-cookie')!.split(';')[0]
    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, cookie },
      body: JSON.stringify({ username: 'admin', password: process.env.ADMIN_PASSWORD }),
    })
    expect(login.status).toBe(200)
    csrf = ((await login.json()) as any).csrf
    const made = await fetch(`${base}/api/me/app-passwords`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, cookie: login.headers.get('set-cookie')!.split(';')[0] ?? cookie },
      body: JSON.stringify({ name: 'tp', scope: 'readwrite', password: process.env.ADMIN_PASSWORD }),
    })
    expect(made.status).toBe(200)
    adminSecret = ((await made.json()) as any).secret
  })
  afterAll(async () => {
    set('false', '')
    await app.stop()
  })

  test('from a socket outside the list a changing X-Forwarded-For does not dodge the login lockout', async () => {
    set('true', '10.0.0.0/8') // the test connects from 127.0.0.1: not a trusted proxy
    for (let i = 0; i < 3; i++) expect(await failLogin('tp-ghost1', `10.0.0.${i}, 198.51.100.${i}`)).toBe(401)
    expect(await failLogin('tp-ghost1', '10.0.0.99, 198.51.100.99')).toBe(429)
  })
  test('from a trusted socket the forwarded address counts (each client has its own lockout)', async () => {
    set('true', '127.0.0.1')
    for (let i = 0; i < 3; i++) expect(await failLogin('tp-ghost2', `10.0.0.1, 198.51.100.1`)).toBe(401)
    expect(await failLogin('tp-ghost2', '10.0.0.1, 198.51.100.77')).toBe(401) // another client address
    expect(await failLogin('tp-ghost2', '10.0.0.1, 198.51.100.1')).toBe(429) // the same address again
  })
  test('with the list empty the header is believed from any socket, as before', async () => {
    set('true', '')
    for (let i = 0; i < 3; i++) expect(await failLogin('tp-ghost3', '198.51.100.1')).toBe(401)
    expect(await failLogin('tp-ghost3', '198.51.100.50')).toBe(401)
    expect(await failLogin('tp-ghost3', '198.51.100.1')).toBe(429)
  })

  test('the WebDAV Destination takes X-Forwarded-Host only from a trusted socket', async () => {
    set('false', '')
    expect((await fetch(`${base}/dav/home/tp-a.txt`, {
      method: 'PUT', body: 'x', headers: { authorization: `Basic ${Buffer.from(`admin:${adminSecret}`).toString('base64')}` },
    })).status).toBe(201)
    const to = 'http://files.example.org/dav/home/tp-b.txt'
    set('true', '10.0.0.0/8')
    const refused = await move(to, 'files.example.org')
    expect(refused.status).toBe(502)
    expect(await refused.text()).toContain('เซิร์ฟเวอร์')
    set('true', '127.0.0.1')
    expect((await move(to, 'files.example.org')).status).toBe(201)
  })
})

describe('TRUSTED_PROXIES: config warnings', () => {
  test('TRUST_PROXY without TRUSTED_PROXIES is warned about; with it, or without TRUST_PROXY, it is not', async () => {
    const { config } = await import('../src/config')
    const { envWarnings } = await import('../src/config-warnings')
    const has = () => envWarnings().some(w => w.code === 'admin.config-proxy-open')
    try {
      config.trustProxy = 'cloudflare'
      config.trustedProxies = []
      expect(has()).toBe(true)
      expect(envWarnings().find(w => w.code === 'admin.config-proxy-open')?.severity).toBe('warning')
      config.trustedProxies = parseIpList('172.16.0.0/12').rules
      expect(has()).toBe(false)
      config.trustProxy = 'false'
      config.trustedProxies = []
      expect(has()).toBe(false)
    } finally {
      config.trustProxy = 'false'
      config.trustedProxies = []
    }
  })
  test('X-Forwarded-Proto counts only from a trusted socket', async () => {
    const { config } = await import('../src/config')
    const { configWarnings } = await import('../src/config-warnings')
    const insecure = (socket: string) => configWarnings(new Request('http://localhost/x', { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '1.2.3.4' } }), socket)
      .some(w => w.code === 'admin.config-insecure-cookie')
    const saved = config.secureCookie
    try {
      config.secureCookie = false
      config.trustProxy = 'true'
      config.trustedProxies = parseIpList('127.0.0.1').rules
      expect(insecure('127.0.0.1')).toBe(true)
      expect(insecure('192.168.1.9')).toBe(false)
    } finally {
      config.secureCookie = saved
      config.trustProxy = 'false'
      config.trustedProxies = []
    }
  })
})
