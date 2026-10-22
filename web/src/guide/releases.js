import { compareVersions, forRole } from './util'

/**
 * What changed, newest first. `roles` says who is told (user = everyone, manager = managers and admins, admin = admins only);
 * `to` is where "Show me" goes; `tour` is the spotlight to run there (step ids from tours.js, or inline steps).
 */
export const releases = [
  {
    version: '1.12.0',
    items: [
      {
        id: '112-menu', icon: 'menu', roles: ['user'], to: { name: 'files' },
        title: { th: 'เมนูจัดเป็นหมวดหมู่', en: 'A tidier menu' },
        text: { th: 'เมนูด้านข้างแบ่งเป็นหมวด ไฟล์ การแชร์ และการจัดการ หาของได้ง่ายขึ้น', en: 'The side menu is now split into sections: files, sharing and management. Easier to find things.' },
        tour: [{ id: '112-menu', target: 'nav-section-files', title: { th: 'เมนูแบบมีหมวด', en: 'Menu sections' }, text: { th: 'เมนูแบ่งเป็นหมวด ไฟล์ การแชร์ และอื่นๆ ตามสิทธิ์ของคุณ', en: 'The menu is grouped into sections, depending on what you may do.' } }],
      },
      {
        id: '112-system', icon: 'system', roles: ['admin'], to: { name: 'settings' },
        title: { th: 'หน้าระบบแบบแท็บ', en: 'The System page with tabs' },
        text: { th: 'ตั้งค่า สำรองข้อมูล อัปเดต บันทึกระบบ และถังขยะทั้งระบบ รวมอยู่ในหน้า "ระบบ" หน้าเดียว แยกเป็นแท็บ', en: 'Settings, backup, update, logs and the system-wide trash now live on one "System" page, split into tabs.' },
        tour: ['sys-menu', 'sys-settings', 'sys-backup', 'sys-update'],
      },
      {
        id: '112-help', icon: 'help', roles: ['user'], to: { name: 'files' },
        title: { th: 'หน้าคู่มือ ปุ่ม ? และทัวร์แนะนำ', en: 'Help page, ? button and tours' },
        text: { th: 'กดปุ่ม ? ที่มุมบนเพื่อเปิดคู่มือ ค้นหาวิธีใช้ และเริ่มทัวร์แนะนำได้ทุกเมื่อ', en: 'Press the ? button at the top to open the guide, look things up and start a tour whenever you like.' },
        tour: ['help-button'],
      },
      {
        id: '112-prefs', icon: 'theme', roles: ['user'], to: { name: 'files' },
        title: { th: 'ธีมและภาษาย้ายไปอยู่ในเมนูผู้ใช้', en: 'Theme and language are in your menu' },
        text: { th: 'กดที่ชื่อของคุณมุมขวาบนเพื่อสลับโหมดสว่าง/มืด และเปลี่ยนภาษา', en: 'Press your name at the top right to switch light/dark and change the language.' },
        tour: ['user-menu'],
      },
    ],
  },
  {
    version: '1.11.0',
    items: [
      {
        id: '111-dav', icon: 'dav', roles: ['user'], needs: 'webdav', to: { name: 'files' },
        title: { th: 'เชื่อมเป็นไดรฟ์เครือข่ายด้วย WebDAV', en: 'Connect as a network drive (WebDAV)' },
        text: { th: 'เปิด File Center เป็นไดรฟ์ในคอมพิวเตอร์หรือแอปมือถือ โดยใช้รหัสผ่านแอป สร้างได้ที่ บัญชี > WebDAV', en: 'Open File Center as a drive on your computer or in a phone app, with an app password. Make one in Account > WebDAV.' },
        tour: [{ id: '111-dav', target: 'user-menu', title: { th: 'บัญชี > WebDAV', en: 'Account > WebDAV' }, text: { th: 'เปิดเมนูนี้ เลือก "บัญชีและความปลอดภัย" แล้วไปที่แท็บ WebDAV เพื่อสร้างรหัสผ่านแอป', en: 'Open this menu, pick "Account and security", then the WebDAV tab to create an app password.' } }],
      },
      {
        id: '111-groups', icon: 'groups', roles: ['user'], to: { name: 'files' },
        title: { th: 'กลุ่มผู้ใช้และโฟลเดอร์กลุ่ม', en: 'User groups and group folders' },
        text: { th: 'ถ้าคุณอยู่ในกลุ่ม จะมีโฟลเดอร์ร่วมของกลุ่มในเมนู และแชร์โฟลเดอร์ให้ทั้งกลุ่มได้ในคลิกเดียว', en: 'If you are in a group, its shared folder is in the menu, and you can share a folder with a whole group in one go.' },
        tour: ['nav-groups'],
      },
      {
        id: '111-groups-admin', icon: 'groups', roles: ['admin'], to: { name: 'admin-groups' },
        title: { th: 'สร้างกลุ่มผู้ใช้', en: 'Create user groups' },
        text: { th: 'ผู้ดูแลระบบสร้างกลุ่มและตั้งสิทธิ์ของสมาชิกได้ที่เมนู "กลุ่ม"', en: 'Admins create groups and set what members may do in the "Groups" page.' },
        tour: ['nav-admin-groups'],
      },
      {
        id: '111-gallery', icon: 'gallery', roles: ['user'], to: { name: 'files' },
        title: { th: 'ภาพย่อ แกลเลอรี และดูในไฟล์ zip', en: 'Thumbnails, gallery and zip viewer' },
        text: { th: 'ดูภาพย่อของรูป เปิดมุมมองแกลเลอรี ดูเต็มจอหรือสไลด์โชว์ และดูข้างในไฟล์ zip ได้โดยไม่ต้องแตกไฟล์', en: 'See image thumbnails, use the gallery with a full-screen viewer and slideshow, and look inside zip files without extracting them.' },
        tour: ['view-switch'],
      },
    ],
  },
  {
    version: '1.10.0',
    items: [
      {
        id: '110-trash', icon: 'trash', roles: ['user'], to: { name: 'my-trash' },
        title: { th: 'ถังขยะของคุณเอง และเลิกทำ', en: 'Your own trash, with undo' },
        text: { th: 'ไฟล์ที่คุณลบจะอยู่ในถังขยะของคุณ กู้คืนได้ และกด "เลิกทำ" ได้ทันทีหลังลบ', en: 'Files you delete go to your own trash where you can restore them, and "Undo" is there right after deleting.' },
        tour: ['nav-my-trash'],
      },
      {
        id: '110-drag', icon: 'drag', roles: ['user'], to: { name: 'files' },
        title: { th: 'ลากย้าย คีย์ลัด และเมนูคลิกขวา', en: 'Drag to move, shortcuts and right-click' },
        text: { th: 'ลากไฟล์ไปวางบนโฟลเดอร์เพื่อย้าย คลิกขวาเพื่อเปิดเมนู และกด ? ในรายการไฟล์เพื่อดูคีย์ลัดทั้งหมด', en: 'Drag files onto a folder to move them, right-click for the menu, and press ? in the file list to see all shortcuts.' },
        tour: ['file-list'],
      },
      {
        id: '110-bell', icon: 'bell', roles: ['user'], to: { name: 'files' },
        title: { th: 'กระดิ่งแจ้งเตือน อีเมล และ LINE', en: 'Notifications: bell, email and LINE' },
        text: { th: 'กระดิ่งบอกเมื่อมีเรื่องที่ต้องดู และส่งอีเมลหรือ LINE ให้ได้ ตั้งค่าที่ บัญชี > การแจ้งเตือน', en: 'The bell tells you when something needs a look, and can also send email or LINE. Set it up in Account > Notifications.' },
        tour: ['bell'],
      },
      {
        id: '110-withme', icon: 'share', roles: ['user'], to: { name: 'with-me' },
        title: { th: 'แชร์โฟลเดอร์ให้ผู้ใช้เฉพาะคน', en: 'Share a folder with specific users' },
        text: { th: 'แชร์โฟลเดอร์ให้ผู้ใช้ที่เลือก โฟลเดอร์ที่คนอื่นแชร์ให้คุณอยู่ที่ "แชร์กับฉัน"', en: 'Share a folder with the users you pick. What others share with you is under "Shared with me".' },
        tour: ['nav-with-me'],
      },
      {
        id: '110-backup', icon: 'backup', roles: ['admin'], to: { name: 'backup' },
        title: { th: 'ตั้งค่าการสำรองข้อมูล', en: 'Backup settings' },
        text: { th: 'เลือกระดับการบีบอัด ตั้งเวลาสำรองอัตโนมัติ และกำหนดจำนวนไฟล์สำรองที่เก็บไว้', en: 'Pick the compression level, set an automatic schedule and choose how many backups to keep.' },
        tour: ['sys-backup'],
      },
    ],
  },
  {
    version: '1.9.1',
    items: [
      {
        id: '191-upload', icon: 'upload', roles: ['user'], to: { name: 'files' },
        title: { th: 'อัปโหลดเร็วขึ้น', en: 'Faster uploads' },
        text: { th: 'อัปโหลดหลายไฟล์พร้อมกันแบบขนาน เสร็จเร็วกว่าเดิม', en: 'Several files now upload in parallel, so a batch finishes sooner.' },
        tour: ['upload'],
      },
    ],
  },
  {
    version: '1.9.0',
    items: [
      {
        id: '190-manager', icon: 'users', roles: ['admin'], to: { name: 'users' },
        title: { th: 'บทบาทผู้จัดการ', en: 'The manager role' },
        text: { th: 'ผู้ดูแลระบบตั้งผู้ใช้เป็น "ผู้ดูแล" ให้คอยดูแลผู้ใช้คนอื่นแทนได้ โดยไม่ต้องให้สิทธิ์ระบบทั้งหมด', en: 'Admins can make a user a manager who looks after other users, without handing out full system access.' },
        tour: ['nav-users'],
      },
    ],
  },
]

/**
 * The releases a user is told about: newer than `seen` (null = every one) and, with `upTo`, not newer than the running
 * version; items filtered by role and by the `features` this server has on ({ webdav }); releases left with nothing are dropped.
 */
export function releasesFor(role, seen, upTo, features = {}) {
  return releases
    .filter(r => (seen == null || compareVersions(r.version, seen) > 0) && (!upTo || compareVersions(r.version, upTo) <= 0))
    .map(r => ({ ...r, items: forRole(r.items, role).filter(it => !it.needs || features[it.needs]) }))
    .filter(r => r.items.length)
}
