/**
 * moveTree: a rename on one disk, a copy and then removing the source across disks (EXDEV). One disk can not
 * produce EXDEV, so the tests hand moveTree a rename step that fails with it and the copy path runs for real.
 * What the old cpSync fallback guaranteed on its own, each kept by a test below:
 *  - never a copy of a folder into itself
 *  - never overwrite what is at the destination (errorOnExist, force: false), nor write through a link put there
 *  - links are not followed (a link is moved as the link)
 *  - nothing half moved: a copy that fails leaves the source as it was and no partial copy
 *  - synchronous, so nothing could arrive in the source during the copy: now it may, and it must not be lost
 */
import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './in-process-env'
import { moveTree } from '../src/fsx'

const base = mkdtempSync(join(tmpdir(), 'fc-move-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

let n = 0
/** a fresh folder for one test */
const box = () => {
  const d = join(base, `t${n++}`)
  mkdirSync(d)
  return d
}
const renames: [string, string][] = []
/** the rename step of a move between two disks */
const otherDisk = async (from: string, to: string) => {
  renames.push([from, to])
  throw Object.assign(new Error(`EXDEV: cross-device link not permitted, rename '${from}' -> '${to}'`), { code: 'EXDEV' })
}

/** every file under `dir` with its content, and every link with its target */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name)
      const st = lstatSync(abs)
      if (st.isSymbolicLink()) out[`${rel}${name}`] = `-> ${readlinkSync(abs)}`
      else if (st.isDirectory()) { out[`${rel}${name}/`] = ''; walk(abs, `${rel}${name}/`) }
      else out[`${rel}${name}`] = readFileSync(abs, 'utf8')
    }
  }
  walk(dir, '')
  return out
}

/** src/ with a nested tree, a link to a file outside it and a link to a folder outside it */
function tree(root: string) {
  const outside = join(root, 'outside')
  mkdirSync(join(outside, 'dir'), { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), 'outside')
  const src = join(root, 'src')
  mkdirSync(join(src, 'a', 'b'), { recursive: true })
  mkdirSync(join(src, 'empty'))
  writeFileSync(join(src, 'top.txt'), 'top')
  writeFileSync(join(src, 'a', 'mid.txt'), 'mid')
  writeFileSync(join(src, 'a', 'b', 'deep.txt'), 'deep')
  writeFileSync(join(src, 'ไฟล์ ไทย.txt'), 'ไทย')
  symlinkSync(join(outside, 'secret.txt'), join(src, 'a', 'link-to-file'))
  symlinkSync('../../outside/dir', join(src, 'a', 'link-to-dir'))
  return { src, outside }
}

describe('moveTree', () => {
  test('on one disk it is one rename, and its errors are passed on as they are', async () => {
    const root = box()
    const { src } = tree(root)
    const before = snapshot(src)
    await moveTree(src, join(root, 'dst'))
    expect(existsSync(src)).toBe(false)
    expect(snapshot(join(root, 'dst'))).toEqual(before)

    // anything but EXDEV is not a reason to copy
    const enoent = moveTree(join(root, 'missing'), join(root, 'nowhere'))
    await expect(enoent).rejects.toMatchObject({ code: 'ENOENT' })
    const denied = moveTree(join(root, 'dst'), join(root, 'other'), async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) })
    await expect(denied).rejects.toMatchObject({ code: 'EACCES' })
    expect(existsSync(join(root, 'other'))).toBe(false)
    expect(snapshot(join(root, 'dst'))).toEqual(before)
  })

  test('across disks the tree is copied for real and the source removed', async () => {
    const root = box()
    const { src, outside } = tree(root)
    const before = snapshot(src)
    const dst = join(root, 'dst')
    renames.length = 0
    await moveTree(src, dst, otherDisk)
    expect(renames).toEqual([[src, dst]])
    expect(existsSync(src)).toBe(false)
    // same files, same contents, and the links are links again with the same target: never followed
    expect(snapshot(dst)).toEqual(before)
    expect(lstatSync(join(dst, 'a', 'link-to-file')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(dst, 'a', 'link-to-dir')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('outside')
    expect(readdirSync(join(outside, 'dir'))).toEqual([])
  })

  test('a single file and a single link move across disks too', async () => {
    const root = box()
    writeFileSync(join(root, 'f.txt'), 'file')
    await moveTree(join(root, 'f.txt'), join(root, 'g.txt'), otherDisk)
    expect(existsSync(join(root, 'f.txt'))).toBe(false)
    expect(readFileSync(join(root, 'g.txt'), 'utf8')).toBe('file')

    symlinkSync('g.txt', join(root, 'link'))
    await moveTree(join(root, 'link'), join(root, 'moved-link'), otherDisk)
    expect(existsSync(join(root, 'link'))).toBe(false)
    expect(lstatSync(join(root, 'moved-link')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(root, 'moved-link'))).toBe('g.txt')
    expect(readFileSync(join(root, 'g.txt'), 'utf8')).toBe('file')
  })

  test('never into itself', async () => {
    const root = box()
    const { src } = tree(root)
    const before = snapshot(src)
    for (const to of [join(src, 'inside'), join(src, 'a', 'b', 'inside')]) {
      const moving = moveTree(src, to, otherDisk)
      await expect(moving).rejects.toMatchObject({ status: 400, code: 'files.copy-into-self' })
    }
    expect(snapshot(src)).toEqual(before)
  })

  test('never overwrites a file or a folder at the destination, and the source stays', async () => {
    const root = box()
    const { src } = tree(root)
    const before = snapshot(src)
    mkdirSync(join(root, 'taken'))
    writeFileSync(join(root, 'taken', 'top.txt'), 'theirs')
    const intoFolder = moveTree(src, join(root, 'taken'), otherDisk)
    await expect(intoFolder).rejects.toMatchObject({ code: 'EEXIST' })
    expect(snapshot(join(root, 'taken'))).toEqual({ 'top.txt': 'theirs' })

    writeFileSync(join(root, 'taken.txt'), 'theirs')
    const ontoFile = moveTree(join(src, 'top.txt'), join(root, 'taken.txt'), otherDisk)
    await expect(ontoFile).rejects.toMatchObject({ code: 'EEXIST' })
    expect(readFileSync(join(root, 'taken.txt'), 'utf8')).toBe('theirs')
    expect(snapshot(src)).toEqual(before)
  })

  test('never writes through a link put where the move goes', async () => {
    const root = box()
    const { src, outside } = tree(root)
    const before = snapshot(src)
    // a link to a folder, and a dangling link to a file that does not exist yet
    symlinkSync(join(outside, 'dir'), join(root, 'to-dir'))
    symlinkSync(join(outside, 'new.txt'), join(root, 'to-file'))
    for (const [from, to] of [[src, 'to-dir'], [join(src, 'top.txt'), 'to-file']]) {
      const moving = moveTree(from, join(root, to), otherDisk)
      await expect(moving).rejects.toMatchObject({ code: 'EEXIST' })
      expect(lstatSync(join(root, to)).isSymbolicLink()).toBe(true)
    }
    expect(readdirSync(join(outside, 'dir'))).toEqual([])
    expect(existsSync(join(outside, 'new.txt'))).toBe(false)
    expect(snapshot(src)).toEqual(before)
  })

  test('a copy that fails half way leaves the source whole and nothing at the destination', async () => {
    const root = box()
    const src = join(root, 's')
    // deep enough to fit under PATH_MAX where it is, too deep once moved under a longer folder name: the files near
    // the top are copied, the deepest one fails with ENAMETOOLONG
    const limit = process.platform === 'linux' ? 4096 : 1024
    const level = 'd'.repeat(200)
    let deep = src
    while ((deep + '/' + level + '/f.txt').length < limit - 20) {
      deep = join(deep, level)
      mkdirSync(deep, { recursive: true })
      writeFileSync(join(deep, 'f.txt'), deep.length.toString())
    }
    writeFileSync(join(src, 'first.txt'), 'first')
    const before = snapshot(src)
    const parent = join(root, 'x'.repeat(250))
    mkdirSync(parent)
    const dst = join(parent, 'moved')
    const moving = moveTree(src, dst, otherDisk)
    await expect(moving).rejects.toMatchObject({ code: 'ENAMETOOLONG' })
    expect(existsSync(dst)).toBe(false)
    expect(readdirSync(parent)).toEqual([])
    expect(snapshot(src)).toEqual(before)
  })

  test('what arrives in the source during the copy is not lost', async () => {
    const root = box()
    const src = join(root, 'src')
    mkdirSync(src)
    // enough files that the copy takes several turns of the event loop
    for (let i = 0; i < 2000; i++) writeFileSync(join(src, `f-${i}.txt`), String(i))
    const dst = join(root, 'dst')
    const moving = moveTree(src, dst, otherDisk)
    // the copy has read the folder once it writes into the destination: a file added now is not in its list
    while (!existsSync(dst) || readdirSync(dst).length === 0) await new Promise(r => setImmediate(r))
    writeFileSync(join(src, 'late.txt'), 'arrived during the copy')
    await moving
    expect(readdirSync(dst).length).toBe(2000)
    expect(readFileSync(join(dst, 'f-1999.txt'), 'utf8')).toBe('1999')
    // the source keeps only what was not copied
    expect(readdirSync(src)).toEqual(['late.txt'])
    expect(readFileSync(join(src, 'late.txt'), 'utf8')).toBe('arrived during the copy')
  })
})
