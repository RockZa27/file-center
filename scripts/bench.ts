/**
 * Benchmark of a File Center instance: starts the app as a child process on a temporary STORAGE_DIR / DATA_DIR with a
 * generated tree, then drives it with a small load generator (no dependencies).
 *
 *   bun run bench [--quick] [--json out.json] [--concurrency N] [--duration SECONDS] [--files N]
 *   bun run bench --compare qa/bench/baseline.json [--current out.json]   # runs (or reads --current) and prints the difference
 *
 * The generator runs on the same machine as the app, so the numbers are relative: compare runs of one machine only.
 * Nothing here changes what the app does; it only talks to it over HTTP like the browser.
 */
import { spawn } from 'node:child_process'
import { cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const MB = 1024 ** 2
const ROOT = resolve(import.meta.dir, '..')

type Row = { rps?: number; p50: number; p95: number; p99: number; errors: number; requests: number; mbps?: number; note?: string }
type Result = {
  machine: Record<string, unknown>
  date: string
  mode: 'quick' | 'full'
  settings: Record<string, number>
  coldStartMs: number
  rssMb: number
  rows: Record<string, Row>
}

// ───────────── arguments ─────────────
const argv = process.argv.slice(2)
const flag = (n: string) => argv.includes(`--${n}`)
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined }
const quick = flag('quick')
const concurrency = Number(opt('concurrency') ?? 8)
const duration = Number(opt('duration') ?? (quick ? 1.5 : 5))
const fileCount = Number(opt('files') ?? (quick ? 2000 : 20000))
const bigMb = quick ? 10 : 100 // the "large" download and upload
const PASSWORD = 'bench-admin-pass'

// ───────────── numbers ─────────────
const pct = (sorted: number[], p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d

/** `conc` workers call `one` in a loop until the time is up (and at least `min` calls in all); latency in ms of each call */
async function load(one: () => Promise<number | void>, opts: { conc: number; secs: number; min?: number }): Promise<Row> {
  const lat: number[] = []
  let errors = 0
  let bytes = 0
  const end = performance.now() + opts.secs * 1000
  const t0 = performance.now()
  const min = opts.min ?? 1
  let started = 0
  const worker = async () => {
    while (performance.now() < end || started < min) {
      started++
      const s = performance.now()
      try {
        const n = await one()
        if (typeof n === 'number') bytes += n
        lat.push(performance.now() - s)
      } catch {
        errors++
      }
    }
  }
  await Promise.all(Array.from({ length: opts.conc }, worker))
  const took = (performance.now() - t0) / 1000
  lat.sort((a, b) => a - b)
  return {
    rps: round(lat.length / took, 1), p50: round(pct(lat, 0.5)), p95: round(pct(lat, 0.95)), p99: round(pct(lat, 0.99)),
    errors, requests: lat.length + errors, ...(bytes > 100_000 ? { mbps: round(bytes / MB / took) } : {}),
  }
}

// ───────────── the app ─────────────
const work = mkdtempSync(join(tmpdir(), 'fc-bench-'))
const storage = join(work, 'storage')
const data = join(work, 'data')
mkdirSync(storage, { recursive: true })

function buildTree() {
  // nested folders with small files; a flat folder of 2,000 entries to list; a folder of 200 files to zip; large files
  const perDir = 50
  let n = 0
  for (let a = 0; n < fileCount; a++) {
    for (let b = 0; b < 10 && n < fileCount; b++) {
      const dir = join(storage, 'tree', `d${String(a).padStart(3, '0')}`, `s${b}`)
      mkdirSync(dir, { recursive: true })
      for (let f = 0; f < perDir && n < fileCount; f++, n++) writeFileSync(join(dir, `file-${a}-${b}-${f}.txt`), `bench ${n}\n`)
    }
  }
  mkdirSync(join(storage, 'flat'))
  for (let i = 0; i < 2000; i++) writeFileSync(join(storage, 'flat', `entry-${String(i).padStart(4, '0')}.txt`), 'x')
  mkdirSync(join(storage, 'zipsrc'))
  for (let i = 0; i < 200; i++) writeFileSync(join(storage, 'zipsrc', `part-${i}.txt`), `part ${i}\n`.repeat(200))
  mkdirSync(join(storage, 'big'))
  const one = crypto.getRandomValues(new Uint8Array(MB))
  writeFileSync(join(storage, 'big', '1mb.bin'), one)
  const parts: Uint8Array[] = []
  for (let i = 0; i < bigMb; i++) parts.push(one)
  writeFileSync(join(storage, 'big', 'large.bin'), Buffer.concat(parts))
}

async function waitHealth(base: string, t0: number, timeoutMs = 30000) {
  while (performance.now() - t0 < timeoutMs) {
    try { if ((await fetch(`${base}/api/health`)).ok) return performance.now() - t0 } catch { /* not up yet */ }
    await Bun.sleep(5)
  }
  throw new Error('the app did not start')
}

// ───────────── http client ─────────────
class Client {
  cookie = ''
  csrf = ''
  constructor(public base: string) {}
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers, 'x-csrf-token': this.csrf }
    if (this.cookie) h.cookie = this.cookie
    let payload: BodyInit | undefined
    if (body instanceof Uint8Array) payload = body as BodyInit
    else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json' }
    const res = await fetch(this.base + path, { method, headers: h, body: payload })
    const set = res.headers.get('set-cookie')
    if (set) this.cookie = set.split(';')[0]
    return res
  }
  async ok(method: string, path: string, body?: unknown) {
    const res = await this.req(method, path, body)
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`)
    return res
  }
  async login() {
    this.csrf = (await (await this.ok('GET', '/api/session')).json() as any).csrf
    this.csrf = (await (await this.ok('POST', '/api/login', { username: 'admin', password: PASSWORD })).json() as any).csrf
    return this
  }
}

/** read a whole body, return its size */
async function drain(res: Response) {
  if (!res.ok) throw new Error(String(res.status))
  return (await res.arrayBuffer()).byteLength
}

// ───────────── run ─────────────
async function run(): Promise<Result> {
  buildTree()
  const port = 20000 + Math.floor(Math.random() * 20000)
  const base = `http://127.0.0.1:${port}`
  const env = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', STORAGE_DIR: storage, DATA_DIR: data, ADMIN_PASSWORD: PASSWORD,
    MIN_FREE_SPACE: '0', ACCESS_LOG: 'false', WEB_UPDATE: 'false',
  }
  const started = performance.now()
  const child = spawn(process.execPath, [join(ROOT, 'src', 'index.ts')], { env, stdio: 'ignore' })
  try {
    const coldStartMs = round(await waitHealth(base, started), 0)
    const c = await new Client(base).login()
    const rows: Record<string, Row> = {}
    const secs = duration

    // wait for the search index so the "search" row is what it says
    for (let i = 0; i < 600; i++) {
      const r: any = await (await c.ok('GET', '/api/search?space=home&q=file-1-1-1')).json()
      if (r.indexed) break
      await Bun.sleep(100)
    }

    // warm-up burst
    await load(() => c.ok('GET', '/api/session').then(drain), { conc: concurrency, secs: 0.5 })

    rows['session'] = await load(() => c.ok('GET', '/api/session').then(drain), { conc: concurrency, secs })
    rows['list-2000'] = await load(() => c.ok('GET', '/api/list?space=home&path=/flat').then(drain), { conc: concurrency, secs })
    rows['search'] = await load(() => c.ok('GET', '/api/search?space=home&q=file-1-1-1').then(drain), { conc: concurrency, secs })
    rows['download-1mb'] = await load(() => c.ok('GET', '/api/download?space=home&path=/big/1mb.bin').then(drain), { conc: concurrency, secs })
    rows[`download-${bigMb}mb`] = await load(() => c.ok('GET', '/api/download?space=home&path=/big/large.bin').then(drain), { conc: 2, secs, min: 2 })

    // the static page and the largest hashed asset, asked for gzip like a browser
    const assets = join(ROOT, 'web', 'dist', 'assets')
    if (existsSync(assets)) {
      const big = readdirSync(assets).filter(f => f.endsWith('.js')).map(f => ({ f, s: statSync(join(assets, f)).size })).sort((a, b) => b.s - a.s)[0]
      // decompress: false keeps the bytes as they travel (the client would otherwise spend this machine's CPU unzipping)
      const get = (path: string) => fetch(`${base}${path}`, { headers: { 'accept-encoding': 'br, gzip' }, decompress: false } as RequestInit)
      const sample = await get(`/assets/${big.f}`)
      const wire = sample.headers.get('content-encoding') ?? 'identity'
      const wireKb = round((await sample.arrayBuffer()).byteLength / 1024, 0)
      rows['static-page'] = await load(() => get('/').then(drain), { conc: concurrency, secs })
      rows['static-asset'] = {
        ...await load(() => get(`/assets/${big.f}`).then(drain), { conc: concurrency, secs }),
        note: `${big.f} ${round(big.s / 1024, 0)} KB, on the wire ${wireKb} KB (${wire})`,
      }
    }

    // zip of 200 files: writes an archive each time
    let z = 0
    const items = Array.from({ length: 200 }, (_, i) => `part-${i}.txt`)
    rows['zip-200'] = await load(() => c.ok('POST', '/api/zip', { space: 'home', path: '/zipsrc', items, name: `b${z++}.zip` }).then(drain), { conc: 2, secs, min: 3 })

    // chunked upload the way the web app does it: 3 chunks in flight
    {
      const size = bigMb * MB
      const t0 = performance.now()
      try {
        const init: any = await (await c.ok('POST', '/api/upload', { space: 'home', path: '/', name: 'uploaded.bin', size })).json()
        const body = crypto.getRandomValues(new Uint8Array(init.chunkSize))
        const queue = Array.from({ length: init.total }, (_, i) => i)
        const lat: number[] = []
        await Promise.all(Array.from({ length: 3 }, async () => {
          for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
            const len = i === init.total - 1 ? size - init.chunkSize * (init.total - 1) : init.chunkSize
            const s = performance.now()
            await c.ok('PUT', `/api/upload/${init.id}/${i}`, body.subarray(0, len))
            lat.push(performance.now() - s)
          }
        }))
        await c.ok('POST', `/api/upload/${init.id}/complete`)
        lat.sort((a, b) => a - b)
        const took = (performance.now() - t0) / 1000
        rows[`upload-${bigMb}mb`] = { p50: round(pct(lat, 0.5)), p95: round(pct(lat, 0.95)), p99: round(pct(lat, 0.99)), errors: 0, requests: lat.length + 2, mbps: round(size / MB / took), rps: round(lat.length / took, 1), note: 'one upload; latency is per chunk' }
      } catch (err) {
        rows[`upload-${bigMb}mb`] = { p50: 0, p95: 0, p99: 0, errors: 1, requests: 1, note: String(err) }
      }
    }

    // login is slow on purpose (argon2): measured, never tuned. Each call starts from a fresh anonymous session.
    rows['login'] = await load(async () => { await new Client(base).login() }, { conc: 2, secs, min: 3 })

    const rssKb = Number((await Bun.$`ps -o rss= -p ${child.pid}`.text()).trim())
    return {
      machine: { cpu: cpus()[0]?.model, cores: cpus().length, memGb: round(totalmem() / 1024 ** 3), os: `${platform()} ${release()}`, bun: Bun.version },
      date: new Date().toISOString(),
      mode: quick ? 'quick' : 'full',
      settings: { concurrency, durationSecs: duration, files: fileCount, bigMb },
      coldStartMs, rssMb: round(rssKb / 1024), rows,
    }
  } finally {
    child.kill('SIGTERM')
    await Promise.race([new Promise(r => child.once('exit', r)), Bun.sleep(3000)])
    rmSync(work, { recursive: true, force: true })
  }
}

// ───────────── output ─────────────
function table(r: Result) {
  const f = (v: number | undefined, w: number) => (v === undefined ? '-' : String(v)).padStart(w)
  console.log(`\n${r.mode} run on ${r.machine.cpu} x${r.machine.cores}, bun ${r.machine.bun}; ${r.settings.files} files, concurrency ${r.settings.concurrency}, ${r.settings.durationSecs}s per row`)
  console.log(`cold start to /api/health: ${r.coldStartMs} ms   RSS after warm-up: ${r.rssMb} MB\n`)
  console.log(`${'row'.padEnd(16)}${'req/s'.padStart(9)}${'p50 ms'.padStart(10)}${'p95 ms'.padStart(10)}${'p99 ms'.padStart(10)}${'errors'.padStart(8)}${'MB/s'.padStart(9)}  note`)
  for (const [k, v] of Object.entries(r.rows)) {
    console.log(`${k.padEnd(16)}${f(v.rps, 9)}${f(v.p50, 10)}${f(v.p95, 10)}${f(v.p99, 10)}${f(v.errors, 8)}${f(v.mbps, 9)}  ${v.note ?? ''}`)
  }
}

function compare(base: Result, cur: Result) {
  const d = (a: number | undefined, b: number | undefined, higherIsBetter: boolean) => {
    if (!a || b === undefined) return '-'.padStart(8)
    const p = ((b - a) / a) * 100
    const mark = Math.abs(p) < 10 ? ' ' : (p > 0) === higherIsBetter ? '+' : '!'
    return `${(p >= 0 ? '+' : '') + p.toFixed(0)}%${mark}`.padStart(8)
  }
  console.log(`\nagainst ${base.machine.cpu} (${base.date.slice(0, 10)}, ${base.mode}); "!" = worse by 10% or more, "+" = better by 10% or more`)
  console.log(`${'row'.padEnd(16)}${'req/s'.padStart(8)}${'p50'.padStart(8)}${'p95'.padStart(8)}${'MB/s'.padStart(8)}`)
  for (const [k, v] of Object.entries(cur.rows)) {
    const o = base.rows[k]
    if (!o) { console.log(`${k.padEnd(16)}  (not in the baseline)`); continue }
    console.log(`${k.padEnd(16)}${d(o.rps, v.rps, true)}${d(o.p50, v.p50, false)}${d(o.p95, v.p95, false)}${d(o.mbps, v.mbps, true)}`)
  }
  console.log(`${'cold start'.padEnd(16)}${d(base.coldStartMs, cur.coldStartMs, false)}   RSS${d(base.rssMb, cur.rssMb, false)}`)
  if (base.machine.cpu !== cur.machine.cpu) console.log('\nnote: the baseline is from another machine, the differences mean little')
  if (base.mode !== cur.mode) console.log('\nnote: the baseline and this run use different modes (quick/full), the differences mean little')
}

const baselinePath = opt('compare')
const currentPath = opt('current')
const result: Result = currentPath ? JSON.parse(readFileSync(currentPath, 'utf8')) : await run()
if (!currentPath) table(result)
const out = opt('json')
if (out) writeFileSync(out, JSON.stringify(result, null, 2) + '\n')
if (baselinePath) compare(JSON.parse(readFileSync(baselinePath, 'utf8')), result)
process.exit(0)
