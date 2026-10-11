# KPI ของ subagent

คะแนนรวม = 70% หลักฐาน (คำนวณใหม่จากผล run-checks, บั๊กฝัง, เหยื่อล่อ, การรัน repro ซ้ำ) + 30% reviewer (rubric ใน qa/rubrics/)
นิ่ง = ≥ 80% ติดกัน 3 รอบ · \* = ยังไม่มีคะแนน reviewer

| agent | r0 | r1 | r2 | r3 | สถานะ |
|---|---|---|---|---|---|
| qa-runner | 100% | 100% | - | - | ปรับต่อ |
| security-auditor | 94% | 100% | 100% | 100% | นิ่ง |
| verifier | 94% | 77% | 100% | 100% | ปรับต่อ |
| backend-dev | - | 100% | 97% | 100% | นิ่ง |
| frontend-dev | - | 94% | 100% | 91% | นิ่ง |
| ux-tester | - | 100% | 100% | 100% | นิ่ง |

## รอบ r3

ชุดตรวจ r3-final: ผ่าน, เทสต์ 159/160, coverage 89.21%

เทสต์ของระบบจับบั๊กฝังได้ 100%

### security-auditor — 100% (+0 จากรอบ r2)
- ✓ precision (findings that are real): 100% (เป้า 70%) — 6/6
- ✓ recall on planted bugs: 100% (เป้า 80%) — 6/6 (easy 2/2, subtle 4/4); missed: -
- ✓ ignores decoys: 100% (เป้า 100%)
- ✓ severity within one level of the truth: 100% (เป้า 80%)
- ✓ every finding has file, line, evidence: 100% (เป้า 100%)
- reviewer 5/5: 6/6 รวม 3 บั๊กในโค้ด log ใหม่ ไม่แตะเหยื่อล่อ 5 จุด ตามรอยข้อมูลที่ผู้โจมตีควบคุมไปถึง CSV/log ได้ และบอกเงื่อนไขที่ลดความรุนแรงทุกข้อ ใช้เวลาเพียง 68 วินาที
- ต้นทุน: 112k tokens, 68 วินาที, 28 tool calls

### verifier — 100% (+0 จากรอบ r2)
- ✓ confirms the planted bugs: 100% (เป้า 90%) — 6/6
- ✓ refutes findings on decoys: 100% (เป้า 100%) — no decoy was reported
- ✓ every finding gets a verdict: 100% (เป้า 100%)
- ✓ repro commands reproduce (run twice): 100% (เป้า 100%) — 6/6
- ✓ repro does not trigger on clean code: 100% (เป้า 100%) — 6/6
- ✓ unplanted findings reproduce on the real code: 100% (เป้า 100%) — none to check
- ✓ CONFIRMED verdicts carry a repro: 100% (เป้า 90%)
- reviewer 5/5: ยืนยัน 6/6 ด้วย helper ร่วม สคริปต์แยกโค้ดเสี่ยง/ปลอดภัยได้ (ทดสอบกับสำเนาที่แก้ใน scratch) ประเมินระดับเองพร้อมเหตุผล ต้นทุนลดจาก 176k/15 นาทีเหลือ 41k/2 นาทีโดยคุณภาพไม่ลด
- ต้นทุน: 41k tokens, 122 วินาที, 15 tool calls

### backend-dev — 100% (+3 จากรอบ r2)
- ✓ [log] green the first time it said "done": 100% (เป้า 100%)
- ✓ [log] green at the end (no regression): 100% (เป้า 100%)
- ✓ [log] added at least one test: 100% (เป้า 100%) — 13 added
- ✓ [log] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [log] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [log] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ [log] test files with new tests fail on the code before the change: 100% (เป้า 100%) — 1/1
- ✓ [perf] green the first time it said "done": 100% (เป้า 100%)
- ✓ [perf] green at the end (no regression): 100% (เป้า 100%)
- ✓ [perf] added at least one test: 100% (เป้า 100%) — 5 added
- ✓ [perf] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [perf] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [perf] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ [perf] test files with new tests fail on the code before the change: 100% (เป้า 100%) — 1/1
- reviewer 5/5: log: ตัดความลับครบรวม upload id ที่ไม่ได้อยู่ในสเปก นับ console call ตามจริง (23 ไม่ใช่ 22) และอธิบายทุกการตัดสินใจ; perf: ใช้ hard link ทำเทสต์ 50k ไฟล์ให้เร็ว รายงานว่าหน้าภาพรวมจะพังกับ storage:null นอกขอบเขตตัวเอง และบอกสิ่งที่ยังไม่ได้ทำ (cpSync, search)
- ต้นทุน: 305k tokens, 1616 วินาที, 153 tool calls

### frontend-dev — 91% (-9 จากรอบ r2)
- ✓ green the first time it said "done": 100% (เป้า 100%)
- ✓ green at the end (no regression): 100% (เป้า 100%)
- ✗ ux-tester flows pass on its page: 80% (เป้า 100%)
- ✓ no removed tests, no skips: 100% (เป้า 100%)
- ✓ stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- ✓ [mobile] green the first time it said "done": 100% (เป้า 100%) — excused: tests/update.test.ts used pgrep -f on the worktree path and killed the agent's own running app (orchestrator's test bug, fixed in the same round)
- ✓ [mobile] green at the end (no regression): 100% (เป้า 100%)
- ✗ [mobile] ux-tester flows pass on its page: 80% (เป้า 100%)
- ✓ [mobile] no removed tests, no skips: 100% (เป้า 100%)
- ✓ [mobile] stayed inside its allowed paths: 100% (เป้า 100%)
- ✓ [mobile] needed at most one fix round: 100% (เป้า 100%) — 2 qa run(s)
- reviewer 4/5: หน้า log ดี (การ์ดบนมือถือ) และงานแก้มือถือพบบั๊ก row-key เดิม + เทสต์ของผมที่ฆ่าแอปผิดตัว; แต่งานแรกแก้หน้าประวัติการใช้งานแล้วไม่ได้ตรวจตารางที่ 375px และงานแก้ทำการ์ดถังขยะที่ตัดชื่อยาว ux-tester ต้องจับให้ 2 ครั้ง
- ต้นทุน: 244k tokens, 1705 วินาที, 218 tool calls

### ux-tester — 100% (+0 จากรอบ r2)
- ✓ every flow has a screenshot: 100% (เป้า 100%)
- ✓ every failure explains its cause: 100% (เป้า 100%) — 2 failing flow(s)
- ✓ flows without unexplained console errors: 100% (เป้า 100%)
- reviewer 5/5: ชี้สาเหตุถึงระดับบรรทัด (:scroll-x, .truncate) ตัดสินจากสิ่งที่ผู้ใช้เห็นจริง ค้นความลับในทุกไฟล์ log และโฟลเดอร์ข้อมูล บอกตรง ๆ ว่าการลากไฟล์ด้วยสคริปต์ทดสอบไม่ได้ และแยก 4xx ที่ตั้งใจออกตามกฎใหม่
- ต้นทุน: 208k tokens, 911 วินาที, 100 tool calls
