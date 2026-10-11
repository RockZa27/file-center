# KPI ของ subagent

คะแนนรวม = 70% หลักฐาน (คำนวณใหม่จากผล run-checks, บั๊กฝัง, เหยื่อล่อ, การรัน repro ซ้ำ) + 30% reviewer (rubric ใน qa/rubrics/)
นิ่ง = ≥ 80% ติดกัน 3 รอบ · \* = ยังไม่มีคะแนน reviewer

| agent | r0 | r1 | สถานะ |
|---|---|---|---|
| qa-runner | 100% | 100%* | ปรับต่อ |
| security-auditor | 94% | 100%* | ปรับต่อ |
| verifier | 94% | 85%* | ปรับต่อ |

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

### verifier — 85% (-9 จากรอบ r0)
- ✓ confirms the planted bugs: 100% (เป้า 90%) — 7/7
- ✓ refutes findings on decoys: 100% (เป้า 100%) — no decoy was reported
- ✓ every finding gets a verdict: 100% (เป้า 100%)
- ✓ repro commands reproduce (run twice): 100% (เป้า 100%) — 8/8
- ✓ repro does not trigger on clean code: 100% (เป้า 100%) — 7/7
- ✗ unplanted findings reproduce on the real code: 0% (เป้า 100%) — 0/1
- ✓ CONFIRMED verdicts carry a repro: 100% (เป้า 90%) — F8 (not planted) does not reproduce on the real code
- ต้นทุน: 147k tokens, 711 วินาที, 46 tool calls
