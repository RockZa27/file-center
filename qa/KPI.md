# KPI ของ subagent

คะแนนรวม = 70% หลักฐาน (คำนวณใหม่จากผล run-checks, บั๊กฝัง, เหยื่อล่อ, การรัน repro ซ้ำ) + 30% reviewer (rubric ใน qa/rubrics/)
นิ่ง = ≥ 80% ติดกัน 3 รอบ · \* = ยังไม่มีคะแนน reviewer

| agent | r0 | r1 | r2 | r3 | r4 | r5 | r6 | r7 | สถานะ |
|---|---|---|---|---|---|---|---|---|---|
| qa-runner | 100% | 100% | - | - | - | - | - | 100% | ปรับต่อ |
| security-auditor | 94% | 100% | 100% | 100% | 100% | 100% | 91% | 100% | นิ่ง |
| verifier | 94% | 77% | 100% | 100% | 100% | 100% | 100% | 100% | นิ่ง |
| backend-dev | - | 100% | 97% | 100% | 94% | 93% | 89% | 89% | นิ่ง |
| frontend-dev | - | 94% | 100% | 91% | 98% | 92% | 100% | 94% | นิ่ง |
| ux-tester | - | 100% | 100% | 100% | 100% | 100% | 98% | 94% | นิ่ง |

## รอบ r7

ชุดตรวจ r7-merged: ผ่าน, เทสต์ 384/385, coverage 95.73%

เทสต์ของระบบจับบั๊กฝังได้ 100%

### qa-runner — 100%
- ✓ numbers match run-checks: 100% (เป้า 100%)
- ✓ flaky tests reported correctly: 100% (เป้า 100%)
- reviewer 5/5: ตัวเลขตรงกับไฟล์ผลทุกช่อง (384/0/1, 95.73%) ใช้ 2 tool call
- ต้นทุน: 20k tokens, 143 วินาที, 2 tool calls

### security-auditor — 100% (+9 จากรอบ r6)
- ✓ precision (findings that are real): 100% (เป้า 70%) — 8/8
- ✓ recall on planted bugs: 100% (เป้า 80%) — 7/7 (easy 2/2, subtle 0/0); missed: -
- ✓ ignores decoys: 100% (เป้า 100%)
- ✓ severity within one level of the truth: 100% (เป้า 80%)
- ✓ every finding has file, line, evidence: 100% (เป้า 100%)
- reviewer 5/5: พบบั๊กฝังครบ 7/7 รวมตัวยาก (ลิงก์ขอไฟล์ตรวจสิทธิ์ download แทน upload) ไม่แตะเหยื่อล่อ และพบช่องจริงที่ไม่ได้ฝัง F7 (ไฟล์สำรองมี secret.key คู่กับความลับ 2FA) ซึ่งแก้แล้ว; F8 จัดระดับถูกว่าเป็นข้อบกพร่องการทำงานไม่ใช่การข้ามโควตา
- ต้นทุน: 154k tokens, 87 วินาที, 36 tool calls

### verifier — 100% (+0 จากรอบ r6)
- ✓ confirms the planted bugs: 100% (เป้า 90%) — 7/7
- ✓ refutes findings on decoys: 100% (เป้า 100%) — no decoy was reported
- ✓ every finding gets a verdict: 100% (เป้า 100%)
- ✓ repro commands reproduce (run twice): 100% (เป้า 100%) — 8/8
- ✓ repro does not trigger on clean code: 100% (เป้า 100%) — 7/7
- ✓ unplanted findings reproduce on the real code: 100% (เป้า 100%) — 1/1
- ✓ CONFIRMED verdicts carry a repro: 100% (เป้า 90%)
- reviewer 5/5: ยืนยัน 8/8 ด้วยสคริปต์ที่ออก 0 บนโค้ดสะอาดทุกตัว ยกเว้น F7 ที่เป็นช่องจริงในโค้ดจริง (ถูกต้อง); ใช้ TRUST_PROXY พิสูจน์ ticket ไม่ผูก IP; เร็ว (93 วิ, 57k tokens)
- ต้นทุน: 57k tokens, 93 วินาที, 31 tool calls

### backend-dev — 89% (-1 จากรอบ r6)
- ✗ [account] green the first time it said "done": 0% (เป้า 100%)
- ✓ [account] green at the end (no regression): 100% (เป้า 100%)
- ✓ [account] added at least one test: 100% (เป้า 100%) — 35 added
- ✓ [account] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [account] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [account] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ [account] test files with new tests fail on the code before the change: 100% (เป้า 100%) — 1/1
- ✓ [quota] green the first time it said "done": 100% (เป้า 100%)
- ✓ [quota] green at the end (no regression): 100% (เป้า 100%)
- ✓ [quota] added at least one test: 100% (เป้า 100%) — 39 added
- ✓ [quota] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [quota] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [quota] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ [quota] test files with new tests fail on the code before the change: 100% (เป้า 100%) — 3/3
- reviewer 4/5: account: ออกแบบดี (ticket ใช้หมดเฉพาะเมื่อรหัสถูก, กุญแจล็อกแยก 2fa-step-up เพราะ confirmPassword ล้างกุญแจเดิม, CLI ถึงแอปที่รันอยู่ผ่าน cli-changed) แต่รอบแรกล้มจากชื่อ message code ของตัวเอง; quota: ชี้ข้อผิดในโจทย์ของผมเอง (public→home ไม่มีจริง) แทนการสร้างของเกิน, จองโควตาแบบไม่มี await คั่น; หัก 1: ข้อความโควตาเป็นไบต์ดิบ (ux พบ ผมแก้) และปล่อย secret.key ลง backup ตามที่โจทย์ให้แค่ 'บอกใน README' แทนที่จะชี้ว่าขัดกับเป้าหมาย

### frontend-dev — 94% (-6 จากรอบ r6)
- ✓ [quota] green the first time it said "done": 100% (เป้า 100%)
- ✓ [quota] green at the end (no regression): 100% (เป้า 100%)
- ✓ [quota] ux-tester flows pass on its page: 100% (เป้า 100%)
- ✓ [quota] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [quota] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [quota] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ [account] green the first time it said "done": 100% (เป้า 100%)
- ✓ [account] green at the end (no regression): 100% (เป้า 100%)
- ✓ [account] ux-tester flows pass on its page: 100% (เป้า 100%)
- ✓ [account] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [account] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [account] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- reviewer 4/5: ครบทั้งสองงาน ux ผ่าน 7/7, QR สร้างในเครื่อง, หมายเหตุลิงก์แสดงเป็นข้อความ; หัก 1: ป้ายไม่ตรงกันระหว่างสรุปลิงก์กับ My links, placeholder 'Please Input' ของ Naive UI ไม่ได้แปล, หน้าต่างอุปกรณ์ไม่ได้ตรวจที่ 375px; account ถูกตัดกลางทางเพราะขีดจำกัด (ไม่นับ)

### ux-tester — 94% (-4 จากรอบ r6)
- ✓ every flow has a screenshot: 100% (เป้า 100%)
- ✓ every failure explains its cause: 100% (เป้า 100%) — no failures
- ✓ flows without unexplained console errors: 100% (เป้า 100%)
- reviewer 4/5: ครบ 7 flow ละเอียด (ตรวจ clipboard, ไฟล์ต้นฉบับบนดิสก์ไม่ถูกทับ, ป้ายเกินขีดหลังหน้าเก่า, scrollWidth ที่ 375px) และแยก HTTP error ที่ตั้งใจได้ถูก; หัก 1: ทิ้งสคริปต์ Playwright ที่ค้างพร้อม Chromium ไว้ (ผมหยุดด้วย PID เอง)
