Add the admin page "สำรองข้อมูล" (Backup) for the backup API that now exists on the base branch (read `src/routes/backup.ts` for the exact request and response shapes).

- Route `/admin/backup` (name `backup`, admin only) in `web/src/router.js`, a nav item after "อัปเดตระบบ" in `web/src/layouts/AppLayout.vue` (icon `ArchiveOutline` from `@vicons/ionicons5`), API calls in `web/src/api.js`, all strings in `th` and `en` in `web/src/i18n.js`, the action names (`backup-create`, `backup-delete`, `backup-restore`, and any other the server audits) in `ActivityView.vue` and both languages.
- New `web/src/views/BackupView.vue`:
  - Status card: last success time, last attempt result (error message when it failed), schedule ("ทุกวันเวลา 03:00" or off), where backups are kept, how many are kept, whether user files are included. A warning alert when `sameDisk` is true, explaining that backups on the same disk do not survive a disk failure and how to set `BACKUP_DIR`.
  - "สำรองตอนนี้" button (loading state, refreshes the list).
  - List of backups: date, size, download link, delete (confirm), restore.
  - Restore asks in a modal: what will be replaced (accounts, passwords, settings, logo; not files; a safety backup is taken first), password field, confirm. Then wait for the restart and reload, exactly like `UpdateView.vue` does after installing (move the waiting code into a shared module, e.g. `web/src/restart.js`, and use it from both pages).
- Works at 375 px width; no console errors.
