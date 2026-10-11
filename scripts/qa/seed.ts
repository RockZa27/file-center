/**
 * Seeded bugs: small, known mistakes planted in a throw-away copy of the code. They answer two questions
 * with a number instead of a feeling:
 *   check    does the test suite catch each planted bug?  (mutation score, written to qa/results/seeded-<id>.json)
 *   prepare  give an auditor a copy with some bugs planted, so its recall can be measured
 *
 *   bun scripts/qa/seed.ts check [--ids a,b] [--run-id id]
 *   bun scripts/qa/seed.ts prepare <dir> <ids|all> [--blind]   (prints where each bug is)
 *       --blind: a plain copy for an auditor: no .git (so no diff shows the bugs), no qa/, no .claude/
 *   bun scripts/qa/seed.ts clean <dir>
 * Works on committed code (git worktree of HEAD): commit before running. The real tree is never modified.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { SeededBug } from './types'

const root = resolve(import.meta.dir, '..', '..')
const bugs: SeededBug[] = JSON.parse(readFileSync(join(root, 'qa', 'seeded', 'bugs.json'), 'utf8'))
const [cmd, ...rest] = process.argv.slice(2)

const run = async (cmd: string[], cwd = root, env: Record<string, string> = {}) => {
  const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { out, err, code }
}

export function lineOf(bug: SeededBug, dir = root) {
  const src = readFileSync(join(dir, bug.file), 'utf8')
  const i = src.indexOf(bug.find)
  return i < 0 ? null : src.slice(0, i).split('\n').length
}

async function prepare(dir: string, ids: string[], blind = false) {
  if (blind) {
    mkdirSync(dir, { recursive: true })
    const r = await run(['bash', '-c', `git archive HEAD | tar -x -C ${JSON.stringify(dir)}`])
    if (r.code !== 0) throw new Error(r.err)
    for (const hidden of ['qa', '.claude', 'scripts/qa']) rmSync(join(dir, hidden), { recursive: true, force: true })
  } else {
    const r = await run(['git', 'worktree', 'add', '--detach', dir, 'HEAD'])
    if (r.code !== 0) throw new Error(r.err)
  }
  // dependencies and the compiled web page are not in git
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'))
  if (existsSync(join(root, 'web', 'dist'))) symlinkSync(join(root, 'web', 'dist'), join(dir, 'web', 'dist'))
  const where: Record<string, { file: string; line: number | null; category: string }> = {}
  for (const id of ids) {
    const bug = bugs.find(b => b.id === id)
    if (!bug) throw new Error(`unknown seeded bug ${id}`)
    const path = join(dir, bug.file)
    const src = readFileSync(path, 'utf8')
    if (src.split(bug.find).length !== 2) throw new Error(`${id}: the code to replace is not there exactly once (the code moved: update qa/seeded/bugs.json)`)
    where[id] = { file: bug.file, line: lineOf(bug, dir), category: bug.category }
    writeFileSync(path, src.replace(bug.find, () => bug.replace))
  }
  return where
}

async function clean(dir: string) {
  if (existsSync(join(dir, '.git'))) await run(['git', 'worktree', 'remove', '--force', dir])
  rmSync(dir, { recursive: true, force: true })
}

const pick = (spec: string | undefined) => (!spec || spec === 'all' ? bugs.map(b => b.id) : spec.split(','))

if (cmd === 'prepare') {
  const [dir, spec] = rest
  console.log(JSON.stringify(await prepare(resolve(dir), pick(spec), rest.includes('--blind')), null, 2))
} else if (cmd === 'clean') {
  await clean(resolve(rest[0]))
} else if (cmd === 'check') {
  const i = rest.indexOf('--ids')
  const ids = pick(i >= 0 ? rest[i + 1] : undefined)
  const j = rest.indexOf('--run-id')
  const runId = j >= 0 ? rest[j + 1] : new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const out: { id: string; severity: string; killed: boolean; failedTests: string[] }[] = []
  for (const id of ids) {
    const dir = join('/tmp', `fc-seed-${id}-${process.pid}`)
    mkdirSync('/tmp', { recursive: true })
    try {
      await prepare(dir, [id])
      const bug = bugs.find(b => b.id === id)!
      const r = await run(['bun', 'test', bug.tests], dir, { FC_QA_SEEDED: '1' })
      const failed = [...(r.err + r.out).matchAll(/\(fail\) (.+?) \[/g)].map(m => m[1])
      const killed = r.code !== 0
      out.push({ id, severity: bug.severity, killed, failedTests: failed })
      console.log(`${killed ? 'caught  ' : 'MISSED  '} ${id}${killed ? `  (${failed.length} failing)` : '  ← the tests do not notice this bug'}`)
    } finally {
      await clean(dir)
    }
  }
  const score = out.filter(o => o.killed).length / Math.max(1, out.length)
  mkdirSync(join(root, 'qa', 'results'), { recursive: true })
  writeFileSync(join(root, 'qa', 'results', `seeded-${runId}.json`), JSON.stringify({ runId, bugs: out, mutationScore: score }, null, 2))
  console.log(`\nmutation score ${(score * 100).toFixed(0)}%  (${out.filter(o => o.killed).length}/${out.length} planted bugs caught by tests)`)
} else {
  console.log('usage: seed.ts check [--ids a,b] | prepare <dir> <ids|all> | clean <dir>')
  process.exit(2)
}
