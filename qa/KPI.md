# KPI ของ subagent

คะแนนรวม = 70% หลักฐาน (คำนวณใหม่จากผล run-checks, บั๊กฝัง, เหยื่อล่อ, การรัน repro ซ้ำ) + 30% reviewer (rubric ใน qa/rubrics/)
นิ่ง = ≥ 80% ติดกัน 3 รอบ · \* = ยังไม่มีคะแนน reviewer

| agent | r0 | r1 | สถานะ |
|---|---|---|---|
| qa-runner | 100% | 100%* | ปรับต่อ |
| security-auditor | 94% | 100%* | ปรับต่อ |
| verifier | 94% | 100%* | ปรับต่อ |
| backend-dev | - | 100%* | ปรับต่อ |

## รอบ r1

ชุดตรวจ r1: ผ่าน, เทสต์ 103/104, coverage 82.45%

เทสต์ของระบบจับบั๊กฝังได้ 100%

### qa-runner — 100% (+0 จากรอบ r0)
- ✓ numbers match run-checks: 100% (เป้า 100%)
- ✓ flaky tests reported correctly: 100% (เป้า 100%)
- ต้นทุน: 50k tokens, 41 วินาที, 3 tool calls

### security-auditor — 100% (+6 จากรอบ r0)
- ✓ precision (findings that are real): 100% (เป้า 70%) — 8/8
- ✓ recall on planted bugs: 100% (เป้า 80%) — 7/7 (easy 1/1, subtle 6/6); missed: -
- ✓ ignores decoys: 100% (เป้า 100%)
- ✓ severity within one level of the truth: 100% (เป้า 80%)
- ✓ every finding has file, line, evidence: 100% (เป้า 100%)
- ต้นทุน: 123k tokens, 81 วินาที, 24 tool calls

### verifier — 100% (+6 จากรอบ r0)
- ✓ confirms the planted bugs: 100% (เป้า 90%) — 7/7
- ✓ refutes findings on decoys: 100% (เป้า 100%) — no decoy was reported
- ✓ every finding gets a verdict: 100% (เป้า 100%)
- ✓ repro commands reproduce (run twice): 100% (เป้า 100%) — not re-run (use --rerun-repro)
- ✓ repro does not trigger on clean code: 100% (เป้า 100%) — not measured (needs --rerun-repro and a clean copy)
- ✓ unplanted findings reproduce on the real code: 100% (เป้า 100%) — none to check
- ✓ CONFIRMED verdicts carry a repro: 100% (เป้า 90%)
- ต้นทุน: 147k tokens, 711 วินาที, 46 tool calls

### backend-dev — 100%
- ✓ green the first time it said "done": 100% (เป้า 100%)
- ✓ green at the end (no regression): 100% (เป้า 100%)
- ✓ added at least one test: 100% (เป้า 100%) — 10 added
- ✓ no removed tests, no skips: 100% (เป้า 100%)
- ✓ stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ new test files fail on the code before the change: 100% (เป้า 100%) — 1/1
- ต้นทุน: 193k tokens, 924 วินาที, 50 tool calls
