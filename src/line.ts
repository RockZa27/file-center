/**
 * LINE notifications through the Messaging API (LINE Notify is discontinued). On while LINE_CHANNEL_TOKEN is set.
 *
 * Linking: the user asks for a 6-digit code (valid 10 minutes), sends it to the bot, and LINE calls our webhook
 * (POST /api/line/webhook, signed with LINE_CHANNEL_SECRET) with the sender's userId; that id is then tied to the account.
 * Push messages go to the LINE API at a fixed address; no host comes from a user or a request. LINE_API_BASE exists only
 * so tests can point it at a stand-in on this machine: anything but http(s) to 127.0.0.1, localhost or [::1] is ignored.
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import { config } from './config'

export class LineError extends Error {
  constructor(message: string, public permanent: boolean) {
    super(message)
    this.name = 'LineError'
  }
}

export const LINE_API = 'https://api.line.me'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
export const LINK_CODE_TTL_MS = 10 * 60_000
/** wrong codes from one LINE account before it is ignored for LINK_CODE_TTL_MS (a code has 10^6 values) */
const MAX_WRONG_CODES = 5
export const LINE_TIMING = { sendTimeoutMs: 10_000 }

/** the API address: LINE's, unless LINE_API_BASE names a stand-in on this machine */
export function lineBase(): string {
  const v = config.lineApiBase
  if (v) {
    try {
      const u = new URL(v)
      if ((u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname)) return u.origin
    } catch { /* ignored below */ }
  }
  return LINE_API
}

export const lineEnabled = () => config.lineChannelToken !== ''
/** the webhook can only be trusted with a secret to check the signature against */
export const lineWebhookEnabled = () => config.lineChannelSecret !== ''

/** X-Line-Signature: base64 of HMAC-SHA256(channel secret, raw body) */
export function validSignature(body: Uint8Array, signature: string | null | undefined): boolean {
  if (!config.lineChannelSecret || !signature) return false
  const want = createHmac('sha256', config.lineChannelSecret).update(body).digest()
  const got = Buffer.from(signature, 'base64')
  return got.length === want.length && timingSafeEqual(got, want)
}

async function post(path: string, body: unknown): Promise<void> {
  const abort = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; abort.abort() }, LINE_TIMING.sendTimeoutMs)
  try {
    const res = await fetch(`${lineBase()}${path}`, {
      method: 'POST', redirect: 'error', signal: abort.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.lineChannelToken}` },
      body: JSON.stringify(body),
    })
    void res.body?.cancel().catch(() => {})
    // 429 and 5xx may pass; any other answer (bad token, bad id) will not change by asking again
    if (!res.ok) throw new LineError(`LINE answered ${res.status}`, res.status < 500 && res.status !== 429)
  } catch (e) {
    if (e instanceof LineError) throw e
    throw new LineError(timedOut ? 'LINE did not answer in time' : 'LINE could not be reached', false)
  } finally {
    clearTimeout(timer)
  }
}

const cut = (text: string) => text.slice(0, 4800)

/** push a text to a user id or a group id */
export async function linePush(to: string, text: string): Promise<void> {
  if (!lineEnabled()) throw new LineError('LINE is off', true)
  await post('/v2/bot/message/push', { to, messages: [{ type: 'text', text: cut(text) }] })
}

/** answer a message the bot got (free, and needs no linked account) */
export async function lineReply(replyToken: string, text: string): Promise<void> {
  if (!lineEnabled()) return
  await post('/v2/bot/message/reply', { replyToken, messages: [{ type: 'text', text: cut(text) }] })
}

// ───────────── link codes (memory only: a restart makes the user ask again) ─────────────

const codes = new Map<string, { username: string; expires: number }>()
const wrong = new Map<string, { count: number; until: number }>()

/** a new code for the user; an earlier one of theirs stops working */
export function issueLinkCode(username: string, now = Date.now()): { code: string; expiresAt: string } {
  for (const [c, v] of codes) if (v.expires <= now || v.username === username) codes.delete(c)
  let code: string
  do code = String(randomInt(0, 1_000_000)).padStart(6, '0'); while (codes.has(code))
  const expires = now + LINK_CODE_TTL_MS
  codes.set(code, { username, expires })
  return { code, expiresAt: new Date(expires).toISOString() }
}

/** the username a code belongs to (the code is used up), null for a wrong or expired one; 'locked' after too many wrong ones */
export function redeemLinkCode(code: string, lineUserId: string, now = Date.now()): string | null | 'locked' {
  const w = wrong.get(lineUserId)
  if (w && w.until > now && w.count >= MAX_WRONG_CODES) return 'locked'
  const hit = codes.get(code)
  if (hit && hit.expires > now) {
    codes.delete(code)
    wrong.delete(lineUserId)
    return hit.username
  }
  const count = w && w.until > now ? w.count + 1 : 1
  wrong.set(lineUserId, { count, until: now + LINK_CODE_TTL_MS })
  if (wrong.size > 10_000) for (const [k, v] of wrong) if (v.until <= now) wrong.delete(k)
  return null
}

/** forget every code (tests) */
export function resetLineCodes() {
  codes.clear()
  wrong.clear()
}
