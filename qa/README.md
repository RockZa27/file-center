# QA: ระบบตรวจผลและ KPI ของ subagent

ตัวเลขทุกตัวมาจากสคริปต์ ไม่ใช่จากที่ agent บอก agent มีหน้าที่ทำงานและรายงานเป็น JSON ส่วน `scripts/qa/` เป็นคนตัดสิน

| ไฟล์ | หน้าที่ |
|---|---|
| `scripts/qa/run-checks.ts` (`bun run qa`) | build, typecheck, เทสต์ + coverage, re-run เทสต์ที่ล้มเพื่อแยก flaky, route ทุกเส้นมีเทสต์สิทธิ์, guard (ห้ามลบเทสต์ / `.skip` / แก้นอกขอบเขต), งบ (`qa/thresholds.json`) → `qa/results/<runId>.json` |
| `scripts/qa/seed.ts` | `check` = เทสต์จับบั๊กฝังได้กี่ตัว (mutation score) · `prepare` = ทำสำเนาที่ฝังบั๊ก + เหยื่อล่อให้ auditor |
| `qa/seeded/bugs.json`, `decoys.json` | บั๊กฝัง (easy / subtle) และโค้ดที่ดูน่าสงสัยแต่ปลอดภัย (วัด false positive) |
| `scripts/qa/prompt.ts` | สร้าง prompt จาก `.claude/agents/<agent>.md` ตามตัวอักษร พร้อม hash ของนิยาม |
| `scripts/qa/score.ts` (`bun run qa:score <round>`) | KPI = 70% หลักฐาน + 30% reviewer → `qa/kpi.json`, `qa/KPI.md` |
| `qa/rubrics/README.md` | เกณฑ์ของ reviewer (เขียนก่อนเริ่มรอบ) |
| `qa/agents-CHANGELOG.md` | บันทึกการปรับ agent: ปัญหาที่ KPI เห็น → การเปลี่ยน 1 อย่าง → ผลรอบถัดไป |

## ขั้นตอนของหนึ่งรอบ (`<round>` เช่น r1)
1. `bun run qa --run-id <round>-base` บน branch ฐาน และ `bun run qa:seed --run-id <round>` (เทสต์ต้องจับบั๊กฝังได้ 100% ก่อนเริ่ม)
2. `bun scripts/qa/seed.ts prepare /tmp/fc-audit-<round> <bug ids> --decoys all --blind --clean /tmp/fc-clean-<round> --record qa/reports/<round>/seeded.json`
3. ส่งงาน: prompt ของแต่ละ agent มาจาก `bun scripts/qa/prompt.ts <agent> key=value ...` เท่านั้น
   - qa-runner → security-auditor (สำเนาฝังบั๊ก) → verifier (ไฟล์ผล auditor)
   - backend-dev (branch ของรอบ) → frontend-dev (ต่อจาก branch backend) → ux-tester
4. บันทึกผลแต่ละ agent เป็น `qa/reports/<round>/<agent>.json`, ต้นทุนเป็น `usage.json`, `round.json` = `{ "checkRunId", "seededRunId" }`
5. ให้คะแนน reviewer ตาม rubric ใน `review.json` แล้ว `bun run qa:score <round> --rerun-repro --check-dev-tests`
6. agent ที่ต่ำกว่าเป้า: เปลี่ยนนิยาม 1 อย่าง บันทึกใน `qa/agents-CHANGELOG.md` แล้ววัดใหม่รอบถัดไป
7. merge branch ของ dev เมื่อ `bun run qa` เขียว และผู้ตรวจ (ผม) อ่าน diff แล้ว

## ข้อจำกัดที่รู้อยู่
- นิยามใน `.claude/agents/` เรียกตามชื่อได้ใน session ใหม่เท่านั้น ใน session เดิมใช้ `prompt.ts` ส่งให้ subagent ทั่วไป (เนื้อหาเดียวกัน)
- บั๊กฝังวัดได้เฉพาะสิ่งที่เรารู้ล่วงหน้า finding ใหม่ที่ไม่ได้ฝังขึ้นกับ verifier + การรัน repro ซ้ำ
- คะแนน reviewer 30% เป็นดุลยพินิจของผู้ตรวจ จึงต้องเขียนเหตุผลอ้างหลักฐานทุกครั้ง

## ตรวจความปลอดภัยเต็มรูปแบบ (security-audit skill)
skill จาก Cloudflare อยู่ที่ `.claude/skills/security-audit/` (ปักเวอร์ชันไว้ใน `UPSTREAM.md`) เรียกด้วย "security audit this codebase"
- ผลลัพธ์อยู่นอก repo: `~/security-audit-skill/file-center/run-<N>` และคัดลอกแค่ `REPORT.md` มาไว้ที่ `qa/reports/sec-<version>/`
- hunter ใช้นิยามของ `security-auditor` ส่วน verifier ใช้ `verifier` ทำงานพร้อมกันได้ไม่เกิน 2 ตัว และ verifier ต้องไม่ใช่ตัวที่เจอ finding นั้น
- โค้ดของแอปต้องรันผ่าน `scripts/qa/sandbox.sh <scratch> <cmd...>` เท่านั้น (ตั้ง `SBX_CWD` เป็นโฟลเดอร์ที่จะรัน)
  - ไม่มีเครือข่ายภายนอก ใช้ได้แค่ loopback
  - env ว่าง มีเฉพาะค่าที่อนุญาต
  - ไฟล์ทั้งเครื่องอ่านอย่างเดียว ยกเว้น scratch
  - จำกัด CPU/หน่วยความจำ/process/ขนาดไฟล์/เวลา
- ตรวจไฟล์ผลด้วย `node .claude/skills/security-audit/validate-findings.cjs <dir>/findings.json` และ `validate-coverage-ledger.cjs <dir>/coverage-ledger.json`
