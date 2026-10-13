# KPI ของ subagent

คะแนนรวม = 70% หลักฐาน (คำนวณใหม่จากผล run-checks, บั๊กฝัง, เหยื่อล่อ, การรัน repro ซ้ำ) + 30% reviewer (rubric ใน qa/rubrics/)
นิ่ง = ≥ 80% ติดกัน 3 รอบ · \* = ยังไม่มีคะแนน reviewer

| agent | r0 | r1 | r2 | r3 | r4 | r5 | r6 | r7 | r8 | สถานะ |
|---|---|---|---|---|---|---|---|---|---|---|
| qa-runner | 100% | 100% | - | - | - | - | - | 100% | - | ปรับต่อ |
| security-auditor | 94% | 100% | 100% | 100% | 100% | 100% | 91% | 100% | 100% | นิ่ง |
| verifier | 94% | 77% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | นิ่ง |
| backend-dev | - | 100% | 97% | 100% | 94% | 93% | 89% | 89% | 92% | นิ่ง |
| frontend-dev | - | 94% | 100% | 91% | 98% | 92% | 100% | 94% | 87% | นิ่ง |
| ux-tester | - | 100% | 100% | 100% | 100% | 100% | 98% | 94% | 98% | นิ่ง |

## รอบ r8

ชุดตรวจ r8-merged: ผ่าน, เทสต์ 433/434, coverage 95.97%

เทสต์ของระบบจับบั๊กฝังได้ 100%

### security-auditor — 100% (+0 จากรอบ r7)
- ✓ precision (findings that are real): 100% (เป้า 70%) — 7/7
- ✓ recall on planted bugs: 100% (เป้า 80%) — 6/6 (easy 1/1, subtle 0/0); missed: -
- ✓ ignores decoys: 100% (เป้า 100%)
- ✓ severity within one level of the truth: 100% (เป้า 80%)
- ✓ every finding has file, line, evidence: 100% (เป้า 100%)
- reviewer 5/5: พบบั๊กฝังครบ 6/6 รวมตัวยาก (คัดลอกข้ามพื้นที่ตรวจแค่ read ที่ปลายทาง) ไม่แตะเหยื่อล่อ และพบช่องจริงที่ไม่ได้ฝัง F7 (office-links.key ลง backup) ซึ่งแก้แล้ว; ระดับความรุนแรงสมเหตุผล
- ต้นทุน: 176k tokens, 107 วินาที, 40 tool calls

### verifier — 100% (+0 จากรอบ r7)
- ✓ confirms the planted bugs: 100% (เป้า 90%) — 6/6
- ✓ refutes findings on decoys: 100% (เป้า 100%) — no decoy was reported
- ✓ every finding gets a verdict: 100% (เป้า 100%)
- ✓ repro commands reproduce (run twice): 100% (เป้า 100%) — 7/7
- ✓ repro does not trigger on clean code: 100% (เป้า 100%) — 6/6
- ✓ unplanted findings reproduce on the real code: 100% (เป้า 100%) — 1/1
- ✓ CONFIRMED verdicts carry a repro: 100% (เป้า 90%)
- reviewer 5/5: ยืนยัน 7/7 ทุกสคริปต์ออก 0 บนโค้ดสะอาด ยกเว้น F7 ที่เป็นช่องจริง (ถูกต้อง); รู้ว่าแอปเริ่มดัชนีเฉพาะตอนรันเป็น server จึงเรียกเองใน helper; บอกตรง ๆ ว่ายังไม่ได้รันบนสำเนาสะอาด
- ต้นทุน: 55k tokens, 139 วินาที, 36 tool calls

### backend-dev — 92% (+4 จากรอบ r7)
- ✓ [search] green the first time it said "done": 100% (เป้า 100%) — excused: test-time budget: machine 1.5x slower after a worker restart (base 157 s vs 106 s before)
- ✓ [search] green at the end (no regression): 100% (เป้า 100%) — budget excused: test-time budget on a machine 1.5x slower after a worker restart (untouched 1.5.0 suite 157 s here vs 106 s before); the budget is now 200 s
- ✓ [search] added at least one test: 100% (เป้า 100%) — 12 added
- ✓ [search] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [search] stayed inside its allowed paths: 100% (เป้า 100%)
- ✗ [search] needed at most one fix round: 33% (เป้า 100%) — 3 qa run(s)
- ✓ [search] test files with new tests fail on the code before the change: 100% (เป้า 100%) — 1/1
- ✓ [versions] green the first time it said "done": 100% (เป้า 100%) — excused: test-time budget: machine 1.5x slower after a worker restart (base 157 s vs 106 s before); the first run also failed the guards check for a renamed test (counted)
- ✓ [versions] green at the end (no regression): 100% (เป้า 100%) — budget excused: test-time budget on a machine 1.5x slower after a worker restart (untouched 1.5.0 suite 157 s here vs 106 s before); the budget is now 200 s
- ✓ [versions] added at least one test: 100% (เป้า 100%) — 36 added
- ✓ [versions] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [versions] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [versions] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ [versions] test files with new tests fail on the code before the change: 100% (เป้า 100%) — 1/1
- reviewer 4/5: versions: ออกแบบรอบคอบ (เวอร์ชันนับโควตาเจ้าของ home, ย้ายข้ามพื้นที่ลงถังขยะเพื่อกู้ได้, ชี้ข้อความ audit office ที่ผิดนอกขอบเขตตัวเอง); search+CI: workflow ผ่านบน GitHub, ci-docker.sh ผ่านทั้งในเครื่องและบน runner, แก้เทสต์ docker-entrypoint ให้รันจริงเมื่อไม่ใช่ root; หัก 1: ดัชนีไม่ถูกใช้เมื่อค้นจาก root (เครื่องหมาย / เกิน) ที่ ux พบ, เทสต์ favorites ไม่จับบั๊กฝัง 'สิทธิ์ไม่ใช่ read', และเทสต์ api พึ่งลำดับไฟล์ (ของเดิม) ที่ CI เผย

### frontend-dev — 87% (-7 จากรอบ r7)
- ✓ [search] green the first time it said "done": 100% (เป้า 100%)
- ✓ [search] green at the end (no regression): 100% (เป้า 100%)
- ✗ [search] ux-tester flows pass on its page: 57% (เป้า 100%)
- ✓ [search] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [search] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [search] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ [versions] green the first time it said "done": 100% (เป้า 100%)
- ✓ [versions] green at the end (no regression): 100% (เป้า 100%)
- ✗ [versions] ux-tester flows pass on its page: 57% (เป้า 100%)
- ✓ [versions] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [versions] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [versions] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- reviewer 4/5: versions: ครบตามโจทย์ ตรวจ read-only ถูก; search: ตัวกรองครบ ทดสอบบน 2,000 ไฟล์ ใส่ตาข่ายกัน placeholder ของ Naive ไว้ใน App.vue; หัก 1: ผู้ใช้ที่อ่าน public ได้อย่างเดียวไม่เห็นเมนูคัดลอกไป home (server อนุญาต), ช่องโควตายังมี 'Please Input', ออกจากระบบที่หน้า Users มี TypeError — ux พบทั้งหมด ผมแก้

### ux-tester — 98% (+4 จากรอบ r7)
- ✓ every flow has a screenshot: 100% (เป้า 100%)
- ✓ every failure explains its cause: 100% (เป้า 100%) — 3 failing flow(s)
- ✗ flows without unexplained console errors: 86% (เป้า 100%)
- reviewer 5/5: 7 flow ละเอียด วัดเวลา (535 ms บน 20,000 ไฟล์), พบบั๊กจริง 4 ข้อพร้อมชี้ต้นเหตุถึงบรรทัด (startInIndex trailing slash, actionsFor can('write')), ทดสอบ office ด้วย stub + JWT จริง, ปิด process ของตัวเองครบทุกตัวตามที่ขอ
