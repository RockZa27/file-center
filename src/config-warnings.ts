/**
 * Settings of the .env that are risky or do not fit how the app is reached (GET /api/admin/config-warnings). Some can be
 * seen without a request (`envWarnings`, also checked once at start and sent as one alert), the rest need the request
 * at hand: whether it came over HTTPS, and whether a proxy that is trusted sent its headers.
 */
import { allUsers } from './auth'
import { config } from './config'
import type { MessageCode } from './messages'
import { unreadableSecrets } from './policy'

export type ConfigWarning = { code: MessageCode; severity: 'warning' | 'critical' }

/** from the env and the accounts alone */
export function envWarnings(): ConfigWarning[] {
  const out: ConfigWarning[] = []
  if (config.updateAllowUnsigned) out.push({ code: 'update.allow-unsigned', severity: 'critical' })
  if (!config.secureCookie && /^https:/i.test(config.publicUrl)) out.push({ code: 'admin.config-insecure-cookie', severity: 'warning' })
  if (config.adminPassword && allUsers().some(u => u.role === 'admin')) out.push({ code: 'admin.config-admin-password-env', severity: 'warning' })
  return out
}

export function configWarnings(request: Request): ConfigWarning[] {
  const out = envWarnings()
  const h = request.headers
  const trusted = config.trustProxy !== 'false'
  const https = new URL(request.url).protocol === 'https:' || (trusted && h.get('x-forwarded-proto')?.split(',')[0].trim().toLowerCase() === 'https')
  if (https && !config.secureCookie && !out.some(w => w.code === 'admin.config-insecure-cookie')) out.push({ code: 'admin.config-insecure-cookie', severity: 'warning' })
  if (config.trustProxy === 'true' && !h.get('x-forwarded-for')) out.push({ code: 'admin.config-proxy-no-headers', severity: 'warning' })
  if (config.trustProxy === 'cloudflare' && !h.get('cf-connecting-ip')) out.push({ code: 'admin.config-proxy-no-headers', severity: 'warning' })
  // the initial password is the one made at the first start: the account still has to change it
  if (allUsers().some(u => u.role === 'admin' && u.mustChangePassword)) out.push({ code: 'admin.config-admin-initial-password', severity: 'critical' })
  if (unreadableSecrets().length) out.push({ code: 'admin.config-secret-unreadable', severity: 'warning' })
  return out
}
