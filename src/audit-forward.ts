/**
 * Audit forwarding: every audit entry is also sent to a syslog server (RFC 5424, over UDP or TCP) and/or a webhook,
 * when an admin sets one on the settings page (auditForward.*). The log file stays the record of truth; this is a copy
 * for a log collector or SIEM.
 *
 * It never gets in the way of the request that wrote the entry: `forwardAudit` only puts the entry on a bounded
 * in-memory queue (a full queue drops the newest and counts it), everything else happens in the background with
 * timeouts, and every failure is only logged (warn, at most once a minute) and counted. A restart loses what was
 * still waiting. The webhook URL follows the same rule as the alert webhook (https, or http to this machine only,
 * no redirects) and is checked again at send time; the syslog line carries the same fields as the log file.
 */
import { createHmac } from 'node:crypto'
import { createSocket, type Socket } from 'node:dgram'
import { hostname } from 'node:os'
import { connect, type Socket as TcpSocket } from 'node:net'
import type { AuditEntry } from './audit'
import { config } from './config'
import { log, scrub } from './logger'
import { auditForwardValues, isSafeWebhookUrl } from './policy'

export const FORWARD_TIMING = {
  /** entries waiting; more are dropped */
  maxQueue: 1000,
  /** entries per webhook request, and how long they may wait to be batched */
  batch: 50,
  flushMs: 1000,
  /** one webhook request or one TCP connect */
  timeoutMs: 5000,
  /** after a TCP connect fails, do not try again for this long (entries meanwhile are dropped) */
  retryMs: 30_000,
}

const state = { queued: 0, dropped: 0, sent: 0, failed: 0, lastError: '', lastErrorAt: 0, lastOkAt: 0 }
let lastWarn = 0

function failure(channel: string, reason: string) {
  state.failed++
  state.lastError = `${channel}: ${reason}`.slice(0, 200)
  state.lastErrorAt = Date.now()
  if (Date.now() - lastWarn > 60_000) {
    lastWarn = Date.now()
    log.warn('audit-forward-failed', { channel, reason })
  }
}
const success = () => { state.sent++; state.lastOkAt = Date.now() }

/** counters for tests and the config warning */
export const forwardStats = () => ({ ...state })
/** a destination is set and the last attempt failed within the last 10 minutes */
export function forwardFailing(): boolean {
  return state.lastErrorAt > 0 && state.lastErrorAt > state.lastOkAt && Date.now() - state.lastErrorAt < 10 * 60_000
}

// ───────────── RFC 5424 ─────────────

const HOST = (() => { const h = hostname().replace(/[^\x21-\x7e]/g, '').slice(0, 255); return h || '-' })()
const sdValue = (v: string) => scrub(v).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[\\"\]]/g, c => '\\' + c).slice(0, 500)
const token = (v: string, max: number) => v.replace(/[^\x21-\x7e]/g, '').slice(0, max) || '-'

/** `<PRI>1 time host app procid msgid [sd] message`, severity 6 (informational) */
export function syslogLine(e: AuditEntry, facility: number): string {
  const sd = `[fc@32473 user="${sdValue(e.user)}" ip="${sdValue(e.ip)}"${e.target ? ` target="${sdValue(e.target)}"` : ''}]`
  const msg = e.detail ? scrub(e.detail).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000) : ''
  return `<${facility * 8 + 6}>1 ${e.ts} ${HOST} file-center ${process.pid} ${token(e.action, 32)} ${sd}${msg ? ' ' + msg : ''}`
}

// ───────────── the queue ─────────────

const queue: AuditEntry[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let flushing: Promise<void> | null = null

/** put an entry on the queue; never throws, never waits */
export function forwardAudit(entry: AuditEntry): void {
  try {
    const v = auditForwardValues()
    if (!v.syslogHost && !v.webhookUrl) return
    if (queue.length >= FORWARD_TIMING.maxQueue) { state.dropped++; return }
    queue.push(entry)
    state.queued++
    if (!timer && !flushing) timer = setTimeout(() => { timer = null; void flush() }, queue.length >= FORWARD_TIMING.batch ? 0 : FORWARD_TIMING.flushMs).unref()
  } catch { /* forwarding must not break the request */ }
}

/** send what waits (one flush at a time; a flush that finds more waiting goes on) */
export function flush(): Promise<void> {
  flushing ??= (async () => {
    try {
      while (queue.length) {
        const batch = queue.splice(0, FORWARD_TIMING.batch)
        const v = auditForwardValues()
        await Promise.all([
          v.syslogHost ? sendSyslog(v, batch).catch(e => failure('syslog', reasonOf(e))) : null,
          // a saved secret that can not be opened must not turn into unsigned batches the receiver would take as genuine
          v.webhookUrl && v.webhookSecretBroken ? Promise.reject(new ForwardError('secret unreadable')).catch(e => failure('webhook', reasonOf(e)))
            : v.webhookUrl ? sendWebhook(v.webhookUrl, batch, v.webhookSecret).catch(e => failure('webhook', reasonOf(e))) : null,
        ])
      }
    } finally { flushing = null }
  })()
  return flushing
}

function reasonOf(e: unknown): string {
  const x = e as { code?: unknown; name?: unknown; message?: unknown } | null
  return typeof x?.code === 'string' ? x.code : typeof x?.message === 'string' && x.name === 'ForwardError' ? x.message : typeof x?.name === 'string' ? x.name : 'error'
}
class ForwardError extends Error { override name = 'ForwardError' }

// ───────────── syslog ─────────────

let udp: Socket | null = null
let tcp: { key: string; socket: TcpSocket } | null = null
let tcpBlockedUntil = 0

function sendUdp(host: string, port: number, lines: string[]): Promise<void> {
  udp ??= (() => { const s = createSocket(host.includes(':') ? 'udp6' : 'udp4'); s.unref(); s.on('error', () => { udp?.close(); udp = null }); return s })()
  const socket = udp
  return Promise.all(lines.map(l => new Promise<void>((resolve, reject) => {
    // a datagram over ~2000 bytes may not pass the network; the line is already cut well under that
    socket.send(Buffer.from(l, 'utf8').subarray(0, 2000), port, host, err => (err ? reject(err) : resolve()))
  }))).then(() => {})
}

function tcpSocket(host: string, port: number): Promise<TcpSocket> {
  const key = `${host}:${port}`
  if (tcp && tcp.key === key && !tcp.socket.destroyed && tcp.socket.writable) return Promise.resolve(tcp.socket)
  tcp?.socket.destroy()
  tcp = null
  if (Date.now() < tcpBlockedUntil) return Promise.reject(new ForwardError('waiting to reconnect'))
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    socket.unref()
    socket.setTimeout(FORWARD_TIMING.timeoutMs)
    const fail = (e: unknown) => { socket.destroy(); tcpBlockedUntil = Date.now() + FORWARD_TIMING.retryMs; reject(e) }
    socket.once('timeout', () => fail(new ForwardError('timeout')))
    socket.once('error', fail)
    socket.once('connect', () => {
      socket.setTimeout(0)
      socket.removeListener('error', fail)
      socket.on('error', () => socket.destroy())
      tcp = { key, socket }
      resolve(socket)
    })
  })
}

async function sendSyslog(v: ReturnType<typeof auditForwardValues>, batch: AuditEntry[]): Promise<void> {
  const lines = batch.map(e => syslogLine(e, v.syslogFacility))
  if (v.syslogProto === 'udp') {
    await sendUdp(v.syslogHost, v.syslogPort, lines)
  } else {
    const socket = await tcpSocket(v.syslogHost, v.syslogPort)
    // RFC 6587 octet counting: "<length> <message>", so a line may hold anything
    const data = Buffer.concat(lines.map(l => { const b = Buffer.from(l, 'utf8'); return Buffer.concat([Buffer.from(`${b.length} `), b]) }))
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { socket.destroy(); reject(new ForwardError('timeout')) }, FORWARD_TIMING.timeoutMs)
      socket.write(data, err => { clearTimeout(t); if (err) { socket.destroy(); reject(err) } else resolve() })
    })
  }
  success()
}

// ───────────── webhook ─────────────

/** `X-FC-Signature` value: sha256= and the hex HMAC of "<timestamp>.<body>" */
export const signWebhook = (secret: string, timestamp: string, body: string) => 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')

async function sendWebhook(url: string, batch: AuditEntry[], secret = ''): Promise<void> {
  if (!isSafeWebhookUrl(url)) throw new ForwardError('unsafe url')
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), FORWARD_TIMING.timeoutMs)
  try {
    const entries = batch.map(e => ({ ts: e.ts, user: e.user, ip: e.ip, action: e.action, target: e.target, detail: e.detail === undefined ? undefined : scrub(e.detail) }))
    // serialised once: the signature covers exactly the string that is sent
    const body = JSON.stringify({ event: 'audit', source: 'file-center', host: HOST, version: config.version, entries })
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (secret) {
      const ts = String(Math.floor(Date.now() / 1000))
      headers['x-fc-timestamp'] = ts
      headers['x-fc-signature'] = signWebhook(secret, ts, body)
    }
    const res = await fetch(url, { method: 'POST', redirect: 'error', signal: abort.signal, headers, body })
    void res.body?.cancel().catch(() => {})
    if (!res.ok) throw new ForwardError(`HTTP ${res.status}`)
    success()
  } catch (e) {
    if (e instanceof ForwardError) throw e
    throw new ForwardError(abort.signal.aborted ? 'timeout' : 'unreachable')
  } finally { clearTimeout(timer) }
}

/** send everything waiting now (tests, shutdown) */
export async function forwardIdle(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null }
  while (queue.length || flushing) await flush()
}

/** forget connections and counters (tests; a changed destination reconnects on its own) */
export function resetForwarding(): void {
  queue.length = 0
  if (timer) { clearTimeout(timer); timer = null }
  udp?.close(); udp = null
  tcp?.socket.destroy(); tcp = null
  tcpBlockedUntil = 0
  Object.assign(state, { queued: 0, dropped: 0, sent: 0, failed: 0, lastError: '', lastErrorAt: 0, lastOkAt: 0 })
}
