/**
 * A small SMTP client for notification e-mail (SMTP_HOST set = on). No library: EHLO, STARTTLS or implicit TLS,
 * AUTH PLAIN / LOGIN, MAIL / RCPT / DATA, over Bun's own sockets. One message per connection, which is plenty for notices.
 *
 * What it takes care of: an address or a subject with CR or LF is refused (that is how a header gets injected), a Thai
 * subject goes out as RFC 2047 UTF-8 "B" words, the body is UTF-8 in base64, lines of DATA are dot-stuffed and end with
 * CRLF. The password is only sent over TLS (or to this machine), is never put in an error, and the certificate of the
 * server is checked. A 4xx answer is "try again later" (`permanent` false), a 5xx answer is final.
 */
import { createHash, randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { config } from './config'

export class MailError extends Error {
  /** true = the server said no for good (5xx, a bad address): sending again changes nothing */
  constructor(message: string, public permanent: boolean) {
    super(message)
    this.name = 'MailError'
  }
}

export type SmtpSettings = {
  host: string; port: number; secure: 'starttls' | 'tls' | 'none'; user: string; pass: string; from: string
  /** extra options for the TLS handshake (tests trust their own certificate here); the default checks the server as usual */
  tls?: { ca?: string | string[]; serverName?: string }
}

/** waits, in ms; tests make them shorter */
export const MAIL_TIMING = { connectMs: 15_000, replyMs: 30_000 }

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

/** the address, trimmed and checked; anything with a control character, space, angle bracket or quote is refused */
export function cleanAddress(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const a = input.trim()
  return a.length <= 254 && ADDRESS.test(a) ? a : null
}

/** "a@b.c" or "Name <a@b.c>" */
export function parseFrom(input: string): { name: string; address: string } | null {
  const m = /^(?:(.*?)\s*<([^<>]*)>|([^<>\s]+))$/.exec(input.trim())
  if (!m) return null
  const address = cleanAddress(m[2] ?? m[3])
  const name = (m[1] ?? '').trim().replace(/^"(.*)"$/, '$1')
  // no control characters or quotes in a name: it goes into a header
  if (!address || /[\x00-\x1f\x7f"\\]/.test(name) || name.length > 100) return null
  return { name, address }
}

/** the SMTP_* settings, checked once per value; `error` says why e-mail is off (startup log, never the password) */
let parsed: { key: string; settings: SmtpSettings | null; error: string | null } | undefined
export function smtpConfig(): { enabled: boolean; error: string | null; settings: SmtpSettings | null } {
  const c = config
  const key = [c.smtpHost, c.smtpPort, c.smtpSecure, c.smtpUser, c.smtpPass, c.smtpFrom, c.publicUrl].join('\n')
  if (parsed?.key !== key) {
    parsed = { key, settings: null, error: null }
    if (c.smtpHost) {
      const secure = c.smtpSecure as SmtpSettings['secure']
      const from = c.smtpFrom || (cleanAddress(c.smtpUser) ?? '')
      if (!/^[A-Za-z0-9.:\[\]-]+$/.test(c.smtpHost)) parsed.error = 'SMTP_HOST ไม่ถูกต้อง'
      else if (!Number.isInteger(c.smtpPort) || c.smtpPort < 1 || c.smtpPort > 65535) parsed.error = 'SMTP_PORT ต้องเป็นเลข 1-65535'
      else if (!['starttls', 'tls', 'none'].includes(secure)) parsed.error = 'SMTP_SECURE ต้องเป็น starttls, tls หรือ none'
      else if (!!c.smtpUser !== !!c.smtpPass) parsed.error = 'ต้องตั้ง SMTP_USER และ SMTP_PASS คู่กัน'
      else if (secure === 'none' && c.smtpUser && !LOOPBACK.has(c.smtpHost.toLowerCase())) parsed.error = 'SMTP_SECURE=none ส่งรหัสผ่านโดยไม่เข้ารหัส ใช้ได้เฉพาะ SMTP_HOST ที่เป็นเครื่องนี้'
      else if (!parseFrom(from)) parsed.error = 'ต้องตั้ง SMTP_FROM เป็นอีเมล เช่น files@example.com หรือ File Center <files@example.com>'
      else if (!publicBase()) parsed.error = 'ต้องตั้ง PUBLIC_URL (เช่น https://files.example.com) เพื่อสร้างลิงก์ยืนยันอีเมล'
      else parsed.settings = { host: c.smtpHost, port: c.smtpPort, secure, user: c.smtpUser, pass: c.smtpPass, from }
    }
  }
  return { enabled: parsed.settings !== null, error: parsed.error, settings: parsed.settings }
}

/** PUBLIC_URL without a trailing slash, or null when it is not an http(s) address */
export function publicBase(): string | null {
  if (!config.publicUrl) return null
  try {
    const u = new URL(config.publicUrl)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

// ───────────── the message ─────────────

/** the text as one line: control characters become spaces (a file name may hold a newline) */
export const oneLine = (s: string) => s.replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()

/** a header value in ASCII: as it is when it is plain, else RFC 2047 "B" words of at most 45 bytes (never half a character) */
export function encodeHeader(value: string): string {
  if (/[\r\n]/.test(value)) throw new MailError('header has a line break', true)
  if (/^[\x20-\x7e]*$/.test(value) && value.length <= 70) return value
  const words: string[] = []
  let cur = ''
  for (const ch of value) {
    if (Buffer.byteLength(cur + ch) > 45) { words.push(cur); cur = '' }
    cur += ch
  }
  if (cur) words.push(cur)
  return words.map(w => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ')
}

/** every line that starts with a dot gets a second one (RFC 5321 4.5.2) */
export function dotStuff(data: string): string {
  return data.split('\r\n').map(l => (l.startsWith('.') ? `.${l}` : l)).join('\r\n')
}

export function buildMessage(m: { from: { name: string; address: string }; to: string; subject: string; text: string; date?: Date }): string {
  const to = cleanAddress(m.to)
  if (!to) throw new MailError('bad recipient', true)
  if (/[\r\n]/.test(m.subject)) throw new MailError('subject has a line break', true)
  const fromName = m.from.name ? (/^[\x20-\x7e]*$/.test(m.from.name) ? `"${m.from.name}"` : encodeHeader(m.from.name)) : ''
  const body = Buffer.from(m.text.replace(/\r\n|\r|\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n')
  const domain = m.from.address.split('@')[1]
  return [
    `From: ${fromName ? `${fromName} ` : ''}<${m.from.address}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${(m.date ?? new Date()).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
    '',
    body,
  ].join('\r\n')
}

// ───────────── the conversation ─────────────

type Reply = { code: number; lines: string[] }

/** the bytes the server sent, cut into replies; a failed socket answers whoever is waiting */
class Conn {
  private buf = ''
  private failure: MailError | null = null
  private wake: (() => void) | null = null
  upgraded = false
  socket: any = null

  /** for the socket the conversation starts on (ignored once a TLS socket replaced it: it would only carry ciphertext) */
  readonly plain = {
    data: (_s: any, d: Buffer) => { if (!this.upgraded) this.feed(d) },
    open: () => {}, drain: () => {},
    close: () => this.fail(new MailError('connection closed', false)),
    error: (_s: any, e: any) => this.fail(new MailError(`connection failed${e?.code ? ` (${e.code})` : ''}`, false)),
    connectError: (_s: any, e: any) => this.fail(new MailError(`cannot connect${e?.code ? ` (${e.code})` : ''}`, false)),
  }
  handshaken: ((ok: boolean) => void) | null = null
  readonly secured = {
    data: (_s: any, d: Buffer) => this.feed(d),
    open: () => {}, drain: () => {},
    handshake: (_s: any, ok: boolean) => this.handshaken?.(ok),
    close: () => this.fail(new MailError('connection closed', false)),
    error: (_s: any, e: any) => this.fail(new MailError(`TLS failed${e?.code ? ` (${e.code})` : ''}`, false)),
    connectError: (_s: any, e: any) => this.fail(new MailError(`cannot connect${e?.code ? ` (${e.code})` : ''}`, false)),
  }

  private feed(d: Buffer) {
    this.buf += d.toString('latin1')
    if (this.buf.length > 65536) this.fail(new MailError('reply too long', false))
    this.wake?.()
  }
  fail(e: MailError) {
    this.failure ??= e
    this.wake?.()
  }
  write(line: string) {
    if (this.failure) throw this.failure
    this.socket.write(line)
  }
  /** one complete reply (every line of a multi-line one) */
  async reply(): Promise<Reply> {
    const deadline = Date.now() + MAIL_TIMING.replyMs
    for (;;) {
      const lines = this.buf.split('\r\n')
      lines.pop() // the unfinished rest
      const last = lines.at(-1)
      if (last !== undefined && /^\d{3}(?: .*)?$/.test(last) && lines.every(l => /^\d{3}[ -]/.test(l) || /^\d{3}$/.test(l))) {
        this.buf = this.buf.slice(lines.join('\r\n').length + 2)
        return { code: Number(last.slice(0, 3)), lines: lines.map(l => l.slice(4)) }
      }
      if (this.failure) throw this.failure
      const left = deadline - Date.now()
      if (left <= 0) throw new MailError('no answer from the mail server', false)
      await new Promise<void>(resolve => {
        const t = setTimeout(() => { this.wake = null; resolve() }, left)
        this.wake = () => { clearTimeout(t); this.wake = null; resolve() }
      })
    }
  }
}

function timeoutAfter<T>(ms: number, what: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new MailError(what, false)), ms) })]).finally(() => clearTimeout(timer))
}

/** the name we give in EHLO: this machine's, in ASCII */
const ehloName = () => hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost'

/** Send one message. Throws MailError; the message of it never holds the password or the address of the user. */
export async function smtpSend(s: SmtpSettings, msg: { to: string; subject: string; text: string }): Promise<void> {
  const from = parseFrom(s.from)
  if (!from) throw new MailError('bad sender', true)
  // built first: a bad address or subject is refused before anything is sent to anyone
  const data = dotStuff(buildMessage({ from, to: msg.to, subject: msg.subject, text: msg.text }))
  const to = cleanAddress(msg.to)!

  const conn = new Conn()
  const tlsOptions = { serverName: s.tls?.serverName ?? s.host, ...(s.tls?.ca ? { ca: s.tls.ca } : {}) }
  const connectTimeout = MAIL_TIMING.connectMs
  try {
    conn.socket = await timeoutAfter(connectTimeout, 'cannot connect (timeout)', Bun.connect({
      hostname: s.host, port: s.port,
      ...(s.secure === 'tls' ? { tls: tlsOptions } : {}),
      socket: s.secure === 'tls' ? conn.secured : conn.plain,
    } as any))
    if (s.secure === 'tls') conn.upgraded = true

    const expect = async (r: Reply | Promise<Reply>, ...ok: number[]) => {
      const reply = await r
      if (!ok.includes(reply.code)) throw new MailError(`the mail server answered ${reply.code}`, reply.code >= 500)
      return reply
    }
    const cmd = (line: string, ...ok: number[]) => {
      conn.write(`${line}\r\n`)
      return expect(conn.reply(), ...ok)
    }

    await expect(conn.reply(), 220)
    let ehlo = await cmd(`EHLO ${ehloName()}`, 250)
    if (s.secure === 'starttls') {
      if (!ehlo.lines.some(l => /^STARTTLS$/i.test(l.trim()))) throw new MailError('the mail server does not offer STARTTLS', true)
      await cmd('STARTTLS', 220)
      const done = new Promise<boolean>(resolve => { conn.handshaken = resolve })
      const [, secured] = (conn.socket as any).upgradeTLS({ tls: tlsOptions, socket: conn.secured })
      conn.upgraded = true
      conn.socket = secured
      if (!(await timeoutAfter(connectTimeout, 'TLS handshake timeout', done))) throw new MailError('TLS handshake failed', false)
      ehlo = await cmd(`EHLO ${ehloName()}`, 250)
    }

    if (s.user) {
      // the password only travels over TLS, or to this machine (smtpConfig refuses the rest)
      if (s.secure === 'none' && !LOOPBACK.has(s.host.toLowerCase())) throw new MailError('refusing to send a password without TLS', true)
      const mechs = ehlo.lines.flatMap(l => (/^AUTH[ =]/i.test(l) ? l.slice(5).toUpperCase().split(/\s+/) : []))
      if (mechs.includes('PLAIN')) {
        await cmd(`AUTH PLAIN ${Buffer.from(`\0${s.user}\0${s.pass}`).toString('base64')}`, 235)
      } else if (mechs.includes('LOGIN')) {
        await cmd('AUTH LOGIN', 334)
        await cmd(Buffer.from(s.user).toString('base64'), 334)
        await cmd(Buffer.from(s.pass).toString('base64'), 235)
      } else {
        throw new MailError('the mail server offers no AUTH PLAIN or LOGIN', true)
      }
    }

    await cmd(`MAIL FROM:<${from.address}>`, 250)
    await cmd(`RCPT TO:<${to}>`, 250, 251)
    await cmd('DATA', 354)
    conn.write(`${data}\r\n.\r\n`)
    await expect(conn.reply(), 250)
    try { conn.write('QUIT\r\n') } catch { /* the message is accepted already */ }
  } finally {
    try { conn.socket?.end() } catch { /* already closed */ }
  }
}

/** send with the SMTP_* settings; throws a permanent MailError when e-mail is off */
export async function sendMail(msg: { to: string; subject: string; text: string }): Promise<void> {
  const { settings } = smtpConfig()
  if (!settings) throw new MailError('e-mail is off', true)
  await smtpSend(settings, msg)
}

/** a short stable id of an address, for log lines (the address itself is not written to the log) */
export const addressTag = (a: string) => createHash('sha256').update(a.toLowerCase()).digest('hex').slice(0, 8)
