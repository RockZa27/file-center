/** The absolute lifetime of a signed-in session (SESSION_MAX_HOURS), checked on the server whatever the cookie says. */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import './in-process-env'

let auth: typeof import('../src/auth')
let config: typeof import('../src/config').config
let policy: typeof import('../src/policy')
const H = 3600_000
let ttl0 = 0
let max0 = 0

beforeAll(async () => {
  ;({ config } = await import('../src/config'))
  auth = await import('../src/auth')
  policy = await import('../src/policy')
  ttl0 = config.sessionTtlMs
  max0 = config.sessionMaxMs
})
afterEach(() => { config.sessionTtlMs = ttl0; config.sessionMaxMs = max0 })

const listed = (user: string) => auth.listUserSessions(user).length

describe('session absolute lifetime', () => {
  test('default is 30 days', () => { expect(max0).toBe(720 * H) })

  test('a session in constant use but older than the limit is gone; a younger one works', () => {
    config.sessionMaxMs = 100 * H
    config.sessionTtlMs = 10 * H // below the limit, so the limit is what counts
    const old = auth.createSession('smax-a')
    const young = auth.createSession('smax-a')
    old.session.created = Date.now() - 101 * H
    old.session.seen = Date.now() // used a moment ago: the idle rule alone would keep it
    young.session.created = Date.now() - 99 * H
    young.session.seen = Date.now()
    expect(auth.getSession(old.sid)).toBeNull()
    expect(auth.getSession(young.sid)?.username).toBe('smax-a')
    expect(listed('smax-a')).toBe(1)
    expect(auth.getSession(old.sid)).toBeNull() // and stays gone
  })

  test('the idle TTL wins when it is longer than SESSION_MAX_HOURS', () => {
    config.sessionMaxMs = 10 * H
    config.sessionTtlMs = 50 * H
    expect(policy.sessionMaxMs()).toBe(50 * H)
    const s = auth.createSession('smax-b')
    s.session.created = Date.now() - 40 * H
    expect(auth.getSession(s.sid)).not.toBeNull()
    s.session.created = Date.now() - 51 * H
    s.session.seen = Date.now()
    expect(auth.getSession(s.sid)).toBeNull()
  })

  test('a signed-in session without a numeric created fails closed', () => {
    const s = auth.createSession('smax-c')
    delete (s.session as any).created
    expect(auth.getSession(s.sid)).toBeNull()
    const t = auth.createSession('smax-c')
    ;(t.session as any).created = 'yesterday'
    expect(auth.getSession(t.sid)).toBeNull()
  })

  test('purgeExpiredSessions drops absolutely-expired sessions from the store and the device list', () => {
    config.sessionMaxMs = 100 * H
    config.sessionTtlMs = 10 * H // below the limit, so the limit is what counts
    const old = auth.createSession('smax-d')
    const young = auth.createSession('smax-d')
    old.session.created = Date.now() - 101 * H
    expect(listed('smax-d')).toBe(2)
    auth.purgeExpiredSessions()
    expect(listed('smax-d')).toBe(1)
    expect(auth.getSession(young.sid)).not.toBeNull()
  })

  test('visitor sessions keep their own rules', () => {
    config.sessionMaxMs = 1 * H
    config.sessionTtlMs = 1 * H
    const v = auth.createSession(null)
    v.session.created = Date.now() - 5 * H
    expect(auth.getSession(v.sid)).not.toBeNull()
  })
})
