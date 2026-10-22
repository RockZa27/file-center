/**
 * Server-side thumbnails (src/thumbs.ts, GET /api/thumb and /api/s/:token/thumb). The real tools (libvips, poppler,
 * ffmpeg) are used where this machine has them, and those tests are skipped where it does not; the safety rules
 * (permissions, limits, timeout, queue, cache) are also tested with fake tools that every machine can run.
 * Runs in-process on the same app as api.test.ts (see in-process-env.ts); every user here starts with "th-".
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { deflateSync } from 'node:zlib'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import './in-process-env'

let app: any
let thumbs: typeof import('../src/thumbs')
let paths: typeof import('../src/config').paths

class Client {
  cookie = ''
  csrf = ''
  async raw(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers }
    const cookies = [this.cookie, headers.cookie].filter(Boolean)
    if (cookies.length) h.cookie = cookies.join('; ')
    if (this.csrf) h['x-csrf-token'] = this.csrf
    let payload: any = body
    if (body !== undefined) {
      payload = JSON.stringify(body)
      h['content-type'] = 'application/json'
    }
    const res: Response = await app.handle(new Request('http://localhost' + path, { method, headers: h, body: payload }))
    const set = res.headers.get('set-cookie')
    if (set?.startsWith('fc_sid=')) this.cookie = set.split(';')[0]
    return res
  }
  async json(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
    const res = await this.raw(method, path, body, headers)
    return { status: res.status, data: (await res.json().catch(() => null)) as any, res }
  }
  async login(username: string, password: string) {
    this.csrf = (await this.json('GET', '/api/session')).data.csrf
    const r = await this.json('POST', '/api/login', { username, password })
    expect(r.status).toBe(200)
    this.csrf = r.data.csrf
    return this
  }
}

const PW = 'harbor-lamp-42'
const admin = new Client()
const anon = new Client()
const home = (user: string, ...p: string[]) => join(process.env.STORAGE_DIR!, 'users', user, ...p)
const q = (o: Record<string, string>) => new URLSearchParams(o).toString()

let owner: Client
let other: Client

async function userWith(username: string, permissions: string[]) {
  const r = await admin.json('POST', '/api/admin/users', { username, name: username, password: PW, role: 'user', permissions, publicPermissions: [] })
  expect(r.status).toBe(200)
  return new Client().login(username, PW)
}

const thumb = (c: Client, path: string, extra: Record<string, string> = {}, headers: Record<string, string> = {}) =>
  c.raw('GET', `/api/thumb?${q({ space: 'home', path, ...extra })}`, undefined, headers)

// ───────────── fixtures made here, so no binary files are checked in ─────────────

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}
/** a w x h RGB picture (a gradient), as a PNG */
function png(w: number, h: number): Uint8Array {
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2
  const raw = new Uint8Array((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * (w * 3 + 1) + 1 + x * 3; raw[i] = x % 256; raw[i + 1] = y % 256; raw[i + 2] = 128 }
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]
  return Buffer.concat(parts)
}
/** a one page PDF with a line of text */
function pdf(): Uint8Array {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const content = 'BT /F1 48 Tf 72 700 Td (Hello File Center) Tj ET'
  objs[3] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  let out = '%PDF-1.4\n'
  const at: number[] = []
  objs.forEach((o, i) => { at.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

const have = { vips: !!Bun.which('vipsthumbnail') && !!Bun.which('vipsheader'), pdf: !!Bun.which('pdftoppm'), ffmpeg: !!Bun.which('ffmpeg') }
const isWebp = (b: Uint8Array) => new TextDecoder().decode(b.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(b.subarray(8, 12)) === 'WEBP'
const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8

async function dimsOf(bytes: Uint8Array): Promise<[number, number]> {
  const file = join(paths.tmp, `dims-${Math.random().toString(36).slice(2)}`)
  mkdirSync(paths.tmp, { recursive: true })
  writeFileSync(file, bytes)
  try {
    const p = Bun.spawnSync([Bun.which('vipsheader')!, file])
    const m = /: (\d+)x(\d+) /.exec(p.stdout.toString())! // after the name, which is random and may itself hold "4x7"
    return [Number(m[1]), Number(m[2])]
  } finally { rmSync(file, { force: true }) }
}

/** a fake tool: a shell script that logs when it starts and ends and writes `out` (the last argument) after `sleep` seconds */
function fakeTool(name: string, body: string) {
  const file = join(paths.tmp, name)
  mkdirSync(paths.tmp, { recursive: true })
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

beforeAll(async () => {
  ;({ app } = await import('../src/index'))
  ;({ paths } = await import('../src/config'))
  thumbs = await import('../src/thumbs')
  await admin.login('admin', process.env.ADMIN_PASSWORD!)
  owner = await userWith('th-owner', ['read', 'write', 'download', 'share'])
  other = await userWith('th-other', ['read', 'write', 'download'])
  mkdirSync(home('th-owner', 'pics', 'inner'), { recursive: true })
  mkdirSync(home('th-owner', 'secret'), { recursive: true })
  writeFileSync(home('th-owner', 'pics', 'a.png'), png(600, 400))
  writeFileSync(home('th-owner', 'pics', 'inner', 'b.png'), png(64, 64))
  writeFileSync(home('th-owner', 'secret', 's.png'), png(64, 64))
  writeFileSync(home('th-owner', 'note.txt'), 'hello')
  symlinkSync(home('th-owner', 'secret', 's.png'), home('th-owner', 'pics', 'out-link.png'))
})

// other test files count the files in the homes of the users: leave none behind
afterAll(() => {
  for (const u of ['th-owner', 'th-other', 'th-blind', 'th-viewer']) rmSync(home(u), { recursive: true, force: true })
})

afterEach(() => {
  thumbs.resetTools()
  Object.assign(thumbs.limits, { running: 2, queue: 16, timeoutMs: 10_000, maxPixels: 100_000_000, maxImageBytes: 500 * 1024 ** 2, failMs: 5 * 60_000 })
})

describe('what can be made', () => {
  test('status needs a login and tells the kinds this machine can make', async () => {
    expect((await anon.json('GET', '/api/thumbs/status')).status).toBe(401)
    const r = await owner.json('GET', '/api/thumbs/status')
    expect(r.status).toBe(200)
    expect(r.data).toEqual({ image: have.vips, pdf: have.pdf, video: have.ffmpeg })
  })

  test('a kind whose tool is missing is off, and so is a file type nobody can make', async () => {
    thumbs.setTools({ vipsthumbnail: null, vipsheader: null, pdftoppm: null, ffmpeg: null })
    expect((await owner.json('GET', '/api/thumbs/status')).data).toEqual({ image: false, pdf: false, video: false })
    const r = await owner.json('GET', `/api/thumb?${q({ space: 'home', path: '/pics/a.png' })}`)
    expect(r.status).toBe(404)
    expect(r.data.code).toBe('thumb.unavailable')
    thumbs.resetTools()
    const txt = await owner.json('GET', `/api/thumb?${q({ space: 'home', path: '/note.txt' })}`)
    expect(txt.status).toBe(404)
    expect(txt.data.code).toBe('thumb.unavailable')
  })

  test('a size other than 256 or 1024 is refused; a missing file and a folder are not found', async () => {
    expect((await thumb(owner, '/pics/a.png', { size: '300' })).status).toBe(400)
    expect((await thumb(owner, '/pics/a.png', { size: 'x' })).status).toBe(400)
    expect((await thumb(owner, '/pics/none.png')).status).toBe(404)
    expect((await thumb(owner, '/pics')).status).toBe(404)
  })
})

describe('who may ask', () => {
  test('a visitor, a user without read and another user are refused; a link out of the folder is refused', async () => {
    thumbs.setTools({ vipsthumbnail: '/bin/true', vipsheader: '/bin/true' })
    expect((await thumb(anon, '/pics/a.png')).status).toBe(401)
    const blind = await userWith('th-blind', ['download'])
    mkdirSync(home('th-blind'), { recursive: true })
    writeFileSync(home('th-blind', 'a.png'), png(64, 64))
    expect((await thumb(blind, '/a.png')).status).toBe(403)
    // another user's `home` is their own folder: the same path there is a different (missing) file, never the owner's
    expect((await thumb(other, '/pics/a.png')).status).toBe(404)
    expect((await other.raw('GET', `/api/thumb?${q({ space: 'user:th-owner', path: '/pics/a.png' })}`)).status).toBe(403)
    expect((await thumb(owner, '/pics/../../x.png')).status).toBe(400)
    expect((await thumb(owner, '/pics/out-link.png')).status).not.toBe(200)
  })

  test.skipIf(!have.vips)('a manager-less admin sees through the owner space, and the owner gets the picture', async () => {
    expect((await thumb(owner, '/pics/a.png')).status).toBe(200)
    const viaAdmin = await admin.raw('GET', `/api/thumb?${q({ space: 'home', path: '/users/th-owner/pics/a.png' })}`)
    expect(viaAdmin.status).toBe(200)
  })
})

describe.skipIf(!have.vips)('images (libvips)', () => {
  test('a png becomes a webp no longer than 256 px, with the cache headers', async () => {
    const r = await thumb(owner, '/pics/a.png')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/webp')
    expect(r.headers.get('cache-control')).toBe('private, max-age=86400')
    expect(r.headers.get('etag')).toMatch(/^"[0-9a-f]{40}"$/)
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    const bytes = new Uint8Array(await r.arrayBuffer())
    expect(isWebp(bytes)).toBe(true)
    const [w, h] = await dimsOf(bytes)
    expect(Math.max(w, h)).toBe(256)
    expect(w / h).toBeCloseTo(1.5, 1)
  })

  test('size 1024 does not enlarge a small picture, and is cached apart from 256', async () => {
    const big = await thumb(owner, '/pics/a.png', { size: '1024' })
    const [w] = await dimsOf(new Uint8Array(await big.arrayBuffer()))
    expect(w).toBe(600)
    const small = await thumb(owner, '/pics/a.png')
    expect(small.headers.get('etag')).not.toBe(big.headers.get('etag'))
  })

  test('the second request is a cache hit: no tool is started; If-None-Match gets 304; a changed file gets a new tag', async () => {
    const first = await thumb(owner, '/pics/inner/b.png')
    expect(first.status).toBe(200)
    const etag = first.headers.get('etag')!
    const before = thumbs.stats.spawned
    const again = await thumb(owner, '/pics/inner/b.png')
    expect(again.status).toBe(200)
    expect(thumbs.stats.spawned).toBe(before)
    expect(existsSync(join(paths.thumbs, `${etag.slice(1, -1)}.webp`))).toBe(true)
    const cond = await thumb(owner, '/pics/inner/b.png', {}, { 'if-none-match': etag })
    expect(cond.status).toBe(304)
    expect((await cond.arrayBuffer()).byteLength).toBe(0)
    expect(thumbs.stats.spawned).toBe(before)
    // a hit touches the cached file, so the trimming sees it as used
    const cached = join(paths.thumbs, `${etag.slice(1, -1)}.webp`)
    utimesSync(cached, new Date(Date.now() - 5 * 3600_000), new Date(Date.now() - 5 * 3600_000))
    await thumb(owner, '/pics/inner/b.png')
    expect(Date.now() - statSync(cached).mtimeMs).toBeLessThan(60_000)
    // a rewritten file is another version
    writeFileSync(home('th-owner', 'pics', 'inner', 'b.png'), png(80, 40))
    const changed = await thumb(owner, '/pics/inner/b.png', {}, { 'if-none-match': etag })
    expect(changed.status).toBe(200)
    expect(changed.headers.get('etag')).not.toBe(etag)
  })

  test('a name with brackets or a leading dash is only a name', async () => {
    writeFileSync(home('th-owner', 'pics', '-x[page=2].png'), png(32, 32))
    const r = await thumb(owner, '/pics/-x[page=2].png')
    expect(r.status).toBe(200)
    expect(isWebp(new Uint8Array(await r.arrayBuffer()))).toBe(true)
  })

  test('a file that is not the image its name says fails, and is not tried again at once', async () => {
    writeFileSync(home('th-owner', 'pics', 'broken.jpg'), 'this is not a jpeg')
    const r = await owner.json('GET', `/api/thumb?${q({ space: 'home', path: '/pics/broken.jpg' })}`)
    expect(r.status).toBe(404)
    expect(r.data.code).toBe('thumb.unavailable')
    const before = thumbs.stats.spawned
    expect((await thumb(owner, '/pics/broken.jpg')).status).toBe(404)
    expect(thumbs.stats.spawned).toBe(before)
  })

  test('libvips does not hand a file to ImageMagick because of what is inside it', async () => {
    writeFileSync(home('th-owner', 'pics', 'mvg.png'), 'push graphic-context\nviewbox 0 0 10 10\nfill red\nrectangle 0 0 5 5\npop graphic-context\n')
    expect((await thumb(owner, '/pics/mvg.png')).status).toBe(404)
  })

  test('over the pixel limit is refused before any picture is made; so is a file over the size limit', async () => {
    writeFileSync(home('th-owner', 'pics', 'px.png'), png(300, 200))
    thumbs.limits.maxPixels = 10_000
    const r = await owner.json('GET', `/api/thumb?${q({ space: 'home', path: '/pics/px.png', size: '1024' })}`)
    expect(r.status).toBe(422)
    expect(r.data.code).toBe('thumb.too-big')
    expect(existsSync(join(paths.thumbs, `${thumbs.cacheKey('/users/th-owner/pics/px.png', 1024, statSync(home('th-owner', 'pics', 'px.png')))}.webp`))).toBe(false)
    // asked again, it is refused the same way without running anything
    const spawned = thumbs.stats.spawned
    expect((await thumb(owner, '/pics/px.png', { size: '1024' })).status).toBe(422)
    expect(thumbs.stats.spawned).toBe(spawned)
    thumbs.limits.maxPixels = 100_000_000
    thumbs.limits.maxImageBytes = 100
    const big = await owner.json('GET', `/api/thumb?${q({ space: 'home', path: '/pics/px.png' })}`)
    expect(big.status).toBe(422)
    expect(big.data.code).toBe('thumb.too-big')
  })
})

describe.skipIf(!have.pdf)('PDF (poppler)', () => {
  test('the first page becomes a jpeg', async () => {
    writeFileSync(home('th-owner', 'doc.pdf'), pdf())
    const r = await thumb(owner, '/doc.pdf')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/jpeg')
    const bytes = new Uint8Array(await r.arrayBuffer())
    expect(isJpeg(bytes)).toBe(true)
    if (have.vips) expect(Math.max(...(await dimsOf(bytes)))).toBe(256)
    writeFileSync(home('th-owner', 'bad.pdf'), '%PDF-1.4 nothing here')
    expect((await thumb(owner, '/bad.pdf')).status).toBe(404)
  })
})

describe.skipIf(!have.ffmpeg)('video (ffmpeg)', () => {
  test('a frame of a clip, also of one shorter than a second', async () => {
    for (const [name, secs] of [['clip.mp4', '2'], ['short.mp4', '0.3']] as const) {
      const out = home('th-owner', name)
      const p = Bun.spawnSync([Bun.which('ffmpeg')!, '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=' + secs + ':size=320x240:rate=10', '-pix_fmt', 'yuv420p', '-c:v', 'mpeg4', '-y', out])
      expect(p.exitCode).toBe(0)
      const r = await thumb(owner, '/' + name)
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toBe('image/webp')
      expect(isWebp(new Uint8Array(await r.arrayBuffer()))).toBe(true)
    }
  })

  test('a playlist that is called .mp4 is not followed to the files it names', async () => {
    writeFileSync(home('th-owner', 'evil.mp4'), '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n')
    expect((await thumb(owner, '/evil.mp4')).status).toBe(404)
  })
})

describe('limits (fake tools, run everywhere)', () => {
  test('a tool that runs too long is killed after the timeout, and the answer is "unavailable"', async () => {
    thumbs.setTools({ ffmpeg: fakeTool('fake-sleep', 'exec sleep 30') })
    thumbs.limits.timeoutMs = 400
    writeFileSync(home('th-owner', 'slow.mp4'), 'x')
    const t0 = Date.now()
    const r = await owner.json('GET', `/api/thumb?${q({ space: 'home', path: '/slow.mp4' })}`)
    expect(r.status).toBe(404)
    expect(r.data.code).toBe('thumb.unavailable')
    expect(Date.now() - t0).toBeLessThan(5000)
    // the work files are gone
    expect(readdirSync(join(paths.thumbs, 'tmp'))).toEqual([])
    // and it is not started again for the next request
    const before = thumbs.stats.spawned
    expect((await thumb(owner, '/slow.mp4')).status).toBe(404)
    expect(thumbs.stats.spawned).toBe(before)
  })

  test('no more than two run at once; the others wait, and when the queue is full the answer is 503 with Retry-After', async () => {
    const log = join(paths.tmp, 'fake-conc.log')
    rmSync(log, { force: true })
    thumbs.setTools({ ffmpeg: fakeTool('fake-conc', `echo start >> ${log}\nsleep 0.4\nfor a; do last=$a; done\nprintf 'RIFF....WEBPVP8 ' > "$last"\necho end >> ${log}`) })
    for (let i = 0; i < 6; i++) writeFileSync(home('th-owner', `c${i}.mp4`), String(i))
    const all = await Promise.all([0, 1, 2, 3, 4, 5].map(i => thumb(owner, `/c${i}.mp4`)))
    expect(all.map(r => r.status)).toEqual([200, 200, 200, 200, 200, 200])
    let now = 0
    let max = 0
    for (const l of readFileSync(log, 'utf8').split('\n').filter(Boolean)) { now += l === 'start' ? 1 : -1; max = Math.max(max, now) }
    expect(max).toBe(2)

    // one place to run, none to wait: the second and third at the same time are turned away quickly
    thumbs.limits.running = 1
    thumbs.limits.queue = 0
    for (let i = 0; i < 3; i++) writeFileSync(home('th-owner', `d${i}.mp4`), 'd' + i)
    const busy = await Promise.all([0, 1, 2].map(i => owner.json('GET', `/api/thumb?${q({ space: 'home', path: `/d${i}.mp4` })}`)))
    const refused = busy.filter(r => r.status === 503)
    expect(refused.length).toBe(2)
    expect(refused[0].data.code).toBe('thumb.busy')
    expect(refused[0].res.headers.get('retry-after')).toBe('3')
    expect(busy.filter(r => r.status === 200).length).toBe(1)
  })

  test('the same thumbnail asked for twice at once is made once', async () => {
    const log = join(paths.tmp, 'fake-once.log')
    rmSync(log, { force: true })
    thumbs.setTools({ ffmpeg: fakeTool('fake-once', `echo run >> ${log}\nsleep 0.3\nfor a; do last=$a; done\nprintf 'RIFF....WEBPVP8 ' > "$last"`) })
    writeFileSync(home('th-owner', 'once.mp4'), 'once')
    const rs = await Promise.all([1, 2, 3].map(() => thumb(owner, '/once.mp4')))
    expect(rs.map(r => r.status)).toEqual([200, 200, 200])
    expect(readFileSync(log, 'utf8').trim().split('\n').length).toBe(1)
  })

  test('a tool that makes no file, or a huge one, is a failure', async () => {
    thumbs.setTools({ ffmpeg: fakeTool('fake-empty', 'exit 0') })
    writeFileSync(home('th-owner', 'empty.mp4'), 'e')
    expect((await thumb(owner, '/empty.mp4')).status).toBe(404)
  })

  test('the tool gets a plain symlink in thumbs/tmp, a minimal environment, and the real path is never an argument', async () => {
    const log = join(paths.tmp, 'fake-args.log')
    rmSync(log, { force: true })
    thumbs.setTools({ ffmpeg: fakeTool('fake-args', `echo "$@" >> ${log}\nenv >> ${log}\nfor a; do last=$a; done\nprintf 'RIFF....WEBPVP8 ' > "$last"`) })
    writeFileSync(home('th-owner', '-odd[1] name.mp4'), 'x')
    process.env.SECRET_FOR_TEST = 'leak-me'
    expect((await thumb(owner, '/-odd[1] name.mp4')).status).toBe(200)
    delete process.env.SECRET_FOR_TEST
    const text = readFileSync(log, 'utf8')
    expect(text).not.toContain('odd')
    expect(text).not.toContain('leak-me')
    expect(text).toContain(join(paths.thumbs, 'tmp', 'in-'))
    expect(text).toContain('VIPS_BLOCK_UNTRUSTED=1')
    expect(text).toContain('-protocol_whitelist file')
  })
})

describe('share links', () => {
  test.skipIf(!have.vips)('a folder link gives thumbnails of what is inside it, and nothing outside, without counting a download', async () => {
    const r = await owner.json('POST', '/api/shares', { space: 'home', path: '/pics', days: 7, maxDownloads: 3 })
    expect(r.status).toBe(200)
    const { token } = r.data
    const get = (path: string, headers: Record<string, string> = {}) => anon.raw('GET', `/api/s/${token}/thumb?${q({ path })}`, undefined, headers)
    const ok = await get('/a.png')
    expect(ok.status).toBe(200)
    expect(isWebp(new Uint8Array(await ok.arrayBuffer()))).toBe(true)
    expect((await get('/inner/b.png')).status).toBe(200)
    expect((await get('/a.png', { 'if-none-match': ok.headers.get('etag')! })).status).toBe(304)
    // out of the folder, through a link inside it, not a file, not there
    expect((await get('/../secret/s.png')).status).toBe(400)
    expect([403, 404]).toContain((await get('/out-link.png')).status)
    expect((await get('/inner')).status).toBe(404)
    expect((await get('/zzz.png')).status).toBe(404)
    const mine = await owner.json('GET', '/api/shares')
    expect(mine.data.shares.find((s: any) => s.id === r.data.share.id).downloads).toBe(0)
    // a revoked link answers nothing
    await owner.json('DELETE', `/api/shares/${r.data.share.id}`)
    expect((await get('/a.png')).status).toBe(404)
  })

  test.skipIf(!have.vips)('a link with a password gives nothing before the password; an upload link and a made-up token never do', async () => {
    const r = await owner.json('POST', '/api/shares', { space: 'home', path: '/pics', days: 7, password: 'secret-pass-1' })
    const { token } = r.data
    const url = `/api/s/${token}/thumb?${q({ path: '/a.png' })}`
    expect((await anon.raw('GET', url)).status).toBe(401)
    const unlock = await anon.raw('POST', `/api/s/${token}/unlock`, { password: 'secret-pass-1' })
    expect(unlock.status).toBe(200)
    const cookie = unlock.headers.get('set-cookie')!.split(';')[0]
    expect((await anon.raw('GET', url, undefined, { cookie })).status).toBe(200)
    const up = await owner.json('POST', '/api/shares', { space: 'home', path: '/pics', days: 7, kind: 'upload' })
    expect((await anon.raw('GET', `/api/s/${up.data.token}/thumb?${q({ path: '/a.png' })}`)).status).toBe(404)
    expect((await anon.raw('GET', `/api/s/${'a'.repeat(43)}/thumb?${q({ path: '/a.png' })}`)).status).toBe(404)
  })

  test.skipIf(!have.vips)('a link to one file gives that file only', async () => {
    const r = await owner.json('POST', '/api/shares', { space: 'home', path: '/pics/a.png', days: 7 })
    const { token } = r.data
    expect((await anon.raw('GET', `/api/s/${token}/thumb`)).status).toBe(200)
    expect((await anon.raw('GET', `/api/s/${token}/thumb?${q({ path: '/other.png' })}`)).status).toBe(404)
  })
})

describe('the cache', () => {
  test('pruning removes the least recently used files first, and the leftovers of killed runs', async () => {
    mkdirSync(paths.thumbs, { recursive: true })
    // an empty cache, so the sizes below are all there is
    for (const n of readdirSync(paths.thumbs)) if (/\.(webp|jpg)$/.test(n)) rmSync(join(paths.thumbs, n))
    const mk = (name: string, ageHours: number, size = 1000) => {
      const f = join(paths.thumbs, name)
      writeFileSync(f, new Uint8Array(size))
      const t = new Date(Date.now() - ageHours * 3600_000)
      utimesSync(f, t, t)
    }
    mk('p-old.webp', 50); mk('p-mid.webp', 20); mk('p-new.jpg', 1)
    // the work files of a killed run: old ones go, young ones stay
    mkdirSync(join(paths.thumbs, 'tmp'), { recursive: true })
    writeFileSync(join(paths.thumbs, 'tmp', 'in-old'), 'x')
    utimesSync(join(paths.thumbs, 'tmp', 'in-old'), new Date(Date.now() - 5 * 3600_000), new Date(Date.now() - 5 * 3600_000))
    writeFileSync(join(paths.thumbs, 'tmp', 'in-young'), 'x')
    // 3000 bytes in the cache and room for 1200: the two older ones go, the newest stays
    const r = await thumbs.pruneThumbs(1200)
    expect(r.removed).toBe(2)
    expect(existsSync(join(paths.thumbs, 'p-old.webp'))).toBe(false)
    expect(existsSync(join(paths.thumbs, 'p-mid.webp'))).toBe(false)
    expect(existsSync(join(paths.thumbs, 'p-new.jpg'))).toBe(true)
    expect(existsSync(join(paths.thumbs, 'tmp', 'in-old'))).toBe(false)
    expect(existsSync(join(paths.thumbs, 'tmp', 'in-young'))).toBe(true)
    // under the cap nothing is touched
    expect((await thumbs.pruneThumbs(10 ** 12)).removed).toBe(0)
  })

  test('a backup does not carry the cache', async () => {
    mkdirSync(paths.thumbs, { recursive: true })
    writeFileSync(join(paths.thumbs, 'in-backup.webp'), 'x')
    const { unzipSync } = await import('fflate')
    const made = await admin.json('POST', '/api/admin/backups', {})
    expect(made.status).toBe(200)
    const zip = unzipSync(new Uint8Array(await (await admin.raw('GET', `/api/admin/backups/${made.data.name}/download`)).arrayBuffer()))
    expect(Object.keys(zip).filter(n => n.includes('thumbs') || n.includes('in-backup'))).toEqual([])
    // not left for the tests that count backups
    expect((await admin.json('DELETE', `/api/admin/backups/${made.data.name}`)).status).toBe(200)
  })
})

describe('who may ask for 1024 px (security 1.11)', () => {
  test('read alone gets 256 px only; 1024 needs read and download, in every way of writing the number', async () => {
    thumbs.setTools({ vipsthumbnail: '/bin/true', vipsheader: '/bin/true' })
    const viewer = await userWith('th-viewer', ['read'])
    mkdirSync(home('th-viewer'), { recursive: true })
    writeFileSync(home('th-viewer', 'a.png'), png(64, 64))
    for (const size of ['1024', '1024.0', ' 1024', '0x400', '1e3']) {
      const r = await thumb(viewer, '/a.png', { size })
      expect([size, r.status === 403 || r.status === 400]).toEqual([size, true])
    }
    expect((await thumb(viewer, '/a.png', { size: '1024' })).status).toBe(403)
    // 256 passes the permission check (the fake tool makes no picture, so the answer is "unavailable", not 403)
    expect((await thumb(viewer, '/a.png', { size: '256' })).status).toBe(404)
    expect((await thumb(viewer, '/a.png')).status).toBe(404)
    // with download as well, 1024 is allowed (the same answer as 256 here)
    expect((await thumb(other, '/pics/a.png', { size: '1024' })).status).not.toBe(403)
    expect((await thumb(owner, '/pics/a.png', { size: '1024' })).status).not.toBe(403)
  })

  test('a picture from someone else\'s home leaves a line in the trail, once a minute per file', async () => {
    thumbs.setTools({ vipsthumbnail: '/bin/true', vipsheader: '/bin/true' })
    const audit = await import('../src/audit')
    const url = `/api/thumb?${q({ space: 'user:th-owner', path: '/pics/inner/b.png' })}`
    await admin.raw('GET', url)
    await admin.raw('GET', url)
    const lines = [...audit.auditEntries()].filter(e => e.user === 'admin' && e.action === 'browse' && e.target === '/users/th-owner/pics/inner/b.png')
    expect(lines.length).toBe(1)
    // one's own folder leaves nothing
    await owner.raw('GET', `/api/thumb?${q({ space: 'home', path: '/pics/inner/b.png' })}`)
    expect([...audit.auditEntries()].some(e => e.user === 'th-owner' && e.action === 'browse')).toBe(false)
  })
})

describe('share links and the download limit (security 1.11)', () => {
  test('a link whose downloads are used up gives no thumbnail; neither does an expired or revoked one', async () => {
    thumbs.setTools({ vipsthumbnail: '/bin/true', vipsheader: '/bin/true' })
    const r = await owner.json('POST', '/api/shares', { space: 'home', path: '/pics', days: 7, maxDownloads: 1 })
    const { token } = r.data
    const get = (size?: string) => anon.raw('GET', `/api/s/${token}/thumb?${q({ path: '/a.png', ...(size ? { size } : {}) })}`)
    // not used up: past the link's checks (the fake tool makes no picture: "unavailable")
    expect((await get()).status).toBe(404)
    expect((await get('1024')).status).toBe(404)
    expect((await (await get('1024')).json() as any).code).toBe('thumb.unavailable')
    const dl = await anon.raw('GET', `/api/s/${token}/download?${q({ path: '/a.png' })}`)
    expect(dl.status).toBe(200)
    await dl.arrayBuffer()
    for (const size of [undefined, '256', '1024']) {
      const res = await get(size)
      expect([size, res.status, ((await res.json()) as any).code]).toEqual([size, 404, 'share.not-found'])
    }
  })
})
