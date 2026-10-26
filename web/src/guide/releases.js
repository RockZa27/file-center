import { compareVersions, forRole } from './util'

/**
 * What changed, newest first. `roles` says who is told (user = everyone, manager = managers and admins, admin = admins only);
 * `to` is where "Show me" goes; `tour` is the spotlight to run there (step ids from tours.js, or inline steps).
 */
export const releases = [
  {
    version: '1.13.2',
    items: [
      {
        id: '1132-hardening', icon: 'system', roles: ['admin'], to: { name: 'dashboard' },
        title: { th: 'เสริมความแข็งแรงจากการตรวจความปลอดภัย', en: 'Hardening from the security audit' },
        text: {
          th: 'การตั้งปลายทางแจ้งเตือน (webhook) ต้องยืนยันรหัสผ่านและแจ้งผู้ดูแลเหมือนหมวดความปลอดภัย launcher ตรวจ server.js ของอัปเดตก่อนเริ่มทุกครั้งและกลับไปใช้เวอร์ชันที่มากับระบบถ้าไฟล์ถูกแก้ ผู้ใช้ถืออัปโหลดค้างได้ไม่เกิน UPLOAD_MAX_PENDING งาน ลิงก์แชร์ที่มีรหัสผ่านล็อกทั้งลิงก์เมื่อเดารหัสผิดมากจากหลาย IP ลิงก์ที่จำกัดจำนวนดาวน์โหลดนับตอนดูภาพขนาดใหญ่ และการกดเสร็จอัปโหลดซ้ำไม่นับเป็นไฟล์ใหม่ การกู้คืนไฟล์สำรองเก็บการเข้าสู่ระบบ รหัสผ่านแอป ลิงก์ สิทธิ์ และการเป็นสมาชิกกลุ่มไว้เฉพาะบัญชีที่เป็นบัญชีเดียวกับในไฟล์สำรอง (ชื่อและเวลาสร้างตรงกัน) บัญชีที่มาทีหลังด้วยชื่อเดิมจะไม่ได้อะไรไปเลย ผู้เยี่ยมชมนับอัปโหลดค้างแยกตาม IP งานของผู้เยี่ยมชมที่ไม่มีชิ้นใหม่ 15 นาทีคืนโควตารายวัน และ PROPFIND ของ WebDAV จำกัด namespace 256 ตัวอักษรกับขนาดคำตอบ 32 MiB',
          en: 'Setting the alert webhook now asks for your password and tells the admins, like the security category. The launcher checks an update\'s server.js before every start and falls back to the built-in version if it was changed. A user can hold at most UPLOAD_MAX_PENDING unfinished uploads. A share link with a password locks as a whole after many wrong guesses from several addresses. A link with a download limit counts the large preview as a download, and completing an upload twice no longer counts a new file. Restoring a backup keeps the sign-ins, app passwords, links, grants and group places only of an account that is the very one in the backup (same name and creation time); a later account that reused a name inherits none of them. Unfinished visitor uploads are counted per address, a visitor upload with no new chunk for 15 minutes gives back its share of the daily allowance, and a WebDAV PROPFIND is limited to 256-character namespaces and a 32 MiB answer.',
        },
      },
    ],
  },
  {
    version: '1.13.1',
    items: [
      {
        id: '1131-security', icon: 'system', roles: ['admin'], to: { name: 'dashboard' },
        title: { th: 'ปิดช่องโหว่ที่พบจากการตรวจความปลอดภัย', en: 'Fixes from a security audit' },
        text: {
          th: 'WebDAV ทำตามกฎบังคับ 2FA และเห็นคำสั่ง sessions-revoke ทันที การรีเซ็ต 2FA ลบรหัสผ่านแอปด้วย บัญชีที่สร้างใหม่ชื่อซ้ำกับบัญชีที่หายไปหลังกู้คืนข้อมูลสำรองไม่ได้ลิงก์ สิทธิ์ กลุ่ม หรือการเข้าสู่ระบบของบัญชีเดิม ผู้เยี่ยมชมคนเดียวจองโควตาอัปโหลดรายวันของทุกคนไม่ได้อีก และการแตกไฟล์ zip ใหญ่ไม่ทำให้ระบบค้าง',
          en: 'WebDAV follows the 2FA rule and sees sessions-revoke at once, a 2FA reset also removes app passwords, a new account with the name of one a backup restore dropped gets none of its links, grants, groups or sign-ins, one visitor can no longer use up the visitors\' daily upload allowance, and unzipping a big archive no longer makes the server stall.',
        },
      },
    ],
  },
  {
    version: '1.13.0',
    items: [
      {
        id: '113-more', icon: 'menu', roles: ['user'], to: { name: 'files' },
        title: { th: 'ปุ่ม ⋯ และแถบเลือกไฟล์ด้านล่างบนมือถือ', en: 'The ⋯ button and a selection bar on phones' },
        text: { th: 'แต่ละไฟล์มีปุ่ม ⋯ สำหรับเมนูการทำงาน และเมื่อเลือกไฟล์บนมือถือ จะมีแถบปุ่มลัดอยู่ด้านล่างของหน้าจอ กดง่ายด้วยนิ้วเดียว', en: 'Every file has a ⋯ button for its actions, and when you select files on a phone a bar of actions appears at the bottom of the screen, easy to reach with one thumb.' },
        tour: ['file-list'],
      },
      {
        id: '113-longpress', icon: 'drag', roles: ['user'], to: { name: 'files' },
        title: { th: 'กดค้างเพื่อเลือกไฟล์', en: 'Press and hold to select' },
        text: { th: 'บนมือถือ กดค้างที่ไฟล์หรือโฟลเดอร์เพื่อเริ่มเลือก แล้วแตะรายการอื่นเพื่อเลือกเพิ่ม', en: 'On a phone, press and hold a file or folder to start selecting, then tap others to add them.' },
        tour: ['file-list'],
      },
      {
        id: '113-sort', icon: 'gallery', roles: ['user'], to: { name: 'files' },
        title: { th: 'เมนูเรียงลำดับ และจำวิธีเรียงให้', en: 'A sort menu that remembers' },
        text: { th: 'เลือกเรียงตามชื่อ ขนาด หรือวันที่ได้จากเมนูเรียงลำดับ ระบบจำวิธีที่คุณเลือกไว้ในเครื่องนี้', en: 'Sort by name, size or date from the sort menu. The way you choose is remembered on this device.' },
        tour: ['file-list'],
      },
      {
        id: '113-looks', icon: 'share', roles: ['user'], to: { name: 'files' },
        title: { th: 'หน้าแชร์ลิงก์และหน้าเข้าสู่ระบบหน้าตาใหม่', en: 'A new look for share and sign-in pages' },
        text: { th: 'หน้าที่คนเปิดจากลิงก์แชร์และหน้าเข้าสู่ระบบ ปรับดีไซน์ใหม่ ดูง่ายขึ้น โดยเฉพาะบนมือถือ', en: 'The page people open from a share link and the sign-in page have a fresh design that is easier to read, especially on a phone.' },
      },
      {
        id: '113-settings', icon: 'system', roles: ['admin'], to: { name: 'settings' },
        title: { th: 'หน้าตั้งค่าจัดใหม่เป็นหมวด', en: 'Settings reorganised into categories' },
        text: { th: 'หน้าตั้งค่าแบ่งเป็นหมวด ทั่วไป หน้าสาธารณะ แชร์ ความปลอดภัย ไฟล์และพื้นที่ อีเมลและแจ้งเตือน ทุกช่องมีคำอธิบายและบอกว่าค่ามาจาก .env ตั้งในเว็บ หรือค่าเริ่มต้น และคืนค่าเริ่มต้นได้', en: 'Settings are split into categories: general, public page, sharing, security, files and storage, email and alerts. Every field has a short explanation, says whether its value is from .env, set on the web or the default, and can be reset.' },
        tour: ['sys-settings', 'settings-cats'],
      },
      {
        id: '113-share-policy', icon: 'share', roles: ['admin'], to: { name: 'settings' },
        title: { th: 'นโยบายลิงก์แชร์', en: 'Share link policy' },
        text: { th: 'กำหนดอายุลิงก์ที่เลือกไว้ให้ อายุนานที่สุด อนุญาตลิงก์ไม่หมดอายุ และบังคับให้ลิงก์ต้องมีรหัสผ่าน', en: 'Set the preselected lifetime, the longest lifetime, whether links may never expire, and whether every link needs a password.' },
        tour: [{ id: '113-share-policy', target: ['settings-cat-share', 'settings-cats'], route: { name: 'settings' }, title: { th: 'หมวด "แชร์"', en: 'The "Sharing" category' }, text: { th: 'นโยบายของลิงก์แชร์ทั้งหมดอยู่ที่หมวดนี้', en: 'All the share link rules are in this category.' } }],
      },
      {
        id: '113-2fa', icon: 'lock', roles: ['admin'], to: { name: 'settings' },
        title: { th: 'บังคับใช้ 2FA และตั้งอายุการเข้าสู่ระบบ', en: 'Require 2FA, and session rules' },
        text: { th: 'บังคับให้ผู้ดูแลหรือทุกคนต้องเปิด 2FA ตั้งอายุการเข้าสู่ระบบ จำนวนครั้งที่ใส่รหัสผ่านผิดได้ และเวลาล็อก ที่หมวด "ความปลอดภัย" ผู้ที่ยังไม่มี 2FA จะถูกพาไปตั้งค่าก่อนใช้งานต่อ', en: 'Require 2FA for admins or everybody, and set the sign-in lifetime, the wrong-password limit and the lock time, in the "Security" category. People without 2FA are taken to set it up before they continue.' },
        tour: [{ id: '113-2fa', target: ['settings-cat-security', 'settings-cats'], route: { name: 'settings' }, title: { th: 'หมวด "ความปลอดภัย"', en: 'The "Security" category' }, text: { th: 'บังคับ 2FA และกฎการเข้าสู่ระบบอยู่ที่นี่ การเปลี่ยนค่าต้องยืนยันด้วยรหัสผ่าน', en: 'Required 2FA and the sign-in rules are here. Changes ask for your password.' } }],
      },
      {
        id: '113-quota', icon: 'backup', roles: ['admin'], to: { name: 'settings' },
        title: { th: 'โควตาเริ่มต้นและค่าไฟล์ตั้งในเว็บได้', en: 'Default quota and file limits on the web' },
        text: { th: 'ตั้งพื้นที่เริ่มต้นของผู้ใช้ใหม่ ขนาดอัปโหลดสูงสุด อายุถังขยะ และจำนวนเวอร์ชันที่เก็บ ได้ที่หมวด "ไฟล์และพื้นที่" ไม่ต้องแก้ไฟล์ .env แล้วรีสตาร์ต', en: 'Set the default storage for new users, the upload limit, the trash lifetime and how many versions are kept in "Files and storage", with no .env edit and restart.' },
        tour: [{ id: '113-quota', target: ['settings-cat-files', 'settings-cats'], route: { name: 'settings' }, title: { th: 'หมวด "ไฟล์และพื้นที่"', en: 'The "Files and storage" category' }, text: { th: 'โควตา ขนาดอัปโหลด ถังขยะ และเวอร์ชันของไฟล์', en: 'Quota, upload size, trash and file versions.' } }],
      },
      {
        id: '113-mail', icon: 'bell', roles: ['admin'], to: { name: 'settings' },
        title: { th: 'ตั้งค่าอีเมล (SMTP) และ webhook แจ้งเตือนในเว็บ', en: 'Set up SMTP email and the alert webhook on the web' },
        text: { th: 'กรอกเซิร์ฟเวอร์อีเมลและ webhook ได้ที่หมวด "อีเมลและแจ้งเตือน" มีปุ่มส่งอีเมลทดสอบ รหัสผ่านและ URL ถูกเก็บแบบเข้ารหัสและไม่แสดงกลับ', en: 'Fill in the email server and the webhook in "Email and alerts", with a button to send a test email. The password and the URL are stored encrypted and never shown again.' },
        tour: [{ id: '113-mail', target: ['settings-cat-mail', 'settings-cats'], route: { name: 'settings' }, title: { th: 'หมวด "อีเมลและแจ้งเตือน"', en: 'The "Email and alerts" category' }, text: { th: 'SMTP, อีเมลทดสอบ และ webhook อยู่ที่นี่', en: 'SMTP, the test email and the webhook are here.' } }],
      },
      {
        id: '113-warnings', icon: 'system', roles: ['admin'], to: { name: 'settings' },
        title: { th: 'คำเตือนเมื่อค่าใน .env เสี่ยง', en: 'Warnings about risky .env values' },
        text: { th: 'หน้าระบบแสดงแถบเตือนเมื่อพบค่าใน .env ที่เสี่ยงหรือไม่เหมาะกับการใช้งาน เช่น เปิดอัปเดตแบบไม่ตรวจลายเซ็น สีแดงคือเรื่องที่ควรแก้ทันที', en: 'The System page shows a banner when a .env value is risky or does not fit how the app is used, for example updates without signature checks. Red means fix it right away.' },
        tour: ['sys-settings'],
      },
    ],
  },
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
