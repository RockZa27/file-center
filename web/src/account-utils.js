/** Small helpers for the account pages: devices, relative time, secrets, quotas. */

/** "Chrome · Windows" from a User-Agent header: only the common browsers and systems, else the raw text cut short */
export function describeUserAgent(ua) {
  const s = String(ua || '')
  if (!s || s === 'unknown') return { browser: '', os: '' }
  let browser = ''
  if (/Edg(e|A|iOS)?\//.test(s)) browser = 'Edge'
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera'
  else if (/SamsungBrowser\//.test(s)) browser = 'Samsung Internet'
  else if (/Firefox\/|FxiOS\//.test(s)) browser = 'Firefox'
  else if (/Chrome\/|CriOS\//.test(s)) browser = 'Chrome'
  else if (/Safari\//.test(s)) browser = 'Safari'
  else if (/curl\//i.test(s)) browser = 'curl'
  let os = ''
  if (/Windows/.test(s)) os = 'Windows'
  else if (/Android/.test(s)) os = 'Android'
  else if (/iPhone|iPad|iPod/.test(s)) os = 'iOS'
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS'
  else if (/CrOS/.test(s)) os = 'ChromeOS'
  else if (/Linux|X11/.test(s)) os = 'Linux'
  if (!browser && !os) return { browser: s.slice(0, 40), os: '' }
  return { browser, os }
}

/** "5 minutes ago" in the page language (`now` and `time` are milliseconds) */
export function relativeTime(time, now, locale) {
  const rtf = new Intl.RelativeTimeFormat(locale === 'th' ? 'th' : 'en', { numeric: 'auto' })
  const sec = Math.round((time - now) / 1000)
  const abs = Math.abs(sec)
  if (abs < 60) return rtf.format(Math.min(0, sec), 'second')
  if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour')
  return rtf.format(Math.round(sec / 86400), 'day')
}

/** the secret in groups of 4 to type by hand */
export const groupSecret = s => String(s || '').replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim()

const MB = 1024 * 1024
const GB = 1024 * MB
/** quota bytes -> { value, unit } for the form; 0 = no limit */
export function splitQuota(bytes) {
  if (!bytes) return { value: null, unit: 'GB' }
  if (bytes % GB === 0 || bytes >= 10 * GB) return { value: Math.round((bytes / GB) * 100) / 100, unit: 'GB' }
  return { value: Math.round((bytes / MB) * 100) / 100, unit: 'MB' }
}
export const joinQuota = (value, unit) => (value && value > 0 ? Math.round(value * (unit === 'GB' ? GB : MB)) : 0)
