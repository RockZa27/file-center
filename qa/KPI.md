# KPI ของ subagent

คะแนนรวม = 70% หลักฐาน (คำนวณใหม่จากผล run-checks, บั๊กฝัง, เหยื่อล่อ, การรัน repro ซ้ำ) + 30% reviewer (rubric ใน qa/rubrics/)
นิ่ง = ≥ 80% ติดกัน 3 รอบ · \* = ยังไม่มีคะแนน reviewer

| agent | r0 | r1 | สถานะ |
|---|---|---|---|
| qa-runner | 100% | 100% | ปรับต่อ |
| security-auditor | 94% | 100% | ปรับต่อ |
| verifier | 94% | 77% | ปรับต่อ |
| backend-dev | - | 100% | ปรับต่อ |
| frontend-dev | - | 94% | ปรับต่อ |
| ux-tester | - | 100% | ปรับต่อ |

## รอบ r1

ชุดตรวจ r1: ผ่าน, เทสต์ 103/104, coverage 82.45%

เทสต์ของระบบจับบั๊กฝังได้ 100%

### qa-runner — 100% (+0 จากรอบ r0)
- ✓ numbers match run-checks: 100% (เป้า 100%)
- ✓ flaky tests reported correctly: 100% (เป้า 100%)
- reviewer 5/5: ตัวเลขตรงไฟล์ผลทุกช่อง รวม failedSteps ส่ง JSON อย่างเดียว
- ต้นทุน: 50k tokens, 41 วินาที, 3 tool calls

### security-auditor — 100% (+6 จากรอบ r0)
- ✓ precision (findings that are real): 100% (เป้า 70%) — 8/8
- ✓ recall on planted bugs: 100% (เป้า 80%) — 7/7 (easy 1/1, subtle 6/6); missed: -
- ✓ ignores decoys: 100% (เป้า 100%)
- ✓ severity within one level of the truth: 100% (เป้า 80%)
- ✓ every finding has file, line, evidence: 100% (เป้า 100%)
- reviewer 5/5: พบบั๊กฝังครบ 7/7 รวมตัวแนบเนียนคำเดียว ไม่แตะเหยื่อล่อ และพบช่องโหว่จริงที่ไม่ได้ฝัง (F8: โค้ดแพ็กเกจรันก่อนถามรหัสผ่าน) พร้อมเส้นทางโจมตีที่ตรวจในโค้ดแล้ว
- ต้นทุน: 123k tokens, 81 วินาที, 24 tool calls

### verifier — 77% (-17 จากรอบ r0)
- ✓ confirms the planted bugs: 100% (เป้า 90%) — 7/7
- ✓ refutes findings on decoys: 100% (เป้า 100%) — no decoy was reported
- ✓ every finding gets a verdict: 100% (เป้า 100%)
- ✓ repro commands reproduce (run twice): 100% (เป้า 100%) — 8/8
- ✓ repro does not trigger on clean code: 100% (เป้า 100%) — 7/7
- ✗ unplanted findings reproduce on the real code: 0% (เป้า 100%) — 0/1
- ✓ CONFIRMED verdicts carry a repro: 100% (เป้า 90%) — F8 (not planted) does not reproduce on the real code
- reviewer 3/5: สคริปต์ 7 ตัวแยกโค้ดเสี่ยง/ปลอดภัยได้จริง แต่ F8 ใส่ SHA-256 ปลอมจึงทำงานได้เพราะบั๊กฝัง F7 เท่านั้น บนโค้ดจริงพิสูจน์ไม่ได้ (ผิดเกณฑ์ repro ต้อง self-contained) และใช้เวลานานที่สุด 12 นาที
- ต้นทุน: 147k tokens, 711 วินาที, 46 tool calls

### backend-dev — 100%
- ✓ [f8] green the first time it said "done": 100% (เป้า 100%)
- ✓ [f8] green at the end (no regression): 100% (เป้า 100%)
- ✓ [f8] added at least one test: 100% (เป้า 100%) — 1 added
- ✓ [f8] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [f8] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [f8] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ [f8] changed test files fail on the code before the change: 100% (เป้า 100%) — 1/1
- ✓ green the first time it said "done": 100% (เป้า 100%)
- ✓ green at the end (no regression): 100% (เป้า 100%)
- ✓ added at least one test: 100% (เป้า 100%) — 10 added
- ✓ no removed tests, no skips: 100% (เป้า 100%)
- ✓ stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ changed test files fail on the code before the change: 100% (เป้า 100%) — 2/2
- reviewer 5/5: backup: ครบสเปก ทำ freeze ของ JsonStore เกินสเปกแต่ปิด race จริงและอธิบายเหตุผล; F8: diff เล็กตรงจุด เทสต์ล้มบนโค้ดเดิม และแจ้งเอกสาร/ข้อความหน้าเว็บที่ล้าสมัยนอกขอบเขตแทนที่จะแก้เอง
- ต้นทุน: 270k tokens, 1137 วินาที, 69 tool calls

### frontend-dev — 94%
- ✓ green the first time it said "done": 100% (เป้า 100%)
- ✓ green at the end (no regression): 100% (เป้า 100%)
- ✓ ux-tester flows pass on its page: 100% (เป้า 100%)
- ✓ no removed tests, no skips: 100% (เป้า 100%)
- ✓ stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- reviewer 4/5: หน้า backup ครบ ไทย/อังกฤษ มือถือได้ ไม่มี console error ทดสอบการกู้คืนจริง; แต่ย้ายโค้ดรอรีสตาร์ตของหน้าอัปเดตแล้วไม่ได้ลองติดตั้งอัปเดตจริง (บอกตรง ๆ ในรายงาน ux-tester มาพิสูจน์ให้ภายหลัง)
- ต้นทุน: 133k tokens, 380 วินาที, 42 tool calls

### ux-tester — 100%
- ✓ flows passed: 100% (เป้า 100%)
- ✓ flows without console errors: 100% (เป้า 100%)
- ✓ every flow has a screenshot: 100% (เป้า 100%)
- reviewer 5/5: ทำทุก flow ด้วยการคลิกจริง ตัดสินจากหน้าจอ ลองติดตั้งอัปเดตจริงเพื่อพิสูจน์โค้ดที่ถูกย้าย เลือก build หน้าเว็บใหม่ลง scratchpad แทนแก้ของในโปรเจกต์ ปิดโปรเซสครบ (ครั้งแรกปิดผิด PID แล้วแก้เองตามต้นไม้โปรเซส)
- ต้นทุน: 111k tokens, 220 วินาที, 32 tool calls
