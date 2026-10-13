import { statSync } from 'node:fs'
import { brotliCompress, constants, gzip } from 'node:zlib'
import { promisify } from 'node:util'

const brotli = promisify(brotliCompress)
const gz = promisify(gzip)

/** text formats shrink a lot; images, fonts and archives are compressed already */
const COMPRESSIBLE = /\.(?:html|js|mjs|css|json|svg|txt|map|xml|wasm|webmanifest)$/i
const MIN_BYTES = 1024

type Encoding = 'br' | 'gzip'
type Entry = { stamp: string; br?: Promise<Uint8Array>; gzip?: Promise<Uint8Array> }
/** compressed copies, made on the first request that wants them and kept until the file changes (web/dist is small) */
const cache = new Map<string, Entry>()

export const compressible = (abs: string, size: number) => size >= MIN_BYTES && COMPRESSIBLE.test(abs)

/** the best encoding the client accepts (q=0 means "not accepted"); br before gzip */
export function pickEncoding(acceptEncoding: string | null): Encoding | null {
  if (!acceptEncoding) return null
  const ok = new Set<string>()
  for (const part of acceptEncoding.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    const q = params.map(p => p.trim()).find(p => p.startsWith('q='))
    if (q !== undefined && !(Number(q.slice(2)) > 0)) continue
    ok.add(name.trim())
  }
  return ok.has('br') ? 'br' : ok.has('gzip') || ok.has('*') ? 'gzip' : null
}

/** a validator that changes with the file (size + mtime) and with the encoding sent, so a cache never mixes the two */
export const etagOf = (size: number, mtimeMs: number, encoding: Encoding | null) =>
  `W/"${size.toString(16)}-${Math.round(mtimeMs).toString(16)}${encoding ? '-' + encoding : ''}"`

/** If-None-Match: a list of tags (weak or strong) or `*`; weak comparison is what 304 needs */
export function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false
  const bare = (t: string) => t.trim().replace(/^W\//, '')
  const mine = bare(etag)
  return header.split(',').some(t => t.trim() === '*' || bare(t) === mine)
}

export async function compressedCopy(abs: string, encoding: Encoding): Promise<Uint8Array> {
  const st = statSync(abs)
  const stamp = `${st.size}-${st.mtimeMs}`
  let entry = cache.get(abs)
  if (!entry || entry.stamp !== stamp) {
    entry = { stamp }
    cache.set(abs, entry)
  }
  const made = entry[encoding]
  if (made) return made
  // async zlib runs on the thread pool: compressing the biggest bundle does not hold up other requests
  const run = (async () => {
    const raw = Buffer.from(await Bun.file(abs).arrayBuffer())
    return encoding === 'br'
      ? new Uint8Array(await brotli(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }))
      : new Uint8Array(await gz(raw, { level: 9 }))
  })()
  entry[encoding] = run
  // a failed attempt must not stick: the next request tries again
  run.catch(() => { if (entry![encoding] === run) delete entry![encoding] })
  return run
}
