The dashboard counts every file synchronously, so with a big storage every request waits several seconds each time an admin opens it. Make the expensive counting asynchronous and cached.

- `storageStats` ใน `src/routes/admin.ts` ใช้ `treeStats` แบบ sync ถึง 1M รายการ → บล็อกทุกคำขอ เปลี่ยนเป็นนับแบบ async ทีละชุด (yield ทุก ~2,000 entries), ผลเก็บแคช (ในหน่วยความจำ + `data/system/stats-cache.json`), คืนค่าแคชเดิมทันทีพร้อม `stale: true` ระหว่างนับใหม่, นับพร้อมกันได้ครั้งเดียว
- `trash.ts` `treeStats(abs, 200_000)` ตอนลบโฟลเดอร์ใหญ่ และ `transfer` copy ที่เรียก `treeStats(from)` — ใช้ตัว async เดียวกัน
- เทสต์: สร้างไฟล์ ~50,000 ไฟล์ แล้วยิง `/api/admin/status` พร้อมวัด latency ของ `/api/list` คู่ขนาน ต้องไม่เกิน ~100 ms ระหว่างนับ; ขยาย `scripts/loadtest.ts` (อยู่แล้ว) ให้มีโหมดนี้
- ไม่แก้ `src/logger.ts`/routes ของงาน A (กันชนกัน)


- Docs: README note if behaviour visible to admins changes.
