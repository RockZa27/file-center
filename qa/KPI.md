# KPI ของ subagent

คะแนนรวม = 70% หลักฐาน (คำนวณใหม่จากผล run-checks, บั๊กฝัง, เหยื่อล่อ, การรัน repro ซ้ำ) + 30% reviewer (rubric ใน qa/rubrics/)
นิ่ง = ≥ 80% ติดกัน 3 รอบ · \* = ยังไม่มีคะแนน reviewer

| agent | r0 | r1 | r2 | r3 | สถานะ |
|---|---|---|---|---|---|
| qa-runner | 100% | 100% | - | - | ปรับต่อ |
| security-auditor | 94% | 100% | 100% | 100%* | นิ่ง |
| verifier | 94% | 77% | 100% | 100%* | ปรับต่อ |
| backend-dev | - | 100% | 97% | 100%* | นิ่ง |
| frontend-dev | - | 94% | 100% | - | ปรับต่อ |
| ux-tester | - | 100% | 100% | - | ปรับต่อ |

## รอบ r3

ชุดตรวจ r3-merged2: ผ่าน, เทสต์ 159/160, coverage 89.21%

เทสต์ของระบบจับบั๊กฝังได้ 100%

### security-auditor — 100% (+0 จากรอบ r2)
- ✓ precision (findings that are real): 100% (เป้า 70%) — 6/6
- ✓ recall on planted bugs: 100% (เป้า 80%) — 6/6 (easy 2/2, subtle 4/4); missed: -
- ✓ ignores decoys: 100% (เป้า 100%)
- ✓ severity within one level of the truth: 100% (เป้า 80%)
- ✓ every finding has file, line, evidence: 100% (เป้า 100%)
- ต้นทุน: 112k tokens, 68 วินาที, 28 tool calls

### verifier — 100% (+0 จากรอบ r2)
- ✓ confirms the planted bugs: 100% (เป้า 90%) — 6/6
- ✓ refutes findings on decoys: 100% (เป้า 100%) — no decoy was reported
- ✓ every finding gets a verdict: 100% (เป้า 100%)
- ✓ repro commands reproduce (run twice): 100% (เป้า 100%) — 6/6
- ✓ repro does not trigger on clean code: 100% (เป้า 100%) — 6/6
- ✓ unplanted findings reproduce on the real code: 100% (เป้า 100%) — none to check
- ✓ CONFIRMED verdicts carry a repro: 100% (เป้า 90%)
- ต้นทุน: 41k tokens, 122 วินาที, 15 tool calls

### backend-dev — 100% (+3 จากรอบ r2)
- ✓ [log] green the first time it said "done": 100% (เป้า 100%)
- ✓ [log] green at the end (no regression): 100% (เป้า 100%)
- ✓ [log] added at least one test: 100% (เป้า 100%) — 13 added
- ✓ [log] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [log] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [log] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ [perf] green the first time it said "done": 100% (เป้า 100%)
- ✓ [perf] green at the end (no regression): 100% (เป้า 100%)
- ✓ [perf] added at least one test: 100% (เป้า 100%) — 5 added
- ✓ [perf] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [perf] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [perf] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ต้นทุน: 305k tokens, 1616 วินาที, 153 tool calls
