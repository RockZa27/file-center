/**
 * The one command that decides "is the code good": bun run qa
 *
 *   bun scripts/qa/run-checks.ts [--run-id id] [--skip-build] [--base <git ref>] [--allow "src/**,tests/**"]
 *
 * Builds the web page, type-checks, runs every test with coverage, re-runs failures once to spot flaky tests,
 * checks that every mutating route is named in a test, and (with --base) guards against an agent making the
 * numbers look better by deleting tests, adding .skip, or touching files outside its allowed paths.
 * Writes qa/results/<runId>.json and exits 1 when anything is wrong.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { CheckResult, Step } from './types'

const root = resolve(import.meta.dir, '..', '..')
const args = process.argv.slice(2)
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined }
const flag = (n: string) => args.includes(`--${n}`)

const sh = async (cmd: string[], env: Record<string, string> = {}) => {
  const t = Date.now()
  const p = Bun.spawn(cmd, { cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { out, err, code, ms: Date.now() - t }
}
const git = async (...a: string[]) => (await sh(['git', ...a])).out.trim()

const runId = opt('run-id') ?? new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const steps: Step[] = []
const step = (name: string, ok: boolean, ms: number, detail?: string) => { steps.push({ name, ok, ms, detail }); console.log(`${ok ? '✓' : '✗'} ${name} (${(ms / 1000).toFixed(1)}s)${detail && !ok ? `\n  ${detail.slice(0, 600)}` : ''}`) }

// ── build (the end-to-end update test needs web/dist)
let build: CheckResult['build'] = null
if (!flag('skip-build')) {
  const r = await sh(['bun', '--bun', 'run', 'build'])
  step('build web', r.code === 0, r.ms, r.err.slice(-600))
}
try {
  const dist = join(root, 'web', 'dist')
  let total = 0, largest = 0
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); const s = statSync(p); if (s.isDirectory()) walk(p); else { total += s.size; largest = Math.max(largest, s.size) } } }
  walk(dist)
  build = { ok: steps.find(s => s.name === 'build web')?.ok ?? true, webBytes: total, largestAsset: largest }
} catch { /* no dist yet */ }

// ── typecheck
{
  const r = await sh(['bun', 'run', 'typecheck'])
  step('typecheck', r.code === 0, r.ms, r.out + r.err)
}

// ── tests + coverage
const tmp = mkdtempSync(join(tmpdir(), 'fc-qa-'))
const junit = join(tmp, 'junit.xml')
type Case = { name: string; file: string; failed: boolean; skipped: boolean }
function parseJunit(file: string): Case[] {
  const xml = readFileSync(file, 'utf8')
  const out: Case[] = []
  for (const m of xml.matchAll(/<testcase\s([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attr = (k: string) => new RegExp(`${k}="([^"]*)"`).exec(m[1])?.[1]?.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&apos;', "'") ?? ''
    const body = m[3] ?? ''
    out.push({ name: `${attr('classname')} > ${attr('name')}`.replace(/^ > /, ''), file: attr('file'), failed: /<failure|<error/.test(body), skipped: /<skipped/.test(body) })
  }
  return out
}
let cases: Case[] = []
let coverage: CheckResult['coverage'] = { lines: null, funcs: null }
{
  const r = await sh(['bun', 'test', '--coverage', '--coverage-reporter=text', '--reporter=junit', `--reporter-outfile=${junit}`])
  try { cases = parseJunit(junit) } catch { /* test run crashed before writing */ }
  const all = /All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/.exec(r.err + r.out)
  if (all) coverage = { funcs: Number(all[1]), lines: Number(all[2]) }
  const failed = cases.filter(c => c.failed)
  step('tests', cases.length > 0 && failed.length === 0, r.ms, failed.map(c => c.name).join('\n') || (cases.length ? '' : (r.err + r.out).slice(-600)))
}
const failedCases = cases.filter(c => c.failed)
// a failure that passes when run again alone is flaky, not broken
const flaky: string[] = []
for (const file of new Set(failedCases.map(c => c.file))) {
  const r = await sh(['bun', 'test', file])
  if (r.code === 0) flaky.push(...failedCases.filter(c => c.file === file).map(c => c.name))
}
if (flaky.length) step('flaky tests (passed on re-run)', false, 0, flaky.join('\n'))

// ── every mutating route must be named in a test
let routes: CheckResult['routes'] = { total: 0, uncovered: [] }
{
  const probe = mkdtempSync(join(tmpdir(), 'fc-routes-'))
  const r = await sh(['bun', '-e', "const {app}=await import('./src/index'); console.log('ROUTES'+JSON.stringify(app.routes.map(r=>[r.method,r.path])))"], {
    STORAGE_DIR: join(probe, 's'), DATA_DIR: join(probe, 'd'), ADMIN_PASSWORD: 'qa-probe-password',
  })
  rmSync(probe, { recursive: true, force: true })
  const m = /ROUTES(\[.*\])/.exec(r.out)
  if (m) {
    const list: [string, string][] = JSON.parse(m[1])
    const tests = readdirSync(join(root, 'tests')).map(f => readFileSync(join(root, 'tests', f), 'utf8')).join('\n')
    const mentioned = (method: string, path: string) => tests.includes(`'${method}', '${path}`) || tests.includes(`'${method}', \`${path}`)
    const need = list.filter(([method, path]) => method !== 'HEAD' && (method !== 'GET' || path.startsWith('/api/admin')))
    routes = { total: need.length, uncovered: need.filter(([method, path]) => !mentioned(method, path)).map(([method, path]) => `${method} ${path}`) }
  }
  step('route coverage', routes.total > 0 && routes.uncovered.length === 0, 0, routes.uncovered.join('\n') || (routes.total ? '' : 'could not list routes'))
}

// ── guards against gaming the numbers
let guards: CheckResult['guards'] = null
const base = opt('base')
if (base) {
  const testNames = (src: string) => [...src.matchAll(/\b(?:test|it)\(\s*(['"`])(.+?)\1/g)].map(m => m[2])
  const before = new Set<string>(), after = new Set<string>()
  for (const f of (await git('ls-tree', '-r', '--name-only', base, 'tests')).split('\n').filter(Boolean)) {
    for (const n of testNames(await git('show', `${base}:${f}`))) before.add(n)
  }
  for (const f of readdirSync(join(root, 'tests'))) for (const n of testNames(readFileSync(join(root, 'tests', f), 'utf8'))) after.add(n)
  const diff = await git('diff', base, '--', 'tests')
  const skipAdded = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++') && /\.(skip|only|todo)\b|\b(xit|xdescribe)\(/.test(l))
  let outOfScope: string[] = []
  const allow = opt('allow')
  if (allow) {
    const globs = allow.split(',').map(g => new Bun.Glob(g.trim()))
    const changed = (await git('diff', '--name-only', base)).split('\n').filter(Boolean)
    outOfScope = changed.filter(f => !globs.some(g => g.match(f)))
  }
  guards = {
    base,
    removedTests: [...before].filter(n => !after.has(n)),
    addedTests: [...after].filter(n => !before.has(n)),
    skipAdded,
    outOfScope,
  }
  const bad = guards.removedTests.length + guards.skipAdded.length + guards.outOfScope.length
  step('guards (no removed tests, no skips, in scope)', bad === 0, 0, JSON.stringify({ removed: guards.removedTests, skip: guards.skipAdded, outOfScope: guards.outOfScope }))
}

const result: CheckResult = {
  runId,
  at: new Date().toISOString(),
  commit: await git('rev-parse', '--short', 'HEAD'),
  branch: await git('branch', '--show-current'),
  dirty: (await git('status', '--porcelain')) !== '',
  steps,
  tests: {
    total: cases.length,
    passed: cases.filter(c => !c.failed && !c.skipped).length,
    failed: failedCases.length,
    skipped: cases.filter(c => c.skipped).length,
    names: cases.map(c => c.name),
    failedNames: failedCases.map(c => c.name),
    flaky,
  },
  coverage,
  routes,
  build,
  guards,
  ok: steps.every(s => s.ok),
}
mkdirSync(join(root, 'qa', 'results'), { recursive: true })
writeFileSync(join(root, 'qa', 'results', `${runId}.json`), JSON.stringify(result, null, 2))
rmSync(tmp, { recursive: true, force: true })
console.log(`\n${result.ok ? 'PASS' : 'FAIL'}  run ${runId}  tests ${result.tests.passed}/${result.tests.total} (skipped ${result.tests.skipped})  lines ${coverage.lines ?? '?'}%  routes uncovered ${routes.uncovered.length}`)
process.exit(result.ok ? 0 : 1)
