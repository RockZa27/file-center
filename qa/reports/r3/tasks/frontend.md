- หน้า `/admin/logs` "บันทึกระบบ": ตารางระดับ/เวลา/เหตุการณ์/รายละเอียด, กรองระดับ + ค้นหา, ปุ่มดาวน์โหลด log ทั้งหมด (.zip), เมนูต่อจาก "ประวัติการใช้งาน"
- หน้า "ประวัติการใช้งาน": ปุ่ม "ส่งออก CSV" ตามตัวกรองปัจจุบัน
- หน้าภาพรวม: การ์ด/คำเตือน error 24 ชม. ลิงก์ไปหน้า log; สถิติไฟล์แสดง "กำลังนับ…" เมื่อ `stale`
- backlog รอบ 2: คำเตือนชื่อ `guest` ก่อนบันทึก (UserFormModal), ข้อความปฏิเสธแพ็กเกจแสดงเป็น alert ค้างในหน้าอัปเดตแทน toast 6 วิ, จัดวางคำแนะนำโลโก้ในหน้าตั้งค่า
- (ข้อความ error ของเซิร์ฟเวอร์เป็นไทยอย่างเดียว: ต้องเปลี่ยนเป็นรหัส error ทั้งระบบ — ใหญ่เกินรอบนี้ บันทึกไว้เป็นงานรอบถัดไป)

- The dashboard must also cope with `storage: null` (first count after install still running): `web/src/views/DashboardView.vue` reads `s.storage.files` directly today and would break. Show "กำลังนับ…" on those cards, and the time of the last count (`storage.countedAt`) when known.
- APIs to use (read `src/routes/logs.ts`, `src/routes/admin.ts`): `GET /api/admin/logs?level&q&page&pageSize` → `{ items: [{ ts, level, event, detail }], hasMore }`, `GET /api/admin/logs/download` (zip), `GET /api/admin/activity/export?format=csv&user&action&q`, `GET /api/admin/status` (warning code `errors`, `stale`, `storage` may be null).
