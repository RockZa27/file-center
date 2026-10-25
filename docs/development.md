# คู่มือนักพัฒนา

[← กลับหน้าแรก](../README.md) · [ติดตั้ง](install.md) · [ตั้งค่าระบบ](configuration.md) · [ความปลอดภัย](security.md)

สำหรับคนที่แก้โค้ด File Center: backend เป็น **ElysiaJS + Bun** (`src/`) frontend เป็น **Vue 3 + Naive UI** (`web/src`) ถ้าต้องการแค่ติดตั้งหรือใช้งาน ดู [ติดตั้ง](install.md) และ [คู่มือผู้ดูแล](admin-guide.md)

## สารบัญ

- [เริ่มพัฒนา](#เริ่มพัฒนา)
- [โครงสร้างโค้ด](#โครงสร้างโค้ด)
- [ตรวจคุณภาพ (QA)](#ตรวจคุณภาพ-qa)
- [ตรวจคุณภาพอัตโนมัติ (CI)](#ตรวจคุณภาพอัตโนมัติ-ci)
- [วัดความเร็ว (benchmark)](#วัดความเร็ว-benchmark)
- [ออกรุ่นที่เซ็นแล้ว](#ออกรุ่นที่เซ็นแล้ว)
- [ต่างจาก FileGator ต้นแบบอย่างไร](#ต่างจาก-filegator-ต้นแบบอย่างไร)
- [อ้างอิง API](#อ้างอิง-api)

## เริ่มพัฒนา

ต้องมี [Bun](https://bun.sh) (CI และอิมเมจใช้ 1.4.2)

```bash
bun install
bun run dev        # API ที่ :3000 (bun --watch) + หน้าเว็บ (Vite, hot reload) ที่ :5173
```

เปิด `http://localhost:5173` Vite ส่งต่อคำขอ `/api` ไปที่ `http://localhost:3000` (เปลี่ยนด้วย `API_URL`) ครั้งแรกระบบสร้างบัญชี `admin` และแสดงรหัสผ่านที่สุ่มไว้ในหน้าจอ หรือกำหนดด้วย `ADMIN_PASSWORD`

| สคริปต์ | ทำอะไร |
|---|---|
| `bun run dev` | API + หน้าเว็บพร้อมกัน (`concurrently`) |
| `bun run dev:api` / `bun run dev:web` | แยกทีละส่วน |
| `bun run build` | คอมไพล์หน้าเว็บไปที่ `web/dist` (ไม่มี Node ให้ใช้ `bun --bun run build`) |
| `bun start` | รันผ่าน launcher (`src/launcher.ts`) เหมือนตอนใช้งานจริง |
| `bun test` | เทสต์ทั้งหมด (`SLOW_TESTS=1 bun test` เพิ่มเทสต์ zip ขนาด 4.4 GB) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run qa` | ตรวจรวม ดู [ตรวจคุณภาพ (QA)](#ตรวจคุณภาพ-qa) |
| `bun run qa:seed` | ใส่บั๊กที่รู้ตัวแล้วดูว่าเทสต์จับได้ |
| `bun run qa:score` | ให้คะแนน subagent ของรอบ (ดู `qa/README.md`) |
| `bun run bench` | วัดความเร็ว ดู [วัดความเร็ว](#วัดความเร็ว-benchmark) |
| `bun run package` | สร้างแพ็กเกจอัปเดต ดู [ติดตั้ง](install.md#สร้างและเผยแพร่อัปเดตของคุณเอง) |
| `bun run release` | เผยแพร่แพ็กเกจลง branch `updates` ดู [ออกรุ่นที่เซ็นแล้ว](#ออกรุ่นที่เซ็นแล้ว) |

เทสต์รันบน runner ธรรมดา (ไม่ใช่ root ไม่มี Chromium) เทสต์ API ส่วนใหญ่รันแอปในโปรเซสเดียวกัน (`tests/in-process-env.ts`) ใช้โฟลเดอร์ชั่วคราวที่ลบเมื่อจบ (`tests/preload.ts` ตั้งใน `bunfig.toml`)

## โครงสร้างโค้ด

```
src/
  index.ts          ประกอบแอป, เสิร์ฟหน้าเว็บ, งานเบื้องหลังรายชั่วโมง
  launcher.ts       ตัวรันแอป: รีสตาร์ตหลังอัปเดต และย้อนกลับเวอร์ชันเองถ้าเวอร์ชันใหม่เปิดไม่ขึ้น
  lifecycle.ts      รีสตาร์ตตัวเองผ่าน launcher (EXIT_RESTART)
  config.ts         ค่าตั้งต้นจากตัวแปรสภาพแวดล้อม และตำแหน่งโฟลเดอร์/ไฟล์ข้อมูล (paths)
  updater.ts, release.ts, routes/update.ts   ตรวจ/ติดตั้ง/ย้อนกลับแพ็กเกจอัปเดตจากหน้าเว็บ
  update-source.ts  ตรวจหาและดาวน์โหลดแพ็กเกจจาก UPDATE_SOURCE (latest.json)
  update-key.ts     กุญแจสาธารณะของ File Center ที่ฝังมา (ตรวจลายเซ็นแพ็กเกจ)
  alerts.ts, routes/alerts.ts               แจ้งเตือนผู้ดูแลทาง Discord/Slack/Telegram/webhook และงานตรวจเบื้องหลัง (error, ดิสก์, เวอร์ชันใหม่)
  notify.ts, notify-checks.ts, routes/notify.ts   การแจ้งเตือนส่วนตัว: กระดิ่ง (notifications.json), ตั้งค่าต่อผู้ใช้, ลิงก์ใกล้หมดอายุ/โควตา
  mail.ts, line.ts, deliver.ts              ส่งอีเมล (SMTP ในตัว), ส่ง/รับ LINE Messaging API และคิวส่งเบื้องหลังที่ลองใหม่ได้
  backup.ts, routes/backup.ts               สำรองข้อมูลระบบอัตโนมัติ และกู้คืน
  search-index.ts   ดัชนีค้นหา (SQLite) และตัวกรองของ /api/search
  auth.ts           ผู้ใช้, session, ล็อกการเข้าสู่ระบบ, การแปลงสิทธิ์เป็นพื้นที่ที่เข้าถึงได้, ขั้นตอนที่สองของการเข้าสู่ระบบ (2FA)
  totp.ts, secret-box.ts, cli.ts            รหัส TOTP, เข้ารหัสความลับด้วย secret.key, คำสั่งสำหรับผู้ดูแลที่เครื่อง server
  context.ts        ตรวจ session/CSRF, รูปแบบ error เดียวกันทุก API
  messages.ts       ข้อความทุกข้อที่แสดงต่อผู้ใช้ ตามรหัส (code) เป็นภาษาไทยและอังกฤษ
  fsx.ts            จัดการพาธอย่างปลอดภัย (กัน ../ และ symlink), คัดลอก/ย้าย
  zip.ts            สร้างและแตก zip ด้วย zip.js (ZIP64 ไฟล์เกิน 4 GB, ตรวจ CRC, กัน zip-slip / zip bomb)
  archive.ts        ดูรายการและดึงรายการเดียวออกจาก zip โดยไม่แตกไฟล์ (สารบัญท้ายไฟล์, กัน zip bomb) routes/archive.ts
  thumbs.ts         ภาพตัวอย่างด้วยเครื่องมือของระบบ (vips, pdftoppm, ffmpeg): คิว 2 งาน, timeout, แคชใน DATA_DIR/thumbs routes/thumbs.ts
  uploads.ts        อัปโหลดแบบแบ่งชิ้น กลับมาต่อได้
  logger.ts         log ของระบบ (logs/system.log), หมุนไฟล์ log, ตัดความลับออกก่อนเขียน
  stats.ts          นับจำนวนและขนาดไฟล์ให้หน้าภาพรวม (เบื้องหลัง เก็บผลไว้ใน stats-cache.json)
  shares.ts, routes/shares.ts               ลิงก์แชร์ให้คนที่ไม่มีบัญชีดาวน์โหลด และลิงก์รับไฟล์
  grants.ts, routes/grants.ts               แชร์โฟลเดอร์ให้ผู้ใช้/กลุ่ม (space grant:<id>)
  groups.ts, routes/groups.ts               กลุ่มและโฟลเดอร์กลุ่ม (space group:<id>)
  webdav.ts, webdav-xml.ts, app-passwords.ts, routes/app-passwords.ts   WebDAV ที่ /dav (PROPFIND, PUT แบบสตรีม, MOVE/COPY, LOCK ที่ไม่บังคับ) รหัสผ่านแอปที่ใช้เข้า และตัวอ่าน XML เล็ก ๆ
  quota.ts          โควตาพื้นที่ต่อผู้ใช้: นับ เก็บผล 60 วินาที จองพื้นที่ของงานที่กำลังเขียน
  versions.ts, routes/versions.ts           เวอร์ชันเก่าของไฟล์ (เก็บทุกครั้งที่บันทึกทับ)
  favorites.ts, guide.ts, routes/guide.ts   รายการโปรด/ล่าสุด และสถานะทัวร์/"มีอะไรใหม่" ต่อผู้ใช้
  office.ts, routes/office.ts               แก้ไขเอกสาร office ผ่าน ONLYOFFICE Docs: config ที่เซ็นแล้ว, โทเคนของลิงก์, JWT, รับไฟล์ที่บันทึก
  compress.ts, static.ts                    บีบ JSON ของ API (br/gzip) และเสิร์ฟไฟล์หน้าเว็บพร้อม ETag
  trash.ts, audit.ts, settings.ts, store.ts, common-passwords.ts
  routes/           session, files, upload, admin, me, update, backup, logs, shares, grants, groups, trash, versions, office, alerts, notify, archive, thumbs, guide, app-passwords
scripts/
  package.ts        สร้างแพ็กเกจอัปเดต (bun run package)
  release.ts        เผยแพร่แพ็กเกจลง branch updates (bun run release)
  bench.ts          วัดความเร็ว (bun run bench)
  loadtest.ts       ทดสอบโหลดกับเครื่องทดสอบ (ทีละขั้น)
  ci-docker.sh      ทดสอบอิมเมจ Docker จริงแบบครบวงจร (ใช้ใน CI)
  docker-entrypoint.sh   entrypoint ของอิมเมจ (chown ครั้งเดียวแล้วลดเป็น bun)
  set-tunnel-token.sh    ใส่ TUNNEL_TOKEN ลง .env แบบไม่โชว์โทเคน
  qa/               ระบบตรวจคุณภาพ (run-checks, seed, score, prompt)
web/                Vue 3 + Naive UI (build ไปที่ web/dist) — web/src: views/ components/ guide/ (ทัวร์และ "มีอะไรใหม่") viewers/ (ตัวดูเอกสาร) i18n.js (ข้อความไทย/อังกฤษ)
tests/              เทสต์ (ดูตารางด้านล่าง)
qa/                 เกณฑ์ ผลการรัน และรายงาน (qa/README.md)
dist-update/        แพ็กเกจที่ bun run package สร้าง
```

**เทสต์** (`bun test` รันทั้งหมด รวมเทสต์ของโค้ดหน้าเว็บ `web/src/**/*.test.js`)

| ไฟล์ใน `tests/` | ครอบคลุม |
|---|---|
| `api.test.ts` | API หลัก (ไฟล์ session อัปโหลด zip ฯลฯ) ใช้เป็นแอปกลางที่ไฟล์เทสต์อื่นใช้ร่วม |
| `roles.test.ts`, `roles-fixes.test.ts` | บทบาท manager/admin, สิทธิ์, การยึดโฟลเดอร์ตามชื่อ, หน้าภาพรวมฉบับย่อ |
| `account.test.ts` | อุปกรณ์ที่เข้าสู่ระบบ 2FA (TOTP, รหัสสำรอง, ความลับที่เข้ารหัส) และ CLI |
| `shares.test.ts`, `upload-links.test.ts` | ลิงก์แชร์: สิทธิ์ รหัสผ่าน หมดอายุ จำนวนครั้ง ไม่ออกนอกโฟลเดอร์ที่แชร์ · ลิงก์รับไฟล์: เงื่อนไขการสร้าง ไม่เห็นของในโฟลเดอร์ ไม่เขียนทับ ข้อจำกัด ผูกกับผู้เยี่ยมชม |
| `grants.test.ts`, `groups.test.ts` | แชร์ให้ผู้ใช้/กลุ่ม, กลุ่ม, โควตากลุ่ม, ถังขยะกลุ่ม |
| `own-trash.test.ts`, `security-110.test.ts` | ถังขยะของผู้ใช้เอง · ข้อค้นพบความปลอดภัยของ 1.10.0 |
| `quota.test.ts` | โควตา: ทุกทางที่ไบต์ลงโฟลเดอร์ การจองและคืนที่จอง อัปโหลดพร้อมกัน และ `/api/me/usage` |
| `webdav.test.ts` (+ `dav-server.ts`) | WebDAV และรหัสผ่านแอป: การเข้าสู่ระบบ ล็อก PROPFIND PUT แบบสตรีม โควตา ถังขยะ MOVE/COPY ขอบเขต read พาธอันตราย โฟลเดอร์ที่แชร์ และขีดจำกัดขนาดคำขอของ API |
| `versions.test.ts`, `web-versions.test.ts` | เวอร์ชันของไฟล์ รายการโปรด/ล่าสุด คัดลอก/ย้ายข้าม space · ตัวเปรียบเทียบเวอร์ชันของหน้าเว็บ |
| `guide.test.ts` | สถานะทัวร์และ "มีอะไรใหม่" |
| `search-index.test.ts`, `search-fts.test.ts` | ดัชนีค้นหาและตัวกรอง · ดัชนี trigram ต้องให้ผลเหมือน query เดิม |
| `archive.test.ts`, `zip-bytes.test.ts`, `thumbs.test.ts` | ดูรายการใน zip · ความถูกต้องของ zip ที่ deflate ระดับ 1 · ภาพตัวอย่าง (ข้ามเมื่อไม่มีเครื่องมือในเครื่อง) |
| `logs.test.ts`, `messages.test.ts` | log ของระบบ การหมุนไฟล์ การส่งออก และว่าไม่มีความลับหลุดลง log · ทุกรหัสที่ใช้ใน `src/` มีในรายการข้อความ ทั้งสองภาษามีตัวแปรตรงกัน error ตอบตามภาษาของคำขอ และลิงก์ดาวน์โหลดที่ล้มเหลวได้หน้า HTML |
| `update.test.ts`, `backup.test.ts` | อัปเดตและกู้คืนข้อมูลกับ launcher จริง |
| `update-signing.test.ts`, `update-beta.test.ts`, `update-source.test.ts` | ลายเซ็นแพ็กเกจ · ช่องทางเบตา · ตรวจหา/ดาวน์โหลดอัปเดตจาก server ทดสอบในเครื่อง |
| `release.test.ts`, `release-beta.test.ts` | `bun run release` กับ repo ชั่วคราว (ไม่แตะ repo จริง) |
| `backup-settings.test.ts`, `durability.test.ts` | ตั้งค่าสำรอง (บีบอัด ตารางเวลา) และ disk-full guard · หยุดระบบ/เขียนไฟล์ข้อมูลล้มเหลว/ถังขยะค้าง/ชื่อและลำดับไฟล์สำรอง/launcher ช้า/กู้คืน 2FA ข้ามเครื่อง |
| `office.test.ts` | ONLYOFFICE กับ document server ปลอม: สิทธิ์ โทเคน JWT การบันทึกเป็นเวอร์ชัน CSP และ `expectedMtime` ของไฟล์ข้อความ |
| `alerts.test.ts`, `notify.test.ts` | แจ้งเตือนผู้ดูแลกับ webhook ทดสอบในเครื่อง (รูปแบบ ชั่วโมงละครั้ง ตัดความลับ ตรวจเวอร์ชันใหม่รายวัน) · แจ้งเตือนส่วนตัวกับเซิร์ฟเวอร์ SMTP และ LINE จำลอง (ไม่เห็นของคนอื่น ครั้งเดียวต่อเหตุการณ์ ไม่ส่งอีเมลก่อนยืนยัน กัน header injection ลายเซ็น webhook รหัสเชื่อม LINE ข้อจำกัดอัตรา) |
| `r9-security.test.ts`, `files-fixes.test.ts`, `move.test.ts` | ขีดจำกัดคำขอ ล็อกการเข้าสู่ระบบแบบกว้าง · การแก้ไขของ 1.12.1 (ขีดจำกัดแตก zip, อัปโหลดที่โฟลเดอร์หาย, ย้ายแบบ atomic) · `moveTree` ข้ามดิสก์ |
| `speed.test.ts`, `list-speed.test.ts`, `perf.test.ts` | ไฟล์หน้าเว็บบีบพร้อม validator, collator ตัวเดียว, `updateSoon` · รายการโฟลเดอร์แบบไม่บล็อกและ JSON ที่บีบ · การนับไฟล์ 50,000 ไฟล์ การคัดลอก 20,000 ไฟล์ และการค้นหาต้องไม่ทำให้คำขออื่นช้า (`scripts/loadtest.ts` โหมด `dashboard` ใช้ลองกับ server จริง) |
| `docker-entrypoint.test.ts` | `scripts/docker-entrypoint.sh` โดยไม่ต้องมี Docker และไฟล์ compose/workflow/Dockerfile ตามที่เอกสารสัญญา |

## ตรวจคุณภาพ (QA)

```bash
bun run qa                       # build, typecheck, เทสต์ + coverage, ตรวจ route, งบ
bun run qa:seed                  # ใส่บั๊กที่รู้ตัวลงไป ดูว่าเทสต์จับได้ไหม (mutation score)
```

`bun run qa` (`scripts/qa/run-checks.ts`) เป็นคำสั่งเดียวที่ตัดสินว่า "โค้ดดีไหม" ทำตามลำดับ

1. build หน้าเว็บ (`bun --bun run build`) — เทสต์อัปเดตต้องมี `web/dist`
2. typecheck
3. เทสต์ทั้งหมดพร้อม coverage รันซ้ำเฉพาะที่ล้มหนึ่งครั้งเพื่อแยกเทสต์ที่ไม่นิ่ง (flaky)
4. ทุก route ที่แก้ข้อมูลต้องมีชื่ออยู่ในเทสต์
5. งบใน `qa/thresholds.json`
6. (เมื่อใส่ `--base <git ref>`) ตรวจว่าไม่มีการลบเทสต์ ไม่มี `.skip` ใหม่ และไม่แก้นอกขอบเขตที่อนุญาต (`--allow "src/**,tests/**"`)

ตัวเลือก: `--run-id <id>` `--skip-build` `--base <git ref>` `--allow "<globs>"` `--compare <run id ก่อนหน้า>` ผลเขียนที่ `qa/results/<runId>.json` (โฟลเดอร์นี้อยู่ใน `.gitignore`) และจบด้วยรหัส 1 ถ้ามีอะไรผิด

**งบ (`qa/thresholds.json`)**

| ค่า | ตอนนี้ | ความหมาย |
|---|---|---|
| `minCoverageLines` | 80 | coverage ของบรรทัด (%) ต้องไม่ต่ำกว่านี้ |
| `maxCoverageDrop` | 1 | coverage ลดจากรอบที่เทียบ (`--compare`) ได้ไม่เกินกี่จุด |
| `maxWebBytes` | 5242880 (5 MB) | ขนาดรวมของ `web/dist` |
| `maxTestSeconds` | 420 | เวลารวมของเทสต์ (วินาที) |

**`bun run qa:seed`** = `bun scripts/qa/seed.ts check` ใส่บั๊กที่รู้ตัว (`qa/seeded/bugs.json` แบ่งง่าย/แนบเนียน) ลงในสำเนา แล้วดูว่าชุดเทสต์จับได้กี่ตัว (ผลที่ `qa/results/seeded-<runId>.json`) ใช้ `--ids a,b` ลองเฉพาะบางตัว ส่วน `prepare` ทำสำเนาที่ฝังบั๊กพร้อมเหยื่อล่อ (`qa/seeded/decoys.json`) ให้ auditor และ `clean` ล้างสำเนา ไม่แตะ working tree จริง

**`bun run qa:score <round>`** ให้คะแนน subagent ของรอบจากหลักฐาน (70% หลักฐาน + 30% ผู้ตรวจ) ลง `qa/kpi.json` และ `qa/KPI.md` รายละเอียดขั้นตอนของหนึ่งรอบและเกณฑ์อยู่ใน [`qa/README.md`](../qa/README.md)

## ตรวจคุณภาพอัตโนมัติ (CI)

GitHub Actions (`.github/workflows/qa.yml`) ทำงานทุก push และ pull request (และสั่งเองได้) ไม่ใช้ secret

| งาน | ตรวจอะไร |
|---|---|
| `qa` | `bun run qa`: build หน้าเว็บ, typecheck, เทสต์ทั้งหมดพร้อม coverage (รันซ้ำเฉพาะที่ล้มเพื่อหาเทสต์ที่ไม่นิ่ง), ทุก route ที่แก้ข้อมูลต้องมีในรายการเทสต์, งบใน `qa/thresholds.json` ผลอยู่ใน artifact `qa-results` |
| `seeded` | (เฉพาะ push เข้า `main` และสั่งเอง) `bun run qa:seed check`: ใส่บั๊กที่รู้ตัวลงไปแล้วดูว่าเทสต์จับได้ ผลอยู่ใน artifact `qa-seeded-results` |
| `docker` | `scripts/ci-docker.sh`: build อิมเมจจริง รันบน volume ว่าง ตรวจว่าแอปรันเป็น uid 1000 และไฟล์ใน `/data` เป็นของ 1000, อัปโหลดแบบแบ่งชิ้นแล้วดาวน์โหลดกลับ (ต้องตรงกันทุกไบต์), ภาพตัวอย่างจากเครื่องมือในอิมเมจ (รูป PDF วิดีโอ), แพ็กเกจที่ไม่เซ็นถูกปฏิเสธ แล้วติดตั้งแพ็กเกจอัปเดต 99.0.0 ที่เซ็นด้วยกุญแจชั่วคราวผ่านหน้าอัปเดตแล้วรอรีสตาร์ต, `FC_RUN_AS_ROOT=true` ต้องรันเป็น uid 0, ระบบไฟล์ root อ่านอย่างเดียว (เขียนนอก `/data` ต้องล้ม), `CapEff` ของ PID 1 เป็น 0, ตั้ง `no-new-privileges` แล้ว และ volume เก่าที่เป็นของ root ถูกเปลี่ยนเจ้าของได้ด้วยสิทธิ์ที่เหลือ |
| `bench` | `bun run bench --quick --json bench.json` เก็บ `bench.json` เป็น artifact `bench-results` **ไม่ตัดสินผ่าน/ไม่ผ่านจากตัวเลข** (runner ต่างกัน ไฟล์ไว้ดู) |
| `security` | `bun audit` และ Trivy (โค้ดและอิมเมจ) ล้มเฉพาะ HIGH/CRITICAL ที่มีเวอร์ชันแก้แล้ว ผลอยู่ใน artifact `security-results` รายละเอียดที่ [ความปลอดภัย: ตรวจช่องโหว่ใน CI](security.md#ตรวจช่องโหว่ใน-ci) |

Action ทุกตัวใน workflow ปักด้วย commit SHA มีเวอร์ชันเต็มเขียนกำกับไว้ข้าง ๆ (`@<sha> # vX.Y.Z`) ส่วนอิมเมจใน `Dockerfile` และ `docker-compose.yml` ปักด้วย digest ต่อท้าย tag (`:1.4.4@sha256:...`) มีเทสต์ตรวจทั้งสองแบบ เพราะ tag ย้ายไปชี้เนื้อหาอื่นได้แต่ SHA และ digest ย้ายไม่ได้

**Dependabot** (`.github/dependabot.yml`) เปิด pull request ทุกสัปดาห์สำหรับ npm, GitHub Actions และอิมเมจ Docker โดยอัป SHA, digest และป้ายเวอร์ชันข้างกันไปพร้อมกัน
- npm ระดับ minor/patch รวมเป็น PR เดียว
- major ของ vite, typescript, pinia, vue-router และ concurrently ไม่เปิด PR เพราะต้องแก้โค้ด ให้อัปเองเมื่อพร้อม
- PR ของ Dependabot ไม่ merge เอง ต้องผ่าน CI ทุกงานและมีคนอ่านก่อน โดยเฉพาะ action กับอิมเมจ ให้ดูว่า SHA หรือ digest ใหม่มาจาก release ของเจ้าของจริง

เทสต์ทั้งหมดต้องผ่านบน runner ธรรมดา (ไม่ใช่ root ไม่มี Chromium)

**รันสคริปต์ Docker บนเครื่องตัวเอง** (ต้องมี Docker และ Bun)

```bash
bash scripts/ci-docker.sh
```

สร้างคอนเทนเนอร์ volume และอิมเมจชั่วคราว (ชื่อขึ้นต้น `fc-ci-`) บนพอร์ตสุ่มของ `127.0.0.1` แล้วลบทิ้งเมื่อจบ ไม่ว่าผ่านหรือไม่ ตัวแปรของสคริปต์ (ใช้เฉพาะตอนทดสอบ)

| ตัวแปร | ความหมาย |
|---|---|
| `FC_CI_CA_BUNDLE=/path/ca.crt` | ถ้าเครือข่ายผ่านพร็อกซีที่แทรก CA ของตัวเอง ให้ขั้นตอน build อิมเมจเชื่อ CA นั้น |
| `FC_CI_NO_APT=1` | build โดยไม่ลง/อัปเกรดแพ็กเกจ Debian (เครื่องที่เข้า mirror ไม่ได้) ข้ามการทดสอบภาพตัวอย่างด้วย |
| `FC_CI_PREFIX` | เปลี่ยนส่วนต้นของชื่อที่สคริปต์ใช้ (ค่าเริ่มต้น `fc-ci`) |

## วัดความเร็ว (benchmark)

```bash
bun --bun run build                                  # ต้องมี web/dist ก่อน (แถว static)
bun run bench [--quick] [--json out.json]            # เริ่มแอปเป็น child บนโฟลเดอร์ชั่วคราว สร้างไฟล์ 20,000 ไฟล์ (--quick: 2,000) แล้ววัด
bun run bench --compare qa/bench/baseline.json       # วัดแล้วพิมพ์ผลต่างจาก baseline (ไม่ทำให้ล้มเหลว; "!" = แย่ลง 10% ขึ้นไป)
```

ตัวเลือกอื่นของ `bench`: `--concurrency N` (ค่าเริ่มต้น 8) `--duration SECONDS` (5 วินาทีต่อแถว; `--quick` 1.5) `--files N` และ `--current out.json` (ใช้ผลที่วัดไว้แล้วกับ `--compare`)

ตารางมีต่อแถว: req/s, p50/p95/p99 (ms), errors และ MB/s (ดาวน์โหลด/อัปโหลด) ส่วน `login` ช้าโดยตั้งใจ (argon2) วัดไว้เฉยๆ ตัวสร้างโหลดรันบนเครื่องเดียวกับแอป ตัวเลขจึงเทียบได้เฉพาะระหว่างการรันบนเครื่องเดียวกัน (CI รัน `--quick` แล้วเก็บ `bench.json` เป็น artifact ไม่ตัดสินผ่าน/ไม่ผ่านจากตัวเลข) `qa/bench/baseline.json` คือผล **ก่อน** ปรับปรุงรอบนี้ (Intel Xeon 2.8 GHz 4 คอร์, Bun 1.4.2, โหมดเต็ม, concurrency 8, 5 วินาที/แถว) และ `qa/bench/1.8.0-vs-1.7.2.json` คือผลเทียบรอบ 1.8

สำหรับทดสอบโหลดกับเครื่องทดสอบจริง ใช้ `scripts/loadtest.ts` ทีละขั้น (อ่านวิธีใช้ในหัวไฟล์) **ชี้ไปที่เครื่องทดสอบเท่านั้น ห้ามชี้ข้อมูลจริง** ตัวแปรของสคริปต์: `BASE` (ค่าเริ่มต้น `http://127.0.0.1:3101`), `WORK` (โฟลเดอร์ที่มี `src.bin`), `FC_USER`, `FC_PASS`, `FILES`, `FCDATA`, `CHUNK`

ผลบนเครื่องนี้ ก่อน → หลัง

| แถว | ก่อน | หลัง | สิ่งที่แก้ |
|---|---|---|---|
| list-2000 | 12.7 req/s, p50 587 ms | 46.9 req/s, p50 160 ms | เรียงชื่อด้วย `Intl.Collator` ตัวเดียว (`localeCompare` สร้าง collator ใหม่ทุกครั้งที่เทียบ ใช้เวลาเรียง ~60 ms ต่อ 2,000 ชื่อ) |
| static-asset (bundle 1,121 KB) | ส่ง 1,121 KB | ส่ง 316 KB (br), 2,094 req/s | บีบ br/gzip ครั้งเดียวแล้วเก็บไว้ + `Vary: Accept-Encoding` + ETag/304 (index.html และไฟล์อื่นด้วย) |
| RSS หลังอุ่นเครื่อง | 174 MB | 107 MB | (ความแตกต่างระหว่างรอบ ไม่ได้ตั้งใจแก้) |
| recent files | เขียน user-state.json ทุกการดาวน์โหลด | รวมเป็น 1 ครั้งต่อวินาที | `JsonStore.updateSoon`; ปิดระบบและสำรองข้อมูลเขียนที่ค้างอยู่ก่อนเสมอ |

แถวอื่น (session, download, upload) ต่างกันอยู่ในช่วงความผันผวนของเครื่อง ไม่ได้แก้อะไร (search และ zip แก้ในรอบ 1.8 ด้านล่าง) การดาวน์โหลดใช้ `Bun.file` และรองรับ Range (206/416) อยู่แล้ว

**รอบ 1.8** (รายการโฟลเดอร์ 2,000 รายการ, `bun run bench --quick`, concurrency 8, เครื่องเดียวกัน): list-2000 69.7 → 104.8 req/s, p50 106 → 74 ms

- โปรไฟล์ (`bun --cpu-prof`) ก่อนแก้: `lstatSync` 39%, เรียงชื่อด้วย collator 28%, JSON 8%, `readdirSync` 7% จึงเก็บ **ลำดับชื่อ** ต่อโฟลเดอร์ไว้ (LRU 200 โฟลเดอร์) และใช้ก็ต่อเมื่อตรงกับรายการที่อ่านสดทุกครั้ง (จำนวนเท่ากัน ทุกชื่อรู้จัก ชนิดตรงกัน) ขนาดและเวลาจึงสดเสมอ และไฟล์ที่เพิ่ม/ลบ/เปลี่ยนชื่อโผล่ทันที; `lstat` ทำเป็นก้อนละ 64 แล้วคืนคิวให้คำขออื่น (ลอง `lstat` แบบ async ขนาน 64 แล้ว: 49 req/s ช้ากว่าเดิม 55 เพราะค่า promise/thread pool จึงไม่ใช้)
- คำตอบ JSON ของ `/api/list`, `/folders`, `/search`, `/versions`, `/me/favorites`, `/me/recent` และรายการ admin (users, activity, logs, folders) บีบ br (quality 4, ~1.5 ms) หรือ gzip (level 3, ~1 ms) เมื่อใหญ่ตั้งแต่ 1 KB: 222 KB → 10 KB (br) / 18 KB (gzip) บนสาย แลกกับ CPU ราว 10% บน loopback (~90 req/s); เส้นทางที่มี token/โค้ด (session, login, 2FA, แชร์, อัปโหลด) และไฟล์ดาวน์โหลดไม่บีบ (BREACH) รายการอยู่ใน `src/compress.ts`

**รอบ 1.8** (ค้นหา zip อัปโหลด; เครื่องเดิม โหมดเต็ม 20,000 ไฟล์ concurrency 8)

| แถว | ก่อน | หลัง | สิ่งที่แก้ |
|---|---|---|---|
| search | 64.8 req/s, p50 103.6 ms | 1,055 req/s, p50 6.5 ms | ตาราง FTS5 แบบ trigram สำหรับคำค้น 3 ตัวอักษรขึ้นไป + ตาราง `entries` แบบ rowid (เดิม `WITHOUT ROWID` สแกน `instr` ช้ากว่า ~6 เท่า) + จำ realpath ของราก |
| search 200,000 ไฟล์ (เรียกตรง) | 134 ms | 0.05–5 ms (คำค้น 1–2 ตัวอักษร 23 ms) | เหมือนข้างบน |
| zip (ไฟล์ข้อความ 200 × 40 KB / 6 × 3 MB) | 295 ms / 687 ms | 184 ms / 331 ms | deflate ระดับ 1 แทน 3: ไฟล์ใหญ่กว่า 0.3–1.6% (ระดับอื่นนอกจาก 6 zip.js ใช้ deflate ของตัวเอง ส่วนระดับ 6 ของ CompressionStream ช้ากว่าระดับ 1) |
| upload 100 MB | 117–141 MB/s | ไม่เปลี่ยน | โปรไฟล์ชี้ที่การเขียนไฟล์ใหม่ลงดิสก์ (`dd` ไฟล์ใหม่ขนาดเท่ากัน 136–160 MB/s) ไม่มี fsync/แฮชใน path นี้ และงานอื่นต่อชังก์รวม <0.2 ms จึงไม่แก้ |

`zip-200` ของ bench (ไฟล์ละ 1.6 KB) ไม่เปลี่ยน (11.1 → 11.2 req/s): เวลาไปกับ stream ต่อไฟล์ใน zip.js (~0.3 ms) ไม่ใช่ deflate ลองอ่านไฟล์เล็กเข้าหน่วยความจำ และบีบเองด้วย `Bun.deflateSync` แล้วส่งต่อ (`passThrough`) แล้ว: ช้ากว่า (90 กับ 62 ms) หรือไฟล์ใหญ่ขึ้น 34% จึงไม่ใช้ การสร้างดัชนีครั้งแรกช้าลง (200,000 ไฟล์: 6 → 15 วินาที ในเบื้องหลัง) เพราะต้องเขียนดัชนี trigram ด้วย

## ออกรุ่นที่เซ็นแล้ว

ผู้ออกรุ่นของ File Center เซ็นตอนเผยแพร่ด้วย

```bash
# เพิ่ม "version" ใน package.json แล้ว commit ให้เรียบร้อยก่อน
bun run release --sign <ไฟล์กุญแจส่วนตัว> --notes "สิ่งที่เปลี่ยน" --push
```

- ไม่ใส่ `--sign` ระบบไม่ยอมเผยแพร่ ต้องใส่ `--unsigned` ให้ชัดเจนเท่านั้น
- ปฏิเสธถ้า working tree ไม่สะอาด หรือ `version` ไม่ใหม่กว่าทุกเวอร์ชันใน `updates` แล้ว
- ไม่ใส่ `--push` = commit ลง `updates` ในเครื่องเท่านั้น ตรวจแล้วค่อย `git push origin updates` เอง
- เบตา: `--beta` ดู [ติดตั้ง: ช่องทางเบตา](install.md#ช่องทางเบตา-เวอร์ชัน-xyz-betan)
- ผลคือ branch `updates` ที่มี `file-center-<version>.zip`, `SHA256SUMS`, `README.md` (ตารางเวอร์ชัน), `latest.json` (และ `latest-beta.json`) ที่ server อ่าน

ขั้นตอนทั้งหมด (สร้างกุญแจ ตั้ง `UPDATE_PUBLIC_KEY` `UPDATE_SOURCE` สร้างแพ็กเกจ) อยู่ที่ [ติดตั้ง: สร้างและเผยแพร่อัปเดตของคุณเอง](install.md#สร้างและเผยแพร่อัปเดตของคุณเอง) กุญแจส่วนตัวของรุ่นทางการไม่อยู่ใน repository ผู้ใช้รุ่นทางการไม่ต้องสร้างกุญแจเอง

## ต่างจาก FileGator ต้นแบบอย่างไร

File Center เขียนใหม่ทั้งหมดด้วย ElysiaJS + Bun (backend) และ Vue 3 + Naive UI (frontend) ออกแบบให้ใช้งานและหน้าตาใกล้เคียง File Center ที่สร้างต่อจาก FileGator แต่ไม่ได้ใช้โค้ดหรือข้อมูลเดิมเลย

- ไม่มีการ `chmod` ผ่านหน้าเว็บ (ไม่มีความหมายบน Windows/Docker)
- รหัสผ่านเก็บด้วย argon2id ผู้ใช้เดิมจาก FileGator ย้ายมาไม่ได้ ต้องสร้างใหม่ (ตามที่ตั้งใจไว้ว่าเริ่มใหม่ทั้งหมด)
- API เป็น REST (`/api/...`) ไม่ใช้รูปแบบ `/?r=/route`
- ไฟล์ที่ซ้ำชื่อตอนอัปโหลดจะถูกตั้งชื่อใหม่ เช่น `report (1).pdf` ไม่เขียนทับ
- session ของผู้เยี่ยมชมอยู่ในหน่วยความจำและมีเพดาน ส่วน session ของผู้ที่เข้าสู่ระบบเก็บในดิสก์ จึงอยู่รอดหลังรีสตาร์ต

## อ้างอิง API

หลักการร่วม

- ทุกคำสั่งที่เปลี่ยนข้อมูลต้องส่งหัว `X-CSRF-Token` ที่ได้จาก `GET /api/session` ผิดพลาดตอบเป็น `{ "error": "ข้อความ", "code": "fs.bad-name", "params": {} }`
- `code` คงที่ไม่เปลี่ยนตามภาษา (รายการทั้งหมดอยู่ใน `src/messages.ts` แบ่งตามหมวด เช่น `auth.locked`, `files.name-taken`) ส่วน `params` คือค่าที่เติมในข้อความ เช่น `{ "seconds": 30 }`
- `error` เป็นภาษาไทยหรืออังกฤษตามคำขอ: หัว `X-Lang: th` หรือ `en` ก่อน ถ้าไม่มีใช้คุกกี้ `fc_lang` (`th`/`en` ที่หน้าเว็บตั้งตามภาษาที่เลือก) ถ้าไม่มีใช้ `Accept-Language` ของเบราว์เซอร์ ถ้าไม่ระบุเลยเป็นภาษาไทย คำเตือนในหน้าภาพรวม (`warnings` ของ `GET /api/admin/status`) มี `code`, `message` และ `params` แบบเดียวกัน ส่วน log และประวัติการใช้งานยังเป็นภาษาไทยเสมอ
- ลิงก์ดาวน์โหลดที่เบราว์เซอร์เปิดในแท็บ (`/api/download`, `/api/batch/:token`, `/api/admin/logs/download`, `/api/admin/activity/export`, `/api/admin/backups/:name/download`, `/api/s/:token/download`) ถ้าล้มเหลวจะได้หน้า HTML สั้น ๆ แทน JSON: รหัสสถานะเดิม ข้อความตามภาษา รหัส และลิงก์กลับหน้าหลัก (นับเป็นการเปิดในแท็บเมื่อมี `Sec-Fetch-Mode: navigate` หรือ `Accept` มี `text/html` และไม่มีหัว `X-Lang`) การเรียกด้วย fetch ยังได้ JSON เหมือนเดิม
- รหัสเดิมที่หน้าเว็บใช้อยู่ไม่เปลี่ยน: `csrf`, `must-change-password`, `disk-full`, `not-supervised` และคำเตือน `errors`
- "space" คือพื้นที่ที่คำสั่งทำงานใน: `home` (โฟลเดอร์ส่วนตัว) · `public` · `grant:<id>` (โฟลเดอร์ที่ถูกแชร์ให้) · `group:<id>` (โฟลเดอร์กลุ่ม) · `user:<ชื่อ>` (ดูไฟล์ผู้ใช้ อ่านอย่างเดียว)

### ตารางสรุป

| เส้นทาง | ใช้ทำอะไร |
|---|---|
| `GET /api/session` · `POST /api/login` · `POST /api/login/2fa` · `POST /api/logout` · `POST /api/password` | เซสชัน |
| `GET /api/sessions` · `DELETE /api/sessions/:id` · `POST /api/sessions/revoke-others` · `POST /api/2fa/setup\|enable\|disable\|backup-codes` | อุปกรณ์ที่เข้าสู่ระบบ และ 2FA |
| `GET /api/list` · `/api/folders` · `/api/search` | ดูรายการ ค้นหา (พารามิเตอร์ `space`, `path`) การค้นหารับตัวกรองเพิ่ม ดู [ค้นหาไฟล์](#ค้นหาไฟล์) |
| `POST /api/mkdir` · `/newfile` · `/rename` · `/copy` · `/move` · `/delete` · `/zip` · `/unzip` | จัดการไฟล์ (ลบ = ย้ายไปถังขยะ) `/copy` และ `/move` มี `destSpace` (ไม่ใส่ = space เดิม) เพื่อข้าม space: ต้องมี `read` (+`download` ถ้าคัดลอก, +`write` ถ้าย้าย) ที่ต้นทาง และ `write` + `upload` ที่ปลายทาง นับโควตาปลายทาง; ย้ายข้าม space = คัดลอกก่อนแล้วลบต้นทางลงถังขยะ (คัดลอกไม่สำเร็จต้นทางไม่ถูกแตะ) |
| `GET/PUT /api/content` | อ่าน/บันทึกไฟล์ข้อความ (≤ 2 MB) `GET` ตอบ `mtime` ส่งกลับใน `PUT` เป็น `expectedMtime` ถ้าไฟล์ถูกแก้จากที่อื่นหลังจากเปิดจะได้ 409 `files.changed-elsewhere` และไม่บันทึก `PUT` ตอบ `mtime` ใหม่ |
| `GET /api/download` (รองรับ `Range`) · `POST /api/batch` + `GET /api/batch/:token` | ดาวน์โหลด |
| `POST /api/upload` → `PUT /api/upload/:id/:n` → `POST /api/upload/:id/complete` (และ `GET /api/upload/:id` ถามชิ้นที่รับแล้ว) | อัปโหลดแบบแบ่งชิ้น เก็บ space ที่ประกาศไว้ และตรวจสิทธิ์ `upload` ในที่นั้นใหม่ทุกชิ้นและตอนจบ (ยกเลิกสิทธิ์/แชร์ระหว่างอัปโหลด = 403 และงานถูกทิ้ง คืนโควตา) |
| `POST /api/office/config` · `GET /api/office/file/:token` · `POST /api/office/callback/:token` | แก้ไขเอกสาร office ด้วย ONLYOFFICE ดู [ONLYOFFICE](#onlyoffice) สองตัวหลังเรียกโดย document server เท่านั้น |
| `GET /api/thumb?space&path&size=256\|1024` · `GET /api/thumbs/status` · `GET /api/s/:token/thumb?path&size` | ภาพตัวอย่างของรูป/PDF/วิดีโอ ดู [ภาพตัวอย่าง](#ภาพตัวอย่างและดูไฟล์-zip) |
| `GET /api/archive/list?space&path` · `GET /api/archive/file?space&path&entry[&inline=1]` · `GET /api/s/:token/archive/list\|file` | ดูรายการใน zip และดึงรายการเดียวออกมา โดยไม่แตกไฟล์ |
| `POST/GET /api/shares` · `DELETE /api/shares/:id` · `GET /api/s/:token` · `POST /api/s/:token/unlock` · `GET /api/s/:token/download` | ลิงก์แชร์ ดู [ลิงก์แชร์](#ลิงก์แชร์) |
| `POST /api/s/:token/upload` → `PUT /api/s/:token/upload/:id/:n` → `POST /api/s/:token/upload/:id/complete` · `DELETE /api/s/:token/upload/:id` | ผู้เยี่ยมชมส่งไฟล์ผ่านลิงก์รับไฟล์ |
| `GET /api/me/usage` | พื้นที่ที่ใช้และโควตาของฉัน ดู [โควตา](#โควตาและถังขยะของผู้ใช้) |
| `/api/me/notifications` · `/api/me/notify-prefs` · `/api/me/email` · `/api/me/line` · `POST /api/line/webhook` | การแจ้งเตือนส่วนตัว: กระดิ่ง อีเมล LINE ดู [การแจ้งเตือนส่วนตัว](#การแจ้งเตือนส่วนตัว) |
| `GET /api/me/trash` · `POST /api/me/trash/:id/restore` · `DELETE /api/me/trash/:id` · `DELETE /api/me/trash` | ถังขยะของฉัน |
| `GET /api/groups/mine\|lookup` · `/api/admin/groups*` | กลุ่มและโฟลเดอร์กลุ่ม space `group:<id>` |
| `POST /api/grants` · `GET /api/grants/mine\|to-me` · `PATCH/DELETE /api/grants/:id` · `GET /api/users/lookup?q=` | แชร์โฟลเดอร์ให้ผู้ใช้อื่น space `grant:<id>` |
| `GET /api/versions?space&path` (`read`) · `GET /api/versions/:id/download?space&path` (`download`) · `POST /api/versions/:id/restore { space, path, expectedMtime? }` (`write`) · `DELETE /api/versions/:id?space&path` (`write`) | เวอร์ชันเก่าของไฟล์ (เก็บทุกครั้งที่บันทึกทับ ดู `VERSIONS_KEEP`/`VERSIONS_DAYS`): รหัสเวอร์ชันใช้ได้กับไฟล์ของมันเท่านั้น, กู้คืนจะเก็บเนื้อหาปัจจุบันเป็นเวอร์ชันก่อน (409 `files.changed-elsewhere` ถ้า `expectedMtime` ล้าสมัย) ถ้าโควตาเต็มจะลบเวอร์ชันเก่าสุดของไฟล์นั้นก่อน ยังไม่พอก็ปฏิเสธ `quota.exceeded` |
| `GET/POST/DELETE /api/me/favorites` (`{ space, path }`, สูงสุด 200) · `GET /api/me/recent` (50 ล่าสุด) | รายการโปรดและไฟล์ที่เปิดล่าสุดของผู้ใช้ (ผู้เยี่ยมชมได้ 401) ตรวจสิทธิ์ `read` และการมีอยู่ของไฟล์ทุกครั้งที่อ่าน |
| `GET/PUT /api/me/guide` | สถานะทัวร์และ "มีอะไรใหม่" ของผู้ใช้ (`{ seenVersion, toursDone }` เก็บใน `DATA_DIR/guide.json`) |
| `GET/POST /api/me/app-passwords` · `DELETE /api/me/app-passwords/:id` | รหัสผ่านแอป WebDAV |
| `/api/admin/*` | ผู้ใช้, ภาพรวม, ประวัติ, ลิงก์ที่แชร์ (admin และ manager ตามขอบเขต) · ถังขยะ, ตั้งค่า, โลโก้, `folders` (เฉพาะ admin) |
| `GET/POST /api/admin/backups` · `PUT /api/admin/backups/settings` · `GET /api/admin/backups/estimate` · `GET /api/admin/backups/:name/download` · `DELETE /api/admin/backups/:name` · `POST /api/admin/backups/restore` | สำรองข้อมูลระบบ: รายการ, ตั้งค่า (บีบอัด ตารางเวลา จำนวนที่เก็บ รวมไฟล์), ประมาณขนาด, สำรองทันที, ดาวน์โหลด, ลบ, กู้คืน (ต้องใส่รหัสผ่าน `{ name, password }`) (เฉพาะ admin) |
| `GET /api/admin/logs` (`level=info\|warn\|error`, `q`, `page`, `pageSize`) | log ของระบบ ใหม่สุดก่อน อ่านต่อไปยังไฟล์ที่หมุนแล้ว ตอบ `{ items, hasMore }` (เฉพาะ admin) |
| `GET /api/admin/logs/download` | zip ของ `system.log`, `launcher.log`, `audit.log` (รวมไฟล์ที่หมุนแล้ว) (เฉพาะ admin) |
| `GET /api/admin/activity/export?format=csv` | ส่งออกประวัติการใช้งานเป็น CSV ตามตัวกรองเดียวกับหน้าประวัติ (`user`, `action`, `q`) เป็น UTF-8 มี BOM ให้ Excel แสดงภาษาไทยได้ ช่องที่ขึ้นต้นด้วย `=` `+` `-` `@` tab หรือ CR จะมี `'` นำหน้ากันสูตร Excel (เฉพาะ admin) |
| `/api/admin/update/*` | อัปเดตระบบ: อัปโหลดแพ็กเกจ (ส่งชิ้นส่วนด้วย `PUT /api/upload/:id/:n`), ตรวจ, ติดตั้ง, ย้อนกลับ (เฉพาะ admin) `GET /api/admin/update` มี `source: { enabled, url }` และ `last.message` ตามภาษาของคำขอ ดู [อัปเดตระบบ](#อัปเดตระบบ) |
| `GET /api/admin/alerts` · `POST /api/admin/alerts/test` | สถานะการแจ้งเตือน · ส่งข้อความทดสอบ (เฉพาะ admin) |
| `GET /api/health` | ตรวจสุขภาพ (ใช้กับ Docker healthcheck) ผู้เยี่ยมชมได้แค่ `status` เครื่อง server เองและ admin ได้เวอร์ชันด้วย |

### ค้นหาไฟล์

`GET /api/search?space=home&q=report` หาจากชื่อไฟล์/โฟลเดอร์ (ตัวพิมพ์เล็กใหญ่ไม่ต่างกัน) ใต้ `path` ที่ระบุ เฉพาะภายในพื้นที่ของผู้เรียกที่มีสิทธิ์ `read` ตัวกรองเพิ่มเติม (ไม่ใส่ = ไม่กรอง)

| พารามิเตอร์ | ความหมาย |
|---|---|
| `type` | `file` หรือ `dir` |
| `ext` | นามสกุลคั่นด้วย `,` เช่น `pdf,docx` (ไม่สนตัวพิมพ์ ใส่จุดหน้าได้) |
| `from` / `to` | วันที่แก้ไขล่าสุด แบบ ISO (`2024-03-01` หรือ `2024-03-01T08:00:00Z`) `to` แบบมีแต่วันที่รวมทั้งวัน |
| `minSize` / `maxSize` | ขนาดเป็นไบต์ (โฟลเดอร์นับเป็น 0) |
| `sort` / `order` | `name` (ค่าเริ่มต้น) `mtime` `size` / `asc` (ค่าเริ่มต้น) `desc` |
| `limit` | จำนวนสูงสุดที่ตอบ ค่าเริ่มต้น 200 มากสุด 500 |

ตอบ `{ results, truncated, indexed }` ค่า filter ที่ผิดตอบ 400 (`files.bad-filter`)

ระบบเก็บ **ดัชนีค้นหา** ไว้ที่ `DATA_DIR/search.db` (SQLite) สร้างในเบื้องหลังตอนเริ่ม (ไม่บล็อกคำขออื่น ไม่ตามลิงก์) สแกนใหม่ทุก `SEARCH_RESCAN_MINUTES` นาที และอัปเดตทันทีหลังอัปโหลด สร้างโฟลเดอร์/ไฟล์ แก้ไข เปลี่ยนชื่อ ย้าย คัดลอก ลบ/ถังขยะ กู้คืน และแตก zip ระหว่างที่ดัชนียังสร้างไม่เสร็จ `/api/search` เดินดิสก์เองและตอบ `indexed: false` (ช้ากว่า และหยุดที่ 50,000 รายการ) ไฟล์นี้สร้างใหม่ได้เสมอ: ถ้าเสียหายหรือเป็นสคีมาเก่าระบบลบแล้วสร้างใหม่เอง จึงไม่ถูกรวมในการสำรองข้อมูล (`search.db` ของ 1.7.x ก็นับเป็นสคีมาเก่า: ถูกสร้างใหม่ในเบื้องหลังพร้อมตาราง `entries_fts` ระหว่างนั้นค้นหาด้วยการเดินดิสก์ `indexed: false`)

คำค้นตั้งแต่ 3 ตัวอักษรใช้ตาราง `entries_fts` (FTS5 `trigram`) หาแถวที่เป็นไปได้ก่อน คำค้นใส่เป็น phrase ใน `"..."` โดยเติม `"` เป็น `""` และส่งเป็นพารามิเตอร์ จึงไม่มีทางถูกอ่านเป็นไวยากรณ์ FTS แถวที่ได้ยังถูกตรวจด้วย `instr` กับชื่อจริงอีกครั้ง; คำค้น 1–2 ตัวอักษร หรือคำค้นที่พบเกิน 1,000 แถว ใช้ `instr` เรียงตามชื่อเหมือนเดิม

### ลิงก์แชร์

ผู้ที่เข้าสู่ระบบส่งลิงก์ให้คนที่ไม่มีบัญชีดาวน์โหลดไฟล์หรือโฟลเดอร์หนึ่งรายการได้ (ต้องมีสิทธิ์ `share` และ `download` ในพื้นที่ที่รายการนั้นอยู่) ผู้รับเปิด `/s/<token>` โดยไม่ต้องเข้าสู่ระบบ

- สร้าง: `POST /api/shares` `{ space, path, days, password?, maxDownloads? }` อายุ `days` เป็น 1, 7 หรือ 30 วัน (ไม่เกิน `SHARE_MAX_DAYS`) รหัสผ่านไม่บังคับ (อย่างน้อย 6 ตัวอักษร) `maxDownloads` ไม่ใส่ = ไม่จำกัด ตอบ `{ share, token, url }` `shares.json` (ใน `DATA_DIR`) เก็บ SHA-256 ของโทเคนไว้หาลิงก์ และเก็บตัวโทเคนแบบเข้ารหัส (AES-256-GCM ด้วย `secret.key`) ไว้ให้คัดลอกซ้ำ
- ลิงก์ของฉัน `GET /api/shares` (มี `linkAvailable`) · คัดลอกซ้ำ `GET /api/shares/:id/link` → `{ token, url }` (เจ้าของหรือ admin เฉพาะลิงก์ที่ยังใช้งานได้ บันทึก `share-link-view` ลิงก์ที่สร้างก่อน 1.8.1 หรือหลังกู้คืนข้อมูลบนเครื่องที่ `secret.key` ต่างไป ตอบ 409 `share.link-unavailable`) · ยกเลิก `DELETE /api/shares/:id` (เจ้าของหรือ admin) · admin ดูทั้งหมดที่ `GET /api/admin/shares` (ไม่มี hash ในคำตอบ)
- ใช้ลิงก์ (ไม่ต้องเข้าสู่ระบบ): `GET /api/s/:token` ตอบ `{ name, type, size, expiresAt, needsPassword, entries? }` (ลิงก์โฟลเดอร์ดูข้างในได้ด้วย `?path=` ไม่มีทางออกนอกโฟลเดอร์ที่แชร์ และไม่แสดง/ไม่ตาม symlink) · `POST /api/s/:token/unlock` `{ password }` ตั้ง cookie อายุ 1 ชั่วโมงที่ใช้ได้กับลิงก์นั้นลิงก์เดียว (ไม่ต้องมี CSRF token) ใส่ผิด 5 ครั้งล็อกลิงก์นั้นสำหรับ IP นั้น 15 นาที · `GET /api/s/:token/download?path=` ส่งไฟล์ (หัวเดียวกับ `/api/download`) หรือโฟลเดอร์/โฟลเดอร์ย่อยเป็น zip
- `maxDownloads` นับเฉพาะการดาวน์โหลดที่ส่งครบ ครั้งละหนึ่ง ระหว่างดาวน์โหลดจองที่ไว้ (เริ่มพร้อมกันหลายครั้งก็เกินไม่ได้) ยกเลิกกลางทางไม่นับ ลิงก์ที่จำกัดจำนวนครั้งส่งทั้งไฟล์เสมอ (ไม่รับ `Range`) ลิงก์ไม่จำกัดรับ `Range` ได้ และนับเฉพาะครั้งที่ได้ทั้งไฟล์
- ลิงก์หยุดทำงานเมื่อ: หมดอายุ, ถูกยกเลิก, ดาวน์โหลดครบจำนวน, รายการถูกลบ/ย้าย/เปลี่ยนชนิด, เจ้าของถูกลบ (ลิงก์ถูกยกเลิกด้วย สร้างบัญชีชื่อเดิมใหม่ก็ไม่กลับมา) หรือเจ้าของไม่มีสิทธิ์ `share`/`download` ในพื้นที่นั้นแล้ว ทุกกรณีตอบ 404 `share.not-found` แบบเดียวกัน
- ประวัติการใช้งานบันทึก `share-create`, `share-download`, `share-revoke` พร้อมพาธ (ไม่บันทึกโทเคน) ลิงก์ที่หมดอายุถูกลบออกจาก `shares.json` ตอนเริ่มระบบและวันละครั้ง

**ลิงก์รับไฟล์:** `POST /api/shares` ใส่ `kind: "upload"` ได้เฉพาะ **โฟลเดอร์** และต้องมีสิทธิ์ `share` กับ `upload` ในพื้นที่นั้น (ลิงก์ที่ไม่มี `kind` คือลิงก์ดาวน์โหลดเหมือนเดิมทุกประการ) ตัวเลือก (ไม่บังคับทั้งหมด): `maxFileBytes` (ไม่เกิน `UPLOAD_MAX_SIZE`), `maxFiles`, `maxTotalBytes` (ไม่เกิน 2^50), `note` (ข้อความถึงผู้อัปโหลด ไม่เกิน 500 ตัวอักษร แสดงเป็นข้อความธรรมดา), `days` และ `password` เหมือนลิงก์ดาวน์โหลด สิทธิ์ของเจ้าของถูกตรวจใหม่ทุกครั้งที่ใช้ลิงก์ ถ้าเสียสิทธิ์ `share`/`upload` ลิงก์หยุดทันที

- `GET /api/s/:token` ของลิงก์รับไฟล์ตอบชื่อโฟลเดอร์ ข้อจำกัด note จำนวนที่รับแล้ว และ `mine` (ไฟล์ที่ผู้เยี่ยมชมคนนี้ส่งเอง) **ไม่เคยแสดงของที่อยู่ในโฟลเดอร์** เส้นทางดาวน์โหลดปฏิเสธลิงก์รับไฟล์ และเส้นทางอัปโหลดปฏิเสธลิงก์ดาวน์โหลด (404 เหมือนกรณีอื่น)
- ส่งไฟล์: `POST /api/s/:token/upload` `{ name, size }` → `{ id, chunkSize, total }` · `PUT /api/s/:token/upload/:id/:n` · `POST /api/s/:token/upload/:id/complete` · `DELETE /api/s/:token/upload/:id` ไฟล์ลงตรงในโฟลเดอร์ที่แชร์ (ผู้ส่งเลือกโฟลเดอร์ย่อยไม่ได้) ชื่อผ่านการตรวจชื่อปกติ ชื่อซ้ำได้ชื่อใหม่ เช่น `a (1).pdf` **ไม่เขียนทับ**
- งานอัปโหลดผูกกับลิงก์นั้นและกับผู้เยี่ยมชมคนนั้นด้วย cookie สุ่ม `fc_visitor` (HttpOnly, SameSite=Strict, ใช้ได้เฉพาะ path ของลิงก์) เพราะไม่มี session จึงไม่ต้องใช้ CSRF token สำหรับ 4 เส้นทางนี้ (ระบุใน `src/context.ts`)
- ไบต์นับกับโควตาของเจ้าของลิงก์ (ถ้าลิงก์อยู่ใน home) และกับข้อจำกัดของลิงก์ โดยจองตั้งแต่ประกาศไฟล์ จำกัดอัปโหลดค้างพร้อมกัน 5 งานต่อลิงก์ และ 3 งานต่อ IP ลิงก์ที่ไม่ได้กำหนดข้อจำกัดใช้ค่าเริ่มต้น `UPLOAD_REQUEST_MAX_FILE` / `UPLOAD_REQUEST_MAX_TOTAL` ลิงก์ในพื้นที่ public หรือของผู้ใช้ที่ไม่มีโควตา (รวมผู้ดูแล) นับกับโควตารายวันของผู้เยี่ยมชม (`GUEST_UPLOAD_DAILY_BYTES`) งานที่ประกาศแล้วแต่ไม่มีชิ้นใหม่เกิน `UPLOAD_REQUEST_IDLE_MINUTES` ถูกลบและคืนที่ว่างของลิงก์ ประวัติการใช้งานบันทึก `share-upload` (เจ้าของ รหัสลิงก์ ชื่อไฟล์ ขนาด)

### โควตาและถังขยะของผู้ใช้

**โควตา:** admin กำหนดที่ `POST /api/admin/users` และ `PUT /api/admin/users/:username` ด้วย `quotaBytes` (จำนวนไบต์เต็ม 0 ถึง 2^50, `0` หรือไม่ตั้ง = ไม่จำกัด) แสดงใน `GET /api/admin/users` ด้วย ผู้ใช้ดูยอดของตัวเองที่ `GET /api/me/usage` → `{ used, quota, counting }` (`quota` 0 = ไม่จำกัด `counting` เป็น true ขณะกำลังนับครั้งแรกและยังไม่มีตัวเลข) เต็มแล้วได้ **507** `quota.exceeded` พร้อม `params: { used, quota }` (ไบต์) ดูกติกาที่ [คู่มือผู้ดูแล](admin-guide.md#โควตาพื้นที่)

**ถังขยะของผู้ใช้**

การลบเขียน `meta.json` ของรายการ **ก่อน** ย้ายไฟล์เข้าถังขยะ (ตั้งแต่ 1.12.1) การลบยังย้ายไปถังขยะกลางเหมือนเดิม (admin ดูและกู้คืนได้ที่ `/api/admin/trash`) แต่แต่ละรายการจดเพิ่ม `owner` (ผู้ใช้ที่โฟลเดอร์ของเขาเก็บรายการนั้นอยู่; `null` = โฟลเดอร์สาธารณะหรือที่อื่น) และ `space` (`home` / `public` / `other`) รายการเก่าที่ไม่มีสองค่านี้หา `owner` จาก `originalPath` ตอนอ่าน (ไม่นับบัญชีที่สร้างหลังเวลาที่รายการถูกลบ) เมื่อลบบัญชีผู้ใช้ รายการในถังขยะที่เป็นของเขาหรือที่เขาลบ (`owner`, `deletedBy`) จะถูกเปลี่ยนเป็นชื่อ `~<ชื่อ>@<เวลา>` ซึ่งไม่มีบัญชีไหนใช้ได้ (`~` ใช้ในชื่อผู้ใช้ไม่ได้) บัญชีใหม่ชื่อเดิมจึงไม่เห็น เหลือเฉพาะ admin ที่ `/api/admin/trash`

| | |
|---|---|
| `GET /api/me/trash` | `{ items: [{ id, name, type, size, deletedAt, deletedBy, owner, space, path, restorable }], retentionDays }` `space`/`path` คือที่ที่จะกู้คืนไป (ใน space ของผู้เรียก) เป็น `null` และ `restorable: false` ถ้ากลับไปที่เดิมไม่ได้แล้ว (เช่นโฟลเดอร์ home ถูกย้าย) |
| `POST /api/me/trash/:id/restore` | กู้คืนไปที่เดิม ชื่อซ้ำได้ชื่อใหม่ (`name (1).ext`) เวอร์ชันเก่ากลับมาด้วย นับโควตาเหมือนการเขียนอื่น (507 `quota.exceeded`) ตอบ `{ ok, restoredTo, space, path }` ที่เดิมอยู่นอกพื้นที่ของผู้เรียก หรือไม่มี `write` ที่นั่น = 403 `trash.cannot-restore-here` |
| `DELETE /api/me/trash/:id` | ลบถาวร (ไม่ต้องใส่รหัสผ่าน) ตอบ `{ ok, removed: 1 }` ลบถาวรได้เฉพาะเจ้าของรายการ (รายการในโฟลเดอร์สาธารณะ/ที่อื่นที่ไม่มีเจ้าของ: คนที่ลบ) ผู้รับแชร์ที่ลบในโฟลเดอร์ของคนอื่นกู้คืนได้แต่ลบถาวรไม่ได้ = 403 `trash.cannot-purge` |
| `DELETE /api/me/trash` | ล้างถังขยะของตัวเอง ตอบ `{ ok, removed }` (นับเฉพาะรายการที่ลบถาวรได้ตามข้างบน) |

รายการที่ไม่ใช่ของผู้เรียกตอบ 404 เหมือนรหัสที่ไม่มีอยู่ ประวัติการใช้งานมี `trash-restore-own` และ `trash-delete-own` `POST /api/delete` ที่ส่ง `withTrash: true` ตอบ `trashed: [{ path, id }]` เพิ่ม (หน้าเว็บใช้ทำปุ่ม "เลิกลบ" ที่เรียก restore ทันที; ไม่ส่งก็ได้คำตอบเดิม `{ done, failed }`) ของที่ลบจากโฟลเดอร์กลุ่มมี `owner` = `group:<id>` และ `group: { id, name }` ใน `GET /api/me/trash`

### แชร์ให้ผู้ใช้และกลุ่ม (grants)

เจ้าของโฟลเดอร์ (ต้องมีสิทธิ์ `share` ใน home) เลือกโฟลเดอร์ของตัวเองให้ผู้ใช้อีกคนเปิดได้ เก็บใน `DATA_DIR/grants.json` ผู้รับเปิดผ่าน space `grant:<id>` ที่ใช้กับ `/api/list`, `/api/download`, `/api/upload` ฯลฯ ได้เหมือน space อื่น โดยราก (`/`) คือโฟลเดอร์ที่แชร์

- `perms: "view"` = `read`, `download`, `batchdownload`, `zip` · `"edit"` = view + `write`, `upload` ไม่มี `share` เสมอ (ผู้รับแชร์ต่อไม่ได้)
- เปิดได้เฉพาะผู้รับ (`to`) คนที่สามและเจ้าของเองได้คำตอบเหมือนรหัสที่ไม่มีอยู่ (403) สิทธิ์ตรวจใหม่ทุกครั้งที่ใช้: ถ้าเจ้าของหรือผู้รับถูกลบ เจ้าของไม่มี `share` แล้ว โฟลเดอร์ home ของเจ้าของถูกย้าย หรือโฟลเดอร์หายไป ถูกย้ายออก กลายเป็นไฟล์หรือลิงก์ สิทธิ์นั้นใช้ไม่ได้ทันที (ลบผู้ใช้ลบสิทธิ์ที่ให้และได้รับออกจากไฟล์ด้วย)
- ที่ที่ผู้รับเขียนนับโควตาของ **เจ้าของ** ไม่ใช่ของผู้รับ ของที่ผู้รับลบเข้าถังขยะของเจ้าของ (ผู้รับกู้คืนได้เองตราบที่ยังมีสิทธิ์ `edit`)
- การเปิดดูโฟลเดอร์ของผู้รับแชร์ลงประวัติ `browse` (ครั้งเดียวต่อนาทีต่อโฟลเดอร์) ส่วนดาวน์โหลด/เปิดอ่านลงประวัติพร้อม `detail` = space
- **แชร์ให้กลุ่ม:** `POST /api/grants` ใส่ `toGroup: <id>` แทน `to` (ใส่ทั้งสองหรือไม่ใส่เลย = 400 `grants.to-one`) ผู้ใช้ที่มี `share` แชร์ให้ **กลุ่มที่ตัวเองเป็นสมาชิก** ได้ (admin ให้กลุ่มไหนก็ได้) กลุ่มอื่น/ไม่มี = 404 `groups.not-found` สมาชิกทุกคนเห็นใน `GET /api/grants/to-me` (ยกเว้นเจ้าของเอง) ผู้ที่เป็นสมาชิก `view` ได้ไม่เกิน `view` แม้แชร์แบบ `edit` สมาชิกที่ถูกถอดหรือกลุ่มที่ถูกลบ = เสียสิทธิ์ทันที สมาชิก **ออกจากการแชร์ของกลุ่มเองไม่ได้** (`DELETE /api/grants/:id` ของผู้รับกลุ่ม = 404) เฉพาะเจ้าของยกเลิกได้ เจ้าของเห็นใน `/api/grants/mine` พร้อม `toGroup` และ `toGroupName` (`to` เป็น `null`)

| | |
|---|---|
| `POST /api/grants` `{ space: "home", path, to, perms }` | ให้สิทธิ์ (ต้องมี `share` ที่ home; `path` เป็นโฟลเดอร์จริงใน home ไม่ใช่ `/` ไม่ใช่ลิงก์) ตอบ `{ ok, created, grant }` ซ้ำ (เจ้าของ+โฟลเดอร์+ผู้รับ เดียวกัน) = แก้ `perms` (`created: false`) · จำกัด 30 ครั้งต่อนาทีต่อคน (429 `grants.create-rate`) เพื่อไม่ให้ใช้เดาชื่อผู้ใช้ · 400 `grants.to-self` / `grants.folder-only` / `grants.too-many` · 404 `admin.user-not-found` / `files.folder-not-found` |
| `GET /api/grants/mine` | `{ items: [{ id, path, name, to, toName, perms, createdAt, active }] }` สิทธิ์ที่ฉันให้ (`path` สัมพันธ์กับ home; `active: false` = ใช้ไม่ได้แล้ว ควรให้ลบ) |
| `GET /api/grants/to-me` | `{ items: [{ id, space, name, owner, ownerName, perms, createdAt }] }` โฟลเดอร์ที่ได้รับและใช้ได้อยู่ (ไม่มีพาธของเจ้าของ) |
| `PATCH /api/grants/:id` `{ perms }` | เจ้าของเท่านั้น (คนอื่น 404) |
| `DELETE /api/grants/:id` | เจ้าของยกเลิก หรือผู้รับออกจากการแชร์ (คนอื่น 404) |
| `GET /api/users/lookup?q=` | เลือกผู้รับ: ต้องเข้าสู่ระบบและมี `share` (admin ได้) `q` อย่างน้อย 3 ตัวอักษร (400 `grants.query-short`, `params.min` = 3) ค้นจากชื่อผู้ใช้และชื่อที่แสดง ตอบ `{ users: [{ username, name }] }` ไม่เกิน 10 คน ไม่รวมตัวเอง ไม่ระบุบัญชี admin/manager ให้ผู้ใช้ทั่วไป (ผู้ใช้ทั่วไปแชร์ให้เจ้าหน้าที่ได้โดยพิมพ์ชื่อผู้ใช้เต็มใน `POST /api/grants`) ไม่มีข้อมูลอื่น จำกัด 20 ครั้งต่อนาทีต่อคน (429 `grants.lookup-rate`) |

ประวัติการใช้งานมี `grant-create`, `grant-update`, `grant-delete` ในโค้ด `onGrantCreated(grant)` ใน `src/grants.ts` เรียกทุกครั้งที่สร้างสิทธิ์ใหม่ (ไม่รวมการแก้) โมดูลอื่น (เช่นการแจ้งเตือน) เพิ่มฟังก์ชันใน `grantCreatedListeners` เพื่อรับรู้

### กลุ่ม

ข้อมูลกลุ่มเก็บใน `DATA_DIR/groups.json`: `{ id, name, members: [{ username, perms }], quotaBytes, createdAt, createdBy }` โฟลเดอร์ `<storage>/groups/<id>` และ space `group:<id>` กติกาของกลุ่มดู [คู่มือผู้ดูแล: กลุ่ม](admin-guide.md#กลุ่ม)

| | |
|---|---|
| `GET /api/groups/mine` | `{ items: [{ id, name, perms, space, quotaBytes, used }] }` กลุ่มที่ฉันเป็นสมาชิก (admin ที่ไม่ได้เป็นสมาชิกไม่อยู่ในนี้) |
| `GET /api/groups/lookup?q=` | เลือกกลุ่มตอนแชร์: ต้องมี `share` (admin ได้) `q` ไม่ใส่ = ทั้งหมด ตอบ `{ groups: [{ id, name }] }` เฉพาะกลุ่มของฉัน (admin: ทุกกลุ่ม) ไม่เกิน 20 |
| `GET /api/admin/groups` | admin: ทุกกลุ่ม · manager: เฉพาะกลุ่มที่เป็นสมาชิก `{ items: [{ id, name, space, quotaBytes, used, createdAt, createdBy, members: [{ username, name, perms }] }] }` |
| `POST /api/admin/groups` `{ name, quotaBytes? }` | admin เท่านั้น ตอบ `{ ok, group }` · 400 `groups.bad-name` · 409 `groups.name-taken` · 400 `admin.bad-quota` |
| `PATCH /api/admin/groups/:id` `{ name?, quotaBytes? }` | admin เท่านั้น ตอบ `{ ok, group }` · 404 `groups.not-found` |
| `DELETE /api/admin/groups/:id` `{ password }` | admin เท่านั้น ต้องใส่รหัสผ่านตัวเองซ้ำ (403 `auth.wrong-password`, 429 `auth.confirm-locked`) |
| `PUT /api/admin/groups/:id/members` `{ username, perms: "view"\|"edit" }` | เพิ่มสมาชิกหรือเปลี่ยนสิทธิ์ ตอบ `{ ok, added, member }` · 404 `admin.user-not-found` · manager: 403 `groups.not-manageable` |
| `DELETE /api/admin/groups/:id/members/:username` | ถอดสมาชิก · 404 `groups.member-not-found` |

ประวัติการใช้งานมี `group-create`, `group-update`, `group-delete`, `group-member-add` (รวมเปลี่ยนสิทธิ์), `group-member-remove` และ `browse`/`download`/`view` ใน space `group:<id>` โมดูลอื่น (เช่น WebDAV) ใช้ `groupSpacesOf(user)` จาก `src/groups.ts` ได้: คืน `[{ name, space }]` ของกลุ่มที่ผู้ใช้เป็นสมาชิก แล้วเรียก `accessFor(user, space)` ตามปกติ

### ดูไฟล์ของผู้ใช้ space=user

ใช้ route ไฟล์เดิมทั้งหมดโดยส่ง `space=user:ubob` (ชื่อไม่สนตัวพิมพ์): `GET /api/list` · `/folders` · `/search` · `/content` · `/download` (รวม `inline=1`) · `POST /api/batch` + `GET /api/batch/:token` · `GET /api/versions...` สิทธิ์ใน space นี้มีเพียง `read, download, batchdownload, zip` (คำตอบของ `/api/list` มี `permissions`) คำสั่งเขียนทุกตัว (mkdir, newfile, PUT content, rename, copy, move, delete, zip, unzip, upload, shares, office, favorites) ได้ 403 รวมถึงการคัดลอกออกจาก space นี้ไปโฟลเดอร์ตัวเอง ถ้า manager ไม่มีสิทธิ์จัดการเจ้าของ (ไม่มีผู้ใช้ เป็น manager/admin โฟลเดอร์ไม่ใช่ `/users/<ชื่อ>`) หรือเป็น user/ผู้เยี่ยมชม ได้ 403 (ผู้เยี่ยมชม 401) path ที่หลุดออกนอกโฟลเดอร์นั้นได้ 400/403 เหมือน space ปกติ

ทุกการอ่านที่มีผลกับไฟล์ถูกบันทึกในประวัติการใช้งาน: `download` (รวมพรีวิว), `download-zip`, และ `view` (อ่านไฟล์ข้อความ `GET /api/content`) โดย `detail` บอก `user:<ชื่อ>` (การดูรายการและค้นหาไม่บันทึก) ไฟล์ที่เปิดไม่ถูกจำใน "ล่าสุด"/"รายการโปรด"

`GET /api/admin/status` ของ manager ตอบเฉพาะ `{ reduced: true, users, storage: { size }, stale, warnings }` (`users` และ `storage` นับเฉพาะผู้ใช้ที่ manageable ส่วน `size` คือพื้นที่ที่โฮมของพวกเขาใช้) และ `warnings` มีได้เพียง `admin.default-password` (นับเฉพาะผู้ใช้ที่ manageable) ไม่มีเวอร์ชัน เวลาทำงาน ดิสก์ สำรองข้อมูล ถังขยะ หรือข้อมูลอัปเดต ของ admin ตอบเหมือนเดิมพร้อม `reduced: false`

รหัสข้อผิดพลาดของ manager: สร้าง/เลื่อนเป็น `manager` หรือ `admin` ไม่ได้ → 403 `admin.role-not-allowed` · แตะ manager/admin หรือตัวเอง → 403 `admin.not-manageable` (ผู้ใช้ที่ไม่มีอยู่ 404) · `publicPermissions` เกินของ manager เอง → 403 `admin.public-perms-exceed` (ค่าที่ผู้ใช้คนนั้นมีอยู่แล้วส่งกลับมาซ้ำได้) · โฟลเดอร์ซ้ำ/ซ้อน → 409 `admin.home-exists` · admin คนสุดท้ายลบหรือลดบทบาทไม่ได้ → 400 `admin.last-admin` · `homedir` เป็น `/groups` หรือข้างใน → 400 `admin.home-in-groups` · ตั้งรหัสผ่านใหม่ให้ผู้ใช้ (`PUT /api/admin/users/:username` พร้อม `password`) ต้องส่ง `confirmPassword` เป็นรหัสผ่านของ manager/admin เอง (ผิด 403) · `GET /api/admin/users` ของบัญชีที่จัดการไม่ได้ตอบเพียง `{ username, name, role, manageable: false }`

### อุปกรณ์และ 2FA

| | |
|---|---|
| `GET /api/sessions` | อุปกรณ์ที่เข้าสู่ระบบอยู่ของตัวเอง `{ id, ip, ua, created, seen, current }` เรียงใหม่สุดก่อน |
| `DELETE /api/sessions/:id` · `POST /api/sessions/revoke-others` | ออกจากระบบอุปกรณ์นั้น (ถ้าเป็นเครื่องที่ใช้อยู่ก็เท่ากับออกจากระบบ) · เก็บไว้เฉพาะเครื่องนี้ |
| `GET /api/admin/users/:username/sessions` · `POST .../sessions/revoke` | admin (และ manager กับผู้ใช้ที่จัดการได้) ดูและเพิกถอนทุกอุปกรณ์ของผู้ใช้ การเพิกถอนนี้ **ลบรหัสผ่านแอป WebDAV ของผู้ใช้ด้วย** คำตอบมี `appPasswords` = จำนวนที่ลบ และบันทึกในประวัติการใช้งาน |
| `POST /api/2fa/setup { password }` | ได้ `{ secret, uri }` (uri เป็น `otpauth://` ที่ใช้ชื่อเว็บจากหน้าตั้งค่าเป็น issuer) |
| `POST /api/2fa/enable { code }` | ได้ `{ backupCodes }` 10 รหัส แสดงครั้งเดียว และอุปกรณ์อื่นถูกออกจากระบบ |
| `POST /api/2fa/disable { password, code }` · `POST /api/2fa/backup-codes { password, code }` | ปิด 2FA · ขอรหัสสำรองชุดใหม่ (`code` เป็นรหัสจากแอปหรือรหัสสำรองก็ได้) |
| `POST /api/login` → `{ twoFactor: true, ticket }` → `POST /api/login/2fa { ticket, code }` | ผู้ใช้ที่เปิด 2FA ได้ ticket (ใช้ได้ครั้งเดียว 5 นาที ผูกกับผู้ใช้และ IP) ก่อนจะได้ session |
| `POST /api/admin/users/:username/2fa/reset { password }` | admin/manager รีเซ็ต 2FA ให้ (ใส่รหัสผ่านของตัวเอง) |

### การแจ้งเตือนผู้ดูแล

`GET /api/admin/alerts` ตอบ `{ enabled, kind, host, lastSent: { <เรื่อง>: เวลา } }` · `POST /api/admin/alerts/test` ส่งข้อความทดสอบทันที ตอบ `{ ok: true }` หรือ error ที่บอกสาเหตุ (`admin.alert-off`, `admin.alert-status`, `admin.alert-timeout`, `admin.alert-unreachable`) และบันทึก `alert-test` ในประวัติการใช้งาน (เฉพาะ admin) รูปแบบ `json` ส่ง `{ event, code, message, params, lang, version, time }` ดูวิธีตั้งที่ [คู่มือผู้ดูแล](admin-guide.md#การแจ้งเตือนระบบ-webhook)

### การแจ้งเตือนส่วนตัว

ส่งถึงผู้ใช้แต่ละคน เก็บที่ `DATA_DIR/notifications.json` คนละไม่เกิน 100 รายการ (เก่าสุดหลุดก่อน) ระบบเก็บแค่ชนิดกับค่าที่เกี่ยวข้อง (`params`) ข้อความเขียนตอนอ่านตามภาษาของผู้อ่าน ตัวคิวส่งอีเมล/LINE อยู่ใน `src/deliver.ts`

| ชนิด (`kind`) | ส่งเมื่อ |
|---|---|
| `upload-received` | มีคนอัปโหลดไฟล์ผ่านลิงก์รับไฟล์ของฉันเสร็จ (บอกเฉพาะเจ้าของลิงก์) การอัปโหลดผ่านลิงก์เดียวกันภายใน 10 นาทีรวมเป็นรายการเดียวในกระดิ่ง (ยังไม่อ่าน: `params.n` = จำนวนไฟล์, `size` = ขนาดรวม, `file` = ไฟล์ล่าสุด) |
| `link-expiring` | ลิงก์แชร์ของฉันจะหมดอายุภายใน 24 ชั่วโมง (ตรวจรายชั่วโมง ครั้งเดียวต่อลิงก์ ลิงก์ที่ตั้งไว้ 1 วันไม่แจ้ง) |
| `link-limit-reached` | ลิงก์แชร์ของฉันถูกดาวน์โหลดครบจำนวนที่ตั้งไว้ |
| `quota-low` | พื้นที่ของฉันใช้เกิน 90% ของโควตา (ครั้งเดียวจนกว่าจะต่ำกว่า 90% แล้วเกินอีก) |
| `folder-shared` | มีคนแชร์โฟลเดอร์ให้ฉัน (แชร์ให้กลุ่ม = สมาชิกทุกคนยกเว้นผู้แชร์) |
| `group-added` | ฉันถูกเพิ่มเข้ากลุ่ม (ลิงก์ `/groups/<id>`; เปลี่ยนสิทธิ์ในกลุ่มไม่แจ้ง) |
| `system-alert` | (admin) สิ่งเดียวกับที่ส่งไป webhook ของผู้ดูแล ชั่วโมงละครั้งต่อเรื่อง แม้ไม่ได้ตั้ง `ALERT_WEBHOOK_URL` |

ผู้ใช้เลือกต่อชนิดและต่อช่องทาง (`web` กระดิ่ง · `email` · `line`) ค่าเริ่มต้นเปิดเฉพาะกระดิ่ง ส่งทางอีเมลและ LINE เป็นงานเบื้องหลัง ไม่ทำให้คำขอใดช้า ลองใหม่ได้ 3 ครั้งแล้วเลิก (บันทึก `notify-delivery-failed` ใน log โดยไม่มีที่อยู่อีเมลหรือโทเคน) ลิงก์ในข้อความเป็นพาธในแอป เช่น `/links`, `/files?path=...`

| เส้นทาง (ต้องเข้าสู่ระบบ ผู้เยี่ยมชมได้ 401) | |
|---|---|
| `GET /api/me/notifications?unreadOnly=true` | `{ items: [{ id, kind, at, read, text, params, link }], unread }` ใหม่สุดก่อน `text` ตามภาษาของคำขอ (`X-Lang`) `unread` นับทั้งหมด ไม่ขึ้นกับ `unreadOnly` |
| `POST /api/me/notifications/read` | `{ ids?: string[] }` ไม่ใส่ = ทั้งหมด → `{ ok, unread }` |
| `DELETE /api/me/notifications/:id` | ลบของตัวเอง ของคนอื่นหรือไม่มี → 404 `notify.not-found` |
| `GET /api/me/notify-prefs` | `{ lang, email: { enabled, address, verified }, line: { enabled, linked }, events: { <ชนิด>: { web, email, line } } }` |
| `PUT /api/me/notify-prefs` | `{ lang?: "th"\|"en", events?: { <ชนิด>: { web?, email?, line? } } }` เปลี่ยนเฉพาะที่ส่ง → ตอบเหมือน GET ชนิดไม่รู้จัก 400 `notify.bad-kind` |
| `PUT /api/me/email` · `DELETE /api/me/email` | `{ address }` → `{ address, verified: false }` และส่งลิงก์ยืนยัน (400 `notify.bad-address`, 409 `notify.email-off`, 429 `notify.verify-too-soon` / `notify.mail-limit`) |
| `GET /api/me/email/verify?token=` | ลิงก์ในอีเมล: เปิดจากโปรแกรมอีเมลได้ redirect ไป `/?emailVerified=1` (หรือ `=0` ถ้าโทเคนใช้ไม่ได้) ถ้าเรียกด้วย fetch (มีหัว `X-Lang` หรือ `Accept: application/json`) ได้ JSON `{ ok, username }` หรือ 400 `notify.bad-token` |
| `POST /api/me/line/link` · `DELETE /api/me/line` | `{ code, expiresAt, ttlSeconds }` (409 `notify.line-off` ถ้ายังไม่ตั้ง LINE) · ยกเลิกการเชื่อม |
| `POST /api/line/webhook` | สำหรับ LINE เท่านั้น (ลายเซ็น `X-Line-Signature` ไม่ใช่ session) |

หน้าเว็บควรถามรายการแบบ `?unreadOnly=true` ทุก 30-60 วินาทีขณะแท็บเปิดอยู่ (และเมื่อกลับมาที่แท็บ) แล้วโหลดรายการเต็มเมื่อเปิดกระดิ่ง ปลายทางนี้บีบอัดผลตอบได้เพราะไม่มีความลับในนั้น

### รหัสผ่านแอป WebDAV

| | |
|---|---|
| `GET /api/me/app-passwords` | `{ items: [{ id, name, scope, hint, createdAt, lastUsedAt, lastIp }], max: 20, enabled }` (`hint` คือ `fc-` กับอักขระ 8 ตัวแรกของรหัส ไว้แยกว่าอันไหน ไม่ใช่ตัวรหัส; `enabled: false` = `WEBDAV=off`) |
| `POST /api/me/app-passwords` `{ name, scope, password }` | `name` 1–60 ตัวอักษร · `scope` = `read` / `readwrite` · `password` = รหัสผ่านบัญชีของคุณตอนนี้ ตอบ `{ id, name, scope, hint, createdAt, lastUsedAt, lastIp, secret }` **`secret` มีเฉพาะคำตอบนี้ครั้งเดียว** · 403 `auth.wrong-password` / 429 `auth.confirm-locked` (นับรวมกับการยืนยันรหัสผ่านอื่น) · 400 `auth.app-password-bad-name` / `auth.app-password-bad-scope` / `auth.app-password-limit` |
| `DELETE /api/me/app-passwords/:id` | ลบอันของตัวเอง (ของคนอื่น = 404 `auth.app-password-not-found`) |

`GET /api/session` มี `config.webdav` (true/false) สำหรับผู้ที่เข้าสู่ระบบแล้ว ให้หน้าเว็บรู้ว่าจะแสดงส่วนนี้หรือไม่ บันทึก `lastUsedAt`/`lastIp` ไม่เกินนาทีละครั้ง

**ผู้พัฒนา: เพิ่มโฟลเดอร์ใน `/dav/`** โมดูลอื่นเพิ่มโฟลเดอร์ใน `/dav/` ได้ด้วย `registerDavSpace(ชื่อ, user => space | null)` (หนึ่งโฟลเดอร์ = หนึ่ง space) หรือ `registerDavFolder(ชื่อ, user => [{ name, space }])` (โฟลเดอร์ที่รวมหลาย space เช่น กลุ่มผู้ใช้: `registerDavFolder('groups', user => groupsOf(user).map(g => ({ name: g.name, space: \`group:${g.id}\` })))` ซึ่ง `src/index.ts` ลงทะเบียนไว้แล้ว) ใน `src/webdav.ts` ชื่อถูกทำให้ปลอดภัยและไม่ซ้ำให้ ถ้าไม่มี entry โฟลเดอร์นั้นไม่ปรากฏ สิทธิ์ทุกอย่างมาจาก `accessFor(user, space)`

### WebDAV (รายละเอียดโปรโตคอล)

ผู้ใช้อ่านที่ [คู่มือผู้ใช้: WebDAV](user-guide.md#webdav-เปิดไฟล์เป็นไดรฟ์ในเครื่อง) ส่วนนี้คือสิ่งที่ `src/webdav.ts` ทำจริง

- `PROPFIND` รองรับ `Depth: 0` และ `1` เท่านั้น (`infinity` ตอบ 403) ขอ property ได้ไม่เกิน 50 ชื่อต่อคำขอ (เกิน → 400 `files.dav-too-many-props`) โฟลเดอร์ที่มี `WEBDAV_MAX_ITEMS` (ค่าเริ่มต้น 100,000) รายการขึ้นไปใน `Depth: 1` ตอบ **507** พร้อมเนื้อหา `<D:error><D:number-of-matches-within-limits/></D:error>` ทั้งก้อน (ไม่ตัดครึ่ง เพราะไคลเอนต์จะเข้าใจว่าครบ) ชื่อ property ที่ไม่รู้จัก (รวม `__proto__`, `constructor`) ตอบ 404 ในคำตอบตามปกติ
- `PROPPATCH` ตั้งเวลาแก้ไขล่าสุดได้ (`getlastmodified`, `lastmodified` ของ rclone/ownCloud, `Win32LastModifiedTime`) รับแต่ไม่เก็บค่า `Win32*` อื่น ๆ และปฏิเสธ property อื่นทั้งหมด (ไม่มี dead properties)
- `PUT` รองรับ `If-Match` / `If-None-Match` และ `X-OC-Mtime` ไฟล์ถูกเขียนลงโฟลเดอร์ชั่วคราวแล้วย้ายเข้าที่ในครั้งเดียว ใช้ได้ทั้งแบบมีและไม่มี `Content-Length` และใช้หน่วยความจำคงที่
- `LOCK`/`UNLOCK` แจก token (ไม่เกิน 1 ชั่วโมง) เก็บในหน่วยความจำ ไม่บังคับ ผู้ใช้รหัสผ่านแอปสิทธิ์ `read` ได้ `DAV: 1` (ไม่มี LOCK)
- ผ่านชุดทดสอบ litmus `basic` 16/16 และ `copymove` 13/13 ส่วนชุด `locks` และ `props` ไม่ผ่านตามที่ออกแบบไว้ (ไม่บังคับ lock ไม่มี dead properties) ทดสอบกับ rclone 1.75 ผ่านทั้ง `vendor=other` และ `vendor=owncloud`
- `GET` ที่โฟลเดอร์ตอบ 405 (ใช้ `PROPFIND`)

### ภาพตัวอย่างและดูไฟล์ zip

**ภาพตัวอย่าง**

- `GET /api/thumb?space=&path=&size=256|1024` (ต้องมีสิทธิ์ `read`; `size` ไม่ใส่ = 256 · **`size=1024` ต้องมี `read` + `download`** ผู้ที่อ่านได้อย่างเดียวได้ 256 เท่านั้น 1024 → 403 · เปิดดูใน `space=user:<ชื่อ>` / grant / กลุ่ม บันทึก `browse` ในประวัติการใช้งาน (ไฟล์ละครั้งต่อนาที) เหมือนการเปิดดูโฟลเดอร์) ตอบ `image/webp` (PDF เป็น `image/jpeg`) ด้านยาวไม่เกิน `size` พิกเซล ไม่ขยายรูปเล็ก มี `ETag` (คีย์ของแคช) และ `Cache-Control: private, max-age=86400` ส่ง `If-None-Match` ได้ 304
- ลิงก์แชร์โฟลเดอร์: `GET /api/s/:token/thumb?path=&size=` ตรวจเหมือนดาวน์โหลดของลิงก์นั้น (รหัสผ่าน, ต้องอยู่ในโฟลเดอร์ที่แชร์, ไม่ตาม symlink) แต่ **ไม่นับเป็นการดาวน์โหลด** (ลิงก์ที่ใช้ครบจำนวนครั้งแล้ว หมดอายุ หรือถูกเพิกถอน ตอบ 404 `share.not-found` เหมือนเส้นทางอื่น ลิงก์ดาวน์โหลดทุกอันขอ 1024 ได้)
- ตอบ 404 `thumb.unavailable` เมื่อไม่มีเครื่องมือ, ชนิดไฟล์ไม่รองรับ, สร้างไม่ได้ (ไฟล์เสีย, หมดเวลา) หรือเพิ่งล้มเหลว (ไม่ลองซ้ำ 5 นาที) · 422 `thumb.too-big` ไฟล์รูปเกิน 500 MB หรือเกิน 100 ล้านพิกเซล (อ่านขนาดก่อนสร้าง) · 503 `thumb.busy` พร้อม `Retry-After: 3` เมื่อคิวสร้างเต็ม
- `GET /api/thumbs/status` (ต้องเข้าสู่ระบบ) → `{ "image": true, "pdf": true, "video": false }` หน้าเว็บใช้ตัดสินว่าจะขอภาพหรือแสดงไอคอน
- แคช: `DATA_DIR/thumbs/<sha1(พาธ|ขนาด|mtime|ขนาดไฟล์)>.webp` (PDF เป็น `.jpg`) ไฟล์ที่แก้ไขแล้วได้ภาพใหม่เอง ตัดให้ไม่เกิน `THUMB_CACHE_MAX_MB` ทุกชั่วโมง ลบอันที่ใช้ล่าสุดนานที่สุดก่อน (ทุกครั้งที่มีคนขอ ระบบ touch เวลาของไฟล์) ไม่อยู่ในไฟล์สำรอง ปิดทั้งหมดด้วย `THUMBNAILS=off`

**ดูรายการในไฟล์ zip โดยไม่แตกไฟล์**

- `GET /api/archive/list?space=&path=` (ต้องมี `read` + `download`) → `{ entries: [{ name, dir, size, compressed, modified, encrypted }], truncated }` อ่านเฉพาะสารบัญท้ายไฟล์ (central directory) ไม่แตกอะไรลงดิสก์ รองรับ ZIP64 และชื่อภาษาไทย (UTF-8) `name` คือพาธเต็มในไฟล์ zip (โฟลเดอร์ลงท้าย `/`) `modified` เป็น ms สูงสุด 10,000 รายการ เกินนั้น `truncated: true` ไม่ใช่ zip หรืออ่านไม่ได้ → 400 `archive.not-zip` (ดูจากเนื้อไฟล์ ไม่ใช่นามสกุล) **ไม่รองรับ .rar และ .7z** zip ที่สารบัญใหญ่เกิน 64 MB หรือมีเกิน 100,000 รายการ → 413 `archive.directory-too-big` โดยไม่เปิดไฟล์ · เปิดดูพร้อมกันได้ 4 งาน (ทั้งรายการและดึงรายการเดียว รวมลิงก์แชร์) งานที่เกิน → 503 `archive.busy` พร้อม `Retry-After: 3`
- `GET /api/archive/file?space=&path=&entry=&inline=1` (ต้องมี `read` + `download`) ส่งรายการเดียวแบบสตรีม (ไม่มี Range) `entry` ต้องตรงกับชื่อในสารบัญ ชื่อที่มี `..` ขึ้นต้นด้วย `/` มี `\` หรือ NUL → 400 `archive.bad-entry` · ไม่พบหรือเป็นโฟลเดอร์ → 404 `archive.entry-not-found` · เข้ารหัสด้วยรหัสผ่าน → 422 `archive.encrypted` · อ่านไม่ได้ (วิธีบีบอัดที่ไม่รองรับ) → 422 `archive.damaged` · ขนาดที่ประกาศเกิน `UPLOAD_MAX_SIZE` หรือ (เกิน 100 MB และบีบอัดเกิน 100:1) → 413 `archive.too-big` ก่อนแตก เปิดในแท็บ (`inline=1`) ได้เฉพาะรูป (ไม่รวม svg), PDF และ `.txt` ที่เหลือเป็น `attachment` เสมอ บันทึกในประวัติการใช้งานเป็น `download` (รายการละครั้งต่อนาที) และ `browse` เมื่อผู้ดูแลเปิดดูใน `space=user:<ชื่อ>`
- ลิงก์แชร์โฟลเดอร์ (ลิงก์ดาวน์โหลดเท่านั้น): `GET /api/s/:token/archive/list?path=` และ `GET /api/s/:token/archive/file?path=&entry=` ตรวจเหมือนดาวน์โหลดของลิงก์ (รหัสผ่าน, อยู่ในโฟลเดอร์ที่แชร์) การเอารายการออกจาก zip **นับเป็นการดาวน์โหลดของลิงก์หนึ่งครั้ง** ส่วนการดูรายการไม่นับ

### ONLYOFFICE

การตั้งค่าอยู่ที่ [ติดตั้ง: ONLYOFFICE](install.md#แก้ไขเอกสาร-office-ด้วย-onlyoffice) ส่วนนี้คือกลไก

หน้าเว็บขอ `POST /api/office/config` `{ space, path, mode: "edit" | "view" }` (ต้องเข้าสู่ระบบ ดูต้องมีสิทธิ์ `read` + `download` แก้ต้องมี `write` ด้วย ไฟล์ไม่เกิน `OFFICE_MAX_SIZE` ค่าเริ่มต้น 100 MB) ได้ `{ apiUrl, config }` ซึ่งเป็น config ของ ONLYOFFICE ที่เซ็นด้วย `OFFICE_JWT_SECRET` (`config.token`) แล้ว document server ติดต่อ File Center เอง ไม่ใช้ cookie ของผู้ใช้: ดาวน์โหลดไฟล์จาก `GET /api/office/file/:token` และส่งไฟล์ที่บันทึกกลับมาทาง `POST /api/office/callback/:token` `GET /api/session` บอกผู้ที่เข้าสู่ระบบใน `config.office: { enabled, edit: [...], view: [...] }` ว่าเปิดไฟล์นามสกุลไหนได้

- **บันทึก:** เมื่อทุกคนปิดเอกสาร (หรือกดบันทึกแบบ force save) document server ส่งไฟล์ใหม่มา ระบบเก็บ **ฉบับเดิมเป็นเวอร์ชันของไฟล์ก่อน** (กู้คืนได้ที่ `/api/versions`; ถ้าปิดเวอร์ชันด้วย `VERSIONS_KEEP=0` จะย้ายไปถังขยะแทน) แล้ววางไฟล์ใหม่แทนที่ในครั้งเดียว (ไม่มีช่วงที่ไฟล์เขียนไม่ครบ) บันทึก `office-save` ในประวัติการใช้งาน และ `office-open` ทุกครั้งที่เปิด
- **โทเคนของลิงก์:** เซ็นด้วย `office-links.key` ใน `DATA_DIR` ระบุไฟล์ ผู้ใช้ โหมด และหมดอายุใน 24 ชั่วโมง ดู [ความปลอดภัย](security.md#onlyoffice)

### อัปเดตระบบ

เฉพาะ admin เส้นทางอยู่ใต้ `/api/admin/update`

| | |
|---|---|
| `GET /api/admin/update` | สถานะ: เวอร์ชันที่รัน ที่มา `source: { enabled, url }` `history` (2 เวอร์ชันล่าสุดที่ย้อนกลับได้) `last.message` ตามภาษาของคำขอ และ `uploadsInProgress` |
| `GET /api/admin/update/check` | ถาม `latest.json` (และ `latest-beta.json`) ของ `UPDATE_SOURCE` → `{ enabled, current, latest: { version, notes, size, signed, builtAt } \| null, newer, refused, beta: { version, notes, size, signed, builtAt } \| null }` (`beta` มีเมื่อใหม่กว่าทั้งที่ใช้อยู่และรุ่นปกติล่าสุดเท่านั้น และเป็น `null` เมื่อไม่มี `latest-beta.json`) เบตาที่ `signed: false` ถูกปฏิเสธเมื่อ `signatureRequired` |
| `POST /api/admin/update/fetch` | รับ body ไม่บังคับ `{ channel?: "stable" \| "beta", acceptBetaRisk?: boolean }` ดาวน์โหลดแพ็กเกจแล้วตรวจแบบเดียวกับ `/stage` (ตอบเหมือนกัน) ติดตั้งต่อด้วย `/apply` |
| `POST /api/admin/update/upload { size }` → `PUT /api/upload/:id/:n` → `POST /api/admin/update/stage { id }` | ประกาศแพ็กเกจ (ไม่เกิน `UPDATE_MAX_SIZE`) ส่งเป็นชิ้น แล้วตรวจ (ยังไม่รันโค้ดของแพ็กเกจ) `DELETE /api/admin/update/staged/:id` ทิ้งแพ็กเกจที่ตรวจแล้ว |
| `POST /api/admin/update/apply` | `{ id, password }` ติดตั้งแพ็กเกจที่ตรวจแล้ว ลองเปิดเวอร์ชันใหม่แยกต่างหากก่อน แล้วรีสตาร์ต |
| `POST /api/admin/update/fetch-and-apply` | `{ password, channel?, acceptBetaRisk? }` ตรวจรหัสผ่านก่อน (ล็อกเมื่อผิดซ้ำเหมือน `/apply` และยังไม่ดาวน์โหลดอะไร) แล้วทำ `/check` → `/fetch` → `/apply` ต่อกันโดยไม่ข้ามการตรวจใด ๆ: ต้องใหม่กว่าที่ใช้อยู่, SHA-256 และขนาดตรง `latest.json`, ตรวจไฟล์ในแพ็กเกจแบบเดียวกับที่อัปโหลด, ลายเซ็น, ลองเปิดเวอร์ชันใหม่แยกต่างหาก แล้วจึงรีสตาร์ต ตอบ `{ ok, version, restarting }` ถ้าขั้นใดล้มเหลว คำตอบบอกขั้นนั้นใน `params.step` (`check` / `fetch` / `stage` / `apply`) และไม่มีแพ็กเกจค้างอยู่ ประวัติการใช้งานบันทึก `update-fetch` และ `update-apply` เหมือนทำทีละขั้น |
| `POST /api/admin/update/rollback` | `{ dir, password }` ย้อนกลับไปเวอร์ชันใน `history` หรือ `dir: "builtin"` สำหรับเวอร์ชันที่มากับอิมเมจ |

เบตา: `channel: "beta"` ต้องส่ง `acceptBetaRisk: true` ด้วย ไม่งั้นตอบ 400 `update.beta-not-accepted` (ตรวจก่อนถามรหัสผ่านและก่อนดาวน์โหลด) ที่เหลือเหมือนรุ่นปกติทุกอย่าง ประวัติการใช้งานบันทึก `update-apply-beta` เพิ่มเมื่อติดตั้งเบตา `GET /api/admin/status` มีคำเตือน `update.on-beta` ขณะใช้เบตา และ `update.available` เมื่อการตรวจรายวันพบรุ่นปกติใหม่

ประวัติการใช้งานของการอัปเดต: `update-stage`, `update-apply`, `update-apply-unsigned`, `update-apply-beta`, `update-rollback`, `update-fetch`, `update-denied` (รหัสผ่านผิด)

### สำรองข้อมูล

เฉพาะ admin ดูรายละเอียดการทำงานที่ [คู่มือผู้ดูแล: สำรองและกู้คืนข้อมูล](admin-guide.md#สำรองและกู้คืนข้อมูล)

| | |
|---|---|
| `GET /api/admin/backups` | `{ items, status, settings }`: `items` คือไฟล์สำรอง `{ name, size, createdAt, parts }` (`parts: null` = ไฟล์สำรองก่อน 1.10) `status` คือผลล่าสุด `settings` คือการตั้งค่าที่ใช้อยู่ |
| `PUT /api/admin/backups/settings` | ส่งเฉพาะที่เปลี่ยน (ไม่ส่ง = คงเดิม `null` = กลับเป็นค่าเริ่มต้น) ตอบการตั้งค่าที่ใช้อยู่ บันทึก `backup-settings` ในประวัติการใช้งาน: `compression` (`fast` / `balanced` / `smallest`) · `schedule` (`{ "mode": "off" }` · `{ "mode": "daily", "time": "03:00" }` · `{ "mode": "weekly", "days": [1, 4], "time": "03:00" }` โดย 0=อาทิตย์ ... 6=เสาร์ · `{ "mode": "interval", "hours": 12 }` 1–168) · `keep` (1–30) · `includeFiles` (เปิดต้องส่ง `password`) |
| `GET /api/admin/backups/estimate` | `{ estimate, free, needed, ok, parts: { data, logs, storage } }` แต่ละส่วน (`parts.data`, `parts.logs`, `parts.storage`) บอก `files`, `size` ก่อนบีบ และ `compressed` หลังบีบ `backup.json` ในไฟล์สำรองมีรูปแบบเดียวกัน (`{ version, createdAt, includesFiles, parts }`) |
| `POST /api/admin/backups` | สำรองทันที |
| `POST /api/admin/backups/restore` | `{ name, password }` ตอบมี `twoFactorLost` (ชื่อผู้ใช้) และ `warning` (`backup.restore-2fa-lost`) เมื่อ `secret.key` ของเครื่องนี้เปิดความลับ 2FA ในไฟล์สำรองไม่ได้ |

ผลการสำรองล่าสุดเก็บใน `DATA_DIR/backup-status.json`

```json
{ "status": "ok", "lastSuccess": "2026-10-08T20:00:00.000Z", "lastAttempt": "2026-10-08T20:00:00.000Z", "message": "สำรองข้อมูลสำเร็จ", "file": "file-center-backup-20261009-030000.zip", "size": 48213 }
```

`status` เป็น `"ok"` หรือ `"failed"` เมื่อล้มเหลว `lastSuccess` ยังเป็นเวลาที่สำเร็จครั้งล่าสุด (ไฟล์จริงมี `code`/`params` ด้วย เพื่อให้หน้าเว็บแสดงเป็นภาษาของผู้อ่าน)

### ไฟล์ข้อมูลที่เสียหาย และการหยุดระบบ

กลไก (1.12.1) อธิบายที่ [ติดตั้ง](install.md#ข้อมูลอยู่ที่ไหน-และถ้าไฟล์ข้อมูลเสีย) ในโค้ดคือ `src/store.ts` (`JsonStore`: เขียนไฟล์ชั่วคราว → `fsync` → เปลี่ยนชื่อ, `updateSoon` รวมการเขียนเป็นหนึ่งครั้งต่อวินาที, `flushAll` ตอนหยุดระบบ, `.broken-<เวลา>` เมื่ออ่าน JSON ไม่ได้)
