/**
 * Alerts: a short message to the admin's chat (Discord, Slack, Telegram) or any JSON webhook (ALERT_WEBHOOK_URL)
 * when something needs a look: a backup failed, many errors in an hour, an account or share link locked out for
 * wrong passwords, the disk almost full, a newer version published at UPDATE_SOURCE.
 *
 * An alert never gets in the way of the work that caused it: it is sent in the background with a time limit, a
 * failure is only logged (warn), and each kind goes out at most once per hour. The text is a catalog message in
 * ALERT_LANG and passes through `scrub` like the log, so no password, token or cookie leaves; IPs appear as in the
 * activity log. startAlerts (index.ts) runs the checks that have no request of their own to hang on.
 */
import { basename } from 'node:path'
import { config } from './config'
import { conflict, HttpError } from './fsx'
import { clean, errorsSince, log, scrub } from './logger'
import { MESSAGES, text, type MessageCode, type Params } from './messages'
import { mirrorAlert, resetNotifyLimits } from './notify'
import { settings } from './settings'
import { DISK_CRITICAL_PERCENT, diskInfo } from './stats'
import { JsonStore } from './store'
import { lookForNewVersion } from './update-source'

export type AlertKind = 'test' | 'backup-failed' | 'errors' | 'lockout' | 'disk-critical' | 'update-available' | 'store-write-failed'
const WEBHOOK_KINDS = ['discord', 'slack', 'telegram', 'json'] as const
type WebhookKind = (typeof WEBHOOK_KINDS)[number]

/** how long and how often; tests make them shorter */
export const ALERT_TIMING = {
  sendTimeoutMs: 10_000,
  /** one alert of a kind per this long */
  perKindMs: 3600_000,
  /** errors per hour and disk space are looked at this often */
  monitorEveryMs: 5 * 60_000,
  /** the first look at UPDATE_SOURCE after start, then one a day */
  firstVersionCheckMs: 60_000,
  versionCheckEveryMs: 24 * 3600_000,
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

type Target = { key: string; url: string | null; kind: WebhookKind | null; host: string | null; error: string | null }
let parsed: Target | undefined

/** the webhook settings, checked once per value; `error` says why alerts are off (for the startup log, never the URL) */
export function alertTarget(): Omit<Target, 'key'> {
  const key = [config.alertWebhookUrl, config.alertWebhookKind, config.alertTelegramChatId].join('\n')
  if (parsed?.key !== key) {
    parsed = { key, url: null, kind: null, host: null, error: null }
    const value = config.alertWebhookUrl
    if (value) {
      let u: URL | null = null
      try { u = new URL(value) } catch { /* reported below */ }
      const kind = (WEBHOOK_KINDS as readonly string[]).includes(config.alertWebhookKind) ? config.alertWebhookKind as WebhookKind : null
      if (u) parsed.host = u.host
      if (!u) parsed.error = 'อ่าน ALERT_WEBHOOK_URL ไม่ได้'
      else if (!(u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname)))) {
        parsed.error = 'ALERT_WEBHOOK_URL ต้องเป็น https:// (http:// ได้เฉพาะ 127.0.0.1 หรือ localhost)'
      } else if (!kind) parsed.error = 'ALERT_WEBHOOK_KIND ต้องเป็น discord, slack, telegram หรือ json'
      else if (kind === 'telegram' && !config.alertTelegramChatId) parsed.error = 'ALERT_WEBHOOK_KIND=telegram ต้องตั้ง ALERT_TELEGRAM_CHAT_ID ด้วย'
      else {
        parsed.url = u.href
        parsed.kind = kind
      }
    }
  }
  return { url: parsed.url, kind: parsed.kind, host: parsed.host, error: parsed.error }
}

/** when each kind last went out (memory only) */
const lastSent: Partial<Record<AlertKind, string>> = {}
/** sends still on their way, so tests can wait for them */
const inFlight = new Set<Promise<void>>()

/** GET /api/admin/alerts: never the URL itself (a bot token or webhook secret is part of it), only its host */
export function alertStatus() {
  const t = alertTarget()
  return { enabled: t.url !== null, kind: t.kind ?? config.alertWebhookKind, host: t.host, lastSent: { ...lastSent } }
}

/** the text in ALERT_LANG and the params, both cleaned the way the log is */
function render(code: MessageCode, params: Params): { message: string; params: Params } {
  const p: Params = { ...params }
  // a reason that is itself a catalog message (backup failures) is told in ALERT_LANG too
  if (typeof p.reasonCode === 'string' && Object.hasOwn(MESSAGES, p.reasonCode)) p.reason = text(config.alertLang, p.reasonCode as MessageCode)
  const message = scrub(`[${settings.get().appName}] ${text(config.alertLang, code, p)}`).slice(0, 1500)
  return { message, params: clean(p) as Params }
}

/** the body each service expects; names typed by visitors (a login name) must not ping a whole channel */
function payload(kind: WebhookKind, event: AlertKind, code: MessageCode, message: string, params: Params) {
  switch (kind) {
    case 'discord': return { content: message, allowed_mentions: { parse: [] } }
    case 'slack': return { text: message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
    case 'telegram': return { chat_id: config.alertTelegramChatId, text: message, disable_web_page_preview: true }
    default: return { event, code, message, params, lang: config.alertLang, version: config.version, time: new Date().toISOString() }
  }
}

/** POST it, no redirects (one could lead off https), cancelled after sendTimeoutMs; throws an HttpError that says why */
async function post(url: string, body: unknown): Promise<void> {
  const abort = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; abort.abort() }, ALERT_TIMING.sendTimeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST', redirect: 'error', signal: abort.signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    void res.body?.cancel().catch(() => {})
    if (!res.ok) throw new HttpError(502, 'admin.alert-status', { status: res.status })
  } catch (e) {
    if (e instanceof HttpError) throw e
    if (timedOut) throw new HttpError(504, 'admin.alert-timeout', { seconds: Math.ceil(ALERT_TIMING.sendTimeoutMs / 1000) })
    throw new HttpError(502, 'admin.alert-unreachable')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Send an alert in the background, unless alerts are off or this kind went out within the hour. Never throws and
 * never waits: the caller is usually answering a request. Returns whether it was sent off.
 */
export function alert(event: Exclude<AlertKind, 'test'>, code: MessageCode, params: Params = {}): boolean {
  // the admins' bell (and LINE group) hear of it whether or not a webhook is set; notify.ts limits it to once an hour per kind
  mirrorAlert(event, code, params)
  try {
    const t = alertTarget()
    if (!t.url || !t.kind) return false
    const last = lastSent[event]
    if (last && Date.now() - Date.parse(last) < ALERT_TIMING.perKindMs) return false
    lastSent[event] = new Date().toISOString()
    const r = render(code, params)
    const sending: Promise<void> = post(t.url, payload(t.kind, event, code, r.message, r.params)).then(
      () => log.info('alert-sent', { event }),
      err => log.warn('alert-failed', { event, error: err instanceof HttpError ? err.message : err }),
    ).finally(() => { inFlight.delete(sending) })
    inFlight.add(sending)
    return true
  } catch (err) {
    log.warn('alert-failed', { event, error: err })
    return false
  }
}

/** POST /api/admin/alerts/test: sent right away (no hourly limit), and the admin gets the error when it fails */
export async function sendTestAlert(): Promise<void> {
  const t = alertTarget()
  if (!t.url || !t.kind) throw conflict('admin.alert-off')
  lastSent.test = new Date().toISOString()
  const r = render('admin.alert-test', {})
  await post(t.url, payload(t.kind, 'test', 'admin.alert-test', r.message, r.params))
}

// a data file that could not be written (disk full, no permission) after several tries: the change is only in memory
JsonStore.onWriteFailed = (file, error) => {
  alert('store-write-failed', 'admin.alert-store-write', { file: basename(file), reason: (error as Error)?.message ?? String(error) })
}

/** wait for the alerts on their way (tests) */
export async function alertsIdle(): Promise<void> {
  await Promise.all([...inFlight])
}

/** forget when alerts went out (tests) */
export function resetAlerts() {
  for (const k of Object.keys(lastSent)) delete lastSent[k as AlertKind]
  resetNotifyLimits()
  notifiedVersion = null
}

/** too many errors in the last hour, or the disk below the dashboard's critical mark */
export function checkHealth() {
  try {
    if (!alertTarget().url) return
    const errors = errorsSince(Date.now() - 3600_000)
    if (errors > config.alertErrorsPerHour) alert('errors', 'admin.alert-errors', { count: errors, max: config.alertErrorsPerHour })
    const disk = diskInfo()
    if (disk && disk.total > 0) {
      const freePct = (disk.free / disk.total) * 100
      if (freePct < DISK_CRITICAL_PERCENT) alert('disk-critical', 'admin.disk-critical', { percent: freePct.toFixed(1) })
    }
  } catch (err) {
    log.warn('alert-check-failed', err)
  }
}

/** the version the last alert told about: one alert per new version */
let notifiedVersion: string | null = null

/** the daily look at UPDATE_SOURCE: the dashboard warns from what it found, and the admin gets one alert per new version */
export async function checkForNewVersion() {
  try {
    const v = await lookForNewVersion()
    if (v && v !== notifiedVersion && alert('update-available', 'update.available', { version: v })) notifiedVersion = v
  } catch (err) {
    // the source is down or wrong: the update page says so when the admin asks
    log.warn('update-check-failed', err instanceof HttpError ? err.message : err)
  }
}

/** log a wrong setting once, then run the checks in the background; returns a function that stops them */
export function startAlerts(): () => void {
  const t = alertTarget()
  if (t.error) log.warn('alerts-invalid', `การแจ้งเตือน${t.host ? ` (${t.host})` : ''} ไม่ถูกต้อง: ${t.error} ปิดการแจ้งเตือนไว้จนกว่าจะแก้ค่านี้`)
  const monitor = setInterval(checkHealth, ALERT_TIMING.monitorEveryMs)
  let daily: ReturnType<typeof setInterval> | undefined
  const first = setTimeout(() => {
    void checkForNewVersion()
    daily = setInterval(() => void checkForNewVersion(), ALERT_TIMING.versionCheckEveryMs)
    daily.unref()
  }, ALERT_TIMING.firstVersionCheckMs)
  monitor.unref()
  first.unref()
  return () => {
    clearInterval(monitor)
    clearTimeout(first)
    clearInterval(daily)
  }
}
