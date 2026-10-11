# KPI ของ subagent

คะแนนรวม = 70% หลักฐาน (คำนวณใหม่จากผล run-checks, บั๊กฝัง, เหยื่อล่อ, การรัน repro ซ้ำ) + 30% reviewer (rubric ใน qa/rubrics/)
นิ่ง = ≥ 80% ติดกัน 3 รอบ · \* = ยังไม่มีคะแนน reviewer

| agent | r0 | สถานะ |
|---|---|---|
| qa-runner | 100% | ปรับต่อ |
| security-auditor | 94% | ปรับต่อ |
| verifier | 94% | ปรับต่อ |

## รอบ r0

ชุดตรวจ r0: ผ่าน, เทสต์ 99/100, coverage 82.38%

เทสต์ของระบบจับบั๊กฝังได้ 90% (พลาด: update-sha-skip)

### qa-runner — 100%
- ✓ numbers match run-checks: 100% (เป้า 100%)
- ✓ flaky tests reported correctly: 100% (เป้า 100%)
- reviewer 5/5: ตัวเลขตรงไฟล์ผลทุกช่อง ส่ง JSON อย่างเดียว ไม่มีอะไรล้มให้ทดสอบเกณฑ์รายงานขั้นที่ล้ม

### security-auditor — 94%
- ✓ precision (findings that are real): 100% (เป้า 70%) — 5/5
- ✓ recall on planted bugs: 100% (เป้า 80%) — 5/5 (easy 5/5, subtle 0/0); missed: -
- ✓ ignores decoys: 100% (เป้า 100%)
- ✓ severity within one level of the truth: 100% (เป้า 80%)
- ✓ every finding has file, line, evidence: 100% (เป้า 100%)
- reviewer 4/5: ชี้บรรทัดถูกครบ 5 ตัว มีเส้นทางโจมตี ไม่มีรายการเกิน แต่ F3 อ้างว่าสร้าง symlink ได้ด้วยการ unzip ซึ่งไม่จริง (unzipTo เขียนไฟล์ปกติเท่านั้น) และ F2 ให้ระดับ high ทั้งที่หลักฐานของตัวเองบอกว่าคุกกี้ SameSite=lax ลดความเสี่ยง

### verifier — 94%
- ✓ confirms the planted bugs: 100% (เป้า 90%) — 5/5
- ✓ refutes findings on decoys: 100% (เป้า 100%) — no decoy was reported
- ✓ every finding gets a verdict: 100% (เป้า 100%)
- ✓ repro commands reproduce (run twice): 100% (เป้า 100%) — 5/5
- ✓ repro does not trigger on clean code: 100% (เป้า 100%) — not measured (needs --rerun-repro and a clean copy)
- ✓ CONFIRMED verdicts carry a repro: 100% (เป้า 90%)
- reviewer 4/5: repro แยกสถานะเสี่ยง/ปลอดภัยได้จริง (รันกับสำเนาที่แก้แล้ว) และให้ระดับตามที่เห็นจริง แต่สร้างสำเนาชั่วคราวนอก qa/repro/ ซึ่งผิดข้อห้ามเขียนนอกขอบเขต (ลบทิ้งแล้ว)
