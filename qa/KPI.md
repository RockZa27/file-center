# KPI ของ subagent

คะแนนรวม = 70% หลักฐาน (คำนวณใหม่จากผล run-checks, บั๊กฝัง, เหยื่อล่อ, การรัน repro ซ้ำ) + 30% reviewer (rubric ใน qa/rubrics/)
นิ่ง = ≥ 80% ติดกัน 3 รอบ · \* = ยังไม่มีคะแนน reviewer

| agent | r0 | r1 | r2 | สถานะ |
|---|---|---|---|---|
| qa-runner | 100% | 100% | - | ปรับต่อ |
| security-auditor | 94% | 100% | 100%* | นิ่ง |
| verifier | 94% | 77% | 100%* | ปรับต่อ |
| backend-dev | - | 100% | 97%* | ปรับต่อ |
| frontend-dev | - | 94% | - | ปรับต่อ |
| ux-tester | - | 100% | - | ปรับต่อ |

## รอบ r2

เทสต์ของระบบจับบั๊กฝังได้ 100%

### security-auditor — 100% (+0 จากรอบ r1)
- ✓ precision (findings that are real): 100% (เป้า 70%) — 9/9
- ✓ recall on planted bugs: 100% (เป้า 80%) — 9/9 (easy 6/6, subtle 3/3); missed: -
- ✓ ignores decoys: 100% (เป้า 100%)
- ✓ severity within one level of the truth: 100% (เป้า 80%)
- ✓ every finding has file, line, evidence: 100% (เป้า 100%)
- ต้นทุน: 136k tokens, 103 วินาที, 26 tool calls

### verifier — 100% (+23 จากรอบ r1)
- ✓ confirms the planted bugs: 100% (เป้า 90%) — 9/9
- ✓ refutes findings on decoys: 100% (เป้า 100%) — no decoy was reported
- ✓ every finding gets a verdict: 100% (เป้า 100%)
- ✓ repro commands reproduce (run twice): 100% (เป้า 100%) — 8/8
- ✓ repro does not trigger on clean code: 100% (เป้า 100%) — 8/8
- ✓ unplanted findings reproduce on the real code: 100% (เป้า 100%) — none to check
- ✓ CONFIRMED verdicts carry a repro: 100% (เป้า 90%)

### backend-dev — 97% (-3 จากรอบ r1)
- ✓ [sign] green the first time it said "done": 100% (เป้า 100%)
- ✓ [sign] green at the end (no regression): 100% (เป้า 100%)
- ✓ [sign] added at least one test: 100% (เป้า 100%) — 12 added
- ✓ [sign] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [sign] stayed inside its allowed paths: 100% (เป้า 100%)
- ✗ [sign] needed at most one fix round: 33% (เป้า 100%) — 3 qa run(s)
- ✓ [harden] green the first time it said "done": 100% (เป้า 100%)
- ✓ [harden] green at the end (no regression): 100% (เป้า 100%)
- ✓ [harden] added at least one test: 100% (เป้า 100%) — 12 added
- ✓ [harden] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [harden] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [harden] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ต้นทุน: 295k tokens, 1033 วินาที, 82 tool calls
