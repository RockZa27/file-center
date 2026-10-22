/**
 * Server-side thumbnails: a small picture of an image, the first page of a PDF or a frame of a video, so the file list
 * can show what a file is without downloading it.
 *
 * The work is done by system tools in the Docker image, never by a library inside the app: vipsthumbnail (libvips-tools)
 * for images, pdftoppm (poppler-utils) for PDF, ffmpeg for video. A web update delivers only the app bundle, so the
 * tools are looked up on PATH when asked and every kind simply turns off when its tool is missing (the page shows an
 * icon, see thumbStatus). Each tool runs as a child process of its own, with an argument list (no shell), a minimal
 * environment, a timeout and at most MAX_RUNNING at a time, so a hostile image can crash, hang or eat only that child.
 * The tool is never given the user's path: it gets a symlink with a plain name in DATA_DIR/thumbs/tmp that points at the
 * real file, so a name such as "a.jpg[page=2]" or "-x.png" is never read as an option or a loader setting.
 *
 * Results are kept in DATA_DIR/thumbs/<sha1(path|size|mtime|file size)>.webp (.jpg for PDF), so a changed file gets a
 * new thumbnail and an unchanged one is never made twice. The cache is trimmed to THUMB_CACHE_MAX_MB, least recently
 * used first (a hit touches the file's mtime), by pruneThumbs() in the hourly housekeeping.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync } from 'node:fs'
import { lstat, readdir, rm, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { config, paths } from './config'
import { HttpError, notFound } from './fsx'
import { log } from './logger'

export type Kind = 'image' | 'pdf' | 'video'
export type ThumbSize = 256 | 1024
export const THUMB_SIZES: readonly ThumbSize[] = [256, 1024]

/** knobs; tests change them */
export const limits = {
  /** generations running at once */
  running: 2,
  /** generations waiting for a place; more than this is answered 503 at once */
  queue: 16,
  /** one generation, all its steps together */
  timeoutMs: 10_000,
  maxPixels: 100_000_000,
  maxImageBytes: 500 * 1024 ** 2,
  /** a file that failed is not tried again for this long */
  failMs: 5 * 60_000,
}

/** how many tool processes were started (tests: a cache hit starts none) */
export const stats = { spawned: 0 }

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff'])
const HEIF_EXT = new Set(['.heic', '.heif', '.avif'])
/** the demuxer ffmpeg is told to use: a file is never sniffed into a playlist (HLS, concat) that names other files or URLs */
const VIDEO_DEMUX: Record<string, string> = {
  '.mp4': 'mov,mp4,m4a,3gp,3g2,mj2', '.m4v': 'mov,mp4,m4a,3gp,3g2,mj2', '.mov': 'mov,mp4,m4a,3gp,3g2,mj2', '.3gp': 'mov,mp4,m4a,3gp,3g2,mj2',
  '.webm': 'matroska,webm', '.mkv': 'matroska,webm', '.avi': 'avi', '.mpg': 'mpeg', '.mpeg': 'mpeg', '.wmv': 'asf', '.flv': 'flv',
}

// ───────────── the tools ─────────────

type ToolName = 'vipsthumbnail' | 'vipsheader' | 'vips' | 'pdftoppm' | 'ffmpeg'
const NAMES: ToolName[] = ['vipsthumbnail', 'vipsheader', 'vips', 'pdftoppm', 'ffmpeg']
const toolPath: Record<ToolName, string | null> = { vipsthumbnail: null, vipsheader: null, vips: null, pdftoppm: null, ffmpeg: null }
let looked = false
let heif: boolean | null = null

function lookUp() {
  if (looked) return
  looked = true
  for (const n of NAMES) toolPath[n] = Bun.which(n)
}

/** look for the tools again on the next call (tests) */
export function resetTools() {
  looked = false
  heif = null
}

/** use these programs instead of the ones on PATH (tests: a fake tool that sleeps); null = not installed */
export function setTools(tools: Partial<Record<ToolName, string | null>>) {
  lookUp()
  Object.assign(toolPath, tools)
  heif = null
}

/** which kinds can be made on this machine; the file list asks once, then shows icons for the rest */
export function thumbStatus(): Record<Kind, boolean> {
  if (!config.thumbnails) return { image: false, pdf: false, video: false }
  lookUp()
  return { image: !!(toolPath.vipsthumbnail && toolPath.vipsheader), pdf: !!toolPath.pdftoppm, video: !!toolPath.ffmpeg }
}

/** libvips built without libheif can not read HEIC / AVIF: ask the tool once */
function heifSupported(): boolean {
  if (heif !== null) return heif
  lookUp()
  heif = false
  if (toolPath.vips) {
    try {
      const r = Bun.spawnSync([toolPath.vips, '-l'], { stdout: 'pipe', stderr: 'ignore', env: toolEnv(), timeout: 5000 })
      heif = r.exitCode === 0 && /\bheifload\b/.test(r.stdout.toString())
    } catch { /* stays false */ }
  }
  return heif
}

export function kindOf(name: string): Kind | null {
  const ext = extname(name).toLowerCase()
  if (IMAGE_EXT.has(ext) || (HEIF_EXT.has(ext) && heifSupported())) return 'image'
  if (ext === '.pdf') return 'pdf'
  if (VIDEO_DEMUX[ext]) return 'video'
  return null
}

const unavailable = () => notFound('thumb.unavailable')
const tooBig = () => new HttpError(422, 'thumb.too-big')

/** what a tool process sees: no secrets of the app, nothing but what it needs. VIPS_BLOCK_UNTRUSTED keeps libvips from
 * handing a file to ImageMagick, rsvg or poppler when it does not look like the image its name says */
function toolEnv(): Record<string, string> {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: join(paths.thumbs, 'tmp'), TMPDIR: join(paths.thumbs, 'tmp'), LANG: 'C.UTF-8',
    VIPS_BLOCK_UNTRUSTED: '1', VIPS_CONCURRENCY: '1', OMP_NUM_THREADS: '1',
  }
}

/** `transient`: the tool did not get to give an answer (timeout, could not start), so a failure says nothing about the file */
type Ran = { ok: boolean; out: string; timedOut: boolean; transient?: boolean }

/** one tool, killed (only it) when it runs past `timeoutMs`; its output is read only when `capture` says so */
async function run(argv: string[], timeoutMs: number, capture = false): Promise<Ran> {
  stats.spawned++
  let proc
  try {
    proc = Bun.spawn(argv, { stdin: 'ignore', stdout: capture ? 'pipe' : 'ignore', stderr: 'ignore', env: toolEnv(), cwd: join(paths.thumbs, 'tmp') })
  } catch {
    return { ok: false, out: '', timedOut: false, transient: true }
  }
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, Math.max(1, timeoutMs))
  try {
    // the output is read next to the wait: a killed tool may leave a child holding the pipe open
    const read = capture ? readCapped(proc.stdout as ReadableStream<Uint8Array>) : Promise.resolve('')
    const code = await proc.exited
    const out = await Promise.race([read, new Promise<string>(r => setTimeout(() => r(''), 300))])
    return { ok: code === 0 && !timedOut, out, timedOut, transient: timedOut }
  } finally {
    clearTimeout(timer)
  }
}

async function readCapped(stream: ReadableStream<Uint8Array>, max = 16 * 1024): Promise<string> {
  const reader = stream.getReader()
  let out = ''
  const dec = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (out.length < max) out += dec.decode(value, { stream: true })
    }
  } catch { /* the pipe went away */ }
  return out.slice(0, max)
}

// ───────────── the plan: what a thumbnail of this file is called, before any work ─────────────

export type Plan = { abs: string; key: string; kind: Kind; size: ThumbSize; ext: 'webp' | 'jpg'; mime: string }

/**
 * Files this tool says it can not thumbnail: until when they are not tried again, and the answer they get meanwhile.
 * Only that verdict is kept. A timeout, a tool that could not start or a busy queue says nothing about the file, so the
 * next request tries again (one slow minute must not hide a file's thumbnail for five).
 */
const failed = new Map<string, { until: number; code: 'thumb.unavailable' | 'thumb.too-big' }>()

/** forget every remembered failure (tests: one slow run must not decide the next test) */
export function resetFailures() {
  failed.clear()
}

/** the key of one version of a file at one size */
export const cacheKey = (stored: string, size: number, st: { size: number; mtimeMs: number }) =>
  createHash('sha1').update(`${stored}|${size}|${st.mtimeMs}|${st.size}`).digest('hex')

/**
 * Decide what a request for `abs` (already checked against the caller's rights) would produce. Throws 404
 * `thumb.unavailable` for a kind this machine can not make or a file that failed before, 422 `thumb.too-big`.
 */
export function planThumb(abs: string, stored: string, size: number): Plan {
  if (!THUMB_SIZES.includes(size as ThumbSize)) throw new HttpError(400, 'request.invalid')
  let st
  try { st = statSync(abs) } catch { throw notFound() }
  if (!st.isFile()) throw notFound()
  const kind = kindOf(abs)
  if (!kind || !thumbStatus()[kind]) throw unavailable()
  if (kind === 'image' && st.size > limits.maxImageBytes) throw tooBig()
  const key = cacheKey(stored, size, st)
  const bad = failed.get(key)
  if (bad) {
    if (bad.until > Date.now()) throw bad.code === 'thumb.too-big' ? tooBig() : unavailable()
    failed.delete(key)
  }
  const ext = kind === 'pdf' ? 'jpg' : 'webp'
  return { abs, key, kind, size: size as ThumbSize, ext, mime: ext === 'jpg' ? 'image/jpeg' : 'image/webp' }
}

const cachePath = (p: Plan) => join(paths.thumbs, `${p.key}.${p.ext}`)

/** a hit keeps the file young for the trimming: its mtime is touched, at most once an hour */
function cachedFile(p: Plan): string | null {
  const file = cachePath(p)
  let st
  try { st = statSync(file) } catch { return null }
  if (!st.isFile() || st.size === 0) return null
  if (Date.now() - st.mtimeMs > 3600_000) {
    try { utimesSync(file, new Date(), new Date()) } catch { /* read-only cache: it is only a hint */ }
  }
  return file
}

// ───────────── making one ─────────────

let running = 0
const waiting: (() => void)[] = []

async function inSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= limits.running) {
    if (waiting.length >= limits.queue) throw new HttpError(503, 'thumb.busy')
    // the place is handed over by whoever finishes: `running` stays as it is
    await new Promise<void>(resolve => waiting.push(resolve))
  } else running++
  try {
    return await fn()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else running--
  }
}

const inflight = new Map<string, Promise<string>>()

/** the cached file of the plan, made first when needed (the same thumbnail asked twice at once is made once) */
export function thumbFile(p: Plan): Promise<string> {
  const hit = cachedFile(p)
  if (hit) return Promise.resolve(hit)
  let job = inflight.get(p.key)
  if (!job) {
    job = inSlot(() => generate(p)).finally(() => inflight.delete(p.key))
    inflight.set(p.key, job)
  }
  return job
}

/** ffmpeg leaves a stub of a few bytes when it found no frame (a real picture is more than a 12 byte RIFF header) */
const EMPTY = 12
const sizeOf = (file: string) => { try { return statSync(file).size } catch { return 0 } }

async function generate(p: Plan): Promise<string> {
  const work = join(paths.thumbs, 'tmp')
  mkdirSync(work, { recursive: true })
  const id = randomBytes(8).toString('hex')
  // a plain name for the tool, whatever the file is called
  const ext = (extname(p.abs).toLowerCase().match(/^\.[a-z0-9]{1,5}$/) ?? ['.bin'])[0]
  const link = join(work, `in-${id}${ext}`)
  const out = join(work, `out-${id}.${p.ext}`)
  const deadline = Date.now() + limits.timeoutMs
  const left = () => deadline - Date.now()
  let transient = false
  const ran = async (argv: string[], capture = false) => {
    const r = await run(argv, left(), capture)
    if (r.transient) transient = true
    return r
  }
  try {
    let real: string
    try { real = realpathSync(p.abs) } catch { throw notFound() }
    symlinkSync(real, link)
    const N = String(p.size)

    if (p.kind === 'image') {
      // the size in pixels first: a small file can unpack to billions
      const head = await ran([toolPath.vipsheader!, link], true)
      const dims = /:\s*(\d+)x(\d+)\b/.exec(head.out)
      if (!head.ok || !dims) throw unavailable()
      if (Number(dims[1]) * Number(dims[2]) > limits.maxPixels) throw tooBig()
      const q = p.size === 256 ? 75 : 80
      // ">" = only ever make it smaller
      const r = await ran([toolPath.vipsthumbnail!, link, '--size', `${N}x${N}>`, '-o', `${out}[Q=${q},strip]`])
      if (!r.ok) throw unavailable()
    } else if (p.kind === 'pdf') {
      // the first page only; -singlefile writes <prefix>.jpg
      const r = await ran([toolPath.pdftoppm!, '-q', '-f', '1', '-l', '1', '-scale-to', N, '-jpeg', '-jpegopt', 'quality=80', '-singlefile', link, out.slice(0, -4)])
      if (!r.ok) throw unavailable()
    } else {
      const demux = VIDEO_DEMUX[ext] ?? VIDEO_DEMUX['.mp4']
      const scale = `scale=w='min(${N},iw)':h='min(${N},ih)':force_original_aspect_ratio=decrease`
      const base = [toolPath.ffmpeg!, '-nostdin', '-hide_banner', '-v', 'error', '-threads', '1', '-protocol_whitelist', 'file', '-f', demux]
      const tail = ['-i', link, '-an', '-sn', '-frames:v', '1', '-vf', scale, '-c:v', 'libwebp', '-quality', '75', '-y', out]
      // a frame at one second; a clip shorter than that gives nothing, so it is asked again for its first frame
      let r = await ran([...base, '-ss', '1', ...tail])
      if (r.ok && sizeOf(out) <= EMPTY) r = await ran([...base, ...tail])
      if (!r.ok) throw unavailable()
    }

    const size = sizeOf(out)
    if (size <= EMPTY || size > 8 * 1024 * 1024) throw unavailable()
    const file = cachePath(p)
    renameSync(out, file)
    return file
  } catch (err) {
    const verdict = err instanceof HttpError && (err.code === 'thumb.unavailable' || err.code === 'thumb.too-big')
    if (verdict && !(transient && err.code === 'thumb.unavailable')) {
      failed.set(p.key, { until: Date.now() + limits.failMs, code: err instanceof HttpError && err.code === 'thumb.too-big' ? 'thumb.too-big' : 'thumb.unavailable' })
    }
    if (failed.size > 5000) failed.clear()
    throw err
  } finally {
    rmSync(link, { force: true })
    rmSync(out, { force: true })
  }
}

// ───────────── the cache ─────────────

/** the cache is trimmed to `max` bytes (a tenth less, so it is not trimmed again an hour later), oldest use first; leftovers of killed runs go */
export async function pruneThumbs(max = config.thumbCacheMax): Promise<{ removed: number; bytes: number }> {
  if (!existsSync(paths.thumbs)) return { removed: 0, bytes: 0 }
  // work files of a run that was killed in the middle
  const tmp = join(paths.thumbs, 'tmp')
  if (existsSync(tmp)) {
    for (const n of await readdir(tmp)) {
      const st = await lstat(join(tmp, n)).catch(() => null)
      if (st && Date.now() - st.mtimeMs > 3600_000) await rm(join(tmp, n), { force: true })
    }
  }
  const files: { path: string; size: number; mtime: number }[] = []
  let total = 0
  const names = (await readdir(paths.thumbs)).filter(n => /\.(webp|jpg)$/.test(n))
  for (let i = 0; i < names.length; i += 200) {
    await Promise.all(names.slice(i, i + 200).map(async n => {
      const st = await stat(join(paths.thumbs, n)).catch(() => null)
      if (st?.isFile()) { files.push({ path: join(paths.thumbs, n), size: st.size, mtime: st.mtimeMs }); total += st.size }
    }))
  }
  if (total <= max) return { removed: 0, bytes: 0 }
  files.sort((a, b) => a.mtime - b.mtime)
  const target = max * 0.9
  let removed = 0
  let bytes = 0
  for (const f of files) {
    if (total <= target) break
    await rm(f.path, { force: true })
    total -= f.size
    bytes += f.size
    removed++
  }
  log.info('thumbs-pruned', { removed, bytes })
  return { removed, bytes }
}
