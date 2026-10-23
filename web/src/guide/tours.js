import { forRole } from './util'

/**
 * Spotlight steps. `target` is a data-tour name (or a list: the first one found is used), `route` is where to go first,
 * `roles` says who sees the step (user = everyone, manager = managers and admins, admin = admins only).
 * A step whose target is not on the page (a button the user has no right to, an empty list) is skipped silently.
 */
export const steps = {
  'file-list': {
    target: 'file-list', route: { name: 'files' }, roles: ['user'],
    title: { th: 'ไฟล์ของคุณอยู่ที่นี่', en: 'Your files live here' },
    text: {
      th: 'คลิกโฟลเดอร์เพื่อเปิด คลิกไฟล์เพื่อดูตัวอย่าง คลิกขวา (หรือกดค้างบนมือถือ) เพื่อเปิดเมนู และลากไฟล์ไปวางบนโฟลเดอร์เพื่อย้ายได้เลย',
      en: 'Click a folder to open it and a file to preview it. Right-click (or long-press on a phone) for the menu, and drag files onto a folder to move them.',
    },
  },
  upload: {
    target: 'upload', route: { name: 'files' }, roles: ['user'],
    title: { th: 'อัปโหลดไฟล์', en: 'Upload files' },
    text: {
      th: 'กดที่นี่เพื่อเลือกไฟล์หรือทั้งโฟลเดอร์ หรือจะลากไฟล์จากเครื่องมาวางบนหน้านี้ก็ได้ อัปโหลดหลายไฟล์พร้อมกันได้',
      en: 'Press here to pick files or a whole folder, or just drag files from your computer onto this page. Many files upload at the same time.',
    },
  },
  'new-folder': {
    target: 'new-folder', route: { name: 'files' }, roles: ['user'],
    title: { th: 'สร้างโฟลเดอร์ใหม่', en: 'New folder' },
    text: { th: 'สร้างโฟลเดอร์เพื่อจัดไฟล์ให้เป็นหมวดหมู่', en: 'Make folders to keep your files organised.' },
  },
  search: {
    target: 'search', route: { name: 'files' }, roles: ['user'],
    title: { th: 'ค้นหา', en: 'Search' },
    text: { th: 'ค้นหาไฟล์และโฟลเดอร์จากชื่อ ลองกดปุ่ม / บนคีย์บอร์ดเพื่อเปิดช่องค้นหาได้ทุกเมื่อ', en: 'Find files and folders by name. Press / on the keyboard to open search at any time.' },
  },
  'view-switch': {
    target: 'view-switch', route: { name: 'files' }, roles: ['user'],
    title: { th: 'เลือกมุมมอง', en: 'Change the view' },
    text: {
      th: 'สลับระหว่างรายการ ตาราง และแกลเลอรี มุมมองแกลเลอรีแสดงภาพย่อ เปิดดูเต็มจอหรือเล่นสไลด์โชว์ได้',
      en: 'Switch between list, grid and gallery. The gallery shows thumbnails and opens a full-screen viewer with a slideshow.',
    },
  },
  share: {
    target: ['share', 'file-list'], route: { name: 'files' }, roles: ['user'],
    title: { th: 'แชร์ไฟล์', en: 'Share' },
    text: {
      th: 'เลือกไฟล์หรือโฟลเดอร์หนึ่งรายการ แล้วจะมีปุ่ม "แชร์" ขึ้นที่แถบด้านบนรายการ สร้างลิงก์ให้คนนอกหรือแชร์ให้ผู้ใช้และกลุ่มในระบบได้ (ถ้าคุณมีสิทธิ์แชร์)',
      en: 'Select one file or folder and a "Share" button appears above the list. Make a link for people outside, or share with users and groups here (if you have the right to share).',
    },
  },
  'nav-favorites': {
    target: 'nav-favorites', roles: ['user'],
    title: { th: 'รายการโปรด', en: 'Favourites' },
    text: { th: 'กดดาวที่ไฟล์หรือโฟลเดอร์ แล้วจะมาอยู่ที่นี่ เปิดได้ในคลิกเดียว', en: 'Star a file or folder and it shows up here, one click away.' },
  },
  'nav-with-me': {
    target: 'nav-with-me', roles: ['user'],
    title: { th: 'แชร์กับฉัน', en: 'Shared with me' },
    text: { th: 'โฟลเดอร์ที่คนอื่นแชร์ให้คุณจะแสดงที่นี่ และมีแจ้งเตือนเมื่อมีใครแชร์ให้', en: 'Folders other people share with you appear here, and you get a notification when someone does.' },
  },
  'nav-groups': {
    target: 'nav-groups', roles: ['user'],
    title: { th: 'โฟลเดอร์กลุ่ม', en: 'Group folders' },
    text: { th: 'โฟลเดอร์ที่ใช้ร่วมกันของกลุ่มที่คุณเป็นสมาชิก ทุกคนในกลุ่มเห็นไฟล์เดียวกัน', en: 'Shared folders of the groups you belong to. Everyone in the group sees the same files.' },
  },
  'nav-links': {
    target: 'nav-links', roles: ['user'],
    title: { th: 'ลิงก์ที่แชร์', en: 'Share links' },
    text: { th: 'ดู ปิด หรือลบลิงก์ที่คุณสร้างไว้ได้ที่นี่', en: 'See, pause or delete the links you made.' },
  },
  'nav-my-trash': {
    target: 'nav-my-trash', roles: ['user'],
    title: { th: 'ถังขยะ', en: 'Trash' },
    text: { th: 'ไฟล์ที่ลบจะอยู่ในถังขยะของคุณก่อน กู้คืนได้ทุกเมื่อ และกด "เลิกทำ" ได้ทันทีหลังลบ', en: 'Deleted files go to your own trash first. Restore them any time, or press "Undo" right after deleting.' },
  },
  bell: {
    target: 'bell', roles: ['user'],
    title: { th: 'การแจ้งเตือน', en: 'Notifications' },
    text: { th: 'กระดิ่งบอกเมื่อมีคนแชร์ให้คุณหรือมีเรื่องที่ต้องดู ตั้งให้ส่งอีเมลหรือ LINE ได้ที่ บัญชี > การแจ้งเตือน', en: 'The bell tells you when someone shares with you or something needs a look. Add email or LINE in Account > Notifications.' },
  },
  'user-menu': {
    target: 'user-menu', roles: ['user'],
    title: { th: 'เมนูผู้ใช้', en: 'Your menu' },
    text: {
      th: 'ที่นี่คือบัญชีของคุณ: เปลี่ยนรหัสผ่าน เปิดการยืนยันสองขั้นตอน (2FA) ดูอุปกรณ์ที่ล็อกอิน เชื่อม WebDAV รวมถึงสลับธีมและภาษา',
      en: 'This is your account: change the password, turn on two-step verification (2FA), see signed-in devices, connect WebDAV, and switch theme and language.',
    },
  },
  'help-button': {
    target: 'help-button', roles: ['user'],
    title: { th: 'ต้องการความช่วยเหลือ?', en: 'Need help?' },
    text: { th: 'กดปุ่ม ? เพื่อเปิดคู่มือ ค้นหาวิธีใช้ ดูสิ่งใหม่ หรือเริ่มทัวร์นี้ใหม่ได้ทุกเมื่อ', en: 'Press ? for the guide: look up how things work, see what is new, or restart this tour at any time.' },
  },

  // staff
  'nav-dashboard': {
    target: 'nav-dashboard', route: { name: 'dashboard' }, roles: ['manager'],
    title: { th: 'ภาพรวมระบบ', en: 'Dashboard' },
    text: { th: 'ดูพื้นที่ที่ใช้ การแจ้งเตือนของระบบ และสถานะโดยรวมได้ในหน้าเดียว', en: 'Storage used, system alerts and the overall state, on one page.' },
  },
  'nav-users': {
    target: 'nav-users', route: { name: 'users' }, roles: ['manager'],
    title: { th: 'ผู้ใช้', en: 'Users' },
    text: { th: 'เพิ่มผู้ใช้ กำหนดสิทธิ์ โควตา และรีเซ็ตรหัสผ่านของผู้ใช้ที่คุณดูแล', en: 'Add users, set their permissions and quota, and reset the passwords of the users you look after.' },
  },
  'nav-admin-groups': {
    target: 'nav-admin-groups', route: { name: 'admin-groups' }, roles: ['manager'],
    title: { th: 'กลุ่ม', en: 'Groups' },
    text: { th: 'จัดสมาชิกของกลุ่ม แต่ละกลุ่มมีโฟลเดอร์ร่วมกันของตัวเอง', en: 'Manage group members. Each group has its own shared folder.' },
  },
  'nav-activity': {
    target: 'nav-activity', route: { name: 'activity' }, roles: ['manager'],
    title: { th: 'ประวัติการใช้งาน', en: 'Activity' },
    text: { th: 'ดูว่าใครทำอะไรและเมื่อไหร่ ค้นหาและกรองตามผู้ใช้หรือประเภทได้', en: 'See who did what and when. Search and filter by user or kind.' },
  },

  // admin
  'sys-menu': {
    target: 'nav-settings', route: { name: 'settings' }, roles: ['admin'],
    title: { th: 'หน้าระบบ', en: 'The System page' },
    text: { th: 'การตั้งค่าระบบทั้งหมดรวมอยู่ในหน้าเดียวที่แบ่งเป็นแท็บ จุดสีฟ้าแปลว่ามีเวอร์ชันใหม่', en: 'All system settings are on one page with tabs. A blue dot means a new version is available.' },
  },
  'sys-settings': {
    target: 'sys-settings', route: { name: 'settings' }, roles: ['admin'],
    title: { th: 'ตั้งค่า', en: 'Settings' },
    text: { th: 'ชื่อระบบ สี โลโก้ หน้าสาธารณะ นโยบายแชร์ ความปลอดภัย 2FA โควตา อีเมล และการแจ้งเตือน แยกเป็นหมวด', en: 'App name, colour, logo, the public page, share rules, security and 2FA, quotas, email and alerts, in categories.' },
  },
  'settings-cats': {
    target: ['settings-cats'], route: { name: 'settings' }, roles: ['admin'],
    title: { th: 'หมวดการตั้งค่า', en: 'Setting categories' },
    text: { th: 'เลือกหมวดทั่วไป หน้าสาธารณะ แชร์ ความปลอดภัย ไฟล์และพื้นที่ หรืออีเมลและแจ้งเตือน เมื่อแก้ค่า จะมีแถบบันทึกลอยอยู่ด้านล่าง', en: 'Pick General, Public page, Sharing, Security, Files and storage, or Email and alerts. When you change something, a save bar appears at the bottom.' },
  },
  'sys-backup': {
    target: 'sys-backup', route: { name: 'backup' }, roles: ['admin'],
    title: { th: 'สำรองข้อมูล', en: 'Backup' },
    text: { th: 'สำรองข้อมูลด้วยมือหรือตั้งเวลาอัตโนมัติ เลือกระดับการบีบอัดและจำนวนไฟล์สำรองที่เก็บไว้', en: 'Back up by hand or on a schedule. Choose the compression and how many backups to keep.' },
  },
  'sys-update': {
    target: 'sys-update', route: { name: 'update' }, roles: ['admin'],
    title: { th: 'อัปเดตระบบ', en: 'Update' },
    text: { th: 'อัปโหลดแพ็กเกจเวอร์ชันใหม่เพื่ออัปเดต ระบบสำรองข้อมูลให้ก่อนทุกครั้ง', en: 'Upload a new version package to update. The system backs up first, every time.' },
  },
}

/** the guided tours, by id; the new-user tour is all of them that fit the role, in this order */
export const tours = {
  basics: ['file-list', 'upload', 'new-folder', 'search', 'view-switch', 'share', 'nav-favorites', 'nav-with-me', 'nav-groups', 'nav-links', 'nav-my-trash', 'bell', 'user-menu', 'help-button'],
  manage: ['nav-dashboard', 'nav-users', 'nav-admin-groups', 'nav-activity'],
  system: ['sys-menu', 'sys-settings', 'settings-cats', 'sys-backup', 'sys-update'],
}

/** a list of step ids and/or inline steps -> steps (with an id) */
export const resolve = list => (Array.isArray(list) ? list : list ? [list] : []).map((s, i) => (typeof s === 'string' ? { id: s, ...steps[s] } : { id: s.id || `step-${i}`, ...s })).filter(s => s.target)

export const tourSteps = (id, role) => forRole(resolve(tours[id] || []), role)

/**
 * The tour of one page (the "?" menu in the top bar offers it): step ids by route name. A page not listed has no tour.
 * Each step brings its own route, so the tour starts correctly from anywhere.
 */
const systemPageTour = ['sys-menu', 'sys-settings', 'settings-cats', 'sys-backup', 'sys-update']
export const pageTours = {
  files: ['file-list', 'upload', 'new-folder', 'search', 'view-switch', 'share'],
  favorites: ['nav-favorites'],
  'with-me': ['nav-with-me'],
  groups: ['nav-groups'],
  links: ['nav-links'],
  'my-trash': ['nav-my-trash'],
  dashboard: ['nav-dashboard'],
  users: ['nav-users'],
  'admin-groups': ['nav-admin-groups'],
  activity: ['nav-activity'],
  settings: systemPageTour,
  backup: systemPageTour,
  update: systemPageTour,
}

/** the steps of the page's tour for a role (empty when the page has none, or none of it fits the role) */
export const pageTourSteps = (routeName, role) => forRole(resolve(pageTours[routeName] || []), role)

/** the ids of the tours a role has */
export const tourIdsFor = role => Object.keys(tours).filter(id => tourSteps(id, role).length)

/** the whole tour for a role: basics, then (for staff) manage, then (for admins) system */
export const fullTour = role => tourIdsFor(role).flatMap(id => tourSteps(id, role))
