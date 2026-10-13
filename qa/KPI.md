# KPI ของ subagent

คะแนนรวม = 70% หลักฐาน (คำนวณใหม่จากผล run-checks, บั๊กฝัง, เหยื่อล่อ, การรัน repro ซ้ำ) + 30% reviewer (rubric ใน qa/rubrics/)
นิ่ง = ≥ 80% ติดกัน 3 รอบ · \* = ยังไม่มีคะแนน reviewer

| agent | r0 | r1 | r2 | r3 | r4 | r5 | r6 | r7 | r8 | r9 | สถานะ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| qa-runner | 100% | 100% | - | - | - | - | - | 100% | - | - | ปรับต่อ |
| security-auditor | 94% | 100% | 100% | 100% | 100% | 100% | 91% | 100% | 100% | 100% | นิ่ง |
| verifier | 94% | 77% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | นิ่ง |
| backend-dev | - | 100% | 97% | 100% | 94% | 93% | 89% | 89% | 92% | 91% | นิ่ง |
| frontend-dev | - | 94% | 100% | 91% | 98% | 92% | 100% | 94% | 87% | - | ปรับต่อ |
| ux-tester | - | 100% | 100% | 100% | 100% | 100% | 98% | 94% | 98% | 100% | นิ่ง |

## รอบ r9

ชุดตรวจ r9-final2: ผ่าน, เทสต์ 480/481, coverage 96.34%

เทสต์ของระบบจับบั๊กฝังได้ 100%

### security-auditor — 100% (+0 จากรอบ r8)
- ✓ precision (findings that are real): 100% (เป้า 70%) — 5/5
- ✓ recall on planted bugs: 100% (เป้า 80%) — 0/0 (easy 0/0, subtle 0/0); missed: -
- ✓ ignores decoys: 100% (เป้า 100%)
- ✓ severity within one level of the truth: 80% (เป้า 80%)
- ✓ every finding has file, line, evidence: 100% (เป้า 100%)
- reviewer 5/5: โค้ดจริงไม่มีบั๊กฝัง: พบ 5 ข้อจริงทั้งหมด ทุกข้อ verifier พิสูจน์ได้ จัดลำดับความเสี่ยงถูก (DoS ไม่ต้องล็อกอินสูงสุด) และชี้ช่องที่สำคัญเชิงระบบ (แพ็กเกจไม่บังคับลายเซ็น) ซึ่งเปลี่ยนการออกแบบของระบบอัปเดต; ไม่มี false positive
- ต้นทุน: 209k tokens, 280 วินาที, 46 tool calls

### verifier — 100% (+0 จากรอบ r8)
- ✓ confirms the planted bugs: 100% (เป้า 90%) — 0/0
- ✓ refutes findings on decoys: 100% (เป้า 100%) — no decoy was reported
- ✓ every finding gets a verdict: 100% (เป้า 100%)
- ✓ repro commands reproduce (run twice): 100% (เป้า 100%) — 5/5
- ✓ repro does not trigger on clean code: 100% (เป้า 100%) — not measured (needs --rerun-repro and a clean copy)
- ✓ unplanted findings reproduce on the real code: 100% (เป้า 100%) — none to check
- ✓ CONFIRMED verdicts carry a repro: 100% (เป้า 90%)
- reviewer 5/5: ยืนยัน 5/5 บนโค้ดจริงด้วยผลที่วัดได้ (health รอ ~4 วิ, 30 ครั้งไม่ล็อก, อัปโหลดเกินโควตาผู้เยี่ยมชม, แพ็กเกจไม่เซ็นรันโค้ดจริงและเขียน marker) ไม่ทำเครื่องล่ม เก็บกวาดเอง
- ต้นทุน: 87k tokens, 478 วินาที, 78 tool calls

### backend-dev — 91% (-1 จากรอบ r8)
- ✓ [speed] green the first time it said "done": 100% (เป้า 100%)
- ✓ [speed] green at the end (no regression): 100% (เป้า 100%)
- ✓ [speed] added at least one test: 100% (เป้า 100%) — 17 added
- ✓ [speed] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [speed] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [speed] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ [speed] test files with new tests fail on the code before the change: 100% (เป้า 100%) — 1/1
- ✓ [fixes] green the first time it said "done": 100% (เป้า 100%)
- ✓ [fixes] green at the end (no regression): 100% (เป้า 100%)
- ✓ [fixes] added at least one test: 100% (เป้า 100%) — 12 added
- ✓ [fixes] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [fixes] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [fixes] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ [fixes] test files with new tests fail on the code before the change: 100% (เป้า 100%) — 1/1
- ✗ [signing] green the first time it said "done": 0% (เป้า 100%)
- ✓ [signing] green at the end (no regression): 100% (เป้า 100%)
- ✓ [signing] added at least one test: 100% (เป้า 100%) — 10 added
- ✓ [signing] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [signing] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [signing] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ [signing] test files with new tests fail on the code before the change: 100% (เป้า 100%) — 3/3
- ✓ [security] green the first time it said "done": 100% (เป้า 100%)
- ✓ [security] green at the end (no regression): 100% (เป้า 100%)
- ✓ [security] added at least one test: 100% (เป้า 100%) — 6 added
- ✓ [security] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [security] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [security] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ [security] test files with new tests fail on the code before the change: 100% (เป้า 100%) — 1/1
- reviewer 4/5: security-ci: workflow ถูกตั้งแต่ครั้งแรก อ่าน action.yaml เองจนเจอเรื่อง SARIF ไม่กรองระดับ, hardening ผ่านทั้งเครื่องนี้และ CI, บอกตรง ๆ ว่า slim ไม่ลดจำนวนแพ็กเกจ; fixes: F1–F4 ครบ repro ออก 0; signing: ออกแบบครบ (ปฏิเสธก่อนดาวน์โหลด, escape hatch พร้อมเตือน+audit); speed: วัดก่อนแก้ แก้เฉพาะที่ตัวเลขยืนยัน (list 3.7 เท่า, bundle 1.1MB→316KB) และไม่อวดผลที่เป็น noise; หัก 1: ข้อความ 'จำนวนรายการไม่ถูกต้อง' ไม่บอกขีดจำกัด, หน้าลิงก์ขอไฟล์บอก 'ไม่จำกัด' ทั้งที่มีค่าเริ่มต้น, ข้อความช่วยเหลือหน้าอัปเดตไม่ตรงกฎใหม่ — ux พบ ผมแก้

### ux-tester — 100% (+2 จากรอบ r8)
- ✓ every flow has a screenshot: 100% (เป้า 100%)
- ✓ every failure explains its cause: 100% (เป้า 100%) — 2 failing flow(s)
- ✓ flows without unexplained console errors: 100% (เป้า 100%)
- reviewer 5/5: 7 flow ตรวจหัว content-encoding/ETag จริง, ติดตั้งแพ็กเกจที่เซ็นด้วยกุญแจทดสอบจนกลับมาเป็น 99.0.0, พบปัญหาจริงที่ผู้ใช้เจอ 3 ข้อ (ข้อความจำนวนรายการ, 'ไม่จำกัด' ที่ไม่จริง, ข้อความช่วยเหลือเก่า) และชี้จุดอ่อนของ log การล็อกอิน; ปิด process ครบ
- ต้นทุน: 86k tokens, 934 วินาที, 58 tool calls
