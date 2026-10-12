/**
 * Installing an update from the web.
 *
 * 1. stagePackage: unzip the uploaded package into staging/ and accept only the files its manifest lists
 *    (checked by size and SHA-256). Static checks only: no code from the package runs here, because an
 *    admin session alone (a stolen cookie, say) must not be enough to run code on the server.
 *    With UPDATE_PUBLIC_KEY set, manifest.json must also carry a valid Ed25519 signature (manifest.sig) by the
 *    holder of the private key, so even a taken-over admin account (session + password) can not install its own code.
 * 2. applyStaged (after the password step-up): start the new server for a few seconds against throw-away
 *    data to prove it boots on this machine, then move it to releases/, record it in state.json and ask
 *    for a restart. The launcher starts the new code and goes back to the old one if it does not come up.
 */
import { createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { join, relative, sep } from 'node:path'
import { config, paths } from './config'
import { bad, conflict, ensureSpace, freeSpace, HttpError, notFound } from './fsx'
import type { MessageCode, Params } from './messages'
import {
  compareVersions, isVersion, readManifest, readState, releasePath, releasesDir, releaseUsable, RELEASE_NAME, SERVER_FILE,
  stagingDir, writeState, type Manifest,
} from './release'
import { unzipTo } from './zip'

const MAX_FILES = 5000
const MAX_UNPACKED = 400 * 1024 ** 2
const SAFE_PATH = /^[A-Za-z0-9._@~+-]+(\/[A-Za-z0-9._@~+-]+)*$/
const STAGED_ID = /^[a-f0-9]{16}$/
const VERIFIED = '.verified'
/** base64 Ed25519 signature of the exact bytes of manifest.json, written by "bun run package --sign" */
const SIGNATURE_FILE = 'manifest.sig'
const MAX_MANIFEST = 2 * 1024 * 1024

export type StagedInfo = {
  id: string
  version: string
  builtAt: string
  notes: string
  files: number
  bytes: number
  serverSha256: string
  runningVersion: string
  /** the new server has not been started yet; that happens on install, after the password */
  tested: false
  /** the package carries manifest.sig */
  signed: boolean
  /** the signature was checked against UPDATE_PUBLIC_KEY (false when no key is set: then nothing can check it) */
  signatureVerified: boolean
}

export const staging = () => stagingDir(config.dataDir)
export const releases = () => releasesDir(config.dataDir)

/** one install at a time: staging, installing and rolling back share files and a restart */
let busy = false
export async function exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
  if (busy) throw conflict('update.busy')
  busy = true
  try { return await fn() } finally { busy = false }
}

type KeyProblem = { code: MessageCode; params: Params }
let parsedKey: { value: string; key: KeyObject | null; error: string | null; problem: KeyProblem | null } | undefined

/** the key in UPDATE_PUBLIC_KEY, parsed once per value; `error` says why it is unusable (for the log), `problem` tells the admin */
export function signingKey(): { key: KeyObject | null; error: string | null; problem: KeyProblem | null } {
  const value = config.updatePublicKey
  if (parsedKey?.value !== value) {
    parsedKey = { value, key: null, error: null, problem: null }
    if (value) {
      try {
        const key = createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' })
        if (key.asymmetricKeyType !== 'ed25519') {
          parsedKey.error = `ต้องเป็นกุญแจ Ed25519 (ได้ ${key.asymmetricKeyType})`
          parsedKey.problem = { code: 'update.key-wrong-type', params: { type: String(key.asymmetricKeyType) } }
        } else parsedKey.key = key
      } catch {
        parsedKey.error = 'อ่านกุญแจไม่ได้ ต้องเป็น public key บรรทัดเดียวที่ได้จาก "bun run package --gen-key"'
        parsedKey.problem = { code: 'update.key-unreadable', params: {} }
      }
    }
  }
  return { key: parsedKey.key, error: parsedKey.error, problem: parsedKey.problem }
}

/** a key is set (valid or not): every package must be signed */
export const signatureRequired = () => config.updatePublicKey !== ''

/** check manifest.sig against the manifest bytes when a key is set; a missing or wrong signature rejects the package */
function checkSignature(dir: string, manifestBytes: Buffer): { signed: boolean; signatureVerified: boolean } {
  const sigFile = join(dir, SIGNATURE_FILE)
  const signed = existsSync(sigFile)
  if (!signatureRequired()) return { signed, signatureVerified: false }
  const { key, problem } = signingKey()
  if (!key) throw bad(problem!.code, problem!.params)
  if (!signed) {
    throw bad('update.unsigned')
  }
  let ok = false
  try {
    if (statSync(sigFile).size <= 1024) ok = verify(null, manifestBytes, key, Buffer.from(readFileSync(sigFile, 'utf8').trim(), 'base64'))
  } catch { /* unreadable signature = wrong signature */ }
  if (!ok) throw bad('update.bad-signature')
  return { signed: true, signatureVerified: true }
}

const sha256 = (file: string) => new Bun.CryptoHasher('sha256').update(readFileSync(file)).digest('hex')

/** every regular file under `root` as a forward-slash relative path; a link or odd file anywhere rejects the package */
function listFiles(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      const st = lstatSync(abs)
      const rel = relative(root, abs).split(sep).join('/')
      if (st.isDirectory()) visit(abs)
      else if (st.isFile()) out.push(rel)
      else throw bad('update.odd-file', { file: rel })
      if (out.length > MAX_FILES) throw bad('update.too-many-files')
    }
  }
  visit(root)
  return out
}

/**
 * The manifest of an unpacked package, after checking its signature (when a key is set) and that its files are
 * exactly the ones the manifest lists. The signature is checked on the same bytes that are parsed.
 */
function verifyTree(dir: string): { manifest: Manifest; signed: boolean; signatureVerified: boolean } {
  let raw: Buffer
  try {
    raw = readFileSync(join(dir, 'manifest.json'))
    if (raw.length > MAX_MANIFEST) throw new Error('too big')
  } catch {
    throw bad('update.no-manifest')
  }
  const signature = checkSignature(dir, raw)
  let manifest: Manifest
  try {
    manifest = JSON.parse(raw.toString('utf8'))
  } catch {
    throw bad('update.no-manifest')
  }
  if (manifest?.name !== 'file-center') throw bad('update.not-file-center')
  if (!isVersion(manifest.version)) throw bad('update.bad-version')
  if (typeof manifest.files !== 'object' || manifest.files === null) throw bad('update.bad-manifest')
  const listed = Object.keys(manifest.files)
  if (!listed.includes(SERVER_FILE) || !listed.includes('web/index.html')) throw bad('update.missing-files')

  const actual = listFiles(dir).filter(f => f !== 'manifest.json' && f !== SIGNATURE_FILE && f !== VERIFIED).sort()
  if (actual.join('\n') !== [...listed].sort().join('\n')) throw bad('update.files-mismatch')
  for (const rel of listed) {
    if (!SAFE_PATH.test(rel) || (rel !== SERVER_FILE && !rel.startsWith('web/'))) throw bad('update.bad-file-name', { file: rel })
    const want = manifest.files[rel]
    const abs = join(dir, rel)
    if (statSync(abs).size !== want?.size || sha256(abs) !== want.sha256) throw bad('update.file-corrupt', { file: rel })
  }
  return { manifest, ...signature }
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const port = probe.port!
  await probe.stop(true)
  return port
}

/** run the package's server for real, on a spare port with its own empty data, and make sure it answers */
async function smokeTest(dir: string, manifest: Manifest) {
  const scratch = mkdtempSync(join(paths.app, 'smoke-'))
  const port = await freePort()
  const proc = Bun.spawn([process.execPath, join(dir, SERVER_FILE)], {
    // nothing of this server's environment (tokens, passwords) goes to the code being tested
    env: {
      PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port),
      STORAGE_DIR: join(scratch, 'storage'), DATA_DIR: join(scratch, 'data'), WEB_DIR: join(dir, 'web'),
      ADMIN_PASSWORD: randomBytes(12).toString('hex'), FC_VERSION: manifest.version, MIN_FREE_SPACE: '0',
    },
    stdout: 'ignore', stderr: 'pipe',
  })
  const errors = new Response(proc.stderr).text()
  let exited = false
  void proc.exited.then(() => { exited = true })
  try {
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline && !exited) {
      try {
        const health = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
        if (health.ok && ((await health.json()) as { version?: string }).version === manifest.version) {
          const page = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
          if (!page.ok) throw bad('update.page-failed')
          return
        }
      } catch (e) {
        if (e instanceof HttpError) throw e
      }
      await Bun.sleep(300)
    }
    proc.kill()
    const log = await Promise.race([errors, Bun.sleep(1000).then(() => '')])
    // the first lines hold the message; the rest is a stack trace with server paths
    const detail = log.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('at ') && !l.startsWith('Bun v')).slice(0, 3).join(' ').replaceAll(dir, '.').slice(0, 300)
    if (exited) throw detail ? bad('update.start-failed-detail', { detail }) : bad('update.start-failed')
    throw detail ? bad('update.start-timeout-detail', { seconds: 25, detail }) : bad('update.start-timeout', { seconds: 25 })
  } finally {
    proc.kill()
    await proc.exited
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** remove staged packages nobody installed */
export function cleanStaging(maxAgeMs = 24 * 3600_000) {
  try {
    for (const id of readdirSync(staging())) {
      const p = join(staging(), id)
      if (Date.now() - statSync(p).mtimeMs > maxAgeMs) rmSync(p, { recursive: true, force: true })
    }
    for (const n of readdirSync(paths.app)) {
      if (n.startsWith('smoke-') && Date.now() - statSync(join(paths.app, n)).mtimeMs > 3600_000) rmSync(join(paths.app, n), { recursive: true, force: true })
    }
  } catch { /* nothing staged yet */ }
}

export const runningVersion = () => config.version

export function stagePackage(zipAbs: string, bytes: number): Promise<StagedInfo> {
  return exclusive(async () => {
    mkdirSync(staging(), { recursive: true })
    for (const old of readdirSync(staging())) rmSync(join(staging(), old), { recursive: true, force: true })
    const id = randomBytes(8).toString('hex')
    const dir = join(staging(), id)
    mkdirSync(dir)
    try {
      ensureSpace(paths.app, bytes * 3)
      const free = freeSpace(paths.app)
      try {
        await unzipTo(zipAbs, dir, {
          maxBytes: Math.min(MAX_UNPACKED, free === null ? Infinity : Math.max(0, free - config.minFreeSpace)),
          maxFiles: MAX_FILES,
        })
      } catch (e) {
        throw e instanceof HttpError ? e : bad('update.bad-zip')
      }
      const { manifest, signed, signatureVerified } = verifyTree(dir)
      if (compareVersions(manifest.version, runningVersion()) <= 0) {
        throw bad('update.not-newer', { version: manifest.version, running: runningVersion() })
      }
      writeFileSync(join(dir, VERIFIED), manifest.files[SERVER_FILE].sha256)
      return {
        id,
        version: manifest.version,
        builtAt: String(manifest.builtAt ?? ''),
        notes: String(manifest.notes ?? '').slice(0, 2000),
        files: Object.keys(manifest.files).length,
        bytes: Object.values(manifest.files).reduce((s, f) => s + f.size, 0),
        serverSha256: manifest.files[SERVER_FILE].sha256,
        runningVersion: runningVersion(),
        tested: false,
        signed,
        signatureVerified,
      }
    } catch (e) {
      rmSync(dir, { recursive: true, force: true })
      throw e
    }
  })
}

export function discardStaged(id: string) {
  if (!STAGED_ID.test(id)) throw notFound()
  rmSync(join(staging(), id), { recursive: true, force: true })
}

const keep = (state: { current: string | null; history: string[] }) => new Set([state.current, ...state.history].filter(Boolean) as string[])

/** delete installed releases that can no longer be reached from state.json */
function pruneReleases() {
  const state = readState(config.dataDir)
  const wanted = keep(state)
  if (state.pending) wanted.add(state.pending.dir)
  try {
    for (const name of readdirSync(releases())) if (!wanted.has(name)) rmSync(join(releases(), name), { recursive: true, force: true })
  } catch { /* none installed */ }
}

/** test-run and install a staged package. Call only after the password step-up; the caller restarts the app afterwards. */
export function applyStaged(id: string): Promise<{ version: string; dir: string }> {
  return exclusive(async () => {
    if (!STAGED_ID.test(id)) throw notFound('update.staged-missing')
    const dir = join(staging(), id)
    if (!existsSync(join(dir, VERIFIED))) throw notFound('update.staged-missing')
    const { manifest } = verifyTree(dir) // nothing changed since the check, signature included
    if (compareVersions(manifest.version, runningVersion()) <= 0) throw bad('update.staged-not-newer')
    try {
      await smokeTest(dir, manifest)
    } catch (e) {
      // a package that does not start is useless: drop it so it can not be retried
      rmSync(dir, { recursive: true, force: true })
      throw e
    }
    const name = `${manifest.version}-${manifest.files[SERVER_FILE].sha256.slice(0, 8)}`
    rmSync(join(dir, VERIFIED))
    mkdirSync(releases(), { recursive: true })
    rmSync(releasePath(config.dataDir, name), { recursive: true, force: true })
    renameSync(dir, releasePath(config.dataDir, name))

    const state = readState(config.dataDir)
    const previous = state.current
    writeState(config.dataDir, {
      ...state,
      current: name,
      history: [previous, ...state.history].filter((h): h is string => !!h && h !== name).slice(0, 2),
      pending: { dir: name, previous, at: new Date().toISOString() },
      last: null,
    })
    pruneReleases()
    return { version: manifest.version, dir: name }
  })
}

/** switch to an installed release (or null = the one built into the image). The caller restarts the app afterwards. */
export function rollbackTo(target: string | null): Promise<{ version: string }> {
  return exclusive(() => {
    const state = readState(config.dataDir)
    if (target !== null && (!RELEASE_NAME.test(target) || !state.history.includes(target) || !releaseUsable(config.dataDir, target))) {
      throw notFound('update.rollback-missing')
    }
    if (target === state.current) throw bad('update.version-in-use')
    const version = target ? readManifest(releasePath(config.dataDir, target))!.version : (process.env.FC_BUILTIN_VERSION ?? config.version)
    writeState(config.dataDir, {
      ...state,
      current: target,
      history: [state.current, ...state.history].filter((h): h is string => !!h && h !== target).slice(0, 2),
      // if the older release does not start either, the launcher returns to the one we leave now
      pending: target ? { dir: target, previous: state.current, at: new Date().toISOString() } : null,
      last: null,
    })
    return { version }
  })
}

export function updateStatus() {
  const state = readState(config.dataDir)
  const describe = (dir: string) => {
    const m = readManifest(releasePath(config.dataDir, dir))
    return m ? { dir, version: m.version, builtAt: m.builtAt ?? '', notes: m.notes ?? '' } : null
  }
  return {
    enabled: config.webUpdate,
    supervised: process.env.FC_SUPERVISED === '1',
    runningVersion: runningVersion(),
    runningRelease: process.env.FC_RELEASE || null,
    builtinVersion: process.env.FC_BUILTIN_VERSION ?? config.version,
    pending: state.pending,
    last: state.last,
    history: state.history.map(describe).filter(Boolean),
    maxPackageSize: config.updateMaxSize,
    signatureRequired: signatureRequired(),
  }
}
