/**
 * Planted bugs and decoys: known mistakes (and known-safe code that only looks suspicious) placed in a
 * throw-away copy of the code. They turn "is the test suite / the auditor any good?" into numbers:
 *   check    does the test suite catch each planted bug?  (mutation score → qa/results/seeded-<runId>.json)
 *   prepare  give an auditor a copy with some bugs and decoys planted; --record saves where they are for the scorer
 *
 *   bun scripts/qa/seed.ts check [--ids a,b] [--run-id id]
 *   bun scripts/qa/seed.ts prepare <dir> <bug ids|all|none> [--decoys all|none|a,b] [--blind] [--record file] [--clean <dir2>]
 *       --blind   a plain copy for an auditor: no .git, qa/, .claude/ or tests/ (they would point at the bugs)
 *       --clean   also make an untouched blind copy at <dir2>: the scorer runs repro scripts there, where they must NOT trigger
 *   bun scripts/qa/seed.ts clean <dir>
 * Copies the working tree as it is (uncommitted changes included). The real tree is never modified.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Decoy, Patch, SeededBug, SeedRecord } from './types'

const root = resolve(import.meta.dir, '..', '..')
const bugs: SeededBug[] = JSON.parse(readFileSync(join(root, 'qa', 'seeded', 'bugs.json'), 'utf8'))
const decoys: Decoy[] = JSON.parse(readFileSync(join(root, 'qa', 'seeded', 'decoys.json'), 'utf8'))
const [cmd, ...rest] = process.argv.slice(2)
const opt = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined }

const run = async (cmd: string[], cwd = root, env: Record<string, string> = {}) => {
  const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { out, err, code }
}

async function copyTree(dir: string, blind: boolean) {
  // tracked + new files, not ignored ones
  mkdirSync(dir, { recursive: true })
  const r = await run(['bash', '-c', `git ls-files -z -co --exclude-standard | tar --null -T - -cf - | tar -xf - -C ${JSON.stringify(dir)}`])
  if (r.code !== 0) throw new Error(r.err)
  if (blind) for (const hidden of ['qa', '.claude', 'scripts/qa', 'tests']) rmSync(join(dir, hidden), { recursive: true, force: true })
  // dependencies and the compiled web page are not in git
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'))
  if (existsSync(join(root, 'web', 'dist'))) symlinkSync(join(root, 'web', 'dist'), join(dir, 'web', 'dist'))
}

/** apply patches in order; returns the line where each one starts in the patched file */
function apply(dir: string, id: string, patches: Patch[]) {
  const where: { file: string; line: number }[] = []
  const at: number[] = []
  for (const pt of patches) {
    const path = join(dir, pt.file)
    const src = readFileSync(path, 'utf8')
    if (src.split(pt.find).length !== 2) throw new Error(`${id}: the code to replace is not in ${pt.file} exactly once (the code moved: update qa/seeded/)`)
    at.push(src.indexOf(pt.find))
    writeFileSync(path, src.replace(pt.find, () => pt.replace))
  }
  // lines are read after every patch of this item, so earlier patches in the same file are accounted for. A patch that
  // only deletes code has no text to look for afterwards: it is placed where the deleted code began
  patches.forEach((pt, k) => {
    const src = readFileSync(join(dir, pt.file), 'utf8')
    const i = pt.replace.trim() ? src.indexOf(pt.replace) : at[k]
    where.push({ file: pt.file, line: src.slice(0, i).split('\n').length })
  })
  return where
}

const pick = <T extends { id: string }>(all: T[], spec: string | undefined, dflt: 'all' | 'none') => {
  const s = spec ?? dflt
  if (s === 'all') return all
  if (s === 'none') return []
  return s.split(',').map(id => { const x = all.find(b => b.id === id); if (!x) throw new Error(`unknown id ${id}`); return x })
}

async function prepare(dir: string, chosen: SeededBug[], chosenDecoys: Decoy[], blind: boolean): Promise<SeedRecord> {
  await copyTree(dir, blind)
  const record: SeedRecord = { dir, bugs: {}, decoys: {} }
  for (const d of chosenDecoys) record.decoys[d.id] = apply(dir, d.id, [d])
  for (const b of chosen) record.bugs[b.id] = apply(dir, b.id, b.patches)
  // decoy lines may have moved if a bug was planted above them in the same file
  for (const d of chosenDecoys) {
    const src = readFileSync(join(dir, d.file), 'utf8')
    record.decoys[d.id] = [{ file: d.file, line: src.slice(0, src.indexOf(d.replace)).split('\n').length }]
  }
  return record
}

if (cmd === 'prepare') {
  const dir = resolve(rest[0])
  const record = await prepare(dir, pick(bugs, rest[1], 'none'), pick(decoys, opt('decoys'), 'none'), rest.includes('--blind'))
  const clean = opt('clean')
  if (clean) {
    await copyTree(resolve(clean), true)
    record.cleanDir = resolve(clean)
  }
  const out = opt('record')
  if (out) writeFileSync(resolve(out), JSON.stringify(record, null, 2))
  console.log(JSON.stringify(record, null, 2))
} else if (cmd === 'clean') {
  rmSync(resolve(rest[0]), { recursive: true, force: true })
} else if (cmd === 'check') {
  const ids = pick(bugs, opt('ids'), 'all')
  const runId = opt('run-id') ?? new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const out: { id: string; difficulty: string; severity: string; killed: boolean; failedTests: string[] }[] = []
  for (const bug of ids) {
    const dir = join('/tmp', `fc-seed-${bug.id}-${process.pid}`)
    try {
      await prepare(dir, [bug], [], false)
      const r = await run(['bun', 'test', bug.tests], dir)
      const failed = [...(r.err + r.out).matchAll(/\(fail\) (.+?) \[/g)].map(m => m[1])
      const killed = r.code !== 0
      out.push({ id: bug.id, difficulty: bug.difficulty, severity: bug.severity, killed, failedTests: failed })
      console.log(`${killed ? 'caught  ' : 'MISSED  '} ${bug.id}${killed ? `  (${failed.length} failing)` : '  ← the tests do not notice this bug'}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const score = out.filter(o => o.killed).length / Math.max(1, out.length)
  mkdirSync(join(root, 'qa', 'results'), { recursive: true })
  writeFileSync(join(root, 'qa', 'results', `seeded-${runId}.json`), JSON.stringify({ runId, bugs: out, mutationScore: score }, null, 2))
  console.log(`\nmutation score ${(score * 100).toFixed(0)}%  (${out.filter(o => o.killed).length}/${out.length} planted bugs caught by tests)`)
  process.exit(score === 1 ? 0 : 1)
} else {
  console.log('usage: seed.ts check [--ids a,b] | prepare <dir> <ids|all|none> [--decoys ..] [--blind] [--record f] [--clean dir2] | clean <dir>')
  process.exit(2)
}
