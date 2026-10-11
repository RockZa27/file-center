/**
 * Scores every agent of one round from evidence, then writes qa/kpi.json and qa/KPI.md.
 *
 *   bun scripts/qa/score.ts <round> [--rerun-repro] [--check-dev-tests]
 *
 * Reads qa/reports/<round>/:
 *   round.json      { "checkRunId": "...", "seededRunId": "..." }   which run-checks / seed check results to trust
 *   seeded.json     written by `seed.ts prepare --record`: where bugs and decoys were planted in the auditor's copy
 *   <agent>.json    what the agent reported (shapes in scripts/qa/types.ts)
 *   review.json     { "<agent>": { "score": 0-5, "notes": "..." } }  the orchestrator's rubric score (qa/rubrics/)
 *   usage.json      { "<agent>": { "tokens": n, "ms": n } }          shown for cost, not scored
 * Score = 70% evidence + 30% reviewer. Evidence is recomputed here: run-checks results, planted bugs and decoys,
 * repro commands re-run twice on the seeded copy AND once on a clean copy (where they must not trigger).
 * An agent is "stable" after 3 rounds in a row at or above 0.8.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  SEVERITIES, type AuditorReport, type CheckResult, type DevReport, type Review, type RunnerReport, type SeededBug, type SeedRecord,
  type Usage, type UxReport, type VerifierReport,
} from './types'

const root = resolve(import.meta.dir, '..', '..')
const [round, ...flags] = process.argv.slice(2)
if (!round) { console.error('usage: score.ts <round> [--rerun-repro] [--check-dev-tests]'); process.exit(2) }
const dir = join(root, 'qa', 'reports', round)
const read = <T>(p: string): T | null => { try { return JSON.parse(readFileSync(p, 'utf8')) as T } catch { return null } }
const agent = <T>(name: string) => read<T>(join(dir, `${name}.json`))
const result = (id?: string) => (id ? read<CheckResult>(join(root, 'qa', 'results', `${id}.json`)) : null)
const sh = (cmd: string, cwd = root) => Bun.spawnSync(['bash', '-c', cmd], { cwd, timeout: 180_000, stdout: 'ignore', stderr: 'ignore' }).exitCode

type Kpi = { name: string; value: number; target: number; weight: number; pass: boolean; note?: string }
type Score = { evidence: number; review: number | null; composite: number; kpis: Kpi[]; missing?: string }

const kpi = (name: string, value: number, target: number, weight = 1, note?: string): Kpi =>
  ({ name, value: Math.round(value * 1000) / 1000, target, weight, pass: value >= target, note })
/** each KPI counts as value/target, at most 1 */
const evidenceOf = (ks: Kpi[]) => ks.reduce((s, k) => s + Math.min(1, k.value / k.target) * k.weight, 0) / Math.max(1e-9, ks.reduce((s, k) => s + k.weight, 0))
const frac = (a: number, b: number) => (b === 0 ? 1 : a / b)
const missing = (why: string): Score => ({ evidence: 0, review: null, composite: 0, kpis: [], missing: why })

const bugs = read<SeededBug[]>(join(root, 'qa', 'seeded', 'bugs.json')) ?? []
const seed = read<SeedRecord>(join(dir, 'seeded.json'))
const near = (f: { file: string; line: number }, locs: { file: string; line: number }[], slack = 5) =>
  locs.some(l => l.file === f.file && Math.abs(l.line - f.line) <= slack)

const meta = read<{ checkRunId?: string; seededRunId?: string }>(join(dir, 'round.json')) ?? {}
const checks = result(meta.checkRunId)
const reviews = read<Review>(join(dir, 'review.json')) ?? {}
const usage = read<Usage>(join(dir, 'usage.json')) ?? {}
const scores: Record<string, Score> = {}

const finish = (name: string, kpis: Kpi[]): Score => {
  const review = reviews[name] ? Math.max(0, Math.min(5, reviews[name].score)) / 5 : null
  const evidence = evidenceOf(kpis)
  // with no reviewer score yet the evidence stands alone, marked by review: null
  return { evidence, review, composite: review === null ? evidence : 0.7 * evidence + 0.3 * review, kpis }
}

// ── qa-runner: do its numbers equal the machine's?
{
  const r = agent<RunnerReport>('qa-runner')
  const t = result(r?.runId) ?? checks
  if (r && t) {
    const fields = [
      r.reported.typecheck === (t.steps.find(s => s.name === 'typecheck')?.ok ?? false),
      r.reported.passed === t.tests.passed, r.reported.failed === t.tests.failed, r.reported.skipped === t.tests.skipped,
      r.reported.coverageLines === t.coverage.lines,
    ]
    scores['qa-runner'] = finish('qa-runner', [
      kpi('numbers match run-checks', fields.filter(Boolean).length / fields.length, 1, 3),
      kpi('flaky tests reported correctly', JSON.stringify([...r.flaky].sort()) === JSON.stringify([...t.tests.flaky].sort()) ? 1 : 0, 1, 1),
    ])
  } else if (r) scores['qa-runner'] = missing('no run-checks result for its run id')
}

// ── security-auditor + verifier
{
  const a = agent<AuditorReport>('security-auditor')
  const v = agent<VerifierReport>('verifier')
  if (a && !seed) scores['security-auditor'] = missing('no seeded.json: run seed.ts prepare with --record qa/reports/<round>/seeded.json')
  else if (a && seed) {
    const verdicts = new Map((v?.verdicts ?? []).map(x => [x.findingId, x]))
    const planted = Object.keys(seed.bugs)
    const bugOf = (f: AuditorReport['findings'][number]) => planted.find(id => near(f, seed.bugs[id]))
    // a finding on a planted bug never counts as a decoy hit, even when a decoy sits a line away
    const onDecoy = (f: AuditorReport['findings'][number]) => !bugOf(f) && Object.values(seed.decoys).some(locs => near(f, locs, 3))
    const caught = planted.filter(id => a.findings.some(f => bugOf(f) === id))
    const decoyHits = a.findings.filter(onDecoy)
    // real = on a planted bug, or confirmed by the verifier on code that is not a decoy
    const real = a.findings.filter(f => !onDecoy(f) && (bugOf(f) || verdicts.get(f.id)?.verdict === 'CONFIRMED'))
    const sevOk = real.filter(f => {
      const truth = verdicts.get(f.id)?.severity ?? bugs.find(b => b.id === bugOf(f))?.severity
      return truth ? Math.abs(SEVERITIES.indexOf(truth) - SEVERITIES.indexOf(f.severity)) <= 1 : false
    })
    const byDiff = (d: string) => { const ids = planted.filter(id => bugs.find(b => b.id === id)?.difficulty === d); return `${d} ${ids.filter(id => caught.includes(id)).length}/${ids.length}` }
    scores['security-auditor'] = finish('security-auditor', [
      kpi('precision (findings that are real)', frac(real.length, a.findings.length), 0.7, 2, `${real.length}/${a.findings.length}`),
      kpi('recall on planted bugs', frac(caught.length, planted.length), 0.8, 3, `${caught.length}/${planted.length} (${byDiff('easy')}, ${byDiff('subtle')}); missed: ${planted.filter(id => !caught.includes(id)).join(', ') || '-'}`),
      kpi('ignores decoys', 1 - frac(decoyHits.length, Math.max(1, Object.keys(seed.decoys).length)), 1, 1, decoyHits.length ? `reported: ${decoyHits.map(f => f.id).join(', ')}` : undefined),
      kpi('severity within one level of the truth', frac(sevOk.length, real.length), 0.8, 1),
      kpi('every finding has file, line, evidence', frac(a.findings.filter(f => f.file && f.line > 0 && f.evidence?.length >= 20).length, a.findings.length), 1, 1),
    ])

    if (v) {
      const onPlanted = a.findings.filter(f => bugOf(f) && !onDecoy(f))
      const rightPlanted = onPlanted.filter(f => verdicts.get(f.id)?.verdict === 'CONFIRMED')
      const rightDecoy = decoyHits.filter(f => verdicts.get(f.id)?.verdict === 'REFUTED')
      const withRepro = v.verdicts.filter(x => x.repro)
      let reproduces = withRepro.length, discriminates = 0, discriminateTotal = 0, standalone = 0, standaloneTotal = 0
      const notes: string[] = []
      if (flags.includes('--rerun-repro')) {
        reproduces = 0
        for (const x of withRepro) {
          const ok = [0, 1].every(() => sh(x.repro!.command) === x.repro!.expectExit)
          if (ok) reproduces++
          else notes.push(`${x.findingId} did not reproduce`)
          // on code without the planted bug the same command must NOT report the problem
          const f = a.findings.find(y => y.id === x.findingId)
          if (seed.cleanDir && f) {
            if (existsSync(join(seed.dir, 'qa', 'repro'))) cpSync(join(seed.dir, 'qa', 'repro'), join(seed.cleanDir, 'qa', 'repro'), { recursive: true })
            const onClean = sh(x.repro!.command.replaceAll(seed.dir, seed.cleanDir))
            if (bugOf(f)) {
              discriminateTotal++
              if (onClean !== x.repro!.expectExit) discriminates++
              else notes.push(`${x.findingId} also "reproduces" on clean code`)
            } else if (x.verdict === 'CONFIRMED') {
              // a real defect that was not planted is in the clean code too: its repro must work there,
              // otherwise it leans on some planted bug (or is not real)
              standaloneTotal++
              if (onClean === x.repro!.expectExit) standalone++
              else notes.push(`${x.findingId} (not planted) does not reproduce on the real code`)
            }
          }
        }
      }
      scores.verifier = finish('verifier', [
        kpi('confirms the planted bugs', frac(rightPlanted.length, onPlanted.length), 0.9, 3, `${rightPlanted.length}/${onPlanted.length}`),
        kpi('refutes findings on decoys', frac(rightDecoy.length, decoyHits.length), 1, 2, decoyHits.length ? `${rightDecoy.length}/${decoyHits.length}` : 'no decoy was reported'),
        kpi('every finding gets a verdict', frac(a.findings.filter(f => verdicts.has(f.id)).length, a.findings.length), 1, 1),
        kpi('repro commands reproduce (run twice)', frac(reproduces, withRepro.length), 1, 2, flags.includes('--rerun-repro') ? `${reproduces}/${withRepro.length}` : 'not re-run (use --rerun-repro)'),
        kpi('repro does not trigger on clean code', frac(discriminates, discriminateTotal), 1, 2, discriminateTotal ? `${discriminates}/${discriminateTotal}` : 'not measured (needs --rerun-repro and a clean copy)'),
        kpi('unplanted findings reproduce on the real code', frac(standalone, standaloneTotal), 1, 2, standaloneTotal ? `${standalone}/${standaloneTotal}` : 'none to check'),
        kpi('CONFIRMED verdicts carry a repro', frac(v.verdicts.filter(x => x.verdict === 'CONFIRMED' && x.repro).length, v.verdicts.filter(x => x.verdict === 'CONFIRMED').length), 0.9, 1, notes.join('; ') || undefined),
      ])
    }
  }
}

// ── developers: judged by what run-checks says about their branch. One agent may do several tasks in a round:
// <agent>.json, <agent>.<task>.json ... each is scored, and the agent's evidence is the mean over all of them.
for (const name of ['backend-dev', 'frontend-dev'] as const) {
  const files = readdirSync(dir).filter(f => f === `${name}.json` || (f.startsWith(`${name}.`) && f.endsWith('.json')))
  if (!files.length) continue
  const all: Kpi[] = []
  const problems: string[] = []
  for (const file of files) {
    const task = file === `${name}.json` ? '' : `[${file.slice(name.length + 1, -5)}] `
    const d = read<DevReport>(join(dir, file))
    const first = result(d?.runIdFirst), final = result(d?.runIdFinal)
    if (!d || !first || !final) { problems.push(`${file}: run ids have no result file`); continue }
    const g = final.guards
    const ks = [
      kpi(`${task}green the first time it said "done"`, first.ok ? 1 : 0, 1, 2),
      kpi(`${task}green at the end (no regression)`, final.ok ? 1 : 0, 1, 3),
      // the web page has no test suite of its own and frontend-dev may not touch tests/: its proof is the ux-tester's flows
      name === 'frontend-dev'
        ? (() => { const u = agent<UxReport>('ux-tester'); return kpi(`${task}ux-tester flows pass on its page`, u ? frac(u.flows.filter(f => f.passed).length, u.flows.length) : 0, 1, 3, u ? undefined : 'no ux-tester report yet') })()
        : kpi(`${task}added at least one test`, (g?.addedTests.length ?? 0) >= 1 ? 1 : 0, 1, 1, g ? `${g.addedTests.length} added` : 'run-checks had no --base'),
      kpi(`${task}no removed tests, no skips`, g && g.removedTests.length + g.skipAdded.length === 0 ? 1 : 0, 1, 2),
      kpi(`${task}stayed inside its allowed paths`, g && g.outOfScope.length === 0 ? 1 : 0, 1, 2, g?.outOfScope.join(', ') || undefined),
      kpi(`${task}needed at most one fix round`, d.iterations <= 2 ? 1 : 1 / d.iterations, 1, 1, `${d.iterations} qa run(s)`),
    ]
    // a test that also passes without the feature tests nothing: run the branch's new tests on the base code
    if (flags.includes('--check-dev-tests') && name === 'backend-dev' && d.base) {
      const out = Bun.spawnSync(['git', 'diff', '--name-only', d.base, d.branch, '--', 'tests'], { cwd: root }).stdout.toString()
      const changed = out.split('\n').filter(f => f.endsWith('.test.ts'))
      if (changed.length) {
        const tmp = mkdtempSync(join(tmpdir(), 'fc-devtests-'))
        sh(`git archive ${d.base} | tar -x -C ${tmp} && ln -s ${root}/node_modules ${tmp}/node_modules && ln -s ${root}/web/dist ${tmp}/web/dist`)
        // the branch's test files (new or changed), run against the code from before the change
        let failWithout = 0
        for (const f of changed) {
          sh(`git show ${d.branch}:${f} > ${join(tmp, f)}`)
          if (sh(`bun test ${f}`, tmp) !== 0) failWithout++
        }
        rmSync(tmp, { recursive: true, force: true })
        ks.push(kpi(`${task}changed test files fail on the code before the change`, frac(failWithout, changed.length), 1, 2, `${failWithout}/${changed.length}`))
      }
    }
    all.push(...ks)
  }
  scores[name] = all.length ? finish(name, all) : missing(problems.join('; '))
}

// ── ux-tester
{
  const u = agent<UxReport>('ux-tester')
  if (u) {
    scores['ux-tester'] = finish('ux-tester', [
      kpi('flows passed', frac(u.flows.filter(f => f.passed).length, u.flows.length), 1, 3),
      kpi('flows without console errors', frac(u.flows.filter(f => f.consoleErrors === 0).length, u.flows.length), 1, 2),
      kpi('every flow has a screenshot', frac(u.flows.filter(f => f.screenshot && existsSync(resolve(root, f.screenshot))).length, u.flows.length), 1, 1),
    ])
  }
}

// ── the test suite itself, measured by the planted bugs
const seeded = read<{ mutationScore: number; bugs: { id: string; killed: boolean; difficulty?: string }[] }>(join(root, 'qa', 'results', `seeded-${meta.seededRunId}.json`))
const suite = seeded ? { mutationScore: seeded.mutationScore, missed: seeded.bugs.filter(b => !b.killed).map(b => b.id) } : null

// ── history + report
const kpiFile = join(root, 'qa', 'kpi.json')
type RoundRec = { at: string; check: { runId: string; ok: boolean; passed: number; total: number; lines: number | null } | null; suite: typeof suite; agents: Record<string, Score>; usage?: Usage }
const history = read<{ rounds: Record<string, RoundRec> }>(kpiFile) ?? { rounds: {} }
history.rounds[round] = {
  at: new Date().toISOString(),
  check: checks ? { runId: checks.runId, ok: checks.ok, passed: checks.tests.passed, total: checks.tests.total, lines: checks.coverage.lines } : null,
  suite,
  agents: scores,
  usage,
}
writeFileSync(kpiFile, JSON.stringify(history, null, 2))

const order = Object.keys(history.rounds)
const names = [...new Set(order.flatMap(r => Object.keys(history.rounds[r].agents)))]
const stable = (n: string) => {
  const last = order.slice(-3).map(r => history.rounds[r].agents[n]?.composite ?? 0)
  return last.length === 3 && last.every(c => c >= 0.8)
}
const pct = (x: number) => `${Math.round(x * 100)}%`
let md = `# KPI ของ subagent\n\nคะแนนรวม = 70% หลักฐาน (คำนวณใหม่จากผล run-checks, บั๊กฝัง, เหยื่อล่อ, การรัน repro ซ้ำ) + 30% reviewer (rubric ใน qa/rubrics/)\nนิ่ง = ≥ 80% ติดกัน 3 รอบ · \\* = ยังไม่มีคะแนน reviewer\n\n| agent | ${order.join(' | ')} | สถานะ |\n|---|${order.map(() => '---').join('|')}|---|\n`
for (const n of names) md += `| ${n} | ${order.map(r => { const s = history.rounds[r].agents[n]; return s ? `${pct(s.composite)}${s.review === null ? '*' : ''}` : '-' }).join(' | ')} | ${stable(n) ? 'นิ่ง' : 'ปรับต่อ'} |\n`
const latest = history.rounds[round]
const prev = order[order.indexOf(round) - 1]
md += `\n## รอบ ${round}\n`
if (latest.check) md += `\nชุดตรวจ ${latest.check.runId}: ${latest.check.ok ? 'ผ่าน' : 'ไม่ผ่าน'}, เทสต์ ${latest.check.passed}/${latest.check.total}, coverage ${latest.check.lines ?? '?'}%\n`
if (latest.suite) md += `\nเทสต์ของระบบจับบั๊กฝังได้ ${pct(latest.suite.mutationScore)}${latest.suite.missed.length ? ` (พลาด: ${latest.suite.missed.join(', ')})` : ''}\n`
for (const [n, s] of Object.entries(latest.agents)) {
  const before = prev ? history.rounds[prev].agents[n]?.composite : undefined
  const delta = before === undefined ? '' : ` (${s.composite >= before ? '+' : ''}${Math.round((s.composite - before) * 100)} จากรอบ ${prev})`
  const u = usage[n]
  md += `\n### ${n} — ${pct(s.composite)}${delta}${s.missing ? ` — ${s.missing}` : ''}\n`
  for (const k of s.kpis) md += `- ${k.pass ? '✓' : '✗'} ${k.name}: ${pct(k.value)} (เป้า ${pct(k.target)})${k.note ? ` — ${k.note}` : ''}\n`
  if (reviews[n]) md += `- reviewer ${reviews[n].score}/5: ${reviews[n].notes}\n`
  if (u) md += `- ต้นทุน: ${Math.round(u.tokens / 1000)}k tokens, ${Math.round(u.ms / 1000)} วินาที${u.toolUses ? `, ${u.toolUses} tool calls` : ''}\n`
}
writeFileSync(join(root, 'qa', 'KPI.md'), md)
console.log(md)
