# KPI ของ subagent

คะแนนรวม = 70% หลักฐาน (คำนวณใหม่จากผล run-checks, บั๊กฝัง, เหยื่อล่อ, การรัน repro ซ้ำ) + 30% reviewer (rubric ใน qa/rubrics/)
นิ่ง = ≥ 80% ติดกัน 3 รอบ · \* = ยังไม่มีคะแนน reviewer

| agent | r0 | r1 | r2 | r3 | r4 | r5 | r6 | สถานะ |
|---|---|---|---|---|---|---|---|---|
| qa-runner | 100% | 100% | - | - | - | - | - | ปรับต่อ |
| security-auditor | 94% | 100% | 100% | 100% | 100% | 100% | 91% | นิ่ง |
| verifier | 94% | 77% | 100% | 100% | 100% | 100% | 100% | นิ่ง |
| backend-dev | - | 100% | 97% | 100% | 94% | 93% | 89% | นิ่ง |
| frontend-dev | - | 94% | 100% | 91% | 98% | 92% | 100% | นิ่ง |
| ux-tester | - | 100% | 100% | 100% | 100% | 100% | 98% | นิ่ง |

## รอบ r6

ชุดตรวจ r6-final: ผ่าน, เทสต์ 305/306, coverage 95.51%

เทสต์ของระบบจับบั๊กฝังได้ 100%

### security-auditor — 91% (-9 จากรอบ r5)
- ✓ precision (findings that are real): 100% (เป้า 70%) — 5/5
- ✗ recall on planted bugs: 71% (เป้า 80%) — 5/7 (easy 1/1, subtle 3/3); missed: office-token-no-expiry, alerts-unscrubbed
- ✓ ignores decoys: 100% (เป้า 100%)
- ✓ severity within one level of the truth: 100% (เป้า 80%)
- ✓ every finding has file, line, evidence: 100% (เป้า 100%)
- reviewer 4/5: 5 ข้อจริงทั้งหมด ไม่แตะเหยื่อล่อ 5 จุด หลักฐานละเอียด (ไล่ได้ว่า callback + SSRF ต่อกันไม่ต้องรู้ secret); หัก 1: พลาดบั๊กฝัง 2 ตัวในโค้ดใหม่ที่ขอให้ดูเป็นพิเศษ — token office ไม่หมดอายุ และ alert ไม่ผ่าน scrub
- ต้นทุน: 151k tokens, 174 วินาที, 44 tool calls

### verifier — 100% (+0 จากรอบ r5)
- ✓ confirms the planted bugs: 100% (เป้า 90%) — 5/5
- ✓ refutes findings on decoys: 100% (เป้า 100%) — no decoy was reported
- ✓ every finding gets a verdict: 100% (เป้า 100%)
- ✓ repro commands reproduce (run twice): 100% (เป้า 100%) — 5/5
- ✓ repro does not trigger on clean code: 100% (เป้า 100%) — 5/5
- ✓ unplanted findings reproduce on the real code: 100% (เป้า 100%) — none to check
- ✓ CONFIRMED verdicts carry a repro: 100% (เป้า 90%)
- reviewer 5/5: ยืนยัน 5/5 ด้วย stub document server จริง, ทุกสคริปต์ออก 0 เมื่อมีตัวกัน; พิสูจน์ว่า fetch ของ Bun อ่าน file: ได้ → ผมเพิ่มการตรวจ scheme ในโค้ดจริง (ประโยชน์เกินหน้าที่)
- ต้นทุน: 73k tokens, 329 วินาที, 36 tool calls

### backend-dev — 89% (-4 จากรอบ r5)
- ✗ [alerts] green the first time it said "done": 0% (เป้า 100%)
- ✓ [alerts] green at the end (no regression): 100% (เป้า 100%)
- ✓ [alerts] added at least one test: 100% (เป้า 100%) — 23 added
- ✓ [alerts] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [alerts] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [alerts] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ [alerts] test files with new tests fail on the code before the change: 100% (เป้า 100%) — 3/3
- ✗ [office] green the first time it said "done": 0% (เป้า 100%)
- ✓ [office] green at the end (no regression): 100% (เป้า 100%)
- ✓ [office] added at least one test: 100% (เป้า 100%) — 16 added
- ✓ [office] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [office] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [office] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ [office] test files with new tests fail on the code before the change: 100% (เป้า 100%) — 1/1
- reviewer 5/5: office: ออกแบบรัดกุมและตัดสินใจเองอย่างมีเหตุผล (key ต่อ storage path, ไม่เขียนไฟล์ที่แปลงชนิด, ALLOW_PRIVATE_IP_ADDRESS ใน compose) พร้อมบอกจุดที่ต้องตัดสินใจ; alerts: startAlerts อยู่ใน main เพื่อไม่ให้เทสต์ flaky, recordFailure คืนค่าล็อกเพื่อ hook แจ้งเตือน. รอบแรกล้มทั้งสองงานจากความพลาดของตัวเอง (ชื่อไฟล์กุญแจชนเทสต์, เทสต์พึ่งชื่อแอป) — นับในส่วนหลักฐานแล้ว

### frontend-dev — 100% (+8 จากรอบ r5)
- ✓ [update] green the first time it said "done": 100% (เป้า 100%) — excused: fresh worktree had no node_modules and tests/release.test.ts links to it (environment; the definitions now say to bun install once)
- ✓ [update] green at the end (no regression): 100% (เป้า 100%)
- ✓ [update] ux-tester flows pass on its page: 100% (เป้า 100%)
- ✓ [update] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [update] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [update] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ [docs] green the first time it said "done": 100% (เป้า 100%)
- ✓ [docs] green at the end (no regression): 100% (เป้า 100%)
- ✓ [docs] ux-tester flows pass on its page: 100% (เป้า 100%)
- ✓ [docs] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [docs] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [docs] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- reviewer 5/5: update: กล่องเดียว + ขั้นที่ล้มจริง + ลองใหม่ บอกตรง ๆ ว่าขั้นระหว่างรอเป็นการประมาณ; docs: CDN ของ SheetJS ถูกบล็อก จึงเขียนตัวอ่าน xlsx/xls/ods เอง (มีเทสต์ 12 ตัวที่จับบั๊กจริง), ทุก viewer โหลดเมื่อใช้, sanitize ด้วย DOMPurify ไม่ใช้ innerHTML; ถูกตัดกลางทางเพราะขีดจำกัดแล้วทำต่อได้ไม่ซ้ำงาน

### ux-tester — 98% (-2 จากรอบ r5)
- ✓ every flow has a screenshot: 100% (เป้า 100%)
- ✓ every failure explains its cause: 100% (เป้า 100%) — no failures
- ✗ flows without unexplained console errors: 86% (เป้า 100%)
- reviewer 5/5: ครบ 7 flow ด้วยไฟล์จริงที่สร้างเอง (รวม xls จาก LibreOffice), ตรวจเนื้อไฟล์บนดิสก์หลังบันทึก CSV, ใช้ LOGIN_LOCKOUT_SECONDS สั้นเพื่อทดสอบ rate limit ของ alert, อธิบาย console error ที่เกิดจากการกรอกของตัวเองตรง ๆ
- ต้นทุน: 169k tokens, 1239 วินาที, 85 tool calls
