import { Client, PW, mkUser, admin } from './h'
import { totpAt } from '../../src/totp'
export const stepNow = () => Math.floor(Date.now() / 30000)
export async function with2fa(app: any, name = 'bob') {
  const adm = await admin(app)
  const u = await mkUser(adm, name)
  const s = await u.req('POST', '/api/2fa/setup', { password: PW })
  if (s.status !== 200) throw new Error('setup ' + s.text)
  const en = await u.req('POST', '/api/2fa/enable', { code: totpAt(s.json.secret, stepNow()) })
  if (en.status !== 200) throw new Error('enable ' + en.status + en.text)
  return { adm, secret: s.json.secret as string, backup: en.json.backupCodes as string[], name }
}
export async function ticketFor(app: any, name: string, headers: Record<string, string> = {}) {
  const c = new Client(app, headers); await c.session()
  const r = await c.req('POST', '/api/login', { username: name, password: PW })
  if (!r.json?.ticket) throw new Error('no ticket ' + r.text)
  return { c, ticket: r.json.ticket as string }
}
