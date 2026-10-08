import {
  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync,
} from 'node:fs'
import { basename, dirname, extname, join, relative, sep } from 'node:path'

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

export function validName(name: unknown): string {
  if (typeof name !== 'string') throw bad('ชื่อไม่ถูกต้อง')
  const n = name.trim()
  if (!n || n === '.' || n === '..' || n.length > 255) throw bad('ชื่อไม่ถูกต้อง')
  if (BAD_NAME_CHARS.test(n)) throw bad('ชื่อห้ามมีอักขระ \\ / : * ? " < > |')
  return n
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
    const candidate = join(dir, `${stem} (${i})${ext}`)
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
