import { brotliCompress, brotliCompressSync, constants, gzip, gzipSync } from 'node:zlib'
import { promisify } from 'node:util'
import { pickEncoding } from './static'

/**
 * JSON answers of the API, compressed (br or gzip, whatever the browser accepts). Only GET routes on this list:
 * a compressed answer leaks its content to someone who can add text of their own to it and watch the size (BREACH),
 * so nothing here may carry a secret. Not on it, on purpose: /api/session (CSRF token), login and 2FA (codes),
 * /api/shares and /api/s/* (share tokens), /api/upload (upload ids), backups, update, office (tokens, paths of the
 * server), downloads, zips and streams (not JSON). Logs and the activity list are scrubbed of tokens by logger.ts
 * and audit.ts before they are stored; the rest is names, sizes, times and the settings of one's own account (the notification list holds texts, never a link's token).
 */
const ALLOWED = new Set([
  '/api/list', '/api/folders', '/api/search', '/api/versions', '/api/me/favorites', '/api/me/recent', '/api/me/notifications',
  '/api/admin/users', '/api/admin/activity', '/api/admin/logs', '/api/admin/folders',
])
const MIN_BYTES = 1024
// above this a compression is long enough to hold up the other requests: the thread pool takes it
const SYNC_MAX = 512 * 1024
// measured on a 2,000-entry listing (222 KB): br 4 = 1.5 ms, 19 KB (br 5 = 2.9 ms, 15 KB); gzip 3 = 1.0 ms, 26 KB (gzip 6 = 2.4 ms, 26 KB)
const BR = (n: number) => ({ params: { [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_SIZE_HINT]: n } })
const GZ = { level: 3 }
const brAsync = promisify(brotliCompress)
const gzAsync = promisify(gzip)

export const compressibleRoute = (method: string, pathname: string) => method === 'GET' && ALLOWED.has(pathname)

/** `Vary` for an answer that may go out compressed: on every answer of these routes, compressed or not */
export const withVary = (vary: unknown) => (vary && !/accept-encoding/i.test(String(vary)) ? `${vary}, Accept-Encoding` : String(vary || 'Accept-Encoding'))

/** the answer as a Response, compressed; null when it should go the normal way (small, or the client takes no coding) */
export async function compressedJson(request: Request, value: unknown, headers: Record<string, any>): Promise<Response | null> {
  const encoding = pickEncoding(request.headers.get('accept-encoding'))
  if (!encoding || value === null || typeof value !== 'object') return null
  const raw = Buffer.from(JSON.stringify(value))
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) out[k.toLowerCase()] = String(v)
  if (raw.length < MIN_BYTES) return null
  const big = raw.length > SYNC_MAX
  const body = encoding === 'br'
    ? (big ? await brAsync(raw, BR(raw.length)) : brotliCompressSync(raw, BR(raw.length)))
    : (big ? await gzAsync(raw, GZ) : gzipSync(raw, GZ))
  out['content-type'] = 'application/json'
  out['content-encoding'] = encoding
  out['content-length'] = String(body.length)
  return new Response(body, { headers: out })
}
