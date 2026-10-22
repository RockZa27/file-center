import { forRole } from './util'

/**
 * The topics of the help page. `text` is a list of short paragraphs per language ({host} is this site's address);
 * `tour` is the spotlight a "Show me" runs (step ids from tours.js) where the page has something to point at;
 * `to` is the page the topic is about. `roles`: user = everyone, manager = managers and admins, admin = admins only.
 * `special: 'shortcuts'` makes the help page add the keyboard table.
 */
export const topics = [
  {
    id: 'files', icon: 'folder', roles: ['user'], to: { name: 'files' }, tour: ['file-list', 'upload', 'new-folder'],
    title: { th: 'ไฟล์และการอัปโหลด', en: 'Files and uploading' },
    keywords: { th: 'อัปโหลด ดาวน์โหลด เปิด ดูตัวอย่าง', en: 'upload download open preview' },
    text: {
      th: ['กด "อัปโหลด" เพื่อเลือกไฟล์หรือทั้งโฟลเดอร์ หรือลากไฟล์จากเครื่องมาวางบนหน้านี้ได้เลย ไฟล์ใหญ่จะถูกแบ่งส่งและอัปโหลดหลายไฟล์พร้อมกัน', 'คลิกไฟล์เพื่อดูตัวอย่าง (รูป วิดีโอ PDF เอกสาร ข้อความ) หรือเลือกหลายรายการเพื่อดาวน์โหลดเป็นไฟล์ zip'],
      en: ['Press "Upload" to pick files or a whole folder, or drag files from your computer onto the page. Big files are sent in pieces and many files go up at once.', 'Click a file to preview it (images, video, PDF, documents, text), or select several and download them as one zip.'],
    },
  },
  {
    id: 'folders', icon: 'drag', roles: ['user'], to: { name: 'files' }, tour: ['file-list'],
    title: { th: 'โฟลเดอร์และการย้ายไฟล์', en: 'Folders and moving things' },
    keywords: { th: 'ย้าย ลาก คัดลอก เปลี่ยนชื่อ คลิกขวา คีย์ลัด', en: 'move drag copy rename right-click context menu' },
    text: {
      th: ['ลากไฟล์ไปวางบนโฟลเดอร์ (หรือบนชื่อโฟลเดอร์ในแถบเส้นทางด้านบน) เพื่อย้าย กด Ctrl (Cmd บน Mac) ค้างไว้ขณะวางเพื่อคัดลอกแทน', 'คลิกขวาที่รายการ (บนมือถือแตะที่จุดสามจุด) เพื่อเปิดเมนู: เปลี่ยนชื่อ คัดลอก ย้าย บีบอัดเป็น zip แชร์ และอื่นๆ'],
      en: ['Drag a file onto a folder (or onto a folder name in the path bar above) to move it. Hold Ctrl (Cmd on a Mac) while dropping to copy instead.', 'Right-click an item (on a phone, tap the three dots) for the menu: rename, copy, move, zip, share and more.'],
    },
  },
  {
    id: 'search', icon: 'search', roles: ['user'], to: { name: 'files' }, tour: ['search'],
    title: { th: 'ค้นหา', en: 'Searching' },
    keywords: { th: 'ค้นหา หา ชื่อไฟล์', en: 'search find name' },
    text: {
      th: ['กดปุ่มแว่นขยาย หรือกด / บนคีย์บอร์ด แล้วพิมพ์ชื่อไฟล์หรือโฟลเดอร์ ผลลัพธ์แสดงเฉพาะที่คุณมีสิทธิ์เห็น'],
      en: ['Press the magnifier, or press / on the keyboard, and type part of a file or folder name. Results only include what you are allowed to see.'],
    },
  },
  {
    id: 'gallery', icon: 'gallery', roles: ['user'], to: { name: 'files' }, tour: ['view-switch'],
    title: { th: 'แกลเลอรี ภาพย่อ และดูในไฟล์ zip', en: 'Gallery, thumbnails and zip viewer' },
    keywords: { th: 'รูป ภาพย่อ สไลด์โชว์ zip แกลเลอรี', en: 'photos thumbnails slideshow zip gallery images' },
    text: {
      th: ['สลับมุมมองเป็นรายการ ตาราง หรือแกลเลอรีได้ที่ปุ่มสามปุ่มด้านบน แกลเลอรีแสดงภาพย่อ คลิกรูปเพื่อดูเต็มจอ และเล่นสไลด์โชว์ได้', 'กด "ดูข้างใน" ที่ไฟล์ zip เพื่อเปิดดูรายการข้างในและดาวน์โหลดเฉพาะบางไฟล์ โดยไม่ต้องแตกไฟล์ทั้งหมด'],
      en: ['Switch between list, grid and gallery with the three buttons at the top. The gallery shows thumbnails; click a picture for the full-screen viewer and a slideshow.', 'Choose "Look inside" on a zip file to browse it and download just some of its files without extracting everything.'],
    },
  },
  {
    id: 'links', icon: 'share', roles: ['user'], to: { name: 'files' }, tour: ['share', 'nav-links'],
    title: { th: 'แชร์ด้วยลิงก์', en: 'Sharing with a link' },
    keywords: { th: 'แชร์ ลิงก์ รหัสผ่าน หมดอายุ', en: 'share link password expire public' },
    text: {
      th: ['เลือกไฟล์หรือโฟลเดอร์ แล้วกด "แชร์" เพื่อสร้างลิงก์ ตั้งรหัสผ่านและวันหมดอายุได้ ใครมีลิงก์ก็เปิดได้ แม้ไม่มีบัญชี', 'ดูและลบลิงก์ที่สร้างไว้ได้ที่เมนู "ลิงก์ที่แชร์" (ปุ่มแชร์จะมีเมื่อคุณมีสิทธิ์แชร์เท่านั้น)'],
      en: ['Select a file or folder and press "Share" to make a link. You can add a password and an expiry date. Anyone with the link can open it, account or not.', 'See and delete your links under "Share links". The Share button only shows if you are allowed to share.'],
    },
  },
  {
    id: 'grants', icon: 'share', roles: ['user'], to: { name: 'with-me' }, tour: ['nav-with-me'],
    title: { th: 'แชร์ให้ผู้ใช้และกลุ่ม', en: 'Sharing with users and groups' },
    keywords: { th: 'แชร์กับฉัน ผู้ใช้ กลุ่ม สิทธิ์', en: 'shared with me users groups permission' },
    text: {
      th: ['ในหน้าต่างแชร์ เลือกแท็บ "ผู้ใช้" หรือ "กลุ่ม" แล้วเลือกว่าจะให้แค่ดู หรือแก้ไขได้ด้วย', 'โฟลเดอร์ที่คนอื่นแชร์ให้คุณอยู่ที่เมนู "แชร์กับฉัน" และมีแจ้งเตือนที่กระดิ่ง'],
      en: ['In the share window pick the "Users" or "Groups" tab and choose view-only or edit rights.', 'Folders other people share with you are under "Shared with me", and the bell lets you know.'],
    },
  },
  {
    id: 'groups', icon: 'groups', roles: ['user'], to: { name: 'files' }, tour: ['nav-groups'],
    title: { th: 'โฟลเดอร์กลุ่ม', en: 'Group folders' },
    keywords: { th: 'กลุ่ม โฟลเดอร์กลุ่ม ทีม', en: 'group folder team shared' },
    text: {
      th: ['ถ้าคุณเป็นสมาชิกกลุ่ม จะมีเมนู "โฟลเดอร์กลุ่ม" ทุกคนในกลุ่มใช้โฟลเดอร์เดียวกัน สิทธิ์ของคุณ (ดู อัปโหลด แก้ไข) กำหนดโดยผู้ดูแล'],
      en: ['If you belong to a group, a "Group folders" item appears. Everyone in the group works in the same folder, and your rights (view, upload, edit) are set by an admin.'],
    },
  },
  {
    id: 'trash', icon: 'trash', roles: ['user'], to: { name: 'my-trash' }, tour: ['nav-my-trash'],
    title: { th: 'ถังขยะและเลิกทำ', en: 'Trash and undo' },
    keywords: { th: 'ถังขยะ ลบ กู้คืน เลิกทำ', en: 'trash delete restore undo' },
    text: {
      th: ['ไฟล์ที่ลบไปอยู่ในถังขยะของคุณก่อน กดกู้คืนเพื่อให้กลับไปที่เดิม หรือกด "เลิกทำ" ที่ข้อความด้านล่างทันทีหลังลบ ไฟล์ในถังขยะจะถูกลบถาวรตามจำนวนวันที่ระบบกำหนด'],
      en: ['Deleted files go to your trash first. Press restore to put them back, or press "Undo" in the message right after deleting. Files in the trash are removed for good after the number of days the system sets.'],
    },
  },
  {
    id: 'notify', icon: 'bell', roles: ['user'], to: { name: 'files' }, tour: ['bell'],
    title: { th: 'การแจ้งเตือน (อีเมล / LINE)', en: 'Notifications (email / LINE)' },
    keywords: { th: 'แจ้งเตือน กระดิ่ง อีเมล ไลน์', en: 'notifications bell email line' },
    text: {
      th: ['กระดิ่งมุมบนบอกเมื่อมีคนแชร์ให้คุณหรือมีเรื่องสำคัญ เปิดส่งซ้ำทางอีเมลหรือ LINE ได้ที่ ชื่อของคุณ > บัญชีและความปลอดภัย > การแจ้งเตือน'],
      en: ['The bell at the top tells you when someone shares with you or something important happens. To also get email or LINE messages, go to your name > Account and security > Notifications.'],
    },
  },
  {
    id: 'security', icon: 'lock', roles: ['user'], to: { name: 'files' }, tour: ['user-menu'],
    title: { th: 'ความปลอดภัยของบัญชี', en: 'Account security' },
    keywords: { th: 'รหัสผ่าน 2FA อุปกรณ์ ยืนยันสองขั้นตอน', en: 'password 2fa two-factor devices sessions' },
    text: {
      th: ['เปิดเมนูชื่อของคุณ > "บัญชีและความปลอดภัย" เพื่อเปลี่ยนรหัสผ่าน เปิดการยืนยันสองขั้นตอน (2FA) ด้วยแอปยืนยันตัวตน เก็บรหัสสำรอง และดูหรือออกจากระบบอุปกรณ์ที่ล็อกอินอยู่'],
      en: ['Open your name menu > "Account and security" to change your password, turn on two-step verification (2FA) with an authenticator app, keep backup codes, and see or sign out the devices that are signed in.'],
    },
  },
  {
    id: 'webdav', icon: 'dav', roles: ['user'], needs: 'webdav', to: { name: 'files' }, tour: ['user-menu'],
    title: { th: 'WebDAV: เชื่อมเป็นไดรฟ์', en: 'WebDAV: connect as a drive' },
    keywords: { th: 'webdav ไดรฟ์ เครือข่าย windows mac rclone รหัสผ่านแอป', en: 'webdav network drive windows mac finder rclone app password' },
    text: {
      th: [
        'ก่อนอื่นสร้าง "รหัสผ่านแอป" ที่ ชื่อของคุณ > บัญชีและความปลอดภัย > WebDAV แล้วใช้รหัสนั้นแทนรหัสผ่านบัญชีตอนเชื่อมต่อ ที่อยู่คือ {host}/dav/',
        'Windows: เปิด File Explorer > This PC > Map network drive ใส่ {host}/dav/ ติ๊ก "Connect using different credentials" แล้วใส่ชื่อผู้ใช้กับรหัสผ่านแอป',
        'macOS: ใน Finder เลือก Go > Connect to Server (⌘K) ใส่ {host}/dav/ แล้วกรอกชื่อผู้ใช้กับรหัสผ่านแอป',
        'มือถือ: ใช้แอปจัดการไฟล์ที่รองรับ WebDAV เช่น Documents (iOS) หรือ Solid Explorer / Cx File Explorer (Android) เพิ่มเซิร์ฟเวอร์ WebDAV ด้วยที่อยู่เดียวกัน',
        'rclone: รัน rclone config เลือกชนิด webdav ใส่ url {host}/dav/ และ vendor เป็น other แล้วใส่ชื่อผู้ใช้กับรหัสผ่านแอป',
        'หมายเหตุ: ถ้าเว็บนี้อยู่หลัง Cloudflare การอัปโหลดแต่ละไฟล์ผ่าน WebDAV จะถูกจำกัดที่ 100 MB ไฟล์ที่ใหญ่กว่านั้นให้อัปโหลดผ่านหน้าเว็บ',
      ],
      en: [
        'First create an "app password" in your name > Account and security > WebDAV, and use it instead of your account password when connecting. The address is {host}/dav/',
        'Windows: open File Explorer > This PC > Map network drive, enter {host}/dav/, tick "Connect using different credentials", then your username and the app password.',
        'macOS: in Finder choose Go > Connect to Server (⌘K), enter {host}/dav/, then your username and the app password.',
        'Phones: use a file app that supports WebDAV, such as Documents (iOS) or Solid Explorer / Cx File Explorer (Android), and add a WebDAV server with the same address.',
        'rclone: run rclone config, choose type webdav, set the url to {host}/dav/ and vendor to other, then your username and the app password.',
        'Note: if this site is behind Cloudflare, each file uploaded over WebDAV is limited to 100 MB. Upload bigger files in the web page.',
      ],
    },
  },
  {
    id: 'shortcuts', icon: 'keys', roles: ['user'], to: { name: 'files' }, special: 'shortcuts',
    title: { th: 'คีย์ลัด', en: 'Keyboard shortcuts' },
    keywords: { th: 'คีย์ลัด คีย์บอร์ด ปุ่ม', en: 'keyboard shortcuts keys' },
    text: {
      th: ['ใช้ได้ในรายการไฟล์ เมื่อไม่ได้พิมพ์อยู่ในช่องกรอกและไม่มีหน้าต่างเปิดอยู่ กด ? ในรายการไฟล์เพื่อเปิดรายการนี้ได้ทุกเมื่อ'],
      en: ['They work in the file list when you are not typing in a box and no window is open. Press ? in the file list to see this list at any time.'],
    },
  },

  // staff
  {
    id: 'users', icon: 'users', roles: ['manager'], to: { name: 'users' }, tour: ['nav-users'],
    title: { th: 'จัดการผู้ใช้', en: 'Managing users' },
    keywords: { th: 'ผู้ใช้ เพิ่ม รีเซ็ตรหัสผ่าน โควตา สิทธิ์', en: 'users add reset password quota permission' },
    text: {
      th: ['เพิ่มผู้ใช้ กำหนดสิทธิ์ในแต่ละพื้นที่และโควตา และรีเซ็ตรหัสผ่านได้ที่หน้า "ผู้ใช้" ผู้ใช้ที่ได้รับรหัสผ่านใหม่ต้องเปลี่ยนรหัสผ่านก่อนใช้งาน ผู้จัดการจัดการได้เฉพาะผู้ใช้ที่อยู่ในความดูแล'],
      en: ['On the "Users" page, add users, set their rights in each space and their quota, and reset passwords. A user given a new password must change it before using the app. Managers only handle the users they look after.'],
    },
  },
  {
    id: 'groups-admin', icon: 'groups', roles: ['manager'], to: { name: 'admin-groups' }, tour: ['nav-admin-groups'],
    title: { th: 'จัดการกลุ่ม', en: 'Managing groups' },
    keywords: { th: 'กลุ่ม สมาชิก', en: 'groups members' },
    text: {
      th: ['ที่หน้า "กลุ่ม" เพิ่มหรือนำสมาชิกออก และกำหนดสิทธิ์ของแต่ละคนในโฟลเดอร์กลุ่ม การสร้างและลบกลุ่มทำได้เฉพาะผู้ดูแลระบบ'],
      en: ['On the "Groups" page add or remove members and set each one\'s rights in the group folder. Only admins can create and delete groups.'],
    },
  },
  {
    id: 'dashboard', icon: 'dashboard', roles: ['manager'], to: { name: 'dashboard' }, tour: ['nav-dashboard', 'nav-activity'],
    title: { th: 'ภาพรวมและประวัติการใช้งาน', en: 'Dashboard and activity' },
    keywords: { th: 'ภาพรวม ประวัติ ล็อก กิจกรรม แจ้งเตือนระบบ', en: 'dashboard activity log alerts overview' },
    text: {
      th: ['"ภาพรวมระบบ" แสดงพื้นที่ที่ใช้และข้อแจ้งเตือนของระบบ ตัวเลขสีบนเมนูบอกว่ามีเรื่องที่ควรดู', '"ประวัติการใช้งาน" บอกว่าใครทำอะไรเมื่อไหร่ กรองตามผู้ใช้หรือประเภทได้'],
      en: ['The "Dashboard" shows storage used and system alerts. A coloured number on the menu means something needs a look.', '"Activity" shows who did what and when, and can be filtered by user or kind.'],
    },
  },

  // admin
  {
    id: 'settings', icon: 'system', roles: ['admin'], to: { name: 'settings' }, tour: ['sys-menu', 'sys-settings'],
    title: { th: 'ตั้งค่าระบบ', en: 'System settings' },
    keywords: { th: 'ตั้งค่า ชื่อระบบ โลโก้ สี อัปโหลด อีเมล', en: 'settings name logo colour upload email' },
    text: {
      th: ['หน้า "ระบบ" รวมทุกอย่างของผู้ดูแลไว้ในแท็บ ตั้งค่า สำรองข้อมูล อัปเดต บันทึกระบบ และถังขยะทั้งระบบ แท็บ "ตั้งค่า" ใช้ปรับชื่อ สี โลโก้ ขนาดอัปโหลด WebDAV และการแจ้งเตือน'],
      en: ['The "System" page holds everything for admins in tabs: Settings, Backup, Update, Logs and the system-wide Trash. The "Settings" tab sets the name, colour, logo, upload limits, WebDAV and notifications.'],
    },
  },
  {
    id: 'backup', icon: 'backup', roles: ['admin'], to: { name: 'backup' }, tour: ['sys-backup'],
    title: { th: 'สำรองข้อมูล', en: 'Backups' },
    keywords: { th: 'สำรอง กู้คืน บีบอัด ตาราง', en: 'backup restore compression schedule keep' },
    text: {
      th: ['สำรองข้อมูลด้วยมือได้ทุกเมื่อ หรือตั้งเวลาอัตโนมัติ (รายวัน รายสัปดาห์ หรือทุกกี่ชั่วโมง) เลือกระดับการบีบอัด และจำนวนไฟล์สำรองที่เก็บไว้ ควรเก็บสำเนาไว้นอกเครื่องเซิร์ฟเวอร์ด้วย'],
      en: ['Back up by hand at any time, or on a schedule (daily, weekly or every few hours). Pick the compression level and how many backups to keep. Keep a copy off the server too.'],
    },
  },
  {
    id: 'update', icon: 'update', roles: ['admin'], to: { name: 'update' }, tour: ['sys-update'],
    title: { th: 'อัปเดตระบบ', en: 'Updating' },
    keywords: { th: 'อัปเดต เวอร์ชัน แพ็กเกจ', en: 'update version package upgrade' },
    text: {
      th: ['ที่แท็บ "อัปเดตระบบ" อัปโหลดแพ็กเกจเวอร์ชันใหม่ ระบบจะสำรองข้อมูลก่อน แล้วติดตั้งและเริ่มใหม่ จุดสีฟ้าบนเมนู "ระบบ" แปลว่ามีเวอร์ชันใหม่'],
      en: ['In the "Update" tab upload a new version package. The system backs up first, then installs and restarts. A blue dot on the "System" menu means a new version is available.'],
    },
  },
]

/** `features` names what this server has switched on ({ webdav }): a topic that `needs` one is left out without it */
export const topicsFor = (role, features = {}) => forRole(topics, role).filter(tp => !tp.needs || features[tp.needs])
