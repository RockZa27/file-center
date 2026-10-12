# KPI ของ subagent

คะแนนรวม = 70% หลักฐาน (คำนวณใหม่จากผล run-checks, บั๊กฝัง, เหยื่อล่อ, การรัน repro ซ้ำ) + 30% reviewer (rubric ใน qa/rubrics/)
นิ่ง = ≥ 80% ติดกัน 3 รอบ · \* = ยังไม่มีคะแนน reviewer

| agent | r0 | r1 | r2 | r3 | r4 | สถานะ |
|---|---|---|---|---|---|---|
| qa-runner | 100% | 100% | - | - | - | ปรับต่อ |
| security-auditor | 94% | 100% | 100% | 100% | 100% | นิ่ง |
| verifier | 94% | 77% | 100% | 100% | 100% | นิ่ง |
| backend-dev | - | 100% | 97% | 100% | 94% | นิ่ง |
| frontend-dev | - | 94% | 100% | 91% | 98% | นิ่ง |
| ux-tester | - | 100% | 100% | 100% | 100% | นิ่ง |

## รอบ r4

ชุดตรวจ r4-merged3: ผ่าน, เทสต์ 183/184, coverage 91.05%

เทสต์ของระบบจับบั๊กฝังได้ 100%

### security-auditor — 100% (+0 จากรอบ r3)
- ✓ precision (findings that are real): 100% (เป้า 70%) — 7/7
- ✓ recall on planted bugs: 100% (เป้า 80%) — 6/6 (easy 2/2, subtle 2/2); missed: -
- ✓ ignores decoys: 100% (เป้า 100%)
- ✓ severity within one level of the truth: 100% (เป้า 80%)
- ✓ every finding has file, line, evidence: 100% (เป้า 100%)
- reviewer 5/5: รอบแรกที่ไม่บอกชื่อบั๊กฝัง ยังพบ 6/6 + บั๊กจริงที่ไม่ได้ฝัง 1 ตัว (F3 คัดลอกเข้าตัวเองเมื่อชื่อขึ้นต้นด้วย '..') ไม่แตะเหยื่อล่อ 5 จุด ชี้บรรทัดที่ผิดและบอกเงื่อนไขที่ลดความรุนแรง (ต้องมี symlink อยู่ก่อน) ใช้ 2 นาที
- ต้นทุน: 131k tokens, 121 วินาที, 31 tool calls

### verifier — 100% (+0 จากรอบ r3)
- ✓ confirms the planted bugs: 100% (เป้า 90%) — 6/6
- ✓ refutes findings on decoys: 100% (เป้า 100%) — no decoy was reported
- ✓ every finding gets a verdict: 100% (เป้า 100%)
- ✓ repro commands reproduce (run twice): 100% (เป้า 100%) — 7/7
- ✓ repro does not trigger on clean code: 100% (เป้า 100%) — 6/6
- ✓ unplanted findings reproduce on the real code: 100% (เป้า 100%) — 1/1
- ✓ CONFIRMED verdicts carry a repro: 100% (เป้า 90%)
- reviewer 5/5: ยืนยัน 7/7 ด้วยสคริปต์ที่มีตัวควบคุม (แก้เฉพาะจุดในสำเนา scratch แล้วสคริปต์ออก 0) รันซ้ำ ≥3 ครั้ง ระวัง restartSoon ใน F2 ไม่ให้รีสตาร์ตจริง F3 ทำซ้ำได้บนโค้ดสะอาด เขียนเฉพาะใต้ qa/repro/
- ต้นทุน: 52k tokens, 210 วินาที, 22 tool calls

### backend-dev — 94% (-6 จากรอบ r3)
- ✓ [async] green the first time it said "done": 100% (เป้า 100%)
- ✓ [async] green at the end (no regression): 100% (เป้า 100%)
- ✓ [async] added at least one test: 100% (เป้า 100%) — 5 added
- ✓ [async] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [async] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [async] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ [async] test files with new tests fail on the code before the change: 100% (เป้า 100%) — 1/1
- ✓ [dlerr] green the first time it said "done": 100% (เป้า 100%) — excused: the definition told it to run qa with --skip-build, but a fresh worktree has no web/dist and tests/update-signing.test.ts needs it (orchestrator's definition bug; fixed in backend-dev.md)
- ✓ [dlerr] green at the end (no regression): 100% (เป้า 100%)
- ✓ [dlerr] added at least one test: 100% (เป้า 100%) — 6 added
- ✓ [dlerr] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [dlerr] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [dlerr] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ [dlerr] test files with new tests fail on the code before the change: 100% (เป้า 100%) — 1/1
- ✓ [codes] green the first time it said "done": 100% (เป้า 100%)
- ✓ [codes] green at the end (no regression): 100% (เป้า 100%)
- ✓ [codes] added at least one test: 100% (เป้า 100%) — 13 added
- ✓ [codes] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [codes] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [codes] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ [codes] test files with new tests fail on the code before the change: 100% (เป้า 100%) — 1/1
- reviewer 4/5: codes: แค็ตตาล็อกแบบ typed ทำให้รหัสที่ไม่มีอยู่ typecheck ไม่ผ่าน เทสต์ครอบคลุมและบอกสิ่งที่ยังเป็นไทย; async: วัด latency จริง เทสต์ล้มบนโค้ดเดิม บอก moveSync ที่ยังค้าง; dlerr: escape + CSP ของหน้า error ดี. หัก 1: เปลี่ยนจาก cpSync (ที่กันคัดลอกเข้าตัวเองให้เอง) โดยไม่ตรวจว่าตัวกันเดิมใน copyTree ครอบคลุมจริง → เกิดช่อง F3 ที่ auditor ต้องจับให้

### frontend-dev — 98% (+7 จากรอบ r3)
- ✓ green the first time it said "done": 100% (เป้า 100%)
- ✓ green at the end (no regression): 100% (เป้า 100%)
- ✗ ux-tester flows pass on its page: 86% (เป้า 100%)
- ✓ no removed tests, no skips: 100% (เป้า 100%)
- ✓ stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- reviewer 5/5: ทำครบ 4 ข้อ ตรวจเอง 56/56 ที่ 1200/375 ทั้งสองภาษาโดยตั้งภาษาเบราว์เซอร์ตรงข้าม กันคำตอบเก่าทับคำตอบใหม่ตอนสลับภาษา รัน flow อัปโหลด/อัปเดตซ้ำเพราะแก้ putChunk และบอกข้อจำกัด (middle-click, ข้อความที่เก็บเป็นไทย). flow ที่ล้ม (ลิงก์ดาวน์โหลดไฟล์ปกติ) อยู่นอกสเปกที่ผมเขียน — ช่องว่างของสเปก ไม่หักที่นี่ (หลักฐานส่วน 70% นับไปแล้ว)
- ต้นทุน: 146k tokens, 1036 วินาที, 131 tool calls

### ux-tester — 100% (+0 จากรอบ r3)
- ✓ every flow has a screenshot: 100% (เป้า 100%)
- ✓ every failure explains its cause: 100% (เป้า 100%) — 1 failing flow(s)
- ✓ flows without unexplained console errors: 100% (เป้า 100%)
- reviewer 5/5: หากรณีที่ไม่ได้อยู่ในสคริปต์เอง (ดาวน์โหลดไฟล์ที่ถูกลบ → JSON ภาษาเบราว์เซอร์) พร้อมสาเหตุ (ลิงก์ไม่มี x-lang), วัดเวลาจริงระหว่างคัดลอก (สูงสุด 16 ms ที่ API, 356 ms ในหน้า), รายงานข้อจำกัดของเครื่องมือ (drop สังเคราะห์) และวิธีที่ใช้แทน, ปิดแอปด้วย PID ของตัวเอง
- ต้นทุน: 153k tokens, 1090 วินาที, 81 tool calls
