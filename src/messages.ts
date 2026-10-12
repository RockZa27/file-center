/**
 * Every message the server shows a visitor, by stable code, in Thai and English. An error carries the code and its
 * params; the text is chosen when the answer is written, in the language of that request (`langOf`).
 * Logs and the audit trail keep the Thai text: they are read by the admin, not shown in a visitor's language.
 * `{name}` in a text is replaced by `params.name`; both languages must use the same placeholders (tests check it).
 */
export const MESSAGES = {
  // codes the web page already checks: keep them as they are
  csrf: { th: 'โทเคนความปลอดภัยไม่ถูกต้อง กรุณารีเฟรชหน้าเว็บ', en: 'The security token is invalid. Please reload the page.' },
  'must-change-password': { th: 'กรุณาเปลี่ยนรหัสผ่านก่อนใช้งาน', en: 'Please change your password before continuing.' },
  'disk-full': { th: 'พื้นที่จัดเก็บบนเซิร์ฟเวอร์ไม่พอ กรุณาติดต่อผู้ดูแลระบบ', en: 'There is not enough storage space on the server. Please contact the administrator.' },
  'not-supervised': {
    th: 'ระบบนี้ไม่ได้เริ่มผ่านตัวควบคุม (launcher) จึงรีสตาร์ตเองไม่ได้ ให้เริ่มด้วย "bun start" หรือ Docker',
    en: 'This server was not started by the launcher, so it cannot restart itself. Start it with "bun start" or Docker.',
  },
  // dashboard warning: the page links it to the error log
  errors: { th: 'มี error {count} รายการใน 24 ชั่วโมงที่ผ่านมา', en: '{count} errors in the last 24 hours' },

  // ───────────── request ─────────────
  'request.invalid': { th: 'ข้อมูลที่ส่งมาไม่ถูกต้อง', en: 'The data sent is not valid.' },
  'request.unreadable': { th: 'อ่านข้อมูลที่ส่งมาไม่ได้', en: 'The data sent could not be read.' },
  'request.no-route': { th: 'ไม่พบหน้าที่ต้องการ', en: 'Page not found.' },
  'request.no-api': { th: 'ไม่พบ API ที่เรียก', en: 'API not found.' },
  'request.not-found': { th: 'ไม่พบรายการที่ระบุ', en: 'The item was not found.' },
  'request.internal': { th: 'เกิดข้อผิดพลาดภายในระบบ', en: 'Something went wrong on the server.' },
  // the link on the page a failed download link opens in the tab
  'request.back-to-app': { th: 'กลับไปหน้าหลัก', en: 'Back to the home page' },

  // ───────────── auth ─────────────
  'auth.required': { th: 'กรุณาเข้าสู่ระบบ', en: 'Please sign in.' },
  'auth.forbidden': { th: 'ไม่มีสิทธิ์ทำรายการนี้', en: 'You do not have permission to do this.' },
  'auth.locked': { th: 'พยายามเข้าสู่ระบบผิดหลายครั้ง กรุณารอ {seconds} วินาทีแล้วลองใหม่', en: 'Too many failed sign-ins. Wait {seconds} seconds and try again.' },
  'auth.bad-credentials': { th: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', en: 'Wrong username or password.' },
  'auth.wrong-current-password': { th: 'รหัสผ่านปัจจุบันไม่ถูกต้อง', en: 'Your current password is wrong.' },
  'auth.confirm-locked': { th: 'ใส่รหัสผ่านผิดหลายครั้ง กรุณารอ {seconds} วินาทีแล้วลองใหม่', en: 'Too many wrong passwords. Wait {seconds} seconds and try again.' },
  'auth.wrong-password': { th: 'รหัสผ่านไม่ถูกต้อง', en: 'Wrong password.' },
  'auth.password-too-short': { th: 'รหัสผ่านต้องยาวอย่างน้อย {min} ตัวอักษร', en: 'The password must be at least {min} characters long.' },
  'auth.password-too-long': { th: 'รหัสผ่านยาวเกินไป', en: 'The password is too long.' },
  'auth.password-has-username': { th: 'รหัสผ่านต้องไม่มีชื่อผู้ใช้อยู่ในนั้น', en: 'The password must not contain the username.' },
  'auth.password-common': { th: 'รหัสผ่านนี้ถูกใช้บ่อยเกินไปและเดาได้ง่าย กรุณาตั้งรหัสอื่น', en: 'This password is too common and easy to guess. Please choose another one.' },
  'auth.password-pattern': {
    th: 'รหัสผ่านต้องไม่เป็นตัวอักษรเดียวซ้ำกัน หรือเรียงตามแป้นพิมพ์/ตัวเลข/ตัวอักษร กรุณาตั้งรหัสอื่น',
    en: 'The password must not be one repeated character or a keyboard, number or letter sequence. Please choose another one.',
  },

  // devices and two-factor sign-in
  'auth.session-not-found': { th: 'ไม่พบอุปกรณ์ที่ระบุ', en: 'The device was not found.' },
  'auth.two-factor-bad-code': { th: 'รหัสยืนยันไม่ถูกต้อง', en: 'The verification code is wrong.' },
  'auth.two-factor-bad-ticket': { th: 'หมดเวลาหรือขั้นตอนเข้าสู่ระบบไม่ถูกต้อง กรุณาใส่รหัสผ่านใหม่', en: 'The sign-in step expired or is not valid. Please enter your password again.' },
  'auth.two-factor-locked': { th: 'ใส่รหัสยืนยันผิดหลายครั้ง กรุณารอ {seconds} วินาทีแล้วลองใหม่', en: 'Too many wrong verification codes. Wait {seconds} seconds and try again.' },
  'auth.two-factor-already-enabled': { th: 'เปิดการยืนยันสองขั้นตอนไว้แล้ว', en: 'Two-factor sign-in is already on.' },
  'auth.two-factor-not-enabled': { th: 'ยังไม่ได้เปิดการยืนยันสองขั้นตอน', en: 'Two-factor sign-in is not on.' },
  'auth.two-factor-no-setup': { th: 'ยังไม่ได้เริ่มตั้งค่า หรือหมดเวลาแล้ว กรุณาเริ่มตั้งค่าใหม่', en: 'Setup was not started or has expired. Please start again.' },

  // ───────────── fs: what a file-system error means for the visitor ─────────────
  'fs.bad-name': { th: 'ชื่อไม่ถูกต้อง', en: 'The name is not valid.' },
  'fs.name-too-long': { th: 'ชื่อยาวเกินไป (ภาษาไทยได้ประมาณ 85 ตัวอักษร ภาษาอังกฤษ 255 ตัวอักษร)', en: 'The name is too long (about 85 Thai or 255 English characters).' },
  'fs.name-bad-chars': { th: 'ชื่อห้ามมีอักขระ \\ / : * ? " < > |', en: 'A name may not contain \\ / : * ? " < > |' },
  'fs.bad-path': { th: 'พาธไม่ถูกต้อง', en: 'The path is not valid.' },
  'fs.no-free-name': { th: 'ไม่สามารถตั้งชื่อใหม่ได้', en: 'Could not find a free name.' },
  'fs.not-found': { th: 'ไม่พบรายการที่ระบุ', en: 'The item was not found.' },
  'fs.not-a-folder': { th: 'ไม่พบโฟลเดอร์นี้', en: 'The folder was not found.' },
  'fs.is-a-folder': { th: 'รายการนี้เป็นโฟลเดอร์', en: 'This item is a folder.' },
  'fs.exists': { th: 'มีชื่อนี้อยู่แล้ว', en: 'This name is already taken.' },
  'fs.path-too-long': { th: 'ชื่อหรือพาธยาวเกินไป', en: 'The name or path is too long.' },
  'fs.no-access': { th: 'เซิร์ฟเวอร์ไม่มีสิทธิ์เข้าถึงรายการนี้', en: 'The server has no access to this item.' },
  'fs.read-only': { th: 'พื้นที่จัดเก็บเป็นแบบอ่านอย่างเดียว', en: 'The storage is read-only.' },
  'fs.busy': { th: 'รายการนี้กำลังถูกใช้งานอยู่', en: 'This item is in use.' },

  // ───────────── files ─────────────
  'files.system-folder': { th: 'โฟลเดอร์ระบบ ลบ ย้าย หรือเปลี่ยนชื่อไม่ได้', en: 'System folders cannot be deleted, moved or renamed.' },
  'files.bad-count': { th: 'จำนวนรายการไม่ถูกต้อง', en: 'The number of items is not valid.' },
  'files.root-item': { th: 'ไม่สามารถทำรายการกับโฟลเดอร์หลักได้', en: 'This cannot be done to the top folder.' },
  'files.folder-not-found': { th: 'ไม่พบโฟลเดอร์นี้', en: 'The folder was not found.' },
  'files.not-a-folder': { th: 'พาธนี้ไม่ใช่โฟลเดอร์', en: 'This path is not a folder.' },
  'files.name-taken': { th: 'มีชื่อนี้อยู่แล้ว', en: 'This name is already taken.' },
  'files.too-big-to-open': { th: 'ไฟล์ใหญ่เกินกว่าจะเปิดในหน้าเว็บ', en: 'The file is too big to open in the browser.' },
  'files.text-too-big': { th: 'ข้อความใหญ่เกินกำหนด', en: 'The text is too big.' },
  // saving a text over a version someone else saved after it was opened
  'files.changed-elsewhere': {
    th: 'ไฟล์นี้ถูกแก้ไขจากที่อื่นหลังจากที่คุณเปิด จึงยังไม่บันทึก กรุณาเปิดไฟล์ใหม่แล้วแก้อีกครั้ง (คัดลอกข้อความของคุณเก็บไว้ก่อน)',
    en: 'This file was changed elsewhere after you opened it, so it was not saved. Open it again and redo your changes (copy your text first).',
  },
  'files.rename-root': { th: 'ไม่สามารถเปลี่ยนชื่อโฟลเดอร์หลักได้', en: 'The top folder cannot be renamed.' },
  'files.item-missing': { th: 'ไม่พบ {name}', en: '{name} was not found.' },
  'files.link-expired': { th: 'ลิงก์ดาวน์โหลดหมดอายุแล้ว', en: 'The download link has expired.' },
  'files.download-forbidden': { th: 'ไม่มีสิทธิ์ดาวน์โหลด', en: 'You do not have permission to download this.' },
  'files.dest-not-found': { th: 'ไม่พบโฟลเดอร์ปลายทาง', en: 'The destination folder was not found.' },
  'files.same-folder': { th: 'ปลายทางเป็นโฟลเดอร์เดียวกัน', en: 'The destination is the same folder.' },
  'files.move-into-self': { th: 'ไม่สามารถย้ายโฟลเดอร์เข้าไปในตัวมันเองได้', en: 'A folder cannot be moved into itself.' },
  'files.copy-into-self': { th: 'ไม่สามารถคัดลอกโฟลเดอร์เข้าไปในตัวมันเองได้', en: 'A folder cannot be copied into itself.' },
  'files.dest-name-taken': { th: 'มีชื่อเดียวกันอยู่ในปลายทางแล้ว', en: 'An item with the same name is already in the destination.' },
  'files.delete-failed': { th: 'ลบไม่สำเร็จ', en: 'Could not delete.' },
  'files.transfer-failed': { th: 'ทำรายการไม่สำเร็จ', en: 'Could not complete the action.' },

  // ───────────── upload ─────────────
  'upload.not-found': { th: 'ไม่พบการอัปโหลดนี้', en: 'This upload was not found.' },
  'upload.guest-disabled': { th: 'ผู้เยี่ยมชมอัปโหลดไฟล์ไม่ได้ กรุณาเข้าสู่ระบบก่อน', en: 'Visitors cannot upload files. Please sign in first.' },
  'upload.guest-quota': { th: 'ผู้เยี่ยมชมอัปโหลดครบปริมาณของวันนี้แล้ว กรุณาลองใหม่พรุ่งนี้หรือเข้าสู่ระบบ', en: 'Visitors have used up today\'s upload allowance. Try again tomorrow or sign in.' },
  'upload.bad-size': { th: 'ขนาดไฟล์ไม่ถูกต้อง', en: 'The file size is not valid.' },
  'upload.too-big': { th: 'ไฟล์ใหญ่เกินกำหนด', en: 'The file is too big.' },
  'upload.bad-chunk-index': { th: 'ลำดับชิ้นส่วนไม่ถูกต้อง', en: 'The chunk number is not valid.' },
  'upload.bad-chunk-size': { th: 'ขนาดชิ้นส่วนไม่ถูกต้อง (ต้องเป็น {bytes} ไบต์)', en: 'The chunk size is wrong (it must be {bytes} bytes).' },
  'upload.missing-chunk': { th: 'ยังขาดชิ้นส่วนที่ {n}', en: 'Chunk {n} is still missing.' },
  'upload.size-mismatch': { th: 'ขนาดไฟล์หลังรวมไม่ตรงกับที่แจ้งไว้', en: 'The assembled file does not have the announced size.' },
  'upload.too-deep': { th: 'โฟลเดอร์ซ้อนลึกเกินไป', en: 'The folders are nested too deeply.' },

  // ───────────── zip ─────────────
  'zip.too-big': { th: 'ไฟล์ที่แตกออกมามีขนาดใหญ่เกินกำหนด หรือพื้นที่จัดเก็บไม่พอ', en: 'The extracted files are too big, or there is not enough storage space.' },
  'zip.unsafe-path': { th: 'ไฟล์ zip มีพาธที่ไม่ปลอดภัย', en: 'The zip file contains an unsafe path.' },
  'zip.too-many-files': { th: 'ไฟล์ zip มีไฟล์มากกว่า {max} ไฟล์', en: 'The zip file contains more than {max} files.' },
  'zip.not-zip': { th: 'ต้องเป็นไฟล์ .zip', en: 'This must be a .zip file.' },
  'zip.extract-failed': { th: 'แตกไฟล์ไม่สำเร็จ ไฟล์ zip อาจเสียหายหรือไม่รองรับ', en: 'Could not extract. The zip file may be damaged or not supported.' },

  // ───────────── admin ─────────────
  'admin.bad-username': { th: 'ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 . _ - ยาว 3-32 ตัว', en: 'A username may only use a-z 0-9 . _ - and be 3-32 characters long.' },
  'admin.reserved-username': { th: 'ชื่อผู้ใช้นี้สงวนไว้สำหรับผู้เยี่ยมชม กรุณาใช้ชื่ออื่น', en: 'This username is reserved for visitors. Please choose another one.' },
  'admin.username-taken': { th: 'มีชื่อผู้ใช้นี้อยู่แล้ว', en: 'This username is already taken.' },
  'admin.display-name-required': { th: 'กรุณากรอกชื่อที่แสดง (ไม่เกิน 60 ตัวอักษร)', en: 'Please enter a display name (up to 60 characters).' },
  'admin.bad-display-name': { th: 'ชื่อที่แสดงไม่ถูกต้อง', en: 'The display name is not valid.' },
  'admin.home-required': { th: 'ผู้ใช้ทั่วไปต้องมีโฟลเดอร์ของตัวเอง', en: 'A regular user needs a folder of their own.' },
  'admin.home-in-public': { th: 'โฟลเดอร์ของผู้ใช้ต้องไม่อยู่ในโฟลเดอร์สาธารณะ', en: 'A user\'s folder must not be inside the public folder.' },
  'admin.user-not-found': { th: 'ไม่พบผู้ใช้', en: 'The user was not found.' },
  'admin.last-admin': { th: 'ต้องมีผู้ดูแลระบบอย่างน้อยหนึ่งคน', en: 'There must be at least one administrator.' },
  'admin.delete-self': { th: 'ไม่สามารถลบบัญชีของตัวเองได้', en: 'You cannot delete your own account.' },
  'admin.text-length': { th: 'ข้อความสั้นหรือยาวเกินไป', en: 'A text is too short or too long.' },
  'admin.bad-color': { th: 'รหัสสีต้องอยู่ในรูปแบบ #RRGGBB', en: 'The color must look like #RRGGBB.' },
  'admin.logo-type': { th: 'รองรับเฉพาะ PNG, JPG, WebP หรือ SVG', en: 'Only PNG, JPG, WebP or SVG is supported.' },
  'admin.logo-size': { th: 'ไฟล์โลโก้ต้องไม่เกิน 1 MB', en: 'The logo file must not be larger than 1 MB.' },
  'admin.trash-name-taken': { th: 'มีรายการชื่อเดียวกันอยู่แล้ว', en: 'An item with the same name already exists.' },
  // dashboard warnings
  'admin.disk-critical': { th: 'พื้นที่ดิสก์เหลือเพียง {percent}%', en: 'Only {percent}% of the disk is free.' },
  'admin.disk-low': { th: 'พื้นที่ดิสก์เหลือน้อย ({percent}%)', en: 'Disk space is running low ({percent}% free).' },
  'admin.default-password': { th: 'ยังมีบัญชีที่ใช้รหัสผ่านเริ่มต้น กรุณาเปลี่ยนรหัสผ่าน', en: 'Some accounts still use their initial password. Please change it.' },
  // alerts sent to ALERT_WEBHOOK_URL (alerts.ts), in ALERT_LANG
  'admin.alert-test': { th: 'ทดสอบการแจ้งเตือน: ระบบส่งข้อความถึงช่องทางนี้ได้', en: 'Test alert: messages reach this channel.' },
  'admin.alert-errors': { th: 'มี error {count} รายการในชั่วโมงที่ผ่านมา (เกิน {max} รายการ) ดูได้ที่หน้า log ของระบบ', en: '{count} errors in the last hour (more than {max}). See the system log page.' },
  'admin.alert-login-locked': {
    th: 'ล็อกการเข้าสู่ระบบของ {user} จาก IP {ip} ชั่วคราว เพราะใส่รหัสผ่านผิดหลายครั้ง',
    en: 'Sign-in for {user} from IP {ip} is locked for a while after too many wrong passwords.',
  },
  'admin.alert-confirm-locked': {
    th: 'ล็อกการยืนยันรหัสผ่าน (ติดตั้งอัปเดต/กู้คืนข้อมูล) ของ {user} จาก IP {ip} ชั่วคราว เพราะใส่รหัสผ่านผิดหลายครั้ง',
    en: 'Password confirmation (update/restore) for {user} from IP {ip} is locked for a while after too many wrong passwords.',
  },
  'admin.alert-2fa-locked': {
    th: 'ล็อกการยืนยันสองขั้นตอนของ {user} จาก IP {ip} ชั่วคราว เพราะใส่รหัสยืนยันผิดหลายครั้ง',
    en: 'Two-factor sign-in for {user} from IP {ip} is locked for a while after too many wrong codes.',
  },
  'admin.alert-share-locked': {
    th: 'ล็อกลิงก์แชร์ {share} ของ {owner} สำหรับ IP {ip} ชั่วคราว เพราะใส่รหัสผ่านผิดหลายครั้ง',
    en: 'Share link {share} of {owner} is locked for IP {ip} for a while after too many wrong passwords.',
  },
  'admin.alert-off': {
    th: 'ยังไม่ได้ตั้งการแจ้งเตือน หรือค่าไม่ถูกต้อง (ALERT_WEBHOOK_URL, ALERT_WEBHOOK_KIND, ALERT_TELEGRAM_CHAT_ID) ดูคำเตือนใน log ตอนเริ่มระบบ',
    en: 'Alerts are not set up, or a setting is wrong (ALERT_WEBHOOK_URL, ALERT_WEBHOOK_KIND, ALERT_TELEGRAM_CHAT_ID). See the warning in the log at startup.',
  },
  'admin.alert-timeout': { th: 'ปลายทางการแจ้งเตือนไม่ตอบใน {seconds} วินาที', en: 'The alert destination did not answer within {seconds} seconds.' },
  'admin.alert-status': { th: 'ปลายทางการแจ้งเตือนตอบกลับ HTTP {status}', en: 'The alert destination answered HTTP {status}.' },
  'admin.alert-unreachable': { th: 'ติดต่อปลายทางการแจ้งเตือนไม่ได้', en: 'The alert destination could not be reached.' },
  // standard texts of the public page, used while the admin leaves the setting empty
  'admin.default-welcome-title': { th: 'ศูนย์รวมไฟล์', en: 'File Center' },
  'admin.default-welcome-text': {
    th: 'ดาวน์โหลดไฟล์ที่เผยแพร่ได้จากที่นี่ หากต้องการอัปโหลดหรือจัดการไฟล์ กรุณาเข้าสู่ระบบ',
    en: 'Download the published files here. To upload or manage files, please sign in.',
  },
  'admin.default-public-empty': { th: 'ยังไม่มีไฟล์เผยแพร่ในขณะนี้', en: 'No files have been published yet.' },

  // ───────────── share links ─────────────
  // one answer for every link that does not work (unknown, expired, revoked, used up, item or owner gone): a guesser learns nothing
  'share.not-found': { th: 'ไม่พบลิงก์นี้ หรือลิงก์หมดอายุแล้ว', en: 'Link not found or expired.' },
  'share.bad-days': { th: 'อายุของลิงก์เลือกได้ {days} วัน', en: 'A link can last {days} days.' },
  'share.bad-max-downloads': { th: 'จำนวนครั้งที่ดาวน์โหลดได้ต้องเป็นจำนวนเต็ม 1 ถึง {max}', en: 'The download limit must be a whole number from 1 to {max}.' },
  'share.password-too-short': { th: 'รหัสผ่านของลิงก์ต้องยาวอย่างน้อย {min} ตัวอักษร', en: 'The link password must be at least {min} characters long.' },
  'share.password-required': { th: 'ลิงก์นี้ต้องใส่รหัสผ่านก่อน', en: 'This link needs a password.' },
  'share.too-many': { th: 'มีลิงก์แชร์ครบ {max} ลิงก์แล้ว กรุณายกเลิกลิงก์เก่าก่อน', en: 'You already have {max} share links. Please revoke an old one first.' },

  // ───────────── office documents (ONLYOFFICE) ─────────────
  'office.disabled': { th: 'ยังไม่ได้เปิดใช้การแก้ไขเอกสาร office บนเซิร์ฟเวอร์นี้', en: 'Office document editing is not enabled on this server.' },
  'office.bad-type': { th: 'เปิดไฟล์ชนิดนี้ในโปรแกรมแก้ไขเอกสารไม่ได้', en: 'This type of file cannot be opened in the document editor.' },
  'office.too-big': { th: 'ไฟล์ใหญ่เกิน {mb} MB จึงเปิดในโปรแกรมแก้ไขเอกสารไม่ได้', en: 'The file is larger than {mb} MB, so it cannot be opened in the document editor.' },
  'office.bad-token': { th: 'ลิงก์ของเอกสารไม่ถูกต้องหรือหมดอายุแล้ว', en: 'The document link is not valid or has expired.' },
  'office.bad-jwt': { th: 'ลายเซ็นของ document server ไม่ถูกต้อง', en: 'The document server signature is not valid.' },
  'office.bad-url': { th: 'ที่อยู่ของไฟล์ที่บันทึกไม่ได้มาจาก document server', en: 'The saved file does not come from the document server.' },

  // ───────────── backup ─────────────
  'backup.bad-name': { th: 'ชื่อไฟล์สำรองข้อมูลไม่ถูกต้อง', en: 'The backup file name is not valid.' },
  'backup.not-found': { th: 'ไม่พบไฟล์สำรองข้อมูลนี้', en: 'This backup file was not found.' },
  'backup.busy': { th: 'กำลังสำรองหรือกู้คืนข้อมูลอยู่ กรุณารอให้เสร็จก่อน', en: 'A backup or restore is running. Please wait for it to finish.' },
  'backup.too-big': { th: 'ไฟล์สำรองข้อมูลนี้ใหญ่ผิดปกติ ยกเลิกการกู้คืน', en: 'This backup file is unusually large. The restore was cancelled.' },
  'backup.unreadable': { th: 'อ่านไฟล์สำรองข้อมูลไม่ได้ (ไฟล์เสียหาย)', en: 'The backup file could not be read (it is damaged).' },
  'backup.no-admin': { th: 'ไฟล์สำรองนี้ไม่มีข้อมูลผู้ใช้ที่ถูกต้อง หรือไม่มีผู้ดูแลระบบ จึงไม่กู้คืน', en: 'This backup has no valid users or no administrator, so it was not restored.' },
  'backup.bad-settings': { th: 'ไฟล์ตั้งค่าในไฟล์สำรองเสียหาย จึงไม่กู้คืน', en: 'The settings in this backup are damaged, so it was not restored.' },
  // the outcome of the last backup (backup-status.json)
  'backup.done': { th: 'สำรองข้อมูลสำเร็จ', en: 'The backup was made.' },
  'backup.failed': { th: 'สำรองข้อมูลไม่สำเร็จ: {reason}', en: 'The backup failed: {reason}' },
  // dashboard warnings
  'backup.never': { th: 'ยังไม่มีบันทึกการสำรองข้อมูล', en: 'No backup has been recorded yet.' },
  'backup.last-failed': { th: 'การสำรองข้อมูลครั้งล่าสุดล้มเหลว', en: 'The last backup failed.' },
  'backup.stale': { th: 'ไม่ได้สำรองข้อมูลมากกว่า {days} วันแล้ว', en: 'No backup for more than {days} days.' },

  // ───────────── logs ─────────────
  'logs.bad-level': { th: 'ระดับของ log ต้องเป็น info, warn หรือ error', en: 'The log level must be info, warn or error.' },
  'logs.csv-only': { th: 'ส่งออกได้เฉพาะรูปแบบ CSV (format=csv)', en: 'Only CSV export is supported (format=csv).' },

  // ───────────── update ─────────────
  'update.disabled': { th: 'ปิดการอัปเดตผ่านหน้าเว็บอยู่ (WEB_UPDATE=false)', en: 'Updating from the web page is turned off (WEB_UPDATE=false).' },
  'update.too-big': { th: 'ไฟล์แพ็กเกจใหญ่เกินกำหนด', en: 'The package file is too big.' },
  'update.busy': { th: 'กำลังมีการอัปเดตอีกรายการหนึ่งอยู่ กรุณารอสักครู่', en: 'Another update is in progress. Please wait a moment.' },
  'update.key-wrong-type': {
    th: 'ค่า UPDATE_PUBLIC_KEY ไม่ถูกต้อง (ต้องเป็นกุญแจ Ed25519 (ได้ {type})) ระบบจึงไม่รับแพ็กเกจใด ๆ จนกว่าจะแก้ค่านี้แล้วรีสตาร์ตระบบ',
    en: 'UPDATE_PUBLIC_KEY is not valid (it must be an Ed25519 key, got {type}), so no package is accepted until it is fixed and the server restarted.',
  },
  'update.key-unreadable': {
    th: 'ค่า UPDATE_PUBLIC_KEY ไม่ถูกต้อง (อ่านกุญแจไม่ได้ ต้องเป็น public key บรรทัดเดียวที่ได้จาก "bun run package --gen-key") ระบบจึงไม่รับแพ็กเกจใด ๆ จนกว่าจะแก้ค่านี้แล้วรีสตาร์ตระบบ',
    en: 'UPDATE_PUBLIC_KEY is not valid (it must be the one-line public key from "bun run package --gen-key"), so no package is accepted until it is fixed and the server restarted.',
  },
  'update.unsigned': {
    th: 'แพ็กเกจนี้ไม่มีลายเซ็น (manifest.sig) ระบบนี้รับเฉพาะแพ็กเกจที่เซ็นด้วยกุญแจของผู้ดูแล ให้สร้างด้วย "bun run package --sign <ไฟล์กุญแจ>"',
    en: 'This package has no signature (manifest.sig). This server only accepts packages signed with the administrator\'s key: build it with "bun run package --sign <key file>".',
  },
  'update.bad-signature': {
    th: 'ลายเซ็นของแพ็กเกจไม่ถูกต้อง: แพ็กเกจไม่ได้เซ็นด้วยกุญแจที่ตรงกับ UPDATE_PUBLIC_KEY หรือถูกแก้ไขหลังจากเซ็น',
    en: 'The package signature is wrong: it was not signed with the key matching UPDATE_PUBLIC_KEY, or it was changed after signing.',
  },
  'update.odd-file': { th: 'แพ็กเกจมีไฟล์ชนิดที่ไม่รองรับ: {file}', en: 'The package contains an unsupported kind of file: {file}' },
  'update.too-many-files': { th: 'แพ็กเกจมีไฟล์มากเกินไป', en: 'The package contains too many files.' },
  'update.no-manifest': {
    th: 'ไม่พบ manifest.json ในแพ็กเกจ หรืออ่านไม่ได้ (ต้องเป็นไฟล์ที่สร้างจาก "bun run package")',
    en: 'manifest.json is missing from the package or unreadable (the package must be built with "bun run package").',
  },
  'update.not-file-center': { th: 'แพ็กเกจนี้ไม่ใช่ของ File Center', en: 'This is not a File Center package.' },
  'update.bad-version': { th: 'เวอร์ชันในแพ็กเกจต้องอยู่ในรูปแบบ x.y.z', en: 'The package version must look like x.y.z.' },
  'update.bad-manifest': { th: 'manifest ของแพ็กเกจไม่ถูกต้อง', en: 'The package manifest is not valid.' },
  'update.missing-files': { th: 'แพ็กเกจต้องมี server.js และ web/index.html', en: 'The package must contain server.js and web/index.html.' },
  'update.files-mismatch': { th: 'ไฟล์ในแพ็กเกจไม่ตรงกับ manifest (มีไฟล์เกินหรือขาด)', en: 'The package files do not match the manifest (files are extra or missing).' },
  'update.bad-file-name': { th: 'ชื่อไฟล์ในแพ็กเกจไม่อนุญาต: {file}', en: 'File name not allowed in a package: {file}' },
  'update.file-corrupt': { th: 'ไฟล์ {file} ในแพ็กเกจเสียหายหรือไม่ตรงกับ manifest', en: 'The file {file} in the package is damaged or does not match the manifest.' },
  'update.page-failed': { th: 'เวอร์ชันใหม่เปิดหน้าเว็บไม่ได้', en: 'The new version could not serve the web page.' },
  'update.start-failed': { th: 'เวอร์ชันใหม่เริ่มทำงานไม่สำเร็จ', en: 'The new version failed to start.' },
  'update.start-failed-detail': { th: 'เวอร์ชันใหม่เริ่มทำงานไม่สำเร็จ: {detail}', en: 'The new version failed to start: {detail}' },
  'update.start-timeout': { th: 'เวอร์ชันใหม่เริ่มทำงานไม่สำเร็จ (ไม่ตอบสนองใน {seconds} วินาที)', en: 'The new version failed to start (no answer within {seconds} seconds).' },
  'update.start-timeout-detail': {
    th: 'เวอร์ชันใหม่เริ่มทำงานไม่สำเร็จ (ไม่ตอบสนองใน {seconds} วินาที): {detail}',
    en: 'The new version failed to start (no answer within {seconds} seconds): {detail}',
  },
  'update.bad-zip': { th: 'เปิดไฟล์ zip ไม่ได้ ไฟล์อาจเสียหาย', en: 'The zip file could not be opened. It may be damaged.' },
  'update.not-newer': {
    th: 'แพ็กเกจเป็นเวอร์ชัน {version} ซึ่งไม่ใหม่กว่าเวอร์ชันที่ใช้อยู่ ({running}) ต้องเพิ่มเลขเวอร์ชันก่อนสร้างแพ็กเกจ',
    en: 'The package is version {version}, which is not newer than the running version ({running}). Raise the version number before building the package.',
  },
  'update.staged-not-newer': { th: 'แพ็กเกจไม่ใหม่กว่าเวอร์ชันที่ใช้อยู่', en: 'The package is not newer than the running version.' },
  'update.staged-missing': { th: 'ไม่พบแพ็กเกจที่เตรียมไว้ กรุณาอัปโหลดใหม่', en: 'The prepared package was not found. Please upload it again.' },
  'update.rollback-missing': { th: 'ไม่พบเวอร์ชันที่ต้องการย้อนกลับ', en: 'The version to roll back to was not found.' },
  'update.version-in-use': { th: 'เวอร์ชันนี้กำลังใช้งานอยู่', en: 'This version is already running.' },
  // the result of the last switch, written to state.json by the launcher
  'update.installed': { th: 'ติดตั้งสำเร็จ', en: 'Installed successfully.' },
  'update.exited-unconfirmed': {
    th: 'โปรเซสหยุดทำงาน (code {exit}) ก่อนยืนยันการติดตั้ง',
    en: 'The process stopped (code {exit}) before the update was confirmed.',
  },
  // updates published on the web (UPDATE_SOURCE)
  'update.source-off': { th: 'ยังไม่ได้ตั้งแหล่งอัปเดต (UPDATE_SOURCE)', en: 'No update source is set (UPDATE_SOURCE).' },
  'update.source-unreachable': { th: 'ติดต่อแหล่งอัปเดตไม่ได้', en: 'The update source could not be reached.' },
  'update.source-timeout': { th: 'แหล่งอัปเดตไม่ตอบสนองภายในเวลาที่กำหนด', en: 'The update source did not answer in time.' },
  'update.source-status': { th: 'แหล่งอัปเดตตอบกลับ HTTP {status}', en: 'The update source answered HTTP {status}.' },
  'update.source-latest-too-big': { th: 'latest.json ของแหล่งอัปเดตใหญ่เกินกำหนด', en: 'The latest.json of the update source is too big.' },
  'update.source-latest-invalid': { th: 'latest.json ของแหล่งอัปเดตไม่ถูกต้อง', en: 'The latest.json of the update source is not valid.' },
  'update.source-bad-file': {
    th: 'ชื่อไฟล์แพ็กเกจใน latest.json ไม่ถูกต้อง (ต้องเป็น file-center-x.y.z.zip)',
    en: 'The package file name in latest.json is not valid (it must be file-center-x.y.z.zip).',
  },
  'update.source-not-newer': {
    th: 'เวอร์ชันล่าสุดที่แหล่งอัปเดต ({version}) ไม่ใหม่กว่าเวอร์ชันที่ใช้อยู่ ({running})',
    en: 'The latest version at the update source ({version}) is not newer than the running version ({running}).',
  },
  // dashboard warning and alert: the daily look at UPDATE_SOURCE found a newer version
  'update.available': { th: 'มีเวอร์ชันใหม่ {version} ให้ติดตั้งที่หน้าอัปเดตระบบ', en: 'Version {version} is available on the update page.' },
  'update.source-mismatch': {
    th: 'ไฟล์ที่ดาวน์โหลดไม่ตรงกับ SHA-256 หรือขนาดใน latest.json ไฟล์อาจเสียหายหรือถูกแก้ไข',
    en: 'The downloaded file does not match the SHA-256 or size in latest.json. It may be damaged or altered.',
  },
} as const satisfies Record<string, { th: string; en: string }>

export type MessageCode = keyof typeof MESSAGES
export type Lang = 'th' | 'en'
export type Params = Record<string, string | number>

/** the text of `code` in `lang`, with `{name}` replaced by `params.name` (once: a value is never expanded again) */
export function text(lang: Lang, code: MessageCode, params: Params = {}): string {
  const entry: { th: string; en: string } | undefined = MESSAGES[code]
  if (!entry) return code
  return entry[lang].replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all))
}

const asLang = (v: string | null | undefined): Lang | null => {
  const primary = v?.trim().toLowerCase().split(/[-_]/)[0]
  return primary === 'th' || primary === 'en' ? primary : null
}

/** the cookie the page keeps its language in, for requests that carry no `x-lang` (a download link the tab opens) */
export const LANG_COOKIE = 'fc_lang'

/** `fc_lang` when it is exactly th or en; any other value is ignored */
function cookieLang(request: Request): Lang | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at < 0 || part.slice(0, at).trim() !== LANG_COOKIE) continue
    const v = part.slice(at + 1).trim()
    return v === 'th' || v === 'en' ? v : null
  }
  return null
}

/** the language of a request: the page's `x-lang` (th/en), else its `fc_lang` cookie, else the browser's Accept-Language, else Thai */
export function langOf(request: Request): Lang {
  const own = asLang(request.headers.get('x-lang')) ?? cookieLang(request)
  if (own) return own
  let best: Lang = 'th'
  let bestQ = 0
  for (const part of (request.headers.get('accept-language') ?? '').split(',')) {
    const [tag, ...rest] = part.split(';')
    const lang = asLang(tag)
    const q = Number(rest.map(r => r.trim()).find(r => r.startsWith('q='))?.slice(2) ?? 1)
    // the first of equal weights wins, as the browser listed them in order of preference
    if (lang && q > bestQ) { best = lang; bestQ = q }
  }
  return best
}
