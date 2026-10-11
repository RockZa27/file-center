/** Shapes shared by the QA scripts. Agents write reports in these shapes; numbers about the code come from run-checks, never from an agent. */

export type Step = { name: string; ok: boolean; ms: number; detail?: string }

export type CheckResult = {
  runId: string
  at: string
  commit: string
  branch: string
  dirty: boolean
  steps: Step[]
  tests: { total: number; passed: number; failed: number; skipped: number; names: string[]; failedNames: string[]; flaky: string[] }
  coverage: { lines: number | null; funcs: number | null }
  routes: { total: number; uncovered: string[] }
  build: { ok: boolean; webBytes: number; largestAsset: number } | null
  guards: null | { base: string; removedTests: string[]; addedTests: string[]; skipAdded: string[]; outOfScope: string[] }
  ok: boolean
}

export type Severity = 'critical' | 'high' | 'medium' | 'low'
export const SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical']

export type Finding = { id: string; severity: Severity; title: string; file: string; line: number; evidence: string }
export type AuditorReport = { agent: 'security-auditor'; target: string; seededActive: string[]; findings: Finding[] }
export type Verdict = {
  findingId: string
  verdict: 'CONFIRMED' | 'REFUTED'
  severity: Severity
  /** a command that exits with `expectExit` when the problem is real (re-run by the scorer) */
  repro: { command: string; expectExit: number } | null
}
export type VerifierReport = { agent: 'verifier'; verdicts: Verdict[] }
export type RunnerReport = {
  agent: 'qa-runner'
  runId: string
  reported: { typecheck: boolean; passed: number; failed: number; skipped: number; coverageLines: number | null }
  flaky: string[]
}
export type DevReport = {
  agent: 'backend-dev' | 'frontend-dev'
  branch: string
  /** the ref the branch started from */
  base: string
  /** run-checks run ids: the first time the agent said "done", and after its last fix */
  runIdFirst: string
  runIdFinal: string
  iterations: number
}
export type UxReport = { agent: 'ux-tester'; flows: { name: string; passed: boolean; consoleErrors: number; screenshot?: string }[] }
export type Review = Record<string, { score: number; notes: string }>
/** tokens and wall time per agent, copied from the task notifications: shown, not scored */
export type Usage = Record<string, { tokens: number; ms: number; toolUses?: number }>

export type Patch = { file: string; find: string; replace: string }
export type SeededBug = {
  id: string
  /** easy = an obvious `if (false)`; subtle = a plausible-looking change, sometimes in two places */
  difficulty: 'easy' | 'subtle'
  category: string
  severity: Severity
  patches: Patch[]
  /** test file that should fail when the bug is present */
  tests: string
  description: string
}
/** safe code that looks suspicious: a finding on it is a false positive by construction */
export type Decoy = Patch & { id: string; why: string }
/** where `seed.ts prepare --record` planted things, so the scorer matches findings to the copy the auditor saw */
export type SeedRecord = { dir: string; bugs: Record<string, { file: string; line: number }[]>; decoys: Record<string, { file: string; line: number }[]>; cleanDir?: string }
