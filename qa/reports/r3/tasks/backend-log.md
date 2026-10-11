System log, so an admin sees errors without logging into the server (today they only go to stdout and are lost when the container is recreated).

- `src/logger.ts`: `log.info/warn/error(event, detail)` เขียน JSON ทีละบรรทัดที่ `logs/system.log` + ยังพิมพ์ stdout; หมุนไฟล์ด้วยรูปแบบเดียวกับ `rotateIfNeeded` ใน `src/audit.ts` (แยกเป็นฟังก์ชันใช้ร่วม) ค่า `LOG_MAX_BYTES` / `LOG_MAX_FILES` (ค่าเริ่ม 10 MB × 5)
- แทน `console.error/warn` ทั้ง 22 จุดใน `src/` ด้วย logger; เพิ่ม `process.on('uncaughtException'|'unhandledRejection')` ใน `src/index.ts`; `src/launcher.ts` เขียนเหตุการณ์ (เริ่ม, รีสตาร์ต, ย้อนเวอร์ชัน) ลงไฟล์เดียวกัน (append, ไม่หมุนพร้อมกัน — launcher เขียนเฉพาะตอนแอปไม่ได้เขียน หรือใช้ไฟล์ `launcher.log` แยก)
- **ห้ามมีความลับใน log**: ไม่บันทึกรหัสผ่าน, cookie, CSRF token, token ใน path (`/api/batch/:token`), ส่วน query ของ URL; มีเทสต์ยืนยัน
- API (admin): `GET /api/admin/logs?level&q&page` (ใหม่สุดก่อน, อ่านข้ามไฟล์ที่หมุนแล้วแบบ `queryAudit`), `GET /api/admin/logs/download` (zip ของ system + audit + launcher logs ผ่าน `zipStream`), `GET /api/admin/activity/export?format=csv` (ตามตัวกรองเดียวกับหน้า activity, ป้องกัน CSV injection: ขึ้นต้นด้วย `= + - @` ให้ใส่ `'` นำหน้า)
- `GET /api/admin/status`: เพิ่มคำเตือน "มี error N รายการใน 24 ชั่วโมง"
- ทางเลือก `ACCESS_LOG=true` (ปิดเป็นค่าเริ่ม): บรรทัดละคำขอ method, path ที่ตัด token/query แล้ว, status, ms, ip, user ลง `logs/access.log` หมุนไฟล์เหมือนกัน
- backup: เพิ่ม `logs/system.log` ในไฟล์สำรอง (`src/backup.ts` collectItems)


- Tests: logger writes and rotates; a forced error (e.g. a broken backup restore, an unhandled rejection) shows up in `/api/admin/logs`; after the whole test suite no log file contains a test password, a CSRF token or a batch token; CSV export escapes formulas; every new route in both route lists of `tests/api.test.ts`. Docs: README (Thai) + `.env.example`.
