const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

export function formatBytes(n, digits = 1) {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  const v = n / 1024 ** i
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : digits)} ${UNITS[i]}`
}

const pad = n => String(n).padStart(2, '0')
export function formatDate(input) {
  const d = typeof input === 'number' || typeof input === 'string' ? new Date(input) : input
  if (!d || Number.isNaN(d.getTime())) return '-'
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m`
  return `${s}s`
}

export const extOf = name => {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']
export const VIDEO_EXT = ['mp4', 'webm']
export const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a']
export const TEXT_EXT = ['txt', 'md', 'json', 'csv', 'log', 'xml', 'yml', 'yaml', 'ini', 'js', 'ts', 'css', 'html', 'vue', 'py', 'php', 'sh', 'sql', 'env']

export const isImage = n => IMAGE_EXT.includes(extOf(n))
export const kindOf = name => {
  const e = extOf(name)
  if (IMAGE_EXT.includes(e)) return 'image'
  if (VIDEO_EXT.includes(e)) return 'video'
  if (AUDIO_EXT.includes(e)) return 'audio'
  if (e === 'pdf') return 'pdf'
  if (TEXT_EXT.includes(e)) return 'text'
  return 'other'
}

export const joinPath = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`)
export const parentPath = p => {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}
export const baseName = p => p.slice(p.lastIndexOf('/') + 1)

/** darken (amount<0) or lighten (amount>0) a #rrggbb colour */
export function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16)
  const mix = c => Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount)
  const r = mix((n >> 16) & 255)
  const g = mix((n >> 8) & 255)
  const b = mix(n & 255)
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
}
