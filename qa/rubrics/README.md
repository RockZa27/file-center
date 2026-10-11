# Rubrics (reviewer score, 30% of an agent's KPI)

The orchestrator scores each agent 0–5 per round in `qa/reports/<round>/review.json`, using ONLY the criteria below, written before the round so scores stay comparable. 5 = all met, 3 = main criteria met with one clear miss, 1 = mostly not met, 0 = unusable. Write one line of notes naming the evidence.

## qa-runner
- Reported the failing step and its first lines, not just "failed" (if anything failed)
- Did not edit, re-run to hide, or round numbers
- Final message was only the JSON

## security-auditor
- Findings point at the line where the defect is, with the exploit path from a real request
- No findings about style, tests, or already-guarded code
- Severities are defensible; no padding to look thorough

## verifier
- Repro scripts are self-contained and distinguish vulnerable from fixed state
- REFUTED verdicts name the guard (file:line)
- Wrote nothing outside `qa/repro/`

## backend-dev / frontend-dev
- Smallest change that solves the spec; matches the surrounding code style
- Tests meaningful (fail without the change), not only happy path
- Honest iteration count; commit message explains why
- (frontend) Thai + English strings, no console errors, works at phone width

## ux-tester
- Flows exercised with real interaction, not just page loads
- Judged pass/fail from what the page shows; screenshots match the claim
- Cleaned up the app process it started

# Where the 70% comes from
`scripts/qa/score.ts` recomputes it: numbers from `qa/results/*.json` (run-checks), planted bugs in `qa/seeded/bugs.json`, repro commands re-run twice. An agent's own claims never count as evidence.
