import { createI18n } from 'vue-i18n'

const th = {
  common: {
    save: 'บันทึก', cancel: 'ยกเลิก', close: 'ปิด', confirm: 'ยืนยัน', delete: 'ลบ', create: 'สร้าง',
    rename: 'เปลี่ยนชื่อ', download: 'ดาวน์โหลด', upload: 'อัปโหลด', refresh: 'รีเฟรช', search: 'ค้นหา',
    back: 'ย้อนกลับ', home: 'หน้าแรก', retry: 'ลองใหม่', name: 'ชื่อ', size: 'ขนาด', modified: 'แก้ไขล่าสุด',
    folder: 'โฟลเดอร์', remove: 'นำออก', edit: 'แก้ไข', open: 'เปิด', saved: 'บันทึกแล้ว', never: 'ยังไม่เคย',
    unknownError: 'เกิดข้อผิดพลาด กรุณาลองใหม่', cannotConnect: 'ไม่สามารถเชื่อมต่อระบบได้ กรุณารีเฟรชหน้าเว็บ',
  },
  nav: {
    files: 'ไฟล์ของฉัน', dashboard: 'ภาพรวมระบบ', users: 'ผู้ใช้', activity: 'ประวัติการใช้งาน', trash: 'ถังขยะ',
    settings: 'ตั้งค่า', login: 'เข้าสู่ระบบ', logout: 'ออกจากระบบ', changePassword: 'เปลี่ยนรหัสผ่าน',
    language: 'ภาษา', theme: 'ธีม', themeLight: 'โหมดสว่าง', themeDark: 'โหมดมืด', themeAuto: 'ตามระบบ',
    publicPage: 'หน้าสาธารณะ', publicFolder: 'โฟลเดอร์สาธารณะ', admin: 'ผู้ดูแลระบบ',
  },
  login: {
    title: 'เข้าสู่ระบบ', subtitle: 'กรอกชื่อผู้ใช้และรหัสผ่านเพื่อจัดการไฟล์', username: 'ชื่อผู้ใช้', password: 'รหัสผ่าน',
    submit: 'เข้าสู่ระบบ', failed: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', backToPublic: 'กลับไปหน้าดาวน์โหลด',
  },
  profile: {
    current: 'รหัสผ่านปัจจุบัน', new: 'รหัสผ่านใหม่', confirm: 'ยืนยันรหัสผ่านใหม่', hint: 'อย่างน้อย 8 ตัวอักษร',
    mismatch: 'รหัสผ่านไม่ตรงกัน', done: 'เปลี่ยนรหัสผ่านแล้ว',
    mustChange: 'บัญชีนี้ยังใช้รหัสผ่านเริ่มต้นที่ระบบสร้างให้ กรุณาตั้งรหัสผ่านใหม่ก่อนใช้งานต่อ',
  },
  files: {
    emptyTitle: 'โฟลเดอร์นี้ยังว่างอยู่', emptyText: 'ลากไฟล์มาวางที่นี่ หรือกดปุ่มอัปโหลดเพื่อเพิ่มไฟล์',
    emptyReadonly: 'ยังไม่มีไฟล์ในโฟลเดอร์นี้', newFolder: 'โฟลเดอร์ใหม่', newFile: 'ไฟล์ข้อความใหม่',
    uploadFiles: 'อัปโหลดไฟล์', uploadFolder: 'อัปโหลดทั้งโฟลเดอร์', dropHere: 'วางไฟล์เพื่ออัปโหลดไปที่ {folder}',
    selected: 'เลือกแล้ว {n} รายการ', clearSelection: 'ยกเลิกการเลือก', copyTo: 'คัดลอกไปที่...', moveTo: 'ย้ายไปที่...',
    copyHere: 'คัดลอกมาที่นี่', moveHere: 'ย้ายมาที่นี่', zip: 'บีบอัดเป็น zip', unzip: 'แตกไฟล์ zip',
    archiveName: 'ชื่อไฟล์ zip', unzipConfirm: 'แตกไฟล์ {name} ลงในโฟลเดอร์ใหม่ข้างไฟล์นี้?',
    deleteConfirm: 'ลบ {n} รายการที่เลือก?', deleteToTrash: 'รายการจะถูกย้ายไปที่ถังขยะ ผู้ดูแลระบบกู้คืนได้ภายใน {days} วัน',
    newName: 'ชื่อใหม่', folderName: 'ชื่อโฟลเดอร์', fileName: 'ชื่อไฟล์', preview: 'ดูตัวอย่าง',
    viewList: 'แบบรายการ', viewGrid: 'แบบตาราง', batchReady: 'กำลังดาวน์โหลดไฟล์ zip', itemCount: '{n} รายการ',
    chooseDestination: 'เลือกโฟลเดอร์ปลายทาง', noSubfolders: 'ไม่มีโฟลเดอร์ย่อย', hiddenCount: 'ซ่อนไฟล์ที่ขึ้นต้นด้วยจุด {n} รายการ',
    show: 'แสดง', showHidden: 'แสดงไฟล์ที่ซ่อน', hideHidden: 'ซ่อนไฟล์ที่ขึ้นต้นด้วยจุด', showMore: 'แสดงอีก {n} รายการ',
    done: 'ทำรายการเรียบร้อย', partial: 'สำเร็จ {ok} รายการ ไม่สำเร็จ {failed} รายการ ({reason})',
    downloadZip: 'ดาวน์โหลดเป็น zip', noPreview: 'ไฟล์ชนิดนี้ดูตัวอย่างในหน้าเว็บไม่ได้ กรุณาดาวน์โหลด',
    unsaved: 'ยังไม่ได้บันทึก', unsavedText: 'มีการแก้ไขที่ยังไม่ได้บันทึก ต้องการทิ้งการแก้ไขนี้ไหม?', discard: 'ทิ้งการแก้ไข',
    publicHint: 'ไฟล์ในโฟลเดอร์นี้ผู้เยี่ยมชมทุกคนเห็นและดาวน์โหลดได้ สิ่งที่คุณทำได้ในโฟลเดอร์นี้:',
  },
  perm: {
    read: 'ดูรายการ', download: 'ดาวน์โหลด', batchdownload: 'ดาวน์โหลดหลายไฟล์', upload: 'อัปโหลด',
    write: 'สร้าง/แก้ไข/ลบ', zip: 'บีบอัด/แตกไฟล์',
  },
  upload: {
    uploading: 'กำลังอัปโหลด {n} ไฟล์', finished: 'อัปโหลดเสร็จแล้ว', summary: 'สำเร็จ {ok} · ล้มเหลว {failed} · ทั้งหมด {total}',
    queued: 'รอคิว', paused: 'หยุดชั่วคราว', done: 'เสร็จแล้ว', canceled: 'ยกเลิกแล้ว', pause: 'พัก', resume: 'ทำต่อ',
    remaining: 'เหลือประมาณ {time}', tooBig: '{name} ใหญ่เกินกำหนด (สูงสุด {max})',
  },
  search: {
    title: 'ค้นหาไฟล์', placeholder: 'พิมพ์ชื่อไฟล์หรือโฟลเดอร์', noResults: 'ไม่พบรายการที่ตรงกัน',
    hint: 'ค้นหาจากชื่อในทุกโฟลเดอร์ย่อย', truncated: 'แสดงเฉพาะผลลัพธ์แรก ๆ ลองพิมพ์ให้เจาะจงขึ้น',
  },
  dash: {
    subtitle: 'สถานะของเซิร์ฟเวอร์และพื้นที่เก็บไฟล์', disk: 'พื้นที่ดิสก์', free: 'ว่าง',
    diskUsed: 'ใช้ไป {used} จาก {total} ({pct}%)', unknown: 'ตรวจสอบพื้นที่ดิสก์ไม่ได้', files: 'ไฟล์ทั้งหมด',
    publicFiles: 'ไฟล์สาธารณะ', trash: 'ในถังขยะ', users: 'ผู้ใช้', uploading: 'กำลังอัปโหลด {n} รายการ',
    backup: 'การสำรองข้อมูล', backupOk: 'สำเร็จ', backupFailed: 'ล้มเหลว', noBackup: 'ยังไม่มีบันทึกการสำรองข้อมูล',
    system: 'ระบบ', uptime: 'เปิดมา {time}',
  },
  users: {
    subtitle: 'จัดการบัญชีผู้ใช้ โฟลเดอร์ส่วนตัว และสิทธิ์', add: 'เพิ่มผู้ใช้', edit: 'แก้ไขผู้ใช้', delete: 'ลบผู้ใช้',
    deleteConfirm: 'ลบบัญชี {name}? ไฟล์ในโฟลเดอร์ของผู้ใช้จะไม่ถูกลบ', user: 'ผู้ใช้', name: 'ชื่อที่แสดง', role: 'บทบาท',
    regular: 'ผู้ใช้ทั่วไป', homedir: 'โฟลเดอร์ส่วนตัว', lastLogin: 'เข้าล่าสุด', newPassword: 'รหัสผ่านใหม่',
    keepPassword: 'เว้นว่างไว้ถ้าไม่เปลี่ยน', ownPerms: 'สิทธิ์ในโฟลเดอร์ของตัวเอง', publicPerms: 'สิทธิ์ในโฟลเดอร์สาธารณะ',
    publicHint: 'ถ้าไม่เลือกอะไรเลย ผู้ใช้จะไม่เห็นเมนูโฟลเดอร์สาธารณะ', adminHint: 'ผู้ดูแลระบบเห็นและจัดการได้ทุกโฟลเดอร์',
    useThisFolder: 'ใช้โฟลเดอร์นี้',
  },
  activity: {
    subtitle: 'ใครเข้าสู่ระบบ อัปโหลด ดาวน์โหลด ลบ หรือแก้ไขอะไรบ้าง', search: 'ค้นหาชื่อไฟล์หรือรายละเอียด',
    user: 'ผู้ใช้', action: 'การกระทำ', time: 'เวลา', target: 'รายการ', none: 'ไม่พบประวัติ', more: 'แสดงเพิ่ม',
  },
  action: {
    login: 'เข้าสู่ระบบ', 'login-failed': 'เข้าสู่ระบบไม่สำเร็จ', logout: 'ออกจากระบบ', upload: 'อัปโหลด', download: 'ดาวน์โหลด',
    'download-zip': 'ดาวน์โหลด zip', delete: 'ลบ', restore: 'กู้คืน', purge: 'ลบถาวร', mkdir: 'สร้างโฟลเดอร์', create: 'สร้างไฟล์',
    edit: 'แก้ไขไฟล์', rename: 'เปลี่ยนชื่อ', copy: 'คัดลอก', move: 'ย้าย', zip: 'บีบอัด', unzip: 'แตกไฟล์',
    'password-change': 'เปลี่ยนรหัสผ่าน', 'user-create': 'เพิ่มผู้ใช้', 'user-update': 'แก้ไขผู้ใช้', 'user-delete': 'ลบผู้ใช้',
    'settings-update': 'แก้ไขการตั้งค่า', 'logo-update': 'เปลี่ยนโลโก้', 'logo-remove': 'ลบโลโก้',
  },
  trash: {
    subtitle: 'รายการที่ถูกลบจะอยู่ที่นี่ {days} วันก่อนถูกลบถาวร กู้คืนกลับตำแหน่งเดิมได้', empty: 'ล้างถังขยะ',
    emptyConfirm: 'ลบถาวร {n} รายการในถังขยะ? ไม่สามารถกู้คืนได้อีก', none: 'ถังขยะว่างเปล่า', deletedBy: 'ลบโดย',
    deletedAt: 'ลบเมื่อ', left: 'เหลือเวลา', days: '{n} วัน', restore: 'กู้คืน', restored: 'กู้คืนไปที่ {path} แล้ว',
    purge: 'ลบถาวร', purgeConfirm: 'ลบ {name} ถาวร? ไม่สามารถกู้คืนได้อีก',
  },
  settings: {
    subtitle: 'ปรับชื่อ สี โลโก้ และหน้าสาธารณะของเว็บ', brand: 'แบรนด์', appName: 'ชื่อเว็บ', color: 'สีหลัก', logo: 'โลโก้',
    uploadLogo: 'อัปโหลดโลโก้', logoHint: 'PNG, JPG, WebP หรือ SVG ไม่เกิน 1 MB', publicPage: 'หน้าสาธารณะ',
    publicEnabled: 'เปิดให้ผู้เยี่ยมชมดาวน์โหลดโดยไม่ต้องเข้าสู่ระบบ', welcomeTitle: 'หัวข้อต้อนรับ', welcomeText: 'ข้อความต้อนรับ',
    emptyText: 'ข้อความเมื่อไม่มีไฟล์', guestPerms: 'สิ่งที่ผู้เยี่ยมชมทำได้',
    guestWarn: 'คำเตือน: ผู้เยี่ยมชมทุกคนจะอัปโหลดหรือแก้ไขไฟล์ได้โดยไม่ต้องเข้าสู่ระบบ ควรเปิดเฉพาะเมื่อจำเป็นจริง ๆ',
    about: 'ข้อมูลระบบ', uploadLimit: 'ขนาดไฟล์สูงสุดต่อไฟล์', chunk: 'ขนาดชิ้นอัปโหลด × จำนวนพร้อมกัน', retention: 'เก็บถังขยะไว้',
  },
}

const en = {
  common: {
    save: 'Save', cancel: 'Cancel', close: 'Close', confirm: 'Confirm', delete: 'Delete', create: 'Create',
    rename: 'Rename', download: 'Download', upload: 'Upload', refresh: 'Refresh', search: 'Search',
    back: 'Back', home: 'Home', retry: 'Retry', name: 'Name', size: 'Size', modified: 'Modified',
    folder: 'Folder', remove: 'Remove', edit: 'Edit', open: 'Open', saved: 'Saved', never: 'Never',
    unknownError: 'Something went wrong. Please try again.', cannotConnect: 'Cannot reach the server. Please refresh the page.',
  },
  nav: {
    files: 'My files', dashboard: 'Dashboard', users: 'Users', activity: 'Activity', trash: 'Trash',
    settings: 'Settings', login: 'Sign in', logout: 'Sign out', changePassword: 'Change password',
    language: 'Language', theme: 'Theme', themeLight: 'Light', themeDark: 'Dark', themeAuto: 'System',
    publicPage: 'Public page', publicFolder: 'Public folder', admin: 'Administrator',
  },
  login: {
    title: 'Sign in', subtitle: 'Enter your username and password to manage files', username: 'Username', password: 'Password',
    submit: 'Sign in', failed: 'Wrong username or password', backToPublic: 'Back to downloads',
  },
  profile: {
    current: 'Current password', new: 'New password', confirm: 'Confirm new password', hint: 'At least 8 characters',
    mismatch: 'Passwords do not match', done: 'Password changed',
    mustChange: 'This account still uses the generated first-run password. Please choose a new one to continue.',
  },
  files: {
    emptyTitle: 'This folder is empty', emptyText: 'Drop files here or press upload to add some',
    emptyReadonly: 'No files in this folder yet', newFolder: 'New folder', newFile: 'New text file',
    uploadFiles: 'Upload files', uploadFolder: 'Upload a folder', dropHere: 'Drop files to upload to {folder}',
    selected: '{n} selected', clearSelection: 'Clear selection', copyTo: 'Copy to...', moveTo: 'Move to...',
    copyHere: 'Copy here', moveHere: 'Move here', zip: 'Compress to zip', unzip: 'Extract zip',
    archiveName: 'Zip file name', unzipConfirm: 'Extract {name} into a new folder next to it?',
    deleteConfirm: 'Delete {n} selected item(s)?', deleteToTrash: 'Items go to the trash; an administrator can restore them within {days} days.',
    newName: 'New name', folderName: 'Folder name', fileName: 'File name', preview: 'Preview',
    viewList: 'List view', viewGrid: 'Grid view', batchReady: 'Downloading zip file', itemCount: '{n} items',
    chooseDestination: 'Choose destination folder', noSubfolders: 'No sub folders', hiddenCount: '{n} dot-files hidden',
    show: 'Show', showHidden: 'Show hidden files', hideHidden: 'Hide dot-files', showMore: 'Show {n} more',
    done: 'Done', partial: '{ok} succeeded, {failed} failed ({reason})',
    downloadZip: 'Download as zip', noPreview: 'This file type has no preview. Please download it.',
    unsaved: 'Unsaved changes', unsavedText: 'You have unsaved changes. Discard them?', discard: 'Discard',
    publicHint: 'Everybody can see and download files in this folder. What you can do here:',
  },
  perm: {
    read: 'View list', download: 'Download', batchdownload: 'Download many', upload: 'Upload',
    write: 'Create/edit/delete', zip: 'Zip/unzip',
  },
  upload: {
    uploading: 'Uploading {n} file(s)', finished: 'Upload finished', summary: '{ok} done · {failed} failed · {total} total',
    queued: 'Queued', paused: 'Paused', done: 'Done', canceled: 'Canceled', pause: 'Pause', resume: 'Resume',
    remaining: '{time} left', tooBig: '{name} is too large (max {max})',
  },
  search: {
    title: 'Search files', placeholder: 'Type a file or folder name', noResults: 'Nothing found',
    hint: 'Searches names in all sub folders', truncated: 'Showing the first results only. Try a more specific term.',
  },
  dash: {
    subtitle: 'Server and storage status', disk: 'Disk space', free: 'free',
    diskUsed: '{used} used of {total} ({pct}%)', unknown: 'Disk usage is unavailable', files: 'All files',
    publicFiles: 'Public files', trash: 'In trash', users: 'Users', uploading: '{n} upload(s) in progress',
    backup: 'Backup', backupOk: 'OK', backupFailed: 'Failed', noBackup: 'No backup recorded yet',
    system: 'System', uptime: 'up {time}',
  },
  users: {
    subtitle: 'Manage accounts, personal folders and permissions', add: 'Add user', edit: 'Edit user', delete: 'Delete user',
    deleteConfirm: 'Delete the account {name}? Files in their folder are kept.', user: 'User', name: 'Display name', role: 'Role',
    regular: 'Regular user', homedir: 'Personal folder', lastLogin: 'Last sign-in', newPassword: 'New password',
    keepPassword: 'Leave empty to keep the current one', ownPerms: 'Permissions in their own folder', publicPerms: 'Permissions in the public folder',
    publicHint: 'With nothing selected the user will not see the public folder', adminHint: 'Administrators can see and manage every folder.',
    useThisFolder: 'Use this folder',
  },
  activity: {
    subtitle: 'Who signed in, uploaded, downloaded, deleted or changed what', search: 'Search file names or details',
    user: 'User', action: 'Action', time: 'Time', target: 'Item', none: 'No activity found', more: 'Show more',
  },
  action: {
    login: 'Sign in', 'login-failed': 'Failed sign-in', logout: 'Sign out', upload: 'Upload', download: 'Download',
    'download-zip': 'Download zip', delete: 'Delete', restore: 'Restore', purge: 'Delete forever', mkdir: 'Create folder', create: 'Create file',
    edit: 'Edit file', rename: 'Rename', copy: 'Copy', move: 'Move', zip: 'Compress', unzip: 'Extract',
    'password-change': 'Change password', 'user-create': 'Add user', 'user-update': 'Edit user', 'user-delete': 'Delete user',
    'settings-update': 'Change settings', 'logo-update': 'Change logo', 'logo-remove': 'Remove logo',
  },
  trash: {
    subtitle: 'Deleted items stay here for {days} days before they are removed for good. You can restore them to their original place.',
    empty: 'Empty trash', emptyConfirm: 'Permanently delete {n} item(s) in the trash? This cannot be undone.', none: 'The trash is empty',
    deletedBy: 'Deleted by', deletedAt: 'Deleted', left: 'Time left', days: '{n} days', restore: 'Restore', restored: 'Restored to {path}',
    purge: 'Delete forever', purgeConfirm: 'Permanently delete {name}? This cannot be undone.',
  },
  settings: {
    subtitle: 'Name, colour, logo and the public page', brand: 'Brand', appName: 'Site name', color: 'Primary colour', logo: 'Logo',
    uploadLogo: 'Upload logo', logoHint: 'PNG, JPG, WebP or SVG, up to 1 MB', publicPage: 'Public page',
    publicEnabled: 'Let visitors download without signing in', welcomeTitle: 'Welcome title', welcomeText: 'Welcome text',
    emptyText: 'Text shown when there are no files', guestPerms: 'What visitors may do',
    guestWarn: 'Warning: every visitor will be able to upload or change files without signing in. Only enable this if you really need it.',
    about: 'About', uploadLimit: 'Maximum size per file', chunk: 'Upload chunk × parallel chunks', retention: 'Trash retention',
  },
}

let saved = 'th'
try { saved = localStorage.getItem('fc.lang') || 'th' } catch { /* ignore */ }

export const i18n = createI18n({
  legacy: false,
  locale: saved,
  fallbackLocale: 'th',
  messages: { th, en },
  missingWarn: false,
  fallbackWarn: false,
})
