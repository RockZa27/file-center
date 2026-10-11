Start the app with ACCESS_LOG=true.
1. logs-page: make a real error happen (e.g. on the backup page restore a backup after replacing its zip in the backups folder with a broken file, or anything else that fails on the server); open "บันทึกระบบ": the entry is there; filter by level error and search for it; download all logs: a .zip larger than 0 bytes.
2. no-secrets-in-logs: sign in, create a user, change a password, make a batch download (select 2 files, download as zip); then download the logs zip and search every file in it for the passwords you typed, your session cookie value and the batch token: none may appear.
3. activity-csv: on the activity page export CSV; the file opens as text with Thai readable (UTF-8), one row per event; a file you renamed to "=1+1.txt" before appears with a leading ' so it is not a formula.
4. dashboard-errors: the dashboard shows a warning about errors in the last 24 hours with a link that opens the logs page.
5. stats: the dashboard file statistics show numbers (or "กำลังนับ…" first and numbers after a refresh); the page never hangs.
6. guest-hint: on the users page type "guest" as the username: a warning shows before saving.
7. update-refused-alert: drop a fake .zip on the update page: the error stays visible on the page after 10 seconds.
8. mobile: at 375 x 812 the logs page and the activity page have no horizontal scrolling.
