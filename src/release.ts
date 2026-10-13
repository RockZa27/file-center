/**
 * Installed web updates ("releases"), shared by the launcher (which runs the app) and the app itself.
 *
 * The launcher is baked into the Docker image and is never updated from the web, so the format of
 * state.json is a contract with every update ever installed: only ever ADD optional fields.
 *
 *   <DATA_DIR>/app/state.json            which release runs, which ones can be rolled back to
 *   <DATA_DIR>/app/releases/<name>/      server.js + web/ + manifest.json of one installed update
 *   <DATA_DIR>/app/staging/<id>/         an uploaded package that is checked but not installed yet
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SERVER_FILE = 'server.js'
/** the app exits with this code to ask the launcher for a restart (sysexits EX_TEMPFAIL) */
export const EXIT_RESTART = 75

export type Manifest = {
  name: 'file-center'
  version: string
  builtAt: string
  notes?: string
  /** every file of the package except manifest.json, by path relative to the package root */
  files: Record<string, { sha256: string; size: number }>
}

export type ReleaseState = {
  schema: 1
  /** release that runs; null = the app built into the image */
  current: string | null
  /** releases that were active before, newest first, so an admin can go back */
  history: string[]
  /** an update that has not proven itself yet; if it fails to start the launcher goes back to `previous` */
  pending: { dir: string; previous: string | null; at: string } | null
  /**
   * what happened to the last switch, for the update page. `message` is the Thai text and is always written: an
   * older app reads only that. `code` + `params` (a code of messages.ts) let a newer app answer in the page's
   * language; a launcher before 1.3.0 does not write them.
   */
  last: {
    dir: string | null; version: string; ok: boolean; message: string; at: string
    code?: string; params?: Record<string, string | number>
  } | null
}

export const RELEASE_NAME = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/
/** x.y.z, or the beta form x.y.z-beta.N; no other pre-release word and no build metadata */
export const VERSION_PATTERN = String.raw`(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-beta\.(\d{1,6}))?`
const VERSION = new RegExp(`^${VERSION_PATTERN}$`)

export const isVersion = (v: unknown): v is string => typeof v === 'string' && VERSION.test(v)
/** a version of the beta channel (x.y.z-beta.N) */
export const isBeta = (v: unknown): v is string => isVersion(v) && v.includes('-')

/** negative when a < b, as semver: 1.9.0-beta.1 < 1.9.0-beta.2 < 1.9.0 < 1.9.1. Both must pass isVersion. */
export function compareVersions(a: string, b: string): number {
  const x = VERSION.exec(a)!.slice(1)
  const y = VERSION.exec(b)!.slice(1)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Number(x[i]) - Number(y[i])
  // same x.y.z: a beta comes before the release it leads up to
  if (x[3] === undefined || y[3] === undefined) return (x[3] === undefined ? 1 : 0) - (y[3] === undefined ? 1 : 0)
  return Number(x[3]) - Number(y[3])
}

export const appDir = (dataDir: string) => join(dataDir, 'app')
export const releasesDir = (dataDir: string) => join(appDir(dataDir), 'releases')
export const stagingDir = (dataDir: string) => join(appDir(dataDir), 'staging')
export const releasePath = (dataDir: string, name: string) => join(releasesDir(dataDir), name)
const stateFile = (dataDir: string) => join(appDir(dataDir), 'state.json')

const emptyState = (): ReleaseState => ({ schema: 1, current: null, history: [], pending: null, last: null })

export function readState(dataDir: string): ReleaseState {
  try {
    const s = JSON.parse(readFileSync(stateFile(dataDir), 'utf8')) as Partial<ReleaseState>
    const name = (v: unknown): v is string => typeof v === 'string' && RELEASE_NAME.test(v)
    return {
      ...emptyState(),
      ...s,
      schema: 1,
      current: name(s.current) ? s.current : null,
      history: Array.isArray(s.history) ? s.history.filter(name) : [],
    }
  } catch {
    return emptyState()
  }
}

/** atomic: a crash half way never leaves a broken state.json */
export function writeState(dataDir: string, state: ReleaseState) {
  mkdirSync(appDir(dataDir), { recursive: true })
  const tmp = `${stateFile(dataDir)}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, stateFile(dataDir))
}

export function readManifest(dir: string): Manifest | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    return m?.name === 'file-center' && isVersion(m.version) ? m : null
  } catch {
    return null
  }
}

/** a release folder that can be started */
export function releaseUsable(dataDir: string, name: string): boolean {
  const dir = releasePath(dataDir, name)
  try {
    return statSync(join(dir, SERVER_FILE)).isFile() && existsSync(join(dir, 'web', 'index.html')) && !!readManifest(dir)
  } catch {
    return false
  }
}
