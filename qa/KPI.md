# KPI ของ subagent

คะแนนรวม = 70% หลักฐาน (คำนวณใหม่จากผล run-checks, บั๊กฝัง, เหยื่อล่อ, การรัน repro ซ้ำ) + 30% reviewer (rubric ใน qa/rubrics/)
นิ่ง = ≥ 80% ติดกัน 3 รอบ · \* = ยังไม่มีคะแนน reviewer

| agent | r0 | r1 | r2 | r3 | r4 | r5 | สถานะ |
|---|---|---|---|---|---|---|---|
| qa-runner | 100% | 100% | - | - | - | - | ปรับต่อ |
| security-auditor | 94% | 100% | 100% | 100% | 100% | 100% | นิ่ง |
| verifier | 94% | 77% | 100% | 100% | 100% | 100% | นิ่ง |
| backend-dev | - | 100% | 97% | 100% | 94% | 93% | นิ่ง |
| frontend-dev | - | 94% | 100% | 91% | 98% | 92% | นิ่ง |
| ux-tester | - | 100% | 100% | 100% | 100% | 100% | นิ่ง |

## รอบ r5

ชุดตรวจ r5-final: ผ่าน, เทสต์ 252/253, coverage 94.16%

เทสต์ของระบบจับบั๊กฝังได้ 100%

### security-auditor — 100% (+0 จากรอบ r4)
- ✓ precision (findings that are real): 100% (เป้า 70%) — 7/7
- ✓ recall on planted bugs: 100% (เป้า 80%) — 7/7 (easy 2/2, subtle 3/3); missed: -
- ✓ ignores decoys: 100% (เป้า 100%)
- ✓ severity within one level of the truth: 100% (เป้า 80%)
- ✓ every finding has file, line, evidence: 100% (เป้า 100%)
- reviewer 5/5: พบ 7/7 โดยไม่รู้ชื่อบั๊ก ไม่แตะเหยื่อล่อ 5 จุด ใช้ 3 นาที; ประเมิน F7 (ลิงก์ในโฟลเดอร์แชร์) เป็น low พร้อมเหตุผล (resolveIn ยังกันลิงก์ที่ชี้ออกนอก) ซึ่งถูกกว่าที่ผมตั้งไว้ (high) — verifier ยืนยัน
- ต้นทุน: 164k tokens, 194 วินาที, 45 tool calls

### verifier — 100% (+0 จากรอบ r4)
- ✓ confirms the planted bugs: 100% (เป้า 90%) — 7/7
- ✓ refutes findings on decoys: 100% (เป้า 100%) — no decoy was reported
- ✓ every finding gets a verdict: 100% (เป้า 100%)
- ✓ repro commands reproduce (run twice): 100% (เป้า 100%) — 7/7
- ✓ repro does not trigger on clean code: 100% (เป้า 100%) — 7/7
- ✓ unplanted findings reproduce on the real code: 100% (เป้า 100%) — none to check
- ✓ CONFIRMED verdicts carry a repro: 100% (เป้า 90%)
- reviewer 5/5: ยืนยัน 7/7 รันซ้ำ 2 ครั้ง + ตัวควบคุมด้วยสำเนาที่แก้จุดเดียว; ถูกตัดกลางทางเพราะขีดจำกัดแล้วทำต่อโดยใช้ helper/F1–F3 เดิม ไม่ทำซ้ำ; ระดับความรุนแรงที่ตัดสินทำให้ผมแก้ค่าจริงของบั๊กฝัง 2 ตัว; ใช้ 79k tokens/9 tool calls ในช่วงหลัง
- ต้นทุน: 79k tokens, 142 วินาที, 9 tool calls

### backend-dev — 93% (-1 จากรอบ r4)
- ✗ [backlog] green the first time it said "done": 0% (เป้า 100%)
- ✓ [backlog] green at the end (no regression): 100% (เป้า 100%)
- ✓ [backlog] added at least one test: 100% (เป้า 100%) — 23 added
- ✓ [backlog] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [backlog] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [backlog] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ [backlog] test files with new tests fail on the code before the change: 100% (เป้า 100%) — 4/4
- ✗ [source] green the first time it said "done": 0% (เป้า 100%)
- ✓ [source] green at the end (no regression): 100% (เป้า 100%)
- ✓ [source] added at least one test: 100% (เป้า 100%) — 26 added
- ✓ [source] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [source] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [source] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ [source] test files with new tests fail on the code before the change: 100% (เป้า 100%) — 3/3
- ✓ [share] green the first time it said "done": 100% (เป้า 100%)
- ✓ [share] green at the end (no regression): 100% (เป้า 100%)
- ✓ [share] added at least one test: 100% (เป้า 100%) — 20 added
- ✓ [share] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [share] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [share] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ [share] test files with new tests fail on the code before the change: 100% (เป้า 100%) — 1/1
- reviewer 5/5: share: ออกแบบรัดกุม (เก็บแค่ hash, คุกกี้ HMAC ผูกลิงก์, 404 เดียวทุกกรณี, นับดาวน์โหลดเมื่อจบ/ปฏิเสธ Range เมื่อจำกัดจำนวน) และบอกช่องว่างฝั่งหน้าเว็บ; source: ไม่ตาม redirect, จำกัดขนาด/เวลา, state.json ใช้ได้ทั้งสองทางกับ 1.2.0; backlog: กฎใหม่ได้ผล — moveTree ลิสต์สิ่งที่ cpSync รับประกันแล้วเทสต์ครบ และลบเฉพาะต้นทางที่คัดลอกแล้ว, แก้สเปกผมเรื่อง `docker compose exec id` ที่จะเห็น root. รอบแรกล้ม 2 ใน 3 งานจากความพลาดของตัวเอง (describe.skip, เปลี่ยนชื่อเทสต์) — นับในส่วนหลักฐานแล้ว

### frontend-dev — 92% (-6 จากรอบ r4)
- ✓ green the first time it said "done": 100% (เป้า 100%)
- ✓ green at the end (no regression): 100% (เป้า 100%)
- ✗ ux-tester flows pass on its page: 88% (เป้า 100%)
- ✓ no removed tests, no skips: 100% (เป้า 100%)
- ✓ stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- reviewer 4/5: ทำครบทุกข้อพร้อมของเพิ่มที่จำเป็น (breadcrumb ตัดบรรทัดที่ 375px, ตัวกรองกิจกรรมใหม่) ทดสอบ e2e การอัปเดตทั้งอัปโหลดและดึงจาก source; หัก 1: error ของหน้าอัปเดตไม่ตามการสลับภาษา (เก็บข้อความที่แปลแล้ว) — ปัญหาแบบเดียวกับที่แก้ไว้ในหน้าอื่นเมื่อรอบ 4 ux-tester ต้องจับให้
- ต้นทุน: 274k tokens, 1149 วินาที, 99 tool calls

### ux-tester — 100% (+0 จากรอบ r4)
- ✓ every flow has a screenshot: 100% (เป้า 100%)
- ✓ every failure explains its cause: 100% (เป้า 100%) — 1 failing flow(s)
- ✓ flows without unexplained console errors: 100% (เป้า 100%)
- reviewer 5/5: ครบ 7 flow ด้วยการใช้งานจริง ชี้สาเหตุถึงบรรทัด (UpdateView.vue:249/268), ตรวจไบต์/SHA-256 ของไฟล์ที่ดาวน์โหลด, แยกข้อจำกัดของ headless Chromium (ชื่อไฟล์ไทย) ออกจากบั๊กโดยตรวจ header ด้วย curl, ทำงานรอบ lockout ด้วยลิงก์ที่สองแทนการรอ 15 นาที
- ต้นทุน: 143k tokens, 852 วินาที, 72 tool calls
