# Agent tuning log
One entry per change to an agent's definition (`.claude/agents/*.md`): what the KPI showed, the single change made, score before → after next round.
Change one thing per agent per round, so the effect is visible.

<!-- newest first -->

## r0 (baseline) → r1
- ผลรอบ 0: qa-runner 100%→(รวม reviewer) 100%, security-auditor 94%, verifier 94% (ดู qa/KPI.md)
- **ข้อสรุปที่สำคัญกว่าคะแนน: โจทย์รอบ 0 ง่ายเกินไป** บั๊กฝังทุกตัวเป็น `if (false)` ที่เห็นทันที ทุก KPI เต็มจึงยังไม่รู้ว่า agent เก่งจริงแค่ไหน ใช้เพื่อยืนยันว่าท่อทำงานครบ (auditor → verifier → scorer) เท่านั้น
- ข้อบกพร่องจริงที่ reviewer เห็น: auditor อ้างช่องทางโจมตีที่ไม่มีในโค้ด (unzip สร้าง symlink) ; verifier สร้างไฟล์นอก qa/repro/
- **การเปลี่ยนที่ทำ (1 อย่างต่อ agent):**
  - security-auditor: เพิ่มกฎ "ช่องทางโจมตีที่อ้างต้องตรวจในโค้ดก่อนว่ามีจริง (ใคร/route ไหนทำได้) ถ้าตรวจไม่ได้ให้เขียนเงื่อนไขนั้นเป็นข้อสมมติและลดระดับ"
  - verifier: เพิ่มกฎ "ทดลองกับสำเนาที่แก้ ให้ทำใต้ qa/repro/scratch/ เท่านั้น"
- **การเปลี่ยนเกณฑ์วัดสำหรับ r1:** (1) auditor ตรวจต้นไม้จริงที่ไม่ฝังบั๊ก เพื่อวัด false positive จริง และให้ verifier ตัดสิน (2) บั๊กฝังรอบหน้าต้องแนบเนียนกว่า (เงื่อนไขกลับด้าน, ลืมเช็กใน 1 route จาก 20) (3) ครอบคลุมบั๊กที่เทสต์ตอนนี้ยังจับไม่ได้: update-sha-skip

