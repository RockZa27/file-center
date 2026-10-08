import {
  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statfsSync, statSync,
} from 'node:fs'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { config } from './config'

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message)
  }
}

export const bad = (m: string) => new HttpError(400, m)
export const forbidden = (m = 'ไม่มีสิทธิ์ทำรายการนี้') => new HttpError(403, m)
export const notFound = (m = 'ไม่พบรายการที่ระบุ') => new HttpError(404, m)
export const conflict = (m: string) => new HttpError(409, m)

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
  if (typeof name !== 'string') throw bad('ชื่อไม่ถูกต้อง')
  const n = name.trim()
  if (!n || n === '.' || n === '..') throw bad('ชื่อไม่ถูกต้อง')
  if (bytes(n) > NAME_MAX) throw bad('ชื่อยาวเกินไป (ภาษาไทยได้ประมาณ 85 ตัวอักษร ภาษาอังกฤษ 255 ตัวอักษร)')
  if (BAD_NAME_CHARS.test(n)) throw bad('ชื่อห้ามมีอักขระ \\ / : * ? " < > |')
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

const FS_ERRORS: Record<string, [number, string]> = {
  ENOENT: [404, 'ไม่พบรายการที่ระบุ'],
  ENOTDIR: [404, 'ไม่พบโฟลเดอร์นี้'],
  EISDIR: [400, 'รายการนี้เป็นโฟลเดอร์'],
  EEXIST: [409, 'มีชื่อนี้อยู่แล้ว'],
  ENOTEMPTY: [409, 'มีชื่อนี้อยู่แล้ว'],
  ENAMETOOLONG: [400, 'ชื่อหรือพาธยาวเกินไป'],
  ENOSPC: [507, 'พื้นที่จัดเก็บบนเซิร์ฟเวอร์เต็ม กรุณาติดต่อผู้ดูแลระบบ'],
  EDQUOT: [507, 'พื้นที่จัดเก็บบนเซิร์ฟเวอร์เต็ม กรุณาติดต่อผู้ดูแลระบบ'],
  EACCES: [403, 'เซิร์ฟเวอร์ไม่มีสิทธิ์เข้าถึงรายการนี้'],
  EPERM: [403, 'เซิร์ฟเวอร์ไม่มีสิทธิ์เข้าถึงรายการนี้'],
  EROFS: [403, 'พื้นที่จัดเก็บเป็นแบบอ่านอย่างเดียว'],
  EBUSY: [409, 'รายการนี้กำลังถูกใช้งานอยู่'],
}

/** a clear HttpError for a file-system error (whose own message would show server paths), or null */
export function fromFsError(err: unknown): HttpError | null {
  if (err instanceof HttpError) return err
  const known = FS_ERRORS[(err as any)?.code]
  return known ? new HttpError(known[0], known[1], known[0] === 507 ? 'disk-full' : undefined) : null
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
  if (typeof input !== 'string' || input.includes('\u0000')) throw bad('พาธไม่ถูกต้อง')
  const parts: string[] = []
  for (const seg of input.replaceAll('\\', '/').split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') throw bad('พาธไม่ถูกต้อง')
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
  if (!within(root, abs)) throw bad('พาธไม่ถูกต้อง')
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

export function statEntry(abs: string, rel: string): Entry | null {
  try {
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) return null // never follow or list links
    return {
      name: basename(abs),
      path: rel,
      type: st.isDirectory() ? 'dir' : 'file',
      size: st.isDirectory() ? 0 : st.size,
      mtime: Math.round(st.mtimeMs),
    }
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
  throw conflict('ไม่สามารถตั้งชื่อใหม่ได้')
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

export function copySync(from: string, to: string) {
  if (isDir(from)) {
    const rel = relative(from, to)
    if (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '') {
      if (within(from, to)) throw bad('ไม่สามารถคัดลอกโฟลเดอร์เข้าไปในตัวมันเองได้')
    }
  }
  cpSync(from, to, { recursive: true, errorOnExist: true, force: false, dereference: false })
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
    throw new HttpError(507, 'พื้นที่จัดเก็บบนเซิร์ฟเวอร์ไม่พอ กรุณาติดต่อผู้ดูแลระบบ', 'disk-full')
  }
}

/** total size and file count of a directory tree (symlinks skipped) */
export function treeStats(abs: string, limit = Infinity): { size: number; files: number; truncated: boolean } {
  let size = 0
  let files = 0
  let seen = 0
  let truncated = false
  const stack = [abs]
  while (stack.length) {
    const dir = stack.pop()!
    let names: string[]
    try { names = readdirSync(dir) } catch { continue }
    for (const n of names) {
      if (++seen > limit) { truncated = true; return { size, files, truncated } }
      const p = join(dir, n)
      let st
      try { st = lstatSync(p) } catch { continue }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) stack.push(p)
      else { size += st.size; files++ }
    }
  }
  return { size, files, truncated }
}

export { within }
