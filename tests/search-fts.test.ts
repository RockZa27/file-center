/**
 * The trigram index of the search (1.8): needles of 3+ characters ask `entries_fts`, shorter ones keep instr. Whatever
 * path is taken, the answer must be what the old `instr(name_lower, ?)` query gave. Calls the index directly; the
 * storage is shared with the other test files, so every test works in a folder of its own.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Database } from 'bun:sqlite'
import './in-process-env'

let idx: typeof import('../src/search-index')
let paths: typeof import('../src/config').paths

const tag = () => randomBytes(3).toString('hex')
const touch = (abs: string) => {
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, 'x')
}

beforeAll(async () => {
  idx = await import('../src/search-index')
  ;({ paths } = await import('../src/config'))
  const { config } = await import('../src/config')
  mkdirSync(config.storageDir, { recursive: true })
  idx.stopSearchIndex()
  idx.startSearchIndex()
  await idx.scanIndex()
})
afterAll(() => idx.stopSearchIndex())

/** what the old query returned: names with the needle in them, in the order of the index (lower case name, then path) */
function reference(entries: { name: string; path: string }[], needle: string, limit = 500) {
  const buf = (s: string) => Buffer.from(s)
  return entries
    .filter(e => e.name.toLowerCase().includes(needle))
    .sort((a, b) => Buffer.compare(buf(a.name.toLowerCase()), buf(b.name.toLowerCase())) || Buffer.compare(buf(a.path), buf(b.path)))
    .map(e => e.path)
    .slice(0, limit)
}

const NAMES = [
  'report.txt', 'Report-FINAL.TXT', 'รายงานประจำปี.pdf', 'สรุป ผลการเรียน.docx', 'ไทย.txt', 'a"b".txt', 'star*name.txt', 'paren(1).txt',
  'colon:name.txt', 'dash-name-2.txt', "it's here.txt", 'x OR y.txt', 'NEAR(a b).txt', 'name*.txt', '^start.txt', 'AND.txt',
  'ab', 'abc', 'a', 'b.c', 'ünï-cödé.txt', 'ß-sharp.txt', 'İstanbul.txt', 'a%b_c.txt', 'plain.md',
]

describe('needles give what instr gave', () => {
  const top = `fts-${tag()}`
  const root = join(process.env.STORAGE_DIR!, top)
  const all: { name: string; path: string }[] = []

  beforeAll(async () => {
    for (const n of NAMES) {
      touch(join(root, n))
      all.push({ name: n, path: `/${top}/${n}` })
      touch(join(root, 'sub', n))
      all.push({ name: n, path: `/${top}/sub/${n}` })
    }
    mkdirSync(join(root, 'dir.with.dots'))
    all.push({ name: 'dir.with.dots', path: `/${top}/dir.with.dots` }, { name: 'sub', path: `/${top}/sub` })
    idx.indexTouched(root)
    await idx.indexIdle()
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    idx.indexTouched(root)
  })

  const needles = [
    // 1 and 2 characters: instr
    'a', 'b', 'ab', '.c', 'ไ', 'ไท', '"', '*', '(', ')', ':', '-', "'", '%', '_', '^', 'ü',
    // 3+ characters: the trigram index
    'rep', 'report', 'final', 'ไทย', 'รายงาน', 'ประจำปี', 'ผลการ', 'a"b', 'b".', '"b"', '"""', 'star*', '*name', 'ar*', '(1)', 'paren(', ':na',
    '-name-', "'s h", "it's", 'x or y', ' or ', 'near(', 'and', 'name*', '^st', 'ünï', 'cödé', 'a%b', '%b_', 'b_c', '.txt', 'dots', 'ß-s', 'istanbul',
    'zzzz', 'a b', 'abc', 'near(a b)',
    // FTS syntax that must stay plain text
    'a or b', 'a and b', 'not x', 'name:report', '{name_lower} : x', 'x*', '"report" or "ไทย"', 'rep*', 'name_lower:rep', '-report', '(((', '))) ', 'a" or "b',
  ]

  for (const needle of needles) {
    test(`needle ${JSON.stringify(needle)}`, async () => {
      const n = needle.trim().toLowerCase()
      if (!n) return
      const got = await idx.searchEntries(root, `/${top}`, n, idx.parseFilters({ limit: '500' }))
      expect(got.indexed).toBe(true)
      // the start path is the folder: paths come back in its space (`/<top>/...`)
      expect(got.results.map(e => e.path)).toEqual(reference(all, n).filter(p => p.startsWith(`/${top}/`)))
    })
  }

  test('the Thai needle really finds the Thai names, through the trigram index', async () => {
    const got = await idx.searchEntries(root, `/${top}`, 'ไทย', idx.parseFilters({}))
    expect(got.results.map(e => e.path)).toEqual([`/${top}/sub/ไทย.txt`, `/${top}/ไทย.txt`])
  })
})

describe('bounds', () => {
  test('a start folder reaches only what is below it, and a common needle too', async () => {
    const top = `fts-${tag()}`
    const root = join(process.env.STORAGE_DIR!, top)
    touch(join(root, 'docs', 'inside-secret.txt'))
    touch(join(root, 'docs2', 'sibling-secret.txt'))
    touch(join(root, 'docs.old', 'dotted-secret.txt'))
    // more hits than the trigram index is asked for: the other path must give the same bounds
    for (let i = 0; i < 1300; i++) touch(join(root, 'bulk', `common-${String(i).padStart(4, '0')}-secret.txt`))
    idx.indexTouched(root)
    await idx.indexIdle()
    const f = idx.parseFilters({ limit: '500' })
    expect((await idx.searchEntries(join(root, 'docs'), '/docs', 'secret', f)).results.map(e => e.path)).toEqual(['/docs/inside-secret.txt'])
    expect((await idx.searchEntries(join(root, 'docs2'), '/docs2', 'secret', f)).results.map(e => e.path)).toEqual(['/docs2/sibling-secret.txt'])
    const bulk = await idx.searchEntries(join(root, 'bulk'), '/bulk', 'secret', f)
    expect(bulk.truncated).toBe(true)
    expect(bulk.results.length).toBe(500)
    expect(bulk.results[0].path).toBe('/bulk/common-0000-secret.txt')
    expect(bulk.results.every(e => e.path.startsWith('/bulk/'))).toBe(true)
    const small = await idx.searchEntries(join(root, 'docs'), '/docs', 'common', f)
    expect(small.results).toEqual([])
    // sorted and limited like before
    const desc = await idx.searchEntries(join(root, 'bulk'), '/bulk', 'common-12', idx.parseFilters({ order: 'desc', limit: '3' }))
    expect(desc.results.map(e => e.path)).toEqual(['/bulk/common-1299-secret.txt', '/bulk/common-1298-secret.txt', '/bulk/common-1297-secret.txt'])
    expect(desc.truncated).toBe(true)
    rmSync(root, { recursive: true, force: true })
    idx.indexTouched(root)
  })
})

describe('the trigram table follows the entries', () => {
  test('deleted and renamed names leave it, new ones enter it, and it passes its own integrity check', async () => {
    const top = `fts-${tag()}`
    const root = join(process.env.STORAGE_DIR!, top)
    touch(join(root, 'alpha-one', 'beta-two.txt'))
    touch(join(root, 'gamma.txt'))
    idx.indexTouched(root)
    await idx.indexIdle()
    const f = idx.parseFilters({})
    const find = async (n: string) => (await idx.searchEntries(root, `/${top}`, n, f)).results.map(e => e.path)
    expect(await find('beta-two')).toEqual([`/${top}/alpha-one/beta-two.txt`])
    rmSync(join(root, 'alpha-one'), { recursive: true })
    idx.indexTouched(join(root, 'alpha-one'))
    expect(await find('beta-two')).toEqual([])
    expect(await find('alpha')).toEqual([])
    touch(join(root, 'delta-three.txt'))
    idx.indexTouched(join(root, 'delta-three.txt'))
    expect(await find('delta-th')).toEqual([`/${top}/delta-three.txt`])
    // a second scan over rows that stay does not duplicate them
    await idx.scanIndex()
    expect(await find('gamma')).toEqual([`/${top}/gamma.txt`])
    const other = new Database(paths.searchDb)
    try {
      other.exec("INSERT INTO entries_fts (entries_fts) VALUES ('integrity-check')")
    } finally {
      other.close()
    }
    rmSync(root, { recursive: true, force: true })
    idx.indexTouched(root)
  })
})

describe('a search.db of 1.7.x', () => {
  test('is rebuilt with the trigram table; meanwhile the walk answers', async () => {
    const top = `fts-${tag()}`
    const root = join(process.env.STORAGE_DIR!, top)
    touch(join(root, 'migrated-file.txt'))
    idx.stopSearchIndex()
    // the schema of 1.7.x, with a row for a file that is not on the disk
    const old = new Database(paths.searchDb, { create: true })
    old.exec(`DROP TABLE IF EXISTS entries; DROP TABLE IF EXISTS entries_fts;
      CREATE TABLE entries (
        root TEXT NOT NULL, rel TEXT NOT NULL, name_lower TEXT NOT NULL, ext TEXT NOT NULL, type TEXT NOT NULL,
        size INTEGER NOT NULL, mtime INTEGER NOT NULL, gen INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (root, rel)
      ) WITHOUT ROWID;
      CREATE INDEX entries_name ON entries (root, name_lower);
      PRAGMA user_version = 1;`)
    old.query('INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(process.env.STORAGE_DIR!, '/ghost-migrated.txt', 'ghost-migrated.txt', 'txt', 'file', 1, 1, 0)
    old.close()
    idx.startSearchIndex()
    // not trusted until built again: the walk answers, and does not know the ghost
    expect(idx.indexReady()).toBe(false)
    const walking = await idx.searchEntries(root, `/${top}`, 'migrated', idx.parseFilters({}))
    expect(walking.indexed).toBe(false)
    expect(walking.results.map(e => e.path)).toEqual([`/${top}/migrated-file.txt`])
    await idx.scanIndex()
    const done = await idx.searchEntries(process.env.STORAGE_DIR!, '/', 'migrated', idx.parseFilters({}))
    expect(done.indexed).toBe(true)
    expect(done.results.map(e => e.path)).toEqual([`/${top}/migrated-file.txt`])
    const check = new Database(paths.searchDb, { readonly: true })
    try {
      expect(check.query("SELECT count(*) AS n FROM entries_fts WHERE entries_fts MATCH '\"migrated\"'").get()).toEqual({ n: 1 })
    } finally {
      check.close()
    }
    rmSync(root, { recursive: true, force: true })
    idx.indexTouched(root)
  })
})
