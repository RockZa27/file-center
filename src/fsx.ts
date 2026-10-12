import {
  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statfsSync, statSync,
} from 'node:fs'
import { constants as FS, type Stats } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { config } from './config'
import { type MessageCode, type Params, text } from './messages'

/**
 * An answer for the visitor: a code from the catalog in messages.ts and its params. The text is picked in the
 * request's language when the answer is written; `message` is the Thai text, for logs.
 */
export class HttpError extends Error {
  constructor(public status: number, public code: MessageCode, public params: Params = {}) {
    super(text('th', code, params))
  }
}

export const bad = (code: MessageCode, params?: Params) => new HttpError(400, code, params)
export const forbidden = (code: MessageCode = 'auth.forbidden', params?: Params) => new HttpError(403, code, params)
export const notFound = (code: MessageCode = 'request.not-found', params?: Params) => new HttpError(404, code, params)
export const conflict = (code: MessageCode, params?: Params) => new HttpError(409, code, params)

const BAD_NAME_CHARS = /[<>:"|?*\\/\u0000-\u001f]/
// file systems count bytes, not letters: a Thai letter takes 3, so a Thai name fits about 85 of them
const NAME_MAX = 255
const bytes = (s: string) => Buffer.byteLength(s)

/** cut `stem` by whole characters until `stem + tail` fits in NAME_MAX bytes */
function fit(stem: string, tail: string): string {
  const chars = Array.from(stem).slice(0, NAME_MAX)
  while (chars.length && bytes(chars.join('') + tail) > NAME_MAX) chars.pop()
  return chars.join('') + tail
}

export function validName(name: unknown): string {
  if (typeof name !== 'string') throw bad('fs.bad-name')
  const n = name.trim()
  if (!n || n === '.' || n === '..') throw bad('fs.bad-name')
  if (bytes(n) > NAME_MAX) throw bad('fs.name-too-long')
  if (BAD_NAME_CHARS.test(n)) throw bad('fs.name-bad-chars')
  return n
}

/** turn a name from outside (a zip entry) into one validName accepts: forbidden characters become "_", long ones are cut */
export function cleanName(name: string): string {
  let n = name.replace(new RegExp(BAD_NAME_CHARS.source, 'g'), '_').trim()
  if (bytes(n) > NAME_MAX) {
    const ext = extname(n)
    n = (ext && bytes(ext) <= 32 ? fit(n.slice(0, -ext.length), ext) : fit(n, '')).trim()
  }
  return n === '' || n === '.' || n === '..' ? '_' : n
}

const FS_ERRORS: Record<string, [number, MessageCode]> = {
  ENOENT: [404, 'fs.not-found'],
  ENOTDIR: [404, 'fs.not-a-folder'],
  EISDIR: [400, 'fs.is-a-folder'],
  EEXIST: [409, 'fs.exists'],
  ENOTEMPTY: [409, 'fs.exists'],
  ENAMETOOLONG: [400, 'fs.path-too-long'],
  ENOSPC: [507, 'disk-full'],
  EDQUOT: [507, 'disk-full'],
  EACCES: [403, 'fs.no-access'],
  EPERM: [403, 'fs.no-access'],
  EROFS: [403, 'fs.read-only'],
  EBUSY: [409, 'fs.busy'],
}

/** a clear HttpError for a file-system error (whose own message would show server paths), or null */
export function fromFsError(err: unknown): HttpError | null {
  if (err instanceof HttpError) return err
  const known = FS_ERRORS[(err as any)?.code]
  return known ? new HttpError(known[0], known[1]) : null
}

/** "/users/bob/report.pdf": where an absolute path sits inside the storage, for logs and the trash */
export const storagePath = (abs: string) => '/' + relative(config.storageDir, abs).split(/[\\/]/).filter(Boolean).join('/')

/** true when both paths name the same file, e.g. "a.txt" and "A.txt" on a case-insensitive disk */
export function sameFile(a: string, b: string) {
  try {
    const x = lstatSync(a)
    const y = lstatSync(b)
    return x.dev === y.dev && x.ino === y.ino
  } catch {
    return false
  }
}

/** "/a//b/./c" -> "/a/b/c". Rejects ".." and NUL. */
export function normRel(input: unknown): string {
  if (input === undefined || input === null || input === '') return '/'
  if (typeof input !== 'string' || input.includes('\u0000')) throw bad('fs.bad-path')
  const parts: string[] = []
  for (const seg of input.replaceAll('\\', '/').split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') throw bad('fs.bad-path')
    parts.push(seg)
  }
  return '/' + parts.join('/')
}

export const joinRel = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`)
export const parentRel = (p: string) => {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

const within = (root: string, abs: string) => abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep)

/**
 * Map a space-relative path to an absolute path and make sure it can not leave `root`,
 * not even through a symlink.
 */
export function resolveIn(root: string, rel: string): string {
  const abs = join(root, ...rel.split('/').filter(Boolean))
  if (!within(root, abs)) throw bad('fs.bad-path')
  let probe = abs
  while (!existsSync(probe)) {
    const up = dirname(probe)
    if (up === probe) break
    probe = up
  }
  try {
    if (!within(realpathSync(root), realpathSync(probe))) throw forbidden()
  } catch (err) {
    if (err instanceof HttpError) throw err
  }
  return abs
}

export type Entry = { name: string; path: string; type: 'file' | 'dir'; size: number; mtime: number }

function entryOf(abs: string, rel: string, st: Stats | null): Entry | null {
  if (!st || st.isSymbolicLink()) return null // never follow or list links
  return {
    name: basename(abs),
    path: rel,
    type: st.isDirectory() ? 'dir' : 'file',
    size: st.isDirectory() ? 0 : st.size,
    mtime: Math.round(st.mtimeMs),
  }
}

export function statEntry(abs: string, rel: string): Entry | null {
  try {
    return entryOf(abs, rel, lstatSync(abs))
  } catch {
    return null
  }
}

export function listDir(abs: string, rel: string): Entry[] {
  const out: Entry[] = []
  for (const name of readdirSync(abs)) {
    const e = statEntry(join(abs, name), joinRel(rel, name))
    if (e) out.push(e)
  }
  return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'th', { numeric: true }) : a.type === 'dir' ? -1 : 1))
}

export function isDir(abs: string) {
  try { return statSync(abs).isDirectory() } catch { return false }
}

/** "report.pdf" -> "report (1).pdf" until the name is free */
export function uniquePath(abs: string): string {
  if (!existsSync(abs)) return abs
  const dir = dirname(abs)
  const ext = extname(abs)
  const stem = basename(abs, ext)
  for (let i = 1; i < 10_000; i++) {
    const candidate = join(dir, fit(stem, ` (${i})${ext}`))
    if (!existsSync(candidate)) return candidate
  }
  throw conflict('fs.no-free-name')
}

export function moveSync(from: string, to: string) {
  try {
    renameSync(from, to)
  } catch (err: any) {
    if (err?.code !== 'EXDEV') throw err
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false })
    rmSync(from, { recursive: true, force: true })
  }
}

/**
 * copy a file or a folder tree to `to`, which must not exist yet. Asynchronous, in batches like treeStats, so a
 * folder of 20,000 files does not hold up everyone else. Links are skipped (never followed, never copied), and a
 * copy that fails half way removes what it wrote.
 */
export async function copyTree(from: string, to: string) {
  // compare whole path segments: a folder may be called "..a", so a relative path starting with ".." proves nothing
  if (isDir(from) && within(from, to)) throw bad('files.copy-into-self')
  const st = await lstat(from)
  if (st.isSymbolicLink()) throw notFound()
  if (!st.isDirectory()) {
    // EXCL: never overwrite, and never write through a link put where the copy goes
    try { await copyFile(from, to, FS.COPYFILE_EXCL) } catch (err: any) {
      if (err?.code !== 'EEXIST') await rm(to, { force: true }).catch(() => {})
      throw err
    }
    return
  }
  await mkdir(to) // fails when `to` exists: from here on everything under it is ours
  try {
    const stack: [string, string][] = [[from, to]]
    while (stack.length) {
      const [src, dst] = stack.pop()!
      const names = await readdir(src)
      for (let i = 0; i < names.length; i += COPY_BATCH) {
        const batch = names.slice(i, i + COPY_BATCH)
        // allSettled: nothing of this batch may still be writing when a failure removes the copy
        const done = await Promise.allSettled(batch.map(async n => {
          const s = join(src, n)
          const d = join(dst, n)
          const st = await lstat(s)
          if (st.isDirectory()) { await mkdir(d); stack.push([s, d]) }
          else if (st.isFile()) await copyFile(s, d, FS.COPYFILE_EXCL)
          // links, sockets and pipes are left out
        }))
        const failed = done.find(r => r.status === 'rejected')
        if (failed) throw (failed as PromiseRejectedResult).reason
      }
    }
  } catch (err) {
    await rm(to, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

export function ensureDir(abs: string) {
  mkdirSync(abs, { recursive: true })
}

/** bytes free for this process on the disk holding `abs`, or null when the platform can not tell */
export function freeSpace(abs: string): number | null {
  try {
    const s = statfsSync(abs)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

/** refuse to write `size` more bytes when that would leave the disk below the configured reserve */
export function ensureSpace(abs: string, size: number) {
  const free = freeSpace(abs)
  if (free !== null && free - size < config.minFreeSpace) {
    throw new HttpError(507, 'disk-full')
  }
}

/** entries looked at between two breaks, so other requests are answered while a big tree is counted */
const STATS_BATCH = 2000
/** files copied at the same time: enough to keep the disk busy, few enough to stay far from the open-file limit */
const COPY_BATCH = 64

/**
 * total size and file count of a directory tree (symlinks skipped). Asynchronous: a tree of a million entries
 * takes seconds, and the server keeps answering everyone else meanwhile.
 */
export async function treeStats(abs: string, limit = Infinity): Promise<{ size: number; files: number; truncated: boolean }> {
  let size = 0
  let files = 0
  let seen = 0
  const stack = [abs]
  while (stack.length) {
    const dir = stack.pop()!
    let names: string[]
    try { names = await readdir(dir) } catch { continue }
    for (let i = 0; i < names.length; i += STATS_BATCH) {
      const batch = names.slice(i, i + STATS_BATCH)
      const room = limit - seen
      const truncated = batch.length > room
      const stats = await Promise.all(batch.slice(0, room).map(n => lstat(join(dir, n)).catch(() => null)))
      seen += stats.length
      for (let k = 0; k < stats.length; k++) {
        const st = stats[k]
        if (!st || st.isSymbolicLink()) continue
        if (st.isDirectory()) stack.push(join(dir, batch[k]))
        else { size += st.size; files++ }
      }
      if (truncated) return { size, files, truncated }
    }
  }
  return { size, files, truncated: false }
}

/**
 * entries of the tree under `abs` whose name contains `needle` (lower case), links skipped. Stops after `maxSeen`
 * entries or `maxResults` hits with `truncated: true`. Asynchronous in batches like treeStats.
 */
export async function searchTree(abs: string, rel: string, needle: string, maxSeen = 50_000, maxResults = 200) {
  const results: Entry[] = []
  const stack: [string, string][] = [[abs, rel]]
  let seen = 0
  while (stack.length) {
    const [dir, dirRel] = stack.pop()!
    let names: string[]
    try { names = await readdir(dir) } catch { continue }
    for (let i = 0; i < names.length; i += STATS_BATCH) {
      const batch = names.slice(i, i + STATS_BATCH)
      // one more than the room left, so that "there was more" is still noticed
      const look = batch.slice(0, Math.max(0, maxSeen - seen + 1))
      const stats = await Promise.all(look.map(n => lstat(join(dir, n)).catch(() => null)))
      for (let k = 0; k < look.length; k++) {
        if (++seen > maxSeen || results.length >= maxResults) return { results, truncated: true }
        const e = entryOf(join(dir, look[k]), joinRel(dirRel, look[k]), stats[k])
        if (!e) continue
        if (e.name.toLowerCase().includes(needle)) results.push(e)
        if (e.type === 'dir') stack.push([join(dir, look[k]), e.path])
      }
    }
  }
  return { results, truncated: false }
}

export { within }
