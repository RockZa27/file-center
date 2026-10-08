/**
 * Load test for a File Center instance. Point it at a test instance only, never at real data.
 *
 *   BASE=http://127.0.0.1:3101 FC_USER=admin FC_PASS=... WORK=/work bun scripts/loadtest.ts <step> [...]
 *
 * WORK must hold src.bin, the file to upload (for example: head -c 5G /dev/urandom > src.bin).
 * Steps (run in this order, each prints one JSON line):
 *   big            upload src.bin to /load/big.bin, download it again, compare sha256
 *   range          random Range requests against src.bin
 *   batch          multi-file download (zip stream) of /load/big.bin + a small file, saved to WORK/batch.zip
 *   zip            server-side zip of /load/big.bin, then unzip that archive again
 *   unzip          unzip /load/big-archive.zip (made by "zip") once more
 *   many           list and search a folder with FILES files (default 20,000) created through the API's disk (FCDATA)
 *   parallel       3 users upload 1 GB each at the same time
 *   restart-start  begin a 1 GB upload, send half of it, save the state in WORK/restart.json
 *   restart-end    finish the upload saved by restart-start (run after restarting the server)
 *   reserve        an upload must be refused with 507 (run against an instance started with a huge MIN_FREE_SPACE)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.BASE ?? 'http://127.0.0.1:3101'
const WORK = process.env.WORK ?? '/work'
const SRC = join(WORK, 'src.bin')
const GB = 1024 ** 3
const MB = 1024 ** 2

class Client {
  cookie = ''
  csrf = ''
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers, 'x-csrf-token': this.csrf }
    if (this.cookie) h.cookie = this.cookie
    let payload: BodyInit | undefined
    if (body instanceof Uint8Array || body instanceof ArrayBuffer) payload = body as BodyInit
    else if (body !== undefined) {
      payload = JSON.stringify(body)
      h['content-type'] = 'application/json'
    }
    const res = await fetch(BASE + path, { method, headers: h, body: payload })
    const set = res.headers.get('set-cookie')
    if (set) this.cookie = set.split(';')[0]
    return res
  }
  async json(method: string, path: string, body?: unknown) {
    const res = await this.req(method, path, body)
    const data: any = await res.json().catch(() => null)
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data?.error ?? ''}`)
    return data
  }
  async login(username: string, password: string) {
    this.csrf = (await this.json('GET', '/api/session')).csrf
    this.csrf = (await this.json('POST', '/api/login', { username, password })).csrf
    return this
  }
}

const admin = () => new Client().login(process.env.FC_USER ?? 'admin', process.env.FC_PASS ?? '')
const secs = (t0: number) => (performance.now() - t0) / 1000
const rate = (bytes: number, s: number) => `${(bytes / MB / s).toFixed(0)} MB/s`
const out = (step: string, data: Record<string, unknown>) => console.log(JSON.stringify({ step, ...data }))

async function sha256File(path: string, start = 0, end?: number) {
  const h = new Bun.CryptoHasher('sha256')
  for await (const chunk of Bun.file(path).slice(start, end).stream() as unknown as AsyncIterable<Uint8Array>) h.update(chunk)
  return h.digest('hex')
}

async function sha256Body(res: Response) {
  const h = new Bun.CryptoHasher('sha256')
  let n = 0
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    h.update(chunk)
    n += chunk.length
  }
  return { sha: h.digest('hex'), bytes: n }
}

/** chunked upload of src[start, start+size) the way the web app does it: `parallel` chunks in flight */
async function upload(c: Client, opts: { space?: string; dir: string; name: string; start?: number; size: number; parallel?: number; only?: (i: number) => boolean; id?: string }) {
  const start = opts.start ?? 0
  const init = opts.id
    ? { id: opts.id, ...(await c.json('GET', `/api/upload/${opts.id}`)), chunkSize: Number(process.env.CHUNK ?? 8 * MB) }
    : await c.json('POST', '/api/upload', { space: opts.space ?? 'home', path: opts.dir, name: opts.name, size: opts.size })
  const { id, chunkSize, total } = init
  const have = new Set<number>(init.received ?? [])
  const queue = [...Array(total).keys()].filter(i => !have.has(i) && (opts.only ? opts.only(i) : true))
  let retries = 0
  const worker = async () => {
    for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
      const a = start + i * chunkSize
      const b = start + Math.min(opts.size, (i + 1) * chunkSize)
      const data = new Uint8Array(await Bun.file(SRC).slice(a, b).arrayBuffer())
      for (let attempt = 0; ; attempt++) {
        const res = await c.req('PUT', `/api/upload/${id}/${i}`, data, { 'content-type': 'application/octet-stream' })
        if (res.ok) break
        if (attempt >= 3 || res.status < 500) throw new Error(`chunk ${i} -> ${res.status} ${await res.text()}`)
        retries++
      }
    }
  }
  await Promise.all(Array.from({ length: opts.parallel ?? 3 }, worker))
  return { id, total, retries }
}

async function complete(c: Client, id: string) {
  return c.json('POST', `/api/upload/${id}/complete`)
}

const steps: Record<string, () => Promise<void>> = {
  async big() {
    const c = await admin()
    await c.req('POST', '/api/mkdir', { space: 'home', path: '/', name: 'load' })
    const size = Bun.file(SRC).size
    let t0 = performance.now()
    const want = await sha256File(SRC)
    const hashSecs = secs(t0)
    t0 = performance.now()
    const { id, retries } = await upload(c, { dir: '/load', name: 'big.bin', size })
    const done = await complete(c, id)
    const upSecs = secs(t0)
    t0 = performance.now()
    const res = await c.req('GET', '/api/download?space=home&path=/load/big.bin')
    const got = await sha256Body(res)
    const downSecs = secs(t0)
    out('big', {
      size, completed: done.size === size, retries, upload: rate(size, upSecs), uploadSecs: upSecs.toFixed(1),
      download: rate(got.bytes, downSecs), downloadSecs: downSecs.toFixed(1), sameSha: got.sha === want, hashSecs: hashSecs.toFixed(1),
    })
  },

  async range() {
    const c = await admin()
    const size = Bun.file(SRC).size
    const src = Bun.file(SRC)
    let ok = 0
    const bad: string[] = []
    const t0 = performance.now()
    for (let i = 0; i < 30; i++) {
      const len = 1 + Math.floor(Math.random() * 4 * MB)
      const a = i === 0 ? size - len : Math.floor(Math.random() * (size - len)) // first one hits the end of the file
      const res = await c.req('GET', '/api/download?space=home&path=/load/big.bin', undefined, { range: `bytes=${a}-${a + len - 1}` })
      const body = new Uint8Array(await res.arrayBuffer())
      const want = new Uint8Array(await src.slice(a, a + len).arrayBuffer())
      if (res.status === 206 && Buffer.compare(body, want) === 0) ok++
      else bad.push(`${a}+${len}: ${res.status}`)
    }
    // a range far past 4 GB, where 32-bit offsets would break
    const far = Math.min(size - 1024, 4.5 * GB)
    const res = await c.req('GET', '/api/download?space=home&path=/load/big.bin', undefined, { range: `bytes=${far}-${far + 1023}` })
    const farOk = Buffer.compare(new Uint8Array(await res.arrayBuffer()), new Uint8Array(await src.slice(far, far + 1024).arrayBuffer())) === 0
    out('range', { ok, of: 30, bad, beyond4GB: farOk, secs: secs(t0).toFixed(1) })
  },

  async batch() {
    const c = await admin()
    await c.req('POST', '/api/newfile', { space: 'home', path: '/load', name: 'small.txt' })
    await c.req('PUT', '/api/content', { space: 'home', path: '/load/small.txt', content: 'สวัสดี small file\n'.repeat(1000) })
    const { token } = await c.json('POST', '/api/batch', { space: 'home', path: '/load', items: ['big.bin', 'small.txt'] })
    const t0 = performance.now()
    const res = await c.req('GET', `/api/batch/${token}`)
    const bytes = await Bun.write(join(WORK, 'batch.zip'), res)
    out('batch', { status: res.status, bytes, rate: rate(bytes, secs(t0)), secs: secs(t0).toFixed(1) })
  },

  async zip() {
    const c = await admin()
    let t0 = performance.now()
    const z = await c.json('POST', '/api/zip', { space: 'home', path: '/load', items: ['big.bin'], name: 'big-archive.zip' })
    const zipSecs = secs(t0)
    t0 = performance.now()
    const u = await c.req('POST', '/api/unzip', { space: 'home', path: `/load/${z.name}` })
    const unzipBody: any = await u.json()
    out('zip', { archive: z.name, zipSecs: zipSecs.toFixed(1), unzipStatus: u.status, unzip: unzipBody, unzipSecs: secs(t0).toFixed(1) })
  },

  async unzip() {
    const c = await admin()
    const t0 = performance.now()
    const u = await c.req('POST', '/api/unzip', { space: 'home', path: '/load/big-archive.zip' })
    out('unzip', { status: u.status, body: await u.json().catch(() => null), secs: secs(t0).toFixed(1) })
  },

  async many() {
    const n = Number(process.env.FILES ?? 20_000)
    const data = process.env.FCDATA ?? '/fcdata'
    const dir = join(data, 'storage', 'load', 'many')
    let t0 = performance.now()
    for (let d = 0; d < n / 1000; d++) {
      mkdirSync(join(dir, `group-${d}`), { recursive: true })
      for (let i = 0; i < 1000; i++) writeFileSync(join(dir, `group-${d}`, `file-${d * 1000 + i}.txt`), String(i))
    }
    // and one flat folder with every file side by side
    mkdirSync(join(dir, 'flat'), { recursive: true })
    for (let i = 0; i < n; i++) writeFileSync(join(dir, 'flat', `flat-${i}.txt`), '')
    const createSecs = secs(t0)
    const c = await admin()
    t0 = performance.now()
    const flat = await c.json('GET', '/api/list?space=home&path=/load/many/flat')
    const listSecs = secs(t0)
    const listBytes = JSON.stringify(flat).length
    t0 = performance.now()
    const hit = await c.json('GET', '/api/search?space=home&q=file-19999')
    const searchSecs = secs(t0)
    t0 = performance.now()
    const miss = await c.json('GET', '/api/search?space=home&q=no-such-name')
    const missSecs = secs(t0)
    t0 = performance.now()
    const status = await c.json('GET', '/api/admin/status')
    out('many', {
      files: n * 2, createSecs: createSecs.toFixed(1),
      list: { entries: flat.entries.length, secs: listSecs.toFixed(2), jsonKB: Math.round(listBytes / 1024) },
      search: { found: hit.results.length, truncated: hit.truncated, secs: searchSecs.toFixed(2) },
      searchMiss: { truncated: miss.truncated, secs: missSecs.toFixed(2) },
      status: { files: status.storage.files, secs: secs(t0).toFixed(2) },
    })
  },

  async parallel() {
    const a = await admin()
    const users = ['load-1', 'load-2', 'load-3']
    for (const u of users) {
      await a.req('POST', '/api/admin/users', {
        username: u, name: u, password: 'load-test-password', role: 'user', permissions: ['read', 'write', 'upload', 'download'], publicPermissions: [],
      })
    }
    const clients = await Promise.all(users.map(u => new Client().login(u, 'load-test-password')))
    const size = Math.min(GB, Bun.file(SRC).size)
    const want = await sha256File(SRC, 0, size)
    const t0 = performance.now()
    const results = await Promise.all(clients.map(async (c, n) => {
      const { id } = await upload(c, { dir: '/', name: `part-${n}.bin`, size })
      return complete(c, id)
    }))
    const total = secs(t0)
    const shas = await Promise.all(clients.map(async (c, n) => (await sha256Body(await c.req('GET', `/api/download?space=home&path=/part-${n}.bin`))).sha))
    out('parallel', { users: 3, eachBytes: size, all: results.every(r => r.size === size), aggregate: rate(size * 3, total), secs: total.toFixed(1), sameSha: shas.every(s => s === want) })
  },

  async 'restart-start'() {
    const c = await admin()
    const size = Math.min(GB, Bun.file(SRC).size)
    const { id, total } = await upload(c, { dir: '/load', name: 'resumed.bin', size, only: i => i < 64 })
    writeFileSync(join(WORK, 'restart.json'), JSON.stringify({ id, total, size, cookie: c.cookie, csrf: c.csrf }))
    out('restart-start', { id, sent: 64, total })
  },

  async 'restart-end'() {
    const saved = JSON.parse(readFileSync(join(WORK, 'restart.json'), 'utf8'))
    const c = new Client()
    c.cookie = saved.cookie
    c.csrf = saved.csrf
    // the signed-in session lives on disk, so it survives the restart
    const session = await c.json('GET', '/api/session')
    const status = await c.json('GET', `/api/upload/${saved.id}`)
    await upload(c, { dir: '/load', name: 'resumed.bin', size: saved.size, id: saved.id })
    const done = await complete(c, saved.id)
    const got = await sha256Body(await c.req('GET', `/api/download?space=home&path=/load/${encodeURIComponent('resumed.bin')}`))
    out('restart-end', {
      sessionKept: session.user?.username === (process.env.FC_USER ?? 'admin'), receivedBefore: status.received.length,
      completed: done.size === saved.size, sameSha: got.sha === (await sha256File(SRC, 0, saved.size)),
    })
  },

  async reserve() {
    const c = await admin()
    const res = await c.req('POST', '/api/upload', { space: 'home', path: '/load', name: 'reserve.bin', size: 1024 })
    out('reserve', { status: res.status, body: await res.json().catch(() => null) })
  },
}

if (!existsSync(SRC)) throw new Error(`missing ${SRC}`)
for (const name of process.argv.slice(2)) {
  const step = steps[name]
  if (!step) throw new Error(`unknown step ${name}; known: ${Object.keys(steps).join(', ')}`)
  try {
    await step()
  } catch (err) {
    out(name, { error: String(err) })
    process.exitCode = 1
  }
}
