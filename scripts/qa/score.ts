/**
 * Scores every agent of one round from evidence, then writes qa/kpi.json and qa/KPI.md.
 *
 *   bun scripts/qa/score.ts <round> [--rerun-repro]
 *
 * Reads qa/reports/<round>/:
 *   round.json      { "checkRunId": "...", "seededRunId": "..." }          which run-checks / seed check results to trust
 *   <agent>.json    what the agent reported (shapes in scripts/qa/types.ts)
 *   review.json     { "<agent>": { "score": 0-5, "notes": "..." } }       the orchestrator's rubric score (qa/rubrics/)
 * Score = 70% evidence (numbers re-computed here from run-checks results, repro commands and planted bugs)
 *       + 30% reviewer. An agent is "stable" after 3 rounds in a row at or above 0.8.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SEVERITIES, type AuditorReport, type CheckResult, type DevReport, type Review, type RunnerReport, type SeededBug, type UxReport, type VerifierReport } from './types'

const root = resolve(import.meta.dir, '..', '..')
const [round, ...flags] = process.argv.slice(2)
if (!round) { console.error('usage: score.ts <round> [--rerun-repro]'); process.exit(2) }
const dir = join(root, 'qa', 'reports', round)
const read = <T>(p: string): T | null => { try { return JSON.parse(readFileSync(p, 'utf8')) as T } catch { return null } }
const agent = <T>(name: string) => read<T>(join(dir, `${name}.json`))
const result = (id?: string) => (id ? read<CheckResult>(join(root, 'qa', 'results', `${id}.json`)) : null)

type Kpi = { name: string; value: number; target: number; weight: number; pass: boolean; note?: string }
type Score = { evidence: number; review: number | null; composite: number; kpis: Kpi[]; missing?: string }

const kpi = (name: string, value: number, target: number, weight = 1, note?: string): Kpi =>
  ({ name, value: Math.round(value * 1000) / 1000, target, weight, pass: value >= target, note })
/** each KPI counts as value/target, at most 1 */
const evidenceOf = (ks: Kpi[]) => ks.reduce((s, k) => s + Math.min(1, k.value / k.target) * k.weight, 0) / Math.max(1e-9, ks.reduce((s, k) => s + k.weight, 0))
const frac = (a: number, b: number) => (b === 0 ? 1 : a / b)

const bugs = read<SeededBug[]>(join(root, 'qa', 'seeded', 'bugs.json')) ?? []
const lineOfBug = (b: SeededBug) => {
  try { const s = readFileSync(join(root, b.file), 'utf8'); const i = s.indexOf(b.find); return i < 0 ? null : s.slice(0, i).split('\n').length } catch { return null }
}

const round0 = read<{ checkRunId?: string; seededRunId?: string }>(join(dir, 'round.json')) ?? {}
const checks = result(round0.checkRunId)
const reviews = read<Review>(join(dir, 'review.json')) ?? {}
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
  const truth = result(r?.runId) ?? checks
  if (!r || !truth) scores['qa-runner'] = { evidence: 0, review: null, composite: 0, kpis: [], missing: 'no report or no check result' }
  else {
    const t = truth
    const fields = [
      r.reported.typecheck === (t.steps.find(s => s.name === 'typecheck')?.ok ?? false),
      r.reported.passed === t.tests.passed, r.reported.failed === t.tests.failed, r.reported.skipped === t.tests.skipped,
      r.reported.coverageLines === t.coverage.lines,
    ]
    const flakyOk = JSON.stringify([...r.flaky].sort()) === JSON.stringify([...t.tests.flaky].sort())
    scores['qa-runner'] = finish('qa-runner', [
      kpi('numbers match run-checks', fields.filter(Boolean).length / fields.length, 1, 3),
      kpi('flaky tests reported correctly', flakyOk ? 1 : 0, 1, 1),
    ])
  }
}

// ── security-auditor + verifier: precision, recall on planted bugs, severity, reproducibility
{
  const a = agent<AuditorReport>('security-auditor')
  const v = agent<VerifierReport>('verifier')
  if (!a) scores['security-auditor'] = { evidence: 0, review: null, composite: 0, kpis: [], missing: 'no report' }
  else {
    const verdicts = new Map((v?.verdicts ?? []).map(x => [x.findingId, x]))
    const planted = a.seededActive.map(id => bugs.find(b => b.id === id)).filter((b): b is SeededBug => !!b)
    const hit = (f: AuditorReport['findings'][number], b: SeededBug) => f.file === b.file && Math.abs(f.line - (lineOfBug(b) ?? -999)) <= 15
    const caught = planted.filter(b => a.findings.some(f => hit(f, b)))
    const isReal = (f: AuditorReport['findings'][number]) => planted.some(b => hit(f, b)) || verdicts.get(f.id)?.verdict === 'CONFIRMED'
    const real = a.findings.filter(isReal)
    const sevOk = real.filter(f => {
      const vs = verdicts.get(f.id)?.severity ?? planted.find(b => hit(f, b))?.severity
      return vs ? Math.abs(SEVERITIES.indexOf(vs) - SEVERITIES.indexOf(f.severity)) <= 1 : false
    })
    const complete = a.findings.filter(f => f.file && f.line > 0 && f.evidence?.length >= 20)
    scores['security-auditor'] = finish('security-auditor', [
      kpi('precision (findings that are real)', frac(real.length, a.findings.length), 0.7, 2, `${real.length}/${a.findings.length}`),
      kpi('recall on planted bugs', frac(caught.length, planted.length), 0.8, 3, `${caught.length}/${planted.length}${planted.length ? ` missed: ${planted.filter(b => !caught.includes(b)).map(b => b.id).join(', ') || '-'}` : ''}`),
      kpi('severity within one level', frac(sevOk.length, real.length), 0.8, 1),
      kpi('every finding has file, line, evidence', frac(complete.length, a.findings.length), 1, 1),
    ])

    // the verifier is judged against the planted bugs (ground truth) and by re-running its own repro commands
    if (!v) scores.verifier = { evidence: 0, review: null, composite: 0, kpis: [], missing: 'no report' }
    else {
      const onPlanted = a.findings.filter(f => planted.some(b => hit(f, b)))
      const right = onPlanted.filter(f => verdicts.get(f.id)?.verdict === 'CONFIRMED')
      const withRepro = v.verdicts.filter(x => x.repro)
      let reproOk = withRepro.length
      if (flags.includes('--rerun-repro')) {
        reproOk = 0
        for (const x of withRepro) {
          let same = 0
          for (let i = 0; i < 2; i++) {
            const p = Bun.spawnSync(['bash', '-c', x.repro!.command], { cwd: root, timeout: 120_000, stdout: 'ignore', stderr: 'ignore' })
            if (p.exitCode === x.repro!.expectExit) same++
          }
          if (same === 2) reproOk++
        }
      }
      scores.verifier = finish('verifier', [
        kpi('confirms the planted bugs', frac(right.length, onPlanted.length), 0.9, 3, `${right.length}/${onPlanted.length}`),
        kpi('every verdict covers a finding', frac(v.verdicts.filter(x => a.findings.some(f => f.id === x.findingId)).length, Math.max(1, a.findings.length)), 1, 1),
        kpi('repro commands reproduce (run twice)', frac(reproOk, withRepro.length), 1, 2, flags.includes('--rerun-repro') ? `${reproOk}/${withRepro.length}` : 'not re-run (use --rerun-repro)'),
        kpi('CONFIRMED verdicts carry a repro', frac(v.verdicts.filter(x => x.verdict === 'CONFIRMED' && x.repro).length, v.verdicts.filter(x => x.verdict === 'CONFIRMED').length), 0.9, 1),
      ])
    }
  }
}

// ── developers: judged by what run-checks says about their branch
for (const name of ['backend-dev', 'frontend-dev'] as const) {
  const d = agent<DevReport>(name)
  if (!d) continue
  const first = result(d.runIdFirst), final = result(d.runIdFinal)
  if (!first || !final) { scores[name] = { evidence: 0, review: null, composite: 0, kpis: [], missing: 'run ids in the report have no result file' }; continue }
  const g = final.guards
  scores[name] = finish(name, [
    kpi('tests green the first time it said "done"', first.ok ? 1 : 0, 1, 2),
    kpi('tests green at the end (no regression)', final.ok ? 1 : 0, 1, 3),
    kpi('added at least one test', (g?.addedTests.length ?? 0) >= 1 ? 1 : 0, 1, 1, g ? `${g.addedTests.length} added` : 'no --base given: not measurable'),
    kpi('no removed tests, no skips', g && g.removedTests.length + g.skipAdded.length === 0 ? 1 : 0, 1, 2),
    kpi('stayed inside its allowed paths', g && g.outOfScope.length === 0 ? 1 : 0, 1, 2, g?.outOfScope.join(', ')),
    kpi('needed at most one fix round', d.iterations <= 2 ? 1 : 1 / d.iterations, 1, 1, `${d.iterations} iteration(s)`),
  ])
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
const seeded = read<{ mutationScore: number; bugs: { id: string; killed: boolean }[] }>(join(root, 'qa', 'results', `seeded-${round0.seededRunId}.json`))
const suite = seeded ? { mutationScore: seeded.mutationScore, missed: seeded.bugs.filter(b => !b.killed).map(b => b.id) } : null

// ── history
const kpiFile = join(root, 'qa', 'kpi.json')
const history = read<{ rounds: Record<string, { at: string; check: { runId: string; ok: boolean; passed: number; total: number; lines: number | null } | null; suite: typeof suite; agents: Record<string, Score> }> }>(kpiFile) ?? { rounds: {} }
history.rounds[round] = {
  at: new Date().toISOString(),
  check: checks ? { runId: checks.runId, ok: checks.ok, passed: checks.tests.passed, total: checks.tests.total, lines: checks.coverage.lines } : null,
  suite,
  agents: scores,
}
writeFileSync(kpiFile, JSON.stringify(history, null, 2))

const names = [...new Set(Object.values(history.rounds).flatMap(r => Object.keys(r.agents)))]
const order = Object.keys(history.rounds)
const stable = (n: string) => {
  const last = order.slice(-3).map(r => history.rounds[r].agents[n]?.composite ?? 0)
  return last.length === 3 && last.every(c => c >= 0.8)
}
const pct = (x: number) => `${Math.round(x * 100)}%`
let md = `# KPI ของ subagent\n\nคะแนนรวม = 70% หลักฐาน (คำนวณจากผล run-checks, บั๊กฝัง, repro) + 30% reviewer (rubric ใน qa/rubrics/)\nนิ่ง = ≥ 80% ติดกัน 3 รอบ\n\n| agent | ${order.join(' | ')} | สถานะ |\n|---|${order.map(() => '---').join('|')}|---|\n`
for (const n of names) md += `| ${n} | ${order.map(r => { const s = history.rounds[r].agents[n]; return s ? `${pct(s.composite)}${s.review === null ? '*' : ''}` : '-' }).join(' | ')} | ${stable(n) ? 'นิ่ง' : 'ปรับต่อ'} |\n`
md += `\n\\* ยังไม่มีคะแนน reviewer: ใช้หลักฐานอย่างเดียว\n`
const latest = history.rounds[round]
md += `\n## รอบ ${round}\n`
if (latest.check) md += `\nชุดตรวจ ${latest.check.runId}: ${latest.check.ok ? 'ผ่าน' : 'ไม่ผ่าน'}, เทสต์ ${latest.check.passed}/${latest.check.total}, coverage ${latest.check.lines ?? '?'}%\n`
if (latest.suite) md += `\nเทสต์จับบั๊กฝังได้ ${pct(latest.suite.mutationScore)}${latest.suite.missed.length ? ` (พลาด: ${latest.suite.missed.join(', ')})` : ''}\n`
for (const [n, s] of Object.entries(latest.agents)) {
  md += `\n### ${n} — ${pct(s.composite)}${s.missing ? ` (${s.missing})` : ''}\n`
  for (const k of s.kpis) md += `- ${k.pass ? '✓' : '✗'} ${k.name}: ${pct(k.value)} (เป้า ${pct(k.target)})${k.note ? ` — ${k.note}` : ''}\n`
  if (reviews[n]) md += `- reviewer ${reviews[n].score}/5: ${reviews[n].notes}\n`
}
writeFileSync(join(root, 'qa', 'KPI.md'), md)
console.log(md)
